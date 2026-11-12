import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBay, ClaudeCodeRuntime, EventLog, parseClaudeJson } from "../src/index.js";
import { findSecrets, scanFiles, secretHookFile } from "../src/safety/secrets.js";
import { failureLines } from "../src/factory/trim.js";
import { recall, recallBlock, recallQuery } from "../src/brain/recall.js";
import { overviewBlock } from "../src/tickets/repowork.js";

// Built at run time so this file never holds a real-looking key itself.
const FAKE_GH = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const FAKE_ANT = "sk-ant-" + "api03-" + "x".repeat(40);

describe("SF-17: the secret gate", () => {
  it("finds the keys people leak, and not ordinary code", () => {
    expect(findSecrets(`const token = "${FAKE_GH}";`, "a.js")).toEqual([{ file: "a.js", line: 1, kind: "GitHub token" }]);
    expect(findSecrets(`x\nkey=${FAKE_ANT}`)[0]).toMatchObject({ line: 2, kind: "Anthropic API key" });
    expect(findSecrets("const sk = skip(); const ghp = 1; // AKIA is a prefix")).toEqual([]);
    // The person's own data is not code.
    expect(scanFiles({ "src/a.js": "ok", "data/db.json": FAKE_GH })).toEqual([]);
  });

  it("the Edit/Write hook blocks a file holding a key (exit 2, reason on stderr) and passes a clean one", () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-gate-"));
    const hook = secretHookFile(dir);
    const bad = join(dir, "bad.js"), good = join(dir, "good.js");
    writeFileSync(bad, `export const k = "${FAKE_GH}";\n`);
    writeFileSync(good, "export const k = process.env.KEY;\n");
    const run = (file: string) => {
      try { execFileSync(process.execPath, [hook], { input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: file } }), stdio: ["pipe", "pipe", "pipe"] }); return { code: 0, err: "" }; }
      catch (e: any) { return { code: e.status as number, err: String(e.stderr) }; }
    };
    expect(run(good).code).toBe(0);
    const r = run(bad);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/secret gate.*\n.*bad\.js:1: looks like a GitHub token/s);
  });

  it("repo work runs with the hook; station agents do not need it", () => {
    const rt = new ClaudeCodeRuntime({ profile: "lean" });
    const repo = rt.buildArgs({ prompt: "x", tools: ["Read", "Edit", "Write"], cwd: "/clone" });
    expect(JSON.parse(repo[repo.indexOf("--settings") + 1]).hooks.PostToolUse[0]).toMatchObject({ matcher: "Edit|Write|MultiEdit" });
    expect(rt.buildArgs({ prompt: "x", tools: ["Read"], cwd: "/proj" })).not.toContain("--settings");
  });
});

describe("SF-16: the Fixer reads failure lines, not the whole log", () => {
  it("keeps what failed and where, drops passing chatter and node internals, at most 100 lines", () => {
    const noise = Array.from({ length: 400 }, (_, i) => `ok ${i + 1} - passes ${i}`);
    const out = [...noise.slice(0, 200), "not ok 201 - slugify drops punctuation", "  error: 'Expected values to be strictly equal'", "  expected: 'a-b'", "  actual: 'a b'", "    at TestContext.<anonymous> (file:///p/test/slug.test.js:5:10)", "    at node:internal/test_runner/test:1:1", ...noise.slice(200), "# tests 401", "# pass 400", "# fail 1"].join("\n");
    const t = failureLines(out, 100);
    expect(t.split("\n").length).toBeLessThanOrEqual(100);
    expect(t).toContain("not ok 201 - slugify drops punctuation");
    expect(t).toContain("actual: 'a b'");
    expect(t).toContain("slug.test.js:5:10");
    expect(t).not.toContain("node:internal");
    expect(t).toContain("# fail 1");
    expect(t).not.toContain("ok 17 - passes");
  });

  it("short output passes through as it is", () => {
    expect(failureLines("not ok 1 - x\n# fail 1")).toBe("not ok 1 - x\n# fail 1");
  });
});

describe("SF-22: recall over past notes and decisions", () => {
  it("indexes notes, tickets and Council decisions, and finds the closest ones fast", () => {
    const log = new EventLog();
    log.append("signal.captured", { text: "Game guides must work offline, the person plays on a plane." });
    log.append("ticket.opened", { id: 1, number: 1, kind: "request", title: "Recipe scaler rounds grams", body: "Round to whole grams." });
    log.append("factory.council", { run: 9, round: 1, seats: [], brief: { agreed: ["Store every guide in data/db.json so it works offline."], concerns: [] } });
    expect(recallQuery("The guides, offline!")).toBe('"guides" OR "offline"');
    const t0 = performance.now();
    const hits = recall(log, "a game guide app that works offline");
    expect(performance.now() - t0).toBeLessThan(100);
    expect(hits.map((h) => h.kind)).toEqual(expect.arrayContaining(["note", "Council decision"]));
    expect(hits.some((h) => h.kind === "ticket")).toBe(false);
    expect(recallBlock(log, "offline guides")).toMatch(/^Past notes and decisions that may matter/);
    expect(recallBlock(log, "")).toBe("");
  });
});

describe("SF-18: prompt-cache use per agent", () => {
  it("reads cache tokens from claude's JSON and shows a hit rate per agent", () => {
    const r = parseClaudeJson(JSON.stringify({ result: "hi", total_cost_usd: 0.001, usage: { input_tokens: 100, cache_read_input_tokens: 600, cache_creation_input_tokens: 300 } }), "x", 1);
    expect(r).toMatchObject({ cacheReadTokens: 600, cacheWriteTokens: 300, contextTokens: 1000 });
    const log = new EventLog();
    const bay = new AgentBay(log);
    const s = log.append("agent.run.started", { agent: "skeptic", agentVersion: 1 });
    log.append("agent.run.completed", { runId: s.id, agent: "skeptic", costUsd: 0.001, ...r });
    expect(bay.stats().skeptic.cache).toEqual({ read: 600, write: 300, input: 1000, hitRate: 0.6 });
  });
});

describe("SF-20: the repo Builder starts from the code map", () => {
  it("lists each mapped module's purpose and role, core first, capped", () => {
    const log = new EventLog();
    log.append("repo.module.understood", { projectId: 5, explore: 1, module: "src/ui", hash: "a", purpose: "Screens", role: "ui", risks: [], by: "cartographer" });
    log.append("repo.module.understood", { projectId: 5, explore: 1, module: "src/core", hash: "b", purpose: "Pricing rules", role: "core", risks: ["no tests"], by: "cartographer" });
    const o = overviewBlock(log, 5);
    expect(o).toMatch(/Codebase overview/);
    expect(o.indexOf("src/core")).toBeLessThan(o.indexOf("src/ui"));
    expect(o).toContain("(risks: no tests)");
    expect(overviewBlock(log, 6)).toBe("");
    expect(overviewBlock(log, null)).toBe("");
  });
});
