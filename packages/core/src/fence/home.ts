import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { type GitHub, type GitHubRepo, parseGitHubRepo } from "../tickets/github.js";
import type { GateResult } from "./gate.js";
import { homePage } from "./homepage.js";
import type { RecordLine, TheRecord } from "./record.js";
import { type Bucket, type LimitPeriod, type LimitSettings, LIMIT_DEFAULTS, bucketOfSend, checkLimits, periodEnd, periodStart, roomLeft, runBudget, spendOf } from "./limits.js";
import { sinceYouLeft } from "./since.js";
import { type LadderSettings, type Rung, LADDER_DEFAULTS, checkLadder, isClimbable, ladderHint, nextRung } from "./ladder.js";
import type { SplitResult } from "./gate.js";
import { type Sender, type WatchSettings, WATCH_DEFAULTS, cleanWatch, speak } from "./watchdog.js";
import { type IssueSync, type IssuesMode, syncIssues } from "./issues.js";
import { type StoryStep, stepsOf } from "./story.js";
import { type TicketKind, type TicketOutcome, type TicketSettings, TICKET_KINDS, openTicket, storyLine } from "./ticketrun.js";

/**
 * The home screen (build step 1, slice 3): one page on this computer only. You type a sentence, watch the run,
 * read the story of each ticket, and accept a result. Every picture on it is drawn from the record and from
 * nothing else; the page keeps no truth of its own.
 *
 * It listens on 127.0.0.1 only. Anything that changes something needs the page's own key, which only a page
 * served from here has, so another site open in the browser cannot press its buttons.
 */

/** What you can change on the screen. The project is written "owner/name". */
export interface HomeSettings extends WatchSettings, LimitSettings, LadderSettings {
  repo: string;
  base: string;
  checks: string[];
  prepare: string[];
  model: string;
  maxTurns: number;
  timeLimitMinutes: number;
  /** The installed app installs a newer signed build by itself at start (never while a ticket is being worked). */
  autoUpdate: boolean;
  /** Hold the queue: waiting tickets stay waiting until this is switched off. A run that is working goes on. */
  hold: boolean;
  /** The ready gate: before a run, SoftwareFactory writes the test of done and asks once when a sentence is unclear. */
  gate: boolean;
  /** The model that reads the ticket at the gate. */
  gateModel: string;
  /** After a run meets the plan limit, the queue rests this long; then the parked ticket comes back by itself. */
  parkedWaitMinutes: number;
  /** How many times one ticket may come back by itself. 0: a parked ticket waits for you. */
  parkedReturns: number;
  /** How many runs may work at once. 1: one after another, the way that is proven. More: each run gets a cell of its own in the room. */
  slots: number;
  /** A ticket cut off in the middle (SoftwareFactory closed, the computer restarted) comes back by itself this many times. */
  cutOffReturns: number;
  /** Only a ticket cut off within this many hours comes back by itself: an old one waits for you. */
  cutOffWithinHours: number;
  /** GitHub issues: "off", "in" (your labelled issues become tickets), or "both" (tickets also get an issue). */
  issues: IssuesMode;
  /** Only issues with this label come in, and issues opened from here carry it. */
  issuesLabel: string;
  /** How often GitHub is looked at, in minutes. */
  issuesEveryMinutes: number;
  /** How many tickets of each group the "since you left" panel names. */
  sinceShow: number;
  /** More paths on the stop list: a result that changes a file whose path holds one of these waits for your look. They add to the fixed list. */
  stopPaths: string[];
}

export const HOME_DEFAULTS: HomeSettings = { ...WATCH_DEFAULTS, ...LIMIT_DEFAULTS, ...LADDER_DEFAULTS, repo: "", base: "", checks: [], prepare: [], model: "sonnet", maxTurns: 80, timeLimitMinutes: 45, autoUpdate: true, hold: false, gate: true, gateModel: "haiku", parkedWaitMinutes: 30, parkedReturns: 2, slots: 1, cutOffReturns: 1, cutOffWithinHours: 24, issues: "off", issuesLabel: "sf", issuesEveryMinutes: 5, stopPaths: [], sinceShow: 10 };

/** Check what came from the screen. Returns clean settings or says, in a sentence, what is wrong. */
export function cleanSettings(raw: unknown, from: HomeSettings = HOME_DEFAULTS): HomeSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (k: keyof HomeSettings) => (typeof r[k] === "string" ? (r[k] as string).trim() : (from[k] as string));
  const list = (k: "checks" | "prepare" | "stopPaths") => (Array.isArray(r[k]) ? (r[k] as unknown[]).filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean) : from[k]);
  const num = (k: "maxTurns" | "timeLimitMinutes" | "parkedWaitMinutes" | "parkedReturns" | "slots" | "cutOffReturns" | "cutOffWithinHours" | "issuesEveryMinutes" | "limitYou" | "limitAlone" | "ownSharePercent" | "runLimit" | "runFloor" | "sinceShow" | "ladderAgain" | "ladderOtherWay" | "ladderSharedTries" | "ladderWithinMinutes" | "ladderSplitMinChars") => (r[k] === undefined ? from[k] : Number(r[k]));
  const watch = cleanWatch(r, from);
  const s: HomeSettings = { ...watch, repo: text("repo"), base: text("base"), checks: list("checks"), prepare: list("prepare"), model: text("model"), maxTurns: num("maxTurns"), timeLimitMinutes: num("timeLimitMinutes"), autoUpdate: typeof r.autoUpdate === "boolean" ? r.autoUpdate : from.autoUpdate, hold: typeof r.hold === "boolean" ? r.hold : from.hold, gate: typeof r.gate === "boolean" ? r.gate : from.gate, gateModel: text("gateModel"), parkedWaitMinutes: num("parkedWaitMinutes"), parkedReturns: num("parkedReturns"), slots: num("slots"), cutOffReturns: num("cutOffReturns"), cutOffWithinHours: num("cutOffWithinHours"), issues: (r.issues === undefined ? from.issues : r.issues) as IssuesMode, issuesLabel: text("issuesLabel"), issuesEveryMinutes: num("issuesEveryMinutes"), stopPaths: list("stopPaths"), limitPeriod: (r.limitPeriod === undefined ? from.limitPeriod : r.limitPeriod) as LimitPeriod, limitYou: num("limitYou"), limitAlone: num("limitAlone"), ownSharePercent: num("ownSharePercent"), runLimit: num("runLimit"), runFloor: num("runFloor"), sinceShow: num("sinceShow"), ladder: typeof r.ladder === "boolean" ? r.ladder : from.ladder, ladderAgain: num("ladderAgain"), ladderOtherWay: num("ladderOtherWay"), ladderSplit: typeof r.ladderSplit === "boolean" ? r.ladderSplit : from.ladderSplit, ladderSharedTries: num("ladderSharedTries"), ladderWithinMinutes: num("ladderWithinMinutes"), ladderSplitMinChars: num("ladderSplitMinChars"), ladderModel: text("ladderModel"), ladderSplitModel: text("ladderSplitModel") };
  checkLadder(s);
  if (!Number.isInteger(s.sinceShow) || s.sinceShow < 1 || s.sinceShow > 100) throw new Error("The panel names from 1 to 100 tickets of each group.");
  checkLimits(s);
  if (s.repo && !parseGitHubRepo(s.repo)) throw new Error(`"${s.repo}" is not a project on GitHub. Write it as owner/name.`);
  if (/^(HEAD|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD)$/.test(s.base)) throw new Error(`"${s.base}" is not a branch name.`);
  if (s.base && (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(s.base) || s.base.includes(".."))) throw new Error(`"${s.base}" is not a branch name.`);
  if (!/^[a-z0-9][a-z0-9.-]{0,60}$/.test(s.model)) throw new Error(`"${s.model}" is not a model name.`);
  if (!/^[a-z0-9][a-z0-9.-]{0,60}$/.test(s.gateModel)) throw new Error(`"${s.gateModel}" is not a model name.`);
  if (!Number.isInteger(s.maxTurns) || s.maxTurns < 1 || s.maxTurns > 500) throw new Error("Turns must be a whole number from 1 to 500.");
  if (!Number.isInteger(s.timeLimitMinutes) || s.timeLimitMinutes < 1 || s.timeLimitMinutes > 600) throw new Error("The time limit must be from 1 to 600 minutes.");
  if (!Number.isInteger(s.parkedWaitMinutes) || s.parkedWaitMinutes < 1 || s.parkedWaitMinutes > 1440) throw new Error("The wait after the plan limit must be from 1 to 1440 minutes.");
  if (!Number.isInteger(s.parkedReturns) || s.parkedReturns < 0 || s.parkedReturns > 20) throw new Error("A ticket may come back by itself 0 to 20 times.");
  if (!Number.isInteger(s.slots) || s.slots < 1 || s.slots > 4) throw new Error("Runs at once: a whole number from 1 to 4.");
  if (!Number.isInteger(s.cutOffReturns) || s.cutOffReturns < 0 || s.cutOffReturns > 20) throw new Error("A cut-off ticket may come back by itself 0 to 20 times.");
  if (!Number.isInteger(s.cutOffWithinHours) || s.cutOffWithinHours < 1 || s.cutOffWithinHours > 720) throw new Error("A cut-off ticket comes back within 1 to 720 hours.");
  if (!["off", "in", "both"].includes(s.issues)) throw new Error("GitHub issues are off, in, or both.");
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,48}$/.test(s.issuesLabel)) throw new Error("The issue label is 1 to 49 letters, digits, spaces, dots, dashes or underscores.");
  if (!Number.isInteger(s.issuesEveryMinutes) || s.issuesEveryMinutes < 1 || s.issuesEveryMinutes > 1440) throw new Error("GitHub is looked at every 1 to 1440 minutes.");
  for (const c of [...s.checks, ...s.prepare]) if (c.length > 500 || /[\r\n\0]/.test(c)) throw new Error("A check or a prepare command is one line of at most 500 characters.");
  if (s.checks.length > 20 || s.prepare.length > 20) throw new Error("At most 20 checks and 20 prepare commands.");
  if (s.stopPaths.length > 100 || s.stopPaths.some((x) => x.length > 200 || /[\r\n\0]/.test(x))) throw new Error("At most 100 extra stop paths, each one line of at most 200 characters.");
  return s;
}

/** Settings live in one small file beside the record. Each change is also a line in the record. */
export class SettingsFile {
  constructor(private path: string, private start: Partial<HomeSettings> = {}) {}
  read(): HomeSettings {
    let base = HOME_DEFAULTS;
    try { base = cleanSettings(this.start); } catch { /* a bad starting value never breaks the page; the defaults stand */ }
    if (!existsSync(this.path)) return base;
    try { return cleanSettings(JSON.parse(readFileSync(this.path, "utf8")), base); } catch { return base; }
  }
  write(s: HomeSettings): void {
    const tmp = `${this.path}.${randomBytes(4).toString("hex")}.tmp`;
    // Only what differs from the defaults is kept, so a default that changes in a later build still reaches this computer.
    const base = (() => { try { return cleanSettings(this.start); } catch { return HOME_DEFAULTS; } })() as unknown as Record<string, unknown>;
    const own = Object.fromEntries(Object.entries(s as unknown as Record<string, unknown>).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(base[k])));
    writeFileSync(tmp, JSON.stringify(own, null, 2));
    renameSync(tmp, this.path);
  }
}
export const settingsFileIn = (workDir: string, start: Partial<HomeSettings> = {}) => new SettingsFile(join(workDir, "settings.json"), start);

export type TicketState = "waiting" | "asked" | "kept" | "working" | "proposed" | "accepted" | "undone" | "held" | "split" | "passed" | "failed its checks" | "parked" | "stopped" | "crashed" | "not started" | "interrupted";

export interface TicketView {
  ticket: string;
  project: string | null;
  sentence: string;
  /** request, bug, task, idea, plan or question. */
  kind: string;
  openedAt: string;
  state: TicketState;
  /** One plain sentence on where the ticket stands. */
  says: string;
  url: string | null;
  number: number | null;
  costUsd: number;
  canAccept: boolean;
  canUndo: boolean;
  /** What on the stop list holds its result, when that is why it waits. Only the owner lets it go. */
  stops: { family: string; file: string; why: string }[];
  canRelease: boolean;
  /** Only while it waits: after a run its words are frozen. */
  canEdit: boolean;
  canRemove: boolean;
  /** Send it to be worked again (after an end that left nothing to accept). */
  canAgain: boolean;
  /** Taken off the list. The record keeps it, and it can be put back. */
  removed: boolean;
  /** The gate was passed for the words as they stand. */
  gatePassed: boolean;
  /** Its place in the queue, from 1, while it waits. */
  place: number | null;
  /** The question SoftwareFactory asked before starting, while it waits for the answer. */
  question: string | null;
  /** The test of done written at the gate, once there is one. */
  done: string[];
  /** The one question already asked for these words, with the answer. */
  asked: { question: string; answer: string } | null;
  /** The record line that made it wait (the order of the queue). */
  waitingSince: number;
  /** The GitHub issue it is linked to, when there is one. */
  issue: { number: number; url: string } | null;
  /** Why it is parked, when the record says: "limit" is the plan limit, which passes by itself. */
  parkedFor: string | null;
  /** When its latest go ended. */
  endedAt: string | null;
  /** How many times it came back to the queue by itself after the plan limit. */
  returns: number;
  /** A run or a fence test ever worked on it. */
  everWorked: boolean;
  /** Its latest go was cut off in the middle, and how many times it already came back by itself after that. */
  cutOff: boolean;
  cutOffReturns: number;
  /** The last line of its latest go: when it was cut off, as near as the record knows. */
  lastWorkAt: string | null;
  /** When it comes back by itself, if it will. Filled by the home screen from the settings. */
  returnsAt: string | null;
  /** Whose work its latest go is: yours (limit 1), or SoftwareFactory's by itself (limit 2). */
  bucket: Bucket;
  /** It waits because its limit is used up, and until when. Filled by the home screen. */
  limitUntil: string | null;
  /** The stuck ladder: the ticket it was cut from, the rung its latest go is on, how many rungs it climbed since you last sent it, the tickets it was split into. */
  parent: string | null;
  ladder: Rung | null;
  ladderUsed: number;
  splitInto: string[] | null;
  wasSplit: boolean;
  /** Its latest run ended in a way the ladder is for, and how that run ended. */
  climbable: boolean;
  lastFail: { state: string; reason: string; tail?: string } | null;
  /** Its latest run met a limit and its unfinished work is kept: the next run goes on from it, unless you start clean. */
  keptWork: boolean;
  /** Where it stands on the fixed road, each step with what proves it. */
  steps: StoryStep[];
  story: { id: number; at: string; who: string; what: string; flagged: boolean }[];
}

/** The kinds a run works. An idea, a plan and a question are kept on the list; what happens to them comes with the idea bank. */
const WORKED = ["request", "bug", "task"];

/** Every ticket, newest first, drawn from the record alone. `running` is the ticket being worked right now, if any. */
export function ticketsFrom(lines: RecordLine[], working: string | null | ReadonlySet<string>): TicketView[] {
  const isWorking = (t: string) => (typeof working === "string" ? working === t : !!working && working.has(t));
  const links = new Map<string, { number: number; url: string }>();
  for (const l of lines) if (l.kind === "issue.linked" && l.ticket && l.project) links.set(`${l.project}\n${l.ticket}`, { number: Number((l.data as any).number), url: String((l.data as any).url ?? "") });
  const by = new Map<string, RecordLine[]>();
  for (const l of lines) if (l.ticket) (by.get(l.ticket) ?? by.set(l.ticket, []).get(l.ticket)!).push(l);
  const out: TicketView[] = [];
  for (const [ticket, ls] of by) {
    const opened = ls.find((l) => l.kind === "ticket.opened");
    if (!opened) continue;
    const d = (l?: RecordLine) => (l?.data ?? {}) as Record<string, any>;
    const lastOf = <K extends RecordLine["kind"]>(from: RecordLine[], ...k: K[]) => [...from].reverse().find((l) => (k as string[]).includes(l.kind));
    // The latest go: what happened since the ticket was opened or last sent to be worked again.
    const sent = lastOf(ls, "ticket.opened", "ticket.queued")!;
    const go = ls.filter((l) => l.id > sent.id && !l.kind.startsWith("ticket.") && !l.kind.startsWith("gate.") && l.kind !== "issue.linked" && l.kind !== "watchdog.spoke" && l.kind !== "setting.changed");
    // The gate. A question belongs to the words it was asked about: changed words start the gate afresh.
    const wordsAt = lastOf(ls.filter((l) => l.kind === "ticket.opened" || typeof d(l).sentence === "string"), "ticket.opened", "ticket.edited")!.id;
    const gate = ls.filter((l) => l.id > wordsAt && l.kind.startsWith("gate."));
    const gAsked = lastOf(gate, "gate.asked"), gAnswered = gAsked ? gate.find((l) => l.kind === "gate.answered" && l.id > gAsked.id) : undefined, gPassed = lastOf(gate, "gate.passed");
    const question = gAsked && !gAnswered && !gPassed ? String(d(gAsked).question ?? "") : null;
    const ended = lastOf(go, "run.ended"), fence = lastOf(go, "fence.tested");
    const accepted = lastOf(ls, "result.accepted"), undone = lastOf(ls, "result.undone");
    const proposed = lastOf(go, "result.proposed");
    const edit = lastOf(ls.filter((l) => typeof d(l).sentence === "string"), "ticket.edited"), kindEdit = lastOf(ls.filter((l) => typeof d(l).kind === "string"), "ticket.edited");
    const removed = lastOf(ls, "ticket.removed", "ticket.restored")?.kind === "ticket.removed";
    // The kind: what the owner chose wins; an unmarked ticket takes what the gate read.
    const kindNow = String(d(kindEdit).kind ?? (d(opened).kind && d(opened).kind !== "request" ? d(opened).kind : d(gPassed).kind ?? d(opened).kind ?? "request"));
    // The stuck ladder, counted since the owner last sent the ticket: what SoftwareFactory did by itself after that.
    const ownerSent = lastOf(ls.filter((l) => l.kind === "ticket.opened" || l.who === "you"), "ticket.opened", "ticket.queued")!;
    const ladderUsed = ls.filter((l) => l.id > ownerSent.id && l.kind === "ticket.queued" && d(l).ladder).length;
    const splitLine = lastOf(ls.filter((l) => l.id > ownerSent.id), "ticket.split");
    const splitInto = splitLine && Array.isArray(d(splitLine).into) && d(splitLine).into.length ? (d(splitLine).into as unknown[]).map(String) : null;
    const anyEnded = lastOf(ls.filter((l) => !!l.run), "run.ended");
    const failedCheck = anyEnded ? lastOf(ls.filter((l) => l.run === anyEnded.run && d(l).ok === false), "run.checked") : undefined;
    let state: TicketState, says: string;
    if (undone) { state = "undone"; says = d(undone).sha ? "You undid it. The project is as it was before, and its history keeps both steps." : "The undo is on GitHub and still has to be put in there."; }
    else if (accepted) { state = "accepted"; says = d(accepted).foundMerged ? `It was already put into the project on GitHub${d(accepted).notTheCheckedCommit ? ", with changes made after SoftwareFactory checked it" : ""}.` : "You accepted it. It is in the project."; }
    else if (isWorking(ticket)) { state = "working"; says = "A run is working on it now."; }
    else if (proposed && d(proposed).held) { state = "held"; says = `Held on this computer: ${d(proposed).reason}`; }
    else if (proposed && d(proposed).released) { state = "proposed"; says = "You looked and let it go to GitHub. Waiting for you to accept."; }
    else if (proposed) { state = "proposed"; says = "Done and checked. Waiting for you to accept."; }
    else if (splitInto && splitLine!.id > sent.id) { state = "split"; says = `It did not get done whole, so SoftwareFactory split it into ${splitInto.join(", ")}. They are worked in its place.`; }
    else if (!go.length && question && WORKED.includes(kindNow)) { state = "asked"; says = question; }
    else if (!go.length && !WORKED.includes(kindNow)) { state = "kept"; says = `Kept on the list as ${kindNow === "idea" ? "an idea" : `a ${kindNow}`}. Only requests, bugs and tasks are sent to a run for now.`; }
    // A ticket from before there was a queue (its first line names no kind) is never started by itself.
    else if (!go.length && (typeof d(opened).kind === "string" || sent.kind === "ticket.queued")) { state = "waiting"; says = "Waiting for its turn."; }
    else if (ended) { state = d(ended).end as TicketState; says = String(d(ended).reason ?? ""); }
    else if (go.some((l) => l.kind === "stop.pressed")) { state = "stopped"; says = "You pressed stop."; }
    else if (fence && d(fence).ok === false) { state = "not started"; says = "The fence did not hold, so no run started."; }
    else { state = "interrupted"; says = ls.some((l) => l.id > sent.id && l.kind === "watchdog.spoke" && d(l).why === "gone") ? "SoftwareFactory went away while this was being worked. The watchdog ended the run; nothing left the computer." : !go.length ? "From before tickets waited their turn. Use Work it again to send it." : "SoftwareFactory was closed while this ticket was being worked."; }
    const number = proposed && typeof d(proposed).number === "number" ? (d(proposed).number as number) : null;
    out.push({
      ticket, project: opened.project, sentence: String(d(edit).sentence ?? d(opened).sentence ?? ""), kind: kindNow, openedAt: opened.ts, state, says,
      url: proposed && typeof d(proposed).url === "string" ? d(proposed).url : null, number,
      costUsd: Math.round(ls.reduce((a, l) => a + (l.costUsd ?? 0), 0) * 10000) / 10000,
      canAccept: state === "proposed" && number !== null,
      canUndo: state === "accepted" && typeof d(accepted).sha === "string" && !!d(accepted).sha,
      stops: state === "held" && Array.isArray(d(proposed).stop) ? (d(proposed).stop as any[]).slice(0, 40).map((x) => ({ family: String(x?.family ?? ""), file: String(x?.file ?? ""), why: String(x?.why ?? "") })) : [],
      canRelease: state === "held" && !removed && Array.isArray(d(proposed).stop) && d(proposed).stop.length > 0,
      canEdit: (state === "waiting" || state === "kept" || state === "asked") && !removed, canRemove: state !== "working" && !removed,
      canAgain: !removed && ["proposed", "failed its checks", "parked", "stopped", "crashed", "not started", "interrupted", "held"].includes(state) || (!removed && state === "waiting" && sent.kind === "ticket.queued" && sent.who !== "you"),
      removed, place: null, question: state === "asked" ? question : null, done: Array.isArray(d(gPassed).done) ? (d(gPassed).done as unknown[]).map(String) : [],
      asked: gAsked && gAnswered ? { question: String(d(gAsked).question ?? ""), answer: String(d(gAnswered).answer ?? "") } : null, gatePassed: !!gPassed && !d(gPassed).skipped, waitingSince: Math.max(sent.id, lastOf(ls, "ticket.restored")?.id ?? 0),
      issue: null,
      parkedFor: state === "parked" && typeof d(ended).parkedFor === "string" ? d(ended).parkedFor : null, endedAt: ended?.ts ?? null,
      returns: ls.filter((l) => l.kind === "ticket.queued" && d(l).returned && d(l).after !== "cut off").length, returnsAt: null,
      parent: typeof d(opened).parent === "string" ? d(opened).parent : null, ladder: sent.kind === "ticket.queued" && typeof d(sent).ladder === "string" ? (d(sent).ladder as Rung) : null, ladderUsed, splitInto, wasSplit: !!splitLine,
      // A stop the owner pressed ends the climbing too, however the run then wrote its end.
      climbable: !removed && !go.some((l) => l.kind === "stop.pressed") && isClimbable(state, ended ? { ...d(ended), run: ended.run } : null),
      lastFail: anyEnded && d(anyEnded).end !== "passed" ? { state: String(d(anyEnded).end ?? ""), reason: String(d(anyEnded).reason ?? ""), ...(failedCheck ? { tail: `${String(d(failedCheck).command ?? "")}\n${String(d(failedCheck).tail ?? "")}` } : {}) } : null,
      bucket: bucketOfSend(sent), limitUntil: null, keptWork: !!ended && !!d(ended).kept && !proposed,
      everWorked: ls.some((l) => l.kind === "fence.tested" || l.kind === "run.started"),
      lastWorkAt: go.at(-1)?.ts ?? null,
      cutOff: state === "interrupted" && go.length > 0, cutOffReturns: ls.filter((l) => l.kind === "ticket.queued" && d(l).returned && d(l).after === "cut off").length,
      steps: WORKED.includes(kindNow) ? stepsOf(ls, isWorking(ticket)) : [],
      story: ls.map((l) => ({ id: l.id, at: l.ts, who: l.who, what: storyLine(l), flagged: l.flagged })),
    });
  }
  for (const t of out) { const l = t.project ? links.get(`${t.project}\n${t.ticket}`) : undefined; if (l && l.number > 0) t.issue = { number: l.number, url: /^https:\/\//.test(l.url) ? l.url : "" }; }
  // A ticket that has smaller tickets cut from it was split, whatever else the record says: it is never split twice.
  for (const t of out) if (t.parent) { const p = out.find((x) => x.ticket === t.parent && x.project === t.project); if (p) p.wasSplit = true; }
  queueOf(out).forEach((t, i) => { t.place = i + 1; });
  return out.sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1));
}

/**
 * The rest after the plan limit. A run that met the limit says the next one would meet it too, so the queue rests
 * for the wait in Settings. It ends early only when you send a ticket to be worked again. (Not when another run
 * starts: with two runs at once, one may start just as the other meets the limit.)
 */
export function restOf(lines: RecordLine[], waitMinutes: number, now = Date.now()): { until: string; why: string } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (l.kind === "ticket.queued" && l.who === "you") return null;
    if (l.kind === "run.ended" && (l.data as any).parkedFor === "limit") {
      const until = Date.parse(l.ts) + waitMinutes * 60_000;
      return until > now ? { until: new Date(until).toISOString(), why: "the plan limit was reached" } : null;
    }
  }
  return null;
}

/** The queue: tickets that wait, first come first. */
export function queueOf(tickets: TicketView[]): TicketView[] {
  return tickets.filter((t) => t.state === "waiting" && !t.removed).sort((a, b) => a.waitingSince - b.waitingSince);
}

export interface HomeDeps {
  record: TheRecord;
  github: GitHub;
  settings: SettingsFile;
  /** Works one ticket to its end. The home screen starts it and never waits on it. */
  work: (st: Omit<TicketSettings, "workDir">, ticket: string, sentence: string, signal: AbortSignal) => Promise<TicketOutcome>;
  /** The reader at the ready gate. Without it there is no gate. */
  gate?: (q: { repo: GitHubRepo; base: string; sentence: string; asked: { question: string; answer: string } | null; model: string }) => Promise<GateResult>;
  /** host:port forms this page answers to. Anything else is refused, so a foreign name cannot be pointed here. */
  hosts: string[];
  /** The page's key. Made fresh at every start when not given. */
  key?: string;
  /** The pass in the address SoftwareFactory opens. Made fresh at every start when not given. */
  pass?: string;
  /** Takes an accepted change back. Left out: the page offers no undo. */
  undo?: (ticket: string) => Promise<{ ok: true; sha: string | null; url: string } | { ok: false; why: string }>;
  /** The reader that cuts a stuck ticket into smaller ones. Without it a ticket is never split. */
  split?: (q: { repo: GitHubRepo; base: string; sentence: string; failed: string; model: string }) => Promise<SplitResult>;
  /** Sends a result the stop list held on to GitHub, after the owner looked. Left out: the page offers no release. */
  release?: (ticket: string) => Promise<{ ok: true; url: string; number: number | null } | { ok: false; why: string }>;
  /** How a line reaches the phone. Left out: the real sender. */
  send?: Sender;
  /** Shown on the page: which room, and what a run may reach. Read-only here; the fence is changed by hand. */
  fence?: { room: string; netList: string[] };
}

export function createHome(deps: HomeDeps) {
  const { record, github } = deps;
  const key = deps.key ?? randomBytes(24).toString("hex");
  const pass = deps.pass ?? randomBytes(24).toString("hex"), cookie = randomBytes(24).toString("hex"), cookieName = `sf${randomBytes(4).toString("hex")}`;
  // The pass opens the page once. The address travels through a command line and the browser's history; after
  // the first use it is worth nothing.
  let passUsed = false;
  type Run = { ticket: string; stop: AbortController; startedAt: string; lastLineAt: string; bucket: Bucket; budget: number };
  /** The runs that work right now, by ticket, in the order they started. */
  const runs = new Map<string, Run>();
  const working = (): ReadonlySet<string> => new Set(runs.keys());
  const first = (): Run | null => runs.values().next().value ?? null;
  const splitTries = new Map<string, number>();
  // The ladder climbs only runs that ended while this SoftwareFactory was open: opening the screen never starts
  // paid work on a failure from before.
  const openedAt = Date.now();
  let accepting = false, undoing = false, releasing = false, closing = false;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  const streams = new Set<ServerResponse>();
  record.onLine((l) => { const mine = l.ticket ? runs.get(l.ticket) : undefined; if (mine && l.kind !== "watchdog.spoke") mine.lastLineAt = l.ts; for (const s of streams) s.write(`data: ${JSON.stringify({ id: l.id })}\n\n`); });

  let all: RecordLine[] = [];
  const returnTime = (t: TicketView, s: HomeSettings) => (t.state === "parked" && t.parkedFor === "limit" && !t.removed && t.endedAt && t.returns < s.parkedReturns ? Date.parse(t.endedAt) + s.parkedWaitMinutes * 60_000 : null);
  /** The two limits as they stand: what the record says was used this period, less what the runs at work may still use. */
  const limitsNow = (s: HomeSettings, lines: RecordLine[], now = new Date()) => {
    const used = spendOf(lines, periodStart(s.limitPeriod, now));
    const held = { you: 0, alone: 0, own: 0 };
    for (const r of runs.values()) held[r.bucket] += r.budget;
    const room = roomLeft(s, { you: used.you + held.you, alone: used.alone + held.alone, own: used.own + held.own });
    return { period: s.limitPeriod, until: periodEnd(s.limitPeriod, now).toISOString(), used, room, limit: { you: s.limitYou, alone: s.limitAlone, own: Math.round(s.limitAlone * s.ownSharePercent) / 100 } };
  };
  const state = () => {
    const settings = deps.settings.read();
    const tickets = ticketsFrom(all = record.all(), working());
    const limits = limitsNow(settings, all);
    for (const t of tickets) { const at = returnTime(t, settings); if (at) t.returnsAt = new Date(at).toISOString(); if (t.state === "waiting" && !t.removed && runBudget(settings, roomLeft(settings, limits.used), t.bucket) <= 0) { t.limitUntil = limits.until; t.says = `Waiting: ${t.bucket === "you" ? "limit 1 (work you sent)" : "limit 2 (what SoftwareFactory does by itself)"} is used up for this ${limits.period}.`; } }
    return { ...stateOf(settings, tickets), issuesSeen: lastSync, resting: restOf(all, settings.parkedWaitMinutes), limits, since: sinceYouLeft(all, tickets, settings.sinceShow) };
  };
  const stateOf = (settings: HomeSettings, tickets: TicketView[]) => ({
    settings,
    fence: deps.fence ?? null,
    running: first() ? { ticket: first()!.ticket, startedAt: first()!.startedAt } : null,
    runs: [...runs.values()].map((r) => ({ ticket: r.ticket, startedAt: r.startedAt })),
    tickets,
    spoke: all.filter((l) => l.kind === "watchdog.spoke" && (l.data as any).why !== "test").slice(-3).map((l) => ({ id: l.id, at: l.ts, line: String((l.data as any).line ?? ""), phone: String((l.data as any).phone ?? "") })),
  });
  /** The sign of life the watchdog reads. */
  // The watchdog reads one run: the one that has been quiet longest speaks for all.
  const quietest = () => [...runs.values()].sort((a, b) => (a.lastLineAt < b.lastLineAt ? -1 : 1))[0] ?? null;
  const alive = () => { const q = quietest(); return { pid: process.pid, at: new Date().toISOString(), opened: passUsed, running: q ? { ticket: q.ticket, startedAt: q.startedAt, lastLineAt: q.lastLineAt } : null, runs: runs.size }; };

  const tell = () => { for (const st of streams) st.write(`data: {"id":0}\n\n`); };
  const view = (ticket: string) => ticketsFrom(record.story(ticket), working())[0];
  const words = (sentence: string): string | null => (!sentence.trim() ? "Write what you want first." : sentence.length > 4000 ? "That is too long for one ticket. Keep it under 4000 characters." : null);
  const isKind = (k: unknown): k is TicketKind => (TICKET_KINDS as readonly string[]).includes(k as string);

  /** A new ticket. It waits for its turn; the queue takes it from there. */
  function start(sentence: string, kind: unknown = "request"): { ok: true; ticket: string } | { ok: false; why: string } {
    const bad = words(sentence);
    if (bad) return { ok: false, why: bad };
    if (!isKind(kind)) return { ok: false, why: "That is not a kind of ticket." };
    const repo = parseGitHubRepo(deps.settings.read().repo);
    if (!repo) return { ok: false, why: "Choose the project first, in Settings." };
    const ticket = openTicket(record, `${repo.owner}/${repo.name}`, sentence, kind);
    pump();
    return { ok: true, ticket };
  }

  /**
   * The third rung: the ticket is cut once into smaller tickets, which are worked in its place. Never twice.
   * The reader takes a place among the runs while it reads, so nothing else in the room ends it and Stop reaches it.
   */
  function split(t: TicketView, s: HomeSettings): void {
    const key = `${t.project}\n${t.ticket}`, repo = parseGitHubRepo(t.project ?? "");
    const stamp = { ticket: t.ticket, project: t.project };
    if (!deps.split || !repo) { record.append({ kind: "ticket.split", who: "SF itself", ...stamp, data: { into: [], why: "there is no reader to split it here" } }); return; }
    if (t.sentence.trim().length < s.ladderSplitMinChars) { record.append({ kind: "ticket.split", who: "SF itself", ...stamp, data: { into: [], why: "it is one short sentence, so there is nothing to cut" } }); return; }
    const stop = new AbortController();
    const mine: Run = { ticket: t.ticket, stop, startedAt: new Date().toISOString(), lastLineAt: new Date().toISOString(), bucket: "alone", budget: 0 };
    runs.set(t.ticket, mine);
    splitTries.set(key, (splitTries.get(key) ?? 0) + 1);
    const failed = t.lastFail ? `${t.lastFail.state}: ${t.lastFail.reason}${t.lastFail.tail ? `\n${t.lastFail.tail}` : ""}` : t.says;
    void deps.split({ repo, base: s.base, sentence: t.sentence, failed, model: s.ladderSplitModel })
      .catch((e): SplitResult => ({ ok: false, why: String((e as Error)?.message ?? e).slice(0, 200) }))
      .then((r) => {
        if (runs.get(t.ticket) === mine) runs.delete(t.ticket);
        // Only if the ticket still stands where it stood: the owner may have stopped, sent, changed or removed it meanwhile.
        const now = view(t.ticket);
        if (closing || stop.signal.aborted || !now || now.removed || !now.climbable || now.wasSplit) return;
        // The plan limit met by the reader: the queue rests like after any run that met it, and the split is not used up.
        if (!r.ok && /plan limit/.test(r.why)) { record.append({ kind: "run.ended", who: "SF itself", ...stamp, data: { end: "parked", reason: "the plan limit was reached before the ticket could be split", parkedFor: "limit", where: "before the run" } }); return; }
        // A reader that could not be asked is tried once more later; only its second failure ends the rung.
        if (!r.ok && (splitTries.get(key) ?? 0) < 2) return;
        if (!r.ok || !r.parts.length) { record.append({ kind: "ticket.split", who: "SF itself", ...stamp, costUsd: r.ok ? r.costUsd || null : null, data: { into: [], why: r.ok ? "it cannot be cut into smaller whole pieces" : r.why } }); return; }
        const into = r.parts.map((p) => openTicket(record, t.project!, p, "task", { parent: t.ticket }));
        record.append({ kind: "ticket.split", who: "SF itself", ...stamp, costUsd: r.costUsd || null, data: { into } });
      })
      .catch(() => undefined)
      .finally(() => { if (runs.get(t.ticket) === mine) runs.delete(t.ticket); try { tell(); pump(); } catch { /* the next thing that happens wakes the queue */ } });
  }

  /** The queue: when nothing is being worked and the queue is not held, the ticket that waited longest starts. */
  function pump(): void {
    if (closing) return;
    const s = deps.settings.read();
    if (runs.size >= s.slots) return;
    // Parked for the plan limit: after the wait the ticket comes back to the queue by itself, a set number of times.
    const lines = record.all(), now = Date.now();
    let wake = Infinity;
    const seenNow = ticketsFrom(lines, working());
    // The stuck ladder climbs only in the project Settings speak for, only while limit 2 has room for a run, and
    // counts the tries of a split's smaller tickets as it goes, so one pass cannot hand out more than they share.
    const mineOnly = parseGitHubRepo(s.repo), aloneRoom = runBudget(s, limitsNow(s, lines).room, "alone") > 0;
    const shared = new Map<string, number>();
    for (const x of seenNow) if (x.parent) shared.set(`${x.project}\n${x.parent}`, (shared.get(`${x.project}\n${x.parent}`) ?? 0) + x.ladderUsed);
    let toSplit: TicketView | null = null;
    for (const t of seenNow) {
      // The stuck ladder: a ticket whose run did not finish climbs by itself, one rung at a time, then waits for the owner.
      const fam = `${t.project}\n${t.parent}`;
      const rung = mineOnly && t.project === `${mineOnly.owner}/${mineOnly.name}` && aloneRoom ? nextRung(s, { climbable: t.climbable && !!t.endedAt && Date.parse(t.endedAt) >= openedAt && now - Date.parse(t.endedAt) < s.ladderWithinMinutes * 60_000, used: t.ladderUsed, child: !!t.parent, siblingsUsed: t.parent ? shared.get(fam) ?? 0 : 0, wasSplit: t.wasSplit }) : null;
      if (rung === "once more" || rung === "another way") { record.append({ kind: "ticket.queued", who: "SF itself", ticket: t.ticket, project: t.project, data: { ladder: rung, rung: t.ladderUsed + 1, why: `its run ended as ${t.state}` } }); if (t.parent) shared.set(fam, (shared.get(fam) ?? 0) + 1); }
      else if (rung === "split" && !toSplit) toSplit = t;
      const at = returnTime(t, s);
      // Cut off in the middle (SoftwareFactory was closed, the computer restarted): the steps are safe to repeat.
      if (t.cutOff && !t.removed && t.cutOffReturns < s.cutOffReturns && t.lastWorkAt && now - Date.parse(t.lastWorkAt) < s.cutOffWithinHours * 3_600_000) record.append({ kind: "ticket.queued", who: "SF itself", ticket: t.ticket, project: t.project, data: { returned: true, after: "cut off", why: "it was cut off in the middle, so it is worked again from the start", time: t.cutOffReturns + 1 } });
      if (at === null) continue;
      if (at <= now) record.append({ kind: "ticket.queued", who: "SF itself", ticket: t.ticket, project: t.project, data: { returned: true, why: `the wait of ${s.parkedWaitMinutes} minutes after the plan limit is over`, time: t.returns + 1 } });
      else wake = Math.min(wake, at);
    }
    // While the limit is fresh nothing new starts: the next run would only meet it too.
    const rest = restOf(lines, s.parkedWaitMinutes, now);
    if (rest) wake = Math.min(wake, Date.parse(rest.until));
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = wake === Infinity ? null : setTimeout(() => { wakeTimer = null; try { pump(); tell(); } catch { /* the next thing that happens wakes the queue */ } }, Math.min(Math.max(wake - now, 1000), 2 ** 31 - 1));
    wakeTimer?.unref?.();
    if (s.hold || rest) return;
    // A ticket at the split rung: the reader takes the free place now, and the queue goes on when it has answered.
    if (toSplit && !runs.has(toSplit.ticket)) { split(toSplit, s); if (runs.size >= s.slots) return; }
    // Settings speak for one project. A ticket of another project waits until Settings point at it again.
    const here = parseGitHubRepo(s.repo);
    // The two limits: work of a kind whose limit is used up does not start, and the other kind goes on. Nothing is asked for.
    const limits = limitsNow(s, record.all());
    const inLine = queueOf(ticketsFrom(record.all(), working())).filter((t) => !here || t.project === `${here.owner}/${here.name}`);
    const next = inLine.find((t) => runBudget(s, limits.room, t.bucket) > 0);
    if (!next) {
      // When the period turns the limits are whole again: the queue wakes by itself then.
      if (inLine.length && !wakeTimer) { wakeTimer = setTimeout(() => { wakeTimer = null; try { pump(); tell(); } catch { /* the next thing that happens wakes the queue */ } }, Math.min(Math.max(Date.parse(limits.until) - now, 1000), 2 ** 31 - 1)); wakeTimer.unref?.(); }
      return;
    }
    const budget = runBudget(s, limits.room, next.bucket);
    const repo = parseGitHubRepo(next.project ?? "");
    if (!repo) { record.append({ kind: "run.ended", who: "SF itself", ticket: next.ticket, project: next.project, data: { end: "crashed", reason: "the record does not say which project this ticket is for", where: "before the run" } }); return pump(); }
    const stop = new AbortController();
    const mine: Run = { ticket: next.ticket, stop, startedAt: new Date().toISOString(), lastLineAt: new Date().toISOString(), bucket: next.bucket, budget };
    runs.set(mine.ticket, mine);
    const before = record.all().at(-1)?.id ?? 0;
    const stamp = { ticket: next.ticket, project: next.project };
    // The ready gate first: the test of done is written before the run, and an unclear sentence is asked about once.
    const ready = async (): Promise<string[] | null> => {
      if (next.gatePassed) return next.done;
      if (!s.gate || !deps.gate) return [];
      let g: GateResult;
      // Stop does not wait for the reader: the queue is free at once, and whatever the reader says later is dropped.
      const stopped = new Promise<null>((ok) => stop.signal.addEventListener("abort", () => ok(null), { once: true }));
      try { const got = await Promise.race([deps.gate({ repo, base: s.base, sentence: next.sentence, asked: next.asked, model: s.gateModel }), stopped]); if (!got) return null; g = got; } catch (e) { g = { ok: false, why: String((e as Error)?.message ?? e).slice(0, 200) }; }
      if (stop.signal.aborted) return null;
      // A gate that cannot be asked never holds a ticket up: it passes without a test of done, and the story says so.
      // The plan limit met at the gate: the ticket is parked for it, the queue rests, and it comes back by itself.
      if (!g.ok && /plan limit/.test(g.why)) { record.append({ kind: "run.ended", who: "SF itself", ...stamp, data: { end: "parked", reason: "the plan limit was reached before the run could start", parkedFor: "limit", where: "before the run" } }); return null; }
      if (!g.ok) { record.append({ kind: "gate.passed", who: "SF itself", ...stamp, data: { skipped: `the gate could not be asked: ${g.why}`, done: [] } }); return []; }
      const a = g.answer;
      if (!a.clear && a.question && !next.asked) { record.append({ kind: "gate.asked", who: "SF itself", ...stamp, costUsd: a.costUsd || null, data: { question: a.question } }); return null; }
      record.append({ kind: "gate.passed", who: "SF itself", ...stamp, costUsd: a.costUsd || null, data: { kind: a.kind, done: a.done, guesses: a.guesses } });
      return a.done;
    };
    void ready().then((done) => (done === null ? undefined : deps.work({ repo, base: s.base, checks: s.checks, prepare: s.prepare, model: next.ladder === "another way" && s.ladderModel ? s.ladderModel : s.model, ...(next.ladder && next.ladder !== "split" && next.lastFail ? { hint: ladderHint(next.ladder, next.lastFail) } : {}), maxTurns: s.maxTurns, timeLimitMinutes: s.timeLimitMinutes, stopPaths: s.stopPaths, budgetUsd: budget, done, ...(next.issue ? { issue: next.issue.number } : {}), ...(s.slots > 1 ? { ownCell: true } : {}) }, next.ticket, next.sentence, stop.signal)))
      .catch((e) => { record.append({ kind: "run.ended", who: "SF itself", ticket: mine.ticket, project: next.project, data: { end: "crashed", reason: String((e as Error)?.message ?? e).slice(0, 300), where: "before the run" } }); })
      .catch(() => undefined)
      .finally(() => {
        let again = true;
        try {
          // A go that left no line of work would wait again and start again without end: it is given an end.
          const trace = record.since(before).some((l) => l.ticket === mine.ticket && !l.kind.startsWith("ticket.") && l.kind !== "gate.passed" && l.kind !== "gate.answered" && l.kind !== "issue.linked" && l.kind !== "watchdog.spoke");
          if (!trace) record.append({ kind: "run.ended", who: "SF itself", ticket: mine.ticket, project: next.project, data: { end: "crashed", reason: "the run left no trace", where: "before the run" } });
        } catch { again = false; /* the record could not be written: the queue rests until something wakes it */ }
        if (runs.get(mine.ticket) === mine) runs.delete(mine.ticket);
        try { tell(); if (again) pump(); } catch { /* the next thing that happens wakes the queue */ }
      });
    tell();
    // A free slot is filled at once: the next ticket that waits starts beside this one.
    if (runs.size < s.slots) pump();
  }

  /** One look at GitHub's issues, as Settings say. One at a time; never throws. */
  let syncing: Promise<IssueSync> | null = null, lastSync: { at: string; ok: boolean; why: string | null } | null = null;
  function issues(): Promise<IssueSync> {
    if (syncing) return syncing;
    const s = deps.settings.read(), repo = parseGitHubRepo(s.repo);
    if (!repo || s.issues === "off" || closing) return Promise.resolve({ ok: true, in: [], out: [], closed: [], skipped: 0 });
    const tickets = () => ticketsFrom(record.all(), working()).map((t) => ({ ticket: t.ticket, project: t.project, sentence: t.sentence, kind: t.kind, removed: t.removed, untouched: ["waiting", "asked", "kept"].includes(t.state) && !t.everWorked && !runs.has(t.ticket) }));
    syncing = syncIssues({ record, github }, repo, { mode: s.issues, label: s.issuesLabel, tickets })
      .then((r) => { lastSync = { at: new Date().toISOString(), ok: r.ok, why: r.why ?? null }; return r; })
      .finally(() => { syncing = null; try { tell(); pump(); } catch { /* the next thing that happens wakes the queue */ } });
    return syncing;
  }
  /** Look at GitHub now and then, as often as Settings say. The caller starts it; closing ends it. */
  let issueTimer: ReturnType<typeof setInterval> | null = null;
  function watchIssues(): void {
    if (issueTimer) return;
    let last = 0;
    const tick = () => { const s = deps.settings.read(); if (s.issues !== "off" && Date.now() - last >= s.issuesEveryMinutes * 60_000) { last = Date.now(); void issues(); } };
    issueTimer = setInterval(tick, 30_000); issueTimer.unref?.();
    tick();
  }

  /** SoftwareFactory is closing: the run that works is stopped by the caller, and nothing new starts. */
  function close(): void { closing = true; if (wakeTimer) clearTimeout(wakeTimer); wakeTimer = null; if (issueTimer) clearInterval(issueTimer); issueTimer = null; }

  /** Stop one run, or with no name every run that works. */
  function stopNow(ticket?: string): { ok: boolean; why?: string } {
    const which = ticket ? [runs.get(ticket)].filter((r): r is Run => !!r) : [...runs.values()];
    if (!which.length) return { ok: false, why: ticket ? "That ticket is not being worked." : "Nothing is running." };
    for (const r of which) { record.append({ kind: "stop.pressed", who: "you", ticket: r.ticket, data: {} }); r.stop.abort(); }
    return { ok: true };
  }

  type Did = { ok: true } | { ok: false; why: string };
  const NONE: Did = { ok: false, why: "There is no such ticket." };
  /** Change a waiting ticket's words or kind. After a run its words are frozen. */
  function edit(ticket: string, sentence: unknown, kind: unknown): Did {
    const t = view(ticket);
    if (!t) return NONE;
    if (!t.canEdit) return { ok: false, why: "Only a ticket that still waits can be changed." };
    const data: Record<string, unknown> = {};
    if (typeof sentence === "string" && sentence.trim() !== t.sentence) { const bad = words(sentence); if (bad) return { ok: false, why: bad }; data.sentence = sentence.trim(); }
    if (kind !== undefined && kind !== t.kind) { if (!isKind(kind)) return { ok: false, why: "That is not a kind of ticket." }; data.kind = kind; }
    if (Object.keys(data).length) record.append({ kind: "ticket.edited", who: "you", ticket, project: t.project, data });
    pump();
    return { ok: true };
  }
  /** Take a ticket off the list. The record keeps it, and it can be put back. */
  function remove(ticket: string): Did {
    const t = view(ticket);
    if (!t) return NONE;
    if (!t.canRemove) return { ok: false, why: t.removed ? "It is off the list already." : "A ticket that is being worked cannot be removed. Stop it first." };
    record.append({ kind: "ticket.removed", who: "you", ticket, project: t.project, data: {} });
    return { ok: true };
  }
  function restore(ticket: string): Did {
    const t = view(ticket);
    if (!t) return NONE;
    if (!t.removed) return { ok: false, why: "It is on the list." };
    record.append({ kind: "ticket.restored", who: "you", ticket, project: t.project, data: {} });
    pump();
    return { ok: true };
  }
  /** The owner's answer to the one question the gate asked. The ticket takes its turn again. */
  function answer(ticket: string, text: unknown): Did {
    const t = view(ticket);
    if (!t) return NONE;
    if (t.state !== "asked" || t.removed) return { ok: false, why: "This ticket is not waiting for an answer." };
    if (typeof text !== "string" || !text.trim()) return { ok: false, why: "Write your answer first." };
    if (text.length > 2000) return { ok: false, why: "Keep the answer under 2000 characters." };
    record.append({ kind: "gate.answered", who: "you", ticket, project: t.project, data: { answer: text.trim() } });
    pump();
    return { ok: true };
  }
  /** Send a ticket to be worked again, under the same name. */
  function again(ticket: string, clean = false): Did {
    const t = view(ticket);
    if (!t) return NONE;
    if (!t.canAgain) return { ok: false, why: "This ticket cannot be sent again from where it stands." };
    // A ticket SoftwareFactory queued by itself and that still waits is taken over by the owner: it is theirs from here.
    record.append({ kind: "ticket.queued", who: "you", ticket, project: t.project, data: clean ? { clean: true } : {} });
    pump();
    return { ok: true };
  }

  /** Accept: the proposal goes into the project, exactly the commit that was checked and nothing newer. */
  async function accept(ticket: string): Promise<{ ok: true; sha: string } | { ok: false; why: string }> {
    if (accepting) return { ok: false, why: "An accept is already on its way." };
    accepting = true;
    try {
      const lines = record.story(ticket);
      if (lines.some((l) => l.kind === "result.accepted")) return { ok: false, why: "You accepted this one already." };
      if (view(ticket)?.removed) return { ok: false, why: "This ticket is off the list. Put it back first." };
      // Only a proposal of the ticket's latest go, with nothing working on it: an older one that was sent to be worked again is not accepted from here.
      if (!view(ticket)?.canAccept) return { ok: false, why: "This ticket has no proposal that can be accepted from here." };
      const p = [...lines].reverse().find((l) => l.kind === "result.proposed");
      const d = (p?.data ?? {}) as Record<string, any>;
      if (!p || d.held || typeof d.number !== "number" || typeof d.headSha !== "string") return { ok: false, why: "This ticket has no proposal that can be accepted from here." };
      const repo = parseGitHubRepo(p.project ?? "");
      if (!repo) return { ok: false, why: "The record does not say which project this was." };
      if (!github.hasToken()) return { ok: false, why: "This computer has no GitHub sign-in that can accept. Open the proposal on GitHub instead." };
      const pr = await github.prDetail(repo, d.number);
      if (pr.merged) {
        // Somebody merged it on GitHub. The record says so, and says when it was not the commit that was checked.
        record.append({ kind: "result.accepted", who: "SF itself", run: p.run, ticket, project: p.project, data: { number: d.number, sha: pr.mergeSha, foundMerged: true, ...(pr.headSha !== d.headSha ? { notTheCheckedCommit: true } : {}) } });
        return { ok: true, sha: pr.mergeSha ?? "" };
      }
      if (pr.state !== "open") return { ok: false, why: "The proposal was closed on GitHub." };
      if (pr.headSha !== d.headSha) return { ok: false, why: "The proposal changed on GitHub after SoftwareFactory checked it, so it is not accepted from here. Look at it on GitHub." };
      if (pr.base !== d.base) return { ok: false, why: "The proposal now points at another branch than the one it was made for." };
      if (pr.mergeable === false) return { ok: false, why: "The project moved on and this proposal no longer fits on top of it. Use Work it again." };
      if (pr.draft) await github.markReady(pr.nodeId);
      const ci = await github.ci(repo, d.headSha).catch(() => null);
      const merged = await github.mergePr(repo, d.number, d.headSha, pr.title);
      record.append({ kind: "result.accepted", who: "you", run: p.run, ticket, project: p.project, data: { number: d.number, sha: merged.sha, base: d.base, githubChecks: ci?.state ?? "unknown" } });
      return { ok: true, sha: merged.sha };
    } catch (e) {
      return { ok: false, why: `GitHub did not take it: ${(e as Error).message.slice(0, 200)}` };
    } finally { accepting = false; }
  }

  /** Before the confirm step: what GitHub's own checks say about the proposal right now. Read-only. */
  async function look(ticket: string): Promise<{ ok: true; githubChecks: string } | { ok: false; why: string }> {
    const p = [...record.story(ticket)].reverse().find((l) => l.kind === "result.proposed");
    const d = (p?.data ?? {}) as Record<string, any>;
    const repo = parseGitHubRepo(p?.project ?? "");
    if (!p || !repo || typeof d.headSha !== "string" || !["proposed", "accepted"].includes(view(ticket)?.state ?? "")) return { ok: false, why: "This ticket has no proposal that can be accepted from here." };
    try {
      const ci = await github.ci(repo, d.headSha);
      const says = ci.state === "green" ? "GitHub's own checks passed." : ci.state === "running" ? "GitHub's own checks are still running." : ci.state === "none" ? "GitHub ran no checks of its own on this proposal." : `GitHub's own checks FAILED (${ci.failed.slice(0, 4).join(", ") || "see the proposal"}).`;
      return { ok: true, githubChecks: says };
    } catch { return { ok: true, githubChecks: "GitHub's own checks could not be read just now." }; }
  }

  function saveSettings(raw: unknown): { ok: true; settings: HomeSettings } | { ok: false; why: string } {
    const was = deps.settings.read();
    let now: HomeSettings;
    try { now = cleanSettings(raw, was); } catch (e) { return { ok: false, why: (e as Error).message }; }
    const changed = (Object.keys(now) as (keyof HomeSettings)[]).filter((k) => JSON.stringify(now[k]) !== JSON.stringify(was[k]));
    if (changed.length) {
      deps.settings.write(now);
      record.append({ kind: "setting.changed", who: "you", data: { changed: Object.fromEntries(changed.map((k) => [k, k === "ntfyTopic" ? { changed: true } : { from: was[k], to: now[k] }])) } });
    }
    // A queue that was held and is let go starts at once.
    pump();
    return { ok: true, settings: now };
  }

  const same = (got: string, want: string) => { const a = Buffer.from(got), b = Buffer.from(want); return a.length === b.length && timingSafeEqual(a, b); };
  const sameKey = (got: string | undefined) => same(got ?? "", key);
  const send = (res: ServerResponse, code: number, body: unknown) => { const t = JSON.stringify(body); res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(t); };
  const body = (req: IncomingMessage) => new Promise<any>((resolve, reject) => {
    let t = ""; req.setEncoding("utf8");
    req.on("data", (d: string) => { t += d; if (t.length > 100_000) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(t ? JSON.parse(t) : {}); } catch { reject(new Error("not JSON")); } });
    req.on("error", reject);
  });

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!deps.hosts.includes(String(req.headers.host ?? "").toLowerCase())) { res.writeHead(403).end("not this computer's own page"); return; }
      const url = new URL(req.url ?? "/", "http://x");
      // The way in: the address SoftwareFactory itself opened or printed carries a pass. It is swapped for a cookie
      // that scripts cannot read, and nothing here is shown or told to a caller without that cookie. So another
      // account on this computer, or anything that merely reaches the port, gets no page, no key and no state.
      if (req.method === "GET" && url.pathname === "/" && url.searchParams.has("pass")) {
        if (passUsed || !same(url.searchParams.get("pass") ?? "", pass)) { res.writeHead(403).end("this pass is not the one SoftwareFactory printed"); return; }
        passUsed = true;
        res.writeHead(303, { location: "/", "set-cookie": `${cookieName}=${cookie}; HttpOnly; SameSite=Strict; Path=/`, "cache-control": "no-store", "referrer-policy": "no-referrer" }).end();
        return;
      }
      const got = new RegExp(`(?:^|;\\s*)${cookieName}=([A-Za-z0-9]+)`).exec(String(req.headers.cookie ?? ""))?.[1] ?? "";
      if (!same(got, cookie)) { res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("This page opens once, from SoftwareFactory's own window. Close that window and start SoftwareFactory again to get back in."); return; }
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        });
        res.end(homePage(key));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/step1/state") return send(res, 200, state());
      if (req.method === "GET" && url.pathname === "/api/step1/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(": hello\n\n");
        streams.add(res);
        req.on("close", () => streams.delete(res));
        return;
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/step1/")) {
        // The page's own key, and a body that only a page of ours would send as JSON.
        if (!sameKey(String(req.headers["x-sf-key"] ?? "")) || !String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 403, { ok: false, why: "This did not come from the SoftwareFactory page. Reload the page." });
        const b = await body(req);
        if (url.pathname === "/api/step1/work") { const r = start(String(b.sentence ?? ""), b.kind ?? "request"); return send(res, r.ok ? 200 : 409, r); }
        if (url.pathname === "/api/step1/ticket/edit") { const r = edit(String(b.ticket ?? ""), b.sentence, b.kind); return send(res, r.ok ? 200 : 409, r); }
        if (url.pathname === "/api/step1/ticket/remove") { const r = remove(String(b.ticket ?? "")); return send(res, r.ok ? 200 : 409, r); }
        if (url.pathname === "/api/step1/ticket/restore") { const r = restore(String(b.ticket ?? "")); return send(res, r.ok ? 200 : 409, r); }
        if (url.pathname === "/api/step1/ticket/answer") { const r = answer(String(b.ticket ?? ""), b.answer); return send(res, r.ok ? 200 : 409, r); }
        if (url.pathname === "/api/step1/issues") { const r = await issues(); return send(res, r.ok ? 200 : 409, r); }
        if (url.pathname === "/api/step1/ticket/again") { const r = again(String(b.ticket ?? ""), b.clean === true); return send(res, r.ok ? 200 : 409, r); }
        if (url.pathname === "/api/step1/stop") { const r = stopNow(typeof b.ticket === "string" && b.ticket ? b.ticket : undefined); return send(res, r.ok ? 200 : 409, r); }
        if (url.pathname === "/api/step1/look") { const r = await look(String(b.ticket ?? "")); return send(res, r.ok ? 200 : 409, r); }
        if (url.pathname === "/api/step1/accept") { const r = await accept(String(b.ticket ?? "")); return send(res, r.ok ? 200 : 409, r); }
        if (url.pathname === "/api/step1/seen") {
          // "Got it": from here on the panel shows only what happens after this line. Nothing is hidden or removed.
          const sn = state().since, upTo = Number.isInteger(b.upTo) && b.upTo >= 0 && b.upTo <= sn.upTo ? (b.upTo as number) : sn.upTo;
          if (sn.items.length || sn.cameBack) { record.append({ kind: "home.seen", who: "you", data: { upTo, cutOff: sn.cutOff.slice(0, 500) } }); tell(); }
          return send(res, 200, { ok: true });
        }
        if (url.pathname === "/api/step1/release") {
          const t = String(b.ticket ?? "");
          if (!deps.release || releasing) return send(res, 409, { ok: false, why: releasing ? "A release is already on its way." : "Letting a held result go is not set up here." });
          if (!view(t)?.canRelease) return send(res, 409, { ok: false, why: "This ticket has no held result that can be let go from here." });
          releasing = true;
          try { const r = await deps.release(t); if (r.ok) tell(); return send(res, r.ok ? 200 : 409, r); } finally { releasing = false; }
        }
        if (url.pathname === "/api/step1/undo") {
          if (!deps.undo || undoing) return send(res, 409, { ok: false, why: undoing ? "An undo is already on its way." : "Undo is not set up here." });
          undoing = true;
          try { const r = await deps.undo(String(b.ticket ?? "")); return send(res, r.ok ? 200 : 409, r); } finally { undoing = false; }
        }
        if (url.pathname === "/api/step1/phone-test") {
          const r = await speak({ record, settings: () => deps.settings.read(), send: deps.send }, { line: "This is SoftwareFactory. Your phone line works.", why: "test" });
          return send(res, r.phone === "sent" ? 200 : 409, r.phone === "sent" ? { ok: true } : { ok: false, why: r.phone === "not set" ? "No phone is set yet. Choose ntfy and a channel name, and save first." : "The line did not reach the phone service. Check the server address and your network." });
        }
        if (url.pathname === "/api/step1/settings") { const r = saveSettings(b); return send(res, r.ok ? 200 : 400, r); }
      }
      send(res, 404, { ok: false, why: "no such thing here" });
    } catch (e) {
      if (!res.headersSent) send(res, 500, { ok: false, why: (e as Error).message.slice(0, 200) });
      else res.end();
    }
  }

  return { handler, state, start, pump, close, issues, watchIssues, answer, edit, remove, restore, again, stop: stopNow, accept, saveSettings, key, pass, cookie, cookieName, look, alive, isRunning: () => runs.size > 0 };
}
