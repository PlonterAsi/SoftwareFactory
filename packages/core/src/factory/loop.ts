import { failureLines } from "./trim.js";
import { SAME_TESTS_REASON, stopReason, type RoundRecord } from "./stoprules.js";
import { recallBlock } from "../brain/recall.js";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describeSecrets, scanFiles } from "../safety/secrets.js";
import { fastGates } from "../safety/gates.js";
import { describeIntegrity, testIntegrity } from "../safety/testguard.js";
import { join, resolve } from "node:path";
import type { EventLog } from "../events.js";
import { MockRuntime, READ_TOOLS, type AgentRuntime } from "../runtime.js";
import { runAgent } from "../agents.js";
import { captureSignal } from "../signals.js";
import { builtinCrew, kitArgs, type CrewMember, type CrewSource } from "./crew.js";
import { MAX_COUNCIL_ROUNDS, briefText, isSmallJob, majority, othersText, parseSeatTake, synthesize, type CouncilBrief, type SeatResult } from "./council.js";
import type { Slot } from "../bay/agentfile.js";
import { visualCheck } from "./visualize.js";
import { checkUi, uiCase } from "./uicheck.js";
import { appCase, checkAppLive, installKit, isKitFile } from "./appkit.js";
import { checkScreens, screenCase, type ScreenCheck } from "./screencheck.js";
import { dryRunTests, lockedTestFaults } from "./testcheck.js";
import { WORKBENCH_COMMANDS, WORKBENCH_TOOLS, answerSummary, changedFiles, hasWorkbench, restoreFromHead, restoreProtected, testDispute, workbenchContract, writtenOnDisk } from "./workbench.js";
import {
  commitAll, git, initRepo, isLockedTest, parseFileBlocks, parseJsonBlock, readTree, runTests, syntaxErrors, testsHash, writeFiles, type TestRun,
} from "./workspace.js";

/**
 * The factory loop: one idea becomes a tested git repo.
 *
 *   intake → council (3 to 6 seats, skipped for small jobs) → plan → [gate A: approve plan]
 *     → tests (locked) → build → test ⇄ fix → review (⇄ fix once) → [gate B: accept build] → ship
 *
 * Workers come from a CrewSource (the Agent Bay), asked at the moment each
 * station needs them, so an edit in the Bay applies to the next call.
 *
 * Each station is a loop with a goal, a worker, a verifier, exit criteria and
 * a budget; its sixth field, its visual, is enforced by visualCheck before the
 * station may pass. All state is written to the event log; the Bridge draws
 * from it.
 */
export type StationId = "intake" | "council" | "plan" | "gateA" | "tests" | "build" | "test" | "fix" | "review" | "gateB" | "ship";
export type GateId = "gateA" | "gateB" | "escalation";

export interface Plan {
  name: string;
  slug: string;
  summary: string;
  interface: string;
  /** The screen (visualizeEverything): what the page shows and does. Plans from before the GUI default have none. */
  ui?: string;
  /** The CLI usage line, or "" when there is no command line. */
  cli?: string;
  /** Ready-to-run inputs for the CLI; written to run.json for the Run tab. */
  examples?: { label: string; args: string; input?: string }[];
  /**
   * A real program on the app kit (the Brain's "real-programs"): every plan written since has it.
   * Plans from before have none and are held only to the page check.
   */
  app?: boolean;
  /** What the app manages: each entity gets full CRUD screens from the kit. */
  entities?: { name: string; label?: string; fields: { name: string; type?: string; required?: boolean; options?: string[]; to?: string }[]; seed?: string }[];
  flows?: { name: string; steps: string[] }[];
  /** The app's own views (a dashboard, a board...), beside the kit's screens. */
  views?: { id: string; label: string; shows: string }[];
  acceptance: string[];
  tasks: { id: string; title: string; dependsOn: string[] }[];
  files: string[];
}

export interface RunOptions {
  /** Hard cap for the whole run across every loop, USD. */
  maxUsd?: number;
  maxFixRounds?: number;
  /** Approve both gates automatically (tests and headless runs). Escalations still stop the run. */
  autoApprove?: boolean;
  /** With autoApprove: how many failed-station or fix escalations to retry automatically. Budget escalations are never automatic. */
  autoRetries?: number;
  /** Override a model by agent id or station, for example { builder: "haiku" } or { build: "haiku" }. */
  models?: Record<string, string>;
  /** The Council: "auto" skips it for small jobs (the default), "always" or "never". */
  council?: "auto" | "always" | "never";
  /** The Review station after the tests pass (default on). */
  review?: boolean;
  /** The project this run belongs to. Without one, the run becomes a project of its own. */
  projectId?: number;
}

/**
 * A run on top of a project the factory already shipped: same folder, same data, same locked tests.
 * "screen" turns a script into an app; "feature" adds what the person asks to the shipped app.
 */
export interface ScreenRun { kind: "screen" | "feature"; baseRun: number; baseSha: string; tag: string }

export interface ReviewResult { verdict: "pass" | "fix"; findings: { severity: "high" | "low"; text: string }[]; criteria?: { text: string; pass: boolean; evidence: string }[] }

export function parseReview(text: string): ReviewResult {
  const j = parseJsonBlock<Partial<ReviewResult>>(text);
  if (!j || typeof j !== "object" || !Array.isArray(j.findings)) throw new Error("The review has no findings list");
  const findings = j.findings.map((f: any) => ({ severity: f?.severity === "high" ? "high" as const : "low" as const, text: String(f?.text ?? "").trim().slice(0, 300) })).filter((f) => f.text).slice(0, 5);
  // The done-claim check (H8): each acceptance criterion checked by running the product, with its evidence.
  const criteria = (Array.isArray((j as any).criteria) ? (j as any).criteria : []).filter((c: any) => c && c.text).slice(0, 20)
    .map((c: any) => ({ text: String(c.text).slice(0, 300), pass: c.pass === true, evidence: String(c.evidence ?? "").slice(0, 400) }));
  // A criterion the product does not meet is a high finding: it goes back to the Fixer with its evidence.
  for (const c of criteria.filter((x: { pass: boolean }) => !x.pass)) findings.push({ severity: "high", text: `Acceptance criterion not met: ${c.text}${c.evidence ? ` (${c.evidence})` : ""}`.slice(0, 500) });
  // "fix" needs a high finding to act on; a bare "fix" is read as pass with notes.
  return { verdict: findings.some((f) => f.severity === "high") && (j.verdict === "fix" || criteria.some((c: { pass: boolean }) => !c.pass)) ? "fix" : "pass", findings, ...(criteria.length ? { criteria } : {}) };
}

export interface GateDecision { approve: boolean; note?: string; by?: string }

/** What a waiting gate tells the Bridge besides its question: the button's word, and for a failed step, which one and how often. */
interface GateOpts { neverAuto?: boolean; action?: string; kind?: "retry" | "council" | "rounds" | "budget"; station?: StationId; attempt?: number; error?: string; same?: boolean }

export class StopRun extends Error {}

interface Pending { gate: GateId; resolve: (d: GateDecision) => void }

export class Factory {
  private pending = new Map<number, Pending>();
  private active = new Map<number, Promise<void>>();

  /** Runs this core found in flight when it started (closed as stopped, resumable). */
  readonly interrupted: number[] = [];

  /** Wall-clock limit per run in minutes (the `maxRunMinutes` setting). */
  maxRunMinutes: number | undefined;

  constructor(private log: EventLog, private runtime: AgentRuntime, readonly projectsDir: string, readonly crew: CrewSource = builtinCrew) {
    // Agent calls cut off by the restart would otherwise pulse as "running" forever.
    const ended = new Set([...log.list({ type: "agent.run.completed", limit: 1e6 }), ...log.list({ type: "agent.run.failed", limit: 1e6 })].map((e) => (e.payload as { runId: number }).runId));
    for (const e of log.list({ type: "agent.run.started", limit: 1e6 })) {
      if (!ended.has(e.id)) log.append("agent.run.failed", { runId: e.id, agent: (e.payload as { agent: string }).agent, factoryRun: (e.payload as { factoryRun?: number }).factoryRun, error: "The core restarted during this call." });
    }
    // Runs that were mid-flight when the app closed are closed honestly as stopped,
    // marked resumable: resumeInterrupted() (or the Bridge's Resume) picks them up
    // again from the last station they completed.
    for (const id of unfinishedRuns(log)) {
      log.append("factory.run.finished", { run: id, outcome: "stopped", reason: "The app closed while this run was in flight.", resumable: true, totalUsd: null });
      this.interrupted.push(id);
    }
  }

  /**
   * Resume the runs the app left in flight, each from its last completed station.
   * A run that keeps dying is resumed automatically at most MAX_AUTO_RESUMES times;
   * after that it waits for the Resume button.
   */
  resumeInterrupted(): number[] {
    const out: number[] = [];
    for (const id of this.interrupted.splice(0)) {
      const auto = this.log.list({ type: "factory.run.resumed", limit: 1e6 }).filter((e) => (e.payload as { run: number; auto?: boolean }).run === id && (e.payload as { auto?: boolean }).auto).length;
      if (auto >= MAX_AUTO_RESUMES) continue;
      try { this.resume(id, { auto: true }); out.push(id); } catch { /* not resumable (say, its folder is gone): it stays stopped */ }
    }
    return out;
  }

  /**
   * The run already doing this exact idea, if any: one still in flight (or stopped, ready to resume),
   * or one that shipped in the last day. Pressing Build twice (or on an old suggestion) should
   * point at that run, not start a copy that becomes a second project with the same name.
   * A run that failed or was rejected does not count: building it again is the point.
   */
  duplicateOf(idea: string, withinHours = 24): { run: number; state: "running" | "shipped" | "stopped"; projectId: number | null } | null {
    const norm = normIdea(idea);
    if (!norm) return null;
    const since = new Date(Date.now() - withinHours * 3600_000).toISOString();
    const rows = this.log.db.prepare("SELECT id, idea, outcome, started_at, finished_at FROM factory_runs ORDER BY id DESC LIMIT 500").all() as { id: number; idea: string; outcome: string | null; started_at: string; finished_at: string | null }[];
    for (const r of rows) {
      if (normIdea(r.idea) !== norm) continue;
      const running = r.outcome == null || this.active.has(r.id);
      const stopped = r.outcome === "stopped" && this.resumable(r.id).ok;
      const shipped = r.outcome === "shipped" && (r.finished_at ?? r.started_at) > since;
      if (!running && !stopped && !shipped) continue;
      let own: { project_id: number } | undefined;
      try { own = this.log.db.prepare("SELECT project_id FROM project_links WHERE kind = 'factory_run' AND ref = ?").get(String(r.id)) as typeof own; } catch { /* projects not loaded */ }
      return { run: r.id, state: running ? "running" : stopped ? "stopped" : "shipped", projectId: own ? Number(own.project_id) : null };
    }
    return null;
  }

  /** Can this run be picked up again? Only runs stopped by the app closing, whose project folder still exists. */
  resumable(run: number): { ok: boolean; why?: string; from?: StationId } {
    if (this.active.has(run)) return { ok: false, why: "It is running." };
    const started = this.log.get(run);
    if (started?.type !== "factory.run.started") return { ok: false, why: "No such run." };
    const life = this.log.list({ sinceId: run - 1, limit: 1e6 }).filter((e) => (e.type === "factory.run.finished" || e.type === "factory.run.resumed") && (e.payload as { run: number }).run === run).at(-1);
    const fin = life?.type === "factory.run.finished" ? life.payload as { outcome: string; reason: string; resumable?: boolean } : null;
    if (!fin) return { ok: false, why: "It has not stopped." };
    // Runs closed before resume existed carry the older reason.
    if (!(fin.resumable || /^The core restarted/.test(fin.reason))) return { ok: false, why: `It ${fin.outcome === "shipped" ? "already shipped" : `was ${fin.outcome} on purpose`}.` };
    const st = restoreState(this.log, run);
    if (st.dir && !existsSync(join(st.dir, ".git"))) return { ok: false, why: `Its project folder is gone (${st.dir}).` };
    return { ok: true, from: st.from };
  }

  /** Pick a stopped run up again from its last completed station. Returns the run id. */
  resume(run: number, opts: { auto?: boolean } = {}): number {
    const ok = this.resumable(run);
    if (!ok.ok) throw new Error(`Run #${run} cannot resume: ${ok.why}`);
    const started = this.log.get(run)!.payload as { idea: string; maxUsd?: number; maxFixRounds?: number; autoApprove?: boolean; autoRetries?: number; runtime?: string; council?: "auto" | "always" | "never"; review?: boolean; models?: Record<string, string>; screen?: ScreenRun };
    const st = restoreState(this.log, run);
    // A run keeps the crew it started with: a practice run stays on the free mock crew.
    const current = (this.runtime as { current?: AgentRuntime }).current ?? this.runtime;
    const runtime = started.runtime === "mock" && current.name !== "mock" ? new MockRuntime({ delayMs: Number(process.env.SF_MOCK_DELAY_MS ?? 700) }) : current;
    const o = { maxUsd: started.maxUsd ?? 1.5, maxFixRounds: started.maxFixRounds ?? 5, autoApprove: !!started.autoApprove, autoRetries: started.autoRetries ?? 1, models: started.models ?? {}, council: started.council ?? "auto", review: started.review !== false };
    if (st.maxUsd) o.maxUsd = st.maxUsd;
    // Partial writes from the station that was cut off are thrown away: back to its last commit.
    if (st.dir && existsSync(join(st.dir, ".git"))) {
      try { git(st.dir, "reset", "-q", "--hard"); git(st.dir, "clean", "-fdq"); } catch { /* a repo with no commit yet: the plan station runs again */ }
    }
    this.log.append("factory.run.resumed", { run, from: st.from, auto: !!opts.auto, spentUsd: Number(st.spent.toFixed(6)), runtime: runtime.name });
    const r = new Run(this, this.log, runtime, run, started.idea, o, started.screen ?? null);
    const done = r.go(st).finally(() => this.active.delete(run));
    this.active.set(run, done);
    return run;
  }

  /** Start a run in the background; returns its id at once. */
  start(idea: string, opts: RunOptions = {}): number {
    const text = idea.trim();
    if (!text) throw new Error("An idea needs some text");
    const o = { maxUsd: opts.maxUsd ?? 1.5, maxFixRounds: opts.maxFixRounds ?? 5, autoApprove: !!opts.autoApprove, autoRetries: opts.autoRetries ?? 1, models: opts.models ?? {}, council: opts.council ?? "auto", review: opts.review !== false };
    // A run keeps the crew it started with, even if you switch Practice/Real meanwhile.
    const runtime = (this.runtime as { current?: AgentRuntime }).current ?? this.runtime;
    const ev = this.log.append("factory.run.started", { idea: text, maxUsd: o.maxUsd, maxFixRounds: o.maxFixRounds, autoApprove: o.autoApprove, autoRetries: o.autoRetries, runtime: runtime.name, council: o.council, review: o.review, models: o.models, ...(opts.projectId != null ? { projectId: opts.projectId } : {}) });
    const done = new Run(this, this.log, runtime, ev.id, text, o).go().finally(() => this.active.delete(ev.id));
    this.active.set(ev.id, done);
    return ev.id;
  }

  /**
   * Give a shipped project a screen. The run works in the project's own folder on
   * top of what shipped: the plan and locked tests are kept (no Council, no plan gate),
   * the Builder adds the page, the locked tests and the page check must pass, the
   * Reviewer looks, you accept, and it ships as the next version. A run that does
   * not ship puts the folder back the way it was.
   */
  addScreen(baseRun: number, opts: Pick<RunOptions, "maxUsd" | "autoApprove" | "autoRetries" | "models" | "projectId"> = {}): number {
    const fin = this.log.list({ type: "factory.run.finished", sinceId: baseRun - 1, limit: 1e6 }).map((e) => e.payload as { run: number; outcome: string }).filter((p) => p.run === baseRun).at(-1);
    if (fin?.outcome !== "shipped") throw new Error(`Run #${baseRun} has not shipped, so there is nothing to add a screen to yet.`);
    const base = restoreState(this.log, baseRun);
    if (!base.plan || !base.dir || !existsSync(join(base.dir, ".git"))) throw new Error(`The folder of run #${baseRun} is gone${base.dir ? ` (${base.dir})` : ""}.`);
    const dir = base.dir;
    for (const id of this.active.keys()) if (restoreState(this.log, id).dir === dir) throw new Error(`Run #${id} is already working in that folder.`);
    if (git(dir, "status", "--porcelain")) throw new Error(`The folder has changes that are not committed (${dir}). Commit or undo them first, so nothing of yours is lost.`);
    const tags = git(dir, "tag", "--list", "v*").split("\n").map((t) => t.match(/^v(\d+)\.(\d+)\.(\d+)$/)).filter(Boolean) as RegExpMatchArray[];
    const minor = Math.max(0, ...tags.map((m) => Number(m[1]) * 1000 + Number(m[2]))) + 1;
    const screen: ScreenRun = { kind: "screen", baseRun, baseSha: git(dir, "rev-parse", "HEAD"), tag: `v${Math.floor(minor / 1000)}.${minor % 1000}.0` };
    // A project the factory shipped as a script becomes a real program: an app on the kit, same logic, same locked tests.
    const plan: Plan = { ...base.plan, ui: base.plan.ui?.trim() || defaultUi(base.plan), app: true };
    const idea = `Turn ${plan.name} into an app`;
    const o = { maxUsd: opts.maxUsd ?? 1, maxFixRounds: 4, autoApprove: !!opts.autoApprove, autoRetries: opts.autoRetries ?? 1, models: opts.models ?? {}, council: "never" as const, review: true };
    const runtime = (this.runtime as { current?: AgentRuntime }).current ?? this.runtime;
    const ev = this.log.append("factory.run.started", { idea, maxUsd: o.maxUsd, maxFixRounds: o.maxFixRounds, autoApprove: o.autoApprove, autoRetries: o.autoRetries, runtime: runtime.name, council: o.council, review: o.review, models: o.models, screen, ...(opts.projectId != null ? { projectId: opts.projectId } : {}) });
    const id = ev.id;
    // What is kept from the shipped run is on the floor too, so the run reads whole.
    const kept = `kept from run #${baseRun}`;
    for (const station of ["intake", "council"] as const) this.log.append("factory.station", { run: id, station, state: "skipped", note: kept, spentUsd: 0, maxUsd: o.maxUsd });
    this.log.append("factory.plan", { run: id, plan, dir, sha: git(dir, "rev-parse", "--short", "HEAD"), written: [], kept: baseRun });
    this.log.append("factory.station", { run: id, station: "plan", state: "skipped", note: kept, spentUsd: 0, maxUsd: o.maxUsd });
    this.log.append("factory.gate", { run: id, gate: "gateA", state: "approved", note: "You asked for a screen on a plan you already approved.", by: "you" });
    const files = Object.keys(readTree(dir)).filter(isLockedTest);
    this.log.append("factory.tests.locked", { run: id, hash: testsHash(dir), files, sha: screen.baseSha.slice(0, 7), kept: baseRun });
    this.log.append("factory.station", { run: id, station: "tests", state: "skipped", note: `${files.length} locked test file${files.length === 1 ? "" : "s"} ${kept}`, spentUsd: 0, maxUsd: o.maxUsd });
    const done = new Run(this, this.log, runtime, id, idea, o, screen).go(restoreState(this.log, id)).finally(() => this.active.delete(id));
    this.active.set(id, done);
    return id;
  }

  /**
   * Add a feature to a shipped app. The run works in the app's own folder on top of what
   * shipped: the Council and the Planner see the shipped plan and write the next version's
   * plan (you approve it), the Tester adds tests for the new parts only (the old locked tests
   * stay and must still pass), the Builder changes only what the feature needs, the Reviewer
   * looks, you accept, and it ships as the next version. Your data in the folder stays. A run
   * that does not ship puts the folder back the way it was.
   */
  addFeature(baseRun: number, ask: string, opts: Pick<RunOptions, "maxUsd" | "autoApprove" | "autoRetries" | "models" | "projectId" | "council"> = {}): number {
    const text = ask.trim();
    if (!text) throw new Error("Say what to add.");
    const screen = this.onTopOf(baseRun, "feature", "add a feature to");
    const o = { maxUsd: opts.maxUsd ?? 1.5, maxFixRounds: 5, autoApprove: !!opts.autoApprove, autoRetries: opts.autoRetries ?? 1, models: opts.models ?? {}, council: opts.council ?? "auto", review: true };
    const runtime = (this.runtime as { current?: AgentRuntime }).current ?? this.runtime;
    const ev = this.log.append("factory.run.started", { idea: text, maxUsd: o.maxUsd, maxFixRounds: o.maxFixRounds, autoApprove: o.autoApprove, autoRetries: o.autoRetries, runtime: runtime.name, council: o.council, review: o.review, models: o.models, screen, ...(opts.projectId != null ? { projectId: opts.projectId } : {}) });
    const done = new Run(this, this.log, runtime, ev.id, text, o, screen).go().finally(() => this.active.delete(ev.id));
    this.active.set(ev.id, done);
    return ev.id;
  }

  /** The next version of a shipped run: refuses a folder that is gone, busy or has your own changes. */
  private onTopOf(baseRun: number, kind: ScreenRun["kind"], what: string): ScreenRun {
    const fin = this.log.list({ type: "factory.run.finished", sinceId: baseRun - 1, limit: 1e6 }).map((e) => e.payload as { run: number; outcome: string }).filter((p) => p.run === baseRun).at(-1);
    if (fin?.outcome !== "shipped") throw new Error(`Run #${baseRun} has not shipped, so there is nothing to ${what} yet.`);
    const base = restoreState(this.log, baseRun);
    if (!base.plan || !base.dir || !existsSync(join(base.dir, ".git"))) throw new Error(`The folder of run #${baseRun} is gone${base.dir ? ` (${base.dir})` : ""}.`);
    const dir = base.dir;
    for (const id of this.active.keys()) if (restoreState(this.log, id).dir === dir) throw new Error(`Run #${id} is already working in that folder.`);
    if (git(dir, "status", "--porcelain")) throw new Error(`The folder has changes that are not committed (${dir}). Commit or undo them first, so nothing of yours is lost.`);
    const tags = git(dir, "tag", "--list", "v*").split("\n").map((t) => t.match(/^v(\d+)\.(\d+)\.(\d+)$/)).filter(Boolean) as RegExpMatchArray[];
    const minor = Math.max(0, ...tags.map((m) => Number(m[1]) * 1000 + Number(m[2]))) + 1;
    return { kind, baseRun, baseSha: git(dir, "rev-parse", "HEAD"), tag: `v${Math.floor(minor / 1000)}.${minor % 1000}.0` };
  }

  /** Wait for a run to finish (tests and the CLI). */
  /** A run working right now in this core. */
  isActive(run: number): boolean { return this.active.has(run); }

  /** How many runs are working right now (an update waits for this to reach 0). */
  activeCount(): number { return this.active.size; }
  wait(run: number): Promise<void> { return this.active.get(run) ?? Promise.resolve(); }

  waitingGate(run: number): GateId | null { return this.pending.get(run)?.gate ?? null; }

  /** A human (or the auto-approver) answers the gate a run is waiting at. */
  decide(run: number, gate: GateId, d: GateDecision): boolean {
    const p = this.pending.get(run);
    if (!p || p.gate !== gate) return false;
    this.pending.delete(run);
    p.resolve(d);
    return true;
  }

  /** @internal used by Run */
  awaitGate(run: number, gate: GateId): Promise<GateDecision> {
    return new Promise((res) => this.pending.set(run, { gate, resolve: res }));
  }
}

class Run {
  private spent = 0;
  private calls = 0;
  private dir = "";
  private plan!: Plan;
  private lockedHash = "";
  /** The commit the tests were locked in, and how many cases the suite showed first (SF-24). Not kept across a resume. */
  private lockedSha = "";
  private lockedCases: number | undefined;
  private fixRounds = 0;
  private brief: CouncilBrief | null = null;
  /** A feature run: the plan that shipped, which the next version builds on. */
  private basePlan: Plan | null = null;

  constructor(
    private f: Factory, private log: EventLog, private runtime: AgentRuntime,
    private id: number, private idea: string,
    private o: Required<Omit<RunOptions, "models" | "projectId">> & { models: Record<string, string> },
    private screen: ScreenRun | null = null,
  ) {}

  async go(from?: RestoredState) {
    try {
      if (from) this.restore(from);
      if (this.screen?.kind === "feature") {
        const base = restoreState(this.log, this.screen.baseRun);
        this.basePlan = base.plan ?? null;
        if (!this.dir) this.dir = base.dir ?? "";
      }
      const done = from?.done ?? new Set<string>();
      if (!done.has("intake")) await this.station("intake", async () => { captureSignal(this.log, this.idea, "factory"); });
      if (!done.has("council")) await this.councilLoop();
      if (!done.has("plan")) await this.planLoop(done.has("planWritten"));
      if (!done.has("tests")) await this.station("tests", () => this.writeTests());
      if (!done.has("build")) await this.station("build", () => this.build());
      // On a resume the suite runs again first (free): it proves the repo is where the log says.
      if (!done.has("reviewed")) {
        await this.testFixLoop("", !!from && from.done.has("build"));
        await this.reviewLoop();
      } else if (!done.has("accepted")) await this.testFixLoop("", true);
      if (!done.has("accepted")) await this.acceptLoop();
      const sha = await this.station("ship", () => this.ship());
      this.finish("shipped", `Shipped ${this.plan.name} to ${this.dir}`, sha);
    } catch (e) {
      const stopped = e instanceof StopRun;
      this.finish(stopped ? "stopped" : "failed", (e as Error).message);
    }
  }

  /** Put back what the log says this run already had. */
  private restore(st: RestoredState) {
    this.spent = st.spent;
    this.calls = st.calls;
    this.fixRounds = st.fixRounds;
    this.brief = st.brief;
    this.reviewNotes = st.review;
    if (st.plan) { this.plan = st.plan; this.dir = st.dir ?? ""; }
    if (st.lockedHash) {
      this.lockedHash = st.lockedHash;
      if (testsHash(this.dir) !== st.lockedHash) throw new Error("The locked acceptance tests on disk differ from the ones this run locked. Refusing to resume.");
    }
  }

  // ---------- stations ----------

  /** The seats look at the idea; a second round only when no majority wants to build. */
  private async councilLoop() {
    const size = isSmallJob(this.idea);
    if (this.o.council === "never" || (this.o.council === "auto" && size.small)) {
      this.mark("council", "skipped", undefined, this.o.council === "never" ? "Council turned off for this run" : size.why);
      return;
    }
    const seats: SeatResult[] = [];
    let brief!: CouncilBrief;
    for (let round = 1; round <= MAX_COUNCIL_ROUNDS; round++) {
      const crew = this.f.crew.crewFor("council");
      const prev = seats.filter((x) => x.round === round - 1);
      brief = await this.station("council", async () => {
        const results = await Promise.all(crew.map(async (m, seat) => {
          const prompt = `Idea: ${this.idea}${round === 1 && this.recalled() ? `\n\n${this.recalled()}` : ""}${round > 1 ? `\n\nRound ${round}. The other seats said:\n${othersText(prev, m.id)}\nAnswer again: keep what still holds, change what they convinced you of.` : ""}`;
          const res: SeatResult = { agent: m.id, name: m.name, version: m.version, round, costUsd: 0 };
          try {
            const text = await this.ask(m, prompt, { seat, round });
            res.take = parseSeatTake(text);
          } catch (e) { if (e instanceof StopRun) throw e; res.error = (e as Error).message; }
          this.verdict(m, "council", !!res.take, round, res.error);
          return res;
        }));
        seats.push(...results);
        const answered = results.filter((r) => r.take).length;
        const b = synthesize(seats, round);
        this.log.append("factory.council", { run: this.id, round, seats: results, brief: b });
        if (answered < 2) throw new Error(`only ${answered} of ${crew.length} Council seats gave a usable take`);
        return b;
      }, round);
      if (majority(votesOf(seats, round)) === "build" || round === MAX_COUNCIL_ROUNDS) break;
    }
    if (brief.outcome === "drop") {
      const why = brief.concerns.concat(brief.agreed).slice(0, 3).join("; ");
      const d = await this.gate("escalation", `The Council advises against building this${why ? ` (${why})` : ""}. Build it anyway?`, { action: "Build anyway", kind: "council" });
      if (!d.approve) throw new StopRun("The Council advised against building it, and you agreed.");
    }
    this.brief = brief;
    function votesOf(all: SeatResult[], round: number) { return all.filter((s) => s.round === round && s.take).map((s) => s.take!.vote); }
  }

  private async planLoop(written = false) {
    let feedback = "";
    for (;;) {
      // Resumed at the plan gate: the plan is already written, ask again.
      if (written) written = false;
      else await this.station("plan", async () => {
        const onTop = this.basePlan
          ? `This app already shipped. Its approved plan:\n${JSON.stringify(this.basePlan, null, 2)}\n\nThe person now asks to add: ${this.idea}\n\nWrite the plan for its next version in the same JSON shape: keep the same name and slug, and every existing entity, field, view, flow and exported function (they still work and their tests stay locked); add what the ask needs. New fields on existing entities are optional, so records already saved still load. In "acceptance", list ONLY the new criteria: the old ones stay as they are.`
          : `Idea: ${this.idea}`;
        const text = await this.ask(this.one("plan"), `${onTop}${this.recalled() ? `\n\n${this.recalled()}` : ""}${this.brief ? `\n\n${briefText(this.brief)}` : ""}${feedback ? `\n\nThe person reviewed your last plan and said: ${feedback}\nRevise the plan accordingly.` : ""}`);
        const plan = validatePlan(parseJsonBlock<Plan>(text));
        if (this.basePlan) { plan.slug = this.basePlan.slug; plan.app = true; }
        this.plan = plan;
        if (!this.basePlan) {
          this.dir = resolve(join(this.f.projectsDir, `${plan.slug}-${this.id}`));
          initRepo(this.dir);
        }
        const spec = writeFiles(this.dir, [{ path: "SPEC.md", content: specMarkdown(this.idea, plan) }], { lockTests: true });
        const sha = commitAll(this.dir, `Spec and plan: ${plan.name}`);
        this.log.append("factory.plan", { run: this.id, plan, dir: this.dir, sha, written: spec.written });
      });
      const d = await this.gate("gateA", "Approve the spec and plan");
      this.verdict(this.one("plan"), "plan", d.approve, undefined, d.note);
      if (d.approve) return;
      if (!d.note) throw new StopRun("You rejected the plan.");
      feedback = d.note;
    }
  }

  private async writeTests() {
    // Tests are locked once written, so they must at least parse: one quiet retry with the error before escalating.
    let feedback = "";
    let files: ReturnType<typeof parseFileBlocks> = [];
    let tests: typeof files = [];
    let res!: ReturnType<typeof writeFiles>;
    for (let attempt = 1; ; attempt++) {
      const kept = this.basePlan ? this.testsText() : "";
      const text = await this.ask(this.one("tests"), `Approved spec:\n${JSON.stringify(this.plan, null, 2)}${kept ? `\n\nThis is the next version of a shipped app. Its locked tests stay as they are (read only):\n${kept}\n\nWrite NEW test files, with new names under test/, for the acceptance criteria above only.` : ""}${feedback}`);
      files = parseFileBlocks(text);
      // Fixtures (test/fixtures/*.csv and the like) belong to the locked suite too.
      // A feature run never rewrites a locked test: a new file with an old name gets the version in its name.
      if (this.basePlan) files = files.map((f) => (isLockedTest(f.path) && existsSync(join(this.dir, f.path)) ? { ...f, path: f.path.replace(/(\.test)?(\.[cm]?js|\.[a-z]+)$/i, `-${this.screen!.tag}$1$2`) } : f));
      tests = files.filter((f) => isLockedTest(f.path) && !(this.basePlan && existsSync(join(this.dir, f.path))));
      if (!tests.some((f) => f.path.endsWith(".js"))) throw new Error("The Tester returned no test/*.js files");
      res = writeFiles(this.dir, tests, { lockTests: false });
      const jsTests = res.written.map((w) => w.path).filter((p) => /\.[cm]?js$/.test(p));
      const broken = syntaxErrors(this.dir, jsTests);
      // Parsing is not enough (run 2366): the tests are tried against stubs, and a file that breaks on its
      // own lines goes back to the Tester before it is locked, not to a Fixer who can never make it pass.
      const faulty = broken.length ? [] : await dryRunTests(this.dir, jsTests);
      if (faulty.length) this.log.append("factory.tests.dryrun", { run: this.id, attempt, problems: faulty });
      const bad = [...broken, ...faulty];
      this.verdict(this.one("tests"), "tests", !bad.length, attempt, bad[0]);
      if (!bad.length) break;
      git(this.dir, "clean", "-fdq", "test");
      if (attempt >= 2) throw new Error(broken.length ? `The Tester's tests do not parse: ${broken.join("; ")}` : `The Tester's tests break on their own lines: ${faulty.join("; ")}`);
      feedback = broken.length
        ? `\n\nYour previous tests did not parse, so they were discarded:\n${broken.join("\n")}\nWrite them again, each file complete and valid.`
        : `\n\nYour previous tests were tried before locking, with every module they import stubbed out, and a file failed as a whole on its own lines (no code could ever make it pass), so they were discarded:\n${faulty.join("\n")}\nWrite them again. Every line must sit inside a test or be a valid import or helper; nothing may follow the last test.`;
    }
    for (const f of files.filter((x) => !tests.includes(x))) res.refused.push({ path: f.path, reason: "the Tester may only write under test/" });
    this.log.append("factory.files", { run: this.id, station: "tests", round: 1, ...res });
    const sha = commitAll(this.dir, "Acceptance tests (locked)");
    this.lockedHash = testsHash(this.dir);
    this.lockedSha = git(this.dir, "rev-parse", "HEAD");
    this.log.append("factory.tests.locked", { run: this.id, hash: this.lockedHash, files: res.written.map((w) => w.path), sha });
  }

  private async build() {
    // The app kit goes in first, so the Builder writes the model and views on top of it.
    if (this.plan.app) { installKit(this.dir); commitAll(this.dir, "App kit"); }
    this.builder = this.one("build");
    const text = await this.askBench(this.builder, this.screen?.kind === "feature"
      ? [
        `This app already shipped and its locked acceptance tests pass. Build its next version on top of the existing code: add what the spec adds (new entities, fields, views and logic) and keep everything that works.`,
        `Keep every existing export, entity, view and file working; records the person already saved must still load, so new fields are optional. All locked tests, old and new, must pass. Return only the files you add or change, each in full.`,
        `Spec of the next version:\n${JSON.stringify(this.plan, null, 2)}`,
        `Locked acceptance tests (read only):\n${this.testsText()}`,
        `Current code:\n${this.codeText()}`,
      ].join("\n\n")
      : this.screen
      ? [
        `This project already shipped and its locked acceptance tests pass, but it is a script, not a program. Turn it into a real app on the app kit (already in the folder), on top of the existing code: write src/schema.js (the entities it works on and keeps, such as its inputs, settings and a history of its results, each with sample records), web/app.js with views that run its logic through forms and draw the results, index.html and web/style.css.`,
        `Keep every existing export, file and command working (the CLI too, if there is one). If the logic the app needs lives in a module that imports node: modules, move the pure part into a browser-safe module under src/ and have the old module import it from there; work that truly needs the disk goes in api.js. The locked tests must still pass. Return only the files you add or change, each in full, and update README.md to say the app opens from the Run tab's Start.`,
        `Spec:\n${JSON.stringify(this.plan, null, 2)}`,
        `Locked acceptance tests (read only):\n${this.testsText()}`,
        `Current code:\n${this.codeText()}`,
      ].join("\n\n")
      : `Spec:\n${JSON.stringify(this.plan, null, 2)}\n\nLocked acceptance tests:\n${this.testsText()}`);
    const res = this.takeWork(text);
    if (!res.written.length) throw new Error("The Builder returned no files");
    this.log.append("factory.files", { run: this.id, station: "build", round: 1, ...res, ...(this.bench ? { workbench: true } : {}) });
    commitAll(this.dir, `Build: ${this.plan.name}`);
  }

  /** A real crew works at the workbench (factory/workbench.ts): it runs the tests itself and fixes until they pass. */
  private get bench() { return hasWorkbench(this.runtime); }
  private benchContract(extra?: string) {
    return workbenchContract({ test: "node --test", protect: ["anything under test/ (the locked acceptance tests)", "web/kit/ and server.js (the app kit)"], extra: [
      this.plan?.app ? "After the tests pass, the core also checks the app: it starts server.js, loads index.html and every module it imports, loads src/schema.js and tries create, edit and delete on every entity. Make sure `node -e \"import('./src/schema.js').then(m=>console.log(Object.keys(m)))\"` and `node --check` on every file in web/ and src/ succeed before you finish." : "",
      extra ?? "",
    ].filter(Boolean).join("\n") });
  }

  /**
   * What an agent left after its call: with the workbench, the files it changed on disk (anything locked put
   * back first); always, any whole files it answered as text blocks (the practice crew, or an agent whose
   * tools failed). The result has the shape of writeFiles, for the heat map.
   */
  private takeWork(text: string): ReturnType<typeof writeFiles> {
    const restored = this.bench ? restoreProtected(this.dir, (p) => isLockedTest(p) || isKitFile(p)) : [];
    if (restored.some(isKitFile)) installKit(this.dir);
    const blocks = parseFileBlocks(text);
    const res = blocks.length ? writeFiles(this.dir, blocks, { lockTests: true }) : { written: [], refused: [] };
    if (this.bench) {
      const fromBlocks = new Set(res.written.map((w) => w.path));
      res.written.push(...writtenOnDisk(this.dir, changedFiles(this.dir).filter((p) => !fromBlocks.has(p) && !isLockedTest(p) && !isKitFile(p))));
      res.refused.push(...restored.map((path) => ({ path, reason: "locked: put back as it was" })));
    }
    return res;
  }

  private builder: CrewMember | null = null;
  private startedAt = Date.now();
  private lastFixFiles: Record<string, string> = {};
  private lastFixBefore: Record<string, string> = {};

  private async testFixLoop(extraFeedback = "", rerun = false) {
    let run = await this.station("test", () => this.runSuite(0));
    if (!rerun && this.builder) this.verdict(this.builder, "build", run.failed === 0, 0, run.failed ? `${run.failed} failing` : undefined);
    let history: RoundRecord[] = [];
    let files: Record<string, string> = {};
    let before: Record<string, string> = {};
    let budget = this.o.maxFixRounds;
    let feedback = extraFeedback;
    while (run.failed > 0 || feedback) {
      const failing = run.cases.filter((c) => !c.pass).map((c) => c.name).sort().join("\n");
      history.push({ failing: run.failed, names: failing, files, before });
      const stop = stopReason({ rounds: history, startedAt: this.startedAt, now: Date.now(), maxMinutes: this.f.maxRunMinutes });
      const timeUp = !!stop && /longer than/.test(stop);
      // A stall climbs the ladder before anyone is asked (H6): a deeper fix on a stronger model, then the locked
      // test itself is questioned. Each step once per stall; the wall clock is never waived.
      let climbed = false;
      // Triage first: when the evidence points at a locked test (a Fixer's TEST_WRONG, or a test file that breaks
      // on its own), the test is questioned now, not after a stronger model has burned the budget on code that
      // was right (run 2366). Once per run.
      const faults = this.disputed || timeUp || run.failed === 0 ? [] : lockedTestFaults(run, isLockedTest);
      const fault = !this.disputed && !timeUp && run.failed > 0 && (!!this.lastDispute || faults.length > 0);
      if (fault || (stop && !timeUp && run.failed > 0 && this.ladder !== "person")) {
        const next = fault ? "dispute" : this.ladder === "normal" ? "deeper" : !this.disputed ? "dispute" : "person";
        const why = fault ? (this.lastDispute ? `the Fixer says a locked test is wrong (${this.lastDispute.file})` : `a locked test file breaks on its own (${faults[0].file})`) : stop;
        this.log.append("factory.ladder", { run: this.id, from: this.ladder, to: next, reason: why, round: this.fixRounds, ...(fault ? { triage: true } : {}) });
        this.ladder = next;
        if (next === "dispute") {
          this.mark("tests", "active", undefined, "a locked test is questioned");
          const relocked = await this.disputeTests(run);
          this.mark("tests", "pass", undefined, relocked ? "the locked tests were corrected and locked again" : "the locked tests stand");
          if (relocked) {
            run = await this.station("test", () => this.runSuite(this.fixRounds), this.fixRounds || undefined);
            if (run.failed === 0 && !feedback) break;
          }
          // Corrected tests start the ladder over (no second dispute). Tests that stand after a stall go to you;
          // after triage, the fixing goes on with the Tester's reasons in hand.
          this.ladder = relocked || fault ? "normal" : "person";
          climbed = relocked || fault;
        } else if (next === "deeper") climbed = true;
        // A step up the ladder buys one more fix round, done the new way, before the stop rules look again.
        if (climbed) { history = [history[history.length - 1]]; budget = Math.max(budget, 1); }
      }
      if (climbed) { /* straight to the next fix round */ }
      // Only "the same tests failed twice" may be waved on by a person; the other rules end the run.
      else if (stop && stop !== SAME_TESTS_REASON) {
        this.mark("fix", "fail", this.fixRounds || undefined, `Stopped: ${stop}`);
        throw new StopRun(`${stop}${this.attempts.length ? `\n${this.attemptsText()}` : ""}`);
      }
      const reason = climbed ? "" : budget <= 0 ? `Tests still fail after ${this.o.maxFixRounds} fix rounds.` : stop ?? "";
      if (reason) {
        const tried = this.attempts.length ? ` Tried so far: ${this.attempts.slice(-3).map((a) => `round ${a.round} ${a.model}, failing ${a.before}→${a.after}`).join("; ")}.` : "";
        const d = await this.gate("escalation", `${reason}${tried} Grant 2 more fix rounds?`, { action: "2 more fix rounds", kind: "rounds" });
        if (!d.approve) throw new StopRun(reason);
        budget = 2;
        history = [history[history.length - 1]];
        feedback = d.note ?? feedback;
        this.ladder = "normal";
      }
      budget--;
      this.fixRounds++;
      const round = this.fixRounds;
      const note = feedback;
      feedback = "";
      let fixer!: CrewMember;
      const failingBefore = run.failed;
      run = await this.station("fix", async () => {
        fixer = await this.fix(run, round, note);
        return this.runSuite(round);
      }, round);
      files = this.lastFixFiles;
      before = this.lastFixBefore;
      const attempt = { round, agent: fixer.id, model: this.lastFixModel || this.modelOf(fixer), before: failingBefore, after: run.failed, files: Object.keys(files), said: this.lastFixSaid, ...(this.lastDispute ? { dispute: `${this.lastDispute.file}: ${this.lastDispute.evidence}` } : {}) };
      this.attempts.push(attempt);
      this.log.append("factory.attempt", { run: this.id, ...attempt, ladder: this.ladder });
      if (run.failed < failingBefore && this.ladder !== "person") this.ladder = "normal";
      this.verdict(fixer, "fix", run.failed === 0, round, run.failed ? `${run.failed} failing` : undefined);
      // The Test station shows the latest verdict, not only the first run's.
      if (run.failed === 0) this.mark("test", "pass", round, `green after fix round ${round}`);
    }
  }

  private async fix(run: TestRun, round: number, note: string): Promise<CrewMember> {
    const failures = run.cases.filter((c) => !c.pass).map((c) => `- ${c.name} (${c.file}): ${(c.error ?? "failed").slice(0, 1200)}`).join("\n");
    const deeper = this.ladder === "deeper";
    const fixer = this.one("fix");
    // A stronger model only with the money it needs to work: opus with $0.18 left died in 6 s, twice (run 2366).
    const model = deeper ? this.deeperModel(fixer) : undefined;
    const up = strongerModel(this.modelOf(fixer));
    if (deeper && !model && up !== this.modelOf(fixer)) this.log.append("factory.ladder", { run: this.id, from: "deeper", to: "deeper", reason: `kept ${this.modelOf(fixer)}: $${(this.o.maxUsd - this.spent).toFixed(2)} left is below what ${up} needs ($${modelFloorUsd(up).toFixed(2)})`, round });
    this.lastFixModel = model ?? this.modelOf(fixer);
    const prompt = [
      `Spec:\n${JSON.stringify(this.plan, null, 2)}`,
      // Only the lines that say what failed and where (SF-16), at most 100.
      failures ? `Failing tests (the core's own run):\n${failures}\n\nTest output (failure lines):\n${failureLines(run.output, 100, 2500) || "(none: run the failing file with node yourself to see the raw error)"}` : "All tests pass.",
      note ? `The reviewer of the build asked for: ${note}` : "",
      this.attemptsText(),
      this.keptReason ? `A locked test was questioned and the Tester kept it: ${this.keptReason}` : "",
      deeper ? "The fixes so far did not move the failures. Step back before you edit: write down two or three different explanations of the root cause, check each one by running code (not by reading only), then fix the one the evidence supports. If the evidence says a locked test itself is wrong, say so with the TEST_WRONG line instead of working around it." : "",
      // At the workbench the agent reads what it needs; without it, it gets the whole project as text.
      this.bench ? `The project is the current folder: SPEC.md, the locked tests in test/, the code. Read what you need.` : `Locked tests (read only):\n${this.testsText()}`,
      this.bench ? "" : `Current code:\n${this.codeText()}`,
    ].filter(Boolean).join("\n\n");
    // What each file held before this round, so the stop rules (SF-25) see a revert to the build's version.
    const hashes = () => Object.fromEntries(Object.entries(readTree(this.dir)).filter(([p]) => !isLockedTest(p) && !isKitFile(p)).map(([p, c]) => [p, createHash("sha256").update(c).digest("hex")]));
    const beforeAll = hashes();
    const text = await this.askBench(fixer, prompt, { round }, { model });
    const res = this.takeWork(text);
    this.lastFixBefore = Object.fromEntries(res.written.map((w) => [w.path, beforeAll[w.path]]).filter(([, h]) => h));
    this.lastFixSaid = answerSummary(text);
    this.lastDispute = testDispute(text);
    // Nothing changed is an attempt that taught something (its reasons go to the next round), not a crash.
    const noChange = !res.written.length ? (res.refused.length ? "The Fixer only tried to change the locked tests." : "The Fixer changed nothing.") : undefined;
    this.log.append("factory.files", { run: this.id, station: "fix", round, ...res, ...(noChange ? { noChange, said: this.lastFixSaid } : {}), ...(this.bench ? { workbench: true } : {}) });
    this.lastFixFiles = Object.fromEntries(res.written.map((w) => [w.path, w.sha256]));
    if (!noChange) commitAll(this.dir, `Fix round ${round}`);
    return fixer;
  }

  /** What every fix round so far tried and what came of it (H5): the next round must not repeat a failed approach. */
  private attempts: { round: number; agent: string; model: string; before: number; after: number; files: string[]; said: string; dispute?: string }[] = [];
  private lastFixSaid = "";
  private lastDispute: { file: string; evidence: string } | null = null;
  /** The escalation ladder (H6): a normal fix, then a deeper one on a stronger model, then the locked test is questioned, then you. */
  private ladder: "normal" | "deeper" | "dispute" | "person" = "normal";
  private disputed = false;
  private lastFixModel = "";
  /** Why the Tester kept a questioned test: the Fixer works from it. */
  private keptReason = "";

  /** One step up in model for a deeper fix, if what is left of the run's budget can pay for it; else none. */
  private deeperModel(m: CrewMember): string | undefined {
    const cur = this.modelOf(m);
    const up = strongerModel(cur);
    if (up === cur) return undefined;
    return this.o.maxUsd - this.spent >= modelFloorUsd(up) ? up : undefined;
  }

  private attemptsText(): string {
    if (!this.attempts.length) return "";
    return "What was already tried in this run (do not repeat an approach that did not work):\n" + this.attempts.slice(-6).map((a) =>
      `- Round ${a.round} (${a.agent}, ${a.model}): ${a.files.length ? `changed ${a.files.slice(0, 6).join(", ")}` : "changed nothing"}; failing ${a.before} → ${a.after}.${a.said ? ` It said: ${a.said.replace(/\n/g, " ").slice(0, 300)}` : ""}${a.dispute ? ` It disputed a test: ${a.dispute.slice(0, 200)}` : ""}`).join("\n");
  }

  private modelOf(m: CrewMember) { return this.o.models[m.id] ?? this.o.models[m.station] ?? m.model; }

  /**
   * The locked test is questioned (ladder step 3): the Tester sees the dispute and the evidence and either
   * corrects the test file (the suite is locked again, on the record) or keeps it. At most once per run.
   */
  private async disputeTests(run: TestRun): Promise<boolean> {
    this.disputed = true;
    // A file that failed as a whole although tests in it passed: what broke runs outside any test (run 2366).
    // A file with no passing test failed to load, which is as likely the code's fault: no evidence against the test.
    const fileLevel = lockedTestFaults(run, isLockedTest);
    const claim = this.lastDispute ?? this.attempts.map((a) => a.dispute).filter(Boolean).map((d) => ({ file: d!.split(":")[0], evidence: d! })).at(-1) ?? null;
    if (!claim && !fileLevel.length) return false;
    const m = this.one("tests");
    const evidence = [
      claim ? `The Fixer says a locked test is wrong: ${claim.file}: ${claim.evidence}` : "",
      fileLevel.length ? `Every named test passes, but node --test fails these files as a whole:\n${fileLevel.map((c) => `- ${c.file}: ${(c.error ?? "").slice(0, 800)}`).join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
    let text = "";
    try {
      text = await this.ask(m, `Approved spec:\n${JSON.stringify(this.plan, null, 2)}\n\nThe locked acceptance tests:\n${this.testsText()}\n\n${evidence}\n\nJudge it. If a test file is truly broken or contradicts the spec, return the corrected file in full as a file block (keep every test that is right, same names; never weaken a correct assertion). If the tests are right and the code is wrong, answer only: KEEP: <why>.`);
    } catch (e) { if (e instanceof StopRun) throw e; return false; }
    const fixed = parseFileBlocks(text).filter((f) => isLockedTest(f.path) && existsSync(join(this.dir, f.path)) && readFileSync(join(this.dir, f.path), "utf8") !== f.content);
    this.lastDispute = null;
    if (!fixed.length) { this.keptReason = answerSummary(text, 3); this.log.append("factory.tests.disputed", { run: this.id, kept: true, evidence: evidence.slice(0, 1500), said: answerSummary(text) }); return false; }
    const res = writeFiles(this.dir, fixed, { lockTests: false });
    const broken = syntaxErrors(this.dir, res.written.map((w) => w.path).filter((p) => /\.[cm]?js$/.test(p)));
    if (broken.length) { restoreFromHead(this.dir, changedFiles(this.dir).filter(isLockedTest)); this.log.append("factory.tests.disputed", { run: this.id, kept: true, evidence: evidence.slice(0, 1500), said: `correction did not parse: ${broken[0]}` }); return false; }
    const sha = commitAll(this.dir, `Acceptance tests corrected after a dispute\n\n${evidence.slice(0, 1000)}`);
    this.lockedHash = testsHash(this.dir);
    this.lockedSha = git(this.dir, "rev-parse", "HEAD");
    this.lockedCases = undefined;
    // On the record: the Bridge shows that the locked suite changed, why, and which files.
    this.log.append("factory.tests.locked", { run: this.id, hash: this.lockedHash, files: res.written.map((w) => w.path), sha, relocked: true, reason: evidence.slice(0, 1500) });
    return true;
  }

  /** The Reviewer reads the green build against the spec. High findings go to the Fixer once; the rest ride to the build gate. */
  private reviewNotes: ReviewResult | null = null;
  private async reviewLoop() {
    if (!this.o.review) { this.mark("review", "skipped", undefined, "review turned off for this run"); return; }
    for (let round = 1; round <= 2; round++) {
      const r = await this.station("review", async () => {
        const m = this.one("review");
        const src = Object.entries(readTree(this.dir)).filter(([p]) => !isLockedTest(p) && p !== "SPEC.md" && !isKitFile(p) && !p.startsWith("data/")).map(([p, c]) => `<<<FILE ${p}\n${c.length > 12000 ? c.slice(0, 12000) + "\n...(cut: file continues)\n" : c}FILE>>>`).join("\n");
        const verify = this.bench ? `\n\n${VERIFY_CONTRACT}\nThe acceptance criteria:\n${this.plan.acceptance.map((a, i) => `${i + 1}. ${a}`).join("\n")}` : "";
        const text = await this.ask(m, `Spec:\n${JSON.stringify(this.plan, null, 2)}\n\nCode (the locked tests pass):\n${src.slice(0, 48000)}${verify}`, { round });
        // The Reviewer may run things but not change them: whatever it left in the folder goes.
        if (this.bench) { try { restoreFromHead(this.dir, changedFiles(this.dir)); } catch { /* nothing to put back */ } }
        let res: ReviewResult;
        try { res = parseReview(text); }
        catch (e) {
          // Run 2623: the Reviewer gave its verdict, then a background server it started timed out and its last
          // message was only a note about that, so the verdict was lost. Ask once, in the same session, for the JSON.
          let again: ReviewResult | null = null;
          if (this.lastSession) {
            try {
              const t2 = await this.ask(m, "Your last message did not contain your JSON verdict. Reply now with only that JSON (verdict, findings, criteria), exactly as you reached it. Do not run anything.", { round }, { resume: this.lastSession, noTools: true });
              again = parseReview(t2);
              this.log.append("factory.continued", { run: this.id, station: "review", agent: m.id, round, attempt: 1, reason: "the review's last message had no verdict; asked for it again" });
            } catch (e2) { if (e2 instanceof StopRun) throw e2; }
          }
          if (!again) { this.verdict(m, "review", false, round, (e as Error).message); throw e; }
          res = again;
        }
        this.verdict(m, "review", true, round);
        this.log.append("factory.review", { run: this.id, round, agent: m.id, ...res });
        return res;
      }, round);
      this.reviewNotes = r;
      if (r.verdict === "pass" || round === 2) return;
      const high = r.findings.filter((f) => f.severity === "high").map((f) => `- ${f.text}`).join("\n");
      await this.testFixLoop(`The Reviewer found these problems; fix them without breaking the tests:\n${high}`, true);
    }
  }

  private async acceptLoop() {
    for (;;) {
      const unmet = this.reviewNotes?.criteria?.filter((c) => !c.pass).length ?? 0;
      const notes = unmet ? ` (${unmet} acceptance criteri${unmet > 1 ? "a" : "on"} not seen working; read the review first)`
        : this.reviewNotes?.findings.length ? ` (the Reviewer left ${this.reviewNotes.findings.length} note${this.reviewNotes.findings.length > 1 ? "s" : ""})` : "";
      const d = await this.gate("gateB", `Accept the build${notes}`);
      if (d.approve) return;
      if (!d.note) throw new StopRun("You rejected the build.");
      await this.testFixLoop(d.note, true);
    }
  }

  private async ship(): Promise<string> {
    // Ready-to-run inputs for the Run tab, so nobody has to guess the arguments.
    // Apps start with one press and need none; a CLI the idea asked for keeps its examples.
    const examples = this.plan.app && !this.plan.cli ? [] : (this.plan.examples ?? []).filter((x) => x && x.args != null).slice(0, 5);
    if (examples.length && !existsSync(join(this.dir, "run.json"))) {
      const runJson = { summary: this.plan.summary, examples: examples.map((x) => ({ label: String(x.label || x.args), profile: "cli", args: String(x.args), ...(x.input ? { input: String(x.input) } : {}) })) };
      writeFiles(this.dir, [{ path: "run.json", content: JSON.stringify(runJson, null, 2) + "\n" }], { lockTests: true });
    }
    commitAll(this.dir, this.screen?.kind === "feature" ? `Ship: ${this.plan.name} ${this.screen.tag}` : this.screen ? `Ship: ${this.plan.name} as an app` : "Ship");
    git(this.dir, "tag", "-f", this.screen?.tag ?? "v0.1.0");
    return git(this.dir, "rev-parse", "--short", "HEAD");
  }

  // ---------- plumbing ----------

  private async runSuite(round: number): Promise<TestRun> {
    if (testsHash(this.dir) !== this.lockedHash) throw new Error("The locked acceptance tests were changed. Refusing to run.");
    // Fast gates (SF-26): free checks on what the last commit changed, before the slower suite. A failure goes straight to the fixer.
    let changed: string[] = [];
    try { changed = git(this.dir, "diff", "--name-only", "HEAD~1", "HEAD").split("\n").filter(Boolean); } catch { changed = Object.keys(readTree(this.dir)); }
    const gates = fastGates(this.dir, changed.filter((f) => !isKitFile(f)));
    for (const g of gates.results) this.log.append("factory.fastgate", { run: this.id, round, gate: g.gate, state: g.state, note: g.note, messages: g.messages.slice(0, 20) });
    if (!gates.ok) {
      const bad = gates.results.find((g) => g.state === "fail")!;
      const failed: TestRun = { cases: [{ name: `fast check: ${bad.gate}`, file: changed[0] ?? "", pass: false, error: gates.messages, durationMs: 0 }], passed: 0, failed: 1, exitCode: 1, timedOut: false, output: gates.messages };
      this.log.append("factory.tests", { run: this.id, round, cases: failed.cases, passed: 0, failed: 1, timedOut: false });
      return failed;
    }
    const r = await runTests(this.dir);
    // Every project is a real program: the app check (or, for plans from before apps, the page check)
    // is one more cell in the grid, fixed like a failing test.
    if (this.plan?.app) {
      const restored = installKit(this.dir);
      if (restored.length) commitAll(this.dir, `App kit put back (${restored.join(", ")})`);
      // While the app is up, every screen is opened in a real browser (H8): the page's own code runs.
      let screens: ScreenCheck | null = null;
      const app = await checkAppLive(this.dir, process.env.SF_SCREEN_CHECK === "off" ? undefined : async (url) => { screens = await checkScreens(url); return []; });
      this.log.append("factory.ui", { run: this.id, round, ...app, app: true, kitRestored: restored });
      r.cases.push(appCase(app));
      if (!app.pass) { r.failed++; r.output = `App check:\n${app.problems.join("\n")}\n\n${r.output}`.slice(0, 4000); }
      else r.passed++;
      const sc = screens as ScreenCheck | null;
      if (sc) {
        this.log.append("factory.screens", { run: this.id, round, ...sc });
        if (!sc.skipped && sc.screens.length) {
          const c = screenCase(sc);
          r.cases.push(c);
          if (!c.pass) { r.failed++; r.output = `Screens in a real browser:\n${c.error}\n\n${r.output}`.slice(0, 4000); }
          else r.passed++;
        }
      }
    } else if (this.plan?.ui) {
      const ui = checkUi(this.dir);
      this.log.append("factory.ui", { run: this.id, round, ...ui });
      r.cases.push(uiCase(ui));
      if (!ui.pass) { r.failed++; r.output = `Page check:\n${ui.problems.join("\n")}\n\n${r.output}`.slice(0, 4000); }
      else r.passed++;
    }
    // The secret gate (SF-17): a key in the code is one more failing cell, fixed like a test.
    const secrets = scanFiles(readTree(this.dir));
    r.cases.push({ name: "no secrets in the code (API keys, tokens, private keys)", file: secrets[0]?.file ?? "", pass: !secrets.length, error: secrets.length ? describeSecrets(secrets) : undefined } as (typeof r.cases)[number]);
    if (secrets.length) { r.failed++; r.output = `Secret check:\n${describeSecrets(secrets)}\nRead keys from an environment variable instead.\n\n${r.output}`.slice(0, 4000); }
    else r.passed++;
    // The test integrity guard (SF-24): deleted, moved or skipped tests fail the step like a failing test.
    if (this.lockedSha) {
      const gamed = testIntegrity(this.dir, this.lockedSha, { locked: this.lockedCases, ran: this.lockedCases === undefined ? undefined : r.cases.filter((c) => isLockedTest(c.file)).length });
      r.cases.push({ name: "tests left intact (none deleted, moved or skipped)", file: "", pass: !gamed.length, error: gamed.length ? describeIntegrity(gamed) : undefined } as (typeof r.cases)[number]);
      if (gamed.length) { r.failed++; r.output = `Test integrity:\n${describeIntegrity(gamed)}\nFix the code, not the tests.\n\n${r.output}`.slice(0, 4000); }
      else r.passed++;
      if (this.lockedCases === undefined) this.lockedCases = r.cases.filter((c) => isLockedTest(c.file)).length;
    }
    this.log.append("factory.tests", { run: this.id, round, cases: r.cases, passed: r.passed, failed: r.failed, timedOut: r.timedOut });
    return r;
  }

  /** The project's code (not the locked tests, not the spec) as file blocks. */
  private codeText() {
    // The kit is the same in every app and the agents may not change it: they get its API in their contract, not its source.
    return Object.entries(readTree(this.dir)).filter(([p]) => !isLockedTest(p) && p !== "SPEC.md" && !isKitFile(p) && !p.startsWith("data/"))
      .map(([p, c]) => `<<<FILE ${p}\n${c}FILE>>>`).join("\n");
  }

  private testsText() {
    return Object.entries(readTree(this.dir)).filter(([p]) => isLockedTest(p)).map(([p, c]) => `<<<FILE ${p}\n${c}FILE>>>`).join("\n");
  }

  private recallText: string | null = null;
  /** The person's past notes and decisions closest to this idea (SF-22), worked out once per run and logged. */
  private recalled(): string {
    if (this.recallText === null) {
      this.recallText = recallBlock(this.log, this.idea, 5);
      this.log.append("factory.recall", { run: this.id, count: this.recallText ? this.recallText.split("\n").length - 1 : 0 });
    }
    return this.recallText;
  }

  /** The one agent working a single-seat station right now. */
  private one(slot: Slot): CrewMember {
    const m = this.f.crew.crewFor(slot)[0];
    if (!m) throw new Error(`Nobody works the ${slot} station`);
    return m;
  }

  /** The verifier's verdict on one agent's work: what the Agent Bay's pass rate is made of. */
  private verdict(m: CrewMember, station: string, pass: boolean, round?: number, note?: string) {
    this.log.append("agent.verdict", { agent: m.id, version: m.version, station, run: this.id, round, pass, note: note?.slice(0, 300) });
  }

  /**
   * A workbench call that may run out of its own budget mid-work (run 2623: the Builder died at its $0.60 cap
   * after 3 minutes with half the app written, and only a person's Retry finished it). When the call hit its
   * cap and left files in the folder, the work goes on by itself: a fresh call reads what is there and finishes
   * it, at most twice, while the run's own budget allows. Anything else fails as before.
   */
  private async askBench(m: CrewMember, prompt: string, meta: { seat?: number; round?: number } = {}, x: { model?: string } = {}): Promise<string> {
    try { return await this.ask(m, prompt, meta, x); }
    catch (e) {
      if (!this.bench || !/max_budget/i.test(String((e as Error).message))) throw e;
      let last = e;
      for (let n = 1; n <= 2; n++) {
        const landed = changedFiles(this.dir).filter((p) => !isLockedTest(p) && !isKitFile(p));
        if (!landed.length || this.o.maxUsd - this.spent < 0.05) throw last;
        this.log.append("factory.continued", { run: this.id, station: m.station, agent: m.id, round: meta.round, attempt: n, files: landed.slice(0, 40), reason: "the call ran out of its budget with work in progress" });
        try {
          return await this.ask(m, [
            `Your previous call on this task ran out of its budget before it finished. What it wrote is in the folder (${landed.length} file${landed.length === 1 ? "" : "s"} changed: ${landed.slice(0, 20).join(", ")}).`,
            "Do not start over. Read what is there, write only what is still missing or broken, run the tests, and finish. Keep each step small so you finish within this call.",
            `The task, as it was given:\n${prompt}`,
          ].join("\n\n"), meta, x);
        } catch (e2) { if (!/max_budget/i.test(String((e2 as Error).message))) throw e2; last = e2; }
      }
      throw last;
    }
  }

  /** One agent call, inside both its own cap and what is left of the run's cap. */
  /** The CLI session of the last successful call, so a follow-up can continue it. */
  private lastSession: string | undefined;
  private async ask(m: CrewMember, prompt: string, meta: { seat?: number; round?: number } = {}, x: { model?: string; resume?: string; noTools?: boolean } = {}): Promise<string> {
    if (this.o.maxUsd - this.spent < 0.01) {
      // Council seats ask at the same time: one question, and the others see the answer.
      await this.gateTurn(async () => {
        if (this.o.maxUsd - this.spent >= 0.01) return;
        if (this.budgetRefused) throw new StopRun("Budget spent.");
        const d = await this.gate("escalation", `The run's budget of $${this.o.maxUsd.toFixed(2)} is spent. Add 50% more?`, { neverAuto: true, action: "Add 50% more", kind: "budget" }, true);
        if (!d.approve) { this.budgetRefused = true; throw new StopRun("Budget spent."); }
        this.o.maxUsd *= 1.5;
        this.log.append("factory.budget", { run: this.id, maxUsd: this.o.maxUsd });
      });
    }
    // A hint you gave with Retry reaches the next agent call of that station.
    if (this.hint) prompt += `\n\nThe person retried this step after it failed (${this.hint.error.slice(0, 300)}) and said: ${this.hint.note}`;
    const cap = Math.max(0.01, Math.min(m.budgetUsd, this.o.maxUsd - this.spent));
    this.calls++;
    // The Builder and Fixer of a real crew work at the workbench: the project folder, file tools and a shell.
    const bench = !x.noTools && this.bench && (m.station === "build" || m.station === "fix") && !!this.dir && existsSync(this.dir);
    // The Reviewer verifies at the workbench too, but read and run only: no Edit or Write.
    const verifier = !x.noTools && this.bench && m.station === "review" && !!this.dir && existsSync(this.dir);
    const kit = kitArgs(m);
    const r = await runAgent(this.log, this.runtime, m.id, {
      prompt, model: x.model ?? this.modelOf(m), systemPrompt: bench ? `${m.role}\n\n${this.benchContract()}` : m.role, budgetUsd: Number(cap.toFixed(4)),
      ...kit,
      // An agent that reads files reads this project's folder, once there is one.
      ...(this.dir && existsSync(this.dir) && m.tools.some((t) => READ_TOOLS.includes(t)) ? { cwd: this.dir } : {}),
      ...(bench ? { cwd: this.dir, tools: [...new Set([...WORKBENCH_TOOLS, ...(kit.tools ?? [])])], commands: WORKBENCH_COMMANDS, timeoutMs: 25 * 60_000, noMemory: true } : {}),
      ...(verifier ? { cwd: this.dir, tools: [...new Set([...READ_TOOLS, "Bash", ...(kit.tools ?? []).filter((t) => t !== "Edit" && t !== "Write")])], commands: WORKBENCH_COMMANDS, timeoutMs: 15 * 60_000, noMemory: true } : {}),
      ...(x.resume ? { resume: x.resume } : {}),
      ...(x.noTools ? { tools: [] } : {}),
    }, { factoryRun: this.id, station: m.station, agentVersion: m.version, ...meta, ...(bench ? { workbench: true } : {}) });
    this.lastSession = r.result?.sessionId;
    // A call that failed was still paid for (run 2366: two opus calls died at the cap and were never counted).
    this.spent += r.result?.costUsd ?? r.costUsd ?? 0;
    if (r.error || !r.result) throw new Error(`${m.name} failed: ${r.error}`);
    return r.result.text;
  }

  /** Run one station: mark it active, do the work, require its visuals, mark it passed. Failures escalate once. */
  private async station<T>(id: StationId, work: () => Promise<T> | T, round?: number): Promise<T> {
    let attempt = 1;
    let lastError = "";
    for (;;) {
      this.mark(id, "active", round, attempt > 1 ? `retry ${attempt - 1}` : undefined);
      try {
        const out = await work();
        const v = visualCheck(this.log, this.id, id, round);
        this.log.append("factory.visual", { run: this.id, station: id, round, ...v });
        if (!v.pass) {
          this.mark(id, "incomplete", round, "missing visual: " + v.missing.join(", "));
          throw new Error(`visualizeEverything failed at ${id}: missing ${v.missing.join(", ")}`);
        }
        const failing = (out as TestRun | undefined)?.failed;
        this.mark(id, failing ? "fail" : "pass", round, failing ? `${failing} failing` : undefined);
        if (this.hint?.station === id) this.hint = null;
        return out;
      } catch (e) {
        if (e instanceof StopRun) throw e;
        const msg = (e as Error).message;
        this.mark(id, "fail", round, msg);
        // The same error again means the retry changed nothing: say so, so a Retry that "does nothing" is visible.
        const same = attempt > 1 && msg === lastError;
        const q = same
          ? `${stationName(id)} failed again the same way (attempt ${attempt}): ${msg.slice(0, 300)}. Retrying as is will likely fail again; add a hint or check Systems, then retry?`
          : `${stationName(id)} failed${attempt > 1 ? ` again (attempt ${attempt})` : ""}: ${msg.slice(0, 300)}. Retry it?`;
        const d = await this.gate("escalation", q, { action: "Retry", kind: "retry", station: id, attempt, error: msg.slice(0, 2000), same });
        if (!d.approve) throw new StopRun(`${stationName(id)} failed: ${msg}`);
        this.hint = d.note ? { station: id, note: d.note, error: msg } : null;
        lastError = msg;
        attempt++;
      }
    }
  }

  private mark(station: StationId, state: "active" | "pass" | "fail" | "incomplete" | "waiting" | "skipped", round?: number, note?: string) {
    this.log.append("factory.station", { run: this.id, station, state, round, note, spentUsd: Number(this.spent.toFixed(6)), maxUsd: this.o.maxUsd });
  }

  private autoRetriesUsed = 0;
  private budgetRefused = false;
  private hint: { station: StationId; note: string; error: string } | null = null;
  private gateQueue: Promise<unknown> = Promise.resolve();

  /** One question at a time per run: parallel work (Council seats) waits its turn instead of overwriting a waiting gate. */
  private gateTurn<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.gateQueue.then(fn, fn);
    this.gateQueue = next.catch(() => undefined);
    return next;
  }

  private gate(gate: GateId, question: string, opts: GateOpts = {}, queued = false): Promise<GateDecision> {
    return queued ? this.askGate(gate, question, opts) : this.gateTurn(() => this.askGate(gate, question, opts));
  }

  private async askGate(gate: GateId, question: string, opts: GateOpts): Promise<GateDecision> {
    const station: StationId = gate === "escalation" ? "fix" : gate;
    if (gate !== "escalation") this.mark(station, "waiting");
    const { neverAuto: _n, ...info } = opts;
    let auto = this.o.autoApprove && gate !== "escalation";
    if (this.o.autoApprove && gate === "escalation" && !opts.neverAuto && this.autoRetriesUsed < this.o.autoRetries) { this.autoRetriesUsed++; auto = true; }
    // `auto`: nobody is asked, the run approves itself (screens and tickets then say nothing waits for you).
    this.log.append("factory.gate", { run: this.id, gate, state: "waiting", question, ...info, ...(auto ? { auto: true } : {}) });
    // An unattended run never hangs: an escalation it may not retry stops the run.
    const d: GateDecision = auto ? { approve: true, by: "auto" }
      : this.o.autoApprove ? { approve: false, by: "auto" }
      : await this.f.awaitGate(this.id, gate);
    this.log.append("factory.gate", { run: this.id, gate, state: d.approve ? "approved" : "rejected", note: d.note, by: d.by ?? "you", ...(info.kind ? { kind: info.kind, station: info.station, attempt: info.attempt } : {}) });
    if (gate !== "escalation") this.mark(station, d.approve ? "pass" : "fail", undefined, d.note);
    return d;
  }

  private finish(outcome: "shipped" | "stopped" | "failed", reason: string, sha?: string) {
    // A screen run that does not ship leaves the shipped project exactly as it was.
    if (this.screen && outcome !== "shipped" && this.dir && existsSync(join(this.dir, ".git"))) {
      try { git(this.dir, "reset", "-q", "--hard", this.screen.baseSha); git(this.dir, "clean", "-fdq"); reason += ` The folder is back at ${this.screen.baseSha.slice(0, 7)}, as it shipped.`; } catch { /* leave it; the reason says what happened */ }
    }
    this.log.append("factory.run.finished", {
      run: this.id, outcome, reason, dir: this.dir || null, sha: sha ?? null, plan: this.plan?.name ?? null,
      totalUsd: Number(this.spent.toFixed(6)), agentCalls: this.calls, fixRounds: this.fixRounds,
    });
  }
}

/**
 * The API's answer when a Build would repeat a run: 409 with the run it repeats, so the Bridge can
 * offer "Show run #N" or "Build again anyway" (the same request with { again: true }).
 */
export function duplicateReply(factory: Pick<Factory, "duplicateOf">, idea: string, again: unknown): [number, Record<string, unknown>] | null {
  if (again === true) return null;
  const d = factory.duplicateOf(idea);
  if (!d) return null;
  const what = d.state === "running" ? "is already building it" : d.state === "stopped" ? "already started it and can resume" : "already built it today";
  return [409, { error: `Run #${d.run} ${what}. Open that run, or build again anyway.`, duplicateOf: d.run, state: d.state, projectId: d.projectId }];
}

/** An idea as the duplicate check compares it: case, spacing and closing punctuation do not matter. */
export function normIdea(idea: string): string {
  return idea.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!?\s]+$/, "");
}

/**
 * The done-claim check (H8), added to the Reviewer's job when it has the workbench: "the tests pass" is not
 * "it works". Each acceptance criterion is checked against the running product, with what was seen.
 */
export const VERIFY_CONTRACT = [
  "You also verify the product, not only read it. You have a shell in the project folder (read and run only: do not change files).",
  "For EACH acceptance criterion below, check it by running code: call the functions with node (node --input-type=module -e \"import('./src/x.js').then(...)\"), and for the app start it with `node server.js` in the background on PORT=0, read the port from its \"Ready on\" line and fetch its pages and /api/_db with node, then stop it.",
  "Stop every process you start (a server you ran in the background) before you answer, and make the JSON your very last message: only the last message is read.",
  "Add to your JSON a \"criteria\" list, one entry per criterion in order: {\"text\": \"the criterion\", \"pass\": true|false, \"evidence\": \"what you ran and what you saw, short\"}. pass is true only when you saw it work.",
].join("\n");

/** One step up the model ladder, for a fix round that has to think harder (H6). */
/** The least a model needs left in the run's budget to do a real fix round. */
export function modelFloorUsd(model: string): number {
  return /opus/i.test(model) ? 0.4 : /sonnet/i.test(model) ? 0.15 : 0.02;
}

export function strongerModel(model: string): string {
  if (/haiku/i.test(model)) return "sonnet";
  if (/sonnet/i.test(model)) return "opus";
  return model;
}

function stationName(id: StationId) {
  return ({ intake: "Intake", council: "Council", plan: "Plan", gateA: "Plan gate", tests: "Acceptance tests", build: "Build", test: "Test", fix: "Fix", review: "Review", gateB: "Build gate", ship: "Ship" } as const)[id];
}

export function validatePlan(p: Plan): Plan {
  if (!p || typeof p !== "object") throw new Error("The plan is not an object");
  for (const k of ["name", "slug", "summary", "interface"] as const) if (typeof p[k] !== "string" || !p[k].trim()) throw new Error(`The plan is missing "${k}"`);
  if (!Array.isArray(p.acceptance) || !p.acceptance.length) throw new Error("The plan has no acceptance criteria");
  if (!Array.isArray(p.tasks) || !p.tasks.length) throw new Error("The plan has no tasks");
  const slug = p.slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
  const ids = new Set(p.tasks.map((t) => String(t.id)));
  const examples = (Array.isArray(p.examples) ? p.examples : []).filter((x: any) => x && typeof x === "object" && (typeof x.args === "string" || Array.isArray(x.args)))
    .map((x: any) => ({ label: String(x.label ?? x.args).slice(0, 80), args: Array.isArray(x.args) ? x.args.map(String).join(" ") : String(x.args), ...(x.input ? { input: String(x.input) } : {}) })).slice(0, 5);
  return {
    ...p, slug, files: Array.isArray(p.files) ? p.files.map(String) : [],
    // A plan always has a screen (visualizeEverything); a planner that forgot gets the default one.
    ui: typeof p.ui === "string" && p.ui.trim() ? p.ui.trim() : defaultUi(p),
    cli: typeof p.cli === "string" ? p.cli.trim() : "",
    examples,
    // Every new plan is a real program on the app kit (the Brain's "real-programs").
    app: true,
    entities: (Array.isArray(p.entities) ? p.entities : []).filter((e: any) => e && typeof e.name === "string").slice(0, 8).map((e: any) => ({
      name: String(e.name), ...(e.label ? { label: String(e.label) } : {}),
      fields: (Array.isArray(e.fields) ? e.fields : []).filter((f: any) => f && typeof f.name === "string").map((f: any) => ({ name: String(f.name), type: String(f.type ?? "text"), ...(f.required ? { required: true } : {}), ...(Array.isArray(f.options) ? { options: f.options.map(String) } : {}), ...(f.to ? { to: String(f.to) } : {}) })),
      ...(e.seed ? { seed: String(e.seed).slice(0, 300) } : {}),
    })),
    flows: (Array.isArray(p.flows) ? p.flows : []).filter((x: any) => x && x.name).slice(0, 6).map((x: any) => ({ name: String(x.name), steps: (Array.isArray(x.steps) ? x.steps : []).map(String).slice(0, 10) })),
    views: (Array.isArray(p.views) ? p.views : []).filter((x: any) => x && (x.id || x.label)).slice(0, 4).map((x: any) => ({ id: String(x.id ?? x.label).toLowerCase().replace(/[^a-z0-9-]+/g, "-"), label: String(x.label ?? x.id), shows: String(x.shows ?? "") })),
    tasks: p.tasks.map((t) => ({ id: String(t.id), title: String(t.title ?? t.id), dependsOn: (Array.isArray(t.dependsOn) ? t.dependsOn : []).map(String).filter((d) => ids.has(d)) })),
  };
}

/** The screen a plan gets when nobody described one. */
export function defaultUi(p: Pick<Plan, "summary" | "interface">): string {
  return `An app for: ${p.summary.trim()} It opens with sample records already in it, lets the person create, edit and delete everything it keeps through forms, runs the core (${p.interface.trim().slice(0, 300)}) from a view of its own and draws the results visually (a table, bars or a preview), with any error shown on the screen.`;
}

export function specMarkdown(idea: string, p: Plan): string {
  return [
    `# ${p.name}`, "", `> ${idea}`, "", p.summary, "",
    "## Interface", "", p.interface, "",
    ...(p.ui ? [p.app ? "## The app" : "## Screen", "", p.ui, "", p.app ? "Open it from the project's Run tab in SoftwareFactory and press Start: no arguments, no files to write. Data is kept in `data/db.json`." : "Open it from the project's Run tab in SoftwareFactory (it serves the folder and shows `index.html`).", ""] : []),
    ...(p.entities?.length ? ["## What it manages", "", ...p.entities.map((e) => `- **${e.label ?? e.name}**: ${e.fields.map((f) => `${f.name} (${f.type ?? "text"}${f.to ? ` → ${f.to}` : ""}${f.required ? ", required" : ""})`).join(", ")}. Create, edit, delete and search them in the app.`), ""] : []),
    ...(p.flows?.length ? ["## Flows", "", ...p.flows.map((f) => `- **${f.name}**: ${f.steps.join(" → ")}`), ""] : []),
    ...(p.views?.length ? ["## Views", "", ...p.views.map((v) => `- **${v.label}**: ${v.shows}`), ""] : []),
    ...(p.cli ? ["## Command line", "", "```", p.cli, "```", ""] : []),
    "## Acceptance criteria", "", ...p.acceptance.map((a, i) => `${i + 1}. ${a}`), "",
    "## Tasks", "", ...p.tasks.map((t) => `- **${t.id}** ${t.title}${t.dependsOn.length ? ` (after ${t.dependsOn.join(", ")})` : ""}`), "",
    "Built by SoftwareFactory. The tests in `test/` were written from this spec before the code and were locked.", "",
  ].join("\n");
}

/** How many times one run is resumed on its own before it waits for the Resume button. */
export const MAX_AUTO_RESUMES = 3;

/** Runs whose newest lifecycle event is a start or a resume, not a finish. */
export function unfinishedRuns(log: EventLog): number[] {
  const open = new Set<number>();
  const life = [...log.list({ type: "factory.run.started", limit: 1e7 }), ...log.list({ type: "factory.run.resumed", limit: 1e7 }), ...log.list({ type: "factory.run.finished", limit: 1e7 })].sort((a, b) => a.id - b.id);
  for (const e of life) {
    if (e.type === "factory.run.started") open.add(e.id);
    else if (e.type === "factory.run.resumed") open.add((e.payload as { run: number }).run);
    else if (e.type === "factory.run.finished") open.delete((e.payload as { run: number }).run);
  }
  return [...open];
}

export interface RestoredState {
  /** Milestones already reached: intake, council, planWritten, plan, tests, build, reviewed, accepted. */
  done: Set<string>;
  /** The station a resume starts at. */
  from: StationId;
  spent: number;
  calls: number;
  maxUsd?: number;
  fixRounds: number;
  plan?: Plan;
  dir?: string;
  lockedHash?: string;
  brief: CouncilBrief | null;
  review: ReviewResult | null;
}

/**
 * Where a run stands, from the event log alone (the source of truth): which
 * stations it completed, what it spent, its plan, repo and locked tests.
 */
export function restoreState(log: EventLog, run: number): RestoredState {
  const evs = log.list({ sinceId: run - 1, limit: 1e7 }).filter((e) => { const p = e.payload as { run?: number; factoryRun?: number }; return p?.run === run || p?.factoryRun === run; });
  const of = (type: string) => evs.filter((e) => e.type === type).map((e) => e.payload as any);
  const stations = of("factory.station");
  const passed = (st: StationId) => stations.some((p) => p.station === st && (p.state === "pass" || p.state === "skipped"));
  const done = new Set<string>();
  const plan = of("factory.plan").at(-1);
  const gates = of("factory.gate");
  const lastPlanAt = evs.map((e) => e.type).lastIndexOf("factory.plan");
  if (passed("intake")) done.add("intake");
  const council = stations.filter((p) => p.station === "council").at(-1);
  const brief = (of("factory.council").at(-1)?.brief ?? null) as CouncilBrief | null;
  if (council?.state === "skipped" || plan || (council?.state === "pass" && brief && brief.outcome !== "drop")) done.add("council");
  if (plan) done.add("planWritten");
  if (lastPlanAt >= 0 && evs.slice(lastPlanAt).some((e) => e.type === "factory.gate" && (e.payload as any).gate === "gateA" && (e.payload as any).state === "approved")) done.add("plan");
  const locked = of("factory.tests.locked").at(-1);
  if (locked && done.has("plan")) done.add("tests");
  if (done.has("tests") && stations.some((p) => p.station === "build" && p.state !== "active" && p.state !== "fail" && p.state !== "incomplete") && of("factory.files").some((p) => p.station === "build")) done.add("build");
  const gateB = gates.filter((g) => g.gate === "gateB");
  if (done.has("build") && gateB.length) done.add("reviewed");
  if (done.has("reviewed") && gateB.at(-1)?.state === "approved") done.add("accepted");
  const order: [string, StationId][] = [["intake", "intake"], ["council", "council"], ["planWritten", "plan"], ["plan", "gateA"], ["tests", "tests"], ["build", "build"], ["reviewed", "test"], ["accepted", "gateB"]];
  const from = order.find(([k]) => !done.has(k))?.[1] ?? "ship";
  const completed = [...of("agent.run.completed"), ...of("agent.run.failed")];
  const reviews = of("factory.review");
  const budget = of("factory.budget").at(-1);
  return {
    done, from,
    spent: completed.reduce((a, p) => a + (Number(p.costUsd) || 0), 0),
    calls: of("agent.run.started").length,
    maxUsd: budget?.maxUsd,
    fixRounds: Math.max(0, ...stations.filter((p) => p.station === "fix" && p.round).map((p) => Number(p.round))),
    plan: plan?.plan, dir: plan?.dir, lockedHash: done.has("tests") ? locked?.hash : undefined,
    brief, review: reviews.length ? { verdict: reviews.at(-1).verdict, findings: reviews.at(-1).findings } : null,
  };
}
