import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { EventLog } from "../events.js";
import { dependencyScan, readCode, riskScan } from "../imports/evidence.js";
import { scanRepo } from "../imports/scan.js";
import { projectFolders } from "../launch/routes.js";
import type { Tickets } from "../tickets/tickets.js";

/**
 * Watchers (SF behavior brief, phase 6): scheduled looks at each project that only open tickets. They never change
 * code, never start the crew, and never spend money: every look is plain code reading the project's folder and its
 * records. A ticket a watcher opens is "open", so the crew does not pick it up until you make it ready.
 *
 *  - debt:          source files grown too long, and a pile of TODO/FIXME markers
 *  - security:      secrets and risky code (debug mode, eval, shell commands built from text), and a .env file
 *                   that is not ignored
 *  - dependencies:  packages with a known vulnerability (npm audit, pip-audit when installed), and unpinned packages
 *  - flaky tests:   tests that passed and then failed again inside one build, in two or more builds
 *
 * The same finding opens one ticket, once: each finding has a fingerprint, and a finding that already has a ticket
 * (open or closed) is not filed again. A finding that changes (more markers, another vulnerable package) is new.
 */
export const WATCHER_KINDS = ["debt", "security", "dependencies", "flaky"] as const;
export type WatcherKind = (typeof WATCHER_KINDS)[number];
export const WATCHER_LABEL: Record<WatcherKind, string> = { debt: "Code debt", security: "Security", dependencies: "Dependencies", flaky: "Flaky tests" };
export const WATCHER_TEXT: Record<WatcherKind, string> = {
  debt: "Source files over 1,000 lines, and 30 or more TODO/FIXME markers.",
  security: "Secrets written in the code, risky code (debug mode, eval, shell commands), a .env file that is not ignored.",
  dependencies: "Packages with a known vulnerability (npm audit, pip-audit), and Python packages without a pinned version.",
  flaky: "Tests that passed and then failed again inside one build, in two or more builds.",
};
/** How often each looks, as shipped (hours). */
export const WATCHER_EVERY: Record<WatcherKind, number> = { debt: 168, security: 24, dependencies: 168, flaky: 24 };
/** At most this many tickets from one look, so a first look at an old repo does not flood the board. */
export const MAX_TICKETS_PER_LOOK = 5;

export interface Finding {
  /** Stable for the same finding; part of the ticket's fingerprint. */
  key: string;
  title: string;
  body: string;
  kind: "bug" | "task";
  priority?: "now" | "this_week" | "next" | "someday";
  severity?: "blocking" | "annoying" | "cosmetic";
}

export interface WatcherSetting { on: boolean; everyHours: number }
export interface WatcherState extends WatcherSetting {
  kind: WatcherKind; label: string; text: string;
  lastAt: string | null; nextAt: string | null;
  last: { found: number; opened: number[]; note: string; error?: string } | null;
  /** Why it cannot look at this project, when it cannot (no folder on this computer). */
  blocked: string | null;
}

/** What a look does through the computer; tests replace any of them. */
export interface WatchTools {
  scan: typeof scanRepo;
  readCode: typeof readCode;
  dependencyScan: (dir: string) => ReturnType<typeof dependencyScan>;
}
export const realWatchTools: WatchTools = { scan: scanRepo, readCode, dependencyScan: (dir) => dependencyScan(dir, { pathFirst: [] }, { install: false }) };

const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 10);
const list = (xs: string[], n = 12) => xs.slice(0, n).map((x) => `- ${x}`).join("\n") + (xs.length > n ? `\n- and ${xs.length - n} more` : "");

/** Code debt: long files, one ticket each; a marker count, one ticket per doubling. */
export function debtFindings(dir: string, tools: Pick<WatchTools, "scan"> = realWatchTools): Finding[] {
  const map = tools.scan(dir, { maxFiles: 6000 });
  const out: Finding[] = [];
  for (const f of map.largest.filter((x) => x.lines > 1000)) {
    out.push({ key: `long:${f.path}`, kind: "task", priority: f.lines > 2000 ? "next" : "someday", title: `Split ${f.path} (${f.lines} lines)`,
      body: `${f.path} has ${f.lines} lines. A file that long is hard to read, review and change safely. Split it by what its parts do, with no change in behavior.\n\nOpened by the Code debt watcher.` });
  }
  const todos = map.modules.reduce((a, m) => a + m.todos, 0);
  if (todos >= 30) {
    const bucket = 2 ** Math.floor(Math.log2(todos));
    const where = map.modules.filter((m) => m.todos > 0).sort((a, b) => b.todos - a.todos).map((m) => `${m.id}: ${m.todos}`);
    out.push({ key: `todos:${bucket}`, kind: "task", priority: "someday", title: `Work down ${todos} TODO/FIXME markers`,
      body: `The code holds ${todos} TODO/FIXME markers. Each is something someone meant to come back to. Close the ones that are done, file the real ones as tickets, and remove the rest.\n\nWhere they are:\n${list(where)}\n\nOpened by the Code debt watcher.` });
  }
  return out;
}

/** Security: risky code by kind (one ticket per kind, the places listed), and a .env file git does not ignore. Never quotes a secret. */
export function securityFindings(dir: string, tools: Pick<WatchTools, "readCode"> = realWatchTools): Finding[] {
  const files = tools.readCode(dir, 4000);
  const out: Finding[] = [];
  const byId = new Map<string, ReturnType<typeof riskScan>>();
  for (const r of riskScan(files).filter((x) => x.level === "critical" || x.level === "high")) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
  for (const [id, rs] of byId) {
    const places = rs.map((r) => `${r.file}:${r.line}`);
    const secret = id === "committed-secret" || id === "hardcoded-secret";
    out.push({ key: `${id}:${hash(places.join(","))}`, kind: "bug", severity: rs[0].level === "critical" ? "blocking" : "annoying", priority: rs[0].level === "critical" ? "now" : "this_week",
      title: secret ? `Take the secret out of the code (${rs.length} place${rs.length > 1 ? "s" : ""})` : rs[0].text.split(":")[0].split(",")[0].slice(0, 90),
      body: `${rs[0].text}.\n\nWhere:\n${list(places)}${secret ? "\n\nMove the value to a setting the app reads at start (an environment variable), and change the secret itself: anyone who saw the code has it." : ""}\n\nOpened by the Security watcher. The values themselves are not copied here.` });
  }
  if (existsSync(join(dir, ".env"))) {
    let ignore = "";
    try { ignore = readFileSync(join(dir, ".gitignore"), "utf8"); } catch { /* none */ }
    if (!/^\s*\/?\.env(\*|\b)/m.test(ignore)) out.push({ key: "env-not-ignored", kind: "bug", severity: "annoying", priority: "this_week", title: "Keep .env out of git",
      body: "The project has a .env file and .gitignore does not ignore it, so its settings (often passwords and keys) can be committed. Add .env to .gitignore, and if it was ever committed, change the secrets in it.\n\nOpened by the Security watcher." });
  }
  return out;
}

/** Dependencies: one ticket for the packages a tool calls vulnerable (per tool), one for unpinned Python packages. */
export async function dependencyFindings(dir: string, tools: Pick<WatchTools, "dependencyScan"> = realWatchTools): Promise<{ findings: Finding[]; notes: string[] }> {
  const d = await tools.dependencyScan(dir);
  const out: Finding[] = [];
  for (const r of d.reports.filter((x) => x.ran && x.vulnerable.length)) {
    const names = r.vulnerable.map((v) => v.name).sort();
    const worst = r.vulnerable.some((v) => /critical/i.test(v.severity)) ? "critical" : r.vulnerable.some((v) => /high/i.test(v.severity)) ? "high" : "medium";
    out.push({ key: `${r.tool}:${hash(names.join(","))}`, kind: "bug", severity: worst === "medium" ? "annoying" : "blocking", priority: worst === "critical" ? "now" : worst === "high" ? "this_week" : "next",
      title: `Update ${names.length} package${names.length > 1 ? "s" : ""} with a known vulnerability`,
      body: `${r.tool} reports ${r.note}:\n${list(r.vulnerable.map((v) => `${v.name} (${v.severity})${v.detail ? `: ${v.detail}` : ""}`))}\n\nUpdate each to a fixed version and run the tests.\n\nOpened by the Dependencies watcher.` });
  }
  if (d.unpinned.length) {
    out.push({ key: `unpinned:${hash([...d.unpinned].sort().join(","))}`, kind: "task", priority: "someday", title: `Pin ${d.unpinned.length} Python package${d.unpinned.length > 1 ? "s" : ""} to exact versions`,
      body: `requirements.txt names these without an exact version (==), so two installs can get different code:\n${list(d.unpinned)}\n\nPin each to the version that works now.\n\nOpened by the Dependencies watcher.` });
  }
  return { findings: out, notes: d.reports.filter((x) => !x.ran).map((x) => `${x.tool}: ${x.note}`) };
}

/** Flaky tests: from the project's builds, tests that passed and then failed again in a later round of the same build. */
export function flakyFindings(log: EventLog, projectId: number, minRuns = 2): Finding[] {
  const runs = (log.db.prepare("SELECT ref FROM project_links WHERE project_id = ? AND kind = 'factory_run'").all(projectId) as { ref: string }[]).map((r) => Number(r.ref));
  if (!runs.length) return [];
  const rows = log.db.prepare(`SELECT payload FROM events WHERE type = 'factory.tests' AND json_extract(payload, '$.run') IN (${runs.map(() => "?").join(",")}) ORDER BY id`).all(...runs) as { payload: string }[];
  const seen = new Map<number, Map<string, boolean>>(); // run -> test -> passed before
  const flips = new Map<string, Set<number>>();
  for (const r of rows) {
    const p = JSON.parse(r.payload) as { run: number; cases?: { name: string; file: string; pass: boolean }[] };
    const passed = seen.get(p.run) ?? new Map<string, boolean>();
    seen.set(p.run, passed);
    for (const c of p.cases ?? []) {
      if (/^fast check:/.test(c.name)) continue;
      const id = `${c.file} › ${c.name}`;
      if (c.pass) passed.set(id, true);
      else if (passed.get(id)) flips.set(id, (flips.get(id) ?? new Set()).add(p.run));
    }
  }
  return [...flips].filter(([, rs]) => rs.size >= minRuns).map(([id, rs]) => ({
    key: `flaky:${id}`, kind: "bug" as const, priority: "next" as const, severity: "annoying" as const, title: `Make the test "${id.split(" › ").pop()!.slice(0, 70)}" reliable`,
    body: `The test ${id} passed and then failed again inside the same build, in ${rs.size} builds (${[...rs].map((r) => `run ${r}`).join(", ")}). A test that flips like that hides real failures and sends the crew on false fix rounds. Find what it depends on (time, order, a port, leftover files) and make it stable.\n\nOpened by the Flaky tests watcher.`,
  }));
}

/**
 * The watchers of every project: their settings (`watcher.set`), when each looks next, and each look (`watcher.ran`).
 * A look files its findings as tickets (at most MAX_TICKETS_PER_LOOK); nothing else.
 */
export class Watchers {
  private running = new Set<string>();
  constructor(private log: EventLog, private tickets: Tickets, private tools: WatchTools = realWatchTools) {}

  /** The folder a watcher reads for a project, or null. */
  folder(projectId: number): string | null {
    try { return projectFolders(this.log, projectId).find((f) => f.exists)?.dir ?? null; } catch { return null; }
  }

  setting(projectId: number, kind: WatcherKind): WatcherSetting {
    const row = this.log.db.prepare("SELECT payload FROM events WHERE type = 'watcher.set' AND json_extract(payload, '$.projectId') = ? AND json_extract(payload, '$.kind') = ? ORDER BY id DESC LIMIT 1").get(projectId, kind) as { payload: string } | undefined;
    const p = row ? JSON.parse(row.payload) as Partial<WatcherSetting> : {};
    return { on: p.on ?? true, everyHours: typeof p.everyHours === "number" && p.everyHours > 0 ? p.everyHours : WATCHER_EVERY[kind] };
  }

  set(projectId: number, kind: WatcherKind, patch: { on?: unknown; everyHours?: unknown }): WatcherState {
    if (!WATCHER_KINDS.includes(kind)) throw new Error(`There is no "${kind}" watcher.`);
    if (!this.log.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) throw new Error(`No project #${projectId}`);
    const cur = this.setting(projectId, kind);
    const on = typeof patch.on === "boolean" ? patch.on : cur.on;
    const every = patch.everyHours === undefined ? cur.everyHours : Number(patch.everyHours);
    if (!Number.isFinite(every) || every < 1 || every > 24 * 31) throw new Error("A watcher looks every 1 hour to every 31 days.");
    this.log.append("watcher.set", { projectId, kind, on, everyHours: Math.round(every) });
    return this.state(projectId).find((w) => w.kind === kind)!;
  }

  private lastRun(projectId: number, kind: WatcherKind): { ts: string; found: number; opened: number[]; note: string; error?: string } | null {
    const row = this.log.db.prepare("SELECT ts, payload FROM events WHERE type = 'watcher.ran' AND json_extract(payload, '$.projectId') = ? AND json_extract(payload, '$.kind') = ? ORDER BY id DESC LIMIT 1").get(projectId, kind) as { ts: string; payload: string } | undefined;
    return row ? { ts: row.ts, ...(JSON.parse(row.payload) as { found: number; opened: number[]; note: string; error?: string }) } : null;
  }

  private blocked(projectId: number, kind: WatcherKind): string | null {
    if (kind === "flaky") return null;
    return this.folder(projectId) ? null : "This project has no folder on this computer to look at.";
  }

  /** Every watcher of a project, with when it last looked, what it found, and when it looks next. */
  state(projectId: number, now = Date.now()): WatcherState[] {
    return WATCHER_KINDS.map((kind) => {
      const s = this.setting(projectId, kind);
      const last = this.lastRun(projectId, kind);
      const blocked = this.blocked(projectId, kind);
      const nextAt = !s.on || blocked ? null : new Date(last ? Date.parse(last.ts) + s.everyHours * 3_600_000 : now).toISOString();
      return { kind, label: WATCHER_LABEL[kind], text: WATCHER_TEXT[kind], ...s, lastAt: last?.ts ?? null, nextAt, last: last ? { found: last.found, opened: last.opened, note: last.note, ...(last.error ? { error: last.error } : {}) } : null, blocked };
    });
  }

  /** Look now: find, then open a ticket for each new finding. */
  async run(projectId: number, kind: WatcherKind): Promise<{ found: number; opened: number[]; note: string; error?: string }> {
    if (!WATCHER_KINDS.includes(kind)) throw new Error(`There is no "${kind}" watcher.`);
    const k = `${projectId}:${kind}`;
    if (this.running.has(k)) throw new Error("That watcher is looking right now.");
    this.running.add(k);
    try {
      const dir = this.folder(projectId);
      let findings: Finding[] = [];
      let notes: string[] = [];
      let error: string | undefined;
      try {
        if (kind === "flaky") findings = flakyFindings(this.log, projectId);
        else if (!dir) error = "This project has no folder on this computer to look at.";
        else if (kind === "debt") findings = debtFindings(dir, this.tools);
        else if (kind === "security") findings = securityFindings(dir, this.tools);
        else ({ findings, notes } = await dependencyFindings(dir, this.tools));
      } catch (e) { error = (e as Error).message.slice(0, 300); }
      const opened: number[] = [];
      let known = 0;
      for (const f of findings) {
        const fingerprint = `watch:${projectId}:${kind}:${f.key}`.slice(0, 300);
        if (this.log.db.prepare("SELECT 1 FROM tickets WHERE fingerprint = ?").get(fingerprint)) { known++; continue; }
        if (opened.length >= MAX_TICKETS_PER_LOOK) continue;
        const t = this.tickets.open({ project: projectId, kind: f.kind, title: f.title, body: f.body, priority: f.priority, severity: f.severity, by: `${WATCHER_LABEL[kind]} watcher`, source: "watcher", tags: ["watcher", kind], fingerprint });
        opened.push(t.id);
      }
      const left = findings.length - known - opened.length;
      const note = error ? `Could not look: ${error}`
        : !findings.length ? `Nothing found.${notes.length ? ` ${notes.join(" ")}` : ""}`
        : `${findings.length} found: ${opened.length} new ticket${opened.length === 1 ? "" : "s"}${known ? `, ${known} already filed` : ""}${left > 0 ? `, ${left} wait for the next look` : ""}.`;
      const out = { found: findings.length, opened, note: note.slice(0, 500), ...(error ? { error } : {}) };
      this.log.append("watcher.ran", { projectId, kind, ...out });
      return out;
    } finally { this.running.delete(k); }
  }

  /** The looks that are due now, across active projects. */
  due(now = Date.now()): { projectId: number; kind: WatcherKind }[] {
    const projects = (this.log.db.prepare("SELECT id FROM projects WHERE status IN ('active', 'shipped')").all() as { id: number }[]).map((r) => Number(r.id));
    const out: { projectId: number; kind: WatcherKind }[] = [];
    for (const projectId of projects) for (const w of this.state(projectId, now)) if (w.nextAt && Date.parse(w.nextAt) <= now) out.push({ projectId, kind: w.kind });
    return out;
  }

  /** Run every look that is due, one after another. Returns the tickets opened. */
  async runDue(now = Date.now()): Promise<number[]> {
    const opened: number[] = [];
    for (const d of this.due(now)) { try { opened.push(...(await this.run(d.projectId, d.kind)).opened); } catch (e) { console.error("watcher", d.kind, "on project", d.projectId, "failed:", (e as Error).message); } }
    return opened;
  }
}
