import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ClaudeCodeRuntime, EventLog, Factory, MockRuntime, parseFileBlocks, runTests, git, type AgentRequest, type AgentRuntime } from "../src/index.js";
import { WORKBENCH_COMMANDS, restoreProtected, testDispute, changedFiles, hasWorkbench } from "../src/factory/workbench.js";
import { modelFloorUsd, strongerModel } from "../src/factory/loop.js";
import { checkLinks, linksIn } from "../src/factory/linkcheck.js";
import { critiquePasses, validateCritique, validateDocs } from "../src/factory/discovery.js";
import { evaluationPasses, validateEvaluation } from "../src/factory/evaluate.js";
import { readScreens } from "../src/factory/screencheck.js";
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
    const run = f.start("count words", { autoApprove: true, autoRetries: 0, maxUsd: 2.5 });
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

  it("a Reviewer that runs out of budget at the workbench reviews by reading instead of stopping the run (run 3185)", async () => {
    const { reviewCapUsd } = await import("../src/factory/loop.js");
    expect([reviewCapUsd(0.2, 1.5), reviewCapUsd(0.2, 10), reviewCapUsd(0.2, 50)]).toEqual([0.2, 1, 1]);
    const log = new EventLog();
    const mock = new MockRuntime({ plantBug: false });
    const reviews: AgentRequest[] = [];
    const crew: AgentRuntime = { name: "claude-code:fake", run: async (req) => {
      if (station(req) === "review") {
        reviews.push(req);
        if (reviews.length === 1) throw new Error("claude exited 1: error_max_budget_usd");
      }
      return mock.run(req);
    } };
    const f = new Factory(log, crew, tmp("sf-proj-"));
    const run = f.start("count words", { autoApprove: true, autoRetries: 0, maxUsd: 10 });
    await f.wait(run);
    expect(events(log, "factory.run.finished").at(-1).outcome).toBe("shipped");
    expect(events(log, "factory.gate").some((g) => g.gate === "escalation")).toBe(false);
    // The first call may spend five times the Reviewer's own $0.20 on a $10 run; the second runs nothing.
    expect(reviews[0].budgetUsd).toBe(1);
    expect(reviews[1].tools).toEqual([]);
    expect(reviews[1].prompt).toMatch(/do not run anything: review by reading/);
    expect(events(log, "factory.continued").some((c) => c.station === "review" && /reviews by reading/.test(c.reason))).toBe(true);
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
    expect(events(log, "factory.plan.gaps")[0].added).toBe(true);
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

describe("the build loop: one feature per fresh session", () => {
  const write = (cwd: string, fs: { path: string; content: string }[]) => { for (const f of fs) { mkdirSync(dirname(join(cwd, f.path)), { recursive: true }); writeFileSync(join(cwd, f.path), f.content); } };
  /** A fake real crew: each build call does its one feature at the workbench (writes files in the folder). */
  function featureCrew(onFeature?: (id: string, nth: number, cwd: string, files: { path: string; content: string }[]) => boolean) {
    const mock = new MockRuntime({ plantBug: false });
    const builds: AgentRequest[] = [];
    const seen: Record<string, number> = {};
    const rt: AgentRuntime = { name: "claude-code:fake", run: async (req) => {
      const r = await mock.run(req);
      if (station(req) !== "build") return r;
      builds.push(req);
      const files = parseFileBlocks(r.text);
      const id = req.prompt.match(/Your feature, (F\d+)/)?.[1] ?? "";
      seen[id] = (seen[id] ?? 0) + 1;
      if (!onFeature?.(id, seen[id], req.cwd!, files)) {
        if (id === "F1") write(req.cwd!, files.filter((f) => f.path !== "src/count.js"));
        else if (id === "F2") write(req.cwd!, files.filter((f) => f.path === "src/count.js"));
        else write(req.cwd!, [{ path: "web/style.css", content: `/* ${id} */\n` + (files.find((f) => f.path === "web/style.css")?.content ?? "") }]);
      }
      r.text = `Built ${id}.\nNext call: reuse countWords from src/count.js.`;
      return r;
    } };
    return { rt, builds };
  }

  it("opens the app in a browser after each screen feature and hands a screen that does not draw back to its builder", async () => {
    const log = new EventLog();
    const { rt, builds } = featureCrew();
    const f = new Factory(log, rt, tmp("sf-proj-"));
    let checks = 0;
    f.checkScreens = async () => (++checks === 1
      ? { pass: false, screens: [{ route: "dashboard", ok: false, problem: "Cannot read properties of undefined (reading 'game')" }, { route: "manage", ok: true }] }
      : { pass: true, screens: [{ route: "dashboard", ok: true }] });
    const run = f.start("count words", { autoApprove: true, autoRetries: 0, maxUsd: 10 });
    await f.wait(run);
    const feats = events(log, "factory.feature").filter((e) => e.id === "F3" && e.state !== "building");
    expect(feats.map((e) => e.state)).toEqual(["broken", "built"]);
    expect(feats[0].crashed[0]).toMatch(/#\/dashboard: Cannot read properties of undefined/);
    const f3 = builds.filter((b) => /Your feature, F3/.test(b.prompt));
    expect(f3).toHaveLength(2);
    expect(f3[1].prompt).toMatch(/real browser[\s\S]*reading 'game'/);
    // The model and logic features have no screen of their own to open.
    expect(checks).toBe(3);
  });

  it("hands a schema the app cannot start on, and a made-up link, back to the session that wrote them (run 3185)", async () => {
    const log = new EventLog();
    const { rt, builds } = featureCrew((id, nth, cwd, files) => {
      if (id !== "F2") return false;
      // The first try leaves a field the app kit refuses and a video link from memory; the second puts the schema right.
      write(cwd, files.filter((f) => f.path === "src/count.js" || f.path === "src/schema.js").map((f) => f.path !== "src/schema.js" || nth > 1 ? f : { path: f.path, content: f.content.replace(/name: "(\w+)"/, 'name: "band override", link: "https://www.youtube.com/watch?v=rl-wave-dash", was: "$1"') }));
      return true;
    });
    const f = new Factory(log, rt, tmp("sf-proj-"));
    const asked: string[][] = [];
    f.checkLinks = async (urls) => { asked.push(urls); const dead = urls.filter((u) => /rl-wave-dash/.test(u)).map((url) => ({ url, ok: false as const, status: 404 })); return { pass: !dead.length, checked: urls.length, dead, unknown: 0 }; };
    const old = process.env.SF_LINK_CHECK;
    process.env.SF_LINK_CHECK = "on";
    try {
      const run = f.start("count words", { autoApprove: true, autoRetries: 0, maxUsd: 10 });
      await f.wait(run);
    } finally { process.env.SF_LINK_CHECK = old; }
    const f1 = events(log, "factory.feature").filter((e) => e.id === "F2" && e.state !== "building");
    expect(f1.map((e) => e.state)).toEqual(["broken", "built"]);
    expect(f1[0].invalid.join("\n")).toMatch(/src\/schema\.js: an entity has no valid name/);
    expect(f1[0].deadLinks[0]).toMatch(/rl-wave-dash \(in src\/schema\.js\)/);
    const again = builds.filter((b) => /Your feature, F2/.test(b.prompt))[1];
    expect(again.prompt).toMatch(/app kit refuses the schema[\s\S]*Never write a link from memory/);
    expect(asked.flat().filter((u) => /rl-wave-dash/.test(u))).toHaveLength(1);
    const retro = events(log, "factory.retro").at(-1);
    expect(retro.bad.join("\n")).toMatch(/F2 .* reported done while the app could not start/);
  });

  it("puts the plan's entity and field names into the spelling the app kit accepts (run 3185)", async () => {
    const { kitName, validatePlan } = await import("../src/factory/loop.js");
    expect([kitName("band_min"), kitName("Band Override"), kitName("rankScale"), kitName("2nd-best_video"), kitName("")]).toEqual(["bandMin", "bandOverride", "rankScale", "ndBestVideo", "field"]);
    const plan = validatePlan({ name: "Game Mastery", slug: "game-mastery", summary: "s", interface: "i", acceptance: ["a"], tasks: [{ id: "T1", title: "t", dependsOn: [] }],
      entities: [{ name: "plan_block", fields: [{ name: "band_min", type: "number" }, { name: "game_ref", type: "ref", to: "Game" }] }, { name: "Game", fields: [{ name: "title", type: "text" }] }] } as never);
    expect(plan.entities!.map((e) => [e.name, ...e.fields.map((f) => f.name)])).toEqual([["planBlock", "bandMin", "gameRef"], ["game", "title"]]);
    expect(plan.entities![0].fields[1].to).toBe("game");
    const { CONTRACTS } = await import("../src/bay/builtin.js");
    expect(CONTRACTS.plan).toMatch(/lowerCamelCase.*never "band_min"/);
  });

  it("builds the plan as a list of features, each in its own call, with the list and the progress on disk", async () => {
    const log = new EventLog();
    const { rt, builds } = featureCrew();
    const f = new Factory(log, rt, tmp("sf-proj-"));
    const run = f.start("count words", { autoApprove: true, autoRetries: 0, maxUsd: 10 });
    await f.wait(run);
    const fin = events(log, "factory.run.finished").at(-1);
    expect(fin.outcome).toBe("shipped");
    // Foundation, logic, and one per view: the plan's own, plus the designed screen the Planner left out (the core adds it).
    expect(builds.map((b) => b.prompt.match(/Your feature, (F\d+)/)?.[1])).toEqual(["F1", "F2", "F3", "F4"]);
    // Each call gets its one feature and the pointers to the spine, not the whole spec and all the tests pasted in.
    expect(builds[2].prompt).toMatch(/ONE feature \(F3, number 3 of 4\)/);
    expect(builds[2].prompt).toMatch(/Screen: Progress/);
    expect(builds[2].prompt).toMatch(/features\.json.*PROGRESS\.md/s);
    expect(builds[2].prompt).not.toMatch(/Locked acceptance tests:/);
    // Each call is capped at its share of the build budget, never above the Builder's own cap.
    expect(builds.every((b) => (b.budgetUsd ?? 9) <= 0.6 && (b.budgetUsd ?? 0) >= 0.15)).toBe(true);
    // The spine: the list (all built, with the tests passing after each) and what each session left for the next.
    const list = JSON.parse(readFileSync(join(fin.dir, "features.json"), "utf8")).features;
    expect(list.map((x: any) => x.state)).toEqual(["built", "built", "built", "built"]);
    expect(readFileSync(join(fin.dir, "PROGRESS.md"), "utf8")).toMatch(/## F2 The domain logic: built[\s\S]*reuse countWords/);
    // A commit per feature.
    expect(git(fin.dir, "log", "--format=%s")).toMatch(/Feature F3: Screen: Progress[\s\S]*Feature F2: The domain logic[\s\S]*Feature F1/);
    // The logic feature is where the locked tests go green; the core saw it.
    const built = events(log, "factory.feature").filter((e) => e.state === "built");
    expect(built.map((e) => e.id)).toEqual(["F1", "F2", "F3", "F4"]);
    expect(built[0].failed).toBeGreaterThan(0);
    expect(built[1].failed).toBe(0);
  });

  it("a feature that breaks a test that passed before is sent back once with that evidence", async () => {
    const log = new EventLog();
    const { rt, builds } = featureCrew((id, nth, cwd) => {
      // The screen feature's first attempt breaks the logic the tests check.
      if (id !== "F3" || nth !== 1) return false;
      write(cwd, [{ path: "src/count.js", content: "export function countWords() { return -1; }\nexport function progress() { return -1; }\n" }]);
      return true;
    });
    const f = new Factory(log, rt, tmp("sf-proj-"));
    const run = f.start("count words", { autoApprove: true, autoRetries: 0, maxUsd: 10 });
    await f.wait(run);
    const feats = events(log, "factory.feature").filter((e) => e.id === "F3" && e.state !== "building");
    expect(feats.map((e) => e.state)).toEqual(["regressed", "regressed"]);
    expect(feats[0].broke.length).toBeGreaterThan(0);
    const f3 = builds.filter((b) => /Your feature, F3/.test(b.prompt));
    expect(f3).toHaveLength(2);
    expect(f3[1].prompt).toMatch(/passed before your call and fail after it/);
    // Still broken after the second try: it goes on, and the test and fix loop takes it from there.
    expect(events(log, "factory.station").some((s) => s.station === "fix")).toBe(true);
  });

  it("a small run still builds in one call", async () => {
    const log = new EventLog();
    const { rt, builds } = featureCrew((_id, _n, cwd, files) => { write(cwd, files); return true; });
    const f = new Factory(log, rt, tmp("sf-proj-"));
    const run = f.start("count words", { autoApprove: true, autoRetries: 0, maxUsd: 0.6 });
    await f.wait(run);
    expect(builds).toHaveLength(1);
    expect(events(log, "factory.feature")).toHaveLength(0);
  });
});

describe("the product judge: the running app is judged as a product", () => {
  const block = (j: unknown) => "```json\n" + JSON.stringify(j) + "\n```";
  const docs = {
    brief: { who: "A writer.", problem: "No idea how far along each piece is.", promise: "Shows each piece against its goal.", notThis: [] },
    research: [], assumptions: [],
    journeys: [{ moment: "A normal day", goal: "See progress", steps: ["Open Progress", "Add words"] }],
    screens: [{ id: "dashboard", name: "Progress", purpose: "Each piece against its goal.", shows: ["a bar per piece"], actions: ["add a piece"] }, { id: "log", name: "Session log", purpose: "What I wrote when.", shows: ["sessions"], actions: ["log a session"] }],
    requirements: [{ id: "R1", text: "A bar per piece against its goal", from: "person", must: true }, { id: "R2", text: "A session log with date and minutes", from: "person", must: true }, { id: "R3", text: "Confetti", from: "design", must: false }],
  };
  /** The judge's look at one screen just built: every S/A item of it met, unless `missing` names it. */
  const lookAnswer = (prompt: string, missing: string[] = []) => block({ requirements: [...prompt.matchAll(/^- ([SA]\d+): /gm)].map((m) => ({ id: m[1], met: !missing.includes(m[1]), evidence: missing.includes(m[1]) ? "The screen shows only a heading" : "Shown with sample pieces" })), scores: { function: 4, design: 4, content: 4 }, problems: [] });
  function crewWith(verdicts: { r2: boolean }[], look?: (prompt: string, nth: number) => string) {
    const mock = new MockRuntime({ plantBug: false });
    const seen: { station: string; req: AgentRequest }[] = [];
    let n = 0;
    let looks = 0;
    const rt: AgentRuntime = { name: "mock", run: async (req) => {
      const r = await mock.run(req);
      const st = station(req);
      seen.push({ station: st, req });
      if (st === "design") r.text = block(docs);
      if (st === "evaluate" && /This is a look at ONE screen/.test(req.prompt)) { r.text = look ? look(req.prompt, ++looks) : lookAnswer(req.prompt); return r; }
      if (st === "evaluate") {
        const v = verdicts[Math.min(n++, verdicts.length - 1)];
        r.text = block({ requirements: [{ id: "R1", met: true, evidence: "Progress shows 3 bars" }, { id: "R2", met: v.r2, evidence: v.r2 ? "Session log lists 2 sessions" : "There is no session log screen" }], scores: { function: v.r2 ? 4 : 2, design: 4, content: 4 }, problems: v.r2 ? [] : [{ where: "navigation", problem: "The Session log screen is missing.", fix: "Add the log view." }] });
      }
      return r;
    } };
    return { rt, seen };
  }
  const screens = [{ route: "home", text: "Progress Morning pages 12 / 50", controls: ["New piece"] }];

  it("with a real crew and a product budget, what the judge found is built as features in fresh sessions, then judged again", async () => {
    const log = new EventLog();
    const { rt: inner, seen } = crewWith([{ r2: false }, { r2: true }]);
    const rt: AgentRuntime = { name: "claude-code:fake", run: async (req) => {
      const r = await inner.run(req);
      if (station(req) === "build" && req.cwd) {
        const id = req.prompt.match(/Your feature, ([FJ]\d+)/)?.[1] ?? "";
        const files = parseFileBlocks(r.text);
        for (const f of id === "F1" || id === "F2" ? files : [{ path: "web/style.css", content: `/* ${id} */\n` + (files.find((x) => x.path === "web/style.css")?.content ?? "") }]) { mkdirSync(dirname(join(req.cwd, f.path)), { recursive: true }); writeFileSync(join(req.cwd, f.path), f.content); }
        r.text = `Built ${id}.`;
      }
      return r;
    } };
    const f = new Factory(log, rt, tmp("sf-proj-"));
    f.readScreens = async () => screens;
    const run = f.start("a writing desk", { autoApprove: true, autoRetries: 0, maxUsd: 10 });
    await f.wait(run);
    expect(events(log, "factory.run.finished").at(-1).outcome).toBe("shipped");
    expect(events(log, "factory.evaluation").map((e) => e.pass)).toEqual([false, true]);
    const repair = events(log, "factory.repair");
    expect(repair).toHaveLength(1);
    expect(repair[0].features[0].title).toMatch(/^Judge: requirements R2/);
    const j1 = seen.filter((x) => x.station === "build" && /Your feature, J1/.test(x.req.prompt));
    expect(j1).toHaveLength(1);
    expect(j1[0].req.prompt).toMatch(/R2: A session log with date and minutes[\s\S]*There is no session log screen/);
    expect(events(log, "factory.feature").filter((e) => e.id === "J1" && e.state === "built")).toHaveLength(1);
  });

  it("looks at each screen just after it is built and hands what is missing back to the same builder (cycle 4)", async () => {
    const log = new EventLog();
    // The first look at a screen finds its first shown item missing; every later look finds it all.
    const { rt: inner, seen } = crewWith([{ r2: true }], (prompt, nth) => lookAnswer(prompt, nth === 1 ? ["S1"] : []));
    const rt: AgentRuntime = { name: "claude-code:fake", run: async (req) => {
      const r = await inner.run(req);
      if (station(req) === "build" && req.cwd) {
        const id = req.prompt.match(/Your feature, ([FJ]\d+)/)?.[1] ?? "";
        const files = parseFileBlocks(r.text);
        for (const f of id === "F1" || id === "F2" ? files : [{ path: "web/style.css", content: `/* ${id} */\n` + (files.find((x) => x.path === "web/style.css")?.content ?? "") }]) { mkdirSync(dirname(join(req.cwd, f.path)), { recursive: true }); writeFileSync(join(req.cwd, f.path), f.content); }
        r.text = `Built ${id}.`;
      }
      return r;
    } };
    const f = new Factory(log, rt, tmp("sf-proj-"));
    f.readScreens = async () => [{ route: "dashboard", text: "Progress", controls: [] }, ...screens];
    const run = f.start("a writing desk", { autoApprove: true, autoRetries: 0, maxUsd: 10 });
    await f.wait(run);
    const looks = events(log, "factory.screen.look");
    expect(looks.length).toBeGreaterThanOrEqual(1);
    expect(looks[0]).toMatchObject({ screen: "dashboard", seen: 1, of: 2 });
    expect(looks[0].missing[0]).toMatch(/Progress screen shows a bar per piece[\s\S]*only a heading/);
    const feats = events(log, "factory.feature").filter((e) => e.id === looks[0].feature && e.state !== "building");
    expect(feats.map((e) => e.state)).toEqual(["broken", "built"]);
    expect(feats[0].hollow[0]).toMatch(/bar per piece/);
    const again = seen.filter((x) => x.station === "build" && x.req.prompt.includes(`Your feature, ${looks[0].feature}`))[1];
    expect(again.req.prompt).toMatch(/product judge opened the running app[\s\S]*bar per piece/);
    // The judge reads only that screen, at a small cap.
    const ask = seen.find((x) => x.station === "evaluate" && /look at ONE screen/.test(x.req.prompt))!;
    expect(ask.req.prompt).toMatch(/=== Screen #\/dashboard ===/);
    expect(ask.req.prompt).not.toMatch(/=== Screen #\/home ===/);
    expect(events(log, "factory.retro").at(-1).bad.join("\n")).toMatch(/judge did not find on its screen/);
    // After the retry the judge looks again, and this time it all shows.
    const mine = looks.filter((l) => l.feature === looks[0].feature);
    expect(mine.map((l) => [l.attempt, l.seen, l.of])).toEqual([[1, 1, 2], [2, 2, 2]]);
    expect(events(log, "factory.retro").at(-1).good.join("\n")).toMatch(/every screen sent back had what was missing on the second look/);
  });

  it("a screen still hollow after its retry is not taken on the Builder's word (run 3609)", async () => {
    const log = new EventLog();
    const { rt: inner } = crewWith([{ r2: true }], (prompt) => lookAnswer(prompt, ["S1"]));
    const rt: AgentRuntime = { name: "claude-code:fake", run: async (req) => {
      const r = await inner.run(req);
      if (station(req) === "build" && req.cwd) {
        const id = req.prompt.match(/Your feature, ([FJ]\d+)/)?.[1] ?? "";
        const files = parseFileBlocks(r.text);
        for (const f of id === "F1" || id === "F2" ? files : [{ path: "web/style.css", content: `/* ${id} */\n` + (files.find((x) => x.path === "web/style.css")?.content ?? "") }]) { mkdirSync(dirname(join(req.cwd, f.path)), { recursive: true }); writeFileSync(join(req.cwd, f.path), f.content); }
        r.text = `Built ${id}.`;
      }
      return r;
    } };
    const f = new Factory(log, rt, tmp("sf-proj-"));
    f.readScreens = async () => [{ route: "dashboard", text: "Progress", controls: [] }, ...screens];
    const run = f.start("a writing desk", { autoApprove: true, autoRetries: 0, maxUsd: 10 });
    await f.wait(run);
    const first = events(log, "factory.screen.look").find((l) => !l.skipped)!;
    const feats = events(log, "factory.feature").filter((e) => e.id === first.feature && e.state !== "building");
    expect(feats.map((e) => [e.attempt, e.state])).toEqual([[1, "broken"], [2, "broken"]]);
    const retro = events(log, "factory.retro").at(-1);
    expect(retro.bad.join("\n")).toMatch(/still missed designed items on the second look \(dashboard: 1 of 2/);
  });

  it("finds the designed screen for a view by its name when the Planner renamed its id (run 3609)", async () => {
    const { designScreenFor } = await import("../src/factory/features.js");
    const d = { ...docs, screens: [{ ...docs.screens[0], id: "progress", name: "My Games" }, docs.screens[1]] } as never;
    expect(designScreenFor(d, "my-games", "My Games")?.id).toBe("progress");
    expect(designScreenFor(d, "session_log", "Session Log")?.id).toBe("log");
    expect(designScreenFor(d, "Log")?.id).toBe("log");
    expect(designScreenFor(d, "practice", "Practice")).toBeUndefined();
    expect(designScreenFor(d, "dashboard")?.id).toBe("progress");
  });

  it("a repair that cannot finish never fails the run: the build gate gets what is built (run 3609)", async () => {
    const log = new EventLog();
    const { rt: inner } = crewWith([{ r2: false }, { r2: false }]);
    const rt: AgentRuntime = { name: "claude-code:fake", run: async (req) => {
      if (station(req) === "build" && /Your feature, J\d+/.test(req.prompt)) {
        // The repair writes half a file and dies at its cap, every time.
        if (req.cwd) writeFileSync(join(req.cwd, "web/half.js"), "export const half = ");
        throw new Error("claude exited 1: error_max_budget_usd");
      }
      const r = await inner.run(req);
      if (station(req) === "build" && req.cwd) {
        const id = req.prompt.match(/Your feature, ([FJ]\d+)/)?.[1] ?? "";
        const files = parseFileBlocks(r.text);
        for (const f of id === "F1" || id === "F2" ? files : [{ path: "web/style.css", content: `/* ${id} */\n` + (files.find((x) => x.path === "web/style.css")?.content ?? "") }]) { mkdirSync(dirname(join(req.cwd, f.path)), { recursive: true }); writeFileSync(join(req.cwd, f.path), f.content); }
        r.text = `Built ${id}.`;
      }
      return r;
    } };
    const f = new Factory(log, rt, tmp("sf-proj-"));
    f.readScreens = async () => screens;
    const run = f.start("a writing desk", { autoApprove: true, autoRetries: 0, maxUsd: 10 });
    await f.wait(run).catch(() => {});
    expect(events(log, "factory.run.finished").at(-1).outcome).toBe("shipped");
    const stopped = events(log, "factory.repair.stopped");
    expect(stopped[0].reason).toMatch(/a repair call failed: .*error_max_budget_usd/);
    const fin = events(log, "factory.run.finished").at(-1);
    expect(existsSync(join(fin.dir, "web/half.js"))).toBe(false);
    expect(events(log, "factory.retro").at(-1).bad.join("\n")).toMatch(/Repair: stopped/);
  });

  it("a repair the money left cannot fund does not start (run 3609)", async () => {
    const log = new EventLog();
    const { rt: inner, seen } = crewWith([{ r2: false }, { r2: false }]);
    const rt: AgentRuntime = { name: "claude-code:fake", run: async (req) => {
      const r = await inner.run(req);
      if (station(req) === "build" && req.cwd) {
        const id = req.prompt.match(/Your feature, ([FJ]\d+)/)?.[1] ?? "";
        const files = parseFileBlocks(r.text);
        for (const f of id === "F1" || id === "F2" ? files : [{ path: "web/style.css", content: `/* ${id} */\n` + (files.find((x) => x.path === "web/style.css")?.content ?? "") }]) { mkdirSync(dirname(join(req.cwd, f.path)), { recursive: true }); writeFileSync(join(req.cwd, f.path), f.content); }
        r.text = `Built ${id}.`;
        // The first repair eats the whole repair pool.
        if (/^J/.test(id)) r.costUsd = 5;
      }
      return r;
    } };
    const f = new Factory(log, rt, tmp("sf-proj-"));
    f.readScreens = async () => screens;
    const run = f.start("a writing desk", { autoApprove: true, autoRetries: 0, maxUsd: 10 });
    await f.wait(run).catch(() => {});
    expect(events(log, "factory.run.finished").at(-1).outcome).toBe("shipped");
    const repairs = seen.filter((x) => x.station === "build" && /Your feature, J\d+/.test(x.req.prompt));
    expect(repairs).toHaveLength(1);
    expect(events(log, "factory.repair.stopped")[0]).toMatchObject({ reason: expect.stringMatching(/left for repairs, under the \$0\.30 one needs/) });
  });

  it("a review that still says fix after its last round is recorded and goes first into the repair features (run 3185)", async () => {
    const log = new EventLog();
    const { rt: inner, seen } = crewWith([{ r2: false }, { r2: true }]);
    const rt: AgentRuntime = { name: "claude-code:fake", run: async (req) => {
      const r = await inner.run(req);
      if (station(req) === "review") r.text = block({ verdict: "fix", findings: [{ severity: "high", text: "Needs a look matches are never saved" }], criteria: [{ text: "Research merges keep every item", pass: false, evidence: "merge dropped 3 of 5 items" }] });
      if (station(req) === "build" && req.cwd) {
        const id = req.prompt.match(/Your feature, ([FJ]\d+)/)?.[1] ?? "";
        const files = parseFileBlocks(r.text);
        for (const f of id === "F1" || id === "F2" ? files : [{ path: "web/style.css", content: `/* ${id} */\n` + (files.find((x) => x.path === "web/style.css")?.content ?? "") }]) { mkdirSync(dirname(join(req.cwd, f.path)), { recursive: true }); writeFileSync(join(req.cwd, f.path), f.content); }
        r.text = `Built ${id}.`;
      }
      return r;
    } };
    const f = new Factory(log, rt, tmp("sf-proj-"));
    f.readScreens = async () => screens;
    const run = f.start("a writing desk", { autoApprove: true, autoRetries: 0, maxUsd: 10 });
    await f.wait(run);
    expect(events(log, "factory.review.open")).toMatchObject([{ round: 2, failing: ["Research merges keep every item"], findings: ["Needs a look matches are never saved"] }]);
    expect(events(log, "factory.station").filter((s) => s.station === "review").at(-1).note).toMatch(/still "fix" after 2 reviews: 1 criteria failing/);
    const repair = events(log, "factory.repair")[0];
    expect(repair.features.map((x: any) => x.title)).toEqual(["Judge: what the Reviewer proved still broken", expect.stringMatching(/^Judge: requirements R2/), "Judge: what a user would notice"]);
    const j0 = seen.find((x) => x.station === "build" && /Your feature, J0/.test(x.req.prompt))!;
    expect(j0.req.prompt).toMatch(/Research merges keep every item[\s\S]*merge dropped 3 of 5[\s\S]*Needs a look matches are never saved/);
  });

  it("a run resumed after its build still turns the judge's findings into repair features (run 3185)", async () => {
    const log = new EventLog();
    const dir = tmp("sf-proj-");
    const { rt: inner } = crewWith([{ r2: false }, { r2: true }]);
    let hang = true;
    const rt: AgentRuntime = { name: "claude-code:fake", run: async (req) => {
      if (hang && station(req) === "review") return new Promise(() => {});
      const r = await inner.run(req);
      if (station(req) === "build" && req.cwd) {
        const id = req.prompt.match(/Your feature, ([FJ]\d+)/)?.[1] ?? "";
        const files = parseFileBlocks(r.text);
        for (const f of id === "F1" || id === "F2" ? files : [{ path: "web/style.css", content: `/* ${id} */\n` + (files.find((x) => x.path === "web/style.css")?.content ?? "") }]) { mkdirSync(dirname(join(req.cwd, f.path)), { recursive: true }); writeFileSync(join(req.cwd, f.path), f.content); }
        r.text = `Built ${id}.`;
      }
      return r;
    } };
    const first = new Factory(log, rt, dir);
    const run = first.start("a writing desk", { autoApprove: true, autoRetries: 0, maxUsd: 10 });
    for (let i = 0; i < 1000 && !events(log, "agent.run.started").some((a) => a.station === "review"); i++) await new Promise((r) => setTimeout(r, 10));
    // The app restarts during the review: a new core on the same database picks the run up.
    hang = false;
    const second = new Factory(log, rt, dir);
    second.readScreens = async () => screens;
    expect(second.resumeInterrupted()).toEqual([run]);
    await second.wait(run);
    expect(events(log, "factory.evaluation").map((e) => e.pass)).toEqual([false, true]);
    expect(events(log, "factory.repair")).toHaveLength(1);
  });

  it("an unmet requirement goes back to the fix loop as work, and the app is judged again", async () => {
    const log = new EventLog();
    const { rt, seen } = crewWith([{ r2: false }, { r2: true }]);
    const f = new Factory(log, rt, tmp("sf-proj-"));
    f.readScreens = async () => screens;
    const run = f.start("a writing desk", { autoApprove: true, autoRetries: 0, maxUsd: 5 });
    await f.wait(run);
    expect(events(log, "factory.run.finished").at(-1).outcome).toBe("shipped");
    const evs = events(log, "factory.evaluation");
    expect(evs.map((e) => e.pass)).toEqual([false, true]);
    // The judge sees the person's words, the design and the screens; never the code.
    const judge = seen.find((x) => x.station === "evaluate")!.req.prompt;
    expect(judge).toMatch(/a writing desk/);
    expect(judge).toMatch(/R2: A session log/);
    expect(judge).not.toMatch(/R3/);
    expect(judge).toMatch(/=== Screen #\/home ===\nProgress Morning pages 12 \/ 50\nControls: New piece/);
    expect(judge).not.toMatch(/<<<FILE/);
    // The Fixer got the failure as concrete work.
    const fix = seen.filter((x) => x.station === "fix").at(-1)!.req.prompt;
    expect(fix).toMatch(/Requirement R2 is not met: A session log with date and minutes/);
    expect(fix).toMatch(/There is no session log screen/);
    // Order: review, then the judge, then the build gate.
    const order = events(log, "factory.station").filter((s) => s.state === "pass").map((s) => s.station);
    expect(order.lastIndexOf("review")).toBeLessThan(order.indexOf("evaluate"));
  });

  it("what is still open after the second look is put in front of the person at the build gate", async () => {
    const log = new EventLog();
    const { rt } = crewWith([{ r2: false }]);
    const f = new Factory(log, rt, tmp("sf-proj-"));
    f.readScreens = async () => screens;
    const run = f.start("a writing desk", { autoRetries: 0, maxUsd: 5 });
    for (let i = 0; i < 400; i++) {
      const g = events(log, "factory.gate").at(-1);
      if (g?.state === "waiting" && g.gate === "gateB") break;
      if (g?.state === "waiting") f.decide(run, g.gate, { approve: true });
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(events(log, "factory.evaluation")).toHaveLength(2);
    expect(events(log, "factory.gate").at(-1).question).toMatch(/product judge: 1 of 2 requirements not seen working/);
    f.decide(run, "gateB", { approve: true });
    await f.wait(run);
  });

  it("no browser, no verdict: the judge is skipped and says so, it never guesses", async () => {
    const log = new EventLog();
    const { rt, seen } = crewWith([{ r2: true }]);
    const f = new Factory(log, rt, tmp("sf-proj-"));
    const run = f.start("a writing desk", { autoApprove: true, autoRetries: 0, maxUsd: 5 });
    await f.wait(run);
    expect(seen.some((x) => x.station === "evaluate")).toBe(false);
    expect(events(log, "factory.evaluation")[0]).toMatchObject({ pass: false, skipped: expect.stringMatching(/could not be read/) });
    expect(events(log, "factory.station").some((s) => s.station === "evaluate" && s.state === "skipped")).toBe(true);
  });

  it("the core decides: a requirement the judge skipped is not met, and a missing score fails", () => {
    const e = validateEvaluation({ requirements: [{ id: "R1", met: true, evidence: "x" }], scores: { function: 5, design: 5, content: 5 } }, docs as any);
    expect(e.requirements.map((r) => [r.id, r.met])).toEqual([["R1", true], ["R2", false]]);
    expect(evaluationPasses(e)).toBe(false);
    const ok = validateEvaluation({ requirements: [{ id: "R1", met: true, evidence: "x" }, { id: "R2", met: true, evidence: "y" }], scores: { function: 4, design: 4 } }, docs as any);
    expect(ok.scores.content).toBe(1);
    expect(evaluationPasses(ok)).toBe(false);
  });

  it("with no browser there are no screens to read", async () => {
    expect(await readScreens("http://127.0.0.1:1", { browser: null })).toBeNull();
  });
});

describe("what run 2898 taught the engine", () => {
  it("keeps a long requirement whole, so the Critic never judges text the engine cut", async () => {
    const { validateDocs, DOC_LIMITS } = await import("../src/factory/discovery.js");
    const long = `${"The knowledge list ranks every item by its fit to the player's level. ".repeat(7)}End.`;
    expect(long.length).toBeGreaterThan(300);
    expect(long.length).toBeLessThanOrEqual(DOC_LIMITS.requirementChars);
    const docs = validateDocs({
      brief: { who: "a player", promise: "the few best things to learn next" },
      journeys: [{ moment: "A normal day", goal: "practise", steps: ["open", "pick"] }],
      screens: [{ id: "today", name: "Today" }, { id: "tree", name: "Skill tree" }],
      requirements: Array.from({ length: 34 }, (_, i) => ({ id: `R${i + 1}`, text: long })),
      rules: [{ name: "Today's three", rule: "Pick the three highest ranked items the player has not marked as got it; ties go to the newest." }, "A plain string rule also counts."],
    });
    expect(docs.requirements).toHaveLength(34);
    expect(docs.requirements[33]!.text.endsWith("End.")).toBe(true);
    expect(docs.rules).toHaveLength(2);
  });

  it("keeps a rule with a table whole, and text over the limit ends at a whole sentence (run 3185)", async () => {
    const { validateDocs, keepWhole, DOC_LIMITS } = await import("../src/factory/discovery.js");
    const table = `Level bands. ${"Rocket League: Bronze to Gold is beginner, Platinum to Champion is intermediate. ".repeat(14)}If an item has no band, add the item to Needs a look.`;
    expect(table.length).toBeGreaterThan(800);
    const base = { brief: { who: "a player", promise: "p" }, journeys: [{ moment: "m", steps: ["s"] }], screens: [{ id: "a", name: "A" }, { id: "b", name: "B" }], requirements: ["r"] };
    expect(validateDocs({ ...base, rules: [{ name: "Level bands", rule: table }] }).rules[0]!.rule).toBe(table);
    const over = validateDocs({ ...base, rules: [{ name: "Ranking", rule: "Rank by fit to level, then by freshness. ".repeat(100) }] }).rules[0]!.rule;
    expect(over.length).toBeLessThanOrEqual(DOC_LIMITS.ruleChars);
    expect(over.endsWith("freshness.")).toBe(true);
    expect(keepWhole("one two three four five six", 20)).toBe("one two three four");
    const { CONTRACTS } = await import("../src/bay/builtin.js");
    expect(CONTRACTS.design).toContain("2,400 characters");
  });

  it("gives the Planner and the project the product's rules", async () => {
    const { validateDocs, docsForPlanner, docsFiles } = await import("../src/factory/discovery.js");
    const docs = validateDocs({
      brief: { who: "a player", promise: "p" }, journeys: [{ moment: "m", steps: ["s"] }],
      screens: [{ id: "a", name: "A" }, { id: "b", name: "B" }], requirements: ["r"],
      rules: [{ name: "Ranking", rule: "Score is relevance times freshness." }],
    });
    expect(docsForPlanner(docs)).toContain("Ranking: Score is relevance times freshness.");
    expect(docsFiles("idea", docs, null).find((f) => f.path.endsWith("REQUIREMENTS.md"))!.content).toContain("## Rules");
    // Documents saved before rules existed still load.
    expect(() => docsForPlanner({ ...docs, rules: undefined as never })).not.toThrow();
  });

  it("tries a call once more when the CLI's sign-in check fails at start, and only then", async () => {
    const { EventLog } = await import("../src/events.js");
    const { runAgent } = await import("../src/agents.js");
    process.env.SF_SIGNIN_RETRY_MS = "1";
    const log = new EventLog(":memory:");
    let calls = 0;
    const flaky = { name: "flaky", run: async () => { if (++calls === 1) throw new Error("Not logged in · Please run /login"); return { text: "ok", costUsd: 0.01, durationMs: 1 }; } };
    const r = await runAgent(log, flaky as never, "visionary", { prompt: "x" });
    expect(r.result?.text).toBe("ok");
    expect(log.list({ type: "agent.run.retried" })).toHaveLength(1);
    calls = 0;
    const down = { name: "down", run: async () => { calls++; throw new Error("Not logged in · Please run /login"); } };
    const r2 = await runAgent(log, down as never, "visionary", { prompt: "x" });
    expect(calls).toBe(2);
    expect(r2.error).toContain("not signed in");
    calls = 0;
    const other = { name: "other", run: async () => { calls++; throw new Error("Agent timed out after 5 ms"); } };
    await runAgent(log, other as never, "visionary", { prompt: "x" });
    expect(calls).toBe(1);
    delete process.env.SF_SIGNIN_RETRY_MS;
  });
  it("keeps all six designed screens in the plan, and adds the ones the Planner left out", async () => {
    const { validatePlan, withDesignedScreens } = await import("../src/factory/loop.js");
    const { validateDocs } = await import("../src/factory/discovery.js");
    const names = ["Library", "Game Today", "Skill Tree", "Knowledge", "Practice", "Progress"];
    const docs = validateDocs({
      brief: { who: "a player", promise: "p" }, journeys: [{ moment: "m", steps: ["s"] }], requirements: ["r"],
      screens: names.map((n) => ({ id: n.toLowerCase().replace(/ /g, "-"), name: n, purpose: `The ${n} job.`, shows: ["a"], actions: ["b"] })),
    });
    const base = { name: "GM", slug: "gm", summary: "s", interface: "i", acceptance: ["a"], tasks: [{ id: "t1", title: "t" }] };
    const six = validatePlan({ ...base, views: names.map((n, i) => ({ id: i ? n.toLowerCase().replace(/ /g, "-") : "dashboard", label: n, shows: "x" })) } as never);
    expect(six.views).toHaveLength(6);
    expect(withDesignedScreens(six, docs).added).toEqual([]);
    const four = validatePlan({ ...base, views: six.views!.slice(0, 4) } as never);
    const fixed = withDesignedScreens(four, docs);
    expect(fixed.added).toEqual(["Practice", "Progress"]);
    expect(fixed.plan.views!.map((v) => v.label)).toEqual(names);
    expect(fixed.plan.views![4]!.shows).toContain("The Practice job.");
  });
  it("makes a real crew's Designer research before it designs, and asks again when nothing has a source", async () => {
    const mock = new MockRuntime({ plantBug: false });
    const asked: string[] = [];
    let n = 0;
    const rt: AgentRuntime = { name: "claude-code:fake", run: async (req) => {
      if (/This time you only research/.test(req.prompt)) {
        asked.push(req.prompt);
        const r = await mock.run({ ...req, prompt: "x" });
        r.text = ++n === 1
          ? '```json\n{"research": [{"finding": "From memory, no page."}]}\n```'
          : '```json\n{"research": [{"finding": "Players learn the air dribble from community videos.", "source": "https://example.com/air-dribble"}, {"finding": "A made-up source is dropped.", "source": "a forum"}]}\n```';
        return r;
      }
      if (/Station contract: design\./.test(req.systemPrompt ?? "")) asked.push(req.prompt);
      return mock.run(req);
    } };
    const log = new EventLog();
    const f = new Factory(log, rt, tmp("sf-proj-"));
    const run = f.start("count words", { autoApprove: true, autoRetries: 0, maxUsd: 2.5 });
    await f.wait(run);
    const res = events(log, "factory.research");
    expect(res).toHaveLength(1);
    expect(res[0].sourced).toBe(1);
    expect(res[0].findings[1].source).toBeUndefined();
    // Two research calls (the first had no source), then the design call that carries the findings and may not search.
    expect(asked[1]).toMatch(/an answer from memory is not research/);
    expect(asked[2]).toMatch(/Research done for this design[\s\S]*https:\/\/example\.com\/air-dribble[\s\S]*Do not search the web on this call/);
  });
  it("checks the links in the app's code, not in its seeded data store, and says which file each is in", async () => {
    const { linkFiles, linkCase } = await import("../src/factory/linkcheck.js");
    const dir = tmp("sf-links-");
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "src/schema.js"), 'export const seed = [{ video: "https://www.youtube.com/watch?v=real123" }];');
    writeFileSync(join(dir, "data/db.json"), '{"items":[{"video":"https://www.youtube.com/watch?v=example1"}]}');
    const where = linkFiles(dir, () => false);
    expect(where).toEqual({ "https://www.youtube.com/watch?v=real123": "src/schema.js" });
    const c = linkCase({ pass: false, checked: 1, unknown: 0, dead: [{ url: "https://www.youtube.com/watch?v=real123", ok: false, note: "no such YouTube video", file: "src/schema.js" }] });
    expect(c.error).toContain("(in src/schema.js)");
  });
  it("gives a product run time in proportion to its budget, and leaves a small run's limit alone", async () => {
    const { runMinutes } = await import("../src/factory/stoprules.js");
    expect(runMinutes(1.5)).toBe(30);
    expect(runMinutes(0.6, 20)).toBe(20);
    expect(runMinutes(10)).toBe(150);
    expect(runMinutes(10, 0.01)).toBeLessThan(1);
    expect(runMinutes(100)).toBe(240);
  });

  it("turns what the product judge found into build features, the person's own asks first, within what the budget allows", async () => {
    const { repairFeatures } = await import("../src/factory/evaluate.js");
    const { validateDocs } = await import("../src/factory/discovery.js");
    const docs = validateDocs({
      brief: { who: "a player", promise: "p" }, journeys: [{ moment: "m", steps: ["s"] }], screens: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
      requirements: [...Array.from({ length: 7 }, (_, i) => ({ id: `R${i + 1}`, text: `Thing ${i + 1}`, from: i === 6 ? "person" : "design" })), { id: "R8", text: "Extra", from: "design", must: false }],
    });
    const e = { requirements: docs.requirements.map((r) => ({ id: r.id, met: r.id === "R1", evidence: r.id === "R1" ? "seen" : "not on any screen" })), scores: { function: 2, design: 2, content: 2 }, problems: [{ where: "today", problem: "Lists 2 things, not 3", fix: "Show three" }] };
    const all = repairFeatures(e, docs, 9);
    expect(all.map((f) => f.id)).toEqual(["J1", "J2", "J3"]);
    // The person's own ask leads; the nice-to-have comes last.
    expect(all[0].title).toMatch(/^Judge: requirements R7, R2, R3, R4, R5$/);
    expect(all[1].title).toMatch(/R6, R8$/);
    expect(all[0].what).toMatch(/R7: Thing 7\n  What the judge saw: not on any screen/);
    expect(all[2].what).toMatch(/\[today\] Lists 2 things, not 3 Fix: Show three/);
    expect(repairFeatures(e, docs, 1)).toHaveLength(1);
    expect(repairFeatures(e, docs, 0)).toEqual([]);
  });
  it("fails a screen that prints a missing value as text, and passes ordinary words", async () => {
    const { screenProblem } = await import("../src/factory/screencheck.js");
    const page = (main: string) => `<div class="kit-app"><main class="kit-main">${main}</main></div>`;
    expect(screenProblem(page("<h1>Library</h1><p>Rocket League</p><span>nullnullnull</span>"), [])).toMatch(/raw "nullnullnull" where a value should be \(near: ".*Rocket League/);
    expect(screenProblem(page("<p>Win rate: NaN%</p>"), [])).toMatch(/raw "NaN"/);
    expect(screenProblem(page("<p>Last session: undefined</p>"), [])).toMatch(/raw "undefined"/);
    expect(screenProblem(page("<p>[object Object]</p>"), [])).toMatch(/object Object/);
    expect(screenProblem(page("<p>Nullify the opponent's pressure. Annulled. Banana.</p>"), [])).toBeNull();
  });

  it("tells the first build session to write real sample content from the research, with only researched links", async () => {
    const { featuresOf } = await import("../src/factory/features.js");
    const { validateDocs } = await import("../src/factory/discovery.js");
    const base = { brief: { who: "a player", promise: "p" }, journeys: [{ moment: "m", steps: ["s"] }], screens: [{ id: "a", name: "A" }, { id: "b", name: "B" }], requirements: ["r"] };
    const plan = { name: "GM", slug: "gm", summary: "s", interface: "i", acceptance: ["a"], tasks: [], entities: [], views: [] } as never;
    const sourced = featuresOf(plan, validateDocs({ ...base, research: [{ finding: "f", source: "https://example.com/guide" }] }))[0].what;
    expect(sourced).toMatch(/real content, not filler[\s\S]*one of the pages listed in that research, copied exactly[\s\S]*Never write a web address from memory/);
    expect(featuresOf(plan, validateDocs(base))[0].what).toMatch(/Leave every link field empty/);
    expect(featuresOf(plan, null)[0].what).not.toMatch(/sample records are real content/);
  });
});

describe("what run 3609 taught the engine", () => {
  it("tells the Designer and the Critic what an app's values can come from, so buildable is judged on real origins", async () => {
    const { CONTRACTS } = await import("../src/bay/builtin.js");
    const { critiquePrompt } = await import("../src/factory/discovery.js");
    expect(CONTRACTS.design).toMatch(/never vote or view counts, video timestamps[\s\S]*Every value a screen shows needs an origin/);
    const docs = { brief: { who: "w", problem: "p", promise: "x", notThis: [] }, research: [], assumptions: [], journeys: [], screens: [], requirements: [] };
    expect(critiquePrompt("idea", docs as never, 1)).toMatch(/buildable: .*every value a screen shows has an origin that can really supply it/);
  });

  it("has the Tester write the person's journeys through the kit's data layer, which is in the folder before the tests", async () => {
    const log = new EventLog();
    const mock = new MockRuntime({ plantBug: false });
    let prompt = "";
    const dir = tmp("sf-proj-");
    const rt: AgentRuntime = { name: "mock", run: async (req) => { if (station(req) === "tests") prompt = req.prompt; return mock.run(req); } };
    const f = new Factory(log, rt, dir);
    const run = f.start("count words", { autoApprove: true, autoRetries: 0 });
    await f.wait(run);
    expect(prompt).toMatch(/test\/journeys\.test\.js[\s\S]*seedDb\(schema\)[\s\S]*createRecord[\s\S]*every sample record/);
    const fin = events(log, "factory.run.finished").at(-1);
    expect(git(fin.dir, "log", "--format=%s").split("\n").slice(-3)).toEqual(["Acceptance tests (locked)", "App kit", "Spec and plan: Word Counter"]);
  });
});
