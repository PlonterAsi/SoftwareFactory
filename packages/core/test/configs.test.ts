import { describe, expect, it, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { EventLog, MockRuntime, createCore } from "../src/index.js";
import { runAgent } from "../src/agents.js";
import { buildInventory, configHash, diffConfig, type ConfigInputs } from "../src/configs/inventory.js";
import { ranWith, setConfigSource, stampConfig } from "../src/configs/stamp.js";
import { ClaudeCodeRuntime } from "../src/runtime.js";

const stops: (() => void)[] = [];
afterAll(() => stops.forEach((s) => s()));

function inputs(over: Partial<ConfigInputs> = {}): ConfigInputs {
  return {
    agents: [], slots: { council: [] }, flows: [], plugins: [], skills: [{ name: "tdd", source: "bundled" }], mcp: [{ name: "playwright", source: "bundled" }],
    advisor: { model: "opus", minBudgetUsd: 0.25 }, crewMode: "real", autoWork: { on: true, maxUsd: 1.5, askedMaxUsd: 3, dailyUsd: 10, wip: 1 },
    personalSettings: false, env: {}, ...over,
  };
}

describe("the configuration inventory", () => {
  it("puts every piece in a layer and says where it came from", () => {
    const e = buildInventory(inputs({ env: { SF_ADVISOR: "opus", SF_GEMINI_KEY: "abc", SF_PORT: "4317" } }));
    const byId = Object.fromEntries(e.map((x) => [x.id, x]));
    expect(byId.advisor.layer).toBe("who");
    expect(byId.advisor.source.kind).toBe("scout");
    expect(byId["auto-work"].layer).toBe("how");
    expect(byId["auto-work"].detail).toContain("$10 a day");
    expect(byId.isolation.on).toBe(true);
    expect(byId["skill:tdd"].on).toBe(false); // no agent loads it
    expect(byId["switch:SF_ADVISOR"].detail).toBe("= opus");
    expect(byId["switch:SF_GEMINI_KEY"].detail).toBe("Set (value hidden)");
    expect(byId["switch:SF_PORT"]).toBeUndefined();
  });

  it("gives the same fingerprint to the same setup, and names what changed", () => {
    const a = buildInventory(inputs());
    const b = buildInventory(inputs({ advisor: { model: null, minBudgetUsd: 0.25 }, personalSettings: true }));
    expect(configHash(a)).toBe(configHash(buildInventory(inputs())));
    expect(configHash(a)).not.toBe(configHash(b));
    const d = diffConfig(a, b);
    expect(d.changed.map((c) => c.id).sort()).toEqual(["advisor", "isolation"]);
  });
});

describe("Ran with", () => {
  it("stamps every call with its setup and keeps each setup once", async () => {
    const log = new EventLog();
    let advisor: string | null = "opus";
    setConfigSource(log, () => buildInventory(inputs({ advisor: { model: advisor, minBudgetUsd: 0.25 } })));
    const rt = new MockRuntime({ delayMs: 0 });
    await runAgent(log, rt, "tester", { prompt: "a" }, { factoryRun: 7 });
    await runAgent(log, rt, "tester", { prompt: "b" }, { factoryRun: 7 });
    advisor = null;
    await new Promise((r) => setTimeout(r, 5));
    await runAgent(log, rt, "tester", { prompt: "c" }, { factoryRun: 7 });
    const snaps = log.db.prepare("SELECT count(*) AS n FROM events WHERE type = 'config.snapshot'").get() as { n: number };
    expect(snaps.n).toBe(2);
    const r = ranWith(log, { factoryRun: 7 });
    expect(r.setups.map((s) => s.calls)).toEqual([2, 1]);
    expect(r.setups[1].sameAsNow).toBe(true);
    expect(r.setups[0].sinceThen?.changed.map((c) => c.id)).toEqual(["advisor"]);
  });

  it("never fails a call when the setup cannot be read", async () => {
    const log = new EventLog();
    setConfigSource(log, () => { throw new Error("boom"); });
    expect(stampConfig(log)).toBeNull();
    const run = await runAgent(log, new MockRuntime({ delayMs: 0 }), "tester", { prompt: "x" });
    expect(run.error).toBeUndefined();
  });
});

describe("the crew is kept apart from the person's own Claude Code", () => {
  it("gives an agent editing a repo only project and local settings, unless SF_CREW_PERSONAL_SETTINGS=1", () => {
    const rt = new ClaudeCodeRuntime({ profile: "lean" });
    const args = rt.buildArgs({ prompt: "hi", tools: ["Read", "Edit"], cwd: "/proj" });
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("project,local");
    process.env.SF_CREW_PERSONAL_SETTINGS = "1";
    try {
      expect(rt.buildArgs({ prompt: "hi", tools: ["Read", "Edit"], cwd: "/proj" })).not.toContain("--setting-sources");
    } finally { delete process.env.SF_CREW_PERSONAL_SETTINGS; }
  });
});

describe("the Configuration API", () => {
  it("lists the live setup by layer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-config-"));
    const log = new EventLog(":memory:");
    const core = createCore({ log, runtime: new MockRuntime({ delayMs: 0 }), projectsDir: join(dir, "projects"), order: { mode: "heuristic" } });
    const server: Server = createServer(core);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    stops.push(() => { core.launcher.stopAll(); server.close(); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const j = await (await fetch(`${base}/api/config`)).json();
    expect(j.layers.map((l: { id: string }) => l.id)).toEqual(["how", "who", "where"]);
    expect(j.entries.some((e: { id: string }) => e.id === "agent:builder")).toBe(true);
    expect(j.entries.some((e: { id: string }) => e.id.startsWith("flow:"))).toBe(true);
    expect(j.hash).toMatch(/^[0-9a-f]{12}$/);
    const bad = await fetch(`${base}/api/config/ran`);
    expect(bad.status).toBe(400);
    const none = await (await fetch(`${base}/api/config/ran?run=1`)).json();
    expect(none.setups).toEqual([]);
  });
});
