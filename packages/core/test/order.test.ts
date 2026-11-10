import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import {
  EventLog, captureSignal, OrderEngine, canonFor, classify, splitSentences, polarity, emphasized, heuristicArchivist, parseArchivistPlan,
  createCore, MockRuntime, type AgentRuntime, type AgentRequest,
} from "../src/index.js";

/** A clock the tests move by hand. */
function clock(start = "2026-11-10T09:00:00Z") {
  let t = Date.parse(start);
  return { now: () => new Date(t), days: (d: number) => { t += d * 86_400_000; } };
}

function setup(opts: ConstructorParameters<typeof OrderEngine>[2] = {}, runtime: AgentRuntime | null = null) {
  const log = new EventLog();
  const c = clock();
  const order = new OrderEngine(log, runtime, { mode: "heuristic", now: c.now, ...opts });
  const say = (text: string, source = "bridge") => { const s = captureSignal(log, text, source); return order.ingest({ id: s.id, text: s.text, source }); };
  return { log, order, say, clock: c };
}

describe("order text helpers", () => {
  it("cuts a rambling message into sentence fragments", () => {
    expect(splitSentences("Lets plan first. Then decide on stack.\n- one\n- two")).toEqual(["Lets plan first.", "Then decide on stack.", "one", "two"]);
    expect(splitSentences("Important,\nwe must keep order")).toEqual(["Important, we must keep order"]);
  });

  it("classifies fragments with rules of thumb", () => {
    expect(classify("thanks!")).toBe("noise");
    expect(classify("Where is the code on this laptop?")).toBe("question");
    expect(classify("Approval stations must be minimal.")).toBe("rule");
    expect(classify("We decided on Tauri for the shell.")).toBe("decision");
    expect(classify("Create a folder under C:/Dev")).toBe("task");
    expect(classify("Maybe make it a creational game")).toBe("idea");
    expect(classify("The star map looks nice in the dark")).toBe("note");
  });

  it("reads polarity and emphasis", () => {
    expect(polarity("Never push to main")).toBe(-1);
    expect(polarity("Agents may push to main")).toBe(1);
    expect(emphasized("IMPORTANT: keep it small")).toBe(true);
    expect(emphasized("keep it small")).toBe(false);
  });
});

describe("Order Engine: on every Signal", () => {
  it("opens a project, files fragments under it, hides noise and keeps the raw Signal", async () => {
    const { log, order, say } = setup();
    const r = await say("Project: SoftwareFactory\nApproval stations must be minimal. lol\nMaybe make it a sci-fi creational game.");
    const st = order.state();
    expect(st.nodes.map((n) => [n.kind, n.title])).toEqual([["project", "SoftwareFactory"]]);
    const byKind = Object.fromEntries(r.fragments.map((f) => [f.kind, f]));
    expect(byKind.rule.nodeId).toBe(st.nodes[0].id);
    expect(byKind.idea.nodeId).toBe(st.nodes[0].id);
    expect(byKind.noise.nodeId).toBeNull();
    expect(byKind.rule.important).toBe(true);
    // Raw Signal untouched; every fragment links back to it.
    expect(log.list({ type: "signal.captured" })[0].payload).toMatchObject({ text: expect.stringContaining("lol") });
    expect(r.fragments.every((f) => f.signalId === r.signalId)).toBe(true);
  });

  it("puts rules into the node's Canon with a link to where they were said, and inherits from parents", async () => {
    const { order, say } = setup();
    await say("Project: SoftwareFactory");
    const p = order.state().nodes[0].id;
    const idea = order.createNode("idea", "Order Engine", p);
    const a = await say("Human approval stations must be as few as possible.");
    order.moveFragment(a.fragments[0].id, p);
    const b = await say("The Order Engine must never delete raw signals.");
    order.moveFragment(b.fragments[0].id, idea);
    const st = order.state();
    const canon = canonFor(st, idea);
    expect(canon.map((c) => c.fragment.text)).toEqual(["The Order Engine must never delete raw signals.", "Human approval stations must be as few as possible."]);
    expect(canon[1].inheritedFrom).toBe(p);
    expect(st.signals[canon[0].fragment.signalId].text).toBe("The Order Engine must never delete raw signals.");
    expect(canonFor(st, p).map((c) => c.fragment.id)).toEqual([a.fragments[0].id]);
  });

  it("sends an unsure placement to the Unsorted tray with a suggestion, and a drag files it", async () => {
    const { order, say } = setup();
    await say("Project: SoftwareFactory");
    await say("Project: RoadToMill");
    const r = await say("Where do the old receipts go?");
    const f = r.fragments[0];
    expect(f.nodeId).toBeNull();
    order.moveFragment(f.id, order.state().nodes[1].id);
    expect(order.state().fragments.find((x) => x.id === f.id)).toMatchObject({ nodeId: order.state().nodes[1].id, confidence: 1 });
  });

  it("does not file a wordless drop note under whichever project was active last", async () => {
    const { order, say } = setup();
    await say("Project: SoftwareFactory");
    await say("Project: RoadToMill");
    const st = order.state();
    // Nothing in this note names either project: it waits in Unsorted, with the guess offered first.
    const r = await say("Maybe add a dark mode.", "drop");
    expect(r.fragments[0].nodeId).toBeNull();
    expect(st.nodes.map((n) => n.id)).toContain(r.fragments[0].suggestedNodeId);
    // With a single project there is no doubt, and it is filed straight away.
    const one = setup();
    await one.say("Project: SoftwareFactory");
    expect((await one.say("Maybe add a dark mode.", "drop")).fragments[0].nodeId).toBe(one.order.state().nodes[0].id);
  });

  it("marks a placement as a guess when another project fits nearly as well, and offers it as a one-tap refile", async () => {
    const { order, say } = setup();
    await say("Project: Photo renamer\nThe photo renamer reads dates from photos.");
    await say("Project: Photo backup\nThe photo backup copies photos nightly.");
    const [renamer, backup] = order.state().nodes.filter((n) => n.kind === "project");
    const r = await say("Photos need a progress bar.", "drop");
    const f = r.fragments[0];
    expect(f.nodeId).not.toBeNull();
    expect(f.confidence).toBeLessThan(0.7);
    expect(f.alternatives).toEqual([f.nodeId === renamer.id ? backup.id : renamer.id]);
    order.moveFragment(f.id, f.alternatives![0]);
    const moved = order.state().fragments.find((x) => x.id === f.id)!;
    expect(moved).toMatchObject({ nodeId: f.alternatives![0], confidence: 1 });
    expect(moved.alternatives).toBeUndefined();
  });

  it("routes by vocabulary to the right idea", async () => {
    const { order, say } = setup();
    await say("Project: SoftwareFactory");
    const p = order.state().nodes[0].id;
    order.createNode("idea", "Star map visuals", p);
    order.createNode("idea", "Agent budget caps", p);
    const r = await say("The star map should glow brighter for important visuals.");
    expect(order.state().nodes.find((n) => n.id === r.fragments[0].nodeId)?.title).toBe("Star map visuals");
  });

  it("catches a planted conflict and resolves it by precedence: newer explicit words replace older", async () => {
    const { order, say } = setup();
    await say("Project: SoftwareFactory");
    const old = await say("Agents may push to the main branch.");
    const neu = await say("Never push to the main branch.");
    const st = order.state();
    expect(st.conflicts).toHaveLength(1);
    expect(st.conflicts[0]).toMatchObject({ status: "resolved", rule: "newer-over-older", effect: "supersede", winner: neu.fragments[0].id, loser: old.fragments[0].id, by: "engine" });
    expect(st.fragments.find((f) => f.id === old.fragments[0].id)).toMatchObject({ state: "superseded", supersededBy: neu.fragments[0].id });
    expect(canonFor(st, st.nodes[0].id).map((c) => c.fragment.text)).toEqual(["Never push to the main branch."]);
  });

  it("asks before an unmarked newer line overrides a rule you marked important, and one tap answers", async () => {
    const { order, say } = setup();
    await say("Project: SoftwareFactory");
    const old = await say("IMPORTANT: every run must have a hard money cap.");
    const neu = await say("Runs do not need a money cap for small jobs.");
    let c = order.state().conflicts[0];
    expect(c).toMatchObject({ status: "open", proposal: { winner: neu.fragments[0].id } });
    order.resolveConflict(c.id, old.fragments[0].id);
    const st = order.state();
    c = st.conflicts[0];
    expect(c).toMatchObject({ status: "resolved", winner: old.fragments[0].id, by: "you" });
    expect(st.fragments.find((f) => f.id === neu.fragments[0].id)?.state).toBe("superseded");
    // Changing your mind brings the other one back.
    order.resolveConflict(c.id, neu.fragments[0].id);
    const st2 = order.state();
    expect(st2.fragments.find((f) => f.id === neu.fragments[0].id)?.state).toBe("live");
    expect(st2.fragments.find((f) => f.id === old.fragments[0].id)?.state).toBe("superseded");
  });

  it("asks before replacing a marked rule on a project itself, but replaces it on an idea", async () => {
    const { order, say } = setup();
    await say("Project: SoftwareFactory");
    const p = order.state().nodes[0].id;
    await say("Human approval stations must be as few as possible.");
    await say("Change of plan: every station needs a human approval, it must not run without one.");
    expect(order.state().conflicts[0]).toMatchObject({ status: "open" });
    const idea = order.createNode("idea", "Photo log", p);
    await say("The photo log must never upload photos.");
    await say("The photo log must upload photos to the cloud.");
    const c = order.state().conflicts.find((x) => x.a !== order.state().conflicts[0].a);
    expect(c).toMatchObject({ status: "resolved", rule: "newer-over-older" });
    expect(canonFor(order.state(), idea).map((x) => x.fragment.text)).toContain("The photo log must upload photos to the cloud.");
  });

  it("lets a more specific node's rule win there only", async () => {
    const { order, say } = setup();
    await say("Project: SoftwareFactory");
    const p = order.state().nodes[0].id;
    const idea = order.createNode("idea", "Prototype spike", p);
    const general = await say("Agents must use the Haiku model.");
    const specific = await say("In the prototype spike, agents must not use the Haiku model.");
    expect(specific.fragments[0].nodeId).toBe(idea);
    const st = order.state();
    const c = st.conflicts.find((x) => x.status === "resolved" && x.rule === "specific-over-general");
    expect(c).toBeTruthy();
    expect(canonFor(st, idea).map((x) => x.fragment.id)).toEqual([specific.fragments[0].id]);
    expect(canonFor(st, p).map((x) => x.fragment.id)).toEqual([general.fragments[0].id]);
  });

  it("lets your words beat a rule an agent inferred", async () => {
    const { order, say } = setup();
    await say("Project: SoftwareFactory");
    const mine = await say("Builders must run on Sonnet.");
    await say("Builders must not run on Sonnet.", "agent:reviewer");
    const c = order.state().conflicts[0];
    expect(c).toMatchObject({ status: "resolved", rule: "explicit-over-inferred", winner: mine.fragments[0].id });
  });

  it("passes visualizeEverything for every Signal", async () => {
    const { order, say } = setup();
    await say("Project: SoftwareFactory\nEverything must be visualized.");
    await say("hmm ok");
    const v = order.state().visuals.filter((x) => x.scope === "ingest");
    expect(v).toHaveLength(2);
    expect(v.every((x) => x.pass)).toBe(true);
    expect(v[0].items.join("\n")).toMatch(/body on the star map[\s\S]*particles[\s\S]*constellation/);
    expect(v[1].items.join("\n")).toMatch(/noise/);
  });
});

describe("Order Engine: the agent Archivist", () => {
  const agentSays = (text: string, cost = 0.002): AgentRuntime => ({ name: "fake", async run() { return { text, costUsd: cost, durationMs: 1, models: ["haiku"], runtime: "fake", contextTokens: 0 }; } });

  it("files with the agent's proposal: new nodes, fragments and semantic clashes", async () => {
    const log = new EventLog();
    const order0 = new OrderEngine(log, null, { mode: "heuristic" });
    const s0 = captureSignal(log, "Project: SoftwareFactory\nThe stack is Tauri with a TypeScript core.");
    await order0.ingest({ id: s0.id, text: s0.text });
    const st0 = order0.state();
    const p = st0.nodes[0].id;
    const rule = st0.fragments.find((f) => f.kind === "decision")!.id;
    const reply = "```json\n" + JSON.stringify({
      nodes: [{ ref: "new1", kind: "idea", title: "Game engine core", parent: p }],
      fragments: [{ text: "Use Godot for everything", kind: "decision", important: false, node: "new1", confidence: 0.8, contradicts: [rule] }, { text: "cool", kind: "noise", node: null, confidence: 0.9 }],
    }) + "\n```";
    const order = new OrderEngine(log, agentSays(reply), { mode: "agent" });
    const s = captureSignal(log, "Use Godot for everything, cool");
    const r = await order.ingest({ id: s.id, text: s.text });
    expect(r.mode).toBe("agent");
    expect(r.costUsd).toBe(0.002);
    const st = order.state();
    expect(st.nodes.map((n) => n.title)).toEqual(["SoftwareFactory", "Game engine core"]);
    expect(st.conflicts[0]).toMatchObject({ detectedBy: "archivist", rule: "specific-over-general", effect: "scoped" });
    expect(log.list({ type: "agent.run.completed" })).toHaveLength(1);
  });

  it("falls back to heuristics when the answer is unusable, and says so", async () => {
    const { order, say } = setup({ mode: "agent" }, agentSays("sorry, no json"));
    const r = await say("Project: X\nKeep it simple.");
    expect(r.mode).toBe("heuristic");
    expect(r.note).toMatch(/could not be used/);
    expect(order.state().nodes).toHaveLength(1);
  });

  it("stops calling the agent once the daily cap is spent", async () => {
    const { say } = setup({ mode: "agent", maxUsd: 0.05, perCallUsd: 0.03 }, agentSays("```json\n{\"fragments\":[{\"text\":\"a note\",\"kind\":\"note\",\"node\":null,\"confidence\":0.2}]}\n```", 0.03));
    expect((await say("first")).mode).toBe("agent");
    const second = await say("second");
    expect(second.mode).toBe("heuristic");
    expect(second.note).toMatch(/budget/);
  });

  it("drops node ids and clash ids that do not exist", () => {
    const log = new EventLog();
    const st = new OrderEngine(log, null).state();
    const plan = parseArchivistPlan("```json\n{\"fragments\":[{\"text\":\"builders must use sonnet\",\"kind\":\"bogus\",\"node\":999,\"contradicts\":[5]}]}\n```", st);
    expect(plan.fragments[0]).toMatchObject({ kind: "rule", node: null, contradicts: [] });
  });

  it("gives the agent a small prompt: the tree and the nearest Canon only", () => {
    const { order } = setup();
    expect(heuristicArchivist("hello", order.state()).fragments[0].kind).toBe("noise");
  });
});

describe("Order Engine: sweep and briefing", () => {
  it("fades stale notes (undoable), raises old questions once, and never touches rules or pinned items", async () => {
    const { order, say, clock } = setup();
    await say("Project: SoftwareFactory");
    const note = await say("The factory floor could use a darker grid in the softwarefactory view.");
    const pinned = await say("Softwarefactory idea: maybe a drop folder for ideas.");
    order.pin(pinned.fragments[0].id);
    await say("Agents must stay inside their worktree.");
    await say("What happens to softwarefactory ideas when I am away?");
    clock.days(15);
    const { actions, briefing } = order.sweep();
    const st = order.state();
    const fades = st.sweeps.filter((s) => s.action === "fade");
    expect(fades.map((s) => s.fragmentId)).toEqual([note.fragments[0].id]);
    expect(st.sweeps.filter((s) => s.action === "raise")).toHaveLength(1);
    expect(st.fragments.find((f) => f.kind === "rule")?.state).toBe("live");
    expect(briefing.lines.map((l) => l.kind)).toEqual(expect.arrayContaining(["question", "faded"]));
    expect(actions.length).toBe(2);
    order.undoSweep(fades[0].id);
    expect(order.state().fragments.find((f) => f.id === note.fragments[0].id)?.state).toBe("live");
    order.sweep();
    expect(order.state().sweeps.filter((s) => s.action === "raise")).toHaveLength(1);
  });

  it("proposes merging two ideas started twice, merges on accept, and undoes", async () => {
    const { order } = setup();
    const p = order.createNode("project", "SoftwareFactory");
    const a = order.createNode("idea", "Drop folder for ideas", p);
    const b = order.createNode("idea", "Ideas drop folder", p);
    const { briefing } = order.sweep();
    const prop = order.state().sweeps.find((s) => s.action === "merge-proposal")!;
    expect(prop).toMatchObject({ nodeId: b, intoNodeId: a });
    expect(briefing.lines.some((l) => l.kind === "merge")).toBe(true);
    const m = order.acceptMerge(prop.id);
    expect(order.state().nodes.find((n) => n.id === b)?.mergedInto).toBe(a);
    order.undoSweep(m);
    expect(order.state().nodes.find((n) => n.id === b)?.mergedInto).toBeUndefined();
  });

  it("digests a busy node in plain code", async () => {
    const { order, say } = setup({ digestAt: 3 });
    await say("Project: SoftwareFactory");
    await say("Softwarefactory must keep a hard cap.\nSoftwarefactory idea: maybe add a drop folder.\nSoftwarefactory note on the bridge.");
    order.sweep();
    const d = order.state().sweeps.find((s) => s.action === "digest")!;
    expect(d.summary).toMatch(/3 live fragments[\s\S]*hard cap/);
  });

  it("says when all is in order", () => {
    const { order } = setup();
    expect(order.briefing().lines).toEqual([{ kind: "calm", text: "All in order. Nothing needs you." }]);
  });
});

describe("Order Engine: core API", () => {
  it("files every captured Signal and serves the state with each node's Canon", async () => {
    const log = new EventLog();
    const handler = createCore({ log, runtime: new MockRuntime() });
    const server = createServer(handler);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
    try {
      await post("/api/signals", { text: "Project: SoftwareFactory\nEverything must be visualized." });
      await handler.order.idle();
      const st = await fetch(`http://127.0.0.1:${port}/api/order/state`).then((r) => r.json());
      expect(st.mode).toBe("heuristic");
      expect(st.nodes[0].title).toBe("SoftwareFactory");
      const rule = st.fragments.find((f: any) => f.kind === "rule");
      expect(st.canon[st.nodes[0].id]).toEqual([{ id: rule.id, inheritedFrom: null, rank: expect.any(Number) }]);
      const sw = await post("/api/order/sweep", {});
      expect(sw.briefing.lines.length).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });
});
