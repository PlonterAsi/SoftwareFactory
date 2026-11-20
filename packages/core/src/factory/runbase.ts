import { engineReview } from "./retro.js";
import { PERSON_KINDS, recallBlock } from "../brain/recall.js";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { describeSecrets, scanFiles } from "../safety/secrets.js";
import { fastGates } from "../safety/gates.js";
import { describeIntegrity, testIntegrity } from "../safety/testguard.js";
import { join } from "node:path";
import type { EventLog } from "../events.js";
import { READ_TOOLS, type AgentRuntime } from "../runtime.js";
import { runAgent } from "../agents.js";
import { kitArgs, type CrewMember } from "./crew.js";
import { flowOfRun } from "../flows/library.js";
import { crewPick, type FlowDef } from "../flows/flow.js";
import { critiquePrompt, validateDocs, type Critique, type ProductDocs } from "./discovery.js";
import { FEATURE_FIT_USD } from "./features.js";
import { type Evaluation } from "./evaluate.js";
import { briefText, type CouncilBrief } from "./council.js";
import type { Slot } from "../bay/agentfile.js";
import { visualCheck } from "./visualize.js";
import { checkUi, uiCase } from "./uicheck.js";
import { appCase, checkAppLive, installKit, isKitFile } from "./appkit.js";
import { checkScreens, screenCase, type ScreenCheck } from "./screencheck.js";
import { linkCase, linkFiles } from "./linkcheck.js";
import { WORKBENCH_COMMANDS, WORKBENCH_TOOLS, changedFiles, hasWorkbench, workbenchContract } from "./workbench.js";
import { commitAll, git, isLockedTest, readTree, runTests, testsHash, type TestRun } from "./workspace.js";
import type { Factory } from "./loop.js";
import { type GateDecision, type GateId, type GateOpts, type Plan, type ReviewResult, type RunSettings, type ScreenRun, type StationId, StopRun, modelFloorUsd, stationName, strongerModel } from "./runkit.js";

/** What every station of a run stands on: its state, asking an agent, the stations' bookkeeping, gates, the suite, and the finish. */
export abstract class RunBase {
  protected spent = 0;
  protected calls = 0;
  protected dir = "";
  protected plan!: Plan;
  protected lockedHash = "";
  /** The commit the tests were locked in, and how many cases the suite showed first (SF-24). Not kept across a resume. */
  protected lockedSha = "";
  protected lockedCases: number | undefined;
  protected fixRounds = 0;
  /** Links a feature session wrote that already opened: each is fetched once during the build. */
  protected linksSeen = new Set<string>();
  protected brief: CouncilBrief | null = null;
  /** The product documents discovery settled on, and the Critic's last word on them. */
  protected docs: ProductDocs | null = null;
  protected docsCritique: Critique | null = null;
  /** A feature run: the plan that shipped, which the next version builds on. */
  protected basePlan: Plan | null = null;
  /** A next version: the product documents the app shipped with, and the idea its first version was built from. */
  protected baseDocs: ProductDocs | null = null;
  protected firstIdea = "";
  /** What the person asked for, as the Critic and the judge read it: for a next version, the first idea and then the ask. */
  protected get asked(): string { return this.baseDocs && this.firstIdea ? `${this.firstIdea}\n\nThe app shipped. For its next version the person now asks: ${this.idea}` : this.idea; }

  constructor(
    protected f: Factory, protected log: EventLog, protected runtime: AgentRuntime,
    protected id: number, protected idea: string,
    protected o: RunSettings,
    protected screen: ScreenRun | null = null,
  ) {}

  protected flowDef: FlowDef | null = null;
  /** The flow this run follows: the copy on its started event (flows/library.ts). */
  protected get flow(): FlowDef { return (this.flowDef ??= flowOfRun(this.log, this.id)); }

  /** A real crew works at the workbench (factory/workbench.ts): it runs the tests itself and fixes until they pass. */
  protected get bench() { return hasWorkbench(this.runtime); }
  protected benchContract(extra?: string) {
    return workbenchContract({ test: "node --test", protect: ["anything under test/ (the locked acceptance tests)", "web/kit/ and server.js (the app kit)"], extra: [
      this.plan?.app ? "After the tests pass, the core also checks the app: it starts server.js, loads index.html and every module it imports, loads src/schema.js and tries create, edit and delete on every entity. Make sure `node -e \"import('./src/schema.js').then(m=>console.log(Object.keys(m)))\"` and `node --check` on every file in web/ and src/ succeed before you finish." : "",
      extra ?? "",
    ].filter(Boolean).join("\n") });
  }

  // ---------- what another kind of run changes (factory/reporun.ts works in an existing codebase) ----------

  /** An agent's system prompt on this run: its own role and, at the workbench, the workbench's contract. */
  protected roleOf(m: CrewMember, bench: boolean): string { return bench ? `${m.role}\n\n${this.benchContract()}` : m.role; }
  /** The shell commands a workbench agent may run in this run's folder. */
  protected benchCommands(): string[] { return WORKBENCH_COMMANDS; }
  /** Extra request fields for a workbench call (a run in a codebase with its own tools puts their folder first on the PATH). */
  protected benchEnv(): { pathFirst?: string[] } { return {}; }
  /** An agent that gets the file-reading tools in this run's folder whatever its own kit says (a codebase must be read to be designed for). */
  protected readsFolder(_m: CrewMember): boolean { return false; }
  /** Files no agent may change in this run's folder: the core puts them back. */
  protected isProtected(p: string): boolean { return isLockedTest(p) || isKitFile(p); }
  /** What the Council, the Designer and the Planner are told besides the idea. Nothing for a new app. */
  protected background(): string { return ""; }
  /** The Designer's first prompt of a discovery. */
  protected designPrompt(): string { return `Idea: ${this.idea}${this.recalled() ? `\n\n${this.recalled()}` : ""}${this.brief ? `\n\n${briefText(this.brief)}` : ""}`; }
  /** The Designer's answer as product documents, checked. */
  protected readDocs(j: unknown): ProductDocs { return validateDocs(j); }
  /** What the Critic is asked about one round's documents. */
  protected critiqueFor(docs: ProductDocs, round: number, before?: Critique): string { return critiquePrompt(this.asked, docs, round, before); }
  /** A fingerprint of every file an agent may change, so the stop rules see a fix that only put an old version back. */
  protected fileHashes(): Record<string, string> {
    return Object.fromEntries(Object.entries(readTree(this.dir)).filter(([p]) => !this.isProtected(p)).map(([p, c]) => [p, createHash("sha256").update(c).digest("hex")]));
  }
  /** More for the run's last event (a run in a codebase says its branch and pull request). */
  protected finishExtra(): Record<string, unknown> { return {}; }

  protected builder: CrewMember | null = null;
  protected startedAt = Date.now();
  protected lastFixFiles: Record<string, string> = {};
  protected lastFixBefore: Record<string, string> = {};

  /** What every fix round so far tried and what came of it (H5): the next round must not repeat a failed approach. */
  protected attempts: { round: number; agent: string; model: string; before: number; after: number; files: string[]; said: string; dispute?: string }[] = [];
  protected lastFixSaid = "";
  protected lastDispute: { file: string; evidence: string } | null = null;
  /** The escalation ladder (H6): a normal fix, then a deeper one on a stronger model, then the locked test is questioned, then you. */
  protected ladder: "normal" | "deeper" | "dispute" | "person" = "normal";
  protected disputed = false;
  protected lastFixModel = "";
  /** Why the Tester kept a questioned test: the Fixer works from it. */
  protected keptReason = "";

  /** One step up in model for a deeper fix, if what is left of the run's budget can pay for it; else none. */
  protected deeperModel(m: CrewMember): string | undefined {
    const cur = this.modelOf(m);
    const up = strongerModel(cur);
    if (up === cur) return undefined;
    return this.o.maxUsd - this.spent >= modelFloorUsd(up) ? up : undefined;
  }

  protected attemptsText(): string {
    if (!this.attempts.length) return "";
    return "What was already tried in this run (do not repeat an approach that did not work):\n" + this.attempts.slice(-6).map((a) =>
      `- Round ${a.round} (${a.agent}, ${a.model}): ${a.files.length ? `changed ${a.files.slice(0, 6).join(", ")}` : "changed nothing"}; failing ${a.before} → ${a.after}.${a.said ? ` It said: ${a.said.replace(/\n/g, " ").slice(0, 300)}` : ""}${a.dispute ? ` It disputed a test: ${a.dispute.slice(0, 200)}` : ""}`).join("\n");
  }

  protected modelOf(m: CrewMember) { return this.o.models[m.id] ?? this.o.models[m.station] ?? m.model; }

  /** The Reviewer reads the green build against the spec. High findings go to the Fixer once; the rest ride to the build gate. */
  protected reviewNotes: ReviewResult | null = null;
  /**
   * The product judge (evaluate.ts): a separate agent reads what every screen of the running app shows and
   * judges it against the product documents. The core decides from its answers. What fails goes to the fix
   * loop as work and is judged once more; what is still open then is shown at the build gate.
   */
  protected evaluation: Evaluation | null = null;
  /** Per screen feature, the designed items its last look did not find. They join the judge's requirements. */
  protected screenOpen = new Map<string, string[]>();
  /** A build-gate send-back the run had not acted on when the app closed; it is carried out before the gate asks again. */
  protected pendingSendBack: string | null = null;
  // ---------- plumbing ----------

  protected async runSuite(round: number): Promise<TestRun> {
    if (testsHash(this.dir) !== this.lockedHash) throw new Error("The locked acceptance tests were changed. Refusing to run.");
    // Fast gates (SF-26): free checks on what the last commit changed, before the slower suite. A failure goes straight to the fixer.
    let changed: string[] = [];
    try { changed = git(this.dir, "diff", "--name-only", "HEAD~1", "HEAD").split("\n").filter(Boolean); } catch { changed = Object.keys(readTree(this.dir)); }
    const gates = await fastGates(this.dir, changed.filter((f) => !isKitFile(f)));
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
      // Every link the app ships, opened for real (run 2623 shipped 14 made-up YouTube links).
      if (process.env.SF_LINK_CHECK !== "off") {
        const where = linkFiles(this.dir, (p) => isLockedTest(p) || isKitFile(p));
        const links = await this.f.checkLinks(Object.keys(where));
        links.dead = links.dead.map((d) => ({ ...d, file: where[d.url] }));
        this.log.append("factory.links", { run: this.id, round, pass: links.pass, checked: links.checked, unknown: links.unknown, dead: links.dead.slice(0, 30), ...(links.skipped ? { skipped: links.skipped } : {}) });
        if (!links.skipped && links.checked) {
          const c = linkCase(links);
          r.cases.push(c);
          if (!c.pass) { r.failed++; r.output = `Links:\n${c.error}\n\n${r.output}`.slice(0, 4000); }
          else r.passed++;
        }
      }
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
  /**
   * The shipped code and tests for a Builder working on top of them. At the workbench they are in its folder:
   * pasting a whole shipped app into the prompt was paid for again on every step of the call, and for an app
   * the size of a product it did not fit at all. Without a workbench the text is all the agent has.
   */
  protected codeForBuilder(): string[] {
    if (this.bench) return ["The shipped code and its locked acceptance tests (test/, read only) are in your folder. Read SPEC.md, PROGRESS.md if there is one, src/schema.js and web/app.js first, then only the files the change touches, in one command."];
    return [`Locked acceptance tests (read only):\n${this.testsText()}`, `Current code:\n${this.codeText()}`];
  }

  protected codeText() {
    // The kit is the same in every app and the agents may not change it: they get its API in their contract, not its source.
    return Object.entries(readTree(this.dir)).filter(([p]) => !isLockedTest(p) && p !== "SPEC.md" && !isKitFile(p) && !p.startsWith("data/"))
      .map(([p, c]) => `<<<FILE ${p}\n${c}FILE>>>`).join("\n");
  }

  protected testsText() {
    return Object.entries(readTree(this.dir)).filter(([p]) => isLockedTest(p)).map(([p, c]) => `<<<FILE ${p}\n${c}FILE>>>`).join("\n");
  }

  protected recallText: string | null = null;
  /** The person's past notes and decisions closest to this idea (SF-22), worked out once per run and logged. */
  protected recalled(): string {
    if (this.recallText === null) {
      // Only the person's own words (notes, tickets). Past plans and Council decisions anchored every new build
      // of an idea to the first, weakest one (Assaf, 2026-11-13: "every next version is based on the first").
      // A version built on a shipped app goes through the feature path, which reads its plan on purpose.
      this.recallText = recallBlock(this.log, this.idea, 5, PERSON_KINDS);
      this.log.append("factory.recall", { run: this.id, count: this.recallText ? this.recallText.split("\n").length - 1 : 0 });
    }
    return this.recallText;
  }

  /** The one agent working a single-seat station right now. */
  protected one(slot: Slot): CrewMember {
    // The agent the run's flow names for this station, else whoever works it in the Bay.
    const m = this.f.crew.crewFor(slot, crewPick(this.flow, slot))[0];
    if (!m) throw new Error(`Nobody works the ${slot} station`);
    return m;
  }

  /** The verifier's verdict on one agent's work: what the Agent Bay's pass rate is made of. */
  protected verdict(m: CrewMember, station: string, pass: boolean, round?: number, note?: string) {
    this.log.append("agent.verdict", { agent: m.id, version: m.version, station, run: this.id, round, pass, note: note?.slice(0, 300) });
  }

  /**
   * A workbench call that may run out of its own budget mid-work (run 2623: the Builder died at its $0.60 cap
   * after 3 minutes with half the app written, and only a person's Retry finished it). When the call hit its
   * cap and left files in the folder, the work goes on by itself: a fresh call reads what is there and finishes
   * it, at most twice, while the run's own budget allows. Anything else fails as before.
   */
  protected async askBench(m: CrewMember, prompt: string, meta: { seat?: number; round?: number } = {}, x: { model?: string; capUsd?: number; raiseCap?: boolean } = {}): Promise<string> {
    try { return await this.ask(m, prompt, meta, x); }
    catch (e) {
      if (!this.bench || !/max_budget/i.test(String((e as Error).message))) throw e;
      let last = e;
      for (let n = 1; n <= 2; n++) {
        const landed = changedFiles(this.dir).filter((p) => !this.isProtected(p));
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
  protected lastSession: string | undefined;
  /** Time this run spent waiting at gates for the person. */
  protected waitedMs = 0;
  protected async ask(m: CrewMember, prompt: string, meta: { seat?: number; round?: number } = {}, x: { model?: string; resume?: string; noTools?: boolean; capUsd?: number; /** The cap may go above the agent's own per-call budget (it stays inside the run's). */ raiseCap?: boolean } = {}): Promise<string> {
    if (this.o.maxUsd - this.spent < 0.01) {
      // Council seats ask at the same time: one question, and the others see the answer.
      await this.gateTurn(async () => {
        if (this.o.maxUsd - this.spent >= 0.01) return;
        if (this.budgetRefused) throw new StopRun("Budget spent.");
        // The project's own budget may allow less than half again, or nothing at all.
        const want = this.o.maxUsd * 0.5;
        const more = this.f.extraBudget(this.id, want);
        if (more < 0.01 && more < want) { this.budgetRefused = true; throw new StopRun(`Budget spent: the run's $${this.o.maxUsd.toFixed(2)} is used and the project's budget has nothing left. Raise the project's total on its page to go on.`); }
        const all = more < want - 0.005;
        const d = await this.gate("escalation", `The run's budget of $${this.o.maxUsd.toFixed(2)} is spent. Add $${more.toFixed(2)} more${all ? " (all the project's budget has left)" : ""}?`, { neverAuto: true, action: `Add $${more.toFixed(2)}`, kind: "budget" }, true);
        if (!d.approve) { this.budgetRefused = true; throw new StopRun("Budget spent."); }
        // Asked again after the approval: another build of the project may have spent in the meantime.
        this.o.maxUsd += this.f.extraBudget(this.id, more);
        this.log.append("factory.budget", { run: this.id, maxUsd: this.o.maxUsd });
      });
    }
    // A hint you gave with Retry reaches the next agent call of that station.
    if (this.hint) prompt += `\n\nThe person retried this step after it failed (${this.hint.error.slice(0, 300)}) and said: ${this.hint.note}`;
    // SF-65: a step retried after it ran out of money gets the bigger cap the Retry said it would.
    const boost = this.capBoost?.station === m.station ? this.capBoost.usd : 0;
    const cap = Math.max(0.01, Math.min(Math.max(x.capUsd ?? m.budgetUsd, boost), x.raiseCap || boost ? Infinity : m.budgetUsd, this.o.maxUsd - this.spent));
    this.lastCall = { station: m.station, capUsd: cap };
    this.calls++;
    // The Builder and Fixer of a real crew work at the workbench: the project folder, file tools and a shell.
    const bench = !x.noTools && this.bench && (m.station === "build" || m.station === "fix") && !!this.dir && existsSync(this.dir);
    // The Reviewer verifies at the workbench too, but read and run only: no Edit or Write.
    const verifier = !x.noTools && this.bench && m.station === "review" && !!this.dir && existsSync(this.dir);
    const kit = kitArgs(m);
    const reads = this.readsFolder(m);
    const r = await runAgent(this.log, this.runtime, m.id, {
      prompt, model: x.model ?? this.modelOf(m), systemPrompt: this.roleOf(m, bench), budgetUsd: Number(cap.toFixed(4)),
      ...kit,
      // An agent that reads files reads this project's folder, once there is one.
      ...(this.dir && existsSync(this.dir) && (reads || m.tools.some((t) => READ_TOOLS.includes(t))) ? { cwd: this.dir, ...(reads ? { tools: [...new Set([...(kit.tools ?? []), ...READ_TOOLS])] } : {}) } : {}),
      ...(bench ? { cwd: this.dir, tools: [...new Set([...WORKBENCH_TOOLS, ...(kit.tools ?? [])])], commands: this.benchCommands(), timeoutMs: 25 * 60_000, noMemory: true, ownKitOnly: true, ...this.benchEnv() } : {}),
      ...(verifier ? { cwd: this.dir, tools: [...new Set([...READ_TOOLS, "Bash", ...(kit.tools ?? []).filter((t) => t !== "Edit" && t !== "Write")])], commands: this.benchCommands(), timeoutMs: 15 * 60_000, noMemory: true, ...this.benchEnv() } : {}),
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
  protected async station<T>(id: StationId, work: () => Promise<T> | T, round?: number): Promise<T> {
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
        if (this.capBoost?.station === id) this.capBoost = null;
        return out;
      } catch (e) {
        if (e instanceof StopRun) throw e;
        const msg = (e as Error).message;
        this.mark(id, "fail", round, msg);
        // The same error again means the retry changed nothing: say so, so a Retry that "does nothing" is visible.
        const same = attempt > 1 && msg === lastError;
        // SF-65: a call that ran out of its own money is never retried with the same cap (run 5669: every
        // Builder call held to $0.15 died at it, and Retry gave it $0.15 again). The Retry doubles the cap
        // of that call, at least a whole feature session, and says what it adds to the run to afford it.
        const starved = /max_budget|spend cap/i.test(msg) && this.lastCall?.station === id;
        const boostUsd = starved ? Number(Math.max(FEATURE_FIT_USD, (this.lastCall?.capUsd ?? 0) * 2).toFixed(2)) : 0;
        const room = this.o.maxUsd - this.spent;
        const addUsd = starved && boostUsd > room ? Number((boostUsd - room + 0.25).toFixed(2)) : 0;
        const q = starved
          ? `${stationName(id)} ran out of money inside one call (its cap was $${(this.lastCall?.capUsd ?? 0).toFixed(2)}). Retry it with $${boostUsd.toFixed(2)} for that call${addUsd ? `, adding $${addUsd.toFixed(2)} to the run` : ""}? What is built stays built.`
          : same
            ? `${stationName(id)} failed again the same way (attempt ${attempt}): ${msg.slice(0, 300)}. Retrying as is will likely fail again; add a hint or check Systems, then retry?`
            : `${stationName(id)} failed${attempt > 1 ? ` again (attempt ${attempt})` : ""}: ${msg.slice(0, 300)}. Retry it?`;
        // An unattended run never repeats a failure that nothing changed, and never adds money by itself.
        const d = await this.gate("escalation", q, {
          action: starved ? `Retry with $${boostUsd.toFixed(2)}` : "Retry", kind: "retry", station: id, attempt, error: msg.slice(0, 2000), same,
          ...(starved ? { retryWith: { capUsd: boostUsd, addUsd } } : {}), ...((same && !starved) || addUsd ? { neverAuto: true } : {}),
        });
        if (!d.approve) throw new StopRun(`${stationName(id)} failed: ${msg}`);
        if (starved) {
          this.capBoost = { station: id, usd: boostUsd };
          if (addUsd) {
            const more = this.f.extraBudget(this.id, addUsd);
            if (more < 0.01) throw new StopRun(`${stationName(id)} needs $${addUsd.toFixed(2)} more and the project's budget has nothing left. Raise the project's total on its page to go on.`);
            this.o.maxUsd += more;
            this.log.append("factory.budget", { run: this.id, maxUsd: this.o.maxUsd });
          }
        }
        this.hint = d.note ? { station: id, note: d.note, error: msg } : null;
        lastError = msg;
        attempt++;
      }
    }
  }

  protected mark(station: StationId, state: "active" | "pass" | "fail" | "incomplete" | "waiting" | "skipped", round?: number, note?: string) {
    this.log.append("factory.station", { run: this.id, station, state, round, note, spentUsd: Number(this.spent.toFixed(6)), maxUsd: this.o.maxUsd });
  }

  protected autoRetriesUsed = 0;
  /** The last agent call: its station and the cap it had (SF-65). */
  protected lastCall: { station: string; capUsd: number } | null = null;
  /** A bigger cap a Retry promised the next calls of a station (SF-65). */
  protected capBoost: { station: string; usd: number } | null = null;
  protected budgetRefused = false;
  protected hint: { station: StationId; note: string; error: string } | null = null;
  protected gateQueue: Promise<unknown> = Promise.resolve();

  /** One question at a time per run: parallel work (Council seats) waits its turn instead of overwriting a waiting gate. */
  protected gateTurn<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.gateQueue.then(fn, fn);
    this.gateQueue = next.catch(() => undefined);
    return next;
  }

  protected gate(gate: GateId, question: string, opts: GateOpts = {}, queued = false): Promise<GateDecision> {
    return queued ? this.askGate(gate, question, opts) : this.gateTurn(() => this.askGate(gate, question, opts));
  }

  protected async askGate(gate: GateId, question: string, opts: GateOpts): Promise<GateDecision> {
    const station: StationId = gate === "escalation" ? "fix" : gate;
    if (gate !== "escalation") this.mark(station, "waiting");
    const { neverAuto: _n, ...info } = opts;
    let auto = this.o.autoApprove && gate !== "escalation";
    if (this.o.autoApprove && gate === "escalation" && !opts.neverAuto && this.autoRetriesUsed < this.o.autoRetries) { this.autoRetriesUsed++; auto = true; }
    // `auto`: nobody is asked, the run approves itself (screens and tickets then say nothing waits for you).
    this.log.append("factory.gate", { run: this.id, gate, state: "waiting", question, ...info, ...(auto ? { auto: true } : {}) });
    // An unattended run never hangs: an escalation it may not retry stops the run.
    const asked = Date.now();
    const d: GateDecision = auto ? { approve: true, by: "auto" }
      : this.o.autoApprove ? { approve: false, by: "auto" }
      : await this.f.awaitGate(this.id, gate);
    // The clock measures the factory's work, not how long the person took to answer.
    this.waitedMs += Date.now() - asked;
    this.log.append("factory.gate", { run: this.id, gate, state: d.approve ? "approved" : "rejected", note: d.note, by: d.by ?? "you", ...(info.kind ? { kind: info.kind, station: info.station, attempt: info.attempt } : {}) });
    if (gate !== "escalation") this.mark(station, d.approve ? "pass" : "fail", undefined, d.note);
    return d;
  }

  protected finish(outcome: "shipped" | "stopped" | "failed", reason: string, sha?: string) {
    // A screen run that does not ship leaves the shipped project exactly as it was.
    if (this.screen && outcome !== "shipped" && this.dir && existsSync(join(this.dir, ".git"))) {
      try { git(this.dir, "reset", "-q", "--hard", this.screen.baseSha); git(this.dir, "clean", "-fdq"); reason += ` The folder is back at ${this.screen.baseSha.slice(0, 7)}, as it shipped.`; } catch { /* leave it; the reason says what happened */ }
    }
    // What this run says about the factory itself, from its own events (free, no agent call).
    try {
      const mine = this.log.list({ sinceId: this.id - 1, limit: 1e6 }).filter((e) => { const x = e.payload as { run?: number; factoryRun?: number }; return e.id === this.id || x.run === this.id || x.factoryRun === this.id; });
      this.log.append("factory.retro", { run: this.id, ...engineReview(mine, { outcome, reason, spentUsd: this.spent, maxUsd: this.o.maxUsd }) });
    } catch { /* a review that cannot be written never stops a run from ending */ }
    this.log.append("factory.run.finished", {
      run: this.id, outcome, reason, dir: this.dir || null, sha: sha ?? null, plan: this.plan?.name ?? null,
      totalUsd: Number(this.spent.toFixed(6)), agentCalls: this.calls, fixRounds: this.fixRounds, ...this.finishExtra(),
    });
  }
}
