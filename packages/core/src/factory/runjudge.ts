import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { noteLesson } from "../bay/memory.js";
import { crewPick, roundsOf } from "../flows/flow.js";
import { mustRequirements, newRequirements, type ProductDocs } from "./discovery.js";
import { FEATURE_LOOP_MIN_USD, type Feature } from "./features.js";
import { SCREEN_LOOK_USD, screenLookDocs, screenLookPrompt, MAX_EVALUATION_ROUNDS, PRODUCT_PASS_SCORE, evaluationFeedback, repairFeatures, REPAIR_BUDGET_SHARE, REPAIR_FEATURE_USD, REPAIR_FEATURE_MIN_USD, withScreenItems, evaluationPasses, evaluationPrompt, validateEvaluation, type Evaluation } from "./evaluate.js";
import { isKitFile } from "./appkit.js";
import { lockedTestFaults } from "./testcheck.js";
import { answerSummary, changedFiles, restoreFromHead } from "./workbench.js";
import { commitAll, git, isLockedTest, parseFileBlocks, parseJsonBlock, readTree, syntaxErrors, testsHash, writeFiles, type TestRun } from "./workspace.js";
import { type Plan, type ReviewResult, StopRun, VERIFY_CONTRACT, mergeRecheck, parseReview, reviewCapUsd, reviewRepair } from "./runkit.js";
import { RunBase } from "./runbase.js";

/** The judging half of a run: review, the screen looks, the product evaluation, the build gate and its send-backs. */
export abstract class RunJudge extends RunBase {
  /** The building half, in Run (run.ts): a judge's findings go back through it. */
  protected abstract testFixLoop(extraFeedback?: string, rerun?: boolean): Promise<unknown>;
  protected abstract buildByFeature(more?: Feature[], pool?: number): Promise<unknown>;

  /** What the Reviewer reads, and how it is told to verify when it has the workbench. */
  protected reviewBrief(): { prompt: string; verify: string } {
    const src = Object.entries(readTree(this.dir)).filter(([p]) => !isLockedTest(p) && p !== "SPEC.md" && !isKitFile(p) && !p.startsWith("data/")).map(([p, c]) => `<<<FILE ${p}\n${c.length > 12000 ? c.slice(0, 12000) + "\n...(cut: file continues)\n" : c}FILE>>>`).join("\n");
    return { prompt: `Spec:\n${JSON.stringify(this.plan, null, 2)}\n\nCode (the locked tests pass):\n${src.slice(0, 48000)}`, verify: VERIFY_CONTRACT };
  }
  /** What the build gate asks. */
  protected acceptWord(): string { return "Accept the build"; }
  /**
   * The locked test is questioned (ladder step 3): the Tester sees the dispute and the evidence and either
   * corrects the test file (the suite is locked again, on the record) or keeps it. At most once per run.
   */
  protected async disputeTests(run: TestRun): Promise<boolean> {
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

  /** What the person asked for that the plan leaves out, as short phrases; [] when it covers everything or the check fails. */
  protected async planGaps(plan: Plan): Promise<string[]> {
    const reqs = this.docs ? mustRequirements(this.docs) : [];
    if (!reqs.length && this.idea.trim().split(/[.!?\n]+/).filter((x) => x.trim().length > 12).length < 3) return [];
    try {
      // With product documents the Critic checks the plan against them (it already judged them); without, the Tester does.
      const text = await this.ask(this.docs ? this.one("critique") : this.one("tests"), [
        "This time you check a plan against what the person asked for. Do not score anything and do not write tests or files.",
        `What the person asked for:\n${this.idea}`,
        ...(reqs.length ? [`The product requirements the plan must implement:\n${reqs.map((x) => `- ${x}`).join("\n")}`] : []),
        ...(this.docs ? [`The screens it must have: ${this.docs.screens.map((s) => `${s.id} (${s.name})`).join(", ")}`] : []),
        `The plan:\n${JSON.stringify(plan, null, 2)}`,
        "List every distinct requirement in what the person asked for (a feature, screen, kind of data, behaviour or example they named), and every product requirement and screen above when given. For each, decide whether the plan covers it in its acceptance criteria, entities, views or flows.",
        'Answer only JSON: {"missing": ["short phrase for each requirement the plan does not cover"]}. An empty list when it covers everything.',
      ].join("\n\n"));
      const j = parseJsonBlock<{ missing?: unknown }>(text);
      return Array.isArray(j?.missing) ? j.missing.map((x) => String(x).trim()).filter(Boolean).slice(0, 15) : [];
    } catch (e) { if (e instanceof StopRun) throw e; return []; }
  }

  protected async reviewLoop() {
    if (!this.o.review) { this.mark("review", "skipped", undefined, "review turned off for this run"); return; }
    for (let round = 1; round <= 2; round++) {
      const r = await this.station("review", async () => {
        const m = this.one("review");
        const rb = this.reviewBrief();
        const verify = this.bench ? `\n\n${rb.verify}\nThe acceptance criteria:\n${this.plan.acceptance.map((a, i) => `${i + 1}. ${a}`).join("\n")}` : "";
        const reviewPrompt = rb.prompt;
        // Run 3185: verifying 12 criteria of a $10 product at the workbench ran past the Reviewer's fixed $0.20 and
        // the run stopped with no verdict. The cap grows with the run, and a Reviewer that still runs out gives its
        // verdict from reading the code instead of leaving the person a Retry that would die the same way.
        let text: string;
        try { text = await this.ask(m, reviewPrompt + verify, { round }, this.bench ? { capUsd: reviewCapUsd(m.budgetUsd, this.o.maxUsd), raiseCap: true } : {}); }
        catch (e) {
          if (!this.bench || !/max_budget/i.test(String((e as Error).message)) || this.o.maxUsd - this.spent < 0.05) throw e;
          this.log.append("factory.continued", { run: this.id, station: "review", agent: m.id, round, attempt: 1, files: [], reason: "the Reviewer ran out of its budget while running the criteria; it reviews by reading instead" });
          try { restoreFromHead(this.dir, changedFiles(this.dir)); } catch { /* nothing to put back */ }
          text = await this.ask(m, `${reviewPrompt}\n\nYour first call ran out of its budget while running the acceptance criteria one by one. This time do not run anything: review by reading the code above, and in "criteria" mark each acceptance criterion you could not confirm by reading as not verified.\nThe acceptance criteria:\n${this.plan.acceptance.map((a, i) => `${i + 1}. ${a}`).join("\n")}`, { round }, { noTools: true });
        }
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
      if (r.verdict === "pass") return;
      if (round === 2) {
        // Run 3185: the second review still said "fix" with 5 criteria failing, and the run went on as if it had
        // passed. What is still open is recorded, shown on the review station, and handed to the repair loop.
        const failing = (r.criteria ?? []).filter((c) => !c.pass);
        const open = r.findings.filter((f) => f.severity === "high" && !/^Acceptance criterion not met/.test(f.text));
        this.log.append("factory.review.open", { run: this.id, round, failing: failing.map((c) => c.text).slice(0, 20), findings: open.map((f) => f.text).slice(0, 20) });
        this.mark("review", "pass", round, `still "fix" after ${round} reviews: ${failing.length} criteria failing, ${open.length} serious findings, handed to the repair loop`);
        return;
      }
      // The serious findings become lessons of the agent that built it (bay/memory.ts), for its next work in any project.
      const builder = this.f.crew.crewFor("build", crewPick(this.flow, "build"))[0];
      if (builder) for (const f of r.findings.filter((x) => x.severity === "high" && !/^Acceptance criterion not met/.test(x.text)).slice(0, 2)) noteLesson(this.log, builder.id, `A reviewer sent back my build for: ${f.text.slice(0, 240)}`, "review", `run:${this.id}`);
      const high = r.findings.filter((f) => f.severity === "high").map((f) => `- ${f.text}`).join("\n");
      await this.testFixLoop(`The Reviewer found these problems; fix them without breaking the tests:\n${high}`, true);
    }
  }

  /** The product documents as the judge reads them: the design, plus what the screens still lacked when built. */
  protected judgeDocs(): ProductDocs | null {
    if (!this.docs) return null;
    // A next version is judged on what it adds: the rest was judged when it shipped, and its tests are locked.
    const docs = this.baseDocs ? { ...this.docs, requirements: newRequirements(this.baseDocs, this.docs) } : this.docs;
    return withScreenItems(docs, [...this.screenOpen.values()].flat());
  }
  /** The judge's look at one screen just built: what of its design a person would not find. [] when it all shows or the look cannot run. */
  protected async lookAtScreen(f: Feature, attempt = 1): Promise<string[]> {
    const id = f.what.match(/^The view "([^"]+)"/)?.[1];
    const docs = id && this.docs ? screenLookDocs(this.docs, id, f.title.replace(/^Screen: /, "")) : null;
    if (id && !docs) this.log.append("factory.screen.look", { run: this.id, feature: f.id, screen: id, attempt, skipped: "no designed screen matches this view" });
    if (!docs || this.o.maxUsd - this.spent < SCREEN_LOOK_USD * 2) return [];
    const shots = await this.f.readScreens(this.dir).catch(() => null);
    if (!shots?.length) return [];
    const mine = shots.filter((s) => s.route === id || s.route.startsWith(`${id}/`));
    try {
      const e = validateEvaluation(parseJsonBlock(await this.ask(this.one("evaluate"), screenLookPrompt(this.asked, docs, mine.length ? mine : shots), { round: 0 }, { capUsd: SCREEN_LOOK_USD })), docs);
      const req = (rid: string) => docs.requirements.find((r) => r.id === rid)?.text ?? rid;
      const unmet = e.requirements.filter((r) => !r.met);
      const out = unmet.map((r) => `${req(r.id)} (the judge saw: ${r.evidence})`);
      const open = unmet.map((r) => req(r.id)).slice(0, 12);
      if (open.length) this.screenOpen.set(f.id, open); else this.screenOpen.delete(f.id);
      this.log.append("factory.screen.look", { run: this.id, feature: f.id, screen: id, attempt, seen: e.requirements.length - out.length, of: e.requirements.length, missing: out.slice(0, 20), open });
      return out.slice(0, 12);
    } catch (e) { if (e instanceof StopRun) throw e; return []; }
  }

  protected async evaluateLoop() {
    const skip = (why: string) => { this.mark("evaluate", "skipped", undefined, why); };
    if (!this.docs || !this.plan.app || (this.screen && !this.baseDocs)) return skip("No product design to judge this build against");
    if (!this.judgeDocs()!.requirements.some((r) => r.must)) return skip("This version adds no requirement of its own to judge");
    const looks = roundsOf(this.flow, "evaluate", MAX_EVALUATION_ROUNDS);
    for (let round = 1; round <= looks; round++) {
      const screens = await this.f.readScreens(this.dir).catch(() => null);
      if (!screens?.length) {
        this.log.append("factory.evaluation", { run: this.id, round, pass: false, skipped: "the app's screens could not be read in a browser on this computer" });
        return skip("The app's screens could not be read in a browser here, so the product was not judged");
      }
      const docs = this.judgeDocs()!;
      const ev = await this.station("evaluate", async () => {
        const judge = this.one("evaluate");
        let e: Evaluation;
        try { e = validateEvaluation(parseJsonBlock(await this.ask(judge, evaluationPrompt(this.asked, docs, screens, round), { round }, { capUsd: Math.max(0.1, this.o.maxUsd * 0.08) })), docs); }
        catch (err) { if (!(err instanceof StopRun)) this.verdict(judge, "evaluate", false, round, (err as Error).message); throw err; }
        const pass = evaluationPasses(e);
        this.verdict(judge, "evaluate", true, round);
        if (this.builder) this.verdict(this.builder, "product", pass, round, pass ? undefined : e.requirements.find((r) => !r.met)?.evidence ?? e.problems[0]?.problem);
        this.log.append("factory.evaluation", { run: this.id, round, pass, bar: PRODUCT_PASS_SCORE, screens: screens.length, ...e });
        return { e, pass };
      }, round);
      this.evaluation = ev.e;
      // What the Reviewer proved still broken (by running it) is repaired even when the judge passes: the
      // judge only sees screens (run 4004 went to the build gate with 3 criteria the Reviewer saw fail).
      const left = round === 1 && this.reviewNotes?.verdict === "fix" ? reviewRepair(this.reviewNotes) : null;
      if ((ev.pass && !left) || round === looks) return;
      // Not worth starting a fix it cannot finish: the person sees what is open at the build gate.
      if (this.o.maxUsd - this.spent < 0.3) return;
      // What the judge found goes back to the build loop as features, each in a fresh session (run 2898: one
      // fix round was handed 25 unmet requirements at once). A small run keeps the single fix round.
      const pool = Math.min(this.o.maxUsd * REPAIR_BUDGET_SHARE, this.o.maxUsd - this.spent - 0.4);
      const most = Math.floor(pool / REPAIR_FEATURE_USD);
      // Run 3185 was resumed after the build (the app restarted), so the Builder was never picked in this
      // process and the judge's findings silently skipped the repair features. Pick it here when needed.
      this.builder ??= this.one("build");
      const canRepair = this.bench && this.o.maxUsd >= FEATURE_LOOP_MIN_USD && existsSync(join(this.dir, "features.json"));
      const work: Feature[] = canRepair && !ev.pass ? repairFeatures(ev.e, docs, most) : [];
      // The Reviewer's failures go first.
      if (left && canRepair) { work.unshift(left); if (work.length > Math.max(1, most)) work.pop(); }
      if (!work.length && ev.pass) return;
      if (work.length) {
        this.log.append("factory.repair", { run: this.id, round, features: work.map((f) => ({ id: f.id, title: f.title })), poolUsd: Number(pool.toFixed(2)) });
        // Repairs are extra work on a product that is already built: one that cannot finish never fails the
        // run (run 3609 spent its last $0.42 on three dead calls of one repair and ended "failed" with
        // nothing at the build gate). Its half-written files go back to the last built feature.
        try { await this.buildByFeature(work, pool); }
        catch (e) {
          if (e instanceof StopRun) throw e;
          try { git(this.dir, "checkout", "--", "."); git(this.dir, "clean", "-fdq", "src", "web"); } catch { /* the gate shows the folder as it is */ }
          this.log.append("factory.repair.stopped", { run: this.id, round, reason: `a repair call failed: ${String((e as Error).message).slice(0, 200)}`, spentUsd: Number(this.spent.toFixed(4)) });
        }
        if (this.o.maxUsd - this.spent < 0.3) return;
        await this.testFixLoop("", true);
        if (left && work.includes(left)) await this.recheckReview();
      } else await this.testFixLoop(evaluationFeedback(ev.e, docs), true);
      // The judge's second look needs money too; without it the person decides on the first look.
      if (this.o.maxUsd - this.spent < 0.15) return;
    }
  }

  protected async acceptLoop() {
    if (this.pendingSendBack) {
      const note = this.pendingSendBack;
      this.pendingSendBack = null;
      this.log.append("factory.sentback.resumed", { run: this.id, note: note.slice(0, 300) });
      await this.sendBack(note);
    }
    for (;;) {
      const unmet = this.reviewNotes?.criteria?.filter((c) => !c.pass).length ?? 0;
      const open = this.evaluation ? this.evaluation.requirements.filter((r) => !r.met).length : 0;
      const judged = this.evaluation && !evaluationPasses(this.evaluation) ? ` (the product judge: ${open ? `${open} of ${this.evaluation.requirements.length} requirements not seen working` : "scores under the bar"}; read the Judge tab first)` : "";
      const notes = judged ? judged : unmet ? ` (${unmet} acceptance criteri${unmet > 1 ? "a" : "on"} not seen working; read the review first)`
        : this.reviewNotes?.findings.length ? ` (the Reviewer left ${this.reviewNotes.findings.length} note${this.reviewNotes.findings.length > 1 ? "s" : ""})` : "";
      const d = await this.gate("gateB", `${this.acceptWord()}${notes}`);
      if (d.approve) return;
      if (!d.note) throw new StopRun("You rejected the build.");
      await this.sendBack(d.note);
    }
  }

  /**
   * The person sent the build back with a note. Run 4004's note was "Need to address the issues found on
   * this loop": it points at what the judge and the Reviewer found, so those go with it. With a real crew and
   * a product budget the work is built as features in fresh sessions (the note first), then judged again.
   */
  protected async sendBack(note: string) {
    const docs = this.judgeDocs();
    const open = this.evaluation && docs && !evaluationPasses(this.evaluation) ? this.evaluation : null;
    const features = join(this.dir, "features.json");
    const pool = Math.min(this.o.maxUsd * REPAIR_BUDGET_SHARE, this.o.maxUsd - this.spent - 0.4);
    if (this.bench && docs && this.plan.app && existsSync(features) && this.o.maxUsd >= FEATURE_LOOP_MIN_USD && pool >= REPAIR_FEATURE_MIN_USD) {
      const most = Math.max(1, Math.floor(pool / REPAIR_FEATURE_USD));
      const round = 1 + this.log.list({ type: "factory.repair", limit: 1e6 }).filter((e) => (e.payload as { run: number }).run === this.id).length;
      const tag = `G${round}`;
      const asked: Feature = { id: `${tag}P`, title: "Person: what you asked for at the build gate", state: "todo",
        what: [`The person looked at the running app at the build gate and sent it back with this note:\n${note}`, open ? "The note refers to what the product judge found; that is listed in the next features. Start with whatever the note itself names." : ""].filter(Boolean).join("\n\n"),
        done: "What the person's note asks for can be seen and used in the running app, and every test still passes." };
      const review = this.reviewNotes?.verdict === "fix" ? reviewRepair(this.reviewNotes) : null;
      const work = [asked, ...(review ? [review] : []), ...(open ? repairFeatures(open, docs, most) : [])].slice(0, most + 1)
        .map((f, i) => (i === 0 ? f : { ...f, id: `${tag}${f.id}` }));
      this.builder ??= this.one("build");
      this.log.append("factory.repair", { run: this.id, round, from: "gateB", note: note.slice(0, 300), features: work.map((f) => ({ id: f.id, title: f.title })), poolUsd: Number(pool.toFixed(2)) });
      try { await this.buildByFeature(work, pool); }
      catch (e) {
        if (e instanceof StopRun) throw e;
        try { git(this.dir, "checkout", "--", "."); git(this.dir, "clean", "-fdq", "src", "web"); } catch { /* the gate shows the folder as it is */ }
        this.log.append("factory.repair.stopped", { run: this.id, round, reason: `a repair call failed: ${String((e as Error).message).slice(0, 200)}`, spentUsd: Number(this.spent.toFixed(4)) });
      }
      if (this.o.maxUsd - this.spent >= 0.3) await this.testFixLoop("", true);
      if (review) await this.recheckReview();
      if (this.o.maxUsd - this.spent >= 0.3) await this.judgeOnce();
      return;
    }
    await this.testFixLoop(open && docs ? `${note}\n\nWhat the product judge still found open when the person sent the build back:\n${evaluationFeedback(open, docs)}` : note, true);
  }

  /**
   * After a repair of what the Reviewer saw fail, it runs those criteria again, and only those, so the build
   * gate says what is true now. Without this the gate kept the old count however well the repair went.
   */
  protected async recheckReview() {
    const r = this.reviewNotes;
    const failing = (r?.criteria ?? []).filter((c) => !c.pass);
    if (!r || r.verdict !== "fix" || !failing.length || !this.bench) return;
    const m = this.one("review");
    const cap = Math.min(reviewCapUsd(m.budgetUsd, this.o.maxUsd) / 2, this.o.maxUsd - this.spent - 0.2);
    if (cap < 0.1) return;
    const round = 1 + this.log.list({ type: "factory.review", limit: 1e6 }).filter((e) => (e.payload as { run: number }).run === this.id).length;
    try {
      const text = await this.ask(m, `Spec:\n${JSON.stringify({ name: this.plan.name, interface: this.plan.interface }, null, 2)}\n\n${this.reviewBrief().verify}\n\nThese acceptance criteria failed when you ran them on an earlier review, and the code was repaired since. Read only the code they touch, run ONLY these criteria again, and answer with your JSON: "findings" empty unless one of these still fails, and one "criteria" entry per criterion below, in this order.\n${failing.map((c, i) => `${i + 1}. ${c.text}`).join("\n")}`, { round }, { capUsd: cap, raiseCap: true });
      try { restoreFromHead(this.dir, changedFiles(this.dir)); } catch { /* nothing to put back */ }
      const again = mergeRecheck(r, parseReview(text));
      this.verdict(m, "review", true, round);
      this.log.append("factory.review", { run: this.id, round, agent: m.id, recheck: true, ...again });
      this.reviewNotes = again;
    } catch (e) {
      if (e instanceof StopRun) throw e;
      try { restoreFromHead(this.dir, changedFiles(this.dir)); } catch { /* nothing to put back */ }
      this.log.append("factory.continued", { run: this.id, station: "review", agent: m.id, round, attempt: 1, files: [], reason: `the Reviewer's second run of the failing criteria gave no answer (${String((e as Error).message).slice(0, 120)}); the build gate shows its last full review` });
    }
  }

  /** One more look by the product judge, so the build gate shows where the product stands now. */
  protected async judgeOnce() {
    const docs = this.judgeDocs();
    if (!docs || !this.plan.app) return;
    const screens = await this.f.readScreens(this.dir).catch(() => null);
    if (!screens?.length) return;
    const round = 1 + this.log.list({ type: "factory.evaluation", limit: 1e6 }).filter((e) => (e.payload as { run: number }).run === this.id).length;
    const judge = this.one("evaluate");
    try {
      const e = validateEvaluation(parseJsonBlock(await this.ask(judge, evaluationPrompt(this.asked, docs, screens, round), { round }, { capUsd: Math.max(0.1, this.o.maxUsd * 0.08) })), docs);
      const pass = evaluationPasses(e);
      this.verdict(judge, "evaluate", true, round);
      this.log.append("factory.evaluation", { run: this.id, round, pass, bar: PRODUCT_PASS_SCORE, screens: screens.length, ...e });
      this.evaluation = e;
    } catch (err) { if (err instanceof StopRun) throw err; this.verdict(judge, "evaluate", false, round, (err as Error).message); }
  }
}
