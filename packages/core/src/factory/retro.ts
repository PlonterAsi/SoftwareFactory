/**
 * The engine review: what a run says about the factory itself.
 *
 * Why (Assaf, 2026-11-13): a benchmark run is a test of SF's engine, not of the product it builds. Every run
 * must end with what went well and what went wrong in the engine: which stations, loops and agents did their
 * job, which did not, and where the money and time went. Until now a person read the log and wrote that by
 * hand after each run.
 *
 * The review is computed from the run's own events, with no agent call: it costs nothing and cannot flatter
 * itself. It is logged as `factory.retro` when the run ends and shown on the run's Engine tab.
 */
import type { SfEvent } from "../events.js";

export interface StageReview { station: string; calls: number; failedCalls: number; costUsd: number; seconds: number; rounds: number; state: string }
export interface AgentReview { agent: string; calls: number; failedCalls: number; costUsd: number; passes: number; fails: number; lastNote?: string }
export interface EngineReview {
  outcome: string;
  reason: string;
  spentUsd: number;
  maxUsd: number;
  minutes: number;
  stages: StageReview[];
  agents: AgentReview[];
  /** What the engine did well in this run, each line with its evidence. */
  good: string[];
  /** What the engine did badly, each line with its evidence: the work list for the next engine change. */
  bad: string[];
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `events` are the run's own events in order (factory events carry `run`, agent calls `factoryRun`). */
export function engineReview(events: SfEvent[], end: { outcome: string; reason: string; spentUsd: number; maxUsd: number }): EngineReview {
  const p = (e: SfEvent) => e.payload as Record<string, any>;
  const of = (type: string) => events.filter((e) => e.type === type).map(p);
  const good: string[] = [];
  const bad: string[] = [];

  // Where the money and time went, by station and by agent.
  const stages = new Map<string, StageReview>();
  const agents = new Map<string, AgentReview>();
  const stage = (s: string) => stages.get(s) ?? stages.set(s, { station: s, calls: 0, failedCalls: 0, costUsd: 0, seconds: 0, rounds: 0, state: "" }).get(s)!;
  const agent = (a: string) => agents.get(a) ?? agents.set(a, { agent: a, calls: 0, failedCalls: 0, costUsd: 0, passes: 0, fails: 0 }).get(a)!;
  for (const e of events) {
    const x = p(e);
    if (e.type === "agent.run.completed" || e.type === "agent.run.failed") {
      const failed = e.type === "agent.run.failed";
      for (const row of [stage(String(x.station ?? "other")), agent(String(x.agent))]) {
        row.calls++;
        if (failed) row.failedCalls++;
        row.costUsd += Number(x.costUsd ?? 0);
      }
      stage(String(x.station ?? "other")).seconds += Number(x.durationMs ?? 0) / 1000;
    } else if (e.type === "factory.station") {
      const s = stage(String(x.station));
      if (x.state === "active") s.rounds = Math.max(s.rounds, Number(x.round ?? 1));
      if (x.state !== "active") s.state = String(x.state);
    } else if (e.type === "agent.verdict") {
      const a = agent(String(x.agent));
      if (x.pass) a.passes++; else { a.fails++; if (x.note) a.lastNote = String(x.note); }
    }
  }
  const minutes = events.length ? (Date.parse(events.at(-1)!.ts) - Date.parse(events[0].ts)) / 60_000 : 0;

  // The design loop.
  const disc = of("factory.discovery");
  if (disc.length) {
    const rounds = Math.max(...disc.map((d) => Number(d.round ?? 1)));
    const settled = disc.find((d) => d.settled);
    const last = (settled ?? disc.at(-1))!;
    const scores = last.critique?.scores as Record<string, number> | undefined;
    const text = scores ? Object.entries(scores).map(([k, v]) => `${k} ${v}`).join(", ") : "no scores";
    if (disc.some((d) => d.pass)) good.push(`Design loop: the design passed the Critic in ${plural(rounds, "round")} (${text}).`);
    else bad.push(`Design loop: the design never passed the Critic (${settled?.settled ?? "no passing round"}; ${text}). ${last.critique?.problems?.[0]?.problem ? `Its first open problem: ${String(last.critique.problems[0].problem).slice(0, 200)}` : ""}`.trim());
    const screens = last.docs?.screens?.length ?? 0;
    const reqs = last.docs?.requirements?.length ?? 0;
    if (screens) good.push(`Design loop: it designed ${plural(screens, "screen")} and ${plural(reqs, "requirement")}.`);
  }
  for (const r of of("factory.research")) {
    if (r.sourced > 0) good.push(`Research: ${plural(r.sourced, "finding")} with a real page behind ${r.sourced === 1 ? "it" : "them"} reached the Designer.`);
    else bad.push(`Research: the Designer was allowed ${plural(r.searches, "search", "searches")} and came back with no sourced finding${r.error ? ` (${String(r.error).slice(0, 120)})` : ""}. The product was designed from memory.`);
  }

  // The review loop.
  for (const o of of("factory.review.open")) bad.push(`Review loop: still "fix" after ${o.round} reviews, ${plural((o.failing ?? []).length, "criterion", "criteria")} failing when run${(o.failing ?? []).length ? ` (${String(o.failing[0]).slice(0, 120)})` : ""}; the run went on to the judge with them open.`);

  // The plan.
  const gaps = of("factory.plan.gaps");
  const leftOut = gaps.filter((g) => !g.addedByCore).flatMap((g) => g.missing ?? []);
  const added = gaps.filter((g) => g.addedByCore).flatMap((g) => g.missing ?? []);
  if (leftOut.length) bad.push(`Plan: the Planner's first plan left out ${plural(leftOut.length, "thing")} the design asked for (${leftOut.slice(0, 3).join("; ")}); ${gaps.some((g) => !g.addedByCore && g.added === false) ? "its second try failed, so they reached the approval missing" : "the gaps check caught them and a second Planner call added them"}.`);
  if (added.length) bad.push(`Plan: the Planner dropped ${plural(added.length, "designed screen")} and the core had to add ${added.length === 1 ? "it" : "them"} (${added.join(", ")}).`);
  if (of("factory.plan").length && !gaps.length) good.push("Plan: the plan covered the design on its first try.");

  // The build loop.
  const feats = of("factory.feature").filter((f) => f.state !== "building");
  if (feats.length) {
    const ids = [...new Set(feats.map((f) => String(f.id)))];
    const first = ids.filter((id) => { const mine = feats.filter((f) => f.id === id); return mine.length === 1 && mine[0].state === "built"; });
    const notBuilt = ids.filter((id) => feats.filter((f) => f.id === id).at(-1)!.state !== "built");
    (first.length === ids.length ? good : bad).push(`Build loop: ${first.length} of ${plural(ids.length, "feature")} built on the first try, each in its own session.`);
    for (const f of feats.filter((x) => x.state === "broken")) bad.push(`Build loop: ${f.id} (${f.title}) reported done while ${f.invalid?.length ? `the app could not start: ${String(f.invalid[0]).slice(0, 160)}` : f.stored?.length ? `it kept data in the browser's storage instead of the app's store (${f.stored.slice(0, 3).join(", ")})` : f.deadLinks?.length ? `it held ${plural(f.deadLinks.length, "made-up link")}: ${String(f.deadLinks[0]).slice(0, 120)}` : f.hollow?.length ? `the product judge did not find on its screen ${plural(f.hollow.length, "designed item")}, first: ${String(f.hollow[0]).slice(0, 140)}` : `a screen did not draw: ${String(f.crashed?.[0] ?? "").slice(0, 160)}`}`);
    for (const f of feats.filter((x) => x.state === "regressed")) bad.push(`Build loop: ${f.id} (${f.title}) broke ${plural((f.broke ?? []).length, "test")} that passed before it.`);
    if (notBuilt.length) bad.push(`Build loop: ${notBuilt.join(", ")} did not end built.`);
  }
  const continued = of("factory.continued");
  if (continued.length) bad.push(`Build loop: ${plural(continued.length, "call")} ran out of ${continued.length === 1 ? "its" : "their"} own budget mid-work and had to be continued.`);

  // The checks: a check that catches something is the engine working; what it caught is the builder's miss.
  const allLooks = of("factory.screen.look");
  const looks = allLooks.filter((l) => !l.skipped && (l.attempt ?? 1) === 1);
  if (looks.length) {
    const short = looks.filter((l) => (l.missing ?? []).length);
    good.push(`Checks: the product judge looked at ${plural(looks.length, "screen")} just after ${looks.length === 1 ? "it was" : "they were"} built${short.length ? ` and sent ${short.length} back with what was missing` : " and found every designed item"}.`);
    const again = allLooks.filter((l) => !l.skipped && l.attempt === 2);
    const still = again.filter((l) => (l.missing ?? []).length);
    if (again.length) (still.length ? bad : good).push(`Builder: ${still.length ? `${still.length} of ${plural(again.length, "screen")} sent back still missed designed items on the second look (${still.map((l) => `${l.screen}: ${l.seen} of ${l.of}`).join(", ")})` : `every screen sent back had what was missing on the second look (${plural(again.length, "screen")})`}.`);
  }
  const blanked = of("factory.links.blanked").flatMap((b) => b.links ?? []);
  if (blanked.length) bad.push(`Builder: left ${plural(blanked.length, "made-up link")} after being told twice; the core emptied ${blanked.length === 1 ? "it" : "them"} (${String(blanked[0]).slice(0, 120)}).`);
  const unmatched = allLooks.filter((l) => l.skipped);
  if (unmatched.length) bad.push(`Planner: ${plural(unmatched.length, "view")} matched no designed screen, so the judge could not look at ${unmatched.length === 1 ? "it" : "them"} while building (${unmatched.map((l) => l.screen).join(", ")}).`);
  const firstScreens = of("factory.screens")[0];
  if (firstScreens && !firstScreens.skipped) {
    const crashed = (firstScreens.screens ?? []).filter((s: any) => !s.ok);
    if (crashed.length) { good.push(`Checks: the browser check caught ${plural(crashed.length, "screen")} that did not draw after the build.`); bad.push(`Builder: ${plural(crashed.length, "screen")} did not draw although the tests passed (${crashed.slice(0, 2).map((s: any) => `#/${s.route}`).join(", ")}).`); }
    else good.push(`Checks: all ${plural((firstScreens.screens ?? []).length, "screen")} drew in a real browser on the first check.`);
  } else if (firstScreens?.skipped) bad.push(`Checks: the browser check was skipped (${firstScreens.skipped}).`);
  const firstLinks = of("factory.links")[0];
  if (firstLinks && !firstLinks.skipped) {
    const dead = (firstLinks.dead ?? []).length;
    if (dead) { good.push(`Checks: the link check caught ${plural(dead, "link")} that ${dead === 1 ? "does" : "do"} not exist.`); bad.push(`Builder: wrote ${plural(dead, "made-up link")} into the app.`); }
  }

  // The fix loop.
  const attempts = of("factory.attempt");
  const idle = attempts.filter((a) => !(a.files ?? []).length);
  const useful = attempts.filter((a) => Number(a.after) < Number(a.before));
  if (useful.length) good.push(`Fix loop: ${plural(useful.length, "round")} of ${attempts.length} lowered the number of failing checks.`);
  if (idle.length) bad.push(`Fix loop: ${plural(idle.length, "round")} changed nothing (round ${idle.map((a) => a.round).join(", ")}).`);
  const climbs = of("factory.ladder").filter((l) => l.from !== l.to);
  if (climbs.length) bad.push(`Fix loop: the ladder climbed ${plural(climbs.length, "time")} (${climbs.map((l) => `${l.from} to ${l.to}`).join(", ")}): ${String(climbs[0].reason ?? "").slice(0, 160)}`);
  const disputed = of("factory.tests.disputed");
  if (disputed.length) bad.push(`Tests: ${plural(disputed.length, "locked test")} had to be questioned after locking.`);

  // The judge.
  const evals = of("factory.evaluation").filter((e) => !e.skipped);
  if (evals.length) {
    const last = evals.at(-1)!;
    const open = (last.requirements ?? []).filter((r: any) => !r.met).length;
    const total = (last.requirements ?? []).length;
    const scores = Object.entries(last.scores ?? {}).map(([k, v]) => `${k} ${v}`).join(", ");
    (last.pass ? good : bad).push(`Product judge: ${last.pass ? "passed" : "did not pass"} the product after ${plural(evals.length, "look")} (${scores}; ${total - open} of ${total} requirements seen working).`);
    if (evals.length > 1) {
      const before = (evals[0].requirements ?? []).filter((r: any) => r.met).length;
      (total - open > before ? good : bad).push(`Judge loop: requirements seen working went from ${before} to ${total - open} between the judge's looks.`);
    }
  } else if (of("factory.evaluation").length) bad.push(`Product judge: the product was not judged (${String(of("factory.evaluation")[0].skipped).slice(0, 160)}).`);
  const repairs = of("factory.repair");
  if (repairs.length) good.push(`Judge loop: the judge's findings went back to the build loop as ${plural(repairs.reduce((a, r) => a + (r.features ?? []).length, 0), "feature")}.`);
  for (const s of of("factory.repair.stopped")) bad.push(`Repair: stopped before the build gate (${String(s.reason).slice(0, 160)}${s.skipped?.length ? `; not built: ${s.skipped.join(", ")}` : ""}).`);

  // Agent calls and the run as a whole.
  const retried = of("agent.run.retried").length;
  if (retried) bad.push(`Runtime: ${plural(retried, "agent call")} failed the sign-in check at start and had to be retried.`);
  const failedCalls = [...agents.values()].filter((a) => a.failedCalls);
  if (failedCalls.length) bad.push(`Agents: failed calls: ${failedCalls.map((a) => `${a.agent} ${a.failedCalls} of ${a.calls}`).join(", ")}.`);
  const left = end.maxUsd - end.spentUsd;
  if (end.outcome === "shipped") good.push(`The run shipped for ${usd(end.spentUsd)} of ${usd(end.maxUsd)} in ${Math.round(minutes)} minutes.`);
  else bad.push(`The run ended "${end.outcome}" after ${Math.round(minutes)} minutes with ${usd(left)} of ${usd(end.maxUsd)} unspent: ${end.reason.split("\n")[0].slice(0, 200)}`);

  const round = (n: number) => Number(n.toFixed(4));
  return {
    outcome: end.outcome, reason: end.reason.split("\n")[0].slice(0, 300), spentUsd: round(end.spentUsd), maxUsd: end.maxUsd, minutes: Number(minutes.toFixed(1)),
    stages: [...stages.values()].filter((s) => s.calls || s.state).map((s) => ({ ...s, costUsd: round(s.costUsd), seconds: Math.round(s.seconds) })),
    agents: [...agents.values()].map((a) => ({ ...a, costUsd: round(a.costUsd) })).sort((a, b) => b.costUsd - a.costUsd),
    good, bad,
  };
}

/** The review as text, for a report or a ticket. */
export function engineReviewText(r: EngineReview): string {
  return [
    `Engine review: ${r.outcome}, ${usd(r.spentUsd)} of ${usd(r.maxUsd)}, ${Math.round(r.minutes)} minutes.`,
    "", "What the engine did well:", ...(r.good.length ? r.good.map((x) => `- ${x}`) : ["- (nothing recorded)"]),
    "", "What the engine did badly:", ...(r.bad.length ? r.bad.map((x) => `- ${x}`) : ["- (nothing recorded)"]),
    "", "By station:", ...r.stages.map((s) => `- ${s.station}: ${plural(s.calls, "call")}, ${usd(s.costUsd)}, ${s.seconds} s${s.rounds > 1 ? `, ${s.rounds} rounds` : ""}${s.state ? `, ${s.state}` : ""}`),
    "", "By agent:", ...r.agents.map((a) => `- ${a.agent}: ${plural(a.calls, "call")}, ${usd(a.costUsd)}, verdicts ${a.passes} pass / ${a.fails} fail${a.lastNote ? ` (last: ${a.lastNote.slice(0, 120)})` : ""}`),
  ].join("\n");
}
