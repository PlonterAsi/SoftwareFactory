import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentBay, EventLog, Factory, MockRuntime, Tickets, createProject, git, type AgentRequest, type AgentRuntime, type TestRun } from "../src/index.js";
import { REPO_ENGINE_MIN_USD, enableRepoRuns, failedBefore, repoBranch, validateRepoPlan, type BranchToShip, type RepoTools } from "../src/factory/reporun.js";
import { parseCases, prepareEnv, readPages, runRepoTests, siteProfile, withSite, type RepoEnv } from "../src/factory/repoenv.js";
import { intakeDoor, routeWork } from "../src/factory/route.js";
import { withPathFirst } from "../src/runtime.js";

const tmp = (p = "sf-rr-") => mkdtempSync(join(tmpdir(), p));
const events = (log: EventLog, type: string) => log.list({ limit: 1e6 }).filter((e) => e.type === type).map((e) => e.payload as any);
const station = (req: AgentRequest) => req.systemPrompt?.match(/Station contract: (\w+)/)?.[1] ?? "";
const block = (j: unknown) => "```json\n" + JSON.stringify(j) + "\n```";

/** A small site somebody else wrote: one page, a test that passes and one that was already broken. */
function legacyRepo() {
  const src = tmp("sf-rr-src-");
  git(src, "init", "-q", "-b", "main");
  mkdirSync(join(src, "tests"));
  writeFileSync(join(src, "app.py"), "def home():\n    return 'Plonter'\n");
  writeFileSync(join(src, "tests", "test_app.py"), "def test_home():\n    assert True\n\ndef test_old():\n    assert False\n");
  writeFileSync(join(src, "CLAUDE.md"), "Keep templates in templates/.\n");
  git(src, "add", "-A"); git(src, "commit", "-q", "-m", "first");
  return src;
}

const ENV: RepoEnv = { stack: ["python"], tests: [{ label: "pytest", file: "python", args: ["-m", "pytest"], kind: "pytest" }], pathFirst: ["/venv/bin"], commands: ["pytest", "flask"], notes: [], testHint: "python -m pytest" };

/** The repo's "tests", read from what is in the clone: test_old always fails, a file named BREAK breaks test_home, a contact test appears once it is written. */
const suite = async (dir: string): Promise<TestRun> => {
  const cases = [
    { name: "test_home", file: "tests/test_app.py", pass: !existsSync(join(dir, "BREAK")), durationMs: 1 },
    { name: "test_old", file: "tests/test_app.py", pass: false, durationMs: 1, error: "assert False" },
    ...(existsSync(join(dir, "tests", "test_contact.py")) ? [{ name: "test_contact", file: "tests/test_contact.py", pass: true, durationMs: 1 }] : []),
  ];
  const failed = cases.filter((c) => !c.pass).length;
  return { cases, passed: cases.length - failed, failed, exitCode: failed ? 1 : 0, timedOut: false, output: cases.filter((c) => !c.pass).map((c) => `FAILED ${c.file}::${c.name}`).join("\n") };
};

const PLAN = {
  name: "Contact page", summary: "Visitors can send a message from a new Contact page.", approach: "A new view in app.py and a template next to the others.",
  features: [
    { id: "F1", title: "The contact view", what: "Add contact() to app.py.", files: ["app.py", "tests/test_contact.py"], done: "The view answers." },
    { id: "F2", title: "The contact template", what: "Add templates/contact.html.", files: ["templates/contact.html"], done: "The page shows a form." },
  ],
  acceptance: ["The Contact page shows a form.", "What worked before still works."], tests: "tests/test_contact.py", risks: ["The home page must stay as it is."],
};

/**
 * Plays a Claude Code crew in a clone: the Designer, Critic and judge answer like the practice crew, the
 * Planner returns a plan of two features, the Builder edits files with its tools (and breaks a test on its
 * first go at F2), and the Reviewer passes with the criteria it "ran".
 */
function crew(o: { sloppy?: boolean; stubborn?: boolean; plan?: typeof PLAN; answer?: string; buildUsd?: number; empty?: number } = {}) {
  const mock = new MockRuntime();
  const seen: { station: string; req: AgentRequest }[] = [];
  let f2 = 0;
  let empties = 0;
  const rt: AgentRuntime = { name: "claude-code:fake", run: async (req) => {
    const st = station(req);
    seen.push({ station: st, req });
    const r = await mock.run(req);
    r.costUsd = 0.01;
    if (st === "plan") r.text = block(o.plan ?? PLAN);
    else if (st === "research" && o.answer) r.text = o.answer;
    else if (st === "review") r.text = block({ verdict: "pass", findings: [], criteria: PLAN.acceptance.map((text) => ({ text, pass: true, evidence: "ran pytest" })) });
    else if (st === "repo" && o.empty && empties < o.empty) {
      empties++;
      r.text = "BLOCKED: **There is no references/ folder** at the top of the repo, so I changed no file.";
    } else if (st === "repo") {
      const put = (p: string, c: string) => { mkdirSync(dirname(join(req.cwd!, p)), { recursive: true }); writeFileSync(join(req.cwd!, p), c); };
      if (/Your work, F1/.test(req.prompt)) { put("app.py", "def home():\n    return 'Plonter'\n\ndef contact():\n    return 'Contact'\n"); put("tests/test_contact.py", "def test_contact():\n    assert True\n"); }
      else if (/Your work, F2/.test(req.prompt)) {
        put("templates/contact.html", "<form><input name=email><button>Send</button></form>\n");
        if ((o.sloppy && ++f2 === 1) || o.stubborn) put("BREAK", "x");
        else rmSync(join(req.cwd!, "BREAK"), { force: true });
        // An agent that writes into SoftwareFactory's own folder: it must never reach the branch.
        put(".sf/NOTES-FROM-AGENT.md", "should stay out of git\n");
      } else put("docs/softwarefactory/whole-change.md", "The whole change.\n");
      r.text = "Built it.\nNext: nothing to know.";
      if (o.buildUsd) r.costUsd = o.buildUsd;
    }
    return r;
  } };
  return { rt, seen };
}

function world(o: { sloppy?: boolean; stubborn?: boolean; empty?: number; answer?: string; buildUsd?: number; plan?: typeof PLAN; ship?: RepoTools["ship"]; site?: RepoTools["readSite"]; runTests?: RepoTools["runTests"] } = {}) {
  const log = new EventLog();
  const { rt, seen } = crew(o);
  const bay = new AgentBay(log, rt);
  const src = legacyRepo();
  const project = createProject(log, { name: "Landing page" });
  log.append("project.linked", { projectId: project, kind: "repo", ref: src });
  const factory = new Factory(log, rt, join(tmp("sf-rr-data-"), "projects"), bay);
  const shipped: BranchToShip[] = [];
  const tools: Partial<RepoTools> = {
    prepareEnv: () => ENV,
    runTests: o.runTests ?? ((dir) => suite(dir)),
    readSite: o.site ?? (async () => ({ screens: [{ route: "/contact", text: "Contact us. Email. Send.", controls: ["input email", "button Send"] }] })),
    ship: o.ship ?? (async (b) => { shipped.push(b); return { pr: { number: 7, url: "https://github.com/acme/landing/pull/7", repo: "acme/landing" } }; }),
  };
  const repoRuns = enableRepoRuns(factory, log, tools);
  const tickets = new Tickets(log, { runtime: rt, bay, factory, workRoot: tmp("sf-rr-work-"), repoRuns });
  return { log, rt, seen, bay, src, project, factory, repoRuns, tickets, shipped };
}

describe("intake: which route work in a repo takes", () => {
  it("sends fixes and small asks to one session, features to the engine, and says why", () => {
    expect(routeWork({ kind: "bug", text: "The login button does nothing" })).toMatchObject({ route: "light" });
    expect(routeWork({ kind: "task", size: "M", text: "Rename the footer link" }).route).toBe("light");
    expect(routeWork({ kind: "bug", size: "L", text: "x" })).toMatchObject({ route: "engine" });
    expect(routeWork({ kind: "request", size: "S", text: "x" }).route).toBe("light");
    expect(routeWork({ kind: "request", size: "M", text: "x" }).route).toBe("engine");
    expect(routeWork({ kind: "request", text: "Fix the typo in the footer" }).route).toBe("light");
    const big = routeWork({ kind: "request", text: "Add a contact page with a form that sends an email, and a thank you page, and a link to it in the menu" });
    expect(big.route).toBe("engine");
    expect(big.why).toMatch(/feature-sized/);
  });

  it("says the kind the way a person does: an idea, an epic", () => {
    const long = "Add a contact page with a form that sends an email, and a thank you page, and a link to it in the menu";
    expect(routeWork({ kind: "idea", text: long }).why).toMatch(/^an idea of /);
    expect(routeWork({ kind: "plan", text: long }).why).toMatch(/^an epic of /);
    expect(routeWork({ kind: "idea", size: "M", text: "x" }).why).toMatch(/^an idea sized M/);
    expect(routeWork({ kind: "request", text: long }).why).toMatch(/^a request of /);
  });

  it("the person's choice wins, and a limit under what an engine run needs keeps it light", () => {
    expect(routeWork({ kind: "bug", text: "x", asked: "engine" })).toEqual({ route: "engine", why: "you chose this route", chosen: true });
    expect(routeWork({ kind: "request", size: "L", text: "x", asked: "light" }).route).toBe("light");
    const capped = routeWork({ kind: "request", size: "L", text: "x", maxUsd: 0.6, engineMinUsd: REPO_ENGINE_MIN_USD });
    expect(capped.route).toBe("light");
    expect(capped.why).toMatch(/\$0\.60 is under the \$1\.50/);
  });
});

describe("the pieces a repo run stands on", () => {
  it("reads a plan of features, and a plan in the app shape too", () => {
    const p = validateRepoPlan(PLAN);
    expect(p.repo).toBe(true);
    expect(p.app).toBe(false);
    expect(p.features!.map((f) => f.id)).toEqual(["F1", "F2"]);
    expect(p.files).toEqual(["app.py", "tests/test_contact.py", "templates/contact.html"]);
    expect(p.tasks[1].dependsOn).toEqual(["F1"]);
    const old = validateRepoPlan({ name: "X", summary: "Y", tasks: [{ id: "T1", title: "Do it" }], acceptance: ["works"] });
    expect(old.features).toHaveLength(1);
    expect(() => validateRepoPlan({ name: "X", summary: "Y", features: [], acceptance: ["a"] })).toThrow(/no features/);
  });

  it("names the branch after the ticket, or the run", () => {
    expect(repoBranch(12, "Add a Contact page!", { key: "LP-3" })).toBe("sf/LP-3-add-a-contact-page");
    expect(repoBranch("k3x9a", "Add a Contact page!")).toBe("sf/run-k3x9a-add-a-contact-page");
  });

  it("reads test results of pytest and unittest", () => {
    const py = parseCases("PASSED tests/test_app.py::test_home\nFAILED tests/test_app.py::test_old - assert False\n", "pytest");
    expect(py.map((c) => [c.file, c.name, c.pass])).toEqual([["tests/test_app.py", "test_home", true], ["tests/test_app.py", "test_old", false]]);
    const un = parseCases("test_home (tests.test_app.AppTest) ... ok\ntest_old (tests.test_app.AppTest) ... FAIL\n", "unittest");
    expect(un.map((c) => c.pass)).toEqual([true, false]);
    // Python 3.11 and later repeat the test's name inside the brackets: the file part stays the class.
    expect(parseCases("test_home (tests.test_app.AppTest.test_home) ... ok\n", "unittest")[0]).toMatchObject({ name: "test_home", file: "tests.test_app.AppTest", pass: true });
  });

  it("puts the repo's own Python first on the agent's PATH, under the name the platform uses", () => {
    expect(withPathFirst({ PATH: "/usr/bin" }, ["/venv/bin"], "linux").PATH).toBe("/venv/bin:/usr/bin");
    const win = withPathFirst({ Path: "C:\\Windows" }, ["C:\\venv\\Scripts"], "win32");
    expect(win.Path).toBe("C:\\venv\\Scripts;C:\\Windows");
    expect(win.PATH).toBeUndefined();
  });
});

describe("the engine in an imported repo", () => {
  it("designs, plans, builds feature by feature on a branch of a clone, and hands the branch over as a pull request", async () => {
    const w = world({ sloppy: true });
    const head = git(w.src, "rev-parse", "HEAD");
    const { run, branch } = w.repoRuns.start(w.project, "Add a contact page with a form that sends a message", { maxUsd: 4, autoApprove: true, council: "never" });
    await w.factory.wait(run);
    const fin = events(w.log, "factory.run.finished").at(-1);
    expect(fin.reason).toMatch(/draft pull request #7/);
    expect(fin.outcome).toBe("shipped");
    expect(events(w.log, "factory.run.started").at(-1)).toMatchObject({ kind: "repo", projectId: w.project, repo: { source: w.src, name: "Landing page", branch } });

    // Every station of the engine ran, with the repo's own contracts and the map of the codebase.
    const stations = w.seen.map((s) => s.station);
    for (const s of ["design", "critique", "plan", "repo", "review", "evaluate"]) expect(stations).toContain(s);
    const design = w.seen.find((s) => s.station === "design")!.req;
    expect(design.systemPrompt).toMatch(/change to a product that already exists/);
    expect(design.prompt).toMatch(/Keep templates in templates/);
    expect(design.cwd).toBe(fin.dir);
    const builds = w.seen.filter((s) => s.station === "repo").map((s) => s.req);
    expect(builds[0].cwd).toBe(fin.dir);
    expect(builds[0].commands).toEqual(expect.arrayContaining(["pytest", "flask"]));
    expect(builds[0].pathFirst).toEqual(["/venv/bin"]);

    // The baseline: what failed before is known, and never held against the run.
    const locked = events(w.log, "factory.tests.locked").at(-1);
    expect(locked).toMatchObject({ kept: "repo", baseline: { passed: 1, failed: 1 }, failingBefore: ["tests/test_app.py::test_old"] });
    const last = events(w.log, "factory.tests").at(-1);
    expect(last.failed).toBe(0);
    expect(last.cases.some((c: any) => /already failed before this change/.test(c.name))).toBe(true);

    // One session per feature; the one that broke a passing test went back once with that evidence.
    const feats = events(w.log, "factory.feature");
    expect(feats.filter((f) => f.state === "built").map((f) => f.id)).toEqual(["F1", "F2"]);
    expect(feats.find((f) => f.state === "regressed")).toMatchObject({ id: "F2", attempt: 1, broke: ["tests/test_app.py::test_home"] });
    expect(builds.some((b) => /passed before your call and fail after it[\s\S]*test_home/.test(b.prompt))).toBe(true);

    // The branch: in the clone, with the change, without SoftwareFactory's notes; the original is untouched.
    expect(fin.dir.startsWith(w.factory.repoWorkDir)).toBe(true);
    expect(git(fin.dir, "branch", "--show-current")).toBe(branch);
    const onBranch = git(fin.dir, "ls-files").split("\n");
    expect(onBranch).toEqual(expect.arrayContaining(["app.py", "templates/contact.html", "tests/test_contact.py"]));
    expect(onBranch.some((p) => p.startsWith(".sf/"))).toBe(false);
    expect(existsSync(join(fin.dir, ".sf", "SPEC.md"))).toBe(true);
    expect(readFileSync(join(fin.dir, ".sf", "PROGRESS.md"), "utf8")).toMatch(/F2/);
    expect(git(w.src, "rev-parse", "HEAD")).toBe(head);
    expect(git(w.src, "branch", "--list")).toBe("* main");
    expect(git(w.src, "status", "--porcelain")).toBe("");

    // Handed over: a pull request with the plan in its body, and the run says where the branch is.
    expect(w.shipped).toHaveLength(1);
    expect(w.shipped[0]).toMatchObject({ branch, title: "Contact page" });
    expect(w.shipped[0].body).toMatch(/- \[x\] The Contact page shows a form\./);
    expect(fin.repo).toMatchObject({ source: w.src, branch, pr: { number: 7 } });
    expect(fin.repo.files).toEqual(expect.arrayContaining(["app.py", "templates/contact.html"]));
    expect(events(w.log, "factory.branch").at(-1)).toMatchObject({ run, branch, pr: { number: 7 } });
    expect(events(w.log, "factory.evaluation").at(-1)).toMatchObject({ pass: true, screens: 1 });
    // The run draws like any other: every station it went through left what the run page needs.
    expect(events(w.log, "factory.visual").filter((v) => v.run === run && !v.pass)).toEqual([]);
    expect(events(w.log, "factory.visual").filter((v) => v.run === run).map((v) => v.station)).toEqual(expect.arrayContaining(["discover", "plan", "build", "review", "evaluate", "ship"]));
  }, 60_000);

  it("SF-64: a plan bigger than the money is sliced before the plan gate; the rest becomes the next slice's ticket", async () => {
    const more = [3, 4, 5].map((n) => ({ id: `F${n}`, title: `Part ${n}`, what: `Part ${n} of the page.`, files: [`part${n}.py`], done: "It works." }));
    const w = world({ plan: { ...PLAN, features: [...PLAN.features, ...more] } });
    const t = w.tickets.open({ kind: "request", project: w.project, title: "Contact page with five parts", asked: true });
    const r = w.tickets.work(t.id, { route: "engine", maxUsd: 3, autoApprove: true });
    await w.factory.wait(r.run!);
    const sliced = events(w.log, "factory.plan.sliced").at(-1);
    expect(sliced).toMatchObject({ run: r.run, fit: { features: 5, fits: 3, ok: false } });
    expect(sliced.later.map((f: any) => f.id)).toEqual(["F4", "F5"]);
    // The plan gate said so in words, and only the features that fit were built.
    const gate = events(w.log, "factory.gate").find((g) => g.gate === "gateA" && g.state === "waiting");
    expect(gate.question).toMatch(/builds 3 of them whole/);
    expect(gate.fit.later).toEqual(["F4 Part 4", "F5 Part 5"]);
    expect([...new Set(events(w.log, "factory.feature").filter((f) => f.run === r.run).map((f) => f.id))]).toEqual(["F1", "F2", "F3"]);
    const dir = events(w.log, "factory.run.finished").at(-1).dir;
    expect(readFileSync(join(dir, ".sf", "SPEC.md"), "utf8")).toMatch(/Left to the next slice[\s\S]*F4 Part 4/);
    // The next slice is a ticket of its own, waiting for this one, asked for like it.
    const next = w.tickets.list({ view: "all", project: w.project }).find((x) => /next slice/.test(x.title))!;
    expect(next.body).toMatch(/F4 Part 4[\s\S]*F5 Part 5/);
    expect(next.blocked).toBe(true);
    expect(w.tickets.detail(next.id)!.asked).toBe(true);
  }, 60_000);

  it("keeps the branch in the clone when no pull request can be opened, and skips the judge honestly when the site cannot start", async () => {
    const w = world({ ship: async () => ({ kept: "No GitHub access yet." }), site: async () => ({ skipped: "the site did not start here" }) });
    const { run, branch } = w.repoRuns.start(w.project, "Add a contact page", { maxUsd: 1.5, autoApprove: true, council: "never" });
    await w.factory.wait(run);
    const fin = events(w.log, "factory.run.finished").at(-1);
    expect(fin.outcome).toBe("shipped");
    // A run with no ticket has no button to press, so it carries the one git line that takes the branch.
    expect(fin.reason).toMatch(new RegExp(`No GitHub access yet\\. To take it into your repo: git fetch ".*" ${branch}`));
    expect(fin.repo).toMatchObject({ kept: "No GitHub access yet." });
    expect(fin.repo.pr).toBeUndefined();
    // A run this size builds the whole change in one session.
    expect(events(w.log, "factory.feature").filter((f) => f.state === "built")).toHaveLength(1);
    const ev = events(w.log, "factory.station").filter((s) => s.station === "evaluate").at(-1);
    expect(ev).toMatchObject({ state: "skipped" });
    expect(ev.note ?? ev.detail ?? JSON.stringify(ev)).toMatch(/could not look/);
  }, 60_000);

  it("a run stopped at the plan gate picks up in the same clone on the same branch", async () => {
    const w = world();
    const { run, branch } = w.repoRuns.start(w.project, "Add a contact page", { maxUsd: 4, council: "never" });
    await new Promise<void>((done) => { const t = setInterval(() => { if (w.factory.waitingGate(run)) { clearInterval(t); done(); } }, 20); });
    expect(w.factory.waitingGate(run)).toBe("gateA");
    const dir = events(w.log, "factory.repo").at(-1).dir;
    // The core goes away while the run waits; a new one resumes it from the log.
    const again = new Factory(w.log, w.rt, w.factory.projectsDir, w.bay);
    expect(() => again.resume(run)).toThrow(/repo/);
    const shipped: BranchToShip[] = [];
    enableRepoRuns(again, w.log, { prepareEnv: () => ENV, runTests: (d) => suite(d), readSite: async () => ({ skipped: "no site" }), ship: async (b) => { shipped.push(b); return { kept: "kept" }; } });
    again.resume(run);
    await new Promise<void>((done) => { const t = setInterval(() => { if (again.waitingGate(run)) { clearInterval(t); done(); } }, 20); });
    again.decide(run, "gateA", { approve: true, by: "you" });
    await new Promise<void>((done) => { const t = setInterval(() => { if (again.waitingGate(run)) { clearInterval(t); done(); } }, 20); });
    again.decide(run, "gateB", { approve: true, by: "you" });
    await again.wait(run);
    const fin = events(w.log, "factory.run.finished").at(-1);
    expect(fin.outcome).toBe("shipped");
    expect(fin.dir).toBe(dir);
    expect(shipped[0].branch).toBe(branch);
    // The plan was written once: the resume did not pay the Planner again.
    expect(w.seen.filter((s) => s.station === "plan")).toHaveLength(1);
  }, 60_000);
});

describe("a sliced run still hands over a branch that works (reliability after run 5669)", () => {
  it("a feature that breaks passing tests twice is taken back off the branch, the rest ships, and it goes to the next slice", async () => {
    const more = [{ id: "F3", title: "Part 3", what: "Part 3 of the page.", files: ["part3.py"], done: "It works." }];
    const w = world({ stubborn: true, plan: { ...PLAN, features: [...PLAN.features, ...more] } });
    const t = w.tickets.open({ kind: "request", project: w.project, title: "Contact page" });
    const r = w.tickets.work(t.id, { route: "engine", maxUsd: 4, autoApprove: true });
    await w.factory.wait(r.run!);
    const fin = events(w.log, "factory.run.finished").at(-1);
    expect(fin.outcome).toBe("shipped");
    // F2 broke test_home twice: it is not on the branch, and the branch's tests pass.
    expect(existsSync(join(fin.dir, "BREAK"))).toBe(false);
    expect(existsSync(join(fin.dir, "templates", "contact.html"))).toBe(false);
    expect(git(fin.dir, "ls-files")).toContain("app.py");
    const left = events(w.log, "factory.features.left").at(-1);
    expect(left.left.map((f: any) => f.id)).toEqual(["F2"]);
    expect(left.left[0].why).toMatch(/taken back off the branch/);
    expect(w.shipped[0].body).toMatch(/Left for the next slice[\s\S]*F2 The contact template/);
    const next = w.tickets.list({ view: "all", project: w.project }).find((x) => /next slice/.test(x.title))!;
    expect(next.body).toMatch(/F2 The contact template[\s\S]*Left because it broke/);
    expect(next.blocked).toBe(true);
    // The reviewer was told what was left, so it does not hold it against this run.
    expect(w.seen.filter((x) => x.station === "review").at(-1)!.req.prompt).toMatch(/left to a run of their own[\s\S]*F2/);
    // What only another system could show is left to CI, not failed here (run 7899).
    expect(w.seen.filter((x) => x.station === "review").at(-1)!.req.prompt).toMatch(/not checkable on this computer/);
  }, 60_000);
});

describe("a flaky test on a busy computer (run 9398)", () => {
  it("fails once and passes when the suite runs again: it is not held against the change, and the run ships", async () => {
    // The baseline passes; then every other run of the suite fails test_home, as a starved PC did.
    let calls = 0;
    const flakySuite = async (dir: string): Promise<TestRun> => {
      calls++;
      const t = await suite(dir);
      if (calls > 1 && calls % 2 === 0) { t.cases[0] = { ...t.cases[0], pass: false, error: "Test timed out in 5000ms" }; t.passed--; t.failed++; }
      return t;
    };
    const w = world({ runTests: flakySuite });
    const t = w.tickets.open({ kind: "request", project: w.project, title: "Contact page" });
    const r = w.tickets.work(t.id, { route: "engine", maxUsd: 4, autoApprove: true });
    await w.factory.wait(r.run!);
    const fin = events(w.log, "factory.run.finished").at(-1);
    expect(fin.outcome).toBe("shipped");
    expect(events(w.log, "factory.feature").map((f) => f.state)).not.toContain("regressed");
    const flaky = events(w.log, "factory.tests.flaky");
    expect(flaky.length).toBe(1);
    expect(flaky[0].tests).toEqual(["tests/test_app.py::test_home"]);
    // Once known as flaky, it is not run again just to check, and the build reuses the baseline instead of a second suite.
    const builds = events(w.log, "factory.feature").filter((f) => f.state !== "building").length;
    expect(calls).toBeLessThanOrEqual(1 + builds + 1 + 2);
    const last = events(w.log, "factory.tests").at(-1);
    expect(last.failed).toBe(0);
  }, 60_000);

  it("a test that fails both times is still the change's: the feature regresses as before", async () => {
    const w = world({ stubborn: true, plan: { ...PLAN, features: [...PLAN.features, { id: "F3", title: "Part 3", what: "Part 3.", files: ["part3.py"], done: "It works." }] } });
    const t = w.tickets.open({ kind: "request", project: w.project, title: "Contact page" });
    const r = w.tickets.work(t.id, { route: "engine", maxUsd: 4, autoApprove: true });
    await w.factory.wait(r.run!);
    expect(events(w.log, "factory.feature").filter((f) => f.id === "F2" && f.state === "regressed").length).toBe(2);
    expect(events(w.log, "factory.tests.flaky")).toEqual([]);
  }, 60_000);
});

describe("a Builder call that changes no file (run 7899)", () => {
  it("gets one more call with its own answer back and the ask to search the whole tree, and then builds", async () => {
    const w = world({ empty: 1 });
    const t = w.tickets.open({ kind: "request", project: w.project, title: "Contact page" });
    const r = w.tickets.work(t.id, { route: "engine", maxUsd: 4, autoApprove: true });
    await w.factory.wait(r.run!);
    expect(events(w.log, "factory.run.finished").at(-1).outcome).toBe("shipped");
    const builds = w.seen.filter((x) => x.station === "repo");
    expect(builds[0].req.prompt).toMatch(/search the whole tree/);
    expect(builds[1].req.prompt).toMatch(/Your call changed no file[\s\S]*BLOCKED: \*\*There is no references\/ folder[\s\S]*recursive=1/);
    // No suite after a call that changed nothing; no escalation for the empty first try.
    expect(events(w.log, "factory.feature").find((e) => e.state === "empty")).toMatchObject({ attempt: 1, passed: 0, failed: 0 });
    expect(events(w.log, "factory.gate").filter((g) => g.gate === "escalation")).toHaveLength(0);
    // The Reviewer is told the suite the core ran, and not to run all of it again (run 7899 timed out doing so).
    const review = w.seen.filter((x) => x.station === "review").at(-1)!.req;
    expect(`${review.systemPrompt}
${review.prompt}`).toMatch(/already ran the repo's whole test suite on this branch[\s\S]*Do not run the whole suite again/);
  }, 60_000);

  it("fails in the Builder's own words when it still changes nothing, and a Retry is told about the empty try", async () => {
    const w = world({ empty: 99, plan: { ...PLAN, features: [PLAN.features[0]] } });
    const t = w.tickets.open({ kind: "request", project: w.project, title: "Contact page" });
    const r = w.tickets.work(t.id, { route: "engine", maxUsd: 4, autoApprove: true });
    await w.factory.wait(r.run!);
    const asked = events(w.log, "factory.gate").filter((g) => g.gate === "escalation" && g.state === "waiting");
    expect(asked[0].question).toMatch(/Build failed: The Builder changed no file\. It said: BLOCKED: There is no references\/ folder/);
    // The station Retry starts the build again: its first call already knows an earlier try changed nothing.
    const builds = w.seen.filter((x) => x.station === "repo");
    expect(builds[2].req.prompt).toMatch(/An earlier call changed no file for this|Your call changed no file/);
  }, 60_000);
});

describe("a run that runs short of money mid-build", () => {
  it("stops building before a feature it cannot afford and still reviews and hands over what it built", async () => {
    const more = [{ id: "F3", title: "Part 3", what: "Part 3 of the page.", files: ["part3.py"], done: "It works." }];
    const w = world({ buildUsd: 1.2, plan: { ...PLAN, features: [...PLAN.features, ...more] } });
    const t = w.tickets.open({ kind: "request", project: w.project, title: "Contact page" });
    const r = w.tickets.work(t.id, { route: "engine", maxUsd: 3, autoApprove: true });
    await w.factory.wait(r.run!);
    expect(events(w.log, "factory.build.stopped").at(-1)).toMatchObject({ run: r.run, left: ["F3"] });
    expect(events(w.log, "factory.run.finished").at(-1).outcome).toBe("shipped");
    expect(events(w.log, "factory.features.left").at(-1).left[0].why).toMatch(/money ran short/);
  }, 60_000);
});

describe("the doors before the route: a question and another round", () => {
  it("reads which door an ask comes through, by its words", () => {
    expect(intakeDoor("Why does the login page fail on Safari?").door).toBe("question");
    expect(intakeDoor("Find out which pages are slow").door).toBe("question");
    expect(intakeDoor("Is the contact form sending email anywhere?").door).toBe("question");
    expect(intakeDoor("Can you add a contact page?").door).toBe("work");
    expect(intakeDoor("Add a contact page").door).toBe("work");
    expect(intakeDoor("Fix the typo in the footer").door).toBe("work");
    expect(intakeDoor("Another round on the landing page please").door).toBe("reloop");
    expect(intakeDoor("re-loop this project").door).toBe("reloop");
    expect(intakeDoor("Improve it again").door).toBe("reloop");
  });

  it("a question said in the project becomes a question ticket a reader answers; nothing is built", async () => {
    const w = world({ answer: "The form posts to /contact and nothing sends mail.\nFiles read: app.py" });
    const r = w.tickets.askInRepo(w.project, "Is the contact form sending email anywhere?")!;
    expect(r).toMatchObject({ run: null, door: "question", ticket: { kind: "question" } });
    await w.tickets.waitRepo(r.ticket.id);
    expect(w.tickets.get(r.ticket.id)!.status).toBe("built");
    expect(w.tickets.notes(r.ticket.id).some((n) => /nothing sends mail/.test(n.text))).toBe(true);
    expect(events(w.log, "factory.run.started")).toHaveLength(0);
    // A project without a repo gets its question answered too, instead of a new app being built.
    const plain = createProject(w.log, { name: "From scratch" });
    expect(w.tickets.askInRepo(plain, "Why is the list empty after a restart?")).toMatchObject({ door: "question", run: null });
    expect(w.tickets.askInRepo(plain, "Build a todo app")).toBeNull();
  }, 60_000);

  it("another round reads the project and files what it finds as ready tickets under the round's epic", async () => {
    const w = world({ answer: [
      "Two things are worth doing now.",
      "- [S] bug: Footer link is broken: the footer points to /contct in templates/base.html",
      "- [M] task: Test the home view: app.py has no test for home()",
      "Files read: app.py, templates/base.html",
    ].join("\n") });
    const r = w.tickets.askInRepo(w.project, "Another round on the landing page")!;
    expect(r).toMatchObject({ run: null, door: "reloop", ticket: { kind: "plan" } });
    await w.tickets.waitRepo(r.ticket.id);
    const kids = w.tickets.list({ view: "all", project: w.project, parent: r.ticket.id });
    expect(kids.map((k) => [k.kind, k.size, k.status, k.title])).toEqual(expect.arrayContaining([
      ["bug", "S", "ready", "Footer link is broken"], ["task", "M", "ready", "Test the home view"],
    ]));
    expect(w.tickets.detail(kids[0].id)!.asked).toBe(true);
    expect(w.tickets.notes(r.ticket.id).some((n) => n.kind === "reply" && /Filed as/.test(n.text))).toBe(true);
    expect(events(w.log, "factory.run.started")).toHaveLength(0);
  }, 60_000);
});

describe("tickets in a repo project take the route that fits", () => {
  it("a feature-sized request runs on the engine and comes back with its branch and pull request; it waits for your look", async () => {
    const w = world();
    const t = w.tickets.open({ kind: "request", project: w.project, body: "Add a contact page with a form that sends an email, and a thank you page, and a link to it in the menu" });
    expect(w.tickets.detail(t.id)!.route).toMatchObject({ route: "engine" });
    const r = w.tickets.work(t.id, { autoApprove: true });
    expect(r.route).toMatchObject({ route: "engine" });
    expect(r.run).toBeGreaterThan(0);
    expect(r.branch).toBe("sf/LP-1-add-a-contact-page-with-a-form-t");
    expect(w.tickets.get(t.id)!.status).toBe("in_progress");
    expect(() => w.tickets.work(t.id)).toThrow(/already working/);
    await w.factory.wait(r.run!);
    const done = w.tickets.get(t.id)!;
    expect(done.status).toBe("built");
    expect(done.branch).toBe(r.branch);
    expect(done.pr).toMatchObject({ number: 7, state: "open", repo: "acme/landing" });
    expect(w.tickets.notes(t.id).at(-1)!.text).toMatch(/Opened draft PR #7/);
    // Not in the repo until the pull request merges: the QA rule never closes it.
    expect(w.tickets.notes(t.id).some((n) => n.by === "qa-rule")).toBe(false);
    expect(events(w.log, "factory.run.started").at(-1)).toMatchObject({ kind: "repo", maxUsd: 1.5, repo: { ticket: { id: t.id, key: "LP-1" } } });
  }, 60_000);

  it("a branch the engine kept on this computer goes into your folder on one press, like any ticket branch", async () => {
    const w = world({ ship: async () => ({ kept: "The repo is not on GitHub, so nothing is pushed." }) });
    const t = w.tickets.open({ kind: "request", project: w.project, body: "Add a contact page with a form that sends an email, and a thank you page, and a link to it in the menu" });
    const r = w.tickets.work(t.id, { autoApprove: true });
    await w.factory.wait(r.run!);
    const built = w.tickets.get(t.id)!;
    expect(built).toMatchObject({ status: "built", branch: r.branch, pr: null, pushedUrl: null });
    // Work it again on the built ticket points at the run that built it today, not a second build (run 8917).
    expect(() => w.tickets.work(t.id, { autoApprove: true })).toThrow(/Run #\d+ already built it today/);
    expect(events(w.log, "factory.run.started")).toHaveLength(1);
    const note = w.tickets.notes(t.id).at(-1)!.text;
    expect(note).toMatch(/Press Add to my folder on this ticket/);
    expect(note).not.toMatch(/git fetch/);
    expect(events(w.log, "factory.run.finished").at(-1).reason).toMatch(/Press Add to my folder on ticket LP-1/);
    // Nothing reached the folder until the press, and the press brings the branch only.
    expect(git(w.src, "branch", "--list", r.branch!)).toBe("");
    const sent = await w.tickets.send(t.id);
    expect(sent.pushedUrl).toBe("local");
    expect(git(w.src, "branch", "--list", r.branch!)).toContain(r.branch!);
    expect(git(w.src, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(w.src, "status", "--porcelain")).toBe("");
  }, 60_000);

  it("an epic that holds tickets is worked through them: no route is suggested and no run starts over the whole epic", () => {
    const w = world();
    const epic = w.tickets.open({ kind: "plan", project: w.project, title: "A members area", body: "Add sign up, sign in, a profile page and a page only members can read, with a link to each in the menu" });
    // With no tickets under it, an epic is one large ask: the engine.
    expect(w.tickets.detail(epic.id)!.route).toMatchObject({ route: "engine" });
    const part = w.tickets.open({ kind: "task", project: w.project, title: "Sign up page", parent: epic.id });
    expect(w.tickets.detail(epic.id)!.route).toBeNull();
    expect(() => w.tickets.work(epic.id)).toThrow(/worked through its tickets \(0 of 1 done\)/);
    expect(() => w.tickets.work(epic.id, { route: "engine" })).toThrow(/worked through its tickets/);
    expect(events(w.log, "factory.run.started")).toHaveLength(0);
    // Its ticket still takes a route of its own.
    expect(w.tickets.detail(part.id)!.route).toMatchObject({ route: "light" });
  });

  it("a bug stays one session in the repo, and so does anything the crew starts on its own money", async () => {
    const w = world();
    const bug = w.tickets.open({ kind: "bug", project: w.project, title: "The footer link is broken" });
    expect(w.tickets.detail(bug.id)!.route).toMatchObject({ route: "light" });
    const r = w.tickets.work(bug.id);
    expect(r.run).toBeNull();
    expect(r.route).toMatchObject({ route: "light" });
    await w.tickets.waitRepo(bug.id);
    expect(events(w.log, "factory.run.started")).toHaveLength(0);
    // The dispatcher's cap is under what an engine run needs: a large request still goes the light way.
    const big = w.tickets.open({ kind: "request", size: "L", project: w.project, title: "Rebuild the whole menu" });
    const d = w.tickets.work(big.id, { maxUsd: 0.6, by: "dispatcher" });
    expect(d.run).toBeNull();
    expect(d.route!.why).toMatch(/under the \$1\.50/);
    await w.tickets.waitRepo(big.id);
    // Asked for by name with too little money, the engine refuses in words instead of quietly doing less.
    expect(() => w.tickets.work(big.id, { route: "engine", maxUsd: 0.6 })).toThrow(/at least \$1\.50/);
  }, 60_000);

  it("an ask said in the project itself becomes a ticket there and takes its route", async () => {
    const w = world();
    const small = w.tickets.askInRepo(w.project, "Fix the typo in the footer")!;
    expect(small.ticket).toMatchObject({ kind: "request", project: w.project });
    expect(small.run).toBeNull();
    await w.tickets.waitRepo(small.ticket.id);
    const big = w.tickets.askInRepo(w.project, "Add a contact page with a form that sends an email, and a thank you page, and a link to it in the menu", { autoApprove: true })!;
    expect(big.run).toBeGreaterThan(0);
    await w.factory.wait(big.run!);
    expect(w.tickets.get(big.ticket.id)!.status).toBe("built");
    // A project with no repo is not this door's business.
    expect(w.tickets.askInRepo(createProject(w.log, { name: "From scratch" }), "Build a todo app")).toBeNull();
  }, 60_000);
});

describe("the practice crew", () => {
  it("walks the whole route in a repo for free and leaves a note on the branch", async () => {
    const log = new EventLog();
    const rt = new MockRuntime();
    const bay = new AgentBay(log, rt);
    const src = legacyRepo();
    const project = createProject(log, { name: "Landing page" });
    log.append("project.linked", { projectId: project, kind: "repo", ref: src });
    const factory = new Factory(log, rt, join(tmp("sf-rr-data-"), "projects"), bay);
    const repoRuns = enableRepoRuns(factory, log, { prepareEnv: () => ({ ...ENV, tests: [], testHint: "" }), readSite: async () => ({ skipped: "practice" }) });
    const { run, branch } = repoRuns.start(project, "Add a contact page", { autoApprove: true });
    await factory.wait(run);
    const fin = events(log, "factory.run.finished").at(-1);
    expect(fin.reason).toMatch(/git fetch/);
    expect(fin.outcome).toBe("shipped");
    expect(git(fin.dir, "ls-files").split("\n").some((p) => p.startsWith("docs/softwarefactory/"))).toBe(true);
    // The practice plan is named after the ask, not after the practice crew's sample app.
    expect(events(log, "factory.plan").at(-1).plan).toMatchObject({ name: "Add a contact page", repo: true });
    expect(fin.repo).toMatchObject({ branch });
    expect(fin.repo.kept).toMatch(/no GitHub access/);
    expect(events(log, "factory.visual").filter((v) => v.run === run && !v.pass)).toEqual([]);
  }, 60_000);
});

describe("a codebase on this computer, for real", () => {
  it("makes a Python environment under .sf/, runs the repo's own tests and names each one", async () => {
    const dir = tmp("sf-rr-py-");
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "calc.py"), "def add(a, b):\n    return a + b\n");
    writeFileSync(join(dir, "test_calc.py"), "import unittest\nfrom calc import add\n\nclass CalcTest(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(1, 2), 3)\n    def test_wrong(self):\n        self.assertEqual(add(1, 2), 4)\n");
    git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "first");
    const env = await prepareEnv(dir);
    if (env.notes.some((n) => /no Python 3|could not make/.test(n))) return; // a computer without Python says so, and that is all it can do
    expect(env.tests.map((t) => t.kind)).toEqual(["unittest"]);
    expect(env.testHint).toBe("python -m unittest discover");
    expect(env.pathFirst[0]).toContain(join(".sf", "venv"));
    expect(env.commands).toContain("pytest");
    const r = await runRepoTests(dir, env);
    expect(r.cases.map((c) => [c.name, c.pass]).sort()).toEqual([["test_add", true], ["test_wrong", false]]);
    expect(r).toMatchObject({ passed: 1, failed: 1 });
    // A second look is instant: the environment is there.
    const t0 = Date.now();
    await prepareEnv(dir);
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 120_000);

  it("runs a Node repo's npm test and reads its ticks", async () => {
    const dir = tmp("sf-rr-node-");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", type: "module", scripts: { test: "node --test" } }));
    mkdirSync(join(dir, "test"));
    writeFileSync(join(dir, "test", "a.test.js"), 'import { test } from "node:test";\nimport assert from "node:assert";\ntest("adds", () => { assert.equal(1 + 1, 2); });\ntest("breaks", () => { assert.equal(1 + 1, 3); });\n');
    const env = await prepareEnv(dir);
    expect(env.tests.map((t) => t.label)).toEqual(["npm test"]);
    const r = await runRepoTests(dir, env);
    expect(r.cases.find((c) => c.name === "adds")?.pass).toBe(true);
    expect(r.cases.find((c) => c.name === "breaks")?.pass).toBe(false);
    expect(r.exitCode).not.toBe(0);
  }, 120_000);

  it("starts a site of plain pages, reads the home page and the pages it links to, and stops it", async () => {
    const dir = tmp("sf-rr-site-");
    writeFileSync(join(dir, "index.html"), '<html><body><h1>Plonter</h1><a href="contact.html">Contact</a><a href="https://example.com">Out</a></body></html>');
    writeFileSync(join(dir, "contact.html"), "<html><body><h1>Contact us</h1><form><input name=email placeholder=Email><button>Send</button></form></body></html>");
    expect(siteProfile(dir)?.kind).toBe("static");
    // Read as HTML here (the suite runs with the browser check off); the installed app reads the drawn page.
    const screens = await withSite(dir, {}, (url) => readPages(url, { browser: null }));
    if (!Array.isArray(screens)) throw new Error(screens.skipped);
    expect(screens.map((s) => s.route)).toEqual(["", "contact.html"]);
    expect(screens[0].text).toMatch(/Plonter/);
    expect(screens[1].text).toMatch(/Contact us/);
    expect(screens[1].controls.join(" ")).toMatch(/Send/);
    expect(await withSite(tmp("sf-rr-empty-"), {}, async () => 1)).toMatchObject({ skipped: expect.stringMatching(/no site/) });
  }, 120_000);

  it("starts a Python web program on a free port with the repo's own Python, reads it, and leaves nothing running", async () => {
    const dir = tmp("sf-rr-web-");
    writeFileSync(join(dir, "app.py"), [
      "import os", "from http.server import BaseHTTPRequestHandler, HTTPServer",
      "class H(BaseHTTPRequestHandler):",
      "    def do_GET(self):",
      "        body = b'<html><body><h1>Dog school</h1><a href=\"/about\">About</a></body></html>' if self.path == '/' else b'<html><body><h1>About the school</h1></body></html>'",
      "        self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(body)",
      "    def log_message(self, *a): pass",
      "port = int(os.environ.get('PORT', '5000'))",
      "print(f' * Running on http://127.0.0.1:{port}', flush=True)",
      "HTTPServer(('127.0.0.1', port), H).serve_forever()", "",
    ].join("\n"));
    const env = await prepareEnv(dir);
    if (!env.pathFirst.length) return; // no Python on this computer
    expect(siteProfile(dir)?.kind).toBe("web");
    let seen = "";
    const screens = await withSite(dir, { pathFirst: env.pathFirst }, async (url) => { seen = url; return readPages(url, { browser: null }); });
    if (!Array.isArray(screens)) throw new Error(screens.skipped);
    expect(screens.map((s) => [s.route, /school/.test(s.text)])).toEqual([["", true], ["about", true]]);
    // Stopped: nothing answers on its address any more.
    await new Promise((r) => setTimeout(r, 300));
    await expect(fetch(seen, { signal: AbortSignal.timeout(1500) })).rejects.toThrow();
    // A program that dies at once is said plainly, not waited on.
    writeFileSync(join(dir, "app.py"), "from http.server import HTTPServer\nraise SystemExit('no database')\n");
    expect(await withSite(dir, { pathFirst: env.pathFirst }, async () => 1)).toMatchObject({ skipped: expect.stringMatching(/could not be started here.*no database/s) });
  }, 120_000);
});

describe("a test that already failed before the change", () => {
  it("is known however vitest named it this time (run 7899)", () => {
    const before = new Set(["::opens each screen of a built app and names the one that breaks", "tests/test_app.py::test_old"]);
    expect(failedBefore({ file: "", name: "every screen in a real browser > opens each screen of a built app and names the one that breaks" }, before)).toBe(true);
    expect(failedBefore({ file: "test/engine.test.ts", name: "every screen in a real browser > opens each screen of a built app and names the one that breaks" }, before)).toBe(true);
    expect(failedBefore({ file: "tests/test_app.py", name: "test_old" }, before)).toBe(true);
    // A new failure, or a test of the same name in another file, is still this run's.
    expect(failedBefore({ file: "", name: "every screen > opens one screen" }, before)).toBe(false);
    expect(failedBefore({ file: "tests/test_other.py", name: "test_old" }, before)).toBe(false);
  });
});
