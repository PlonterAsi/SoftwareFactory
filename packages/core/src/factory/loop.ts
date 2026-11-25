import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EventLog } from "../events.js";
import { MockRuntime, type AgentRuntime } from "../runtime.js";
import { builtinCrew, type CrewSource } from "./crew.js";
import { FlowLibrary } from "../flows/library.js";
import { FEATURE_FIT_USD } from "./features.js";
import { type ScreenText } from "./evaluate.js";
import { probeStart } from "./appkit.js";
import { checkScreens, readScreens, type ScreenCheck } from "./screencheck.js";
import { checkLinks, type LinkCheck } from "./linkcheck.js";
import { git, isLockedTest, readTree, testsHash } from "./workspace.js";
import { type GateDecision, type GateId, MAX_AUTO_RESUMES, type Pending, type Plan, type RunMaker, type RunOptions, type ScreenRun, type StationId, StopRun, defaultUi, normIdea, restoreState, unfinishedRuns, waitingEscalation } from "./runkit.js";
import { Run } from "./run.js";
import { AwakeClock, watchSleep } from "./awake.js";
import { brainHash, principles } from "../brain/brain.js";

export { parseReview, StopRun, duplicateReply, normIdea, VERIFY_CONTRACT, modelFloorUsd, strongerModel, MAX_VIEWS, withDesignedScreens, journeyTestRule, kitName, reviewCapUsd, validatePlan, defaultUi, specMarkdown, NEXT_VERSION_ROUNDS, shippedDesign, MAX_AUTO_RESUMES, unfinishedRuns, reviewRepair, mergeRecheck, waitingEscalation, restoreState } from "./runkit.js";
export type { StationId, GateId, Plan, RunOptions, ScreenRun, ReviewResult, GateDecision, RunSettings, RunMaker, RestoredState } from "./runkit.js";
export { Run } from "./run.js";
export { RunBase } from "./runbase.js";
export { RunJudge } from "./runjudge.js";

export class Factory {
  private pending = new Map<number, Pending>();
  private active = new Map<number, Promise<void>>();
  /** SF-115: runs asked to stop, with why; each one's agent call in flight is cut through its signal. */
  private stopping = new Map<number, string>();
  private aborters = new Map<number, AbortController>();

  /** Runs this core found in flight when it started (closed as stopped, resumable). */
  readonly interrupted: number[] = [];

  /**
   * What each screen of a built app shows, for the product judge: the core starts the app and reads its
   * screens in a real browser. null when that cannot be done here (no browser, or the screen check is off).
   */
  /** Open every screen of the app in `dir` in a real browser. Null when the check is off. Tests replace it. */
  /** Open links for real. Tests replace it. */
  checkLinks: (urls: string[]) => Promise<LinkCheck> = (urls) => checkLinks(urls);
  checkScreens: (dir: string) => Promise<ScreenCheck | null> = async (dir) => {
    if (process.env.SF_SCREEN_CHECK === "off") return null;
    let out: ScreenCheck | null = null;
    const problems = await probeStart(dir, 15_000, async (url) => { out = await checkScreens(url); return []; });
    // An app that does not start has no screen that draws (run 3185: this used to count as "nothing to check").
    if (!out && problems.length) return { pass: false, screens: [{ route: "", ok: false, problem: `the app did not start: ${problems[0].slice(0, 300)}` }] };
    return out;
  };
  readScreens: (dir: string) => Promise<ScreenText[] | null> = async (dir) => {
    if (process.env.SF_SCREEN_CHECK === "off") return null;
    let out: ScreenText[] | null = null;
    await probeStart(dir, 15_000, async (url) => { out = await readScreens(url); return []; });
    return out;
  };

  /**
   * Other kinds of run, by the `kind` their started event carries (factory/reporun.ts adds "repo": a run that
   * works in an existing codebase). A kind says how its Run object is made, for a start and for a resume.
   */
  readonly kinds = new Map<string, RunMaker>();
  /** Where runs in existing codebases keep their clones (one folder per run). */
  get repoWorkDir() { return join(dirname(this.projectsDir), "repo-work"); }

  /** Wall-clock limit per run in minutes (the `maxRunMinutes` setting). */
  maxRunMinutes: number | undefined;
  /**
   * How much more a running build may be given when its own limit is spent: the project's budget may allow
   * less than the "Add 50% more" asked for. The server wires it to the project budgets; by default no ceiling.
   */
  extraBudget: (run: number, wantUsd: number) => number = (_run, want) => want;

  /** The flows runs follow (flows/library.ts): each run keeps a copy of its flow on its started event. */
  readonly flows: FlowLibrary;

  constructor(private log: EventLog, private runtime: AgentRuntime, readonly projectsDir: string, readonly crew: CrewSource = builtinCrew) {
    this.flows = new FlowLibrary(log);
    // Sleep is not work: clocks that measure a run leave out the time the PC slept (factory/awake.ts).
    watchSleep();
    // Every event a run writes is a heartbeat.
    log.on("event", (e: { payload: unknown }) => {
      const p = e.payload as { run?: unknown; factoryRun?: unknown } | null;
      const id = typeof p?.run === "number" ? p.run : typeof p?.factoryRun === "number" ? p.factoryRun : null;
      if (id != null) this.beat(id);
    });
    // Agent calls cut off by the restart would otherwise pulse as "running" forever.
    const ended = new Set([...log.list({ type: "agent.run.completed", limit: 1e6 }), ...log.list({ type: "agent.run.failed", limit: 1e6 })].map((e) => (e.payload as { runId: number }).runId));
    for (const e of log.list({ type: "agent.run.started", limit: 1e6 })) {
      if (!ended.has(e.id)) log.append("agent.run.failed", { runId: e.id, agent: (e.payload as { agent: string }).agent, factoryRun: (e.payload as { factoryRun?: number }).factoryRun, error: "The core restarted during this call." });
    }
    // Runs that were mid-flight when the app closed are closed honestly as stopped,
    // marked resumable: resumeInterrupted() (or the Bridge's Resume) picks them up
    // again from the last station they completed.
    for (const id of unfinishedRuns(log)) {
      // Run 3185: the app updated while the run waited at "Review failed. Retry it?", and the restart resumed it
      // and paid for the retry nobody pressed. A run that was waiting for the person's answer stays stopped
      // until they answer with Resume; it is not picked up by itself.
      const asked = waitingEscalation(log, id);
      log.append("factory.run.finished", { run: id, outcome: "stopped", reason: asked ? `The app closed while this run waited for your answer: ${asked.slice(0, 300)} Press Resume to go on, or leave it stopped.` : "The app closed while this run was in flight.", resumable: true, totalUsd: null, ...(asked ? { waitedFor: asked.slice(0, 300) } : {}) });
      if (!asked) this.interrupted.push(id);
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
      // A run that waited at the plan or build gate comes back to that gate with no agent call: an update while it
      // waits is not a run that keeps dying, so those resumes do not count toward the limit.
      const atGate = (from?: string) => from === "gateA" || from === "gateB";
      const auto = this.log.list({ type: "factory.run.resumed", limit: 1e6 }).filter((e) => { const p = e.payload as { run: number; auto?: boolean; from?: string }; return p.run === id && p.auto && !atGate(p.from); }).length;
      if (auto >= MAX_AUTO_RESUMES && !atGate(restoreState(this.log, id).from)) continue;
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

  /**
   * SF-65: can a run that stopped or failed be tried again from the step it stopped at? Any run that did not
   * ship, whose folder is still there. A screen run is not: its folder went back to what shipped.
   */
  retryable(run: number): { ok: boolean; why?: string; from?: StationId } {
    if (this.active.has(run)) return { ok: false, why: "It is running." };
    const started = this.log.get(run);
    if (started?.type !== "factory.run.started") return { ok: false, why: "No such run." };
    const sp = started.payload as { kind?: string; screen?: unknown };
    if (sp.screen) return { ok: false, why: "A screen or feature run goes back to what shipped when it stops; start it again from its project." };
    if (sp.kind && !this.kinds.has(sp.kind)) return { ok: false, why: `It is a "${sp.kind}" run, which this core cannot continue.` };
    const life = this.log.list({ sinceId: run - 1, limit: 1e6 }).filter((e) => (e.type === "factory.run.finished" || e.type === "factory.run.resumed") && (e.payload as { run: number }).run === run).at(-1);
    const fin = life?.type === "factory.run.finished" ? life.payload as { outcome: string } : null;
    if (!fin) return { ok: false, why: "It has not stopped." };
    if (fin.outcome === "shipped") return { ok: false, why: "It already shipped." };
    const st = restoreState(this.log, run);
    if (st.dir && !existsSync(join(st.dir, ".git"))) return { ok: false, why: `Its project folder is gone (${st.dir}).` };
    if (!st.dir && !["intake", "council", "discover", "plan"].includes(st.from)) return { ok: false, why: "It has no project folder to pick up in." };
    return { ok: true, from: st.from };
  }

  /**
   * What a retry adds (SF-65): enough for what is left, not the same starved share again. At the build: a
   * whole session (FEATURE_FIT_USD) for each feature not built yet, and room for the review and the judge.
   * After the build: a review and a judge. Before it: what the run started with.
   */
  retryAddUsd(run: number): number {
    const st = restoreState(this.log, run);
    const first = Number((this.log.get(run)?.payload as { maxUsd?: number } | undefined)?.maxUsd ?? 1.5);
    const evs = this.log.list({ sinceId: run - 1, limit: 1e6 }).filter((e) => e.type === "factory.feature" && (e.payload as { run?: number }).run === run).map((e) => e.payload as { id: string; state: string });
    const builtIds = new Set<string>();
    for (const f of evs) { if (f.state === "built") builtIds.add(f.id); else if (f.state !== "building") builtIds.delete(f.id); }
    let add: number;
    if (st.from === "build" || st.from === "tests") {
      const all = st.plan?.features?.length ?? (st.plan ? (st.plan.views?.length ?? 0) + 2 : 1);
      const left = Math.max(1, all - builtIds.size);
      add = left * FEATURE_FIT_USD / 0.8 + 0.5;
    } else if (st.from === "test" || st.from === "gateB" || st.from === "ship") add = 0.75;
    else add = first;
    return Number(Math.min(Math.max(add, 0.5), Math.max(first, 0.5) * 2).toFixed(2));
  }

  /**
   * SF-65: try a stopped or failed run again from the step it stopped at, with fresh money for what is left.
   * Until now Retry repeated the step with what was left of the old limit, so a build starved of money died
   * the same way again. What was built stays built; the project's budget still bounds what is added.
   */
  retry(run: number, opts: { addUsd?: number; by?: string; auto?: boolean } = {}): { run: number; from: StationId; addUsd: number; maxUsd: number } {
    const ok = this.retryable(run);
    if (!ok.ok) throw new Error(`Run #${run} cannot be retried: ${ok.why}`);
    const want = opts.addUsd ?? this.retryAddUsd(run);
    const add = Number(Math.min(want, this.extraBudget(run, want)).toFixed(2));
    if (add < 0.05) throw new Error(`Run #${run} cannot be retried: the project's budget has nothing left. Raise the project's total on its page to go on.`);
    const st = restoreState(this.log, run);
    const maxUsd = Number((st.spent + add).toFixed(4));
    this.log.append("factory.budget", { run, maxUsd, retry: true });
    this.log.append("factory.run.retried", { run, from: ok.from, addUsd: add, maxUsd, spentUsd: Number(st.spent.toFixed(4)), by: opts.by ?? "you" });
    this.pickUp(run, { auto: !!opts.auto });
    return { run, from: ok.from!, addUsd: add, maxUsd };
  }

  /** Pick a stopped run up again from its last completed station. Returns the run id. */
  resume(run: number, opts: { auto?: boolean } = {}): number {
    const ok = this.resumable(run);
    if (!ok.ok) throw new Error(`Run #${run} cannot resume: ${ok.why}`);
    return this.pickUp(run, opts);
  }

  private pickUp(run: number, opts: { auto?: boolean } = {}): number {
    const started = this.log.get(run)!.payload as { idea: string; maxUsd?: number; maxFixRounds?: number; autoApprove?: boolean; autoRetries?: number; runtime?: string; council?: "auto" | "always" | "never"; review?: boolean; models?: Record<string, string>; screen?: ScreenRun; kind?: string; sizeFromPlan?: boolean };
    // A run of a kind this core does not know is refused before anything about it is touched.
    const make = started.kind ? this.kinds.get(started.kind) : undefined;
    if (started.kind && !make) throw new Error(`Run #${run} is a "${started.kind}" run, which this core cannot continue.`);
    const st = restoreState(this.log, run);
    // A run keeps the crew it started with: a practice run stays on the free mock crew.
    const current = (this.runtime as { current?: AgentRuntime }).current ?? this.runtime;
    const runtime = started.runtime === "mock" && current.name !== "mock" ? new MockRuntime({ delayMs: Number(process.env.SF_MOCK_DELAY_MS ?? 700) }) : current;
    const o = { maxUsd: started.maxUsd ?? 1.5, maxFixRounds: started.maxFixRounds ?? 5, autoApprove: !!started.autoApprove, autoRetries: started.autoRetries ?? 1, models: started.models ?? {}, council: started.council ?? "auto", review: started.review !== false,
      // A new project started at the plain default before sizing existed is sized at its plan gate too.
      sizeFromPlan: started.sizeFromPlan ?? (!started.autoApprove && !started.screen && !started.kind && (started.maxUsd ?? 1.5) === 1.5) };
    if (st.maxUsd) o.maxUsd = st.maxUsd;
    // Partial writes from the station that was cut off are thrown away: back to its last commit.
    if (st.dir && existsSync(join(st.dir, ".git"))) {
      try { git(st.dir, "reset", "-q", "--hard"); git(st.dir, "clean", "-fdq"); } catch { /* a repo with no commit yet: the plan station runs again */ }
    }
    this.log.append("factory.run.resumed", { run, from: st.from, auto: !!opts.auto, spentUsd: Number(st.spent.toFixed(6)), runtime: runtime.name });
    const r = make ? make({ factory: this, log: this.log, runtime, id: run, idea: started.idea, o, started }) : new Run(this, this.log, runtime, run, started.idea, o, started.screen ?? null);
    const done = r.go(st).finally(() => this.ended(run));
    this.active.set(run, done);
    this.beat(run);
    return run;
  }

  /** Start a run in the background; returns its id at once. */
  start(idea: string, opts: RunOptions = {}): number {
    const text = idea.trim();
    if (!text) throw new Error("An idea needs some text");
    // No limit given and a person at the gates: the plan gate sizes the run from its plan (runkit.ts sizeFromPlan).
    const sizeFromPlan = opts.sizeFromPlan ?? (opts.maxUsd == null && !opts.autoApprove);
    const o = { maxUsd: opts.maxUsd ?? 1.5, maxFixRounds: opts.maxFixRounds ?? 5, autoApprove: !!opts.autoApprove, autoRetries: opts.autoRetries ?? 1, models: opts.models ?? {}, council: opts.council ?? "auto", review: opts.review !== false, sizeFromPlan };
    // A run keeps the crew it started with, even if you switch Practice/Real meanwhile.
    const runtime = (this.runtime as { current?: AgentRuntime }).current ?? this.runtime;
    const flow = this.flows.forRun(undefined, opts.flow);
    const ev = this.log.append("factory.run.started", { idea: text, ...(sizeFromPlan ? { sizeFromPlan } : {}), maxUsd: o.maxUsd, maxFixRounds: o.maxFixRounds, autoApprove: o.autoApprove, autoRetries: o.autoRetries, runtime: runtime.name, council: o.council, review: o.review, models: o.models, brain: brainHash(principles(this.log)), ...(opts.projectId != null ? { projectId: opts.projectId } : {}), flow });
    const done = new Run(this, this.log, runtime, ev.id, text, o).go().finally(() => this.ended(ev.id));
    this.active.set(ev.id, done);
    this.beat(ev.id);
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
    const ev = this.log.append("factory.run.started", { idea, maxUsd: o.maxUsd, maxFixRounds: o.maxFixRounds, autoApprove: o.autoApprove, autoRetries: o.autoRetries, runtime: runtime.name, council: o.council, review: o.review, models: o.models, brain: brainHash(principles(this.log)), screen, ...(opts.projectId != null ? { projectId: opts.projectId } : {}), flow: this.flows.forRun() });
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
    const done = new Run(this, this.log, runtime, id, idea, o, screen).go(restoreState(this.log, id)).finally(() => this.ended(id));
    this.active.set(id, done);
    this.beat(id);
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
  addFeature(baseRun: number, ask: string, opts: Pick<RunOptions, "maxUsd" | "autoApprove" | "autoRetries" | "models" | "projectId" | "council"> & { keepDesign?: boolean } = {}): number {
    const text = ask.trim();
    if (!text) throw new Error("Say what to add.");
    // Runs 11701 and 11784 (Idea Bank, what v0.1.0 left): the Council and two design rounds took $1.60 of the
    // $3.00 before a line was built, to design requirements the shipped design already holds.
    const screen: ScreenRun = { ...this.onTopOf(baseRun, "feature", "add a feature to"), ...(opts.keepDesign ? { keepDesign: true } : {}) };
    const o = { maxUsd: opts.maxUsd ?? 1.5, maxFixRounds: 5, autoApprove: !!opts.autoApprove, autoRetries: opts.autoRetries ?? 1, models: opts.models ?? {}, council: opts.keepDesign ? "never" as const : opts.council ?? "auto", review: true };
    const runtime = (this.runtime as { current?: AgentRuntime }).current ?? this.runtime;
    const flow = this.flows.forRun();
    const ev = this.log.append("factory.run.started", { idea: text, maxUsd: o.maxUsd, maxFixRounds: o.maxFixRounds, autoApprove: o.autoApprove, autoRetries: o.autoRetries, runtime: runtime.name, council: o.council, review: o.review, models: o.models, brain: brainHash(principles(this.log)), screen, ...(opts.projectId != null ? { projectId: opts.projectId } : {}), flow });
    const done = new Run(this, this.log, runtime, ev.id, text, o, screen).go().finally(() => this.ended(ev.id));
    this.active.set(ev.id, done);
    this.beat(ev.id);
    return ev.id;
  }

  /**
   * Start a run of another kind (see `kinds`). `extra` goes on its started event, which is all a resume has
   * to build the run again from. Returns the run id at once; the work goes on in the background.
   */
  launch(kind: string, idea: string, extra: Record<string, unknown>, opts: RunOptions = {}): number {
    const make = this.kinds.get(kind);
    if (!make) throw new Error(`This core has no "${kind}" runs.`);
    const text = idea.trim();
    if (!text) throw new Error("Say what to build.");
    const o = { maxUsd: opts.maxUsd ?? 1.5, maxFixRounds: opts.maxFixRounds ?? 5, autoApprove: !!opts.autoApprove, autoRetries: opts.autoRetries ?? 1, models: opts.models ?? {}, council: opts.council ?? "auto", review: opts.review !== false };
    const runtime = (this.runtime as { current?: AgentRuntime }).current ?? this.runtime;
    const started = { idea: text, maxUsd: o.maxUsd, maxFixRounds: o.maxFixRounds, autoApprove: o.autoApprove, autoRetries: o.autoRetries, runtime: runtime.name, council: o.council, review: o.review, models: o.models, brain: brainHash(principles(this.log)), kind, ...extra, ...(opts.projectId != null ? { projectId: opts.projectId } : {}), flow: this.flows.forRun(kind, opts.flow) };
    const ev = this.log.append("factory.run.started", started);
    const done = make({ factory: this, log: this.log, runtime, id: ev.id, idea: text, o, started }).go().finally(() => this.ended(ev.id));
    this.active.set(ev.id, done);
    this.beat(ev.id);
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
  /** The runs in flight, each with the gate it is waiting at (null while it is working). */
  activeRuns(): { run: number; gate: GateId | null }[] { return [...this.active.keys()].map((run) => ({ run, gate: this.waitingGate(run) })); }
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
    const why = this.stopping.get(run);
    if (why) return Promise.reject(new StopRun(why));
    return new Promise((res, rej) => this.pending.set(run, { gate, resolve: res, stop: rej }));
  }

  /**
   * SF-115: stop a run on purpose, whatever it is doing. One parked at a gate ends at once; one at work ends as soon
   * as its agent call in flight is cut (the CLI is killed through the run's signal) or its next step begins; one the
   * app's restart left stopped and resumable (also one that waited at a gate) is closed for good, so nothing resumes
   * it. On 2026-11-22 a duplicate build (run 8917) sat at its plan gate, and the only way to end it was to reject the
   * plan by hand. A stopped run is not resumable; Retry can still pick it up on purpose.
   */
  stop(run: number, opts: { by?: string; reason?: string } = {}): { ok: boolean; run: number; state: "stopping" | "stopped" | "ended"; why?: string } {
    const by = opts.by ?? "you";
    const reason = (opts.reason ?? (by === "you" ? "You stopped this run." : `Stopped by ${by}.`)).slice(0, 500);
    if (this.active.has(run)) {
      if (this.stopping.has(run)) return { ok: true, run, state: "stopping" };
      const gate = this.waitingGate(run);
      this.stopping.set(run, reason);
      this.log.append("factory.run.stop", { run, by, reason, gate, working: !gate });
      const p = this.pending.get(run);
      if (p) { this.pending.delete(run); p.stop?.(new StopRun(reason)); }
      this.aborters.get(run)?.abort();
      return { ok: true, run, state: "stopping" };
    }
    if (this.log.get(run)?.type !== "factory.run.started") return { ok: false, run, state: "ended", why: "No such run." };
    const r = this.resumable(run);
    if (!r.ok) return { ok: false, run, state: "ended", why: r.why };
    const i = this.interrupted.indexOf(run);
    if (i >= 0) this.interrupted.splice(i, 1);
    this.log.append("factory.run.stop", { run, by, reason, gate: null, working: false });
    this.log.append("factory.run.finished", { run, outcome: "stopped", reason, resumable: false, totalUsd: null, by });
    return { ok: true, run, state: "stopped" };
  }

  /**
   * The heartbeat (factory/supervisor.ts): when each run in flight last showed progress, as awake time. Any event of
   * the run counts (a station, a file written, a test result, an agent call ending), and so does every line an agent
   * streams while it works (runbase.ts passes onProgress). The supervisor cuts a run whose heart stopped.
   */
  private beats = new Map<number, AwakeClock>();
  beat(run: number): void { if (this.active.has(run)) (this.beats.get(run) ?? this.beats.set(run, new AwakeClock()).get(run)!).beat(); }
  /** Awake ms since run's last sign of progress, or null when it is not in flight. */
  idleMs(run: number): number | null { if (!this.active.has(run)) return null; return this.beats.get(run)?.idle() ?? 0; }
  /** The runs in flight. */
  activeIds(): number[] { return [...this.active.keys()]; }

  /** Why this run was asked to stop, or null. The run checks it before each step, agent call and gate. */
  stopReason(run: number): string | null { return this.stopping.get(run) ?? null; }

  /** The signal that cuts this run's agent call in flight when it is stopped. */
  signalOf(run: number): AbortSignal {
    let a = this.aborters.get(run);
    if (!a) { a = new AbortController(); this.aborters.set(run, a); }
    return a.signal;
  }

  private ended(run: number) {
    this.active.delete(run);
    this.beats.delete(run);
    this.stopping.delete(run);
    this.aborters.delete(run);
  }
}
