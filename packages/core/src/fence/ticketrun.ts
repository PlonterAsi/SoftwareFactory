import { stepsOf, stepsText } from "./story.js";
import { type FoundChecks, findChecks, scriptsOf } from "./projectchecks.js";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GitHub, GitHubRepo } from "../tickets/github.js";
import { type RunResult, runInRoom } from "./door.js";
import type { FenceReport, RoomExec, RoomFiles } from "./fencetest.js";
import type { FenceSettings } from "./room.js";
import { type RecordLine, type TheRecord, cleanText } from "./record.js";

/**
 * One ticket, from the person's sentence to a proposal on GitHub (build step 1, slice 2). This is the
 * Windows side. It holds the GitHub pass and the project's history; the room gets neither.
 *
 *   sentence -> ticket in the record -> the fence test (all nine lines, or nothing starts)
 *            -> the project from GitHub as a bundle -> the run in the room -> its commits back as a bundle
 *            -> looked at as data (never checked out, never run here) -> a branch and a draft pull request
 */

export interface TicketSettings {
  /** The project on GitHub. The copy always comes from there, never from a folder of the person's. */
  repo: GitHubRepo;
  /** The branch work starts from. Empty: the project's default branch. */
  base: string;
  /** The project's own checks, run in the room without network after the agent finished. */
  checks: string[];
  /** Commands the run is told to do first, to fetch what the checks need while it still has the listed addresses. */
  prepare?: string[];
  /** The test of done from the ready gate, when there is one. */
  done?: string[];
  /** The GitHub issue this ticket is linked to, when there is one: the proposal closes it when it is accepted. */
  issue?: number;
  /** More than one run may work at once (Settings, slots): this run gets its own cell in the room. */
  ownCell?: boolean;
  model: string;
  maxTurns: number;
  timeLimitMinutes: number;
  /** Where SoftwareFactory keeps its own copy of the project's history, on the Windows side. */
  workDir: string;
}

export interface TicketDeps {
  exec: RoomExec;
  files: RoomFiles;
  record: TheRecord;
  github: GitHub;
  /** The nine lines. Injected so the caller decides how the test reaches the room. */
  /** `others`: another run is working in the room, so the test must not end everything of the worker's. */
  fenceTest: (o?: { others: boolean }) => Promise<FenceReport>;
  fence?: Partial<FenceSettings>;
  signal?: AbortSignal;
}

export interface TicketOutcome {
  ticket: string;
  run: string | null;
  end: RunResult["end"] | "not started";
  reason: string;
  /** The draft pull request, or the page that starts one when this computer has no token for the API. */
  url: string | null;
  branch: string | null;
  costUsd: number;
}

/** Paths in a result that SoftwareFactory does not send on by itself: they change what runs by itself on GitHub. */
export const HELD_PATHS = [/^\.github\//, /(^|\/)\.gitmodules$/, /(^|\/)\.gitattributes$/];

/**
 * A run's own words go into a pull request as words only: they call nobody (@name), close or link no issue
 * (#12, "closes"), and carry no hidden characters.
 */
export function quiet(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/@(?=[A-Za-z0-9])/g, "@\u200b").replace(/#(?=\d)/g, "#\u200b").replace(/<!--/g, "<\u200b!--").slice(0, 4000);
}

export function plainGit(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true, timeout: 300_000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
}

/** SoftwareFactory's own bare copy of the project's history. Nothing in it is ever checked out or run. */
export function history(deps: Pick<TicketDeps, "github">, st: Pick<TicketSettings, "repo" | "base" | "workDir">): { dir: string; base: string } {
  const dir = join(st.workDir, "projects", `${st.repo.owner}-${st.repo.name}.git`.replace(/[^A-Za-z0-9._-]/g, "-"));
  const url = deps.github.remote(st.repo);
  const git = (...args: string[]) => (deps.github.hasToken() ? deps.github.git(dir, ...args) : plainGit(dir, ...args));
  if (!existsSync(join(dir, "HEAD"))) {
    mkdirSync(dir, { recursive: true });
    plainGit(dir, "init", "-q", "--bare");
  }
  git("fetch", "-q", "--prune", url, "+refs/heads/*:refs/remotes/origin/*");
  let base = st.base;
  if (!base) {
    const head = git("ls-remote", "--symref", url, "HEAD");
    base = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(head)?.[1] ?? "main";
  }
  // The starting point as a local branch, so a bundle can name it.
  plainGit(dir, "update-ref", `refs/heads/${base}`, `refs/remotes/origin/${base}`);
  return { dir, base };
}

/** The kinds of ticket (leg 2). The door takes one sentence; the kind is "request" until someone says otherwise. */
export const TICKET_KINDS = ["request", "bug", "task", "idea", "plan", "question"] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];

/** Open a ticket: it gets its name and its first line in the record. Nothing runs yet. */
export function openTicket(record: TheRecord, project: string, sentence: string, kind: TicketKind = "request", from: { from: "github"; issue: number } | null = null): string {
  // Counting and writing happen under one lock, so two SoftwareFactory windows cannot give two tickets one name.
  record.db.exec("BEGIN IMMEDIATE");
  try {
    const ticket = `T${record.all().filter((l) => l.kind === "ticket.opened").length + 1}`;
    record.append({ kind: "ticket.opened", who: "you", ticket, project, data: { sentence: sentence.trim(), kind, ...(from ?? {}) } });
    record.db.exec("COMMIT");
    return ticket;
  } catch (e) { record.db.exec("ROLLBACK"); throw e; }
}

/** Work one ticket to a written end. With `open` the ticket is already in the record (it waited in the queue). */
export async function workTicket(deps: TicketDeps, st: TicketSettings, sentence: string, open?: string): Promise<TicketOutcome> {
  const { record } = deps;
  const project = `${st.repo.owner}/${st.repo.name}`;
  const ticket = open ?? openTicket(record, project, sentence);
  const out = (o: Partial<TicketOutcome> & Pick<TicketOutcome, "end" | "reason">): TicketOutcome => ({ ticket, run: null, url: null, branch: null, costUsd: 0, ...o });
  if (deps.signal?.aborted) return out({ end: "stopped", reason: "you pressed stop" });

  // Nothing starts before the fence proved itself. Not one line may be off.
  let fence: FenceReport;
  try { fence = await deps.fenceTest({ others: !!st.ownCell }); }
  catch (e) { fence = { ok: false, lines: [], startedAt: new Date().toISOString(), ms: 0, room: "" }; record.append({ kind: "fence.tested", who: "SF itself", ticket, project, data: { ok: false, error: (e as Error).message } }); }
  if (fence.lines.length) record.append({ kind: "fence.tested", who: "SF itself", ticket, project, data: { ok: fence.ok, ms: fence.ms, lines: fence.lines.map((l) => ({ n: l.n, what: l.what, verdict: l.verdict, ok: l.ok, detail: l.detail })) } });
  // The plan limit met by the test's own agent is not a hole in the fence: the ticket is parked and comes back.
  if (!fence.ok && fence.limit) {
    const reason = "the plan limit was reached before the run could start";
    record.append({ kind: "run.ended", who: "SF itself", ticket, project, data: { end: "parked", reason, parkedFor: "limit", where: "before the run" } });
    return out({ end: "parked", reason });
  }
  if (!fence.ok) return out({ end: "not started", reason: "the fence does not hold, so no run starts" });
  if (deps.signal?.aborted) return out({ end: "stopped", reason: "you pressed stop" });

  const run = `${ticket}-${randomBytes(4).toString("hex")}`;
  const branch = `sf/${ticket.toLowerCase()}-${run.slice(-8)}`;
  const tmp = join(st.workDir, "tmp");
  const inFile = join(tmp, `${run}.in.bundle`), outFile = join(tmp, `${run}.out.bundle`);
  try {
    mkdirSync(tmp, { recursive: true });
    const h = history(deps, st);
    plainGit(h.dir, "bundle", "create", inFile, `refs/heads/${h.base}`);
    // Checks written in Settings win. With none written, the project tells its own, read from the starting point
    // before the run touched anything.
    let checks = st.checks, prepare = st.prepare ?? [], checksFound: string[] | undefined, watch: FoundChecks["watch"] = [], covers: string[] | null = null, workspaces = false;
    if (!checks.length) {
      // The branch by its full name: a tag that happens to carry the same name is never read instead.
      const files = plainGit(h.dir, "ls-tree", "-r", "--name-only", "-z", `refs/heads/${h.base}`).split("\0").filter(Boolean);
      const found = findChecks(files, (path) => { try { const t = plainGit(h.dir, "show", `refs/heads/${h.base}:${path}`); return t.length > 1_000_000 ? null : t; } catch { return null; } });
      checks = found.checks; prepare = [...prepare, ...found.prepare.filter((c) => !prepare.includes(c))]; checksFound = found.found; watch = found.watch; covers = found.covers; workspaces = found.workspaces;
    }
    const result = await runInRoom(deps.exec, deps.files, record, {
      run, ticket, project, sentence, bundle: readFileSync(inFile), base: h.base, branch,
      model: st.model, maxTurns: st.maxTurns, timeLimitMs: st.timeLimitMinutes * 60_000, checks, prepare, checksFound, done: st.done, ownCell: !!st.ownCell, signal: deps.signal,
    }, deps.fence);
    if (result.end !== "passed" || !result.bundle || !result.baseSha || !result.headSha) return out({ run, end: result.end, reason: result.reason, costUsd: result.costUsd });

    // The result comes in as data. It is fetched into the bare history: no file of it is written out, no hook of it can run.
    writeFileSync(outFile, result.bundle);
    const hold = (reason: string) => {
      record.append({ kind: "result.proposed", who: "SF itself", run, ticket, project, data: { held: true, reason } });
      return out({ run, end: "parked", reason, costUsd: result.costUsd });
    };
    try { plainGit(h.dir, "bundle", "verify", "-q", outFile); } catch { return hold("what came out of the room is not a whole set of commits"); }
    plainGit(h.dir, "-c", "fetch.fsckObjects=true", "fetch", "-q", "--no-tags", outFile, `+refs/heads/${branch}:refs/heads/${branch}`);
    if (plainGit(h.dir, "rev-parse", `refs/heads/${branch}`) !== result.headSha) return hold("what came out of the room is not the commit that was checked");
    try { plainGit(h.dir, "merge-base", "--is-ancestor", result.baseSha, branch); } catch { return hold("the result does not continue from the project's own history"); }
    // Names exactly as they are: no quoting of odd characters, and a renamed file counts under both its names.
    const changed = plainGit(h.dir, "-c", "core.quotePath=false", "diff", "--no-renames", "--no-ext-diff", "-z", "--name-only", `${result.baseSha}..${branch}`).split("\0").filter(Boolean);
    const heldFile = changed.find((f) => HELD_PATHS.some((re) => re.test(f)));
    if (heldFile) return hold(`the result changes ${heldFile}, which decides what runs by itself on GitHub: that needs your look before it leaves`);
    // A found check runs the project's own script. A result that rewrites that script has checked itself.
    // npm also runs "pre" and "post" of a script by itself; and with workspaces the top folder's script hands on
    // to the scripts of every package under it, so there any changed script counts.
    const watched = [...watch, ...(workspaces ? changed.filter((f) => /(^|\/)package\.json$/.test(f) && !watch.some((w) => w.path === f)).map((path) => ({ path, scripts: null as string[] | null })) : [])];
    for (const w of watched.filter((x) => changed.includes(x.path))) {
      const at = (rev: string) => { try { return scriptsOf(plainGit(h.dir, "show", `${rev}:${w.path}`))?.scripts ?? {}; } catch { return {} as Record<string, string>; } };
      const was = at(result.baseSha), now = at(`refs/heads/${branch}`);
      const keys = w.scripts ? w.scripts.flatMap((k) => [k, `pre${k}`, `post${k}`]) : [...new Set([...Object.keys(was), ...Object.keys(now)])];
      const moved = keys.find((k) => was[k] !== now[k]);
      if (moved) return hold(`the result changes the "${moved}" command in ${w.path}, which is the very check SoftwareFactory ran on it: that needs your look before it leaves`);
    }
    // The project's own settings may not choose a program to show a file with: this side runs nothing of the result's.
    const diff = plainGit(h.dir, "diff", "--no-renames", "--no-ext-diff", "--no-textconv", `${result.baseSha}..${branch}`);
    if (cleanText(diff).hit) return hold("a secret was found in the result, so it does not leave this computer");

    // Said plainly: files the found checks do not look at were checked by nothing.
    const unchecked = covers && checks.length && !covers.includes("") ? changed.filter((f) => !covers!.some((d) => f.startsWith(`${d}/`))) : [];
    // Out: the branch, and a draft pull request. Never the base branch.
    const title = `${ticket}: ${quiet(sentence.trim().split("\n")[0]!).slice(0, 120)}`;
    if (deps.signal?.aborted) return hold("you pressed stop before the result left this computer");
    const body = [`Ticket **${ticket}** from SoftwareFactory, worked inside the fence.`, "", ...(Number.isInteger(st.issue) && st.issue! > 0 ? [`Closes #${st.issue}`, ""] : []), `> ${quiet(sentence.trim()).split("\n").join("\n> ")}`, "", ...(st.done?.length ? ["Done when (written by SoftwareFactory before the run, from the request):", "", ...st.done.map((x) => `- ${quiet(x)}`), ""] : []), "What the run says it did (its own words, written before SoftwareFactory ran the checks below, and not checked):", "", `> ${quiet(result.summary).split("\n").join("\n> ")}`, "", `Changed ${changed.length} file(s).`, result.checks.length ? `SoftwareFactory then ran these checks itself, without network, and all passed: ${result.checks.map((c) => `\`${c.command}\``).join(", ")}.${checksFound ? " It found them in the project as it was before the run." : ""}${unchecked.length ? ` These changed files lie outside what those checks look at, so nothing checked them: ${unchecked.slice(0, 10).map((f) => `\`${quiet(f)}\``).join(", ")}${unchecked.length > 10 ? " and more" : ""}.` : ""}` : checksFound ? "SoftwareFactory found no build or type check in this project, so nothing was checked." : "No checks were set for this project."].join("\n");
    let url: string, number: number | null = null;
    if (deps.github.hasToken()) {
      // openPr pushes HEAD, so HEAD of the bare history points at the ticket's branch for the length of the call.
      plainGit(h.dir, "symbolic-ref", "HEAD", `refs/heads/${branch}`);
      try { const pr = await deps.github.openPr({ repo: st.repo, dir: h.dir, branch, base: h.base, title, body }); url = pr.url; number = pr.number; }
      finally { plainGit(h.dir, "symbolic-ref", "HEAD", `refs/heads/${h.base}`); }
    } else {
      await deps.github.pushBranch({ repo: st.repo, dir: h.dir, branch, base: h.base });
      url = deps.github.compareUrl(st.repo, h.base, branch);
    }
    record.append({ kind: "result.proposed", who: "SF itself", run, ticket, project, data: { url, number, branch, base: h.base, files: changed.slice(0, 50), baseSha: result.baseSha, headSha: result.headSha, ...(unchecked.length ? { unchecked: unchecked.slice(0, 50) } : {}) } });
    return out({ run, end: "passed", reason: result.reason, url, branch, costUsd: result.costUsd });
  } catch (e) {
    const reason = (e as Error).message.slice(0, 300);
    record.append({ kind: "run.ended", who: "SF itself", run, ticket, project, data: { end: "crashed", reason, where: "outside the room" } });
    return out({ run, end: "crashed", reason });
  } finally {
    rmSync(inFile, { force: true }); rmSync(outFile, { force: true });
  }
}

/** One line of the record as words a person reads. Nothing in it can move a cursor or recolour a console. */
export function storyLine(l: RecordLine): string {
    const d = l.data as any;
    const what =
      l.kind === "ticket.opened" ? `you asked${d.from === "github" ? ` (issue #${d.issue} on GitHub)` : ""}: ${d.sentence}` :
      l.kind === "issue.linked" ? (d.direction === "in" ? `taken from issue #${d.number} on GitHub` : `issue #${d.number} opened on GitHub for it`) :
      l.kind === "ticket.edited" ? `you changed it${d.sentence ? ` to: ${d.sentence}` : ""}${d.kind ? ` (kind: ${d.kind})` : ""}` :
      l.kind === "ticket.queued" ? (d.returned ? `it came back to the queue by itself: ${d.why ?? "the wait is over"}` : "you sent it to be worked again") :
      l.kind === "ticket.removed" ? (d.from === "github" ? `it left the list: ${d.why}` : l.who === "you" ? "you removed it from the list" : "it was removed from the list") :
      l.kind === "ticket.restored" ? "you put it back on the list" :
      l.kind === "gate.asked" ? `before starting, SoftwareFactory asks: ${d.question}` :
      l.kind === "gate.answered" ? `you answered: ${d.answer}` :
      l.kind === "gate.passed" ? (d.skipped ? `ready, without a test of done (${d.skipped})` : `ready. Done when: ${(d.done ?? []).join("; ")}${d.guesses?.length ? `. Assumed: ${d.guesses.join("; ")}` : ""}`) :
      l.kind === "fence.tested" ? (d.ok ? "the fence held: nine lines as they should be" : `the fence did not hold${d.error ? `: ${d.error}` : ""}`) :
      l.kind === "run.started" ? `a run started on ${d.model}${Array.isArray(d.checksFound) ? (d.checks?.length ? `; checks found in the project (${d.checksFound.join(", ")})` : "; no build or type check was found in the project, so nothing will be checked") : ""}` :
      l.kind === "run.step" ? (d.did ?? d.says?.split("\n")[0]?.slice(0, 140) ?? (d.tools ? `used ${d.tools.map((x: any) => x.tool).join(", ")}` : d.toolErrors ? `a command or tool ended with an error: ${String(d.toolErrors[0]).split("\n")[0]!.slice(0, 100)}` : "finished")) :
      l.kind === "run.checked" ? `check ${d.ok ? "passed" : "FAILED"}: ${d.command}` :
      l.kind === "run.ended" ? `the run ended: ${d.end} (${d.reason})` :
      l.kind === "result.proposed" ? (d.held ? `the result is held: ${d.reason}` : `proposed on GitHub: ${d.url}`) :
      l.kind === "result.accepted" ? (d.foundMerged ? "found already put into the project on GitHub" : "you accepted it: it is in the project now") :
      l.kind === "result.undone" ? (d.url && !d.sha ? `the undo is ready on GitHub, waiting to be put in: ${d.url}` : "you undid it: the project is as it was before, and its history keeps both steps") :
      l.kind === "stop.pressed" ? "you pressed stop" :
      l.kind === "watchdog.spoke" ? `said${d.phone === "sent" ? " to your phone" : ""}: ${d.line}` :
      l.kind === "setting.changed" ? `settings changed: ${Object.keys(d.changed ?? {}).join(", ")}` : l.kind;
    return String(what).replace(/[\u0000-\u0008\u000b-\u001f\u007f\u009b]/g, "");
}

/** The story of a ticket, as lines a person reads. */
export function storyText(record: TheRecord, ticket: string): string {
  const lines = record.story(ticket);
  // Ideas, plans and questions are kept, not worked: they have no road.
  const kind = [...lines].reverse().map((l) => (l.kind === "ticket.opened" || l.kind === "ticket.edited" ? (l.data as any).kind : undefined)).find((k) => typeof k === "string") ?? "request";
  const steps = ["idea", "plan", "question"].includes(kind) ? "" : stepsText(stepsOf(lines));
  return `${steps ? `${steps}\n\n` : ""}${lines.map((l) => `${l.ts.slice(11, 19)}  ${l.who.padEnd(9)} ${storyLine(l)}`).join("\n")}`;
}
