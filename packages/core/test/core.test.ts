import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { writeFileSync, chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, captureSignal, listSignals, MockRuntime, ClaudeCodeRuntime, parseClaudeJson, runAgent, costSummary, createCore } from "../src/index.js";

describe("event log and signals", () => {
  it("stores every message as an immutable Signal, in order", () => {
    const log = new EventLog();
    captureSignal(log, "Idea: a factory game\nIMPORTANT: approval stations minimal");
    captureSignal(log, "another thought", "paste");
    const s = listSignals(log);
    expect(s.map((x) => x.text)).toEqual(["Idea: a factory game\nIMPORTANT: approval stations minimal", "another thought"]);
    expect(s[1].source).toBe("paste");
    expect(s[0].id).toBeLessThan(s[1].id);
  });

  it("rejects empty input", () => {
    expect(() => captureSignal(new EventLog(), "   ")).toThrow();
  });

  it("finds signals with full-text search", () => {
    const log = new EventLog();
    captureSignal(log, "use Tauri for the shell");
    captureSignal(log, "the star map shows projects as systems");
    expect(log.searchSignals("tauri").map((e) => (e.payload as { text: string }).text)).toEqual(["use Tauri for the shell"]);
  });

  it("persists across reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-"));
    const path = join(dir, "f.db");
    const a = new EventLog(path); captureSignal(a, "remember me"); a.close();
    const b = new EventLog(path);
    expect(listSignals(b).map((s) => s.text)).toEqual(["remember me"]);
    b.close();
  });
});

describe("agent runtime", () => {
  it("lean profile skips MCP and tools, sets model and budget", () => {
    const args = new ClaudeCodeRuntime({ profile: "lean" }).buildArgs({ prompt: "hi", model: "haiku", budgetUsd: 0.1, pluginDirs: ["/p/superpowers"] });
    expect(args).toEqual(["-p", "hi", "--output-format", "json", "--model", "haiku", "--max-budget-usd", "0.1", "--plugin-dir", "/p/superpowers", "--strict-mcp-config", "--tools", ""]);
  });

  it("full profile loads everything installed", () => {
    const args = new ClaudeCodeRuntime({ profile: "full" }).buildArgs({ prompt: "hi" });
    expect(args).not.toContain("--strict-mcp-config");
  });

  it("parses the CLI's JSON result including cost and context size", () => {
    const r = parseClaudeJson(JSON.stringify({ result: "pong", total_cost_usd: 0.0011, duration_ms: 900, usage: { input_tokens: 2, cache_creation_input_tokens: 5000, cache_read_input_tokens: 800 }, modelUsage: { "claude-haiku-5-5": {} } }), "x", 1);
    expect(r).toMatchObject({ text: "pong", costUsd: 0.0011, durationMs: 900, contextTokens: 5802, models: ["claude-haiku-5-5"] });
  });

  it("surfaces CLI errors", () => {
    expect(() => parseClaudeJson(JSON.stringify({ is_error: true, result: "Authentication error" }), "x", 1)).toThrow("Authentication error");
  });

  it("runs a real child process end to end (fake claude binary)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-bin-"));
    const bin = join(dir, "claude");
    writeFileSync(bin, `#!/usr/bin/env node\nconst p=process.argv[process.argv.indexOf('-p')+1];console.log(JSON.stringify({result:'echo:'+p,total_cost_usd:0.002,duration_ms:5,usage:{input_tokens:1},modelUsage:{'fake-model':{}}}))\n`);
    chmodSync(bin, 0o755);
    const r = await new ClaudeCodeRuntime({ command: bin }).run({ prompt: "ping" });
    expect(r.text).toBe("echo:ping");
    expect(r.costUsd).toBe(0.002);
  });
});

describe("agent runs are logged with cost", () => {
  it("records start and completion, and sums cost", async () => {
    const log = new EventLog();
    await runAgent(log, new MockRuntime(), "overseer", { prompt: "hello" });
    const failing = { name: "broken", run: async () => { throw new Error("boom"); } };
    const bad = await runAgent(log, failing, "overseer", { prompt: "x" });
    expect(bad.error).toBe("boom");
    expect(log.list().map((e) => e.type)).toEqual(["agent.run.started", "agent.run.completed", "agent.run.started", "agent.run.failed"]);
    expect(costSummary(log)).toEqual({ runs: 1, failed: 1, totalUsd: 0, lastUsd: 0 });
  });
});

describe("core HTTP API", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  async function start() {
    const log = new EventLog();
    const runtime = new MockRuntime();
    server = createServer(createCore({ log, runtime }));
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as { port: number };
    return { base: `http://127.0.0.1:${port}`, runtime };
  }

  it("captures, lists and searches signals", async () => {
    const { base } = await start();
    const post = await fetch(`${base}/api/signals`, { method: "POST", body: JSON.stringify({ text: "build the star map" }) });
    expect(post.status).toBe(201);
    expect((await (await fetch(`${base}/api/signals`)).json()).length).toBe(1);
    expect((await (await fetch(`${base}/api/signals?q=star`)).json()).length).toBe(1);
  });

  it("runs the Overseer with a budget cap and reports cost", async () => {
    const { base, runtime } = await start();
    const res = await fetch(`${base}/api/agent/run`, { method: "POST", body: JSON.stringify({ prompt: "status?" }) });
    expect(res.status).toBe(200);
    expect(runtime.calls[0].budgetUsd).toBe(0.25);
    expect(runtime.calls[0].systemPrompt).toContain("Overseer");
    expect((await (await fetch(`${base}/api/cost`)).json()).runs).toBe(1);
  });

  it("streams events to the UI", async () => {
    const { base } = await start();
    await fetch(`${base}/api/signals`, { method: "POST", body: JSON.stringify({ text: "first" }) });
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain('"signal.captured"');
    ctrl.abort();
  });
});
