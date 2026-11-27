import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { type GitHub, parseGitHubRepo } from "../tickets/github.js";
import { homePage } from "./homepage.js";
import type { RecordLine, TheRecord } from "./record.js";
import { type TicketOutcome, type TicketSettings, storyLine } from "./ticketrun.js";

/**
 * The home screen (build step 1, slice 3): one page on this computer only. You type a sentence, watch the run,
 * read the story of each ticket, and accept a result. Every picture on it is drawn from the record and from
 * nothing else; the page keeps no truth of its own.
 *
 * It listens on 127.0.0.1 only. Anything that changes something needs the page's own key, which only a page
 * served from here has, so another site open in the browser cannot press its buttons.
 */

/** What you can change on the screen. The project is written "owner/name". */
export interface HomeSettings {
  repo: string;
  base: string;
  checks: string[];
  prepare: string[];
  model: string;
  maxTurns: number;
  timeLimitMinutes: number;
}

export const HOME_DEFAULTS: HomeSettings = { repo: "", base: "", checks: [], prepare: [], model: "sonnet", maxTurns: 80, timeLimitMinutes: 45 };

/** Check what came from the screen. Returns clean settings or says, in a sentence, what is wrong. */
export function cleanSettings(raw: unknown, from: HomeSettings = HOME_DEFAULTS): HomeSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (k: keyof HomeSettings) => (typeof r[k] === "string" ? (r[k] as string).trim() : (from[k] as string));
  const list = (k: "checks" | "prepare") => (Array.isArray(r[k]) ? (r[k] as unknown[]).filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean) : from[k]);
  const num = (k: "maxTurns" | "timeLimitMinutes") => (r[k] === undefined ? from[k] : Number(r[k]));
  const s: HomeSettings = { repo: text("repo"), base: text("base"), checks: list("checks"), prepare: list("prepare"), model: text("model"), maxTurns: num("maxTurns"), timeLimitMinutes: num("timeLimitMinutes") };
  if (s.repo && !parseGitHubRepo(s.repo)) throw new Error(`"${s.repo}" is not a project on GitHub. Write it as owner/name.`);
  if (s.base && (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(s.base) || s.base.includes(".."))) throw new Error(`"${s.base}" is not a branch name.`);
  if (!/^[a-z0-9][a-z0-9.-]{0,60}$/.test(s.model)) throw new Error(`"${s.model}" is not a model name.`);
  if (!Number.isInteger(s.maxTurns) || s.maxTurns < 1 || s.maxTurns > 500) throw new Error("Turns must be a whole number from 1 to 500.");
  if (!Number.isInteger(s.timeLimitMinutes) || s.timeLimitMinutes < 1 || s.timeLimitMinutes > 600) throw new Error("The time limit must be from 1 to 600 minutes.");
  for (const c of [...s.checks, ...s.prepare]) if (c.length > 500 || /[\r\n\0]/.test(c)) throw new Error("A check or a prepare command is one line of at most 500 characters.");
  if (s.checks.length > 20 || s.prepare.length > 20) throw new Error("At most 20 checks and 20 prepare commands.");
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
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, this.path);
  }
}
export const settingsFileIn = (workDir: string, start: Partial<HomeSettings> = {}) => new SettingsFile(join(workDir, "settings.json"), start);

export type TicketState = "working" | "proposed" | "accepted" | "held" | "passed" | "failed its checks" | "parked" | "stopped" | "crashed" | "not started" | "interrupted";

export interface TicketView {
  ticket: string;
  project: string | null;
  sentence: string;
  openedAt: string;
  state: TicketState;
  /** One plain sentence on where the ticket stands. */
  says: string;
  url: string | null;
  number: number | null;
  costUsd: number;
  canAccept: boolean;
  story: { id: number; at: string; who: string; what: string; flagged: boolean }[];
}

/** Every ticket, newest first, drawn from the record alone. `running` is the ticket being worked right now, if any. */
export function ticketsFrom(lines: RecordLine[], running: string | null): TicketView[] {
  const by = new Map<string, RecordLine[]>();
  for (const l of lines) if (l.ticket) (by.get(l.ticket) ?? by.set(l.ticket, []).get(l.ticket)!).push(l);
  const out: TicketView[] = [];
  for (const [ticket, ls] of by) {
    const opened = ls.find((l) => l.kind === "ticket.opened");
    if (!opened) continue;
    const last = <K extends RecordLine["kind"]>(k: K) => [...ls].reverse().find((l) => l.kind === k);
    const ended = last("run.ended"), proposed = last("result.proposed"), accepted = last("result.accepted"), fence = last("fence.tested");
    const d = (l?: RecordLine) => (l?.data ?? {}) as Record<string, any>;
    let state: TicketState, says: string;
    if (accepted) { state = "accepted"; says = d(accepted).foundMerged ? `It was already put into the project on GitHub${d(accepted).notTheCheckedCommit ? ", with changes made after SoftwareFactory checked it" : ""}.` : "You accepted it. It is in the project."; }
    else if (running === ticket) { state = "working"; says = "A run is working on it now."; }
    else if (proposed && d(proposed).held) { state = "held"; says = `Held on this computer: ${d(proposed).reason}`; }
    else if (proposed) { state = "proposed"; says = "Done and checked. Waiting for you to accept."; }
    else if (ended) { state = d(ended).end as TicketState; says = String(d(ended).reason ?? ""); }
    else if (ls.some((l) => l.kind === "stop.pressed")) { state = "stopped"; says = "You pressed stop."; }
    else if (fence && d(fence).ok === false) { state = "not started"; says = "The fence did not hold, so no run started."; }
    else { state = "interrupted"; says = "SoftwareFactory was closed while this ticket was open."; }
    const number = proposed && typeof d(proposed).number === "number" ? (d(proposed).number as number) : null;
    out.push({
      ticket, project: opened.project, sentence: String(d(opened).sentence ?? ""), openedAt: opened.ts, state, says,
      url: proposed && typeof d(proposed).url === "string" ? d(proposed).url : null, number,
      costUsd: Math.round(ls.reduce((a, l) => a + (l.costUsd ?? 0), 0) * 10000) / 10000,
      canAccept: state === "proposed" && number !== null,
      story: ls.map((l) => ({ id: l.id, at: l.ts, who: l.who, what: storyLine(l), flagged: l.flagged })),
    });
  }
  return out.sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1));
}

export interface HomeDeps {
  record: TheRecord;
  github: GitHub;
  settings: SettingsFile;
  /** Works one ticket to its end. The home screen starts it and never waits on it. */
  work: (st: Omit<TicketSettings, "workDir">, sentence: string, signal: AbortSignal) => Promise<TicketOutcome>;
  /** host:port forms this page answers to. Anything else is refused, so a foreign name cannot be pointed here. */
  hosts: string[];
  /** The page's key. Made fresh at every start when not given. */
  key?: string;
  /** The pass in the address SoftwareFactory opens. Made fresh at every start when not given. */
  pass?: string;
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
  let running: { ticket: string | null; stop: AbortController; startedAt: string; before: number } | null = null;
  // The ticket's name is known from its first line in the record.
  const nameIt = () => { if (running && !running.ticket) running.ticket = record.since(running.before).find((l) => l.kind === "ticket.opened")?.ticket ?? null; };
  let accepting = false;
  const streams = new Set<ServerResponse>();
  record.onLine((l) => { nameIt(); for (const s of streams) s.write(`data: ${JSON.stringify({ id: l.id })}\n\n`); });

  const state = () => ({
    settings: deps.settings.read(),
    fence: deps.fence ?? null,
    running: running ? { ticket: running.ticket, startedAt: running.startedAt } : null,
    tickets: ticketsFrom(record.all(), running?.ticket ?? null),
  });

  /** Start one run. One at a time in step 1. */
  function start(sentence: string): { ok: true } | { ok: false; why: string } {
    const s = deps.settings.read();
    if (running) return { ok: false, why: "A run is working already. One at a time for now." };
    if (!sentence.trim()) return { ok: false, why: "Write what you want first." };
    if (sentence.length > 4000) return { ok: false, why: "That is too long for one ticket. Keep it under 4000 characters." };
    const repo = parseGitHubRepo(s.repo);
    if (!repo) return { ok: false, why: "Choose the project first, in Settings." };
    const stop = new AbortController();
    const mine = { ticket: null as string | null, stop, startedAt: new Date().toISOString(), before: record.all().at(-1)?.id ?? 0 };
    running = mine;
    void deps.work({ repo, base: s.base, checks: s.checks, prepare: s.prepare, model: s.model, maxTurns: s.maxTurns, timeLimitMinutes: s.timeLimitMinutes }, sentence, stop.signal)
      .catch((e) => { nameIt(); if (mine.ticket) record.append({ kind: "run.ended", who: "SF itself", ticket: mine.ticket, data: { end: "crashed", reason: String((e as Error)?.message ?? e).slice(0, 300), where: "before the run" } }); })
      .finally(() => { if (running === mine) running = null; for (const st of streams) st.write(`data: {"id":0}\n\n`); });
    return { ok: true };
  }

  function stopNow(): { ok: boolean; why?: string } {
    if (!running) return { ok: false, why: "Nothing is running." };
    nameIt();
    record.append({ kind: "stop.pressed", who: "you", ticket: running.ticket, data: {} });
    running.stop.abort();
    return { ok: true };
  }

  /** Accept: the proposal goes into the project, exactly the commit that was checked and nothing newer. */
  async function accept(ticket: string): Promise<{ ok: true; sha: string } | { ok: false; why: string }> {
    if (accepting) return { ok: false, why: "An accept is already on its way." };
    accepting = true;
    try {
      const lines = record.story(ticket);
      if (lines.some((l) => l.kind === "result.accepted")) return { ok: false, why: "You accepted this one already." };
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
      if (pr.mergeable === false) return { ok: false, why: "The project moved on and this proposal no longer fits on top of it. Start the ticket again." };
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
    if (!p || !repo || typeof d.headSha !== "string") return { ok: false, why: "This ticket has no proposal that can be accepted from here." };
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
      record.append({ kind: "setting.changed", who: "you", data: { changed: Object.fromEntries(changed.map((k) => [k, { from: was[k], to: now[k] }])) } });
    }
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
        if (url.pathname === "/api/step1/work") { const r = start(String(b.sentence ?? "")); return send(res, r.ok ? 200 : 409, r); }
        if (url.pathname === "/api/step1/stop") { const r = stopNow(); return send(res, r.ok ? 200 : 409, r); }
        if (url.pathname === "/api/step1/look") { const r = await look(String(b.ticket ?? "")); return send(res, r.ok ? 200 : 409, r); }
        if (url.pathname === "/api/step1/accept") { const r = await accept(String(b.ticket ?? "")); return send(res, r.ok ? 200 : 409, r); }
        if (url.pathname === "/api/step1/settings") { const r = saveSettings(b); return send(res, r.ok ? 200 : 400, r); }
      }
      send(res, 404, { ok: false, why: "no such thing here" });
    } catch (e) {
      if (!res.headersSent) send(res, 500, { ok: false, why: (e as Error).message.slice(0, 200) });
      else res.end();
    }
  }

  return { handler, state, start, stop: stopNow, accept, saveSettings, key, pass, cookie, cookieName, look, isRunning: () => !!running };
}
