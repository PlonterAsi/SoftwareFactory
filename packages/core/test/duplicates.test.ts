import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { EventLog, MockRuntime, createCore, listProjects, projectOf, normIdea } from "../src/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "sf-dupes-"));

/**
 * Assaf's app showed three projects named "Redesign SoftwareFactory's plan and review screens with…":
 * one Overseer "Build:" suggestion pressed again and again, each press a new run, and from General
 * each run a project of its own. Build now points at the run already doing the idea, and duplicates merge.
 */
describe("duplicate builds", () => {
  const IDEA = "Redesign SoftwareFactory's plan and review screens with clearer diagrams and visualizations so they are faster to understand.";

  it("normalizes ideas for the comparison", () => {
    expect(normIdea("  A todo  CLI. ")).toBe(normIdea("a todo cli"));
    expect(normIdea("a todo cli")).not.toBe(normIdea("a todo app"));
  });

  it("refuses to start the same idea twice unless asked, from General, a project and an improvement", async () => {
    const dir = tmp();
    const log = new EventLog(":memory:");
    const core = createCore({ log, runtime: new MockRuntime({ delayMs: 0 }), projectsDir: join(dir, "projects"), order: { mode: "heuristic" } });
    const server = createServer(core);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      let r = await post("/api/factory/runs", { idea: IDEA });
      expect(r.status).toBe(202);
      const { run } = await r.json();
      core.factory.wait(run).catch(() => {});

      // Pressed again (13 seconds later, in the real log): no new run, the answer names the first one.
      r = await post("/api/factory/runs", { idea: IDEA.toUpperCase() + "  " });
      expect(r.status).toBe(409);
      const dup = await r.json();
      expect(dup.duplicateOf).toBe(run);
      expect(dup.state).toBe("running");
      expect(dup.projectId).toBe(run);
      expect(dup.error).toMatch(/already building/);

      // The same from inside a project.
      const p = await (await post("/api/projects", { name: "Galaxy" })).json();
      r = await post(`/api/projects/${p.id}/runs`, { idea: IDEA });
      expect(r.status).toBe(409);
      expect((await r.json()).duplicateOf).toBe(run);
      expect(listProjects(log).filter((x) => x.origin === "factory").length).toBe(1);

      // Build again anyway is still one tap away.
      r = await post("/api/factory/runs", { idea: IDEA, again: true });
      expect(r.status).toBe(202);
      const second = (await r.json()).run;
      core.factory.wait(second).catch(() => {});
      expect(second).not.toBe(run);
      expect(listProjects(log).filter((x) => x.origin === "factory").length).toBe(2);

      // A different idea is never held back.
      r = await post("/api/factory/runs", { idea: "a todo CLI" });
      expect(r.status).toBe(202);
      core.factory.wait((await r.json()).run).catch(() => {});
    } finally {
      server.close();
    }
  });

  it("lets a failed or rejected idea be built again, and holds a shipped one for a day", async () => {
    const dir = tmp();
    const log = new EventLog(":memory:");
    const core = createCore({ log, runtime: new MockRuntime({ delayMs: 0 }), projectsDir: join(dir, "projects"), order: { mode: "heuristic" } });
    const f = core.factory;
    const gate = async (id: number, g: string, approve = true) => { for (let i = 0; i < 500 && f.waitingGate(id) !== g; i++) await new Promise((res) => setTimeout(res, 10)); f.decide(id, g as any, { approve }); };

    const rejected = f.start("a word counter");
    await gate(rejected, "gateA", false);
    await f.wait(rejected);
    expect(f.duplicateOf("a word counter")).toBeNull();

    const shipped = f.start("a word counter");
    await gate(shipped, "gateA"); await gate(shipped, "gateB");
    await f.wait(shipped);
    expect(f.duplicateOf("A word counter.")).toMatchObject({ run: shipped, state: "shipped" });
    // Older than the window: free again.
    expect(f.duplicateOf("a word counter", 0)).toBeNull();
  });

  it("merges a duplicate project into another and the duplicate goes away", async () => {
    const dir = tmp();
    const log = new EventLog(":memory:");
    const core = createCore({ log, runtime: new MockRuntime({ delayMs: 0 }), projectsDir: join(dir, "projects"), order: { mode: "heuristic" } });
    const server = createServer(core);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      const a = (await (await post("/api/factory/runs", { idea: IDEA })).json()).run;
      const b = (await (await post("/api/factory/runs", { idea: IDEA, again: true })).json()).run;
      core.factory.wait(a).catch(() => {});
      core.factory.wait(b).catch(() => {});
      await post(`/api/projects/${b}/links`, { kind: "ticket", ref: "7" });
      expect(listProjects(log).length).toBe(2);

      let r = await post(`/api/projects/${b}/merge`, { into: a });
      expect(r.status).toBe(200);
      const kept = await r.json();
      expect(kept.id).toBe(a);
      expect(kept.runIds).toEqual(expect.arrayContaining([a, b]));
      expect(projectOf(log, { kind: "ticket", ref: "7" })).toBe(a);
      // The factory-made duplicate is gone, not left as an empty shell.
      expect(listProjects(log).map((p) => p.id)).toEqual([a]);

      // A project you made is archived rather than lost.
      const mine = (await (await post("/api/projects", { name: "Mine" })).json()).id;
      r = await post(`/api/projects/${mine}/merge`, { into: a });
      expect(r.status).toBe(200);
      expect(listProjects(log).find((p) => p.id === mine)?.status).toBe("archived");

      expect((await post(`/api/projects/${a}/merge`, { into: a })).status).toBe(409);
      expect((await post(`/api/projects/${a}/merge`, {})).status).toBe(409);
    } finally {
      server.close();
    }
  });
});
