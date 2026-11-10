import { join, resolve } from "node:path";
import type { EventLog } from "../events.js";
import type { AgentRuntime } from "../runtime.js";
import { runAgent } from "../agents.js";
import { captureSignal } from "../signals.js";
import { CREW, type CrewMember } from "./crew.js";
import { visualCheck } from "./visualize.js";
import {
  commitAll, git, initRepo, isLockedTest, parseFileBlocks, parseJsonBlock, readTree, runTests, syntaxErrors, testsHash, writeFiles, type TestRun,
} from "./workspace.js";

/**
 * The thin factory loop (milestone 2): one idea becomes a tested git repo.
 *
 *   intake → plan → [gate A: approve plan] → tests (locked) → build → test ⇄ fix → [gate B: accept build] → ship
 *
 * Each station is a loop with a goal, a worker, a verifier, exit criteria and
 * a budget; its sixth field, its visual, is enforced by visualCheck before the
 * station may pass. All state is written to the event log; the Bridge draws
 * from it.
 */
export type StationId = "intake" | "plan" | "gateA" | "tests" | "build" | "test" | "fix" | "gateB" | "ship";
export type GateId = "gateA" | "gateB" | "escalation";

export interface Plan {
  name: string;
  slug: string;
  summary: string;
  interface: string;
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
  /** Override a crew member's model, for example { builder: "haiku" }. */
  models?: Partial<Record<CrewMember["id"], string>>;
}

export interface GateDecision { approve: boolean; note?: string; by?: string }

export class StopRun extends Error {}

interface Pending { gate: GateId; resolve: (d: GateDecision) => void }

export class Factory {
  private pending = new Map<number, Pending>();
  private active = new Map<number, Promise<void>>();

  constructor(private log: EventLog, private runtime: AgentRuntime, readonly projectsDir: string) {
    // Runs that were mid-flight when the core stopped cannot resume yet; close them honestly.
    const finished = new Set(log.list({ type: "factory.run.finished", limit: 1e6 }).map((e) => (e.payload as { run: number }).run));
    for (const e of log.list({ type: "factory.run.started", limit: 1e6 })) {
      if (!finished.has(e.id)) log.append("factory.run.finished", { run: e.id, outcome: "stopped", reason: "The core restarted while this run was in flight.", totalUsd: null });
    }
  }

  /** Start a run in the background; returns its id at once. */
  start(idea: string, opts: RunOptions = {}): number {
    const text = idea.trim();
    if (!text) throw new Error("An idea needs some text");
    const o = { maxUsd: opts.maxUsd ?? 1.5, maxFixRounds: opts.maxFixRounds ?? 5, autoApprove: !!opts.autoApprove, autoRetries: opts.autoRetries ?? 1, models: opts.models ?? {} };
    const ev = this.log.append("factory.run.started", { idea: text, maxUsd: o.maxUsd, maxFixRounds: o.maxFixRounds, autoApprove: o.autoApprove, runtime: this.runtime.name });
    const done = new Run(this, this.log, this.runtime, ev.id, text, o).go().finally(() => this.active.delete(ev.id));
    this.active.set(ev.id, done);
    return ev.id;
  }

  /** Wait for a run to finish (tests and the CLI). */
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
  private fixRounds = 0;

  constructor(
    private f: Factory, private log: EventLog, private runtime: AgentRuntime,
    private id: number, private idea: string,
    private o: Required<Omit<RunOptions, "models">> & { models: RunOptions["models"] },
  ) {}

  async go() {
    try {
      await this.station("intake", async () => {
        captureSignal(this.log, this.idea, "factory");
      });
      await this.planLoop();
      await this.station("tests", () => this.writeTests());
      await this.station("build", () => this.build());
      await this.testFixLoop();
      await this.acceptLoop();
      const sha = await this.station("ship", () => this.ship());
      this.finish("shipped", `Shipped ${this.plan.name} to ${this.dir}`, sha);
    } catch (e) {
      const stopped = e instanceof StopRun;
      this.finish(stopped ? "stopped" : "failed", (e as Error).message);
    }
  }

  // ---------- stations ----------

  private async planLoop() {
    let feedback = "";
    for (;;) {
      await this.station("plan", async () => {
        const text = await this.ask(CREW.planner, `Idea: ${this.idea}${feedback ? `\n\nThe person reviewed your last plan and said: ${feedback}\nRevise the plan accordingly.` : ""}`);
        const plan = validatePlan(parseJsonBlock<Plan>(text));
        this.plan = plan;
        this.dir = resolve(join(this.f.projectsDir, `${plan.slug}-${this.id}`));
        initRepo(this.dir);
        writeFiles(this.dir, [{ path: "SPEC.md", content: specMarkdown(this.idea, plan) }], { lockTests: true });
        const sha = commitAll(this.dir, `Spec and plan: ${plan.name}`);
        this.log.append("factory.plan", { run: this.id, plan, dir: this.dir, sha });
      });
      const d = await this.gate("gateA", "Approve the spec and plan");
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
      const text = await this.ask(CREW.tester, `Approved spec:\n${JSON.stringify(this.plan, null, 2)}${feedback}`);
      files = parseFileBlocks(text);
      tests = files.filter((f) => isLockedTest(f.path) && f.path.endsWith(".js"));
      if (!tests.length) throw new Error("The Tester returned no test/*.js files");
      res = writeFiles(this.dir, tests, { lockTests: false });
      const broken = syntaxErrors(this.dir, res.written.map((w) => w.path));
      if (!broken.length) break;
      git(this.dir, "clean", "-fdq", "test");
      if (attempt >= 2) throw new Error(`The Tester's tests do not parse: ${broken.join("; ")}`);
      feedback = `\n\nYour previous tests did not parse, so they were discarded:\n${broken.join("\n")}\nWrite them again, each file complete and valid.`;
    }
    for (const f of files.filter((x) => !tests.includes(x))) res.refused.push({ path: f.path, reason: "the Tester may only write test/*.js" });
    this.log.append("factory.files", { run: this.id, station: "tests", round: 1, ...res });
    const sha = commitAll(this.dir, "Acceptance tests (locked)");
    this.lockedHash = testsHash(this.dir);
    this.log.append("factory.tests.locked", { run: this.id, hash: this.lockedHash, files: res.written.map((w) => w.path), sha });
  }

  private async build() {
    const text = await this.ask(CREW.builder, `Spec:\n${JSON.stringify(this.plan, null, 2)}\n\nLocked acceptance tests:\n${this.testsText()}`);
    const files = parseFileBlocks(text);
    if (!files.length) throw new Error("The Builder returned no files");
    const res = writeFiles(this.dir, files, { lockTests: true });
    this.log.append("factory.files", { run: this.id, station: "build", round: 1, ...res });
    commitAll(this.dir, `Build: ${this.plan.name}`);
  }

  private async testFixLoop(extraFeedback = "") {
    let run = await this.station("test", () => this.runSuite(0));
    let lastFailing = "";
    let budget = this.o.maxFixRounds;
    let feedback = extraFeedback;
    while (run.failed > 0 || feedback) {
      const failing = run.cases.filter((c) => !c.pass).map((c) => c.name).sort().join("\n");
      let reason = "";
      if (budget <= 0) reason = `Tests still fail after ${this.o.maxFixRounds} fix rounds.`;
      else if (failing && failing === lastFailing) reason = "The same tests failed twice in a row after a fix.";
      if (reason) {
        const d = await this.gate("escalation", `${reason} Grant 2 more fix rounds?`);
        if (!d.approve) throw new StopRun(reason);
        budget = 2;
        lastFailing = "";
        feedback = d.note ?? feedback;
      }
      lastFailing = failing;
      budget--;
      this.fixRounds++;
      const round = this.fixRounds;
      const note = feedback;
      feedback = "";
      run = await this.station("fix", async () => {
        await this.fix(run, round, note);
        return this.runSuite(round);
      }, round);
      // The Test station shows the latest verdict, not only the first run's.
      if (run.failed === 0) this.mark("test", "pass", round, `green after fix round ${round}`);
    }
  }

  private async fix(run: TestRun, round: number, note: string) {
    const failures = run.cases.filter((c) => !c.pass).map((c) => `- ${c.name} (${c.file}): ${c.error ?? "failed"}`).join("\n");
    const src = Object.entries(readTree(this.dir)).filter(([p]) => !isLockedTest(p) && p !== "SPEC.md")
      .map(([p, c]) => `<<<FILE ${p}\n${c}FILE>>>`).join("\n");
    const prompt = [
      `Spec:\n${JSON.stringify(this.plan, null, 2)}`,
      failures ? `Failing tests:\n${failures}\n\nTest output (tail):\n${run.output.slice(-1500)}` : "All tests pass.",
      note ? `The person reviewing the build asked for: ${note}` : "",
      `Locked tests (read only):\n${this.testsText()}`,
      `Current code:\n${src}`,
    ].filter(Boolean).join("\n\n");
    const files = parseFileBlocks(await this.ask(CREW.fixer, prompt));
    const res = writeFiles(this.dir, files, { lockTests: true });
    if (!res.written.length) {
      this.log.append("factory.files", { run: this.id, station: "fix", round, ...res });
      throw new Error(res.refused.length ? "The Fixer only tried to change the locked tests." : "The Fixer changed nothing.");
    }
    this.log.append("factory.files", { run: this.id, station: "fix", round, ...res });
    commitAll(this.dir, `Fix round ${round}`);
  }

  private async acceptLoop() {
    for (;;) {
      const d = await this.gate("gateB", "Accept the build");
      if (d.approve) return;
      if (!d.note) throw new StopRun("You rejected the build.");
      await this.testFixLoop(d.note);
    }
  }

  private async ship(): Promise<string> {
    commitAll(this.dir, "Ship");
    git(this.dir, "tag", "-f", "v0.1.0");
    return git(this.dir, "rev-parse", "--short", "HEAD");
  }

  // ---------- plumbing ----------

  private async runSuite(round: number): Promise<TestRun> {
    if (testsHash(this.dir) !== this.lockedHash) throw new Error("The locked acceptance tests were changed. Refusing to run.");
    const r = await runTests(this.dir);
    this.log.append("factory.tests", { run: this.id, round, cases: r.cases, passed: r.passed, failed: r.failed, timedOut: r.timedOut });
    return r;
  }

  private testsText() {
    return Object.entries(readTree(this.dir)).filter(([p]) => isLockedTest(p)).map(([p, c]) => `<<<FILE ${p}\n${c}FILE>>>`).join("\n");
  }

  /** One agent call, inside both its own cap and what is left of the run's cap. */
  private async ask(m: CrewMember, prompt: string): Promise<string> {
    const left = this.o.maxUsd - this.spent;
    if (left < 0.01) {
      const d = await this.gate("escalation", `The run's budget of $${this.o.maxUsd.toFixed(2)} is spent. Add 50% more?`, { neverAuto: true });
      if (!d.approve) throw new StopRun("Budget spent.");
      this.o.maxUsd *= 1.5;
      this.log.append("factory.budget", { run: this.id, maxUsd: this.o.maxUsd });
    }
    const cap = Math.max(0.01, Math.min(m.budgetUsd, this.o.maxUsd - this.spent));
    this.calls++;
    const r = await runAgent(this.log, this.runtime, m.id, {
      prompt, model: this.o.models?.[m.id] ?? m.model, systemPrompt: m.role, budgetUsd: Number(cap.toFixed(4)),
    }, { factoryRun: this.id, station: m.station });
    this.spent += r.result?.costUsd ?? 0;
    if (r.error || !r.result) throw new Error(`${m.name} failed: ${r.error}`);
    return r.result.text;
  }

  /** Run one station: mark it active, do the work, require its visuals, mark it passed. Failures escalate once. */
  private async station<T>(id: StationId, work: () => Promise<T> | T, round?: number): Promise<T> {
    for (;;) {
      this.mark(id, "active", round);
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
        return out;
      } catch (e) {
        if (e instanceof StopRun) throw e;
        const msg = (e as Error).message;
        this.mark(id, "fail", round, msg);
        const d = await this.gate("escalation", `${stationName(id)} failed: ${msg.slice(0, 300)}. Retry it?`);
        if (!d.approve) throw new StopRun(`${stationName(id)} failed: ${msg}`);
      }
    }
  }

  private mark(station: StationId, state: "active" | "pass" | "fail" | "incomplete" | "waiting", round?: number, note?: string) {
    this.log.append("factory.station", { run: this.id, station, state, round, note, spentUsd: Number(this.spent.toFixed(6)), maxUsd: this.o.maxUsd });
  }

  private autoRetriesUsed = 0;

  private async gate(gate: GateId, question: string, opts: { neverAuto?: boolean } = {}): Promise<GateDecision> {
    const station: StationId = gate === "escalation" ? "fix" : gate;
    if (gate !== "escalation") this.mark(station, "waiting");
    this.log.append("factory.gate", { run: this.id, gate, state: "waiting", question });
    let auto = this.o.autoApprove && gate !== "escalation";
    if (this.o.autoApprove && gate === "escalation" && !opts.neverAuto && this.autoRetriesUsed < this.o.autoRetries) { this.autoRetriesUsed++; auto = true; }
    // An unattended run never hangs: an escalation it may not retry stops the run.
    const d: GateDecision = auto ? { approve: true, by: "auto" }
      : this.o.autoApprove ? { approve: false, by: "auto" }
      : await this.f.awaitGate(this.id, gate);
    this.log.append("factory.gate", { run: this.id, gate, state: d.approve ? "approved" : "rejected", note: d.note, by: d.by ?? "you" });
    if (gate !== "escalation") this.mark(station, d.approve ? "pass" : "fail", undefined, d.note);
    return d;
  }

  private finish(outcome: "shipped" | "stopped" | "failed", reason: string, sha?: string) {
    this.log.append("factory.run.finished", {
      run: this.id, outcome, reason, dir: this.dir || null, sha: sha ?? null, plan: this.plan?.name ?? null,
      totalUsd: Number(this.spent.toFixed(6)), agentCalls: this.calls, fixRounds: this.fixRounds,
    });
  }
}

function stationName(id: StationId) {
  return ({ intake: "Intake", plan: "Plan", gateA: "Plan gate", tests: "Acceptance tests", build: "Build", test: "Test", fix: "Fix", gateB: "Build gate", ship: "Ship" } as const)[id];
}

export function validatePlan(p: Plan): Plan {
  if (!p || typeof p !== "object") throw new Error("The plan is not an object");
  for (const k of ["name", "slug", "summary", "interface"] as const) if (typeof p[k] !== "string" || !p[k].trim()) throw new Error(`The plan is missing "${k}"`);
  if (!Array.isArray(p.acceptance) || !p.acceptance.length) throw new Error("The plan has no acceptance criteria");
  if (!Array.isArray(p.tasks) || !p.tasks.length) throw new Error("The plan has no tasks");
  const slug = p.slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
  const ids = new Set(p.tasks.map((t) => String(t.id)));
  return {
    ...p, slug, files: Array.isArray(p.files) ? p.files.map(String) : [],
    tasks: p.tasks.map((t) => ({ id: String(t.id), title: String(t.title ?? t.id), dependsOn: (Array.isArray(t.dependsOn) ? t.dependsOn : []).map(String).filter((d) => ids.has(d)) })),
  };
}

export function specMarkdown(idea: string, p: Plan): string {
  return [
    `# ${p.name}`, "", `> ${idea}`, "", p.summary, "",
    "## Interface", "", p.interface, "",
    "## Acceptance criteria", "", ...p.acceptance.map((a, i) => `${i + 1}. ${a}`), "",
    "## Tasks", "", ...p.tasks.map((t) => `- **${t.id}** ${t.title}${t.dependsOn.length ? ` (after ${t.dependsOn.join(", ")})` : ""}`), "",
    "Built by SoftwareFactory. The tests in `test/` were written from this spec before the code and were locked.", "",
  ].join("\n");
}
