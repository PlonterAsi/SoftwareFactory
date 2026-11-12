import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_AGENTS,
  AgentBay, EventLog, Factory, MockRuntime, heuristicDraft, isSmallJob, lineDiff, majority, parseAgentFile, parseReview, serializeAgent, synthesize,
  type AgentRequest, type AgentRuntime, type SeatResult,
} from "../src/index.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const events = (log: EventLog, type: string) => log.list({ limit: 1e6 }).filter((e) => e.type === type).map((e) => e.payload as any);

/** The mock crew, with some answers replaced. */
function scripted(over: (req: AgentRequest, n: number) => string | undefined): MockRuntime {
  const rt = new MockRuntime({ plantBug: false });
  const base = rt.run.bind(rt);
  let n = 0;
  rt.run = async (req) => { const r = await base(req); const t = over(req, ++n); if (t !== undefined) r.text = t; return r; };
  return rt;
}
const take = (vote: string, extra: object = {}) => "```json\n" + JSON.stringify({ take: `I vote ${vote}.`, proposals: [], concerns: [], vote, scope: "small", ...extra }) + "\n```";

describe("agent files", () => {
  it("round-trips an agent through its file", () => {
    const bay = new AgentBay(new EventLog());
    const def = bay.get("planner")!.def;
    expect(parseAgentFile(serializeAgent(def))).toEqual(def);
    const odd = { ...def, id: "odd", name: "Odd: one", description: "has: a colon, and \"quotes\"", plugins: ["a b", "c"] };
    expect(parseAgentFile(serializeAgent(odd))).toEqual(odd);
  });

  it("imports a Claude Code subagent file as it is", () => {
    const md = `---\nname: api-designer\ndescription: Use this agent when designing new APIs.\ntools: Read, Write, Edit, Bash\nmodel: inherit\n---\n\nYou are a senior API designer.\n`;
    const a = parseAgentFile(md);
    expect(a).toMatchObject({ id: "api-designer", name: "Api Designer", tools: ["Read", "Write", "Edit", "Bash"], model: "haiku", station: "none", prompt: "You are a senior API designer." });
    expect(() => parseAgentFile("no header")).toThrow(/header/);
    expect(() => parseAgentFile("---\nname: x\n---\n")).toThrow(/prompt/);
  });

  it("diffs two prompts by line", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc").map((l) => l.op + l.text)).toEqual(["samea", "delb", "addB", "samec"]);
  });
});

describe("Agent Bay", () => {
  it("seeds the built-in crew once and puts each on its station", () => {
    const log = new EventLog();
    const bay = new AgentBay(log);
    new AgentBay(log);
    expect(bay.agents().map((a) => a.def.id)).toEqual(["overseer", "archivist", "visionary", "architect", "skeptic", "planner", "tester", "builder", "reviewer", "fixer",
      "integrator", "automator", "simplifier", "enricher", "ux-lens", "flow-lens", "cartographer", "surveyor", "researcher"]);
    expect(bay.slots().council).toEqual(["visionary", "architect", "skeptic"]);
    const [planner] = bay.crewFor("plan");
    expect(planner).toMatchObject({ id: "planner", version: 1, model: "haiku" });
    expect(planner.role).toContain("You are the Planner");
    expect(planner.role).toContain("Station contract: plan.");
  });

  it("versions every edit and rolls back without losing history", () => {
    const bay = new AgentBay(new EventLog());
    const v2 = bay.save("planner", { model: "sonnet", prompt: "You are the Planner. Be brief." });
    expect(v2.version).toBe(2);
    expect(v2.versions.at(-1)!.note).toBe("changed model, prompt");
    expect(bay.save("planner", { model: "sonnet" }).version).toBe(2); // no change, no new version
    expect(() => bay.save("planner", { model: "opus" }, { expectVersion: 1 })).toThrow(/changed since/);
    const v3 = bay.rollback("planner", 1);
    expect(v3).toMatchObject({ version: 3, def: { model: "haiku" } });
    expect(v3.versions.map((v) => v.note)).toEqual(["built-in crew", "changed model, prompt", "rolled back to v1"]);
    expect(bay.file("planner", 2)).toContain("model: sonnet");
  });

  it("clones with a fresh id, retires custom agents and refuses bad assignments", () => {
    const bay = new AgentBay(new EventLog());
    const c1 = bay.clone("builder");
    const c2 = bay.clone("builder");
    expect([c1.def.id, c2.def.id]).toEqual(["builder-copy", "builder-copy-2"]);
    expect(c1.versions[0].note).toBe("cloned from Builder v1");
    bay.assign("build", [c1.def.id]);
    expect(bay.crewFor("build")[0].id).toBe("builder-copy");
    bay.retire(c1.def.id);
    expect(bay.slots().build).toEqual(["builder"]); // never left without a worker
    expect(() => bay.retire("builder")).toThrow(/Built-in/);
    expect(() => bay.assign("build", ["builder", "planner"])).toThrow(/at most 1/);
    expect(() => bay.assign("council", ["planner", "tester", "builder", "fixer", "reviewer", "visionary", "architect"])).toThrow(/at most 6/);
    expect(() => bay.assign("plan", ["nobody"])).toThrow(/No active agent/);
    expect(() => bay.assign("plan", [c1.def.id])).toThrow(/No active agent/);
    expect(bay.state().visuals.every((v) => v.pass)).toBe(true);
  });

  it("drafts an agent from one line without a model on the mock", async () => {
    expect(heuristicDraft("a careful reviewer called Hawk that checks for security holes")).toMatchObject({ name: "Hawk", station: "review", model: "sonnet", avatar: "◎" });
    expect(heuristicDraft("cheap agent that writes tests")).toMatchObject({ station: "tests", model: "haiku" });
    const bay = new AgentBay(new EventLog(), new MockRuntime());
    const a = await bay.draft("a critic that pokes holes in ideas");
    expect(a).toMatchObject({ version: 1, def: { station: "council" } });
    // The Overseer's draft names the agent; its id follows the name, not an id the draft picked.
    const rt = scripted((req) => (req.systemPrompt?.includes("Station contract: draft") ? "```json\n" + JSON.stringify({ id: "council-seat", name: "Game Designer", station: "council", prompt: "You are the Game Designer." }) + "\n```" : undefined));
    Object.defineProperty(rt, "name", { value: "scripted" });
    const g = await new AgentBay(new EventLog(), rt).draft("A Council seat called Game Designer: asks what makes it fun");
    expect(g.def).toMatchObject({ id: "game-designer", name: "Game Designer" });
  });

  it("test-runs agents on their sample task with their station's verifier", async () => {
    const log = new EventLog();
    const bay = new AgentBay(log, new MockRuntime({ plantBug: false }));
    for (const id of ["planner", "tester", "builder", "reviewer", "visionary", "archivist", "overseer"]) {
      const t = await bay.test(id);
      expect([id, t.pass]).toEqual([id, true]);
    }
    // A planner whose answers break the contract fails its test.
    const bad = new AgentBay(log, scripted((req) => (req.systemPrompt?.includes("Station contract: plan") ? "I would rather chat." : undefined)));
    const t = await bad.test("planner");
    expect(t.pass).toBe(false);
    expect(t.checks!.find((c) => !c.pass)!.label).toContain("spec");
    expect(bay.stats().planner.calls).toBe(2);
  });

  it("is where the factory gets its crew: assignments and edits apply to the next run", async () => {
    const log = new EventLog();
    const rt = new MockRuntime();
    const bay = new AgentBay(log, rt);
    const fast = bay.clone("builder", "Fast Builder");
    bay.save(fast.def.id, { model: "haiku", prompt: "You build fast and small." });
    bay.assign("build", [fast.def.id]);
    const f = new Factory(log, rt, tmp("sf-proj-"), bay);
    await f.wait(f.start("count words", { autoApprove: true }));
    const build = events(log, "agent.run.started").find((e) => e.station === "build");
    expect(build).toMatchObject({ agent: "fast-builder", agentVersion: 2, model: "haiku" });
    expect(rt.calls.find((c) => c.systemPrompt?.startsWith("You build fast"))?.systemPrompt).toContain("Station contract: build.");
    expect(events(log, "factory.run.finished")[0].outcome).toBe("shipped");

    const s = bay.stats();
    expect(s["fast-builder"]).toMatchObject({ calls: 1, verdicts: { pass: 0, total: 1 }, passRate: 0, runs: 1, state: "idle" });
    expect(s.fixer).toMatchObject({ calls: 1, verdicts: { pass: 1, total: 1 }, passRate: 1, avgRounds: 1, state: "idle" });
    expect(s["fast-builder"].byVersion[2]).toMatchObject({ calls: 1, total: 1 });
    expect(s.planner.costUsd).toBeCloseTo(0.0001);
  });
});

describe("Council", () => {
  it("skips small jobs and sits for bigger ones", () => {
    expect(isSmallJob("a CLI that renames photos by the date they were taken").small).toBe(true);
    expect(isSmallJob("a habit tracker with streaks, reminders and a weekly report, and export to CSV").small).toBe(false);
    expect(majority(["build", "build", "drop"])).toBe("build");
    expect(majority(["build", "reshape", "drop"])).toBe(null);
  });

  it("merges three takes into one brief: what two seats agree on, proposals and concerns", () => {
    const seat = (agent: string, t: object): SeatResult => ({ agent, name: agent, version: 1, round: 1, costUsd: 0, take: { take: "x", proposals: [], concerns: [], vote: "build", scope: "small", ...t } as any });
    const b = synthesize([
      seat("a", { proposals: ["read input from stdin", "colour output"] }),
      seat("b", { proposals: ["read the input from stdin"], concerns: ["huge files"], vote: "reshape" }),
      seat("c", { concerns: ["empty input"], vote: "build" }),
    ], 1);
    expect(b).toMatchObject({ outcome: "build", agreed: ["read input from stdin"], proposals: ["colour output"], concerns: ["huge files", "empty input"] });
  });

  it("sits three seats in parallel and hands the Planner its brief", async () => {
    const log = new EventLog();
    const rt = new MockRuntime({ plantBug: false });
    const f = new Factory(log, rt, tmp("sf-proj-"), new AgentBay(log, rt));
    await f.wait(f.start("count words", { autoApprove: true, council: "always" }));
    const [c] = events(log, "factory.council");
    expect(c.seats.map((s: SeatResult) => [s.agent, s.take?.vote])).toEqual([["visionary", "build"], ["architect", "build"], ["skeptic", "build"]]);
    expect(c.brief.agreed).toEqual(expect.arrayContaining(["pieces with a word goal", "unicode whitespace"]));
    expect(rt.calls.find((r) => r.systemPrompt?.includes("Station contract: plan"))!.prompt).toContain("Council brief");
    const v = events(log, "factory.visual").find((x) => x.station === "council");
    expect(v.pass).toBe(true);
    expect(events(log, "agent.run.started").filter((e) => e.station === "council").map((e) => e.seat)).toEqual([0, 1, 2]);
    expect(events(log, "factory.run.finished")[0].outcome).toBe("shipped");
  });

  it("deliberates a second round when no majority wants to build", async () => {
    const log = new EventLog();
    const rt = scripted((req) => {
      if (!req.systemPrompt?.includes("Station contract: council")) return undefined;
      const r2 = req.prompt.includes("Round 2");
      if (req.systemPrompt.includes("Visionary")) return take("build");
      if (req.systemPrompt.includes("Architect")) return take(r2 ? "build" : "reshape", { proposals: ["split parsing from output"] });
      return take("drop", { concerns: ["unclear input format"] });
    });
    const f = new Factory(log, rt, tmp("sf-proj-"), new AgentBay(log, rt));
    await f.wait(f.start("count words", { autoApprove: true, council: "always" }));
    const rounds = events(log, "factory.council");
    expect(rounds.map((r) => r.round)).toEqual([1, 2]);
    expect(rounds[1].brief).toMatchObject({ outcome: "build", rounds: 2 });
    expect(rt.calls.find((c) => c.prompt.includes("Round 2") && c.systemPrompt?.includes("Architect"))!.prompt).toContain("Skeptic (voted drop)");
    expect(events(log, "factory.run.finished")[0].outcome).toBe("shipped");
  });

  it("asks before building what the Council advises against", async () => {
    const log = new EventLog();
    const rt = scripted((req) => (req.systemPrompt?.includes("Station contract: council") ? take("drop", { concerns: ["it would delete user files"] }) : undefined));
    const f = new Factory(log, rt, tmp("sf-proj-"), new AgentBay(log, rt));
    const run = f.start("count words", { council: "always" });
    for (let i = 0; i < 200 && f.waitingGate(run) !== "escalation"; i++) await new Promise((r) => setTimeout(r, 10));
    expect(events(log, "factory.gate").at(-1).question).toContain("advises against");
    expect(events(log, "factory.gate").at(-1).question).toContain("delete user files");
    f.decide(run, "escalation", { approve: false });
    await f.wait(run);
    expect(events(log, "factory.run.finished")[0]).toMatchObject({ outcome: "stopped" });
    expect(events(log, "factory.council")).toHaveLength(2);
  });
});

describe("Tester fixtures", () => {
  it("writes fixture files under test/ with the tests, and locks them too", async () => {
    const log = new EventLog();
    const rt = new MockRuntime({ plantBug: false });
    const base = rt.run.bind(rt);
    rt.run = async (req) => { const r = await base(req); if (req.systemPrompt?.includes("Station contract: tests")) r.text += "\n<<<FILE test/fixtures/words.txt\na b c\nFILE>>>\n<<<FILE src/sneaky.js\nx\nFILE>>>"; return r; };
    const f = new Factory(log, rt, tmp("sf-proj-"));
    await f.wait(f.start("count words", { autoApprove: true }));
    const files = events(log, "factory.files").find((x) => x.station === "tests");
    expect(files.written.map((w: any) => w.path).sort()).toEqual(["test/count.test.js", "test/fixtures/words.txt"]);
    expect(files.refused).toEqual([{ path: "src/sneaky.js", reason: "the Tester may only write under test/" }]);
    expect(events(log, "factory.tests.locked")[0].files).toContain("test/fixtures/words.txt");
    expect(events(log, "factory.run.finished")[0].outcome).toBe("shipped");
  });
});

describe("Review station", () => {
  it("reads a review and sends high findings to the Fixer once", async () => {
    expect(parseReview('```json\n{"verdict":"fix","findings":[{"severity":"low","text":"x"}]}\n```').verdict).toBe("pass");
    const log = new EventLog();
    let reviews = 0;
    const rt: AgentRuntime = scripted((req) => {
      if (!req.systemPrompt?.includes("Station contract: review")) return undefined;
      return ++reviews === 1 ? '```json\n{"verdict":"fix","findings":[{"severity":"high","text":"bin/wc.js ignores stdin"}]}\n```' : '```json\n{"verdict":"pass","findings":[]}\n```';
    });
    const f = new Factory(log, rt, tmp("sf-proj-"));
    await f.wait(f.start("count words", { autoApprove: true }));
    expect(events(log, "factory.review").map((r) => r.verdict)).toEqual(["fix", "pass"]);
    const fixCall = (rt as MockRuntime).calls.find((c) => c.systemPrompt?.includes("Station contract: fix"))!;
    expect(fixCall.prompt).toContain("bin/wc.js ignores stdin");
    expect(events(log, "factory.run.finished")[0]).toMatchObject({ outcome: "shipped", fixRounds: 1 });
    expect(events(log, "factory.visual").every((v) => v.pass)).toBe(true);
  });
});

describe("Agent Bay API", () => {
  it("creates, edits, tests, assigns and exports agents over HTTP", async () => {
    const { createServer } = await import("node:http");
    const { createCore } = await import("../src/index.js");
    const log = new EventLog();
    const server = createServer(createCore({ log, runtime: new MockRuntime({ plantBug: false }) }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const post = async (path: string, body: unknown) => { const r = await fetch(base + path, { method: "POST", body: JSON.stringify(body) }); return [r.status, await r.json()] as const; };
    try {
      const [s1, drafted] = await post("/api/bay/draft", { description: "a strict tester called Pinch that writes edge-case tests" });
      expect([s1, drafted.def.name, drafted.def.station]).toEqual([201, "Pinch", "tests"]);
      const [s2, saved] = await post(`/api/bay/agents/pinch/save`, { def: { budgetUsd: 0.1 }, expectVersion: 1 });
      expect([s2, saved.version]).toEqual([200, 2]);
      const [, stale] = await post(`/api/bay/agents/pinch/save`, { def: { budgetUsd: 0.2 }, expectVersion: 1 });
      expect(stale.error).toMatch(/changed since/);
      const [, test] = await post(`/api/bay/agents/pinch/test`, { task: "Spec: src/add.js exports add(a, b)." });
      expect(test).toMatchObject({ agent: "pinch", version: 2, pass: true });
      const [, slots] = await post(`/api/bay/slots/tests`, { agents: ["pinch"] });
      expect(slots.tests).toEqual(["pinch"]);
      const file = await (await fetch(`${base}/api/bay/agents/pinch/file`)).text();
      expect(file).toMatch(/^---\nname: Pinch\n/);
      const [s3, imported] = await post("/api/bay/import", { text: file.replace("name: Pinch", "name: Pinch Two") });
      expect([s3, imported.def.id]).toEqual([201, "pinch-2"]);
      const st = await (await fetch(`${base}/api/bay/state`)).json();
      expect(st.agents).toHaveLength(BUILTIN_AGENTS.length + 2);
      expect(st.stats.pinch.calls).toBe(1);
      // The Overseer answers with its Bay prompt.
      const [, ans] = await post("/api/agent/run", { prompt: "hi" });
      expect(ans.agent).toBe("overseer");
    } finally { server.close(); }
  });
});

describe("Bay and Council tables", () => {
  it("keeps agents, versions, slots, verdicts and Council sessions in organized tables", async () => {
    const log = new EventLog();
    const rt = new MockRuntime({ plantBug: false });
    const bay = new AgentBay(log, rt);
    bay.save("planner", { model: "sonnet" });
    bay.assign("council", ["skeptic", "visionary", "architect"]);
    await bay.test("tester");
    const f = new Factory(log, rt, tmp("sf-proj-"), bay);
    await f.wait(f.start("count words", { autoApprove: true, council: "always" }));
    const q = (sql: string) => log.db.prepare(sql).all() as any[];
    expect(q("SELECT id, version, model FROM bay_agents WHERE id = 'planner'")).toEqual([{ id: "planner", version: 2, model: "sonnet" }]);
    expect(q("SELECT count(*) AS n FROM bay_agent_versions")[0].n).toBe(BUILTIN_AGENTS.length + 1);
    expect(q("SELECT agent FROM bay_slots WHERE slot = 'council' ORDER BY seat").map((r) => r.agent)).toEqual(["skeptic", "visionary", "architect"]);
    expect(q("SELECT status FROM bay_tests")).toEqual([{ status: "pass" }]);
    expect(q("SELECT outcome, round FROM council_sessions")).toEqual([{ outcome: "build", round: 1 }]);
    expect(q("SELECT agent, vote FROM council_seats ORDER BY seat").map((r) => r.agent)).toEqual(["skeptic", "visionary", "architect"]);
    expect(q("SELECT verdict FROM reviews")).toEqual([{ verdict: "pass" }]);
    expect(q("SELECT agent, version, pass FROM agent_verdicts WHERE agent = 'planner'")).toEqual([{ agent: "planner", version: 2, pass: 1 }]);
  });
});
