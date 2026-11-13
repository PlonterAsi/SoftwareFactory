import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ClaudeCodeRuntime, EventLog, Factory, MockRuntime, parseFileBlocks, runTests, git, type AgentRequest, type AgentRuntime } from "../src/index.js";
import { WORKBENCH_COMMANDS, restoreProtected, testDispute, changedFiles, hasWorkbench } from "../src/factory/workbench.js";
import { modelFloorUsd, strongerModel } from "../src/factory/loop.js";
import { checkLinks, linksIn } from "../src/factory/linkcheck.js";
import { critiquePasses, validateCritique, validateDocs } from "../src/factory/discovery.js";
import { dryRunTests, lockedTestFaults, relativeImports } from "../src/factory/testcheck.js";
import { initRepo, commitAll } from "../src/factory/workspace.js";
import { probeStart } from "../src/factory/appkit.js";
import { browserEnv, checkScreens, findBrowser, routesOf, screenCase, screenProblem, type ScreenCheck } from "../src/factory/screencheck.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const events = (log: EventLog, type: string) => log.list({ limit: 1e6 }).filter((e) => e.type === type).map((e) => e.payload as any);
const station = (req: AgentRequest) => req.systemPrompt?.match(/Station contract: (\w+)/)?.[1] ?? "";

describe("the test reader keeps what broke", () => {
  it("shows the error of a file that fails as a whole after every test in it passed (run 2366)", async () => {
    const dir = tmp("sf-diag-");
    mkdirSync(join(dir, "test"));
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    writeFileSync(join(dir, "test", "a.test.js"), 'import { test } from "node:test";\ntest("one", () => {});\nsetTimeout(() => { game; }, 5);\n');
    const r = await runTests(dir);
    const bad = r.cases.filter((c) => !c.pass);
    expect(bad.length).toBe(1);
    expect(bad[0].error).toMatch(/game is not defined/);
    expect(r.output).toMatch(/game is not defined/);
  });

  it("drops a stray last line that is only the block's own path", () => {
    const [f] = parseFileBlocks("<<<FILE test/a.test.js\nimport x from 'y';\ntest/a.test.js\nFILE>>>");
    expect(f.content).toBe("import x from 'y';\n");
  });
});

describe("the workbench", () => {
  it("gives a real agent a shell limited to the workbench commands, in its folder only", () => {
    const rt = new ClaudeCodeRuntime({ profile: "lean" });
    const args = rt.buildArgs({ prompt: "p", cwd: "/tmp/x", tools: ["Read", "Edit", "Write"], commands: ["node", "npm test"] });
    expect(args[args.indexOf("--tools") + 1].split(",")).toContain("Bash");
    expect(args[args.indexOf("--allowedTools") + 1]).toContain("Bash(node:*)");
    expect(args[args.indexOf("--allowedTools") + 1]).toContain("Bash(npm test:*)");
    expect(args).toContain("acceptEdits");
    // No folder, no shell, even when the agent's settings list Bash.
    const none = rt.buildArgs({ prompt: "p", tools: ["Bash", "WebSearch"], commands: ["node"] });
    expect(none[none.indexOf("--tools") + 1]).toBe("WebSearch");
    expect(none.join(" ")).not.toContain("Bash(");
  });

  it("puts back locked files the agent changed, and removes ones it added there", () => {
    const dir = tmp("sf-wb-");
    initRepo(dir);
    mkdirSync(join(dir, "test"));
    writeFileSync(join(dir, "test", "a.test.js"), "locked\n");
    writeFileSync(join(dir, "app.js"), "v1\n");
    commitAll(dir, "base");
    writeFileSync(join(dir, "test", "a.test.js"), "weakened\n");
    writeFileSync(join(dir, "test", "new.test.js"), "added\n");
    writeFileSync(join(dir, "app.js"), "v2\n");
    expect(restoreProtected(dir, (p) => p.startsWith("test/")).sort()).toEqual(["test/a.test.js", "test/new.test.js"]);
    expect(readFileSync(join(dir, "test", "a.test.js"), "utf8")).toBe("locked\n");
    expect(changedFiles(dir)).toEqual(["app.js"]);
  });

  it("reads a dispute line and steps models up", () => {
    expect(testDispute("fixed nothing\nTEST_WRONG: test/a.test.js: last line is a stray path")).toEqual({ file: "test/a.test.js", evidence: "last line is a stray path" });
    expect(testDispute("all good")).toBeNull();
    expect(strongerModel("haiku")).toBe("sonnet");
    expect(strongerModel("sonnet")).toBe("opus");
    expect(strongerModel("claude-opus-5-5")).toBe("claude-opus-5-5");
  });

  it("a real crew's Builder and Fixer work in the folder with the shell; the core reverts locked files and judges", async () => {
    const mock = new MockRuntime();
    const seen: AgentRequest[] = [];
    // Plays a Claude Code crew: the Builder and Fixer write files with their tools (into cwd) and answer in prose.
    const bench: AgentRuntime = { name: "claude-code:fake", run: async (req) => {
      const r = await mock.run(req);
      if (station(req) === "build" || station(req) === "fix") {
        seen.push(req);
        for (const f of parseFileBlocks(r.text)) { mkdirSync(dirname(join(req.cwd!, f.path)), { recursive: true }); writeFileSync(join(req.cwd!, f.path), f.content); }
        // An agent that "helps" by editing a locked test: the core must put it back.
        writeFileSync(join(req.cwd!, "test", "count.test.js"), "// weakened\n");
        r.text = "Wrote the app.\nnode --test: 4 pass, 0 fail.";
      }
      return r;
    } };
    expect(hasWorkbench(bench)).toBe(true);
    const log = new EventLog();
    const f = new Factory(log, bench, tmp("sf-proj-"));
    const run = f.start("count words", { autoApprove: true });
    await f.wait(run);
    const fin = events(log, "factory.run.finished").at(-1);
    expect(fin.outcome).toBe("shipped");
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const req of seen) {
      expect(req.cwd).toBe(fin.dir);
      expect(req.commands).toEqual(WORKBENCH_COMMANDS);
      expect(req.tools).toContain("Bash");
      expect(req.systemPrompt).toMatch(/run the tests yourself/);
    }
    const built = events(log, "factory.files").find((p) => p.station === "build");
    expect(built.workbench).toBe(true);
    expect(built.written.map((w: any) => w.path)).toContain("src/count.js");
    expect(built.refused.map((r: any) => r.path)).toContain("test/count.test.js");
    expect(readFileSync(join(fin.dir, "test", "count.test.js"), "utf8")).not.toContain("weakened");
    expect(git(fin.dir, "status", "--porcelain")).toBe("");
  });
});

describe("the done-claim check", () => {
  it("the Reviewer verifies each acceptance criterion at the workbench (run only); an unmet one goes back to the Fixer with its evidence", async () => {
    const mock = new MockRuntime({ plantBug: false });
    const reviews: AgentRequest[] = [];
    const fixes: AgentRequest[] = [];
    const crew: AgentRuntime = { name: "claude-code:fake", run: async (req) => {
      const r = await mock.run(req);
      const st = station(req);
      if (st === "build" || st === "fix") {
        if (st === "fix") fixes.push(req);
        for (const f of parseFileBlocks(r.text)) { mkdirSync(dirname(join(req.cwd!, f.path)), { recursive: true }); writeFileSync(join(req.cwd!, f.path), f.content + (st === "fix" && f.path.endsWith(".js") ? "// fixed\n" : "")); }
        r.text = "done";
      }
      if (st === "review") {
        reviews.push(req);
        writeFileSync(join(req.cwd!, "scratch.mjs"), "left behind");
        const ok = reviews.length > 1;
        r.text = "```json\n" + JSON.stringify({ verdict: "pass", findings: [], criteria: [{ text: "progress is the share of the goal, capped at 100", pass: ok, evidence: ok ? "progress(300,200) gave 100" : "progress(300,200) gave 150" }] }) + "\n```";
      }
      return r;
    } };
    const log = new EventLog();
    const f = new Factory(log, crew, tmp("sf-proj-"));
    const run = f.start("count words", { autoApprove: true });
    await f.wait(run);
    const fin = events(log, "factory.run.finished").at(-1);
    expect(fin.outcome).toBe("shipped");
    expect(reviews.length).toBe(2);
    expect(reviews[0].tools).toContain("Bash");
    expect(reviews[0].tools).not.toContain("Edit");
    expect(reviews[0].prompt).toMatch(/For EACH acceptance criterion/);
    expect(fixes.length).toBe(1);
    expect(fixes[0].prompt).toMatch(/Acceptance criterion not met: progress is the share of the goal.*gave 150/);
    const rv = events(log, "factory.review");
    expect(rv[0].verdict).toBe("fix");
    expect(rv[1].criteria[0].pass).toBe(true);
    expect(git(fin.dir, "status", "--porcelain")).toBe("");
  });
});

describe("attempt memory and the escalation ladder", () => {
  it("a Fixer that changes nothing is remembered, gets a deeper round on a stronger model, then you are asked with the record", async () => {
    const log = new EventLog();
    const rt = new MockRuntime();
    const prompts: AgentRequest[] = [];
    const lazy: AgentRuntime = { name: "lazy", run: async (req) => {
      const r = await rt.run(req);
      if (req.systemPrompt?.includes("You are the Fixer")) { prompts.push(req); r.text = "I can't see what fails."; }
      return r;
    } };
    const f = new Factory(log, lazy, tmp("sf-proj-"));
    const run = f.start("count words", { autoApprove: true, autoRetries: 0 });
    await f.wait(run);
    expect(events(log, "factory.run.finished").at(-1).outcome).toBe("stopped");
    expect(events(log, "factory.ladder").map((l) => l.to)).toEqual(["deeper", "dispute"]);
    expect(events(log, "factory.attempt").map((a) => a.model)).toEqual(["sonnet", "opus"]);
    expect(prompts[1].model).toBe("opus");
    expect(prompts[1].prompt).toMatch(/What was already tried/);
    expect(prompts[1].prompt).toMatch(/I can't see what fails/);
    expect(prompts[1].prompt).toMatch(/Step back/);
    const gate = events(log, "factory.gate").find((g) => g.gate === "escalation" && g.state === "waiting");
    expect(gate.question).toMatch(/Tried so far/);
  });

  it("a test file that breaks on its own lines is sent back to the Tester before it is locked (run 2366)", async () => {
    const log = new EventLog();
    const rt = new MockRuntime({ plantBug: false });
    let testsCalls = 0;
    const crew: AgentRuntime = { name: "mock", run: async (req) => {
      const r = await rt.run(req);
      // The Tester's first suite has a stray statement that throws after every test passed (run 2366's bug).
      if (station(req) === "tests" && ++testsCalls === 1) r.text = r.text.replace("FILE>>>", "setTimeout(() => { game; }, 5);\nFILE>>>");
      return r;
    } };
    const f = new Factory(log, crew, tmp("sf-proj-"));
    const run = f.start("count words", { autoApprove: true, autoRetries: 0 });
    await f.wait(run);
    const fin = events(log, "factory.run.finished").at(-1);
    expect(fin.outcome).toBe("shipped");
    expect(testsCalls).toBe(2);
    expect(events(log, "factory.tests.dryrun")[0].problems[0]).toMatch(/game is not defined/);
    // Caught before locking: no fix round was ever spent on it, and the suite was locked once.
    expect(events(log, "factory.tests.locked")).toHaveLength(1);
    expect(events(log, "factory.ladder")).toHaveLength(0);
    expect(readFileSync(join(fin.dir, "test", "count.test.js"), "utf8")).not.toContain("game;");
  });

  it("a Fixer's TEST_WRONG goes straight to the Tester, not to a stronger model; kept tests come back with the reason", async () => {
    const log = new EventLog();
    const rt = new MockRuntime();
    let fixCalls = 0;
    const prompts: AgentRequest[] = [];
    const crew: AgentRuntime = { name: "mock", run: async (req) => {
      const r = await rt.run(req);
      if (station(req) === "fix") { prompts.push(req); if (++fixCalls === 1) r.text = "The code looks right.\nTEST_WRONG: test/count.test.js: the expected count looks off"; }
      if (station(req) === "tests" && /Judge it/.test(req.prompt)) r.text = "KEEP: the count is right; a word is any run of letters.";
      return r;
    } };
    const f = new Factory(log, crew, tmp("sf-proj-"));
    const run = f.start("count words", { autoApprove: true, autoRetries: 0 });
    await f.wait(run);
    expect(events(log, "factory.run.finished").at(-1).outcome).toBe("shipped");
    const ladder = events(log, "factory.ladder");
    expect(ladder.map((l) => l.to)).toEqual(["dispute"]);
    expect(ladder[0].triage).toBe(true);
    expect(events(log, "factory.attempt").map((a) => a.model)).not.toContain("opus");
    expect(prompts[1].prompt).toMatch(/the Tester kept it: .*a word is any run of letters/);
  });

  it("no stronger model without the money it needs: the deeper round keeps the model", async () => {
    expect(modelFloorUsd("opus")).toBeGreaterThan(modelFloorUsd("sonnet"));
    const log = new EventLog();
    const rt = new MockRuntime();
    const lazy: AgentRuntime = { name: "lazy", run: async (req) => {
      const r = await rt.run(req);
      if (req.systemPrompt?.includes("You are the Fixer")) r.text = "I can't see what fails.";
      return r;
    } };
    const f = new Factory(log, lazy, tmp("sf-proj-"));
    const run = f.start("count words", { autoApprove: true, autoRetries: 0, maxUsd: 0.3 });
    await f.wait(run);
    expect(events(log, "factory.attempt").map((a) => a.model)).toEqual(["sonnet", "sonnet"]);
    expect(events(log, "factory.ladder").some((l) => /kept sonnet: .* below what opus needs/.test(l.reason))).toBe(true);
  });

  it("a failed agent call's cost counts toward the run's spend", async () => {
    const log = new EventLog();
    const rt = new MockRuntime();
    let failed = false;
    const crew: AgentRuntime = { name: "mock", run: async (req) => {
      if (station(req) === "build" && !failed) { failed = true; throw Object.assign(new Error("error_max_budget_usd"), { costUsd: 0.25 }); }
      return rt.run(req);
    } };
    const f = new Factory(log, crew, tmp("sf-proj-"));
    const run = f.start("count words", { autoApprove: true, autoRetries: 1 });
    await f.wait(run);
    expect(events(log, "agent.run.failed")[0].costUsd).toBe(0.25);
    expect(events(log, "factory.run.finished").at(-1).totalUsd).toBeGreaterThanOrEqual(0.25);
  });
});

describe("a workbench call that runs out of budget mid-work", () => {
  it("goes on by itself from the files it left, without asking anyone (run 2623)", async () => {
    const log = new EventLog();
    const mock = new MockRuntime({ plantBug: false });
    const builds: AgentRequest[] = [];
    const bench: AgentRuntime = { name: "claude-code:fake", run: async (req) => {
      const r = await mock.run(req);
      if (station(req) === "build") {
        builds.push(req);
        const files = parseFileBlocks(r.text);
        const write = (fs: typeof files) => { for (const f of fs) { mkdirSync(dirname(join(req.cwd!, f.path)), { recursive: true }); writeFileSync(join(req.cwd!, f.path), f.content); } };
        // The first call writes half the app, then dies at its cap.
        if (builds.length === 1) { write(files.slice(0, 1)); throw Object.assign(new Error("claude exited 1: error_max_budget_usd"), { costUsd: 0.6 }); }
        write(files);
        r.text = "Finished the rest.";
      }
      return r;
    } };
    const f = new Factory(log, bench, tmp("sf-proj-"));
    const run = f.start("count words", { autoApprove: true, autoRetries: 0, maxUsd: 3 });
    await f.wait(run);
    expect(events(log, "factory.run.finished").at(-1).outcome).toBe("shipped");
    expect(builds).toHaveLength(2);
    expect(builds[1].prompt).toMatch(/ran out of its budget.*Do not start over/s);
    expect(events(log, "factory.continued")).toHaveLength(1);
    expect(events(log, "factory.gate").some((g) => g.gate === "escalation")).toBe(false);
    expect(builds.every((b) => b.noMemory)).toBe(true);
  });

  it("a review whose last message lost its verdict is asked for it again in the same session (run 2623)", async () => {
    const log = new EventLog();
    const mock = new MockRuntime({ plantBug: false });
    const reviews: AgentRequest[] = [];
    const crew: AgentRuntime = { name: "mock", run: async (req) => {
      const r = await mock.run(req);
      if (station(req) === "review") {
        reviews.push(req);
        if (reviews.length === 1) r.text = "The background server I started was stopped at its time limit, as expected. The review above stands.";
      }
      return { ...r, sessionId: `s${reviews.length}` };
    } };
    const f = new Factory(log, crew, tmp("sf-proj-"));
    const run = f.start("count words", { autoApprove: true, autoRetries: 0 });
    await f.wait(run);
    expect(events(log, "factory.run.finished").at(-1).outcome).toBe("shipped");
    expect(reviews[1].resume).toBe("s1");
    expect(reviews[1].tools).toEqual([]);
    expect(events(log, "factory.continued").some((c) => c.station === "review")).toBe(true);
  });

  it("closes a file block on a bare >>> line", () => {
    const [f] = parseFileBlocks("<<<FILE test/a.test.js\nimport x from 'y';\n>>>\nthanks");
    expect(f.content).toBe("import x from 'y';\n");
  });
});

describe("the plan keeps what the person asked for", () => {
  it("a requirement the plan drops goes back to the Planner before the plan gate (run 2623)", async () => {
    const log = new EventLog();
    const rt = new MockRuntime();
    const plans: AgentRequest[] = [];
    const crew: AgentRuntime = { name: "mock", run: async (req) => {
      const r = await rt.run(req);
      if (station(req) === "plan") plans.push(req);
      if (station(req) === "critique" && /you check a plan/.test(req.prompt)) r.text = '{"missing": ["a session log with date and minutes"]}';
      return r;
    } };
    const f = new Factory(log, crew, tmp("sf-proj-"));
    const run = f.start("Count words in my notes. Show a goal bar for each note. Keep a session log with date and minutes.", { autoApprove: true, autoRetries: 0 });
    await f.wait(run);
    expect(events(log, "factory.plan.gaps")[0].missing).toEqual(["a session log with date and minutes"]);
    expect(plans.length).toBeGreaterThanOrEqual(2);
    expect(plans[1].prompt).toMatch(/leaves out these things.*session log/s);
  });
});

describe("every link in the app opens", () => {
  it("finds the app's own links and names the made-up ones", async () => {
    const dir = tmp("sf-links-");
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "test"));
    writeFileSync(join(dir, "src", "seed.js"), 'export const tips = [{ video: "https://www.youtube.com/watch?v=rlAirD0001d" }, { guide: "https://liquipedia.net/rocketleague/Air_Dribble" }, { src: "https://www.reddit.com/r/RocketLeague/" }, { local: "http://localhost:3000/x" }];');
    writeFileSync(join(dir, "test", "a.test.js"), '"https://made.up/in/tests"');
    const urls = linksIn(dir, (p) => p.startsWith("test/"));
    expect(urls.sort()).toEqual(["https://liquipedia.net/rocketleague/Air_Dribble", "https://www.reddit.com/r/RocketLeague/", "https://www.youtube.com/watch?v=rlAirD0001d"]);
    const fake = (async (u: string) => ({ ok: !/oembed/.test(u) && !/reddit/.test(u), status: /oembed/.test(u) ? 400 : /reddit/.test(u) ? 403 : 200, body: null })) as unknown as typeof fetch;
    const c = await checkLinks(urls, { fetcher: fake });
    expect(c.pass).toBe(false);
    expect(c.dead.map((d) => d.url)).toEqual(["https://www.youtube.com/watch?v=rlAirD0001d"]);
    expect(c.dead[0].note).toMatch(/no such YouTube video/);
    expect(c.unknown).toBe(1);
  });
});

describe("the tests are tried before they are locked", () => {
  it("reads the names a test imports from each relative module", () => {
    expect(relativeImports('import { a, b as c } from "../src/x.js";\nimport d from "../src/d.js";\nimport "./setup.js";\nconst { e } = await import("../src/e.js");')).toEqual([
      { spec: "../src/x.js", names: ["a", "b"] }, { spec: "../src/d.js", names: [] }, { spec: "./setup.js", names: [] }, { spec: "../src/e.js", names: ["e"] },
    ]);
  });

  it("passes sound tests against stubs and flags a file that breaks on its own", async () => {
    const dir = tmp("sf-dry-");
    mkdirSync(join(dir, "test"));
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    writeFileSync(join(dir, "test", "good.test.js"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { score, Game } from "../src/game.js";\nconst g = new Game();\ntest("scores", () => { assert.equal(score(g), 3); });\n');
    writeFileSync(join(dir, "test", "bad.test.js"), 'import { test } from "node:test";\nimport { score } from "../src/game.js";\ntest("scores", () => {});\ngame.start();\n');
    const problems = await dryRunTests(dir, ["test/good.test.js", "test/bad.test.js"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^test\/bad\.test\.js: .*game is not defined/);
  });

  it("names a locked file that fails as a whole while tests in it passed", () => {
    const run = { cases: [
      { name: "counts", file: "test/a.test.js", pass: true, durationMs: 1 },
      { name: "test/a.test.js", file: "test/a.test.js", pass: false, error: "test failed: ReferenceError: game is not defined", durationMs: 1 },
      { name: "test/b.test.js", file: "test/b.test.js", pass: false, error: "Cannot find module ../src/b.js", durationMs: 1 },
    ], passed: 1, failed: 2, exitCode: 1, timedOut: false, output: "" };
    expect(lockedTestFaults(run, (p) => p.startsWith("test/")).map((c) => c.file)).toEqual(["test/a.test.js"]);
  });
});

describe("every screen in a real browser", () => {
  const browser = findBrowser();
  it.runIf(!!browser)("opens each screen of a built app and names the one that breaks", async () => {
    const log = new EventLog();
    const f = new Factory(log, new MockRuntime({ plantBug: false }), tmp("sf-proj-"));
    const run = f.start("count words", { autoApprove: true });
    await f.wait(run);
    const dir = events(log, "factory.run.finished").at(-1).dir;
    let good: ScreenCheck | null = null;
    expect((await probeStart(dir, 15_000, async (url) => { good = await checkScreens(url, { browser }); return []; }))).toEqual([]);
    const g = good as unknown as ScreenCheck;
    expect(g.skipped).toBeUndefined();
    expect(g.screens.map((s) => s.route)).toEqual(expect.arrayContaining(["home", "e/piece", "e/piece/new", "system"]));
    expect(g.pass).toBe(true);
    // A view that throws: the kit shows its error box, and the check names the screen.
    writeFileSync(join(dir, "web", "app.js"), readFileSync(join(dir, "web", "app.js"), "utf8").replace("const pieces = store.list(\"piece\");", "const pieces = store.list(\"piece\"); game;"));
    let bad: ScreenCheck | null = null;
    await probeStart(dir, 15_000, async (url) => { bad = await checkScreens(url, { browser }); return []; });
    const b = bad as unknown as ScreenCheck;
    expect(b.pass).toBe(false);
    expect(screenCase(b).error).toMatch(/#\/home: .*game is not defined/);
  }, 120_000);

  it("starts the browser without the Windows app-health shim, and finds Edge where Windows puts it", () => {
    const env = browserEnv({ PATH: "x", __COMPAT_LAYER: "DetectorsAppHealth" });
    expect(env.PATH).toBe("x");
    expect("__COMPAT_LAYER" in env).toBe(false);
  });

  it("reads routes and problems from a dumped screen", () => {
    expect(routesOf('<nav class="kit-nav"><a href="#/home">O</a><a href="#/e/piece">P</a><a href="#/system">S</a></nav>')).toEqual(["home", "e/piece", "system"]);
    expect(screenProblem("<div id=\"app\"></div>", [])).toMatch(/did not start/);
    expect(screenProblem('<div class="kit-app"><main class="kit-main"><div class="kit-error"><h2>Board could not draw</h2><pre>x is not defined</pre></div></main></div>', [])).toBe("Board could not draw: x is not defined");
    expect(screenProblem('<div class="kit-app"><main class="kit-main"><h1>Hi</h1></main></div>', [])).toBeNull();
  });
});

describe("discovery: the idea becomes a designed product before any plan", () => {
  const good = { coverage: 5, journey: 4, screens: 4, originality: 4, buildable: 5 };
  const docs = (home: string) => ({
    brief: { who: "A Rocket League player stuck at Platinum.", problem: "Guides are scattered and not sorted by level.", promise: "Shows the three things worth practising today.", notThis: ["a wiki"] },
    research: [{ finding: "Air dribbles are taught by the community, not the game.", source: "https://liquipedia.net/rocketleague/Air_Dribble" }],
    journeys: [{ moment: "A normal day", goal: "Know what to practise", steps: ["Open Today", "Pick a drill", "Log the session"] }],
    screens: [{ id: "dashboard", name: home, purpose: "The three drills for today.", shows: ["drills"], actions: ["start a drill"] }, { id: "tree", name: "Skill tree", purpose: "Where I stand.", shows: ["skills"], actions: ["open a skill"] }],
    requirements: [{ id: "R1", text: "Rank what to practise by the player's level", from: "person", must: true }, { id: "R2", text: "A streak counter", from: "design", must: false }],
    assumptions: [],
  });
  const block = (j: unknown) => "```json\n" + JSON.stringify(j) + "\n```";
  function crewWith(critiques: Record<string, number>[]) {
    const mock = new MockRuntime({ plantBug: false });
    const seen: { station: string; req: AgentRequest }[] = [];
    let designs = 0, crits = 0;
    const rt: AgentRuntime = { name: "mock", run: async (req) => {
      const r = await mock.run(req);
      const st = station(req);
      seen.push({ station: st, req });
      if (st === "design") r.text = block(docs(`Today v${++designs}`));
      if (st === "critique" && !/you check a plan/.test(req.prompt)) {
        const scores = critiques[Math.min(crits++, critiques.length - 1)];
        r.text = block({ scores, problems: scores.screens < 4 ? [{ where: "screens/tree", problem: "The skill tree is only a list.", fix: "Draw it as a tree with locked branches." }] : [] });
      }
      return r;
    } };
    return { rt, seen };
  }

  it("the Critic sends the design back until every score reaches the bar; the Planner then plans from the documents", async () => {
    const log = new EventLog();
    const { rt, seen } = crewWith([{ ...good, screens: 2 }, good]);
    const f = new Factory(log, rt, tmp("sf-proj-"));
    const run = f.start("a coach for one game", { autoApprove: true, autoRetries: 0, maxUsd: 5 });
    await f.wait(run);
    const fin = events(log, "factory.run.finished").at(-1);
    expect(fin.outcome).toBe("shipped");
    const rounds = events(log, "factory.discovery");
    expect(rounds.map((r) => r.pass)).toEqual([false, true]);
    // Round 2: the Designer got its own documents and the Critic's problem, not a blank page.
    const designs = seen.filter((x) => x.station === "design");
    expect(designs).toHaveLength(2);
    expect(designs[1].req.prompt).toMatch(/Today v1/);
    expect(designs[1].req.prompt).toMatch(/only a list.*Draw it as a tree/s);
    // The Critic never sees the Designer's reasoning, only the person's words and the documents.
    expect(seen.find((x) => x.station === "critique")!.req.prompt).toMatch(/a coach for one game/);
    // The Planner plans from the documents that passed.
    const plan = seen.find((x) => x.station === "plan")!.req.prompt;
    expect(plan).toMatch(/Product documents/);
    expect(plan).toMatch(/Today v2/);
    expect(plan).toMatch(/R1: Rank what to practise/);
    // They live in the project for every later agent and the person.
    expect(readFileSync(join(fin.dir, "docs/product/SCREENS.md"), "utf8")).toMatch(/Today v2/);
    expect(readFileSync(join(fin.dir, "docs/product/REQUIREMENTS.md"), "utf8")).toMatch(/Rank what to practise/);
    expect(readFileSync(join(fin.dir, "docs/product/BRIEF.md"), "utf8")).toMatch(/stuck at Platinum/);
    // The station order on the floor.
    const order = events(log, "factory.station").filter((s) => s.state === "pass").map((s) => s.station);
    expect(order.indexOf("discover")).toBeLessThan(order.indexOf("plan"));
  });

  it("stops after three rounds, goes on with the best-scored documents and says why", async () => {
    const log = new EventLog();
    const { rt, seen } = crewWith([{ ...good, screens: 2 }, { ...good, screens: 3 }, { ...good, screens: 2 }]);
    const f = new Factory(log, rt, tmp("sf-proj-"));
    const run = f.start("a coach for one game", { autoApprove: true, autoRetries: 0, maxUsd: 5 });
    await f.wait(run);
    expect(seen.filter((x) => x.station === "design")).toHaveLength(3);
    const last = events(log, "factory.discovery").at(-1);
    expect(last).toMatchObject({ pass: false, round: 2, settled: "still under the bar after 3 rounds" });
    expect(seen.find((x) => x.station === "plan")!.req.prompt).toMatch(/Today v2/);
    expect(events(log, "factory.run.finished").at(-1).outcome).toBe("shipped");
  });

  it("the core decides from the scores: a missing score fails, and unusable documents are refused", () => {
    expect(critiquePasses(validateCritique({ scores: good }))).toBe(true);
    expect(critiquePasses(validateCritique({ scores: { ...good, originality: 3 } }))).toBe(false);
    expect(validateCritique({ scores: { coverage: 5 } }).scores.journey).toBe(1);
    expect(() => validateDocs({ ...docs("Today"), screens: [docs("Today").screens[0]] })).toThrow(/at least two screens/);
    expect(() => validateDocs({ ...docs("Today"), journeys: [] })).toThrow(/no journey/);
  });

  it("the next version of a shipped app keeps its design: no discovery", async () => {
    const log = new EventLog();
    const { rt, seen } = crewWith([good]);
    const f = new Factory(log, rt, tmp("sf-proj-"));
    const run = f.start("a coach for one game", { autoApprove: true, autoRetries: 0, maxUsd: 5 });
    await f.wait(run);
    const before = seen.filter((x) => x.station === "design").length;
    const next = f.addFeature(run, "add a weekly summary", { autoApprove: true, autoRetries: 0, maxUsd: 5 });
    await f.wait(next);
    expect(seen.filter((x) => x.station === "design").length).toBe(before);
    expect(events(log, "factory.station").some((s) => s.run === next && s.station === "discover" && s.state === "skipped")).toBe(true);
  });
});
