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
    expect(fin).toMatchObject({ run, outcome: "shipped", fixRounds: 1, agentCalls: 5 });
    expect(fin.totalUsd).toBeCloseTo(0.0005);
    expect(existsSync(join(fin.dir, "SPEC.md"))).toBe(true);
    expect(git(fin.dir, "tag")).toBe("v0.1.0");
    expect(git(fin.dir, "log", "--format=%s").split("\n")).toEqual(["Fix round 1", "Build: Word Counter", "Acceptance tests (locked)", "Spec and plan: Word Counter"]);

    const tests = events(log, "factory.tests");
    expect(tests.map((t) => [t.round, t.passed, t.failed])).toEqual([[0, 2, 1], [1, 3, 0]]);
    const visuals = events(log, "factory.visual");
    expect(visuals.every((v) => v.pass)).toBe(true);
    expect(visuals.map((v) => v.station)).toEqual(["intake", "plan", "tests", "build", "test", "fix", "review", "ship"]);
    // A short, single-ask idea skips the Council; the Reviewer passes with a note for the build gate.
    expect(events(log, "factory.station").find((s) => s.station === "council")).toMatchObject({ state: "skipped" });
    expect(events(log, "factory.review")[0]).toMatchObject({ verdict: "pass", agent: "reviewer" });
    expect(events(log, "factory.gate").find((g) => g.gate === "gateB")?.question).toContain("1 note");
    // Every agent's work got a verdict: the builder's first build failed a test, the fix made it green.
    expect(events(log, "agent.verdict").map((v) => [v.agent, v.pass])).toEqual([["planner", true], ["tester", true], ["builder", false], ["fixer", true], ["reviewer", true]]);
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

  it("escalates when the Fixer changes nothing, and an unattended run stops", async () => {
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
    expect(fin.reason).toContain("The Fixer changed nothing");
  });

  it("closes runs left in flight when the core restarts", () => {
    const log = new EventLog();
    const started = log.append("factory.run.started", { idea: "x" });
    const call = log.append("agent.run.started", { agent: "builder", factoryRun: started.id });
    new Factory(log, new MockRuntime(), tmp("sf-proj-"));
    expect(events(log, "factory.run.finished")).toMatchObject([{ run: started.id, outcome: "stopped" }]);
    expect(events(log, "agent.run.failed")).toMatchObject([{ runId: call.id, error: "The core restarted during this call." }]);
  });
});
