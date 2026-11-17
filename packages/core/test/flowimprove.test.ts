import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentBay, EventLog, Factory, FlowImprover, FlowLibrary, MockRuntime, NEW_PROJECT_FLOW, SMALL_CHANGE_FLOW, applyOps, diffFlows, findStep, flowProblems,
  opsFromWords, proposalsFrom, replay, traceRuns, type AgentRequest, type RunTrace,
} from "../src/index.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const events = (log: EventLog, type: string) => log.list({ limit: 1e6 }).filter((e) => e.type === type).map((e) => e.payload as any);

function scripted(over: (req: AgentRequest, n: number) => string | undefined): MockRuntime {
  const rt = new MockRuntime({ plantBug: false });
  const base = rt.run.bind(rt);
  let n = 0;
  rt.run = async (req) => { const r = await base(req); const t = over(req, ++n); if (t !== undefined) r.text = t; r.costUsd = 0.01; return r; };
  return rt;
}
const fix = "```json\n" + JSON.stringify({ verdict: "fix", findings: [{ severity: "high", text: "The list screen has no empty state." }] }) + "\n```";

/** Past runs of New project: the council always sits; the review sends the build back on the runs named. */
async function history(n: number, reviewFinds: number[] = []) {
  const log = new EventLog();
  let run = 0, reviewed = new Set<number>();
  const rt = scripted((req) => {
    if (!req.systemPrompt?.includes("Station contract: review.")) return undefined;
    if (!reviewFinds.includes(run) || reviewed.has(run)) return undefined;
    reviewed.add(run);
    return fix;
  });
  const bay = new AgentBay(log, rt);
  const f = new Factory(log, rt, tmp("sf-proj-"), bay);
  for (run = 1; run <= n; run++) await f.wait(f.start(`count words, version ${run}, with goals and a progress view`, { autoApprove: true, council: "always" }));
  return { log, f, bay, rt };
}

describe("changing a flow by operations", () => {
  it("reads plain words into operations", () => {
    const ops = opsFromWords(NEW_PROJECT_FLOW, "Skip the council, at most 3 rounds for the judge; use React Builder for build. Tell the crew: keep each change small.", [{ id: "react-builder", name: "React Builder" }]);
    expect(ops).toEqual([
      { op: "drop", step: "council" }, { op: "rounds", step: "judge", n: 3 }, { op: "crew", step: "build", agent: "react-builder" },
      { op: "brief", text: "keep each change small." },
    ]);
    expect(opsFromWords(NEW_PROJECT_FLOW, "make it nicer")).toEqual([]);
    expect(findStep(NEW_PROJECT_FLOW, "the product judge")?.id).toBe("evaluate");
  });

  it("leaves a step out with its edges joined around it, and brings it back as shipped", () => {
    const less = applyOps(NEW_PROJECT_FLOW, [{ op: "drop", step: "review" }]);
    expect(flowProblems(less)).toEqual([]);
    expect(less.steps.some((s) => s.id === "review")).toBe(false);
    expect(less.edges.some((e) => e.from === "review" || e.to === "review")).toBe(false);
    expect(diffFlows(NEW_PROJECT_FLOW, less)).toMatchObject([{ kind: "removed", step: "review" }]);
    const back = applyOps(less, [{ op: "restore", step: "review" }]);
    expect(back.steps.map((s) => s.id)).toEqual(NEW_PROJECT_FLOW.steps.map((s) => s.id));
    expect(diffFlows(NEW_PROJECT_FLOW, back)).toEqual([]);
    expect(() => applyOps(NEW_PROJECT_FLOW, [{ op: "drop", step: "plan" }])).toThrow(/cannot be left out/);
    expect(() => applyOps(NEW_PROJECT_FLOW, [{ op: "rounds", step: "judge", n: 9 }])).toThrow(/1 to 6/);
    expect(() => applyOps(NEW_PROJECT_FLOW, [{ op: "rounds", step: "build", n: 2 }])).not.toThrow();
    expect(() => applyOps(SMALL_CHANGE_FLOW, [{ op: "rounds", step: "orient", n: 2 }])).toThrow(/not a loop/);
  });
});

describe("replaying a changed flow on past runs", () => {
  it("prices what a left-out step cost, and says where it caught a problem", async () => {
    const { log } = await history(3, [2]);
    const traces = traceRuns(log, NEW_PROJECT_FLOW);
    expect(traces).toHaveLength(3);
    expect(traces[0].steps.council.ran).toBe(true);
    expect(traces[1].steps.review.found).toBe(1);

    const noCouncil = replay(log, NEW_PROJECT_FLOW, applyOps(NEW_PROJECT_FLOW, [{ op: "drop", step: "council" }]));
    expect(noCouncil.verdict).toBe("cheaper");
    expect(noCouncil.afterUsd).toBeLessThan(noCouncil.beforeUsd);
    expect(noCouncil.runs.every((r) => r.risk === "low")).toBe(true);

    const noReview = replay(log, NEW_PROJECT_FLOW, applyOps(NEW_PROJECT_FLOW, [{ op: "drop", step: "review" }]));
    expect(noReview.verdict).toBe("risky");
    expect(noReview.risky).toBe(1);
    expect(noReview.runs[1].notes.join(" ")).toMatch(/caught 1 problem/);
    expect(noReview.summary).toMatch(/would have let a problem through/);

    const brief = replay(log, NEW_PROJECT_FLOW, applyOps(NEW_PROJECT_FLOW, [{ op: "brief", text: "Keep it small." }]));
    expect(brief.unpriced.join(" ")).toMatch(/live trial/);
    expect(replay(new EventLog(), NEW_PROJECT_FLOW, applyOps(NEW_PROJECT_FLOW, [{ op: "drop", step: "council" }])).verdict).toBe("no-history");
  });

  it("SF proposes one more round where a loop keeps running out, and dropping a step that never caught anything", () => {
    const t = (rounds: number, passed: boolean, reviewUsd = 0.1): RunTrace => ({ run: 1, kind: "run", at: "", flowVersion: 1, outcome: "shipped", totalUsd: 1, steps: { evaluate: { costUsd: 0.2, rounds, passed, ran: true, found: passed ? 0 : 1 }, review: { costUsd: reviewUsd, rounds: 1, passed: true, ran: true, found: 0 } } });
    const p = proposalsFrom(NEW_PROJECT_FLOW, [t(2, false), t(2, false), t(1, true), t(2, false)]);
    expect(p).toHaveLength(2);
    expect(p.map((x) => x.ops)).toEqual(expect.arrayContaining([[{ op: "drop", step: "review" }], [{ op: "rounds", step: "evaluate", n: 3 }]]));
    expect(p.find((x) => x.ops[0].op === "rounds")!.why).toMatch(/3 of the last 4/);
    expect(proposalsFrom(NEW_PROJECT_FLOW, [t(2, false)])).toEqual([]);
  });
});

describe("proposals, one live trial, and your decision", () => {
  it("a change in words is replayed, tried once on the next run, and saved as the next version only when accepted", async () => {
    const { log, f, bay } = await history(2);
    const imp = new FlowImprover(log, f.flows, { runtime: new MockRuntime(), agents: () => bay.agents().map((a) => ({ id: a.def.id, name: a.def.name, station: a.def.station })) });
    f.flows.trial = (id, ticket) => imp.takeTrial(id, ticket);
    const p = await imp.fromWords("new-project", "skip the council");
    expect(p).toMatchObject({ by: "words", state: "proposed", baseVersion: 1, ops: [{ op: "drop", step: "council" }] });
    expect(p.replay.runs).toHaveLength(2);
    expect(f.flows.get("new-project")!.steps.some((s) => s.id === "council")).toBe(true);
    await expect(imp.fromWords("new-project", "make it nicer")).rejects.toThrow(/Nothing to change/);

    imp.arm(p.id);
    expect(() => imp.arm(p.id)).toThrow(/only a new proposal/);
    const run = f.start("a habit tracker with streaks and a weekly chart", { autoApprove: true, council: "always" });
    await f.wait(run);
    expect(events(log, "factory.run.started").at(-1).flow).toMatchObject({ trialOf: p.id });
    expect(events(log, "factory.station").filter((s) => s.run === run && s.station === "council" && s.state !== "skipped")).toEqual([]);
    // Handed out once: the next run follows the saved flow again.
    await f.wait(f.start("a reading list with ratings and a yearly goal", { autoApprove: true, council: "always" }));
    expect(events(log, "factory.run.started").at(-1).flow.trialOf).toBeUndefined();
    const tried = imp.list("new-project").find((x) => x.id === p.id)!;
    expect(tried).toMatchObject({ state: "tried", trial: { run, outcome: "shipped" } });
    // The trial is not a past run of the flow: replays read only runs that followed the saved flow.
    expect(traceRuns(log, f.flows.get("new-project")!).map((t) => t.run)).not.toContain(run);

    imp.accept(p.id);
    const saved = f.flows.get("new-project")!;
    expect(saved.version).toBe(2);
    expect(saved.steps.some((s) => s.id === "council")).toBe(false);
    expect(saved.trialOf).toBeUndefined();
    expect(() => imp.accept(p.id)).toThrow(/changed since|accepted/);
  });

  it("refuses a proposal whose flow changed since, and one that names an agent the Bay does not have", async () => {
    const log = new EventLog();
    const lib = new FlowLibrary(log);
    const imp = new FlowImprover(log, lib, { agents: () => [{ id: "builder", name: "Builder", station: "build" }] });
    const p = imp.propose("small-change", [{ op: "rounds", step: "checks", n: 3 }], "more fix rounds", "you");
    expect(() => imp.propose("small-change", [{ op: "crew", step: "build", agent: "ghost" }], "x", "you")).toThrow(/not an active agent/);
    lib.save(applyOps(lib.get("small-change")!, [{ op: "brief", text: "Small steps." }]));
    expect(() => imp.accept(p.id)).toThrow(/changed since/);
    expect(imp.reject(p.id, "stale").state).toBe("rejected");
    expect(imp.suggest("small-change")).toEqual([]);
    expect(() => imp.propose("import", [{ op: "drop", step: "x" }], "x", "you")).toThrow(/own screen/);
  });

  it("a one-session trial is handed to one ticket, once", () => {
    const log = new EventLog();
    const lib = new FlowLibrary(log);
    const imp = new FlowImprover(log, lib);
    const p = imp.propose("small-change", [{ op: "drop", step: "review" }], "try without the reviewer", "you");
    expect(imp.takeTrial("small-change", 7)).toBeNull();
    imp.arm(p.id);
    expect(imp.takeTrial("small-change", 7)).toMatchObject({ trialOf: p.id });
    expect(imp.takeTrial("small-change", 8)).toBeNull();
    expect(imp.get(p.id)).toMatchObject({ state: "taken", trial: { ticket: 7 } });
    expect(() => imp.reject(p.id)).toThrow(/being tried/);
    log.append("ticket.step", { id: 7, key: "SF-7", step: "commit", state: "passed", note: "" });
    expect(imp.list()[0]).toMatchObject({ state: "tried", trial: { ticket: 7, outcome: "shipped" } });
  });
});
