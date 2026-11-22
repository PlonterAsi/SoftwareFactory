import { failureLines } from "./trim.js";
import { SAME_TESTS_REASON, runMinutes, stopReason, type RoundRecord } from "./stoprules.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { captureSignal } from "../signals.js";
import { type CrewMember } from "./crew.js";
import { crewPick, roundsOf, stepsToRun, type FlowStep } from "../flows/flow.js";
import { DISCOVERY_BUDGET_SHARE, MAX_DISCOVERY_ROUNDS, PASS_SCORE, critiquePasses, critiqueTotal, docsFiles, docsForPlanner, mergeNextDocs, newRequirements, nextVersionPrompt, withAsk, researchForDesigner, researchPrompt, revisePrompt, validateCritique, validateFindings, type Critique, type Finding, type ProductDocs } from "./discovery.js";
import { FEATURE_LOOP_MIN_USD, buildFit, buildPoolUsd, featurePrompt, featureSessionCap, type BuildFit, featuresFile, featuresOf, nextFeaturesOf, progressEntry, type Feature } from "./features.js";
import { REPAIR_FEATURE_MIN_USD } from "./evaluate.js";
import { MAX_COUNCIL_ROUNDS, briefText, isSmallJob, majority, othersText, parseSeatTake, synthesize, type CouncilBrief, type SeatResult } from "./council.js";
import { checkApp, installKit, isKitFile } from "./appkit.js";
import { dryRunTests, lockedTestFaults } from "./testcheck.js";
import { FIND_LINKS_MAX, FIND_LINKS_USD, findLinksPrompt, linkContext, linkFiles, validateFoundLinks } from "./linkcheck.js";
import { answerSummary, changedFiles, restoreProtected, testDispute, writtenOnDisk } from "./workbench.js";
import { commitAll, git, initRepo, isLockedTest, parseFileBlocks, parseJsonBlock, runTests, syntaxErrors, testsHash, writeFiles, type TestRun } from "./workspace.js";
import { NEXT_VERSION_ROUNDS, type Plan, type RestoredState, StopRun, journeyTestRule, modelFloorUsd, restoreState, shippedDesign, specMarkdown, strongerModel, validatePlan, withDesignedScreens } from "./runkit.js";
import { RunJudge } from "./runjudge.js";


export class Run extends RunJudge {
  /**
   * Carry out the run's flow: each step in its order, by the engine action it names. A step whose milestone
   * the log already shows (a resume) is not done again. The built-in flows carry out exactly the fixed
   * pipeline this replaced: intake, council, design, plan with gate A, tests, build, test and fix, review,
   * the product judge, gate B, ship.
   */
  async go(from?: RestoredState) {
    try {
      if (from) this.restore(from);
      const steps = stepsToRun(this.flow);
      // Nothing here may wait before the first step starts: the step marks itself active at once, before
      // whoever started the run writes its next event (a ticket notes its run right after the start).
      this.beforeFlow();
      const done = from?.done ?? new Set<string>();
      let sha: string | undefined;
      for (const step of steps) {
        if (step.resumeKey && done.has(step.resumeKey)) { const kept = this.keptOnResume(step); if (kept) await kept; continue; }
        const out = await this.doStep(step, from, done);
        if (step.action === "ship") sha = out as string;
      }
      this.shipped(sha!);
    } catch (e) {
      const stopped = e instanceof StopRun;
      this.finish(stopped ? "stopped" : "failed", (e as Error).message);
    }
  }

  /** Before the first step: the next version of a shipped app reads what shipped. */
  protected beforeFlow() {
    if (this.screen?.kind === "feature") {
      const base = restoreState(this.log, this.screen.baseRun);
      this.basePlan = base.plan ?? null;
      if (!this.dir) this.dir = base.dir ?? "";
      const shipped = shippedDesign(this.log, this.screen.baseRun);
      this.baseDocs = shipped.docs;
      this.firstIdea = shipped.idea;
    }
  }

  /** One step of the flow, by its action. */
  protected async doStep(step: FlowStep, from: RestoredState | undefined, done: Set<string>): Promise<unknown> {
    switch (step.action) {
      case "intake": return this.intakeStep();
      case "council": return this.councilLoop();
      case "discover": return this.discoverLoop();
      case "plan": return this.planLoop(done.has("planWritten"));
      case "tests": return this.testsStep();
      case "build": return this.station("build", () => this.build());
      // On a resume the suite runs again first (free): it proves the repo is where the log says.
      case "testFix": return this.testFixLoop("", done.has("reviewed") || (!!from && from.done.has("build")));
      case "review": return this.reviewLoop();
      case "evaluate": return this.evaluateLoop();
      case "accept": return this.acceptLoop();
      case "ship": return this.station("ship", () => this.ship());
      default: throw new Error(`The flow "${this.flow.name}" asks for "${step.action}", which this engine cannot do.`);
    }
  }

  /** A step a resume does not do again: most need nothing. Returns a promise only when it has work to wait for. */
  protected keptOnResume(_step: FlowStep): Promise<void> | void { /* nothing to put back */ }

  protected async intakeStep() { await this.station("intake", async () => { captureSignal(this.log, this.idea, "factory"); }); }
  protected async testsStep() { await this.station("tests", () => this.writeTests()); }

  /** The flow reached its end. */
  protected shipped(sha: string) { this.finish("shipped", `Shipped ${this.plan.name} to ${this.dir}`, sha); }

  /** Put back what the log says this run already had. */
  protected restore(st: RestoredState) {
    this.spent = st.spent;
    this.calls = st.calls;
    this.fixRounds = st.fixRounds;
    this.brief = st.brief;
    this.docs = st.docs;
    this.docsCritique = st.docsCritique;
    this.reviewNotes = st.review;
    this.evaluation = st.evaluation;
    this.pendingSendBack = st.sentBack;
    this.screenOpen = new Map(Object.entries(st.screenOpen ?? {}));
    if (st.plan) { this.plan = st.plan; this.dir = st.dir ?? ""; }
    if (st.lockedHash) {
      this.lockedHash = st.lockedHash;
      if (testsHash(this.dir) !== st.lockedHash) throw new Error("The locked acceptance tests on disk differ from the ones this run locked. Refusing to resume.");
    }
  }

  // ---------- stations ----------

  /** The seats look at the idea; a second round only when no majority wants to build. */
  protected async councilLoop() {
    const size = isSmallJob(this.idea);
    if (this.o.council === "never" || (this.o.council === "auto" && size.small)) {
      this.mark("council", "skipped", undefined, this.o.council === "never" ? "Council turned off for this run" : size.why);
      return;
    }
    const seats: SeatResult[] = [];
    let brief!: CouncilBrief;
    const maxRounds = roundsOf(this.flow, "council", MAX_COUNCIL_ROUNDS);
    for (let round = 1; round <= maxRounds; round++) {
      const crew = this.f.crew.crewFor("council", crewPick(this.flow, "council"));
      const prev = seats.filter((x) => x.round === round - 1);
      brief = await this.station("council", async () => {
        const results = await Promise.all(crew.map(async (m, seat) => {
          const prompt = `Idea: ${this.idea}${this.background() ? `\n\n${this.background()}` : ""}${round === 1 && this.recalled() ? `\n\n${this.recalled()}` : ""}${round > 1 ? `\n\nRound ${round}. The other seats said:\n${othersText(prev, m.id)}\nAnswer again: keep what still holds, change what they convinced you of.` : ""}`;
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
      if (majority(votesOf(seats, round)) === "build" || round === maxRounds) break;
    }
    if (brief.outcome === "drop") {
      const why = brief.concerns.concat(brief.agreed).slice(0, 3).join("; ");
      const d = await this.gate("escalation", `The Council advises against building this${why ? ` (${why})` : ""}. Build it anyway?`, { action: "Build anyway", kind: "council" });
      if (!d.approve) throw new StopRun("The Council advised against building it, and you agreed.");
    }
    this.brief = brief;
    function votesOf(all: SeatResult[], round: number) { return all.filter((s) => s.round === round && s.take).map((s) => s.take!.vote); }
  }

  /**
   * Discovery: the idea becomes product documents in a loop of its own, before any plan (discovery.ts).
   * The Designer writes them, the Critic scores them, the Designer revises; the core decides from the scores.
   * It ends when every score reaches the bar, or after MAX_DISCOVERY_ROUNDS, or when discovery has used its
   * share of the budget; the best-scored documents go on, and their scores are shown at the plan gate.
   */
  protected async discoverLoop() {
    // The next version of a shipped app keeps the design it has: its plan is the base.
    const base = this.screen?.kind === "feature" ? this.baseDocs : null;
    if (this.screen && !base) { this.mark("discover", "skipped", undefined, "The next version of a shipped app keeps its design"); return; }
    // A next version starts from the design the app shipped with. A small one (or the practice crew) keeps it
    // and adds the ask as one more requirement; a product-sized one has the Designer design the ask in.
    if (base && !(this.bench && this.o.maxUsd >= FEATURE_LOOP_MIN_USD)) {
      this.docs = withAsk(base, this.idea);
      this.log.append("factory.discovery", { run: this.id, round: 1, docs: this.docs, critique: null, pass: true, bar: PASS_SCORE, kept: this.screen!.baseRun });
      this.mark("discover", "skipped", undefined, "The shipped design is kept, with what you asked for added to its requirements");
      return;
    }
    const rounds = base ? NEXT_VERSION_ROUNDS : roundsOf(this.flow, "discover", MAX_DISCOVERY_ROUNDS);
    let best: { docs: ProductDocs; critique: Critique | null; round: number } | null = null;
    let last: { docs: ProductDocs; critique: Critique | null } | null = null;
    let why = "";
    let found: Finding[] | null = null;
    for (let round = 1; round <= rounds; round++) {
      const got = await this.station("discover", async () => {
        const designer = this.one("design");
        // Design is worth a real share of the run, but a small run cannot afford much research: say so up front.
        const designCap = Math.min(designer.budgetUsd, this.o.maxUsd * 0.25);
        const searches = round > 1 || base ? 0 : designCap >= 0.3 ? 6 : designCap >= 0.12 ? 2 : 0;
        // Research is a step of its own, not a suggestion: in run 2898 the Designer was offered six searches,
        // answered in one turn without any, and designed a research product from memory.
        if (searches && this.bench && !found) found = await this.research(designer, searches, designCap);
        const prompt = (last?.critique
          ? revisePrompt(this.asked, last.docs, last.critique, round, round === rounds)
          : base ? `${nextVersionPrompt(this.idea, base)}${this.brief ? `\n\n${briefText(this.brief)}` : ""}`
          : this.designPrompt())
          + (found?.length ? `\n\n${researchForDesigner(found)}` : "")
          + `\n\n${found ? "Do not search the web on this call: the research above is what was found." : searches ? `You can afford at most ${searches} web searches on this call.` : "Do not search the web on this call: work from what you know and what is above."}`;
        let docs: ProductDocs;
        try { docs = this.readDocs(parseJsonBlock(await this.ask(designer, prompt, { round }, { capUsd: designCap }))); if (base) docs = mergeNextDocs(base, docs); }
        catch (e) { if (!(e instanceof StopRun)) this.verdict(designer, "design", false, round, (e as Error).message); throw e; }
        // A separate agent judges: an agent asked to grade its own design praises it.
        const critic = this.one("critique");
        let critique: Critique | null = null;
        try { critique = validateCritique(parseJsonBlock(await this.ask(critic, this.critiqueFor(docs, round, last?.critique ?? undefined), { round }, { capUsd: Math.max(0.05, this.o.maxUsd * 0.1) }))); }
        catch (e) { if (e instanceof StopRun) throw e; this.verdict(critic, "critique", false, round, (e as Error).message); }
        const pass = !!critique && critiquePasses(critique);
        if (critique) this.verdict(designer, "design", pass, round, pass ? undefined : critique.problems[0]?.problem);
        this.log.append("factory.discovery", { run: this.id, round, docs, critique, pass, bar: PASS_SCORE });
        return { docs, critique, pass };
      }, round);
      last = got;
      if (!best || (got.critique ? critiqueTotal(got.critique) : 0) >= (best.critique ? critiqueTotal(best.critique) : 0)) best = { ...got, round };
      if (got.pass) break;
      if (!got.critique) { why = "the Critic gave no usable scores"; break; }
      if (round === rounds) { why = `still under the bar after ${round} rounds`; break; }
      if (this.spent >= this.o.maxUsd * DISCOVERY_BUDGET_SHARE) { why = "discovery used its share of the budget"; break; }
    }
    this.docs = best!.docs;
    this.docsCritique = best!.critique;
    if (why) this.log.append("factory.discovery", { run: this.id, round: best!.round, docs: best!.docs, critique: best!.critique, pass: false, bar: PASS_SCORE, settled: why });
  }

  /**
   * The Designer researches before it designs: one call that only searches and reports what it found, each
   * finding with the page it came from. The core counts the sourced findings; with none it asks once more.
   * A research call that fails does not stop the run: the design then says it was not researched.
   */
  protected async research(designer: CrewMember, searches: number, designCap: number): Promise<Finding[]> {
    let findings: Finding[] = [];
    let error = "";
    for (let attempt = 1; attempt <= 2 && !findings.some((f) => f.source); attempt++) {
      try {
        const text = await this.ask(designer, researchPrompt(this.idea, searches, attempt), { round: 1 }, { capUsd: Math.max(0.05, designCap * 0.5) });
        findings = validateFindings(parseJsonBlock(text));
        error = "";
      } catch (e) { if (e instanceof StopRun) throw e; error = (e as Error).message; }
    }
    this.log.append("factory.research", { run: this.id, findings, sourced: findings.filter((f) => f.source).length, searches, ...(error ? { error } : {}) });
    return findings;
  }

  protected async planLoop(written = false) {
    let feedback = "";
    for (;;) {
      // Resumed at the plan gate: the plan is already written, ask again.
      if (written) written = false;
      else await this.station("plan", async () => {
        const onTop = this.basePlan
          ? `This app already shipped. Its approved plan:\n${JSON.stringify(this.basePlan, null, 2)}\n\nThe person now asks to add: ${this.idea}\n\nWrite the plan for its next version in the same JSON shape: keep the same name and slug, and every existing entity, field, view, flow and exported function (they still work and their tests stay locked); add what the ask needs. New fields on existing entities are optional, so records already saved still load. In "acceptance", list ONLY the new criteria: the old ones stay as they are.`
          : `Idea: ${this.idea}`;
        const text = await this.ask(this.one("plan"), `${onTop}${this.recalled() ? `\n\n${this.recalled()}` : ""}${this.brief ? `\n\n${briefText(this.brief)}` : ""}${this.docs ? `\n\n${docsForPlanner(this.docs, this.basePlan && this.baseDocs ? { added: newRequirements(this.baseDocs, this.docs) } : undefined)}` : ""}${feedback ? `\n\nThe person reviewed your last plan and said: ${feedback}\nRevise the plan accordingly.` : ""}`);
        let plan = validatePlan(parseJsonBlock<Plan>(text));
        // Nothing the person asked for may fall out of the plan (run 2623's plan dropped the skill tree, the
        // practice plan, the session log and the genre shapes). A second agent lists what the plan misses; the
        // Planner adds it once before you ever see the plan.
        if (!this.basePlan && !feedback) {
          const missing = await this.planGaps(plan);
          if (missing.length) {
            let added = false;
            try {
              const t2 = await this.ask(this.one("plan"), `Idea: ${this.idea}\n\nYour plan:\n${JSON.stringify(plan, null, 2)}\n\nIt leaves out these things the person asked for:\n${missing.map((x) => `- ${x}`).join("\n")}\n\nReturn the whole plan again in the same JSON shape with each of them added: as acceptance criteria, and as the entities, views and flows they need. Keep everything else.`);
              plan = validatePlan(parseJsonBlock<Plan>(t2));
              added = true;
            } catch (e) { if (e instanceof StopRun) throw e; /* the first plan stands; the gaps are on the record */ }
            finally { this.log.append("factory.plan.gaps", { run: this.id, missing, added }); }
          }
        }
        if (this.docs && !this.basePlan) {
          const fixed = withDesignedScreens(plan, this.docs);
          if (fixed.added.length) { plan = fixed.plan; this.log.append("factory.plan.gaps", { run: this.id, missing: fixed.added.map((n) => `screen: ${n}`), addedByCore: true, ...(fixed.replaced.length ? { replaced: fixed.replaced } : {}) }); }
        }
        if (this.basePlan) { plan.slug = this.basePlan.slug; plan.app = true; }
        this.plan = plan;
        if (!this.basePlan) {
          this.dir = resolve(join(this.f.projectsDir, `${plan.slug}-${this.id}`));
          initRepo(this.dir);
        }
        // The product documents live in the project: every later agent and the person can read them there.
        const spec = writeFiles(this.dir, [{ path: "SPEC.md", content: specMarkdown(this.idea, plan) }, ...(this.docs ? docsFiles(this.asked, this.docs, this.docsCritique) : [])], { lockTests: true });
        const sha = commitAll(this.dir, `Spec and plan: ${plan.name}`);
        this.log.append("factory.plan", { run: this.id, plan, dir: this.dir, sha, written: spec.written });
      });
      // SF-64: the plan is checked against the money before it is approved, and the gate says when it does not fit.
      const fit = this.planFit();
      const d = await this.gate("gateA", fit && !fit.ok
        ? `Approve the spec and plan. Note: it has ${fit.features} features and this run's $${this.o.maxUsd.toFixed(2)} builds about ${fit.fits} of them whole; the rest stay to do and can be added as the next version. All in one run would need about $${fit.needUsd.toFixed(2)}.`
        : "Approve the spec and plan", fit && !fit.ok ? { fit: { ...fit } } : {});
      this.verdict(this.one("plan"), "plan", d.approve, undefined, d.note);
      if (d.approve) return;
      if (!d.note) throw new StopRun("You rejected the plan.");
      feedback = d.note;
    }
  }

  /** SF-64: does the plan fit the run's money? Free; logged once per plan. Null when the run builds in one session. */
  protected planFit(): BuildFit | null {
    if (!this.bench || !this.plan?.app || this.o.maxUsd < FEATURE_LOOP_MIN_USD) return null;
    const n = this.basePlan ? 1 + (this.plan.views ?? []).length : featuresOf(this.plan, this.docs).length;
    const fit = buildFit(n, this.o.maxUsd, this.spent);
    this.log.append("factory.plan.fit", { run: this.id, ...fit, spentUsd: Number(this.spent.toFixed(4)), maxUsd: this.o.maxUsd, mode: "feature-loop" });
    return fit;
  }

  protected async writeTests() {
    // Tests are locked once written, so they must at least parse: one quiet retry with the error before escalating.
    let feedback = "";
    // Run 3609: 8 locked files and 186 passing tests, and the Reviewer then found 9 of 12 acceptance criteria
    // unmet when it used the app ("Add game" failed for three games: their starter items broke the schema).
    // The tests checked the logic the Builder would write, never a person's action through the app's data.
    // So the kit goes in first and the Tester also writes journeys through the kit's own data layer, the
    // same create and update the app's server runs, with the app's real schema and sample records.
    if (this.plan.app) { installKit(this.dir); commitAll(this.dir, "App kit"); }
    const journeys = this.plan.app ? `\n\n${journeyTestRule(this.plan)}` : "";
    let files: ReturnType<typeof parseFileBlocks> = [];
    let tests: typeof files = [];
    let res!: ReturnType<typeof writeFiles>;
    for (let attempt = 1; ; attempt++) {
      const kept = this.basePlan ? this.testsText() : "";
      const text = await this.ask(this.one("tests"), `Approved spec:\n${JSON.stringify(this.plan, null, 2)}${journeys}${kept ? `\n\nThis is the next version of a shipped app. Its locked tests stay as they are (read only):\n${kept}\n\nWrite NEW test files, with new names under test/, for the acceptance criteria above only.` : ""}${feedback}`);
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

  protected async build() {
    // The app kit goes in first, so the Builder writes the model and views on top of it.
    if (this.plan.app) { installKit(this.dir); commitAll(this.dir, "App kit"); }
    this.builder = this.one("build");
    // A real crew with a product-sized budget builds one feature per fresh session (features.ts).
    // The next version of a shipped app is built the same way: what it adds, one feature per session.
    if (this.bench && this.plan.app && (!this.screen || (this.screen.kind === "feature" && this.basePlan)) && this.o.maxUsd >= FEATURE_LOOP_MIN_USD) return this.buildByFeature();
    const text = await this.askBench(this.builder, this.screen?.kind === "feature"
      ? [
        `This app already shipped and its locked acceptance tests pass. Build its next version on top of the existing code: add what the spec adds (new entities, fields, views and logic) and keep everything that works.`,
        `Keep every existing export, entity, view and file working; records the person already saved must still load, so new fields are optional. All locked tests, old and new, must pass. Return only the files you add or change, each in full.`,
        `Spec of the next version:\n${JSON.stringify(this.plan, null, 2)}`,
        ...this.codeForBuilder(),
      ].join("\n\n")
      : this.screen
      ? [
        `This project already shipped and its locked acceptance tests pass, but it is a script, not a program. Turn it into a real app on the app kit (already in the folder), on top of the existing code: write src/schema.js (the entities it works on and keeps, such as its inputs, settings and a history of its results, each with sample records), web/app.js with views that run its logic through forms and draw the results, index.html and web/style.css.`,
        `Keep every existing export, file and command working (the CLI too, if there is one). If the logic the app needs lives in a module that imports node: modules, move the pure part into a browser-safe module under src/ and have the old module import it from there; work that truly needs the disk goes in api.js. The locked tests must still pass. Return only the files you add or change, each in full, and update README.md to say the app opens from the Run tab's Start.`,
        `Spec:\n${JSON.stringify(this.plan, null, 2)}`,
        ...this.codeForBuilder(),
      ].join("\n\n")
      : `Spec:\n${JSON.stringify(this.plan, null, 2)}\n\nLocked acceptance tests:\n${this.testsText()}`);
    const res = this.takeWork(text);
    if (!res.written.length) throw new Error("The Builder returned no files");
    this.log.append("factory.files", { run: this.id, station: "build", round: 1, ...res, ...(this.bench ? { workbench: true } : {}) });
    commitAll(this.dir, `Build: ${this.plan.name}`);
  }

  /**
   * The build loop: the plan as a list of features on disk, one fresh session per feature. After each, the
   * core runs the locked tests (free): a test that passed before and fails now sends the feature back once
   * with that evidence. Then it commits, notes the progress for the next session, and goes on. Whatever is
   * still failing at the end goes to the test and fix loop as before. A retried build picks up at the first
   * feature not built yet.
   */
  protected async buildByFeature(more: Feature[] = [], pool?: number) {
    const builder = this.builder!;
    const path = join(this.dir, "features.json");
    const next = this.screen?.kind === "feature" && this.basePlan ? this.screen : null;
    let features = next ? nextFeaturesOf(this.basePlan!, this.plan, this.docs, this.idea, next.tag) : featuresOf(this.plan, this.docs);
    try {
      // Picked up again after a failed call: what is built stays built.
      const kept = (JSON.parse(readFileSync(path, "utf8")).features ?? []) as { id: string; state: string }[];
      for (const f of features) if (kept.find((k) => k.id === f.id)?.state === "built") f.state = "built";
    } catch { /* first time */ }
    // Work the product judge sent back joins the same list: the first build's features are done and stay done.
    if (more.length) { for (const f of features) f.state = "built"; features = [...features, ...more]; }
    const progress = join(this.dir, "PROGRESS.md");
    if (!existsSync(progress)) writeFileSync(progress, `# Progress\n\nOne entry per feature, written by SoftwareFactory after each build session.\n\n`);
    const buildStart = this.spent;
    let passing = new Set<string>();
    // A next version starts on an app whose tests pass: a shipped test its first feature breaks is caught too.
    if (next && !more.length) { try { passing = new Set((await runTests(this.dir)).cases.filter((c) => c.pass).map((c) => `${c.file}::${c.name}`)); } catch { /* judged from the first feature on */ } }
    let wroteAny = features.some((f) => f.state === "built");
    for (let i = 0; i < features.length; i++) {
      const f = features[i];
      if (f.state === "built") continue;
      // A repair gets at least what that work needs, or it does not start (run 3609: J2 got $0.15, died at
      // its cap three times and used up the run). What is built goes to the build gate as it is.
      if (more.includes(f)) {
        const room = Math.min((pool ?? Infinity) - (this.spent - buildStart), this.o.maxUsd - this.spent - 0.15);
        if (room < REPAIR_FEATURE_MIN_USD) {
          const skipped = features.slice(i).filter((x) => x.state !== "built").map((x) => x.id);
          this.log.append("factory.repair.stopped", { run: this.id, reason: `$${Math.max(0, room).toFixed(2)} left for repairs, under the $${REPAIR_FEATURE_MIN_USD.toFixed(2)} one needs`, skipped, spentUsd: Number(this.spent.toFixed(4)) });
          break;
        }
      }
      let retry = "";
      let wasHollow = false;
      let deadBefore = new Set<string>();
      for (let attempt = 1; attempt <= 2; attempt++) {
        writeFileSync(path, featuresFile(features, f.id));
        const left = features.filter((x) => x.state !== "built").length;
        const cap = featureSessionCap(builder.budgetUsd, this.o.maxUsd, (pool ?? buildPoolUsd(this.o.maxUsd, buildStart)) - (this.spent - buildStart), left);
        this.log.append("factory.feature", { run: this.id, id: f.id, title: f.title, index: i + 1, of: features.length, state: "building", attempt, capUsd: Number(cap.toFixed(3)) });
        const text = await this.askBench(builder, featurePrompt(this.plan, features, f, !!this.docs, retry), { round: i + 1 }, { capUsd: cap, raiseCap: cap > builder.budgetUsd });
        const res = this.takeWork(text);
        const files = res.written.map((w) => w.path).filter((p) => p !== "features.json" && p !== "PROGRESS.md");
        const t = await runTests(this.dir);
        const now = new Set(t.cases.filter((c) => c.pass).map((c) => `${c.file}::${c.name}`));
        const broke = [...passing].filter((k) => !now.has(k));
        f.passed = t.passed; f.total = t.passed + t.failed;
        // A screen is built when it draws, not when the unit tests pass: in run 2898 six sessions reported
        // 82 of 82 tests and the home screen threw in the browser. The session that wrote the screen fixes it.
        let crashed: string[] = [];
        // Run 3185: all eight features reported "built" on a schema the app kit refuses (a field with no valid
        // name), so no screen could be opened at all, and the seed carried made-up video links although the
        // research was there. Both are checked the moment a feature is written, by the session that wrote it.
        // (A schema that imports logic a later feature writes is not a fault yet; the check after the build has it.)
        let invalid: string[] = [];
        let stored: string[] = [];
        let deadLinks: string[] = [];
        if (files.length && !broke.length && this.plan.app && existsSync(join(this.dir, "src/schema.js"))) {
          try { invalid = checkApp(this.dir).problems.filter((x) => /^src\/schema\.js/.test(x) && !/imports .* which does not exist|does not load in Node/.test(x)); } catch { /* the check after the build still runs */ }
          // Run 4004: the plan, added topics and settings the person entered lived in the browser's
          // localStorage, so they never reached the app's data file and every check of the store missed them.
          for (const p of files.filter((x) => /^(web|src)\/.*\.m?js$/.test(x) && !isKitFile(x))) {
            try { if (/\blocalStorage\b|\bsessionStorage\b/.test(readFileSync(join(this.dir, p), "utf8"))) stored.push(p); } catch { /* unreadable: the check after the build has it */ }
          }
          invalid = [...new Set(invalid)].slice(0, 10);
          if (process.env.SF_LINK_CHECK !== "off") {
            const where = linkFiles(this.dir, (x) => isLockedTest(x) || isKitFile(x));
            const mine = Object.keys(where).filter((u) => (files.includes(where[u]) || deadBefore.has(u)) && !this.linksSeen.has(u));
            const links = await this.f.checkLinks(mine).catch(() => null);
            for (const u of mine) this.linksSeen.add(u);
            // Run 4004: the Builder was told twice and still left made-up video links in the seed (it has no
            // web search at its workbench). An agent that can search finds the real pages; what it cannot find,
            // and what is still dead after the Builder's second try, the core empties: an empty link is right.
            let dead = links && !links.skipped ? links.dead.map((d) => d.url) : [];
            for (const u of dead) this.linksSeen.delete(u);
            if (dead.length) dead = await this.settleDeadLinks(f, dead, where, attempt);
            deadLinks = dead.map((u) => `${u} (in ${where[u]})`).slice(0, 20);
            if (attempt === 1) deadBefore = new Set(dead);
          }
        }
        if (files.length && !broke.length && !invalid.length && /^(Screen|Judge): /.test(f.title)) {
          const sc = await this.f.checkScreens(this.dir).catch(() => null);
          if (sc && !sc.skipped) crashed = sc.screens.filter((x) => !x.ok).map((x) => `#/${x.route}: ${x.problem}`);
        }
        // A screen that draws can still be hollow: the judge looks at it now, not only at the end. After a
        // retry for what it missed, it looks once more: in run 3609 all five looked-at screens were hollow on
        // the first look, and "built" on the second try was taken on the Builder's word.
        let hollow: string[] = [];
        if ((attempt === 1 || wasHollow) && files.length && !broke.length && !invalid.length && !crashed.length && this.docs && /^Screen: /.test(f.title)) hollow = await this.lookAtScreen(f, attempt);
        if (attempt === 1) wasHollow = hollow.length > 0;
        f.state = !files.length ? "empty" : broke.length ? "regressed" : crashed.length || invalid.length || stored.length || deadLinks.length || hollow.length ? "broken" : "built";
        if (files.length) { wroteAny = true; this.log.append("factory.files", { run: this.id, station: "build", round: i + 1, ...res, workbench: true }); }
        this.log.append("factory.feature", { run: this.id, id: f.id, title: f.title, index: i + 1, of: features.length, state: f.state, attempt, files: files.slice(0, 40), passed: t.passed, failed: t.failed, ...(broke.length ? { broke: broke.slice(0, 10) } : {}), ...(crashed.length ? { crashed: crashed.slice(0, 10) } : {}), ...(invalid.length ? { invalid } : {}), ...(stored.length ? { stored } : {}), ...(deadLinks.length ? { deadLinks } : {}), ...(hollow.length ? { hollow } : {}) });
        if (f.state === "broken" && attempt === 1) {
          const sources = [...new Set((this.docs?.research ?? []).map((r) => r.source).filter((u): u is string => !!u))].slice(0, 12);
          retry = [
            invalid.length ? `The app kit refuses the schema you left, so the app cannot start:\n${invalid.join("\n")}\n\nFix src/schema.js: every field needs a lowerCamelCase "name" (letters and digits only, like "bandOverride"), a known type, and options for a choice.` : "",
            stored.length ? `These files keep data in the browser's localStorage or sessionStorage: ${stored.join(", ")}.\n\nEverything the person enters or changes (plans, settings, added items) is a record in the app's store: add the entity or field to src/schema.js and read and write it through the store the views get, never through the browser's storage.` : "",
            deadLinks.length ? `The core opened every link you wrote and these do not exist:\n${deadLinks.join("\n")}\n\n${sources.length ? `Addresses the research found, which do exist:\n${sources.join("\n")}\n\n` : ""}Never write a link from memory. Use only addresses listed in docs/product/BRIEF.md (the research), copied exactly. Where the research has no page for it, leave the link empty: an empty link is right, a made-up one is a defect.` : "",
            hollow.length ? `A product judge opened the running app after your call and did not find these on the screen you built:\n${hollow.map((h) => `- ${h}`).join("\n")}\n\nMake each one real on that screen: shown with sample records from the seed, and every action a control that changes the data through the store.` : "",
            crashed.length ? `The core opened the app in a real browser after your call, and these screens did not draw:\n${crashed.slice(0, 10).join("\n").slice(0, 1500)}\n\nFix the cause in the page code (a value read before it exists, a wrong import, a missing record) and make sure every screen draws with the sample records and with none.` : "",
          ].filter(Boolean).join("\n\n");
          continue;
        }
        if (f.state === "regressed" && attempt === 1) {
          retry = `These tests passed before your call and fail after it:\n${broke.slice(0, 10).map((k) => `- ${k.replace("::", ": ")}`).join("\n")}\n\n${t.output.slice(0, 1500)}`;
          continue;
        }
        // Whatever happened, the next feature is judged against where the tests stand now.
        passing = now;
        writeFileSync(progress, readFileSync(progress, "utf8") + progressEntry(f, text, files));
        writeFileSync(path, featuresFile(features));
        commitAll(this.dir, `Feature ${f.id}: ${f.title}${f.state === "built" ? "" : ` (${f.state})`}`);
        break;
      }
    }
    if (!wroteAny && !more.length) throw new Error("The Builder returned no files");
  }

  /**
   * Links the core opened and found dead, in files a feature just wrote. An agent with web search is asked
   * once for the real page of each; the core opens what it answers and puts the ones that exist in place.
   * When the search answered, or this is the Builder's second try, the rest are emptied. Returns the links
   * still dead in the files (only when nobody could search on the first try: the Builder then gets one more).
   */
  protected async settleDeadLinks(f: Feature, dead: string[], where: Record<string, string>, attempt: number): Promise<string[]> {
    const read = (file: string) => { try { return readFileSync(join(this.dir, file), "utf8"); } catch { return ""; } };
    let found: Record<string, string> | null = null;
    if (attempt === 1 && this.bench && this.o.maxUsd - this.spent >= FIND_LINKS_USD * 2) {
      const asked = dead.slice(0, FIND_LINKS_MAX).map((url) => ({ url, file: where[url] ?? "", context: linkContext(read(where[url] ?? ""), url) }));
      try {
        const got = validateFoundLinks(parseJsonBlock(await this.ask(this.one("design"), findLinksPrompt(this.plan.name, asked), { round: 0 }, { capUsd: FIND_LINKS_USD })), asked.map((a) => a.url));
        const reals = [...new Set(Object.values(got))];
        // Nothing is taken on the finder's word either: an address it returns is opened like any other.
        const check = reals.length ? await this.f.checkLinks(reals).catch(() => null) : null;
        const bad = new Set((check?.dead ?? []).map((d) => d.url));
        found = !reals.length ? {} : !check || check.skipped ? null : Object.fromEntries(Object.entries(got).filter(([, real]) => !bad.has(real)));
        this.log.append("factory.links.search", { run: this.id, feature: f.id, asked: asked.length, answered: Object.keys(got).length, real: found ? Object.keys(found).length : 0 });
      } catch (e) { if (e instanceof StopRun) throw e; this.log.append("factory.links.search", { run: this.id, feature: f.id, asked: asked.length, answered: 0, real: 0, error: String((e as Error).message).slice(0, 200) }); }
    }
    if (!found && attempt === 1) return dead;
    const replaced: { dead: string; real: string; file: string }[] = [];
    const blanked: string[] = [];
    // The longest first: one address may be the start of another.
    for (const url of [...dead].sort((a, b) => b.length - a.length)) {
      const file = where[url];
      if (!file) continue;
      const real = found?.[url] ?? "";
      try {
        const before = readFileSync(join(this.dir, file), "utf8");
        const after = before.split(url).join(real);
        if (after === before) continue;
        writeFileSync(join(this.dir, file), after);
        if (real) { replaced.push({ dead: url, real, file }); this.linksSeen.add(real); } else blanked.push(`${url} (in ${file})`);
      } catch { /* left for the link check after the build */ }
    }
    if (replaced.length) this.log.append("factory.links.found", { run: this.id, feature: f.id, links: replaced });
    if (blanked.length) this.log.append("factory.links.blanked", { run: this.id, feature: f.id, links: blanked });
    const done = new Set([...replaced.map((r) => r.dead), ...blanked.map((b) => b.split(" (in ")[0])]);
    return dead.filter((u) => !done.has(u));
  }

  /** What the Fixer is told about the product and where things are. */
  protected fixBrief(): { spec: string; where: string } {
    return { spec: `Spec:\n${JSON.stringify(this.plan, null, 2)}`, where: this.bench ? "The project is the current folder: SPEC.md, the locked tests in test/, the code. Read what you need." : `Locked tests (read only):\n${this.testsText()}` };
  }
  /**
   * What an agent left after its call: with the workbench, the files it changed on disk (anything locked put
   * back first); always, any whole files it answered as text blocks (the practice crew, or an agent whose
   * tools failed). The result has the shape of writeFiles, for the heat map.
   */
  protected takeWork(text: string): ReturnType<typeof writeFiles> {
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

  protected async testFixLoop(extraFeedback = "", rerun = false) {
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
      const stop = stopReason({ rounds: history, startedAt: this.startedAt + this.waitedMs + this.suiteMs, now: Date.now(), maxMinutes: runMinutes(this.o.maxUsd, this.f.maxRunMinutes) });
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

  protected async fix(run: TestRun, round: number, note: string): Promise<CrewMember> {
    const failures = run.cases.filter((c) => !c.pass).map((c) => `- ${c.name} (${c.file}): ${(c.error ?? "failed").slice(0, 1200)}`).join("\n");
    const deeper = this.ladder === "deeper";
    const fixer = this.one("fix");
    // A stronger model only with the money it needs to work: opus with $0.18 left died in 6 s, twice (run 2366).
    const model = deeper ? this.deeperModel(fixer) : undefined;
    const up = strongerModel(this.modelOf(fixer));
    if (deeper && !model && up !== this.modelOf(fixer)) this.log.append("factory.ladder", { run: this.id, from: "deeper", to: "deeper", reason: `kept ${this.modelOf(fixer)}: $${(this.o.maxUsd - this.spent).toFixed(2)} left is below what ${up} needs ($${modelFloorUsd(up).toFixed(2)})`, round });
    this.lastFixModel = model ?? this.modelOf(fixer);
    const brief = this.fixBrief();
    const prompt = [
      brief.spec,
      // Only the lines that say what failed and where (SF-16), at most 100.
      failures ? `Failing tests (the core's own run):\n${failures}\n\nTest output (failure lines):\n${failureLines(run.output, 100, 2500) || "(none: run the failing file with node yourself to see the raw error)"}` : "All tests pass.",
      note ? `The reviewer of the build asked for: ${note}` : "",
      this.attemptsText(),
      this.keptReason ? `A locked test was questioned and the Tester kept it: ${this.keptReason}` : "",
      deeper ? "The fixes so far did not move the failures. Step back before you edit: write down two or three different explanations of the root cause, check each one by running code (not by reading only), then fix the one the evidence supports. If the evidence says a locked test itself is wrong, say so with the TEST_WRONG line instead of working around it." : "",
      // At the workbench the agent reads what it needs; without it, it gets the whole project as text.
      brief.where,
      this.bench ? "" : `Current code:\n${this.codeText()}`,
    ].filter(Boolean).join("\n\n");
    // What each file held before this round, so the stop rules (SF-25) see a revert to the build's version.
    const beforeAll = this.fileHashes();
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

  protected async ship(): Promise<string> {
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
}
