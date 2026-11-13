import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ClaudeCodeRuntime, EventLog, Factory, MockRuntime, parseFileBlocks, runTests, git, type AgentRequest, type AgentRuntime } from "../src/index.js";
import { WORKBENCH_COMMANDS, restoreProtected, testDispute, changedFiles, hasWorkbench } from "../src/factory/workbench.js";
import { modelFloorUsd, strongerModel } from "../src/factory/loop.js";
import { dryRunTests, lockedTestFaults, relativeImports } from "../src/factory/testcheck.js";
import { initRepo, commitAll } from "../src/factory/workspace.js";
import { probeStart } from "../src/factory/appkit.js";
import { checkScreens, findBrowser, routesOf, screenCase, screenProblem, type ScreenCheck } from "../src/factory/screencheck.js";

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

  it("reads routes and problems from a dumped screen", () => {
    expect(routesOf('<nav class="kit-nav"><a href="#/home">O</a><a href="#/e/piece">P</a><a href="#/system">S</a></nav>')).toEqual(["home", "e/piece", "system"]);
    expect(screenProblem("<div id=\"app\"></div>", [])).toMatch(/did not start/);
    expect(screenProblem('<div class="kit-app"><main class="kit-main"><div class="kit-error"><h2>Board could not draw</h2><pre>x is not defined</pre></div></main></div>', [])).toBe("Board could not draw: x is not defined");
    expect(screenProblem('<div class="kit-app"><main class="kit-main"><h1>Hi</h1></main></div>', [])).toBeNull();
  });
});
