import type { FactoryRunView, StationState } from "../../api";

/**
 * A run as a mission: ten stops on one track, in the order the engine works. Some stops fold
 * several engine stations together (Build = Tester + Builder; Test and fix = test, fix, review),
 * so the track reads as the story of the run, not as the engine's wiring.
 */
export type StopId = "idea" | "council" | "design" | "plan" | "ok1" | "build" | "check" | "judge" | "ok2" | "ship";
export type StopState = "done" | "live" | "gate" | "fail" | "skip" | "todo";
export type Bead = "done" | "live" | "fail" | "todo";
export interface Stop {
  id: StopId;
  label: string;
  sub: string;
  state: StopState;
  gate?: boolean;
  /** One bead per loop round, drawn on a ring around the stop. */
  beads?: Bead[];
  /** A short extra line under the label (scores, counts). */
  note?: string;
}

const PARTS: Record<StopId, string[]> = {
  idea: ["intake"], council: ["council"], design: ["discover"], plan: ["plan"], ok1: ["gateA"],
  build: ["tests", "build"], check: ["test", "fix", "review"], judge: ["evaluate"], ok2: ["gateB"], ship: ["ship"],
};
export const ORDER: StopId[] = ["idea", "council", "design", "plan", "ok1", "build", "check", "judge", "ok2", "ship"];

const rank: Record<StopState, number> = { live: 5, gate: 4, fail: 3, done: 2, skip: 1, todo: 0 };
function one(s?: StationState): StopState {
  switch (s) {
    case "active": return "live";
    case "waiting": return "gate";
    case "fail": case "incomplete": return "fail";
    case "pass": return "done";
    case "skipped": return "skip";
    default: return "todo";
  }
}

const CRIT = ["coverage", "journey", "screens", "originality", "buildable"];
/** Discovery rounds without the closing "settled" copy of the last round. */
export function designRounds(run: FactoryRunView) { return run.discovery.filter((d) => !d.settled); }
export function scoreLine(scores: Record<string, number>) { return CRIT.filter((k) => k in scores).map((k) => scores[k]).join("·"); }

export function stopsFor(run?: FactoryRunView): Stop[] {
  const st = run?.stations ?? {};
  const started = (id: StopId) => PARTS[id].some((p) => st[p] && st[p].state !== "idle");
  const raw = ORDER.map((id) => {
    const parts = PARTS[id].map((p) => one(st[p]?.state));
    let state = parts.reduce<StopState>((a, b) => (rank[b] > rank[a] ? b : a), "todo");
    // A loop stop is done once anything after it has started; its own red rounds were part of the loop.
    const later = ORDER.slice(ORDER.indexOf(id) + 1).some(started);
    if (later && state !== "skip" && state !== "todo") state = "done";
    if (later && state === "todo") state = "skip";
    if (id === "build" && parts.includes("done") && parts.includes("todo") && !later) state = "live";
    return { id, state };
  });
  // A run that ended without shipping: the stop it ended on turns red.
  if (run?.finished && run.finished.outcome !== "shipped") {
    const live = raw.filter((s) => s.state === "live" || s.state === "gate");
    const last = live.at(-1) ?? [...raw].reverse().find((s) => s.state !== "todo" && s.state !== "skip");
    if (last) { for (const s of live) s.state = "done"; last.state = "fail"; }
  }
  if (run?.finished?.outcome === "shipped") raw.forEach((s) => { if (s.state === "todo") s.state = "skip"; });
  if (run && !Object.keys(st).length && !run.finished) raw[0].state = "live";
  const by = Object.fromEntries(raw.map((r) => [r.id, r.state])) as Record<StopId, StopState>;
  const R = run;
  const rounds = R ? designRounds(R) : [];
  const best = rounds.at(-1);
  const lastTest = R?.tests.at(-1);
  const lastEval = R?.evaluations.filter((e) => !e.skipped).at(-1);
  const built = R?.features.filter((f) => f.state === "built").length ?? 0;
  // The build announces each feature as it starts; the total comes with it.
  const featTotal = Math.max(R?.features.length ?? 0, ...(R?.features.map((f) => f.of ?? 0) ?? [0]));
  const attempts = R?.loop.filter((l) => l.kind === "attempt") ?? [];
  const council = R?.council.at(-1);
  const gateSub = (id: StopId) => by[id] === "gate" ? "waits for you" : by[id] === "done" ? "approved" : by[id] === "fail" ? "sent back" : "you approve";

  const stops: Stop[] = [
    { id: "idea", label: "Idea", sub: "one line", state: by.idea },
    {
      id: "council", label: "Council", state: by.council,
      sub: by.council === "skip" ? "skipped" : council ? `${R!.council.length} round${R!.council.length > 1 ? "s" : ""} · ${council.brief.outcome}` : "six seats",
      beads: R?.council.map(() => "done" as Bead).concat(by.council === "live" ? ["live"] : []),
    },
    {
      id: "design", label: "Design loop", state: by.design,
      sub: by.design === "skip" ? (R?.stations.discover?.state === "skipped" ? "kept its design" : "skipped") : "Designer ⇄ Critic",
      note: best?.critique ? `${best.pass ? "passed" : "best"} ${scoreLine(best.critique.scores)}` : undefined,
      beads: rounds.map((r) => (r.pass ? "done" : "fail") as Bead).concat(by.design === "live" ? ["live"] : []),
    },
    {
      id: "plan", label: "Plan", state: by.plan,
      sub: R?.plan ? `${R.plan.tasks.length} tasks · ${R.plan.acceptance.length} checks` : by.plan === "live" ? "writing…" : "Planner",
    },
    { id: "ok1", label: "Your OK", sub: gateSub("ok1"), state: by.ok1, gate: true },
    {
      id: "build", label: "Build", state: by.build,
      sub: featTotal ? `${built}/${featTotal} features` : by.build === "live" ? "Builder at work" : "feature by feature",
      beads: featTotal ? R!.features.map((f) => (f.state === "built" ? "done" : f.state === "building" ? "live" : f.state === "regressed" || f.state === "broken" ? "fail" : "todo") as Bead)
        .concat(Array<Bead>(Math.max(0, featTotal - R!.features.length)).fill("todo")) : undefined,
    },
    {
      id: "check", label: "Test and fix", state: by.check,
      sub: lastTest ? `${lastTest.passed}/${lastTest.passed + lastTest.failed} tests pass` : "locked tests",
      note: attempts.length ? `${attempts.length} fix round${attempts.length > 1 ? "s" : ""}` : undefined,
      beads: attempts.length ? attempts.map((a) => (a.after === 0 ? "done" : a.after < a.before ? "live" : "fail") as Bead) : undefined,
    },
    {
      id: "judge", label: "Judge", state: by.judge,
      sub: lastEval ? `${lastEval.requirements.filter((q) => q.met).length}/${lastEval.requirements.length} seen working` : by.judge === "skip" ? "not judged" : "uses the running app",
      beads: R?.evaluations.filter((e) => !e.skipped).map((e) => (e.pass ? "done" : "fail") as Bead),
    },
    { id: "ok2", label: "Your OK", sub: gateSub("ok2"), state: by.ok2, gate: true },
    { id: "ship", label: "Ship", sub: R?.finished?.outcome === "shipped" ? "shipped" : "tagged release", state: R?.finished?.outcome === "shipped" ? "done" : by.ship },
  ];
  for (const s of stops) if (s.beads && !s.beads.length) delete s.beads;
  return stops;
}

/** The stop the run is at now (or ended on); the first stop for a run that has not started. */
export function currentStop(stops: Stop[]): Stop {
  return stops.find((s) => s.state === "gate") ?? stops.find((s) => s.state === "live") ?? stops.find((s) => s.state === "fail")
    ?? [...stops].reverse().find((s) => s.state === "done") ?? stops[0];
}

/** One sentence: what is happening now, in plain words. */
export function headline(run: FactoryRunView | undefined, stops: Stop[]): { text: string; who?: string; tone: "live" | "gate" | "fail" | "done" | "idle" } {
  if (!run) return { text: "Type an idea to start the first build. It travels this track from left to right.", tone: "idle" };
  if (run.waiting) {
    if (run.waiting.gate === "gateA") return { text: "The plan is ready. It waits for your OK.", tone: "gate" };
    if (run.waiting.gate === "gateB") return { text: "Built and judged. It waits for your OK.", tone: "gate" };
    return { text: run.waiting.question, tone: "gate" };
  }
  if (run.finished) {
    if (run.finished.outcome === "shipped") return { text: "Shipped. The app is ready to use.", tone: "done" };
    return { text: run.finished.reason || `The run ${run.finished.outcome}.`, tone: "fail" };
  }
  const st = run.stations;
  const active = Object.entries(st).filter(([, v]) => v.state === "active").map(([k, v]) => ({ k, round: v.round }));
  const a = active.at(-1);
  const building = run.features.find((f) => f.state === "building");
  switch (a?.k) {
    case "intake": return { text: "Reading your idea.", tone: "live" };
    case "council": return { who: "The Council", text: "is reading your idea before anything is designed.", tone: "live" };
    case "discover": return { who: "The Designer and the Critic", text: `are shaping the product, round ${a.round ?? designRounds(run).length + 1}.`, tone: "live" };
    case "plan": return { who: "The Planner", text: "is turning the design into a build plan.", tone: "live" };
    case "tests": return { who: "The Tester", text: "is writing the tests that will be locked.", tone: "live" };
    case "build": return building
      ? { who: "The Builder", text: `is building ${building.id}: ${building.title} (${building.index ?? run.features.indexOf(building) + 1} of ${building.of ?? run.features.length}).`, tone: "live" }
      : { who: "The Builder", text: "is writing the app.", tone: "live" };
    case "test": return { text: "Running the locked tests.", tone: "live" };
    case "fix": return { who: "The Fixer", text: `is on fix round ${a.round ?? run.fixRounds}.`, tone: "live" };
    case "review": return { who: "The Reviewer", text: "is checking the build against the plan.", tone: "live" };
    case "evaluate": return { who: "The Product Judge", text: "is using the running app, screen by screen.", tone: "live" };
    case "ship": return { text: "Shipping: commit, tag and list it under Finished apps.", tone: "live" };
  }
  const cur = currentStop(stops);
  return { text: `At ${cur.label}.`, tone: "idle" };
}
