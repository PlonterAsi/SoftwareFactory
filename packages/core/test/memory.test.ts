import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentBay, EventLog, Factory, FlowLibrary, MEMORY_LIMIT, MockRuntime, NEW_PROJECT_FLOW, SMALL_CHANGE_FLOW, crewPick, flowProblems, memoryBlock, memoryOf, noteLesson,
  parseDream, rememberLines, runAgent, tidyPlan, type AgentRequest, type FlowDef, type Lesson,
} from "../src/index.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const events = (log: EventLog, type: string) => log.list({ limit: 1e6 }).filter((e) => e.type === type).map((e) => e.payload as any);

/** The mock crew, with some answers replaced, under another name so the Bay treats it as a real crew. */
function scripted(over: (req: AgentRequest, n: number) => string | undefined, name = "mock"): MockRuntime {
  const rt = new MockRuntime({ plantBug: false });
  const base = rt.run.bind(rt);
  let n = 0;
  rt.run = async (req) => { const r = await base(req); const t = over(req, ++n); if (t !== undefined) r.text = t; return r; };
  if (name !== "mock") Object.defineProperty(rt, "name", { value: name });
  return rt;
}
const L = (id: number, text: string, source: Lesson["source"] = "self"): Lesson => ({ id, agent: "a", text, source, ref: null, at: "2026-11-17T00:00:00Z" });

describe("an agent's own memory", () => {
  it("keeps each lesson once, says repeats and near repeats only once", () => {
    const log = new EventLog();
    expect(noteLesson(log, "builder", "Keep the data layer in data.js, never in the screens.", "self")).toBeTruthy();
    expect(noteLesson(log, "builder", "keep the data layer in data.js; never in the screens", "review")).toBeNull();
    expect(noteLesson(log, "builder", "Check the port is free before starting the server.", "person")).toBeTruthy();
    expect(noteLesson(log, "builder", "  ", "person")).toBeNull();
    expect(memoryOf(log, "builder").map((l) => l.source)).toEqual(["self", "person"]);
    expect(memoryOf(log, "planner")).toEqual([]);
  });

  it("goes into the prompt between the agent's own words and the station contract, yours first", () => {
    const log = new EventLog();
    const bay = new AgentBay(log);
    bay.teach("builder", "Always write the README last.");
    noteLesson(log, "builder", "A reviewer sent back my build for: no empty state on the list screen", "review");
    const [b] = bay.crewFor("build");
    const role = b.role;
    expect(role.indexOf("Your memory")).toBeGreaterThan(0);
    expect(role.indexOf("Your memory")).toBeLessThan(role.indexOf("Station contract: build."));
    expect(role.indexOf("Always write the README last.")).toBeLessThan(role.indexOf("no empty state"));
    expect(b.memory).toContain("Remember:");
    // Nothing yet: it is told it may note lessons.
    expect(bay.crewFor("plan")[0].role).toContain("Your memory: nothing yet.");
    expect(() => bay.teach("builder", "always write the readme last")).toThrow(/already remembers/);
  });

  it("shows at most twelve lessons in a prompt and says how many it left out", () => {
    const many = Array.from({ length: 20 }, (_, i) => L(i + 1, `Lesson number ${i + 1} about topic ${"abcdefghijklmnopqrst"[i]}`));
    const block = memoryBlock(many);
    expect(block.split("\n").filter((x) => x.startsWith("- "))).toHaveLength(12);
    expect(block).toContain("Lesson number 20");
    expect(block).not.toContain("Lesson number 1 ");
    expect(block).toContain("8 older lessons not shown");
  });

  it("picks up the Remember: lines an agent writes, but not from a test run in the Bay", async () => {
    expect(rememberLines("```json\n{}\n```\nRemember: run the tests before the review.\n**Remember:** short")).toEqual(["run the tests before the review."]);
    const log = new EventLog();
    const rt = scripted(() => "Done.\nRemember: the kit's data layer is already in the folder; read it first.");
    await runAgent(log, rt, "builder", { prompt: "x" }, { factoryRun: 7 });
    expect(memoryOf(log, "builder")).toMatchObject([{ text: "the kit's data layer is already in the folder; read it first.", source: "self", ref: "run:7" }]);
    await runAgent(log, rt, "planner", { prompt: "x" }, { bayTest: true });
    expect(memoryOf(log, "planner")).toEqual([]);
  });

  it("a review that sends a build back teaches the agent that built it", async () => {
    const log = new EventLog();
    let reviews = 0;
    const rt = scripted((req) => {
      if (!req.systemPrompt?.includes("Station contract: review.") || reviews++) return undefined;
      return "```json\n" + JSON.stringify({ verdict: "fix", findings: [{ severity: "high", text: "The list screen has no empty state." }] }) + "\n```";
    });
    const f = new Factory(log, rt, tmp("sf-proj-"), new AgentBay(log, rt));
    await f.wait(f.start("count words", { autoApprove: true }));
    expect(memoryOf(log, "builder").map((l) => [l.source, l.text])).toContainEqual(["review", "A reviewer sent back my build for: The list screen has no empty state."]);
  });
});

describe("cleaning a memory", () => {
  it("the free tidy drops repeats (the newest stays) and the oldest past the limit, never yours", () => {
    const { keep, drop } = tidyPlan([L(1, "Use port 4100 for the dev server"), L(2, "Use port 4100 for the dev server!"), L(3, "Old lesson one", "person"), L(4, "Old lesson two"), L(5, "Old lesson three")], 3);
    expect(drop.map((d) => d.id).sort()).toEqual([1, 2]);
    expect(keep.map((k) => k.id)).toEqual([3, 4, 5]);
  });

  it("tidies by itself when a memory grows past the limit", () => {
    const log = new EventLog();
    for (let i = 0; i <= MEMORY_LIMIT; i++) noteLesson(log, "fixer", `Distinct lesson ${i} on ${["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"][i % 8]} ${"x".repeat(i)}`, "self");
    expect(memoryOf(log, "fixer")).toHaveLength(MEMORY_LIMIT);
    expect(events(log, "agent.memory.removed").at(-1)).toMatchObject({ agent: "fixer", by: "auto" });
  });

  it("on the practice crew a dream proposes the free tidy; nothing changes until you accept, and newer lessons stay", async () => {
    const log = new EventLog();
    const bay = new AgentBay(log, new MockRuntime());
    await expect(bay.dream("builder")).rejects.toThrow(/nothing to clean/);
    noteLesson(log, "builder", "Read the kit before building", "self");
    noteLesson(log, "builder", "Write tests that touch the data layer", "self");
    log.append("agent.memory.noted", { agent: "builder", text: "Read the kit before building.", source: "self" }); // a repeat that slipped in
    const d = await bay.dream("builder");
    expect(d).toMatchObject({ state: "proposed", by: "free", costUsd: 0 });
    expect(d.dropped).toHaveLength(1);
    expect(memoryOf(log, "builder")).toHaveLength(3);
    await expect(bay.dream("builder")).rejects.toThrow(/waiting on you/);
    await expect(bay.dream("planner", 2)).rejects.toThrow(/at most \$0.60/);
    bay.teach("builder", "Ask before adding a dependency.");
    const done = bay.acceptDream(d.id);
    expect(done.state).toBe("accepted");
    expect(memoryOf(log, "builder").map((l) => l.text)).toEqual(["Write tests that touch the data layer", "Read the kit before building.", "Ask before adding a dependency."]);
    expect(() => bay.acceptDream(d.id)).toThrow(/already accepted/);
    expect(bay.state().dreams[0]).toMatchObject({ id: d.id, state: "accepted" });
  });

  it("a real crew's dream is one capped call; a merged lesson replaces the ones it came from", async () => {
    const log = new EventLog();
    const answer = (ids: number[]) => "```json\n" + JSON.stringify({ lessons: [{ text: "Read the kit and its data layer before building.", from: [ids[0], ids[1]] }, { text: "made up", from: [999] }], dropped: [{ id: ids[2], why: "about one finished job" }] }) + "\n```";
    let ids: number[] = [];
    const rt = scripted((req) => (req.systemPrompt?.includes("Station contract: dream.") ? answer(ids) : undefined), "claude-code");
    const bay = new AgentBay(log, rt);
    for (const t of ["Read the kit first", "Look at the data layer before building", "The word app needed a goal field", "Never push to main"]) noteLesson(log, "builder", t, t.startsWith("Never") ? "person" : "self");
    ids = memoryOf(log, "builder").map((l) => l.id);
    const d = await bay.dream("builder", 0.05);
    expect(d.by).toBe("agent");
    expect(events(log, "agent.run.started").find((e) => e.station === "dream")).toMatchObject({ agent: "builder", model: "haiku", budgetUsd: 0.05 });
    expect(d.lessons.map((l) => l.text)).toEqual(["Read the kit and its data layer before building.", "Never push to main"]);
    bay.acceptDream(d.id);
    expect(memoryOf(log, "builder").map((l) => [l.text, l.source])).toEqual([["Never push to main", "person"], ["Read the kit and its data layer before building.", "dream"]]);
  });

  it("reads a dream answer safely: yours word for word, what it forgot kept, what it made up left out", () => {
    const mem = [L(1, "A"), L(2, "B lesson"), L(3, "Taught lesson", "person"), L(4, "D lesson")];
    const r = parseDream("```json\n" + JSON.stringify({ lessons: [{ text: "AB merged", from: [1, 2, 3] }, { text: "ghost", from: [] }], dropped: [{ id: 3, why: "x" }] }) + "\n```", mem);
    expect(r.lessons).toEqual([{ text: "AB merged", from: [1, 2] }, { text: "Taught lesson", from: [3] }, { text: "D lesson", from: [4] }]);
    expect(r.dropped).toEqual([]);
    expect(() => parseDream("no json", mem)).toThrow();
  });

  it("a rejected dream changes nothing", async () => {
    const log = new EventLog();
    const bay = new AgentBay(log, new MockRuntime());
    noteLesson(log, "planner", "One", "self"); noteLesson(log, "planner", "Two lessons here", "self");
    const d = await bay.dream("planner");
    expect(bay.rejectDream(d.id).state).toBe("rejected");
    expect(memoryOf(log, "planner")).toHaveLength(2);
    expect(bay.forget("planner", [memoryOf(log, "planner")[0].id])).toBe(1);
    expect(() => bay.forget("planner", [12345])).toThrow(/no such lesson/);
  });
});

describe("flow steps name their agents", () => {
  const withCrew = (flow: FlowDef, slot: string, crew: string[]): FlowDef => ({ ...structuredClone(flow), steps: flow.steps.map((s) => (s.agents[0] === slot ? { ...s, crew } : s)) });

  it("checks the names: Bay ids, a step with an agent, the station's seats", () => {
    expect(flowProblems(withCrew(NEW_PROJECT_FLOW, "build", ["night-builder"]))).toEqual([]);
    expect(flowProblems(withCrew(NEW_PROJECT_FLOW, "build", ["a", "b"])).join(" ")).toMatch(/takes 1/);
    expect(flowProblems(withCrew(NEW_PROJECT_FLOW, "build", ["Not An Id"])).join(" ")).toMatch(/Bay ids/);
    expect(flowProblems(withCrew(NEW_PROJECT_FLOW, "council", ["a", "b", "c", "d"]))).toEqual([]);
    expect(crewPick(withCrew(NEW_PROJECT_FLOW, "build", ["night-builder"]), "build")).toEqual(["night-builder"]);
    expect(crewPick(NEW_PROJECT_FLOW, "build")).toBeUndefined();
  });

  it("refuses to save a flow that names an agent the Bay does not have", () => {
    const log = new EventLog();
    const bay = new AgentBay(log);
    const lib = new FlowLibrary(log);
    lib.agentsKnown = () => new Set(bay.agents().filter((a) => !a.retired).map((a) => a.def.id));
    expect(() => lib.save(withCrew(SMALL_CHANGE_FLOW, "build", ["nobody"]))).toThrow(/not an active agent/);
    expect(lib.save(withCrew(SMALL_CHANGE_FLOW, "build", ["fixer"])).steps.find((s) => s.agents[0] === "build")?.crew).toEqual(["fixer"]);
  });

  it("the engine gives a step to the agent its flow names, with that agent's memory; a retired pick falls back to the station", async () => {
    const log = new EventLog();
    const rt = new MockRuntime();
    const bay = new AgentBay(log, rt);
    const night = bay.clone("builder", "Night Builder");
    bay.save(night.def.id, { prompt: "You build at night, carefully." });
    bay.teach(night.def.id, "Name files after what they hold.");
    const f = new Factory(log, rt, tmp("sf-proj-"), bay);
    f.flows.save(withCrew(NEW_PROJECT_FLOW, "build", [night.def.id]));
    await f.wait(f.start("count words", { autoApprove: true }));
    expect(events(log, "agent.run.started").find((e) => e.station === "build")).toMatchObject({ agent: "night-builder" });
    expect(rt.calls.find((c) => c.systemPrompt?.startsWith("You build at night"))?.systemPrompt).toContain("Name files after what they hold.");
    expect(bay.slots().build).toEqual(["builder"]);

    bay.retire(night.def.id);
    expect(bay.crewFor("build", ["night-builder"])[0].id).toBe("builder");
    expect(bay.crewFor("council", ["visionary", "fixer", "planner", "judge", "critic", "tester", "builder"]).map((m) => m.id)).toHaveLength(6);
  });
});
