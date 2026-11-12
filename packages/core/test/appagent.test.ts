import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, MockRuntime, AgentBay, installKit } from "../src/index.js";
import { askForApp, appSpentToday } from "../src/factory/appagent.js";
import { projectEnv } from "../src/launch/launcher.js";
import type { AgentRequest } from "../src/runtime.js";

function recording(text: string) {
  const rt = new MockRuntime({ plantBug: false });
  const seen: AgentRequest[] = [];
  rt.run = async (req) => { seen.push(req); return { text, costUsd: 0.03, durationMs: 1, models: ["mock"], runtime: "mock", contextTokens: 0 }; };
  return { rt, seen };
}

describe("app agents", () => {
  it("runs the Researcher from the Agent Bay with its web tools and hands back the json", async () => {
    const log = new EventLog();
    const { rt, seen } = recording("Here you go:\n```json\n{\"genre\": \"metroidvania\", \"terms\": [\"Geo\"]}\n```");
    const bay = new AgentBay(log, rt);
    const r = await askForApp(log, rt, bay, { task: "Research Hollow Knight", input: { name: "Hollow Knight" }, app: "Game Mastery" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ agent: "researcher", json: { genre: "metroidvania", terms: ["Geo"] }, costUsd: 0.03 });
    expect(seen[0].tools).toEqual(["WebSearch", "WebFetch"]);
    expect(seen[0].prompt).toContain("App: Game Mastery");
    expect(seen[0].prompt).toContain("\"name\":\"Hollow Knight\"");
    expect(seen[0].budgetUsd).toBe(0.15);
    expect(appSpentToday(log)).toBeCloseTo(0.03);
  });

  it("refuses an empty task, an unknown agent, and asks past the daily cap", async () => {
    const log = new EventLog();
    const { rt, seen } = recording("plain words");
    const bay = new AgentBay(log, rt);
    expect((await askForApp(log, rt, bay, { task: "  " })).status).toBe(400);
    expect((await askForApp(log, rt, bay, { task: "x", agent: "nobody" })).status).toBe(404);
    const ok = await askForApp(log, rt, bay, { task: "say hi" });
    expect(ok.status).toBe(200);
    expect(ok.body.json).toBeUndefined();
    const capped = await askForApp(log, rt, bay, { task: "again" }, { dailyUsd: 0.03 });
    expect(capped.status).toBe(429);
    expect(seen.length).toBe(1);
  });

  it("tells the app where the core is", () => {
    expect(projectEnv(tmpdir(), process.execPath, 5000).SF_CORE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("the kit server forwards /api/_agent to the core, and says to open SoftwareFactory when it is closed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-agentapp-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "schema.js"), `export const app = { name: "Game Mastery", slug: "game-mastery" };
export const entities = [{ name: "game", label: "Games", singular: "Game", title: "name", fields: [{ name: "name", type: "text", required: true }], seed: [{ name: "Celeste" }] }];
export const flows = []; export const features = [];`);
    installKit(dir);
    const got: any[] = [];
    const core = createServer((req, res) => { let s = ""; req.on("data", (c) => (s += c)).on("end", () => { got.push(JSON.parse(s)); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ text: "ok", json: { tips: 3 }, costUsd: 0.01 })); }); });
    await new Promise<void>((r) => core.listen(0, "127.0.0.1", () => r()));
    const corePort = (core.address() as any).port;
    const start = (coreUrl: string) => new Promise<{ url: string; stop: () => void }>((resolve, reject) => {
      const p = spawn(process.execPath, ["server.js"], { cwd: dir, env: { ...process.env, PORT: "0", SF_CORE_URL: coreUrl, APP_DATA_DIR: join(dir, "data") } });
      p.stdout.on("data", (d) => { const m = String(d).match(/Ready on (\S+)/); if (m) resolve({ url: m[1], stop: () => p.kill() }); });
      p.on("exit", (c) => reject(new Error("server exited " + c)));
    });
    const post = (url: string) => fetch(url + "api/_agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task: "Research Celeste", input: { name: "Celeste" } }) });
    const app = await start(`http://127.0.0.1:${corePort}`);
    try {
      const r = await post(app.url);
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ json: { tips: 3 } });
      expect(got[0]).toMatchObject({ task: "Research Celeste", input: { name: "Celeste" }, app: "Game Mastery" });
    } finally { app.stop(); core.close(); }
    const closed = await start("http://127.0.0.1:9");
    try {
      const r = await post(closed.url);
      expect(r.status).toBe(503);
      expect((await r.json()).error).toMatch(/Open SoftwareFactory/);
    } finally { closed.stop(); }
  }, 20000);
});
