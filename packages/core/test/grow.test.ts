import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { EventLog, Factory, MockRuntime, createCore, createProject, git, type AgentRuntime } from "../src/index.js";
import { leftAtShip, leftOfRun, nothingLeft } from "../src/factory/leftover.js";
import { finishLeft, shippedAppOf, standingOf } from "../src/tickets/grow.js";

const tmp = () => mkdtempSync(join(tmpdir(), "sf-grow-"));
const events = (log: EventLog, type: string) => log.list({ limit: 1e6 }).filter((e) => e.type === type).map((e) => e.payload as any);

describe("a new project is sized from its plan", () => {
  it("the plan gate names what the whole plan takes, and approving sets the run's limit to it", async () => {
    const log = new EventLog();
    const mock = new MockRuntime({ plantBug: false });
    // A real crew by name (it has a workbench), answering like the practice crew.
    const rt: AgentRuntime = { name: "claude-code:fake", run: (req) => mock.run(req) };
    const f = new Factory(log, rt, tmp());
    const run = f.start("a writing desk that counts words");
    expect(events(log, "factory.run.started").at(-1).sizeFromPlan).toBe(true);
    let gate: any;
    for (let i = 0; i < 400 && !gate; i++) { await new Promise((r) => setTimeout(r, 25)); gate = events(log, "factory.gate").find((g) => g.run === run && g.gate === "gateA" && g.state === "waiting"); }
    expect(gate, "the run reached its plan gate").toBeTruthy();
    expect(gate.size.fromUsd).toBe(1.5);
    expect(gate.size.toUsd).toBeGreaterThan(1.5);
    expect(gate.size.toUsd).toBeLessThanOrEqual(12);
    expect(gate.question).toMatch(/Approving sets this run's limit to \$/);
    f.decide(run, "gateA", { approve: true, by: "you" });
    let budget: any;
    for (let i = 0; i < 200 && !budget; i++) { await new Promise((r) => setTimeout(r, 25)); budget = events(log, "factory.budget").find((b) => b.run === run && b.sized); }
    expect(budget.maxUsd).toBe(gate.size.toUsd);
    f.stop(run, { by: "test" });
    await f.wait(run).catch(() => {});
  }, 60000);

  it("a run given its own limit, or one nobody watches, keeps that limit", async () => {
    const log = new EventLog();
    const mock = new MockRuntime({ plantBug: false });
    const f = new Factory(log, { name: "claude-code:fake", run: (req) => mock.run(req) }, tmp());
    f.start("a writing desk that counts words", { maxUsd: 2 });
    f.start("a reading list with notes", { autoApprove: true });
    const started = events(log, "factory.run.started");
    expect(started[0].sizeFromPlan).toBeUndefined();
    expect(started[1].sizeFromPlan).toBeUndefined();
    for (const s of log.list({ type: "factory.run.started", limit: 10 })) { f.stop(s.id, { by: "test" }); await f.wait(s.id).catch(() => {}); }
  }, 60000);
});

describe("what a shipped version left to do", () => {
  it("is read from the judge's last look, the Reviewer's last notes and the features never built", () => {
    const log = new EventLog();
    const run = log.append("factory.run.started", { idea: "x" }).id;
    log.append("factory.evaluation", { run, round: 1, pass: false, requirements: [{ id: "R1", met: false, evidence: "old" }] });
    log.append("factory.evaluation", { run, round: 2, pass: false, requirements: [{ id: "R1", met: true, evidence: "seen" }, { id: "R2", met: false, evidence: "No export button on any screen" }] });
    log.append("factory.evaluation", { run: run + 999, round: 1, requirements: [{ id: "R9", met: false, evidence: "another run" }] });
    log.append("factory.review", { run, round: 1, verdict: "pass", findings: [{ severity: "low", text: "Totals are rounded twice." }] });
    const docs = { requirements: [{ id: "R2", text: "Export the board as CSV", from: "person", must: true }] } as any;
    const left = leftAtShip(log, run, docs, [{ id: "F1", title: "Shell", state: "built" }, { id: "F4", title: "Screen: Money", state: "todo" }, { id: "F5", title: "Screen: Guide", state: "broken" }]);
    expect(left.unmet).toEqual([{ id: "R2", text: "Export the board as CSV", evidence: "No export button on any screen" }]);
    expect(left.judged).toBe(2);
    expect(left.notes).toEqual([{ severity: "low", text: "Totals are rounded twice." }]);
    expect(left.features.map((x) => x.id)).toEqual(["F4"]);
    expect(nothingLeft(left)).toBe(false);
    // Low notes alone do not start a next version.
    expect(nothingLeft({ unmet: [], judged: 3, features: [], notes: [{ severity: "low", text: "x" }] })).toBe(true);
    expect(nothingLeft(leftAtShip(log, run + 5000, null))).toBe(true);
  });

  it("keeps what the version before left until a judge sees it working (run 11986 read \"0 of 2\")", () => {
    const log = new EventLog();
    const v1 = log.append("factory.run.started", { idea: "x" }).id;
    log.append("factory.evaluation", { run: v1, round: 1, pass: false, requirements: [
      { id: "R1", met: false, evidence: "no type picker" }, { id: "R2", met: true, evidence: "seen" }, { id: "R3", met: false, evidence: "no history" },
      { id: "SC1", met: false, evidence: "empty", text: "The Money screen shows totals" },
    ] });
    const v2 = log.append("factory.run.started", { idea: "x", screen: { kind: "feature", baseRun: v1 } }).id;
    log.append("factory.evaluation", { run: v2, round: 1, pass: false, requirements: [
      { id: "R1", met: true, evidence: "picker shown" }, { id: "SC1", met: false, evidence: "nothing pinned", text: "The board shows pinned ideas" },
    ] });
    const left = leftOfRun(log, v2);
    expect(left.unmet.map((r) => r.id)).toEqual(["SC1", "R3", "SC1"]);
    expect(left.unmet[1].evidence).toBe("Not checked again in this version. Before: no history");
    // 4 judged in v1, one new screen item in v2: 5, of which R1 and R2 work.
    expect(left.judged).toBe(5);
    expect(left.judged - left.unmet.length).toBe(2);
  });
});

describe("a project keeps going after its first version", () => {
  it("what a version left becomes the project's ticket, and working it builds the next version of the same app", async () => {
    const dir = tmp();
    const log = new EventLog(":memory:");
    const core = createCore({ log, runtime: new MockRuntime({ delayMs: 0, plantBug: false }), projectsDir: join(dir, "projects"), order: { mode: "heuristic" } });
    const server = createServer(core);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      const project = createProject(log, { name: "Writing Desk" });
      expect(shippedAppOf(log, project)).toBeNull();
      const first = core.factory.start("a writing desk that counts words", { autoApprove: true, projectId: project });
      await core.factory.wait(first);
      const shipped = events(log, "factory.run.finished").filter((p) => p.run === first).at(-1);
      expect(shipped.outcome).toBe("shipped");
      expect(shippedAppOf(log, project)).toBe(first);

      // The version left one requirement not working: it is the project's next ticket, asked for and ready.
      log.append("factory.left", { run: first, plan: "Writing Desk", version: "v0.1.0", baseRun: null, judged: 4, unmet: [{ id: "R3", text: "Show a reading-time estimate", evidence: "No estimate on the desk screen" }], notes: [], features: [] });
      let list = (await (await fetch(`${base}/api/tickets?project=${project}&view=all`)).json()).tickets as any[];
      const t = list.find((x) => /finish what v0\.1\.0 left \(1 requirement\)/.test(x.title));
      expect(t, "the ticket for what v0.1.0 left").toBeTruthy();
      expect(t.status).toBe("ready");
      expect(events(log, "ticket.asked").some((a) => a.id === t.id && a.on)).toBe(true);
      // The same list again files nothing new.
      log.append("factory.left", { run: first, plan: "Writing Desk", version: "v0.1.0", unmet: [{ id: "R3", text: "x", evidence: "y" }], notes: [], features: [] });
      list = (await (await fetch(`${base}/api/tickets?project=${project}&view=all`)).json()).tickets as any[];
      expect(list.filter((x) => /finish what v0\.1\.0 left/.test(x.title)).length).toBe(1);

      // Working it is the next version of the app that shipped: same folder, next tag. Not a new app.
      // The crew starts it by itself (it is asked for); a press does the same when the crew is off.
      for (let i = 0; i < 40 && events(log, "factory.run.started").length < 2; i++) await new Promise((r) => setTimeout(r, 25));
      if (events(log, "factory.run.started").length < 2) expect((await post(`/api/tickets/${t.id}/work`, { autoApprove: true })).status).toBeLessThan(300);
      const next = events(log, "factory.run.started").length;
      const started = log.list({ type: "factory.run.started", limit: 10 }).at(-1)!;
      expect((started.payload as any).screen).toMatchObject({ kind: "feature", baseRun: first, keepDesign: true });
      expect((started.payload as any).council).toBe("never");
      expect(next).toBe(2);
      await core.factory.wait(started.id);
      const fin = events(log, "factory.run.finished").filter((p) => p.run === started.id).at(-1);
      expect(fin).toMatchObject({ outcome: "shipped", dir: shipped.dir });
      expect(git(shipped.dir, "tag", "--list", "v*").split("\n").sort()).toEqual(["v0.1.0", "v0.2.0"]);

      // Said in the project's own box: also the next version, on a ticket, in the same folder.
      const said = await post("/api/factory/runs", { idea: "add a dark theme", projectId: project, autoApprove: true });
      expect(said.status).toBe(202);
      const j = await said.json();
      expect(j.onTop).toBe(true);
      expect(j.ticket.id).toBeGreaterThan(0);
      await core.factory.wait(j.run);
      expect(events(log, "factory.run.finished").filter((p) => p.run === j.run).at(-1)).toMatchObject({ outcome: "shipped", dir: shipped.dir });
      // A new app is still a press away.
      const fresh = await post("/api/factory/runs", { idea: "a separate tool that sorts files", projectId: project, newApp: true, autoApprove: true });
      const fj = await fresh.json();
      expect(fj.onTop).toBeUndefined();
      await core.factory.wait(fj.run).catch(() => {});
    } finally { server.close(); }
  }, 120000);

  it("a version that did not bring the list down waits for the person instead of looping", () => {
    const log = new EventLog(":memory:");
    const core = createCore({ log, runtime: new MockRuntime({ delayMs: 0 }), projectsDir: join(tmp(), "projects"), order: { mode: "heuristic" } });
    const project = createProject(log, { name: "Stuck App" });
    const a = log.append("factory.run.started", { idea: "v1", projectId: project }).id;
    log.append("project.linked", { projectId: project, kind: "factory_run", ref: String(a) });
    const b = log.append("factory.run.started", { idea: "v2", projectId: project }).id;
    log.append("project.linked", { projectId: project, kind: "factory_run", ref: String(b) });
    const unmet = [{ id: "R1", text: "a", evidence: "" }, { id: "R2", text: "b", evidence: "" }];
    log.append("factory.left", { run: a, plan: "Stuck App", version: "v0.1.0", baseRun: null, unmet, notes: [], features: [] });
    log.append("factory.left", { run: b, plan: "Stuck App", version: "v0.2.0", baseRun: a, unmet, notes: [], features: [] });
    const asked = events(log, "ticket.asked");
    const tickets = (core as any).tickets ?? null;
    void tickets;
    const opened = events(log, "ticket.opened").filter((o) => /finish what/.test(o.title ?? ""));
    expect(opened.length).toBe(2);
    expect(opened[0].asked ?? asked.some((x) => x.on)).toBeTruthy();
    const notes = events(log, "ticket.noted").map((n) => String(n.text));
    expect(notes.some((n) => /not getting shorter/.test(n))).toBe(true);
  });

  it("where a project stands: what the judge saw, what is left, and one press hands the list to the crew", () => {
    const log = new EventLog(":memory:");
    createCore({ log, runtime: new MockRuntime({ delayMs: 0 }), projectsDir: join(tmp(), "projects"), order: { mode: "heuristic" } });
    const project = createProject(log, { name: "Old App" });
    expect(standingOf(log, project)).toBeNull();
    expect(finishLeft(log, project)).toMatch(/no shipped app/);
    const run = log.append("factory.run.started", { idea: "v1", projectId: project }).id;
    log.append("project.linked", { projectId: project, kind: "factory_run", ref: String(run) });
    log.append("factory.evaluation", { run, round: 1, pass: false, requirements: [{ id: "R1", met: true }, { id: "R2", met: true }, { id: "R3", met: false, evidence: "No export button" }] });
    log.append("factory.review", { run, round: 1, verdict: "pass", findings: [{ severity: "high", text: "Saves can be lost." }, { severity: "low", text: "Naming." }] });
    log.append("factory.run.finished", { run, outcome: "shipped", planName: "Old App", totalUsd: 1.2 });
    // It shipped before the list was kept: no ticket has it.
    let s = standingOf(log, project)!;
    expect(s).toMatchObject({ run, version: "v0.1.0", judged: 3, working: 2, done: false, ticket: null });
    expect(s.versions.map((v) => v.run)).toEqual([run]);
    expect(finishLeft(log, project)).toBeNull();
    s = standingOf(log, project)!;
    expect(s.ticket).toMatchObject({ asked: true });
    expect(s.ticket!.title).toMatch(/finish what v0\.1\.0 left \(1 requirement, 2 notes\)/);
    // Pressing again files nothing new.
    expect(finishLeft(log, project)).toBeNull();
    expect(events(log, "ticket.opened").filter((o) => /finish what/.test(o.title ?? "")).length).toBe(1);
  });
});

describe("the Tester's money follows the plan", () => {
  it("a small plan keeps the Tester's own budget, a big one gets more, never past 15% of the run", async () => {
    const { testsCapUsd } = await import("../src/factory/runkit.js");
    expect(testsCapUsd(0.3, 3, 1.5)).toBe(0.3);
    expect(testsCapUsd(0.3, 14, 6.89)).toBeCloseTo(0.9, 5);
    expect(testsCapUsd(0.3, 40, 6.89)).toBeCloseTo(6.89 * 0.15, 5);
    expect(testsCapUsd(0.3, 40, 1.5)).toBe(0.3);
  });
});
