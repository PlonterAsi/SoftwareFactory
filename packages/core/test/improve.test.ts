import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import {
  EventLog, MockRuntime, OrderEngine, AgentBay, ImproveCouncil, captureSignal, createCore, listSignals, mergeLenses, parseLensAnswer, score, memoryText,
  type AgentRuntime, type AgentRequest, type LensProposal, type Target,
} from "../src/index.js";

const json = (o: unknown) => "```json\n" + JSON.stringify(o) + "\n```";

async function setup(opts: { runtime?: AgentRuntime; maxUsd?: number; autoGate?: () => string | null } = {}) {
  const log = new EventLog();
  const rt = opts.runtime ?? new MockRuntime();
  const bay = new AgentBay(log, rt);
  const order = new OrderEngine(log, null, { mode: "heuristic" });
  const say = async (text: string, source = "bridge") => { const s = captureSignal(log, text, source); await order.ingest({ id: s.id, text: s.text, source }); };
  const council = new ImproveCouncil(log, rt, bay, () => order.state(), { maxUsd: opts.maxUsd, autoGate: opts.autoGate });
  return { log, rt, bay, order, say, council };
}

describe("lens answers", () => {
  it("reads at most two proposals, fills defaults and accepts an empty list", () => {
    const ps = parseLensAnswer(json({ proposals: [
      { title: "Add a dry run", why: "safer", change: "a --dry-run flag", impact: "high", effort: "small" },
      { title: "No change given" },
      { title: "Cache results", change: "keep the last answer", impact: "huge", effort: "?" },
      { title: "Third", change: "too many" },
    ] }));
    expect(ps.map((p) => [p.title, p.impact, p.effort])).toEqual([["Add a dry run", "high", "small"], ["Cache results", "medium", "medium"]]);
    expect(parseLensAnswer(json({ proposals: [] }))).toEqual([]);
    expect(() => parseLensAnswer("I think it is fine")).toThrow(/no proposals/);
  });

  it("merges what two lenses said alike, ranks it first, and drops what was already said", () => {
    const p = (title: string, change: string, impact: LensProposal["impact"] = "medium"): LensProposal => ({ title, why: "", change, impact, effort: "small" });
    const target: Target = { kind: "project", id: 7, title: "Photos" };
    const { drafts, suppressed } = mergeLenses([
      { lens: "Automator", agent: "automator", proposals: [p("Run the renamer every night", "schedule the photo renamer nightly")] },
      { lens: "Flow Lens", agent: "flow-lens", proposals: [p("Run the renamer every night on a schedule", "schedule the photo renamer nightly with a log", "high"), p("Ask once up front", "collect choices first")] },
      { lens: "Simplifier", agent: "simplifier", proposals: [p("Remove the verbose flag", "drop --verbose")] },
      { lens: "UX Lens", agent: "ux-lens", proposals: [p("Show a colourful summary banner", "print a banner at the end")] },
    ], [
      { id: 1, title: "Remove the verbose flag", change: "drop --verbose", status: "parked", target },
      { id: 2, title: "Show a colourful summary banner", change: "print a banner at the end", status: "rejected", target: { kind: "run", id: 3, title: "Other" } },
    ], target);
    expect(drafts.map((d) => [d.title, d.lenses])).toEqual([
      ["Run the renamer every night on a schedule", ["Automator", "Flow Lens"]],
      ["Ask once up front", ["Flow Lens"]],
    ]);
    expect(drafts[0].score).toBe(score({ impact: "high", effort: "small", lenses: ["a", "b"] }));
    expect(suppressed.map((s) => s.because)).toEqual(["alike #1 (parked)", "alike #2 (rejected)"]);
    const mem = memoryText([{ id: 1, title: "Remove the verbose flag", change: "", status: "parked", target }], target);
    expect(mem).toContain("- [parked] Remove the verbose flag");
  });
});

describe("Improvement Council", () => {
  it("picks a changed subject, runs every lens and queues ranked proposals in organized tables", async () => {
    const { log, say, council, rt } = await setup();
    await say("Project: Photo renamer. It renames photos by the date they were taken. Must never overwrite a file.");
    const c = council.pick();
    expect(c).toMatchObject({ target: { kind: "project", title: "Photo renamer" }, due: true, why: "never reviewed" });
    const s = await council.run();
    expect(s).toMatchObject({ state: "done", trigger: "manual", target: { kind: "project", title: "Photo renamer" } });
    expect(s.seats.map((x) => [x.agent, x.state])).toEqual(["integrator", "automator", "simplifier", "enricher", "ux-lens", "flow-lens"].map((a) => [a, "done"]));
    // Every lens read the subject, its rule, and the memory line.
    const call = (rt as MockRuntime).calls.find((x) => /Improvement Council/.test(x.systemPrompt ?? ""))!;
    expect(call.prompt).toContain('Subject: project "Photo renamer"');
    expect(call.prompt).toContain("Must never overwrite a file");
    expect(call.prompt).toContain("Already proposed for this subject: nothing yet.");
    expect(call.model).toBe("haiku");
    expect(call.budgetUsd).toBeLessThanOrEqual(0.03);
    // Six lenses, at most five proposals per session, best first.
    const ps = council.proposals();
    expect(ps).toHaveLength(5);
    expect(ps[0].score).toBeGreaterThanOrEqual(ps[4].score);
    expect(s.suppressed).toHaveLength(1);
    const q = (sql: string) => log.db.prepare(sql).all() as any[];
    expect(q("SELECT status, proposals, suppressed FROM improve_sessions")).toEqual([{ status: "done", proposals: 5, suppressed: 1 }]);
    expect(q("SELECT count(*) AS n FROM improve_proposals WHERE status = 'inbox'")[0].n).toBe(5);
    expect(q("SELECT count(*) AS n FROM agent_runs WHERE station = 'improve'")[0].n).toBe(6);
    expect(log.list({ type: "improve.visual" }).at(-1)?.payload).toMatchObject({ pass: true });
    // Reviewed and unchanged: nothing is due, so an automatic tick does nothing.
    expect(council.candidates().find((x) => x.target.kind === "project")?.why).toBe("reviewed, unchanged since");
  });

  it("never repeats itself: a second look at the same subject says only new things", async () => {
    const { say, council } = await setup();
    await say("Project: Photo renamer. It renames photos by date.");
    const target = council.pick()!.target;
    await council.run({ target });
    const first = council.proposals().map((p) => p.title);
    const again = await council.run({ target });
    const titles = council.proposals().map((p) => p.title);
    expect(new Set(titles).size).toBe(titles.length);
    // The one that did not fit last time is the only new one.
    expect(titles.length - first.length).toBe(1);
    expect(again.proposals).toHaveLength(1);
  });

  it("accepting files the work: a task Signal without the ticket system, the ticket when it answers", async () => {
    const { log, say, council } = await setup();
    await say("Project: Photo renamer. It renames photos by date.");
    await council.run();
    const [a, b, c] = council.proposals();
    const acc = council.decide(a.id, "accepted");
    expect(acc.status).toBe("accepted");
    const sig = listSignals(log).at(-1)!;
    expect([sig.source, sig.id]).toEqual(["improve", acc.signalId]);
    expect(sig.text).toContain(a.title);
    expect(log.list({ type: "improve.proposal.accepted" }).at(-1)?.payload).toMatchObject({ id: a.id, title: a.title, target: { kind: "project" }, lenses: a.lenses });
    // A ticket system that links in the same tick replaces the Signal.
    log.on("event", (e) => { if (e.type === "improve.proposal.accepted") log.append("improve.proposal.linked", { id: (e.payload as { id: number }).id, ticketId: 42 }); });
    const before = listSignals(log).length;
    expect(council.decide(b.id, "accepted").ticketId).toBe(42);
    expect(listSignals(log)).toHaveLength(before);
    council.decide(c.id, "rejected", "not now");
    const rows = log.db.prepare("SELECT id, status, ticket_id, signal_id, note FROM improve_proposals WHERE status != 'inbox' ORDER BY id").all() as any[];
    expect(rows.map((r) => [r.status, r.ticket_id, r.signal_id != null, r.note])).toEqual([["accepted", null, true, null], ["accepted", 42, false, null], ["rejected", null, false, "not now"]]);
    // The council's own Signal does not count as a change to the project.
    expect(council.candidates().find((x) => x.target.kind === "project")?.due).toBe(false);
    expect(council.buildIdea(a.id)).toContain("(for Photo renamer)");
  });

  it("keeps to its daily cap and stops on its own when the inbox is full or the crew is practice", async () => {
    let gate: string | null = null;
    const priced: AgentRuntime = { name: "priced", run: async (req: AgentRequest) => ({ ...(await new MockRuntime().run(req)), costUsd: 0.02 }) };
    const { say, council } = await setup({ runtime: priced, maxUsd: 0.065, autoGate: () => gate });
    await say("Project: Garden app. It must work offline.");
    const s = await council.run();
    // Each seat reserves its $0.03 cap against $0.065 a day: two seats answer, the rest are skipped and say why.
    expect(s.seats.filter((x) => x.state === "done")).toHaveLength(2);
    expect(s.seats.find((x) => x.state === "failed")?.error).toMatch(/budget is spent/);
    expect(council.spentTodayUsd()).toBeCloseTo(0.04);
    expect(() => council.run()).toThrow(/budget of \$0\.0\d is spent/);
    expect(council.autoBlocked()).toMatch(/is spent/);
    council.opts.maxUsd = 10;
    council.opts.maxInbox = 2;
    expect(council.autoBlocked()).toMatch(/2 proposals wait for you/);
    gate = "practice crew";
    expect(council.autoBlocked()).toBe("practice crew");
    council.auto = false;
    expect(council.autoBlocked()).toBe("automatic sessions are off");
    expect(await council.tick()).toBeNull();
  });

  it("runs on its own when due: the tick picks the subject and spaces sessions out", async () => {
    const { say, council } = await setup();
    await say("Project: Garden app. It must work offline.");
    const s = await council.tick();
    expect(s?.trigger).toBe("auto");
    expect(council.autoBlocked(Date.now() + 7 * 3_600_000)).toBe("nothing changed since the last reviews");
    await say("Project: Recipe scaler. Scale a recipe to any number of people.");
    expect(council.autoBlocked()).toMatch(/next look after/);
    expect(council.autoBlocked(Date.now() + 7 * 3_600_000)).toBeNull();
    expect(council.pick()?.target.title).toBe("Recipe scaler");
    // Unchanged subjects get a fresh look after two weeks.
    expect(council.candidates(Date.now() + 15 * 86_400_000).find((c) => c.target.title === "Garden app")?.why).toBe("not looked at for 14 days");
  });

  it("files suggestions published by other parts of the factory, once, with their source", async () => {
    const { log, council } = await setup();
    council.listen();
    const sug = { projectId: 5, projectTitle: "Imported repo", suggestionId: "s1", title: "Add tests for the parser", body: "src/parse.js has no tests", lens: "Code health", severity: "high", files: ["src/parse.js"] };
    const e = log.append("repo.suggestion" as any, sug);
    log.append("repo.suggestion" as any, { ...sug, suggestionId: "s2" });
    const ps = council.proposals();
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ title: "Add tests for the parser", impact: "high", effort: "medium", lenses: ["Code health"], target: { kind: "project", id: 5 }, source: { kind: "repo.suggestion", eventId: e.id, suggestionId: "s1" }, files: ["src/parse.js"] });
    council.decide(ps[0].id, "accepted");
    expect(log.list({ type: "improve.proposal.accepted" }).at(-1)?.payload).toMatchObject({ source: { kind: "repo.suggestion", suggestionId: "s1" } });
  });

  it("looks at shipped apps and at the factory itself", async () => {
    const { log, council } = await setup();
    const { Factory } = await import("../src/index.js");
    const f = new Factory(log, new MockRuntime({ plantBug: false }), (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "sf-imp-")));
    await f.wait(f.start("count words in a file", { autoApprove: true }));
    const kinds = council.candidates().map((c) => [c.target.kind, c.due]);
    // The shipped run is its own project (projects model), so it is looked at as a project with the run inside.
    expect(kinds).not.toContainEqual(["run", true]);
    expect(kinds).toContainEqual(["factory", true]);
    expect(kinds).toContainEqual(["project", true]);
    const run = council.candidates().find((c) => c.target.kind === "project")!.target;
    expect(council.context(run)).toContain("Acceptance criteria:");
    expect(council.context({ kind: "factory", id: null, title: "SoftwareFactory itself" })).toMatch(/Runs: 1, shipped 1/);
  });
});

describe("Improvement Council API", () => {
  it("runs a session, decides, and changes its caps over HTTP", async () => {
    const log = new EventLog();
    const core = createCore({ log, runtime: new MockRuntime({ delayMs: 150 }), order: { mode: "heuristic" } });
    const server = createServer(core).listen(0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const post = async (path: string, body: unknown) => { const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return [r.status, await r.json()] as const; };
    try {
      const [none] = await post("/api/improve/run", {});
      expect(none).toBe(409);
      captureSignal(log, "Project: Habit tracker. Track daily habits.", "bridge");
      await new Promise((r) => setTimeout(r, 50));
      const [s1, started] = await post("/api/improve/run", {});
      expect([s1, started.session.state]).toEqual([202, "running"]);
      const [busy] = await post("/api/improve/run", {});
      expect(busy).toBe(409);
      while (core.improve.state().busy) await new Promise((r) => setTimeout(r, 10));
      const st = await (await fetch(`${base}/api/improve/state`)).json();
      expect(st.proposals.length).toBeGreaterThan(0);
      expect(st.auto.blocked).toMatch(/practice crew/);
      const id = st.proposals[0].id;
      const [s2, parked] = await post(`/api/improve/proposals/${id}/decide`, { decision: "parked" });
      expect([s2, parked.status]).toEqual([200, "parked"]);
      const [s3] = await post(`/api/improve/proposals/${id}/decide`, { decision: "maybe" });
      expect(s3).toBe(400);
      const [s4, set] = await post("/api/improve/settings", { auto: false, maxUsd: 0.5, everyHours: 12 });
      expect([s4, set.auto.on, set.budget.maxUsd, set.auto.everyHours]).toEqual([200, false, 0.5, 12]);
      const [bad] = await post("/api/improve/settings", { maxUsd: 50 });
      expect(bad).toBe(400);
      // The caps you set are kept in the settings table for the next start.
      const again = createCore({ log, runtime: new MockRuntime(), order: { mode: "heuristic" } });
      expect([again.improve.auto, again.improve.opts.maxUsd, again.improve.opts.everyHours]).toEqual([false, 0.5, 12]);
    } finally { server.close(); }
  });
});
