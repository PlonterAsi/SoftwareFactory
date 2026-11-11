import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { EventLog, OrderEngine, MockRuntime, captureSignal, createCore, createProject, listProjects, chatRoutes, projectHome } from "../src/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "sf-chat-"));

function engine(log: EventLog) {
  const order = new OrderEngine(log, null, { mode: "heuristic" });
  log.on("event", (e) => {
    if (e.type !== "signal.captured") return;
    const p = e.payload as any;
    order.ingest({ id: e.id, text: p.text, source: p.source, home: p.projectId != null ? projectHome(log, order.state(), p.projectId) : null });
  });
  return order;
}

describe("project chats", () => {
  it("files words said in a project's chat under that project, never a stray project", async () => {
    const log = new EventLog(":memory:");
    const order = engine(log);
    const garden = createProject(log, { name: "Garden planner" });
    const gardenRoot = order.createNode("project", "Garden planner");
    log.append("project.linked", { projectId: garden, kind: "order_node", ref: String(gardenRoot) });
    const other = createProject(log, { name: "Invoice tool" });
    log.append("project.linked", { projectId: other, kind: "order_node", ref: String(order.createNode("project", "Invoice tool")) });
    expect(projectHome(log, order.state(), garden)).toBe(gardenRoot);

    // No word ties it anywhere: in General it would wait in Unsorted (two projects); in the chat it goes home.
    const s = captureSignal(log, "It must work offline.", "bridge", garden);
    expect(s.projectId).toBe(garden);
    await order.idle();
    const f = order.state().fragments.find((x) => x.signalId === s.id)!;
    expect(f.nodeId).toBe(gardenRoot);

    // A new topic opened from the chat stays inside the project.
    const before = listProjects(log).length;
    const t = captureSignal(log, "Project: Watering schedule. Remind me when to water the tomatoes every morning.", "bridge", garden);
    await order.idle();
    expect(listProjects(log).length).toBe(before);
    expect(chatRoutes(log, order.state()).filed[t.id]).toEqual([garden]);
  });

  it("routes General messages into the projects the Order Engine filed them in", async () => {
    const log = new EventLog(":memory:");
    const order = engine(log);
    const garden = createProject(log, { name: "Garden planner" });
    log.append("project.linked", { projectId: garden, kind: "order_node", ref: String(order.createNode("project", "Garden planner")) });
    captureSignal(log, "Garden planner rule: tomatoes need water every morning.", "bridge", garden);
    await order.idle();
    const g = captureSignal(log, "The garden planner should show tomatoes water times in a calendar.");
    await order.idle();
    expect(g.projectId).toBeUndefined();
    expect(chatRoutes(log, order.state()).filed[g.id]).toEqual([garden]);
    const chit = captureSignal(log, "ok thanks");
    await order.idle();
    expect(chatRoutes(log, order.state()).filed[chit.id]).toBeUndefined();
  });

  it("serves chats over the API: capture and ask in a project, routes, closed chats", async () => {
    const dir = tmp();
    const log = new EventLog(":memory:");
    const core = createCore({ log, runtime: new MockRuntime({ delayMs: 0 }), projectsDir: join(dir, "projects"), order: { mode: "heuristic" } });
    const server = createServer(core);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      const created = await (await post("/api/projects", { name: "Galaxy", kind: "app", summary: "a star map toy" })).json();
      let r = await post("/api/signals", { text: "Galaxy must render 10k stars smoothly.", projectId: created.id });
      expect(r.status).toBe(201);
      const sig = await r.json();
      expect(sig.projectId).toBe(created.id);
      r = await post("/api/signals", { text: "hello", projectId: 999999 });
      expect(r.status).toBe(404);
      r = await post("/api/signals", { text: "a general thought" });
      expect((await r.json()).projectId).toBeUndefined();

      r = await post("/api/agent/run", { prompt: "what is next here?", projectId: created.id });
      const ask = await r.json();
      const started = log.get(ask.runId)!;
      expect((started.payload as any).projectId).toBe(created.id);
      expect((started.payload as any).prompt).toContain('chat of the project "Galaxy"');

      // Let the Order Engine file the Signals, then read the routes.
      for (let i = 0; i < 100; i++) { const routes = await (await fetch(base + "/api/chat/routes")).json(); if (routes.filed[sig.id]) break; await new Promise((res) => setTimeout(res, 10)); }
      const routes = await (await fetch(base + "/api/chat/routes")).json();
      expect(routes.filed[sig.id]).toEqual([created.id]);
      expect(routes.factoryRuns).toEqual({});
    } finally {
      server.close();
    }
  });
});
