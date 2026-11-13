import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { EventLog, MockRuntime, createCore, createProject, linkToProject } from "../src/index.js";
import { buildAllowance, extraAllowance, projectBudget, setProjectBudget } from "../src/projects/budget.js";

/** A finished build of the project that spent `usd`. */
function spent(log: EventLog, projectId: number, usd: number, onTop = false) {
  const run = log.append("factory.run.started", { idea: `build ${usd}`, maxUsd: 10, ...(onTop ? { screen: { baseRun: 1 } } : {}), projectId }).id;
  linkToProject(log, projectId, "factory_run", run);
  log.append("agent.run.completed", { factoryRun: run, agent: "builder", station: "build", costUsd: usd });
  log.append("factory.run.finished", { run, outcome: "shipped" });
  return run;
}

describe("money limits per project and per version", () => {
  it("adds up what each version spent and what is left of the project's total", () => {
    const log = new EventLog();
    const p = createProject(log, { name: "Game Mastery" });
    expect(projectBudget(log, p)).toMatchObject({ totalUsd: null, firstUsd: null, nextUsd: null, spentUsd: 0, leftUsd: null, versions: [] });
    spent(log, p, 6.5);
    spent(log, p, 1.25, true);
    setProjectBudget(log, p, { totalUsd: 30, firstUsd: 10, nextUsd: 3 });
    const b = projectBudget(log, p)!;
    expect(b).toMatchObject({ totalUsd: 30, firstUsd: 10, nextUsd: 3, spentUsd: 7.75, heldUsd: 0, leftUsd: 22.25 });
    expect(b.versions.map((v) => [v.version, v.kind, v.spentUsd])).toEqual([[1, "first", 6.5], [2, "next", 1.25]]);
    // The defaults per kind of version, then what is left caps them.
    expect(buildAllowance(log, p, "first")).toEqual({ maxUsd: 10 });
    expect(buildAllowance(log, p, "next")).toEqual({ maxUsd: 3 });
    expect(buildAllowance(log, p, "first", 25)).toMatchObject({ maxUsd: 22.25, note: expect.stringMatching(/\$22\.25 left of \$30\.00/) });
    // A total below what was already spent is refused; null clears a limit.
    expect(() => setProjectBudget(log, p, { totalUsd: 5 })).toThrow(/already spent \$7\.75/);
    expect(setProjectBudget(log, p, { totalUsd: null }).leftUsd).toBeNull();
  });

  it("refuses a build when the budget is used up, and counts money a running build still holds", () => {
    const log = new EventLog();
    const p = createProject(log, { name: "Recipes" });
    setProjectBudget(log, p, { totalUsd: 2 });
    const running = log.append("factory.run.started", { idea: "recipes", maxUsd: 1.5, projectId: p }).id;
    linkToProject(log, p, "factory_run", running);
    log.append("agent.run.completed", { factoryRun: running, agent: "designer", costUsd: 0.4 });
    // $0.40 spent and $1.10 held by the running build: $0.50 left.
    expect(projectBudget(log, p)).toMatchObject({ spentUsd: 0.4, heldUsd: 1.1, leftUsd: 0.5 });
    expect(buildAllowance(log, p, "first")).toMatchObject({ maxUsd: 0.5 });
    // The running build may be given at most what the project has left, not "50% more" of its own limit.
    expect(extraAllowance(log, running, 0.75, () => p)).toBe(0.5);
    log.append("agent.run.completed", { factoryRun: running, agent: "builder", costUsd: 1.45 });
    expect(buildAllowance(log, p, "first")).toEqual({ error: expect.stringMatching(/budget of \$2\.00 is used up/) });
    // A project with no budget changes nothing: the factory's own default stays.
    const free = createProject(log, { name: "Free" });
    expect(buildAllowance(log, free, "first")).toEqual({ maxUsd: undefined });
    expect(extraAllowance(log, running, 0.75, () => free)).toBe(0.75);
  });

  it("serves the budget and starts project builds within it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-budget-"));
    const log = new EventLog(":memory:");
    const core = createCore({ log, runtime: new MockRuntime({ delayMs: 0 }), projectsDir: join(dir, "projects"), order: { mode: "heuristic" } });
    const server = createServer(core);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      const { id } = await (await post("/api/projects", { name: "Word counter" })).json();
      let r = await post(`/api/projects/${id}/budget`, { totalUsd: 1, firstUsd: 0.75 });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ totalUsd: 1, firstUsd: 0.75, leftUsd: 1 });
      expect((await post(`/api/projects/${id}/budget`, { totalUsd: -3 })).status).toBe(400);
      r = await post(`/api/projects/${id}/runs`, { idea: "a word counter" });
      expect(r.status).toBe(202);
      const first = await r.json();
      expect(first.maxUsd).toBe(0.75);
      expect((log.get(first.run)!.payload as { maxUsd: number }).maxUsd).toBe(0.75);
      // While it runs it holds its limit, so a second build gets only what is left.
      r = await post(`/api/projects/${id}/runs`, { idea: "a word counter with history" });
      expect(r.status).toBe(202);
      const second = await r.json();
      expect(second.maxUsd).toBeLessThanOrEqual(0.25);
      expect(second.note).toMatch(/left of \$1\.00/);
      const detail = await (await fetch(`${base}/api/projects/${id}`)).json();
      expect(detail.facets.budget.versions).toHaveLength(2);
      for (const run of [first.run, second.run]) { core.factory.decide(run, "gateA", { approve: false }); await core.factory.wait(run).catch(() => {}); }
      // Nothing more fits: the next build is refused with the reason.
      expect((await post(`/api/projects/${id}/budget`, { totalUsd: 0.1 })).status).toBe(200);
      r = await post(`/api/projects/${id}/runs`, { idea: "a third version" });
      expect(r.status).toBe(409);
      expect((await r.json()).error).toMatch(/is used up/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("a running build cannot be given more than its project has left", () => {
  const until = async (f: () => boolean) => { for (let i = 0; i < 500 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); };
  it("offers only what is left, and stops with the reason when nothing is", async () => {
    const { Factory } = await import("../src/index.js");
    const tmp = () => mkdtempSync(join(tmpdir(), "sf-budget-run-"));
    const gates = (log: EventLog) => log.list({ type: "factory.gate", limit: 1e6 }).map((e) => e.payload as any);
    const log = new EventLog();
    const f = new Factory(log, new MockRuntime({ plantBug: false }), tmp());
    f.extraBudget = () => 0.02;
    let run = f.start("a todo app", { maxUsd: 0.005 });
    await until(() => f.waitingGate(run) === "escalation");
    expect(gates(log).find((g) => g.state === "waiting" && g.kind === "budget").question).toMatch(/is spent\. Add \$0\.02 more\?/);
    f.decide(run, "escalation", { approve: false });
    await f.wait(run);

    const log2 = new EventLog();
    const f2 = new Factory(log2, new MockRuntime({ plantBug: false }), tmp());
    f2.extraBudget = () => 0;
    run = f2.start("a todo app", { maxUsd: 0.005 });
    await f2.wait(run);
    expect(gates(log2).some((g) => g.kind === "budget")).toBe(false);
    expect(log2.list({ type: "factory.run.finished" })[0].payload).toMatchObject({ outcome: "stopped", reason: expect.stringMatching(/project's budget has nothing left/) });
  });
});
