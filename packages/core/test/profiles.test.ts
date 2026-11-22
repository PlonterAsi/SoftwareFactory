import { describe, expect, it, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { EventLog, MockRuntime, createCore } from "../src/index.js";
import { runAgent } from "../src/agents.js";
import { assign, assignments, profileProblems, removeProfile, resolveProfiles, saveProfile } from "../src/configs/profiles.js";
import { ClaudeCodeRuntime, type AgentRequest, type AgentResult, type AgentRuntime } from "../src/runtime.js";

const stops: (() => void)[] = [];
afterAll(() => stops.forEach((s) => s()));

class Spy implements AgentRuntime {
  name = "spy";
  seen: AgentRequest[] = [];
  async run(req: AgentRequest): Promise<AgentResult> { this.seen.push(req); return { text: "ok", costUsd: 0, durationMs: 1 } as AgentResult; }
}

describe("profiles", () => {
  it("refuses two settings that touch the same thing, and settings a profile cannot make", () => {
    const p = { id: "lean", name: "Lean", settings: [{ path: "advisor.model", value: "opus" }, { path: "advisor.model", value: null }, { path: "agent.builder.prompt", value: "x" }] };
    const problems = profileProblems(p);
    expect(problems.join(" ")).toMatch(/Two settings touch advisor.model/);
    expect(problems.join(" ")).toMatch(/cannot set agent.builder.prompt/);
    expect(() => saveProfile(new EventLog(), p)).toThrow(/Two settings touch/);
  });

  it("resolves broadest first: the narrowest profile that sets a thing wins", () => {
    const log = new EventLog();
    saveProfile(log, { id: "base", name: "Base", settings: [{ path: "agent.builder.model", value: "sonnet" }, { path: "advisor.model", value: "opus" }] });
    saveProfile(log, { id: "cheap", name: "Cheap", settings: [{ path: "agent.builder.model", value: "haiku" }] });
    assign(log, "global", null, "base");
    assign(log, "project", 4, "cheap");
    const r = resolveProfiles(log, { projectId: 4 });
    expect(r.chain.map((c) => c.profile.id)).toEqual(["base", "cheap"]);
    expect(r.settings["agent.builder.model"]).toMatchObject({ value: "haiku", from: "cheap", scope: "project" });
    expect(r.settings["advisor.model"]).toMatchObject({ value: "opus", from: "base" });
    expect(resolveProfiles(log, { projectId: 5 }).settings["agent.builder.model"].value).toBe("sonnet");
    removeProfile(log, "cheap");
    expect(assignments(log).map((a) => a.scope)).toEqual(["global"]);
  });

  it("applies a profile to a call: model, a lower cap, the advisor and the person's own settings", async () => {
    const log = new EventLog();
    saveProfile(log, { id: "p", name: "P", settings: [{ path: "agent.builder.model", value: "opus" }, { path: "agent.builder.budgetUsd", value: 0.2 }, { path: "advisor.model", value: null }, { path: "crew.personalSettings", value: true }] });
    assign(log, "project", 9, "p");
    const rt = new Spy();
    await runAgent(log, rt, "builder", { prompt: "x", model: "sonnet", budgetUsd: 0.6, cwd: "/w", tools: ["Edit"] }, { projectId: 9 });
    expect(rt.seen[0]).toMatchObject({ model: "opus", budgetUsd: 0.2, advisor: null, personalSettings: true });
    const started = log.db.prepare("SELECT payload FROM events WHERE type = 'agent.run.started'").get() as { payload: string };
    expect(JSON.parse(started.payload).profiles).toEqual(["project:p"]);
    // Elsewhere nothing changes.
    await runAgent(log, rt, "builder", { prompt: "x", model: "sonnet", budgetUsd: 0.6 }, { projectId: 10 });
    expect(rt.seen[1]).toMatchObject({ model: "sonnet", budgetUsd: 0.6 });
    expect(rt.seen[1].personalSettings).toBeUndefined();
    // The flag reaches the CLI arguments.
    const args = new ClaudeCodeRuntime({ profile: "lean" }).buildArgs(rt.seen[0]);
    expect(args).not.toContain("--setting-sources");
  });
});

describe("the profiles API and flows", () => {
  it("saves, assigns and resolves over HTTP, and a profile picks the flow for a kind of ticket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-prof-"));
    const log = new EventLog(":memory:");
    const core = createCore({ log, runtime: new MockRuntime({ delayMs: 0 }), projectsDir: join(dir, "projects"), order: { mode: "heuristic" } });
    const server: Server = createServer(core);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    stops.push(() => { core.launcher.stopAll(); server.close(); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const send = async (method: string, path: string, body?: unknown) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, j: await r.json() }; };
    const bad = await send("PUT", "/api/config/profiles/x", { profile: { name: "X", settings: [{ path: "agent.nobody.model", value: "opus" }] } });
    expect(bad.status).toBe(400);
    expect(bad.j.problems.join(" ")).toMatch(/No agent called nobody/);
    const ok = await send("PUT", "/api/config/profiles/refactor-bugs", { profile: { name: "Refactor bugs", settings: [{ path: "flow.bug", value: "refactor" }] } });
    expect(ok.status).toBe(200);
    expect((await send("POST", "/api/config/assign", { scope: "global", profile: "refactor-bugs" })).status).toBe(200);
    const list = await send("GET", "/api/config/profiles");
    expect(list.j.assignments).toEqual([{ scope: "global", ref: null, profile: "refactor-bugs" }]);
    const res = await send("GET", "/api/config/resolve?ticket=1");
    expect(res.j.settings["flow.bug"].value).toBe("refactor");
    const cfg = await send("GET", "/api/config");
    expect(cfg.j.entries.find((e: { id: string }) => e.id === "profile:global").detail).toMatch(/Refactor bugs/);
    const { pickFlow } = await import("../src/tickets/flowpick.js");
    const flows = (core as unknown as { factory?: { flows: unknown } }).factory?.flows;
    expect(flows).toBeDefined();
    {
      const p = pickFlow(flows as never, { kind: "bug", id: 1 }, { repo: true });
      expect(p.flow.id).toBe("refactor");
      expect(p.why).toMatch(/configuration profile/);
    }
  });
});
