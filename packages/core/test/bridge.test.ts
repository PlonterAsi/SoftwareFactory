import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventLog, MockRuntime, OrderEngine, Factory, DropFolder, SwitchableRuntime, createCore, captureSignal, listSignals, sinceReport, statusDigest,
  buildSuggestion, explainAgentError, projectTitle, runAgent, readSettings,
} from "../src/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "sf-m5-"));
const old = (p: string) => { const t = new Date(Date.now() - 60_000); utimesSync(p, t, t); };

describe("drop folder", () => {
  it("turns each note into a Signal once, moves it to filed/, and leaves other files alone", () => {
    const log = new EventLog();
    const dir = tmp();
    writeFileSync(join(dir, "idea.txt"), "Idea: a weekly watering calendar");
    writeFileSync(join(dir, "photo.jpg"), "not text");
    old(join(dir, "idea.txt")); old(join(dir, "photo.jpg"));
    const drop = new DropFolder(log, dir);
    const r = drop.scan();
    expect(r.find((x) => x.file === "idea.txt")?.status).toBe("filed");
    expect(r.find((x) => x.file === "photo.jpg")?.status).toBe("skipped");
    expect(listSignals(log).map((s) => [s.text, s.source])).toEqual([["Idea: a weekly watering calendar", "drop"]]);
    expect(existsSync(join(dir, "idea.txt"))).toBe(false);
    expect(readdirSync(join(dir, "filed"))[0]).toMatch(/idea\.txt$/);
    expect(existsSync(join(dir, "photo.jpg"))).toBe(true);
    // The same note dropped again is not captured twice; a scan with nothing new does nothing.
    writeFileSync(join(dir, "again.md"), "Idea: a weekly watering calendar");
    old(join(dir, "again.md"));
    expect(drop.scan().map((x) => x.status)).toEqual(["skipped"]);
    expect(drop.scan()).toEqual([]);
    expect(listSignals(log)).toHaveLength(1);
    expect(drop.recent().map((d) => d.status)).toEqual(["skipped", "skipped", "filed"]);
  });

  it("waits for a note that is still being written", () => {
    const log = new EventLog();
    const dir = tmp();
    writeFileSync(join(dir, "fresh.txt"), "half a thought");
    expect(new DropFolder(log, dir).scan()).toEqual([]);
    expect(existsSync(join(dir, "fresh.txt"))).toBe(true);
  });
});

describe("factory ideas on the star map", () => {
  it("gives each factory idea its own project body, with no Archivist call", async () => {
    const log = new EventLog();
    const rt = new MockRuntime();
    const order = new OrderEngine(log, rt, { mode: "agent" });
    captureSignal(log, "a CLI that renames photos by the date they were taken", "factory");
    const r = await order.ingest(listSignals(log)[0]);
    expect(r.mode).toBe("factory");
    expect(rt.calls).toHaveLength(0);
    const st = order.state();
    expect(st.nodes.map((n) => [n.kind, n.title])).toEqual([["project", "CLI that renames photos"]]);
    expect(st.fragments[0].nodeId).toBe(st.nodes[0].id);
  });

  it("names projects from the idea", () => {
    expect(projectTitle("Build me a garden planner app that works offline")).toBe("Garden planner app");
    expect(projectTitle("a tool to sum a CSV of expenses")).toBe("Tool to sum a CSV");
  });
});

describe("since you left", () => {
  it("lists what shipped, what waits for you and what was filed after the last seen marker", async () => {
    const dir = tmp();
    const log = new EventLog();
    const rt = new MockRuntime({ plantBug: false });
    const order = new OrderEngine(log, rt);
    log.on("event", (e) => { if (e.type === "signal.captured") order.ingest({ id: e.id, ...(e.payload as { text: string; source: string }) }); });
    captureSignal(log, "Project: Garden. Rule: it must work offline.");
    await order.idle();
    const seenAt = (log.db.prepare("SELECT max(id) AS m FROM events").get() as { m: number }).m;
    log.append("bridge.seen", { eventId: seenAt });
    const f = new Factory(log, rt, dir);
    const run = f.start("a word counter", { autoApprove: true });
    await f.wait(run);
    await order.idle();
    const rep = sinceReport(log, order.state());
    expect(rep.fromEvent).toBe(seenAt);
    expect(rep.lines.map((l) => l.kind)).toContain("shipped");
    expect(rep.lines.find((l) => l.kind === "shipped")!.text).toMatch(/Shipped Word Counter/);
    expect(rep.lines.some((l) => l.kind === "filed")).toBe(true);
    // Nothing before the marker is repeated.
    expect(rep.lines.some((l) => /Garden/.test(l.text) && l.kind === "filed")).toBe(false);
  });

  it("is empty on a first launch", () => {
    const log = new EventLog();
    expect(sinceReport(log, new OrderEngine(log, null).state()).lines).toEqual([]);
  });
});

describe("the Overseer", () => {
  it("reads a live status digest and can suggest a build", async () => {
    const log = new EventLog();
    const rt = new MockRuntime();
    const order = new OrderEngine(log, rt);
    captureSignal(log, "Project: Garden. Rule: it must work offline.");
    await order.ingest(listSignals(log)[0]);
    const d = statusDigest(log, order.state(), "mock");
    expect(d).toMatch(/practice/);
    expect(d).toMatch(/Project "Garden"; rules: .*offline/);
    expect(buildSuggestion("Sounds good.\nBUILD: a CLI that waters plants").build).toBe("a CLI that waters plants");
    expect(buildSuggestion("No build here.").build).toBeUndefined();

    const server = createServer(createCore({ log, runtime: rt, projectsDir: tmp(), dropDir: tmp() }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const r = await (await fetch(`${base}/api/agent/run`, { method: "POST", body: JSON.stringify({ prompt: "what is going on?" }) })).json();
      expect(r.result.text).toMatch(/Practice Overseer/);
      expect(rt.calls.at(-1)!.prompt).toMatch(/^Status of the factory right now:/);
      expect(rt.calls.at(-1)!.prompt).toMatch(/The person says:\nwhat is going on\?$/);
    } finally { server.close(); }
  });

  it("explains agent failures in words you can act on, keeping the raw text", async () => {
    expect(explainAgentError("claude exited 1: Invalid API key · Please run /login")).toMatch(/not signed in/);
    expect(explainAgentError("spawn claude ENOENT")).toMatch(/not found/);
    expect(explainAgentError("something odd")).toBe("something odd");
    const log = new EventLog();
    const failing = { name: "x", run: async () => { throw new Error("Please run /login"); } };
    const r = await runAgent(log, failing, "planner", { prompt: "p" });
    expect(r.error).toMatch(/not signed in/);
    expect((log.list({ type: "agent.run.failed" })[0].payload as { raw: string }).raw).toBe("Please run /login");
  });
});

describe("setup", () => {
  it("reports this computer, remembers the crew picked, and guards its inputs", async () => {
    const log = new EventLog();
    const rt = new SwitchableRuntime(new MockRuntime(), "practice");
    const core = createCore({ log, runtime: rt, projectsDir: tmp(), dropDir: tmp() });
    const server = createServer(core);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const setup = await (await fetch(`${base}/api/setup`)).json();
      expect(setup.mode).toBe("practice");
      expect(setup.node.ok).toBe(true);
      expect(setup.paths.projects).toBeTruthy();
      const res = await fetch(`${base}/api/setup/mode`, { method: "POST", body: JSON.stringify({ mode: "practice" }) });
      expect(res.status).toBe(200);
      expect(readSettings(log).crewMode).toBe("practice");
      const health = await (await fetch(`${base}/api/health`)).json();
      expect(health).toMatchObject({ runtime: "mock", mode: "practice" });
      const bad = await fetch(`${base}/api/setup/drop`, { method: "POST", body: JSON.stringify({ dir: "relative/path" }) });
      expect(bad.status).toBe(400);
      const none = await fetch(`${base}/api/open`, { method: "POST", body: JSON.stringify({ target: "run", run: 999 }) });
      expect(none.status).toBe(404);
      // Presence: a marker only moves forward.
      await fetch(`${base}/api/presence`, { method: "POST", body: JSON.stringify({ eventId: 5 }) });
      await fetch(`${base}/api/presence`, { method: "POST", body: JSON.stringify({ eventId: 3 }) });
      expect(log.list({ type: "bridge.seen" }).map((e) => (e.payload as { eventId: number }).eventId)).toEqual([5]);
    } finally { server.close(); }
  });
});

describe("in-app updates", () => {
  it("records each installed version once and reports update settings and history", async () => {
    const log = new EventLog();
    const core = createCore({ log, runtime: new MockRuntime(), projectsDir: tmp(), dropDir: tmp(), appVersion: "0.2.5" });
    // A restart on the same version records nothing new; a newer one records the step.
    createCore({ log, runtime: new MockRuntime(), projectsDir: tmp(), dropDir: tmp(), appVersion: "0.2.5" });
    createCore({ log, runtime: new MockRuntime(), projectsDir: tmp(), dropDir: tmp(), appVersion: "0.2.9" });
    expect(log.list({ type: "app.updated" }).map((e) => e.payload)).toEqual([{ from: null, to: "0.2.5" }, { from: "0.2.5", to: "0.2.9" }]);

    const server = createServer(core);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const h = await (await fetch(`${base}/api/health`)).json();
      expect(h.appVersion).toBe("0.2.5");
      expect(h.activeRuns).toBe(0);
      const u = await (await fetch(`${base}/api/updates`)).json();
      expect(u.auto).toBe(true);
      expect(u.history.map((x: { from: string | null; to: string }) => `${x.from}->${x.to}`)).toEqual(["0.2.5->0.2.9", "null->0.2.5"]);
      const off = await (await fetch(`${base}/api/updates`, { method: "POST", body: JSON.stringify({ auto: false }) })).json();
      expect(off.auto).toBe(false);
      expect(readSettings(log).autoUpdate).toBe(false);
      expect((await fetch(`${base}/api/updates`, { method: "POST", body: JSON.stringify({ auto: "yes" }) })).status).toBe(400);
    } finally { server.close(); }
  });

  it("records nothing when the shell does not say its version (dev runs, tests)", () => {
    const log = new EventLog();
    createCore({ log, runtime: new MockRuntime(), projectsDir: tmp(), dropDir: tmp() });
    expect(log.list({ type: "app.updated" })).toEqual([]);
  });
});
