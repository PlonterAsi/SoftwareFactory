import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, Factory, MockRuntime, parseFileBlocks, parseJsonBlock, writeFiles, safePath, runTests, git, validatePlan, type AgentRuntime } from "../src/index.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const events = (log: EventLog, type: string) => log.list({ limit: 1e6 }).filter((e) => e.type === type).map((e) => e.payload as any);

describe("agent output parsing", () => {
  it("reads file blocks, with or without a code fence", () => {
    const files = parseFileBlocks("notes\n<<<FILE src/a.js\nexport const a = 1;\nFILE>>>\n<<<FILE b.md\n```md\n# hi\n```\nFILE>>>");
    expect(files).toEqual([{ path: "src/a.js", content: "export const a = 1;\n" }, { path: "b.md", content: "# hi\n" }]);
  });

  it("accepts the closing tags models get wrong", () => {
    const text = "<<<FILE a.js\nx();\n</FILE>>>\n<<<FILE b.js\ny();\n</FILE>\n<<<FILE c.js\nz();\n>>>FILE\n<<<FILE d.js\nw();\n<<<FILE e.js\nv();";
    expect(parseFileBlocks(text).map((f) => [f.path, f.content])).toEqual([["a.js", "x();\n"], ["b.js", "y();\n"], ["c.js", "z();\n"], ["d.js", "w();\n"], ["e.js", "v();\n"]]);
  });

  it("reads a fenced json block", () => {
    expect(parseJsonBlock<{ a: number }>("here:\n```json\n{\"a\": 1}\n```")).toEqual({ a: 1 });
  });

  it("refuses paths outside the project and edits to locked tests", () => {
    const root = tmp("sf-ws-");
    expect(() => safePath(root, "../x")).toThrow();
    expect(() => safePath(root, "/etc/passwd")).toThrow();
    expect(() => safePath(root, ".git/config")).toThrow();
    const r = writeFiles(root, [{ path: "test/a.test.js", content: "x" }, { path: "src/a.js", content: "y\n" }], { lockTests: true });
    expect(r.refused.map((x) => x.path)).toEqual(["test/a.test.js"]);
    expect(r.written).toEqual([{ path: "src/a.js", lines: 1, bytes: 2, sha256: createHash("sha256").update("y\n").digest("hex") }]);
  });

  it("cleans up a plan and drops unknown task links", () => {
    const p = validatePlan({ name: "X", slug: "My App!", summary: "s", interface: "i", acceptance: ["a"], tasks: [{ id: "t1", title: "a", dependsOn: ["t9"] }], files: [] });
    expect(p.slug).toBe("my-app");
    expect(p.tasks[0].dependsOn).toEqual([]);
  });
});

describe("test runner", () => {
  it("turns node --test into a pass and fail grid", async () => {
    const root = tmp("sf-tr-");
    writeFiles(root, [
      { path: "package.json", content: '{"type":"module"}' },
      { path: "test/a.test.js", content: 'import {test} from "node:test";import assert from "node:assert/strict";test("good",()=>{});test("bad",()=>assert.equal(1,2));' },
    ], { lockTests: false });
    const r = await runTests(root);
    expect(r.cases.map((c) => [c.name, c.pass])).toEqual([["good", true], ["bad", false]]);
    expect(r.cases[1].error).toContain("1 !== 2");
  });

  it("counts a suite that cannot load as a failure", async () => {
    const root = tmp("sf-tr-");
    writeFiles(root, [{ path: "package.json", content: '{"type":"module"}' }, { path: "test/a.test.js", content: 'import { nope } from "../src/missing.js";' }], { lockTests: false });
    const r = await runTests(root);
    expect(r.failed).toBeGreaterThan(0);
  });
});

describe("factory loop", () => {
  it("turns one line into a tested, tagged repo, through a fix round, with every station visualized", async () => {
    const log = new EventLog();
    const f = new Factory(log, new MockRuntime(), tmp("sf-proj-"));
    const run = f.start("a CLI that counts words", { autoApprove: true });
    await f.wait(run);

    const fin = events(log, "factory.run.finished").at(-1);
    expect(fin).toMatchObject({ run, outcome: "shipped", fixRounds: 1, agentCalls: 8 });
    expect(fin.totalUsd).toBeCloseTo(0.0005);
    expect(existsSync(join(fin.dir, "SPEC.md"))).toBe(true);
    expect(git(fin.dir, "tag")).toBe("v0.1.0");
    expect(git(fin.dir, "log", "--format=%s").split("\n")).toEqual(["Fix round 1", "Build: Word Counter", "App kit", "Acceptance tests (locked)", "Spec and plan: Word Counter"]);

    const tests = events(log, "factory.tests");
    // Four locked tests, the app check, the secret gate (SF-17) and the test integrity guard (SF-24), one cell each.
    expect(tests.map((t) => [t.round, t.passed, t.failed])).toEqual([[0, 6, 1], [1, 7, 0]]);
    expect(tests[0].cases.at(-3)).toMatchObject({ name: expect.stringContaining("the app works"), pass: true });
    expect(tests[0].cases.at(-2)).toMatchObject({ name: expect.stringContaining("no secrets"), pass: true });
    expect(tests[0].cases.at(-1)).toMatchObject({ name: expect.stringContaining("tests left intact"), pass: true });
    // What it makes is a real program: an app on the kit that starts with one press, full CRUD, no arguments to guess.
    expect(existsSync(join(fin.dir, "index.html"))).toBe(true);
    expect(existsSync(join(fin.dir, "server.js"))).toBe(true);
    expect(events(log, "factory.ui").every((u) => u.pass && u.app)).toBe(true);
    expect(events(log, "factory.ui")[0].entities).toEqual([{ name: "piece", seeds: 3, crud: true }]);
    expect(JSON.parse(readFileSync(join(fin.dir, "package.json"), "utf8")).scripts.start).toBe("node server.js");
    expect(existsSync(join(fin.dir, "run.json"))).toBe(false);
    expect(readFileSync(join(fin.dir, "SPEC.md"), "utf8")).toContain("## What it manages");
    const visuals = events(log, "factory.visual");
    expect(visuals.every((v) => v.pass)).toBe(true);
    expect(visuals.map((v) => v.station)).toEqual(["intake", "discover", "plan", "tests", "build", "test", "fix", "review", "ship"]);
    // A short, single-ask idea skips the Council; the Reviewer passes with a note for the build gate.
    expect(events(log, "factory.station").find((s) => s.station === "council")).toMatchObject({ state: "skipped" });
    expect(events(log, "factory.review")[0]).toMatchObject({ verdict: "pass", agent: "reviewer" });
    expect(events(log, "factory.gate").find((g) => g.gate === "gateB")?.question).toContain("1 note");
    // Every agent's work got a verdict: the builder's first build failed a test, the fix made it green.
    expect(events(log, "agent.verdict").map((v) => [v.agent, v.pass])).toEqual([["designer", true], ["planner", true], ["tester", true], ["builder", false], ["fixer", true], ["reviewer", true]]);
    expect(events(log, "factory.gate").filter((g) => g.state === "approved").map((g) => g.gate)).toEqual(["gateA", "gateB"]);
    expect(events(log, "agent.run.completed").every((a) => a.factoryRun === run)).toBe(true);
  });

  it("waits at both gates for a human, and re-plans when the plan is rejected with a note", async () => {
    const log = new EventLog();
    const rt = new MockRuntime({ plantBug: false });
    const f = new Factory(log, rt, tmp("sf-proj-"));
    const run = f.start("count words");
    const until = async (gate: string) => { for (let i = 0; i < 200 && f.waitingGate(run) !== gate; i++) await new Promise((r) => setTimeout(r, 10)); expect(f.waitingGate(run)).toBe(gate); };

    await until("gateA");
    expect(f.decide(run, "gateB", { approve: true })).toBe(false);
    expect(f.decide(run, "gateA", { approve: false, note: "call it wc" })).toBe(true);
    await until("gateA");
    expect(rt.calls.filter((c) => c.systemPrompt?.includes("Planner")).at(-1)?.prompt).toContain("call it wc");
    f.decide(run, "gateA", { approve: true });
    await until("gateB");
    f.decide(run, "gateB", { approve: true });
    await f.wait(run);
    expect(events(log, "factory.run.finished").at(-1)).toMatchObject({ outcome: "shipped", fixRounds: 0 });
  });

  it("stops instead of overspending, and never auto-approves more budget", async () => {
    const log = new EventLog();
    const pricey: AgentRuntime = { name: "pricey", run: async (req) => ({ ...(await new MockRuntime().run(req)), costUsd: 1 }) };
    const f = new Factory(log, pricey, tmp("sf-proj-"));
    const run = f.start("count words", { autoApprove: true, maxUsd: 1.5 });
    await f.wait(run);
    const fin = events(log, "factory.run.finished").at(-1);
    expect(fin.outcome).toBe("stopped");
    expect(fin.reason).toBe("Budget spent.");
    expect(fin.agentCalls).toBe(2);
  });

  it("refuses to run tests that changed after they were locked", async () => {
    const log = new EventLog();
    const rt = new MockRuntime();
    // A Builder that tries to rewrite the tests: the write is refused and the run still ships.
    const sneaky: AgentRuntime = { name: "sneaky", run: async (req) => {
      const r = await rt.run(req);
      if (req.systemPrompt?.includes("You are the Builder")) r.text += '\n<<<FILE test/count.test.js\nimport "node:test";\nFILE>>>';
      return r;
    } };
    const f = new Factory(log, sneaky, tmp("sf-proj-"));
    const run = f.start("count words", { autoApprove: true });
    await f.wait(run);
    const build = events(log, "factory.files").find((x) => x.station === "build");
    expect(build.refused).toEqual([{ path: "test/count.test.js", reason: "acceptance tests are locked" }]);
    const fin = events(log, "factory.run.finished").at(-1);
    expect(fin.outcome).toBe("shipped");
    expect(readFileSync(join(fin.dir, "test/count.test.js"), "utf8")).toContain("countWords");
  });

  it("asks the Tester again when its tests do not parse, before locking them", async () => {
    const log = new EventLog();
    const rt = new MockRuntime();
    let testerCalls = 0;
    const flaky: AgentRuntime = { name: "flaky", run: async (req) => {
      const r = await rt.run(req);
      if (req.systemPrompt?.includes("You are the Tester") && ++testerCalls === 1) r.text = "<<<FILE test/count.test.js\nimport { test } from 'node:test';\ntest('x', () => {\nFILE>>>";
      return r;
    } };
    const f = new Factory(log, flaky, tmp("sf-proj-"));
    const run = f.start("count words", { autoApprove: true });
    await f.wait(run);
    expect(testerCalls).toBe(2);
    expect(rt.calls.filter((c) => c.systemPrompt?.includes("Tester")).at(-1)?.prompt).toContain("did not parse");
    expect(events(log, "factory.run.finished").at(-1).outcome).toBe("shipped");
  });

  it("climbs the ladder when the Fixer changes nothing, then an unattended run stops", async () => {
    const log = new EventLog();
    const rt = new MockRuntime();
    const lazy: AgentRuntime = { name: "lazy", run: async (req) => {
      const r = await rt.run(req);
      if (req.systemPrompt?.includes("You are the Fixer")) r.text = "The tests look wrong to me.";
      return r;
    } };
    const f = new Factory(log, lazy, tmp("sf-proj-"));
    const run = f.start("count words", { autoApprove: true, autoRetries: 0 });
    await f.wait(run);
    const fin = events(log, "factory.run.finished").at(-1);
    expect(fin.outcome).toBe("stopped");
    expect(fin.reason).toContain("The same tests failed twice");
    expect(events(log, "factory.files").filter((p) => p.station === "fix").every((p) => p.noChange === "The Fixer changed nothing.")).toBe(true);
  });

  it("closes runs left in flight when the core restarts, as resumable", () => {
    const log = new EventLog();
    const started = log.append("factory.run.started", { idea: "x" });
    const call = log.append("agent.run.started", { agent: "builder", factoryRun: started.id });
    const f = new Factory(log, new MockRuntime(), tmp("sf-proj-"));
    expect(events(log, "factory.run.finished")).toMatchObject([{ run: started.id, outcome: "stopped", resumable: true }]);
    expect(events(log, "agent.run.failed")).toMatchObject([{ runId: call.id, error: "The core restarted during this call." }]);
    expect(f.interrupted).toEqual([started.id]);
  });
});

describe("resuming runs", () => {
  /** A crew that never answers at one station: the app "closes" while it waits. */
  const hangAt = (station: string): AgentRuntime => {
    const rt = new MockRuntime();
    return { name: "mock", run: (req) => (new RegExp(`Station contract: ${station}`).test(req.systemPrompt ?? "") ? new Promise(() => {}) : rt.run(req)) };
  };
  const until = async (pred: () => boolean) => { for (let i = 0; i < 400 && !pred(); i++) await new Promise((r) => setTimeout(r, 10)); expect(pred()).toBe(true); };

  it("picks a run up at the station the app closed on, without redoing finished work", async () => {
    const log = new EventLog();
    const projects = tmp("sf-proj-");
    const first = new Factory(log, hangAt("build"), projects);
    const run = first.start("a CLI that counts words", { autoApprove: true });
    await until(() => events(log, "agent.run.started").some((a) => a.station === "build"));

    // The app closes and opens again: a new core on the same database.
    const rt = new MockRuntime();
    const second = new Factory(log, rt, projects);
    expect(second.resumable(run)).toMatchObject({ ok: true, from: "build" });
    expect(second.resumeInterrupted()).toEqual([run]);
    await second.wait(run);

    expect(events(log, "factory.run.resumed")).toMatchObject([{ run, from: "build", auto: true }]);
    const fin = events(log, "factory.run.finished").at(-1);
    expect(fin).toMatchObject({ run, outcome: "shipped" });
    // Only the stations after the cut were worked again: no second plan or test-writing call.
    expect(rt.calls.map((c) => c.systemPrompt?.match(/Station contract: (\w+)/)?.[1])).toEqual(["build", "fix", "review"]);
    expect(git(fin.dir, "log", "--format=%s").split("\n")).toEqual(["Fix round 1", "Build: Word Counter", "App kit", "Acceptance tests (locked)", "Spec and plan: Word Counter"]);
    // The organized table follows: stopped, then back in flight, then shipped.
    expect(log.db.prepare("SELECT outcome, resumes, resumed_from FROM factory_runs WHERE id = ?").get(run)).toMatchObject({ outcome: "shipped", resumes: 1, resumed_from: "build" });
    // Spend carries over: the calls before the cut still count.
    expect(fin.agentCalls).toBe(9); // design, critique, plan, its coverage check, tests, the cut-off build, then build, fix, review
    expect(fin.totalUsd).toBeCloseTo(0.0005);
  });

  it("waits at the plan gate again when the app closed there, without re-planning", async () => {
    const log = new EventLog();
    const projects = tmp("sf-proj-");
    const first = new Factory(log, new MockRuntime({ plantBug: false }), projects);
    const run = first.start("count words");
    await until(() => first.waitingGate(run) === "gateA");

    const rt = new MockRuntime({ plantBug: false });
    const second = new Factory(log, rt, projects);
    expect(second.resumable(run).from).toBe("gateA");
    second.resume(run);
    await until(() => second.waitingGate(run) === "gateA");
    expect(rt.calls.length).toBe(0);
    second.decide(run, "gateA", { approve: true });
    await until(() => second.waitingGate(run) === "gateB");
    second.decide(run, "gateB", { approve: true });
    await second.wait(run);
    expect(events(log, "factory.run.finished").at(-1)).toMatchObject({ run, outcome: "shipped" });
  });

  it("throws away half-written files from the station that was cut off", async () => {
    const log = new EventLog();
    const projects = tmp("sf-proj-");
    const first = new Factory(log, hangAt("build"), projects);
    const run = first.start("count words", { autoApprove: true });
    await until(() => events(log, "agent.run.started").some((a) => a.station === "build"));
    const dir = events(log, "factory.plan").at(-1).dir;
    writeFiles(dir, [{ path: "src/half.js", content: "export const x = " }], { lockTests: true });

    const second = new Factory(log, new MockRuntime(), projects);
    second.resumeInterrupted();
    await second.wait(run);
    expect(existsSync(join(dir, "src/half.js"))).toBe(false);
    expect(events(log, "factory.run.finished").at(-1).outcome).toBe("shipped");
  });

  it("refuses runs that ended on purpose, and stops auto-resuming a run that keeps dying", async () => {
    const log = new EventLog();
    const projects = tmp("sf-proj-");
    const f = new Factory(log, new MockRuntime(), projects);
    const shipped = f.start("count words", { autoApprove: true });
    await f.wait(shipped);
    expect(f.resumable(shipped)).toMatchObject({ ok: false, why: "It already shipped." });
    expect(() => f.resume(shipped)).toThrow(/cannot resume/);

    const run = new Factory(log, hangAt("build"), projects).start("count words", { autoApprove: true });
    await until(() => events(log, "agent.run.started").some((a) => a.station === "build" && a.factoryRun === run));
    for (let i = 0; i < 3; i++) {
      const g = new Factory(log, hangAt("build"), projects);
      expect(g.resumeInterrupted()).toEqual([run]);
      await until(() => events(log, "agent.run.started").filter((a) => a.station === "build" && a.factoryRun === run).length === i + 2);
    }
    const last = new Factory(log, new MockRuntime(), projects);
    expect(last.resumeInterrupted()).toEqual([]);
    expect(last.resumable(run).ok).toBe(true);
  });
});
