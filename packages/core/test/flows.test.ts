import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventLog, MockRuntime, Factory, AgentBay, Tickets, FlowLibrary, NEW_PROJECT_FLOW, REPO_CHANGE_FLOW, BUILT_IN_FLOWS, flowProblems, flowOfRun, roundsOf, stepsToRun, traceOf,
  type FlowDef,
} from "../src/index.js";

const tmp = (p = "sf-flows-") => mkdtempSync(join(tmpdir(), p));
const events = (log: EventLog, type: string) => log.list({ limit: 1e6 }).filter((e) => e.type === type).map((e) => e.payload as any);
const clone = (f: FlowDef): FlowDef => structuredClone(f);
/** The stations a run passed through, in order, each once (the first time it was marked). */
const stationOrder = (log: EventLog, run: number) => [...new Set(events(log, "factory.station").filter((p) => p.run === run && p.state !== "active").map((p) => p.station))];

describe("flows: the engine as data", () => {
  it("ships two built-in flows that the check accepts, carrying out the fixed pipeline's order", () => {
    for (const f of BUILT_IN_FLOWS) expect(flowProblems(f)).toEqual([]);
    expect(stepsToRun(NEW_PROJECT_FLOW).map((s) => s.action)).toEqual(["intake", "council", "discover", "plan", "tests", "build", "testFix", "review", "evaluate", "accept", "ship"]);
    expect(stepsToRun(REPO_CHANGE_FLOW).map((s) => s.action)).toEqual(stepsToRun(NEW_PROJECT_FLOW).map((s) => s.action));
    // Every step names who works it; gate A and the Fixer are drawn, and carried out inside their loops.
    expect(NEW_PROJECT_FLOW.steps.find((s) => s.id === "gateA")).toMatchObject({ kind: "gate", within: "plan" });
    expect(NEW_PROJECT_FLOW.steps.find((s) => s.id === "fix")).toMatchObject({ within: "test", agents: ["fix"] });
    expect(NEW_PROJECT_FLOW.steps.find((s) => s.id === "discover")!.agents).toEqual(["design", "critique"]);
    // The loop limits the engine reads are today's numbers.
    expect([roundsOf(NEW_PROJECT_FLOW, "council", 0), roundsOf(NEW_PROJECT_FLOW, "discover", 0), roundsOf(NEW_PROJECT_FLOW, "evaluate", 0)]).toEqual([2, 3, 2]);
  });

  it("says every problem that would stop a flow from running", () => {
    const f = clone(NEW_PROJECT_FLOW);
    f.steps = f.steps.filter((s) => s.action !== "tests");
    f.steps.find((s) => s.id === "build")!.agents = ["janitor"];
    f.steps.find((s) => s.id === "council")!.loop!.maxRounds = 40;
    const ship = f.steps.find((s) => s.id === "ship")!;
    f.steps = [ship, ...f.steps.filter((s) => s !== ship)];
    f.steps.push({ ...f.steps[1], id: "again" });
    f.steps.push({ id: "magic", label: "Magic", sub: "", kind: "step", action: "teleport" as any, agents: [], stop: "ship", at: { x: 0, y: 0 } });
    const p = flowProblems(f).join("\n");
    expect(p).toMatch(/must tests/i);
    expect(p).toMatch(/"janitor", which is not a crew slot/);
    expect(p).toMatch(/1 to 6 rounds/);
    expect(p).toMatch(/"Ship" must come after/);
    expect(p).toMatch(/repeats/);
    expect(p).toMatch(/"teleport", which the whole engine cannot do/);
    expect(p).toMatch(/line goes from "tests"/);
  });

  it("copies the flow onto each run's started event, and a run follows the flow it started with", async () => {
    const log = new EventLog(":memory:");
    const f = new Factory(log, new MockRuntime(), tmp());
    const run = f.start("a word counter for my notes", { autoApprove: true });
    expect((log.get(run)!.payload as any).flow).toMatchObject({ id: "new-project", version: 1, builtIn: true });
    await f.wait(run);
    expect(events(log, "factory.run.finished").at(-1)).toMatchObject({ run, outcome: "shipped" });
    expect(stationOrder(log, run)).toEqual(["intake", "council", "discover", "plan", "gateA", "tests", "build", "test", "fix", "review", "evaluate", "gateB", "ship"]);
    expect(flowOfRun(log, run).id).toBe("new-project");
  }, 60_000);

  it("keeps every saved version, refuses a flow that cannot run, and puts a built-in back", () => {
    const log = new EventLog(":memory:");
    const lib = new FlowLibrary(log);
    expect(lib.get("new-project")).toMatchObject({ version: 1, builtIn: true });
    const edit = clone(NEW_PROJECT_FLOW);
    edit.steps.find((s) => s.id === "discover")!.loop!.maxRounds = 2;
    expect(lib.save(edit, "Assaf")).toMatchObject({ version: 2, builtIn: false });
    expect(lib.get("new-project")!.steps.find((s) => s.id === "discover")!.loop!.maxRounds).toBe(2);
    const broken = clone(edit);
    broken.steps = broken.steps.filter((s) => s.action !== "ship");
    expect(() => lib.save(broken)).toThrow(/cannot be saved: .*ship/i);
    expect(lib.get("new-project")!.version).toBe(2);
    expect(lib.reset("new-project")).toMatchObject({ version: 3, builtIn: true });
    expect(lib.history("new-project").map((h) => [h.version, h.savedBy])).toEqual([[2, "Assaf"], [3, "you"]]);
    expect(lib.version("new-project", 2)!.steps.find((s) => s.id === "discover")!.loop!.maxRounds).toBe(2);
    expect(lib.list().find((x) => x.id === "new-project")).toMatchObject({ version: 3, builtIn: true, savedBy: "you" });
    // A table rebuilt from the log has the same versions.
    expect(log.db.prepare("SELECT count(*) AS n FROM flows").get()).toMatchObject({ n: 2 });
  });

  it("follows a saved flow: optional steps left out are not run, and an edit never changes a run already going", async () => {
    const log = new EventLog(":memory:");
    const rt = new MockRuntime();
    const f = new Factory(log, rt, tmp());
    const lean = clone(NEW_PROJECT_FLOW);
    lean.steps = lean.steps.filter((s) => !["council", "review"].includes(s.id));
    lean.edges = lean.edges.filter((e) => ![e.from, e.to].some((x) => x === "council" || x === "review"));
    lean.edges.push({ from: "test", to: "evaluate", kind: "next" });
    f.flows.save(lean);
    const run = f.start("a word counter for my notes", { autoApprove: true, council: "always" });
    // Edited while it runs: the run keeps the copy it started with.
    f.flows.reset("new-project");
    await f.wait(run);
    expect(events(log, "factory.run.finished").at(-1)).toMatchObject({ run, outcome: "shipped" });
    const order = stationOrder(log, run);
    expect(order).not.toContain("council");
    expect(order).not.toContain("review");
    expect(order).toEqual(["intake", "discover", "plan", "gateA", "tests", "build", "test", "fix", "evaluate", "gateB", "ship"]);
    expect(flowOfRun(log, run).version).toBe(2);
    expect(rt.calls.some((c) => /Station contract: council/.test(c.systemPrompt ?? ""))).toBe(false);
  }, 60_000);

  it("reads the council's round limit from the flow", async () => {
    const log = new EventLog(":memory:");
    const f = new Factory(log, new MockRuntime(), tmp());
    const one = clone(NEW_PROJECT_FLOW);
    one.steps.find((s) => s.id === "council")!.loop!.maxRounds = 1;
    one.id = "one-round";
    one.name = "One council round";
    f.flows.save(one);
    const run = f.start("a word counter for my notes", { autoApprove: true, council: "always", flow: "one-round" });
    await f.wait(run);
    expect(Math.max(...events(log, "factory.council").filter((p) => p.run === run).map((p) => p.round))).toBe(1);
    expect(() => f.start("x", { flow: "no-such-flow" })).toThrow(/no flow "no-such-flow"/);
  }, 60_000);
});

describe("a ticket's one timeline", () => {
  it("has what was said and what the crew did, in order, append-only", async () => {
    const log = new EventLog();
    const rt = new MockRuntime();
    const bay = new AgentBay(log, rt);
    const f = new Factory(log, rt, tmp(), bay);
    const t = new Tickets(log, { runtime: rt, factory: f, bay });
    const bug = t.open({ kind: "bug", title: "A word counter that counts words", answers: { expected: "Counts words in a file" } });
    t.say(bug.id, "Please keep it small.");
    const notesBefore = t.notes(bug.id).length;
    const { run } = t.work(bug.id, { autoApprove: true });
    await f.wait(run!);
    const tl = t.timeline(bug.id);
    const cats = new Set(tl.map((r) => r.cat));
    for (const c of ["event", "said", "run", "step", "agent", "decision", "retry", "status"]) expect(cats, c).toContain(c);
    // In order and append-only: event ids only grow, and the thread's own notes are all on it.
    expect(tl.map((r) => r.eventId)).toEqual([...tl.map((r) => r.eventId)].sort((a, b) => a - b));
    expect(tl.filter((r) => r.cat === "said").map((r) => r.text)).toContain("Please keep it small.");
    expect(t.notes(bug.id).length).toBeGreaterThan(notesBefore);
    expect(t.notes(bug.id).every((n) => tl.some((r) => r.eventId === n.eventId))).toBe(true);
    // The crew's part: each step, agent calls with their cost, the gates' decisions, the fix rounds.
    expect(tl.some((r) => r.cat === "step" && /^Build passed/.test(r.text) && r.run === run)).toBe(true);
    expect(tl.some((r) => r.cat === "agent" && / answered at build/.test(r.text) && r.costUsd != null)).toBe(true);
    expect(tl.some((r) => r.cat === "decision" && /Your OK on the plan: approved/.test(r.text))).toBe(true);
    expect(tl.some((r) => r.cat === "retry" && /^Fix round 1/.test(r.text))).toBe(true);
    expect(tl.filter((r) => r.cat === "run").map((r) => r.text).join("\n")).toMatch(/Run #\d+ shipped/);
    // The detail the Bridge reads carries it, and a rebuild from the log gives the same rows.
    expect(t.detail(bug.id)!.timeline.length).toBe(tl.length);
    log.rebuild("tickets");
    expect(t.timeline(bug.id)).toEqual(tl);
  }, 90_000);

  it("turns engine and agent events into plain rows, only for runs a ticket works", () => {
    const of = (run: number) => (run === 7 ? 3 : null);
    expect(traceOf("factory.station", { run: 7, station: "build", state: "pass" }, of)).toMatchObject({ ticket: 3, cat: "step", text: "Build passed" });
    expect(traceOf("factory.station", { run: 7, station: "build", state: "active" }, of)).toBeNull();
    expect(traceOf("factory.station", { run: 8, station: "build", state: "pass" }, of)).toBeNull();
    expect(traceOf("factory.gate", { run: 7, gate: "gateB", state: "rejected", note: "the list is empty", by: "you" }, of)).toMatchObject({ cat: "decision", text: "Your OK on the build: sent back by you: the list is empty" });
    expect(traceOf("factory.gate", { run: 7, gate: "escalation", state: "approved", kind: "retry", station: "review", attempt: 1, by: "auto" }, of)).toMatchObject({ cat: "retry" });
    expect(traceOf("agent.run.failed", { agent: "builder", ticket: 5, station: "repo", error: "timed out", costUsd: 0.02 }, of)).toMatchObject({ ticket: 5, cat: "agent", cost: 0.02 });
    expect(traceOf("ticket.step", { id: 5, step: "tests", state: "passed" }, of)).toMatchObject({ ticket: 5, cat: "step", text: "tests: passed" });
    expect(traceOf("ticket.step", { id: 5, step: "tests", state: "failed" }, of)).toBeNull();
  });
});
