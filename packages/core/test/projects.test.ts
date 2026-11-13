import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  EventLog, OrderEngine, Factory, MockRuntime, captureSignal, createCore,
  listProjects, projectDetail, projectOf, createProject, updateProject, linkToProject, unlinkFromProject, foldProjects, nameFromIdea,
} from "../src/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "sf-projects-"));

function engine(log: EventLog) {
  const order = new OrderEngine(log, null, { mode: "heuristic" });
  log.on("event", (e) => { if (e.type === "signal.captured") order.ingest({ id: e.id, text: (e.payload as any).text, source: (e.payload as any).source }); });
  return order;
}

describe("project names are unique", () => {
  it("refuses a taken name (any case), versions names SF picks, and versions old duplicates once", () => {
    const log = new EventLog();
    const a = createProject(log, { name: "Game Mastery" });
    expect(() => createProject(log, { name: "game  mastery" })).toThrow(/already exists.*mastery v2/i);
    const b = createProject(log, { name: "Other" });
    expect(() => updateProject(log, b, { name: "GAME MASTERY" })).toThrow(/already exists/);
    updateProject(log, a, { name: "Game Mastery" }); // its own name is fine
    const c = createProject(log, { name: "Game Mastery", onTaken: "version" });
    expect(projectDetail(log, c)!.name).toBe("Game Mastery v2");
    // Duplicates from before the rule (raw events): the first keeps the name, later ones get the next version.
    log.append("project.created", { name: "Plan Diagram View", kind: "app", summary: "" });
    log.append("project.created", { name: "Plan Diagram View", kind: "app", summary: "" });
    const names = listProjects(log).map((p) => p.name).sort();
    expect(names).toContain("Plan Diagram View");
    expect(names).toContain("Plan Diagram View v2");
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
  });

  it("builds of the same idea get their own version numbers", async () => {
    const log = new EventLog();
    const f = new Factory(log, new MockRuntime({ delayMs: 0 }), tmp());
    await f.wait(f.start("a CLI that counts words", { autoApprove: true }));
    await f.wait(f.start("a CLI that counts words", { autoApprove: true, again: true } as any));
    const names = listProjects(log).filter((p) => p.origin === "factory").map((p) => p.name).sort();
    expect(names).toEqual(["Word Counter", "Word Counter v2"]);
  });
});

describe("projects", () => {
  it("adopts existing Order Engine projects and factory runs without migrating anything", async () => {
    const dir = tmp();
    const path = join(dir, "factory.db");
    // A database from before projects existed: ideas filed and a shipped run.
    {
      const log = new EventLog(path);
      const order = engine(log);
      const sfNode = order.createNode("project", "SoftwareFactory");
      captureSignal(log, "SoftwareFactory rule: approval stations must be minimal.");
      await order.idle();
      // Make sure something is filed under it, whatever the heuristic decided.
      const frag = order.state().fragments[0];
      order.moveFragment(frag.id, sfNode);
      const f = new Factory(log, new MockRuntime({ delayMs: 0 }), join(dir, "projects"));
      await f.wait(f.start("a CLI that counts words", { autoApprove: true }));
      await order.idle();
      // Simulate the old database: drop the projects tables and their bookkeeping.
      log.db.exec("DROP TABLE projects; DROP TABLE project_links; DELETE FROM projections WHERE name = 'projects'");
      log.close();
    }
    const log = new EventLog(path);
    const ps = listProjects(log);
    expect(ps.length).toBe(2);
    const run = ps.find((p) => p.origin === "factory")!;
    // A build that is its own project is named after what was planned, not the cut-off idea.
    expect(run.name).toBe("Word Counter");
    expect(run.summary).not.toBe("");
    expect(run.rollup.runs).toBe(1);
    expect(run.rollup.shipped).toBe(1);
    expect(run.rollup.agentCalls).toBeGreaterThan(0);
    // The run's intake node joined the run's project instead of becoming a project of its own.
    const d = projectDetail(log, run.id)!;
    expect(d.rootNodeIds.length).toBe(1);
    expect(d.agents.length).toBeGreaterThan(0);
    expect(d.artifacts.files).toBeGreaterThan(0);
    const sf = ps.find((p) => p.origin === "order")!;
    expect(sf.rollup.fragments).toBeGreaterThan(0);
    // An order project keeps its node id as its project id.
    expect(projectOf(log, { kind: "order_node", ref: sf.id })).toBe(sf.id);
    expect(projectOf(log, { kind: "factory_run", ref: d.runIds[0] })).toBe(run.id);
  });

  it("runs started in a project stay in it, and so does their intake idea", async () => {
    const dir = tmp();
    const log = new EventLog(":memory:");
    const order = engine(log);
    const pid = createProject(log, { name: "PlonterApp", kind: "app", summary: "Tickets with agents" });
    const f = new Factory(log, new MockRuntime({ delayMs: 0 }), join(dir, "projects"));
    await f.wait(f.start("a word counter", { autoApprove: true, projectId: pid }));
    await f.wait(f.start("a line counter", { autoApprove: true, projectId: pid }));
    await order.idle();
    const ps = listProjects(log);
    expect(ps.map((p) => p.id)).toEqual([pid]);
    const d = projectDetail(log, pid)!;
    expect(d.runIds.length).toBe(2);
    expect(d.rootNodeIds.length).toBe(2);
    expect(d.rollup.shipped).toBe(2);
    expect(d.summary).toBe("Tickets with agents");
  });

  it("moves things between projects; emptied adopted projects disappear, yours stay", async () => {
    const log = new EventLog(":memory:");
    const order = engine(log);
    const a = order.createNode("project", "Alpha");
    const b = order.createNode("project", "Beta");
    const child = order.createNode("idea", "an idea", a);
    expect(listProjects(log).length).toBe(2);
    const mine = createProject(log, { name: "Mine" });
    linkToProject(log, mine, "order_node", a);
    expect(listProjects(log).map((p) => p.id).sort()).toEqual([b, mine].sort());
    // The child idea follows its root.
    expect(projectOf(log, { kind: "order_node", ref: child })).toBe(mine);
    expect(projectDetail(log, mine)!.nodeIds).toContain(child);
    expect(() => linkToProject(log, mine, "order_node", child)).toThrow(/root node/);
    // Other parts of the app link their own things.
    linkToProject(log, mine, "ticket", "T-7");
    expect(projectDetail(log, mine)!.rollup.linked).toEqual({ ticket: 1 });
    // Taking a root node out gives it its own project back.
    unlinkFromProject(log, mine, "order_node", a);
    expect(projectOf(log, { kind: "order_node", ref: a })).toBe(a);
    expect(listProjects(log).find((p) => p.id === a)?.name).toBe("Alpha");
    // Emptying yours keeps it.
    unlinkFromProject(log, mine, "ticket", "T-7");
    expect(listProjects(log).some((p) => p.id === mine)).toBe(true);
  });

  it("edits name, kind, summary and status, and refuses bad input", () => {
    const log = new EventLog(":memory:");
    const id = createProject(log, { name: "  Space   dog  " });
    expect(listProjects(log)[0].name).toBe("Space dog");
    updateProject(log, id, { status: "paused", kind: "tool", summary: "walks dogs" });
    const p = listProjects(log)[0];
    expect([p.status, p.kind, p.summary]).toEqual(["paused", "tool", "walks dogs"]);
    expect(() => createProject(log, { name: "  " })).toThrow();
    expect(() => updateProject(log, id, { status: "gone" as any })).toThrow();
    expect(() => updateProject(log, 999, { name: "x" })).toThrow(/No project/);
    expect(() => linkToProject(log, id, "Bad Kind", "1")).toThrow();
  });

  it("the tables rebuild from the log to the same rows", async () => {
    const log = new EventLog(":memory:");
    const order = engine(log);
    captureSignal(log, "Project Moon base. idea: a garden on the moon");
    await order.idle();
    createProject(log, { name: "Other" });
    const before = listProjects(log);
    log.rebuild("projects");
    expect(listProjects(log)).toEqual(before);
    // The fold is pure: the same events give the same state.
    const events = log.list({ limit: 1e6 });
    expect(foldProjects(events)).toEqual(foldProjects(events));
  });

  it("names projects from ideas at a word boundary", () => {
    expect(nameFromIdea("short idea")).toBe("short idea");
    const long = nameFromIdea("a very long idea about a tool that renames photos by date and place and more");
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long.endsWith("…")).toBe(true);
  });

  it("serves the projects API", async () => {
    const dir = tmp();
    const log = new EventLog(":memory:");
    const core = createCore({ log, runtime: new MockRuntime({ delayMs: 0 }), projectsDir: join(dir, "projects"), order: { mode: "heuristic" } });
    const server = createServer(core);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      let r = await post("/api/projects", { name: "Galaxy", kind: "app" });
      expect(r.status).toBe(201);
      const created = await r.json();
      expect(created.rootNodeIds.length).toBe(1);
      expect((await (await fetch(base + "/api/projects")).json()).length).toBe(1);
      r = await post(`/api/projects/${created.id}`, { status: "shipped" });
      expect((await r.json()).status).toBe("shipped");
      r = await post(`/api/projects/${created.id}/links`, { kind: "ticket", ref: "42" });
      expect((await r.json()).rollup.linked.ticket).toBe(1);
      const of = await (await fetch(`${base}/api/projects/of?kind=ticket&ref=42`)).json();
      expect(of.projectId).toBe(created.id);
      expect((await fetch(base + "/api/projects/999")).status).toBe(404);
      r = await post(`/api/projects/${created.id}/runs`, { idea: "a todo CLI" });
      expect(r.status).toBe(202);
      const { run } = await r.json();
      core.factory.wait(run).catch(() => {});
      expect(projectOf(log, { kind: "factory_run", ref: run })).toBe(created.id);
      // Add a screen: nothing shipped yet, so it says why; once a build ships it works in the same project.
      r = await post(`/api/projects/${created.id}/screen`, {});
      expect(r.status).toBe(409);
      expect((await r.json()).error).toMatch(/no finished factory build/);
      const gate = async (id: number, g: string) => { for (let i = 0; i < 500 && core.factory.waitingGate(id) !== g; i++) await new Promise((res) => setTimeout(res, 10)); core.factory.decide(id, g as any, { approve: true }); };
      await gate(run, "gateA"); await gate(run, "gateB");
      await core.factory.wait(run);
      r = await post(`/api/projects/${created.id}/screen`, {});
      expect(r.status).toBe(202);
      const screen = await r.json();
      expect(screen.baseRun).toBe(run);
      expect(projectOf(log, { kind: "factory_run", ref: screen.run })).toBe(created.id);
      await gate(screen.run, "gateB");
      await core.factory.wait(screen.run);
      expect(log.list({ type: "factory.run.finished", limit: 1e6 }).map((e) => e.payload as any).at(-1)).toMatchObject({ run: screen.run, outcome: "shipped" });
    } finally {
      server.close();
    }
  });
});
