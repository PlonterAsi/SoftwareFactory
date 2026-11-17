import type { EventLog, SfEvent } from "../events.js";
import { BUILT_IN_FLOWS, MAX_ROUNDS_LIMIT, RUNNER_ACTIONS, flowProblems, runnerOf, type FlowDef, type FlowEdge, type FlowStep } from "./flow.js";

/**
 * Flows that improve themselves (SF behavior brief, phase 5; docs/flows-improve.md).
 *
 * A change to a flow is first a proposal. It comes from you (in words, or a change you make), or from SF, which
 * reads what past runs of the flow show. Before anyone uses it, a proposal is replayed on the flow's past runs:
 * what each run would have cost and which outcome it would have risked, from what those runs recorded. Then you
 * may try it once, live: the next run of that flow follows it, within that run's own limit. Nothing becomes the
 * flow until you accept it, and accepting saves it as the flow's next version (so it can always be put back).
 *
 * Events:
 *   flow.proposed   { flowId, baseVersion, flow, ops, why, by, words?, replay, costUsd? }
 *   flow.proposal   { id, state: "armed" | "taken" | "tried" | "accepted" | "rejected", run?, ticket?, outcome?, totalUsd?, note? }
 */

// ---------- what past runs show ----------

/** What one step did in one past run. */
export interface StepTrace { costUsd: number; rounds: number; passed: boolean | null; ran: boolean; found: number }
export interface RunTrace {
  /** The factory run, or the ticket for a one-session flow. */
  run: number; kind: "run" | "ticket"; at: string; flowVersion: number;
  outcome: string; totalUsd: number;
  steps: Record<string, StepTrace>;
}

const P = (e: SfEvent) => e.payload as Record<string, any>;
const money = (n: number) => `$${n.toFixed(2)}`;

/** The slots each top-level step pays for: its own, and those of the steps carried out inside it. */
function slotsOf(flow: FlowDef): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const s of flow.steps.filter((x) => !x.within)) out.set(s.id, new Set(s.agents));
  for (const s of flow.steps.filter((x) => x.within)) for (const a of s.agents) out.get(s.within!)?.add(a);
  return out;
}

/**
 * The past runs of a flow (newest last): for the engine, the factory runs that started with this flow id; for a
 * one-session flow, the tickets worked with it. Read from the log, free.
 */
export function traceRuns(log: EventLog, flow: FlowDef, limit = 20): RunTrace[] {
  return runnerOf(flow) === "engine" ? engineTraces(log, flow, limit) : runnerOf(flow) === "session" ? sessionTraces(log, flow, limit) : [];
}

function engineTraces(log: EventLog, flow: FlowDef, limit: number): RunTrace[] {
  const started = log.list({ type: "factory.run.started", limit: 1e6 }).filter((e) => P(e).flow?.id === flow.id && P(e).flow?.trialOf == null).slice(-limit);
  if (!started.length) return [];
  const ids = new Set(started.map((e) => e.id));
  const first = started[0].id - 1;
  const finished = new Map<number, Record<string, any>>();
  for (const e of log.list({ type: "factory.run.finished", sinceId: first, limit: 1e6 })) if (ids.has(P(e).run)) finished.set(P(e).run, P(e));
  const cost = new Map<number, Map<string, number>>();
  const runOf = new Map<number, number>();
  for (const e of log.list({ type: "agent.run.started", sinceId: first, limit: 1e6 })) if (ids.has(P(e).factoryRun)) runOf.set(e.id, P(e).factoryRun);
  for (const t of ["agent.run.completed", "agent.run.failed"] as const) for (const e of log.list({ type: t, sinceId: first, limit: 1e6 })) {
    const run = runOf.get(P(e).runId);
    if (run == null) continue;
    const m = cost.get(run) ?? cost.set(run, new Map()).get(run)!;
    const st = String(P(e).station ?? "");
    m.set(st, (m.get(st) ?? 0) + Number(P(e).costUsd ?? 0));
  }
  const stations = new Map<number, Map<string, { round: number; state: string; ran: boolean }>>();
  for (const e of log.list({ type: "factory.station", sinceId: first, limit: 1e6 })) {
    const p = P(e);
    if (!ids.has(p.run)) continue;
    const m = stations.get(p.run) ?? stations.set(p.run, new Map()).get(p.run)!;
    const cur = m.get(p.station) ?? { round: 0, state: "", ran: false };
    m.set(p.station, { round: Math.max(cur.round, Number(p.round ?? 0) || (p.state === "skipped" ? 0 : 1)), state: p.state, ran: cur.ran || (p.state !== "skipped") });
  }
  const found = new Map<number, Map<string, number>>();
  const bump = (run: number, step: string, n = 1) => { const m = found.get(run) ?? found.set(run, new Map()).get(run)!; m.set(step, (m.get(step) ?? 0) + n); };
  for (const e of log.list({ type: "factory.review", sinceId: first, limit: 1e6 })) if (ids.has(P(e).run) && P(e).verdict === "fix") bump(P(e).run, "review");
  for (const e of log.list({ type: "factory.evaluation", sinceId: first, limit: 1e6 })) if (ids.has(P(e).run) && P(e).pass === false) bump(P(e).run, "evaluate");

  return started.map((e) => {
    const run = e.id;
    const f = P(e).flow as FlowDef;
    const fin = finished.get(run);
    const c = cost.get(run) ?? new Map();
    const st = stations.get(run) ?? new Map();
    const steps: Record<string, StepTrace> = {};
    for (const [id, slots] of slotsOf(f)) {
      const step = f.steps.find((s) => s.id === id)!;
      const names = step.stations?.length ? step.stations : [id];
      let rounds = 0, passed: boolean | null = null, ran = false;
      for (const n of names) {
        const x = st.get(n);
        if (!x) continue;
        rounds = Math.max(rounds, x.round);
        ran = ran || x.ran;
        passed = x.state === "pass" ? true : x.state === "fail" || x.state === "incomplete" ? false : passed;
      }
      let usd = 0;
      for (const s of slots) usd += c.get(s) ?? 0;
      steps[step.action ?? id] = { costUsd: Number(usd.toFixed(4)), rounds, passed, ran: ran || usd > 0, found: found.get(run)?.get(step.action ?? id) ?? 0 };
    }
    const total = fin?.totalUsd != null ? Number(fin.totalUsd) : [...c.values()].reduce((a, b) => a + b, 0);
    return { run, kind: "run" as const, at: e.ts, flowVersion: Number(f.version ?? 1), outcome: String(fin?.outcome ?? "running"), totalUsd: Number(total.toFixed(4)), steps };
  });
}

function sessionTraces(log: EventLog, flow: FlowDef, limit: number): RunTrace[] {
  let rows: { id: number }[] = [];
  try { rows = log.db.prepare("SELECT id FROM tickets WHERE flow = ? ORDER BY id DESC LIMIT ?").all(flow.id, limit) as { id: number }[]; } catch { return []; }
  const ids = new Set(rows.map((r) => Number(r.id)));
  if (!ids.size) return [];
  const steps = new Map<number, SfEvent[]>();
  for (const e of log.list({ type: "ticket.step", limit: 1e6 })) if (ids.has(P(e).id)) (steps.get(P(e).id) ?? steps.set(P(e).id, []).get(P(e).id)!).push(e);
  const runOf = new Map<number, { ticket: number; station: string }>();
  for (const e of log.list({ type: "agent.run.started", limit: 1e6 })) if (ids.has(P(e).ticket)) runOf.set(e.id, { ticket: P(e).ticket, station: String(P(e).station ?? "") });
  const cost = new Map<number, Map<string, number>>();
  for (const t of ["agent.run.completed", "agent.run.failed"] as const) for (const e of log.list({ type: t, limit: 1e6 })) {
    const r = runOf.get(P(e).runId);
    if (!r) continue;
    const m = cost.get(r.ticket) ?? cost.set(r.ticket, new Map()).get(r.ticket)!;
    m.set(r.station, (m.get(r.station) ?? 0) + Number(P(e).costUsd ?? 0));
  }
  const out: RunTrace[] = [];
  for (const id of [...ids].sort((a, b) => a - b)) {
    const evs = steps.get(id) ?? [];
    if (!evs.length) continue;
    // The last attempt: from the last time its build started.
    const ps = evs.map((e) => P(e));
    let from = -1;
    for (let i = ps.length - 1; i >= 0; i--) if (ps[i].step === "build" && ps[i].state === "running") { from = i; break; }
    const last = (from >= 0 ? evs.slice(from) : evs).map((e) => P(e));
    const c = cost.get(id) ?? new Map();
    const count = (step: string, state: string) => last.filter((p) => p.step === step && p.state === state).length;
    const committed = last.some((p) => p.step === "commit" && p.state === "passed");
    out.push({
      run: id, kind: "ticket", at: evs[0].ts, flowVersion: 0, outcome: committed ? "shipped" : "failed",
      totalUsd: Number([...c.values()].reduce((a, b) => a + b, 0).toFixed(4)),
      steps: {
        build: { costUsd: c.get("build") ?? 0, rounds: 1, passed: count("build", "failed") === 0, ran: true, found: 0 },
        checks: { costUsd: 0, rounds: count("fix", "running"), passed: !last.some((p) => p.step === "checks" && p.state === "failed"), ran: true, found: count("fix", "running") },
        review: { costUsd: c.get("review") ?? 0, rounds: Math.max(1, count("review fix", "running")), passed: last.some((p) => p.step === "review" && p.state === "passed"), ran: last.some((p) => p.step === "review"), found: count("review", "failed") },
      },
    });
  }
  return out;
}

// ---------- what changed ----------

export interface FlowChange { kind: "removed" | "added" | "rounds" | "crew" | "brief" | "other"; step?: string; text: string; before?: unknown; after?: unknown }

const key = (s: FlowStep) => s.action ?? s.id;

/** The differences between two versions of a flow, in words. */
export function diffFlows(a: FlowDef, b: FlowDef): FlowChange[] {
  const out: FlowChange[] = [];
  const top = (f: FlowDef) => new Map(f.steps.map((s) => [s.id, s]));
  const A = top(a), B = top(b);
  for (const [id, s] of A) if (!B.has(id)) out.push({ kind: "removed", step: key(s), text: `${s.label} is left out` });
  for (const [id, s] of B) if (!A.has(id)) out.push({ kind: "added", step: key(s), text: `${s.label} is added` });
  for (const [id, s] of A) {
    const t = B.get(id);
    if (!t) continue;
    if ((s.loop?.maxRounds ?? null) !== (t.loop?.maxRounds ?? null)) out.push({ kind: "rounds", step: key(s), before: s.loop?.maxRounds ?? null, after: t.loop?.maxRounds ?? null, text: `${s.label}: at most ${t.loop?.maxRounds ?? "the default"} rounds (was ${s.loop?.maxRounds ?? "the default"})` });
    if (JSON.stringify(s.crew ?? []) !== JSON.stringify(t.crew ?? [])) out.push({ kind: "crew", step: key(s), before: s.crew ?? [], after: t.crew ?? [], text: `${s.label}: worked by ${t.crew?.length ? t.crew.join(", ") : "the station's crew"} (was ${s.crew?.length ? s.crew.join(", ") : "the station's crew"})` });
    const rest = (x: FlowStep) => JSON.stringify({ ...x, loop: x.loop ? { ...x.loop, maxRounds: undefined } : undefined, crew: undefined });
    if (rest(s) !== rest(t)) out.push({ kind: "other", step: key(s), text: `${s.label}: its description or drawing changed` });
  }
  if ((a.brief ?? "") !== (b.brief ?? "")) out.push({ kind: "brief", before: a.brief ?? "", after: b.brief ?? "", text: b.brief ? `Tells the crew: "${b.brief.slice(0, 160)}"` : "Tells the crew nothing extra any more" });
  return out;
}

// ---------- replay ----------

export interface ReplayRun { run: number; kind: "run" | "ticket"; at: string; outcome: string; beforeUsd: number; afterUsd: number; risk: "none" | "low" | "high"; notes: string[] }
export interface ReplayResult {
  runs: ReplayRun[]; beforeUsd: number; afterUsd: number; risky: number; helped: number;
  verdict: "cheaper" | "costlier" | "risky" | "may-help" | "same" | "no-history";
  summary: string; changes: FlowChange[]; unpriced: string[];
}

/** How an agent did at a station (Agent Bay stats), for a step given to another agent. */
export type AgentRecord = (agent: string, slot: string) => { passRate: number | null; avgUsd: number; calls: number } | null;

/**
 * Replay a changed flow on the current flow's past runs, from what those runs recorded (no agent is called):
 * a step left out saves what it cost, and risks what it found; a lower round limit saves the rounds above it,
 * and risks the runs that passed only later; a higher one may help runs that ran out of rounds. What cannot be
 * priced from the past (new words for the crew, another agent) is said, for the live trial to find out.
 */
export function replay(log: EventLog, current: FlowDef, candidate: FlowDef, o: { limit?: number; agents?: AgentRecord } = {}): ReplayResult {
  const changes = diffFlows(current, candidate);
  const traces = traceRuns(log, current, o.limit ?? 20);
  const unpriced: string[] = [];
  for (const c of changes) {
    if (c.kind === "brief") unpriced.push("New words for the crew: the past cannot price them; the live trial will show.");
    if (c.kind === "crew") {
      const who = (c.after as string[])[0];
      const slot = current.steps.find((s) => key(s) === c.step)?.agents[0] ?? "";
      const r = who ? o.agents?.(who, slot) : null;
      unpriced.push(who ? (r && r.calls ? `${who} has ${r.calls} past calls${r.passRate != null ? `, ${Math.round(r.passRate * 100)}% passed its checks` : ""}, about ${money(r.avgUsd)} a call.` : `${who} has no past work to judge it by; the live trial will show.`) : "The station's own crew works it again.");
    }
    if (c.kind === "added") unpriced.push(`${c.text}: priced from the runs that had it, where there are any.`);
  }
  // The average cost of each step where it ran, for a step that is added back.
  const avg = (k: string) => { const xs = traces.map((t) => t.steps[k]).filter((x) => x?.ran); return xs.length ? xs.reduce((a, x) => a + x.costUsd, 0) / xs.length : 0; };
  const runs: ReplayRun[] = traces.map((t) => {
    let after = t.totalUsd;
    let risk: ReplayRun["risk"] = "none";
    const notes: string[] = [];
    const raise = (r: ReplayRun["risk"]) => { if (r === "high" || (r === "low" && risk === "none")) risk = r; };
    for (const c of changes) {
      const s = c.step ? t.steps[c.step] : undefined;
      if (c.kind === "removed" && s) {
        if (!s.ran) { notes.push(`${c.text}: it did not run here`); continue; }
        after -= s.costUsd;
        if (s.found > 0) { raise("high"); notes.push(`${c.text}: saves ${money(s.costUsd)}, but here it caught ${s.found} problem${s.found > 1 ? "s" : ""} that would have gone through`); }
        else { raise("low"); notes.push(`${c.text}: saves ${money(s.costUsd)}; here it changed nothing`); }
      } else if (c.kind === "added" && c.step) {
        const a = avg(c.step);
        after += a;
        notes.push(`${c.text}: about ${money(a)} more`);
      } else if (c.kind === "rounds" && s && s.ran) {
        const was = Number(c.before ?? 0) || s.rounds, now = Number(c.after ?? 0) || was;
        const perRound = s.rounds ? s.costUsd / s.rounds : 0;
        if (now < s.rounds) {
          after -= perRound * (s.rounds - now);
          if (s.passed) { raise("high"); notes.push(`It passed only at round ${s.rounds}: with ${now} it would have stopped before passing`); }
          else { raise("low"); notes.push(`Saves about ${money(perRound * (s.rounds - now))} on rounds that did not pass anyway`); }
        } else if (now > was && s.rounds >= was && s.passed === false) {
          after += perRound * (now - was);
          notes.push(`It ran out of rounds here without passing: ${now - was} more could have helped, about ${money(perRound * (now - was))} more`);
        } else notes.push(`It used ${s.rounds} round${s.rounds === 1 ? "" : "s"}: the new limit changes nothing here`);
      }
    }
    return { run: t.run, kind: t.kind, at: t.at, outcome: t.outcome, beforeUsd: t.totalUsd, afterUsd: Number(Math.max(0, after).toFixed(4)), risk, notes };
  });
  const beforeUsd = Number(runs.reduce((a, r) => a + r.beforeUsd, 0).toFixed(4));
  const afterUsd = Number(runs.reduce((a, r) => a + r.afterUsd, 0).toFixed(4));
  const risky = runs.filter((r) => r.risk === "high").length;
  const helped = runs.filter((r) => r.notes.some((n) => n.includes("could have helped"))).length;
  const verdict: ReplayResult["verdict"] = !runs.length ? "no-history" : risky ? "risky" : helped ? "may-help" : afterUsd < beforeUsd - 0.005 ? "cheaper" : afterUsd > beforeUsd + 0.005 ? "costlier" : "same";
  const what = runs.length ? `On the last ${runs.length} ${runs[0].kind === "run" ? "run" : "ticket"}${runs.length > 1 ? "s" : ""}: ${money(beforeUsd)} would have been ${money(afterUsd)}` : "No past runs of this flow to replay yet";
  const tail = verdict === "risky" ? `, but ${risky} would have let a problem through or stopped before passing.` : verdict === "may-help" ? `; ${helped} that ran out of rounds might have passed.` : verdict === "no-history" ? ". The live trial is the first evidence." : ".";
  return { runs, beforeUsd, afterUsd, risky, helped, verdict, summary: `${what}${tail}`, changes, unpriced };
}

// ---------- changes as operations ----------

export type FlowOp =
  | { op: "drop"; step: string }
  | { op: "restore"; step: string }
  | { op: "rounds"; step: string; n: number }
  | { op: "crew"; step: string; agent: string | null }
  | { op: "brief"; text: string };

/** Words a person uses for a step, beside its id, action and label. */
const ALIASES: Record<string, string[]> = {
  council: ["council", "seats", "debate"], discover: ["design", "product design", "designer", "critic", "discovery"], plan: ["plan", "planner", "spec"],
  tests: ["tests", "tester", "acceptance tests"], build: ["build", "builder"], testFix: ["test", "test loop", "fix", "fixer", "fix loop", "fix rounds"],
  review: ["review", "reviewer"], evaluate: ["judge", "product judge", "evaluate", "evaluation"], checks: ["checks", "check", "fix", "fix rounds"], answer: ["answer", "reader"],
};

/** The step a word names: its id, action, label, or a usual word for it. */
export function findStep(flow: FlowDef, word: string): FlowStep | undefined {
  const w = word.toLowerCase().trim().replace(/^the\s+/, "").replace(/\s+(step|loop|station)$/, "");
  const top = flow.steps.filter((s) => !s.within);
  return top.find((s) => s.id.toLowerCase() === w || (s.action ?? "").toLowerCase() === w || s.label.toLowerCase() === w)
    ?? top.find((s) => (ALIASES[s.action ?? s.id] ?? []).includes(w))
    ?? top.find((s) => s.label.toLowerCase().includes(w) && w.length >= 4);
}

/** The flow SoftwareFactory ships under this id, if any (to restore a step from). */
const shipped = (id: string) => BUILT_IN_FLOWS.find((f) => f.id === id);

/** Edges for a set of steps: the shipped flow's, with each step that is not there bypassed. */
function bypass(edges: FlowEdge[], gone: string[]): FlowEdge[] {
  let out = edges.map((e) => ({ ...e }));
  for (const x of gone) {
    const into = out.filter((e) => e.to === x && e.kind !== "back" && e.from !== x);
    const from = out.filter((e) => e.from === x && e.kind !== "back" && e.to !== x);
    out = out.filter((e) => e.from !== x && e.to !== x);
    for (const a of into) for (const b of from) if (!out.some((e) => e.from === a.from && e.to === b.to)) out.push({ from: a.from, to: b.to, kind: a.kind === "branch" || b.kind === "branch" ? "branch" : "next" });
  }
  return out;
}

/** Apply operations to a flow. Throws with a plain message when one cannot apply. The result is checked by the caller. */
export function applyOps(flow: FlowDef, ops: FlowOp[]): FlowDef {
  const f: FlowDef = structuredClone(flow);
  const table = runnerOf(f) === "door" ? null : RUNNER_ACTIONS[runnerOf(f) as Exclude<ReturnType<typeof runnerOf>, "door">];
  for (const op of ops) {
    if (op.op === "brief") { f.brief = op.text.trim().slice(0, 2000) || undefined; continue; }
    if (op.op === "restore") {
      const base = shipped(f.id);
      const s = base && findStep(base, op.step);
      if (!s) throw new Error(`"${op.step}" is not a step SoftwareFactory ships in ${f.name}, so it cannot be brought back.`);
      if (f.steps.some((x) => x.id === s.id)) continue;
      const order = base!.steps.map((x) => x.id);
      const add = base!.steps.filter((x) => x.id === s.id || x.within === s.id);
      f.steps = [...f.steps, ...structuredClone(add)].sort((a, b) => (order.indexOf(a.id) < 0 ? 1e3 : order.indexOf(a.id)) - (order.indexOf(b.id) < 0 ? 1e3 : order.indexOf(b.id)));
      const present = new Set(f.steps.map((x) => x.id));
      f.edges = bypass(base!.edges, order.filter((id) => !present.has(id)));
      continue;
    }
    const s = findStep(f, op.step);
    if (!s) throw new Error(`${f.name} has no step called "${op.step}".`);
    if (op.op === "drop") {
      if (s.action && table?.[s.action]?.required) throw new Error(`${s.label} cannot be left out: the flow must ${table[s.action].label.toLowerCase()}.`);
      const gone = new Set([s.id, ...f.steps.filter((x) => x.within === s.id).map((x) => x.id)]);
      f.steps = f.steps.filter((x) => !gone.has(x.id));
      f.edges = bypass(f.edges, [...gone]);
    } else if (op.op === "rounds") {
      if (!s.loop) throw new Error(`${s.label} is not a loop, so it has no round limit.`);
      const n = Math.round(Number(op.n));
      if (!Number.isFinite(n) || n < 1 || n > MAX_ROUNDS_LIMIT) throw new Error(`A loop may take 1 to ${MAX_ROUNDS_LIMIT} rounds.`);
      s.loop = { ...s.loop, maxRounds: n };
    } else if (op.op === "crew") {
      if (!s.agents.length) throw new Error(`The core does ${s.label} with no agent, so no agent can be named for it.`);
      s.crew = op.agent ? [op.agent] : undefined;
      if (!s.crew) delete s.crew;
    }
  }
  return f;
}

/**
 * Words into operations, free: "skip the council", "at most 3 rounds for the judge", "use React Builder for build",
 * "bring back the review", "tell the crew: keep changes small". `agents` maps names to Bay ids. Unknown words: [].
 */
export function opsFromWords(flow: FlowDef, words: string, agents: { id: string; name: string }[] = []): FlowOp[] {
  const out: FlowOp[] = [];
  const text = words.replace(/\r/g, "");
  const brief = text.match(/\b(?:tell|ask|remind) the (?:crew|builder|agents?)(?: to)?[:,]?\s+(.+)$/i) ?? text.match(/^\s*brief:\s*(.+)$/im);
  const rest = brief ? text.slice(0, brief.index) : text;
  for (const part of rest.split(/[.;\n]|,\s*(?:and\s+)?|\band then\b|\band\b/i).map((x) => x.trim()).filter(Boolean)) {
    let m: RegExpMatchArray | null;
    if ((m = part.match(/\b(?:skip|drop|remove|leave out|cut|no more|without|get rid of)\s+(?:the\s+)?([a-z][\w ]*?)\s*$/i))) { if (findStep(flow, m[1])) out.push({ op: "drop", step: m[1] }); continue; }
    if ((m = part.match(/\b(?:bring back|restore|add back|add|put back|re-?add)\s+(?:the\s+)?([a-z][\w ]*?)\s*$/i))) { out.push({ op: "restore", step: m[1] }); continue; }
    if ((m = part.match(/\b(?:at most|up to|max(?:imum)?(?: of)?|only)\s+(\d+)\s+(?:rounds?|looks?|tries|passes)\s+(?:for|in|on|of)\s+(?:the\s+)?([a-z][\w ]*?)\s*$/i))) { out.push({ op: "rounds", step: m[2], n: Number(m[1]) }); continue; }
    if ((m = part.match(/\b(?:give|let)\s+(?:the\s+)?([a-z][\w ]*?)\s+(\d+)\s+(?:rounds?|looks?|tries)\b/i)) || (m = part.match(/^(?:the\s+)?([a-z][\w ]*?)\s+(?:gets|takes|to)\s+(\d+)\s+(?:rounds?|looks?|tries)\b/i))) { out.push({ op: "rounds", step: m[1], n: Number(m[2]) }); continue; }
    if ((m = part.match(/\b(?:use|let|have|put)\s+(.+?)\s+(?:for|on|to (?:do|work)|work|do)\s+(?:the\s+)?([a-z][\w ]*?)\s*$/i))) {
      const who = m[1].toLowerCase().replace(/^the\s+/, "");
      const a = agents.find((x) => x.id === who || x.name.toLowerCase() === who) ?? (/(station|usual|default)/.test(who) ? null : undefined);
      if (a !== undefined) out.push({ op: "crew", step: m[2], agent: a ? a.id : null });
      continue;
    }
  }
  if (brief) out.push({ op: "brief", text: [flow.brief, brief[1].trim()].filter(Boolean).join(" ") });
  return out;
}

export const WORDS_CONTRACT = `Station contract: flow edit.
You turn a person's words about how a SoftwareFactory flow should change into operations on that flow.
Answer with ONE fenced json block and nothing else: {"ops": [ ... ]}. Each op is one of:
{"op": "drop", "step": "<step id>"}            leave an optional step out
{"op": "restore", "step": "<step id>"}         bring back a step SoftwareFactory ships in this flow
{"op": "rounds", "step": "<step id>", "n": 2}  a loop's round limit (1 to ${MAX_ROUNDS_LIMIT})
{"op": "crew", "step": "<step id>", "agent": "<agent id>" | null}   who works a step (null: the station's crew)
{"op": "brief", "text": "..."}                 the words told to the crew on every run (the whole text)
Use only the step ids and agent ids you are given. If the words ask for something else, answer {"ops": []}.`;

export function wordsPrompt(flow: FlowDef, words: string, agents: { id: string; name: string; station: string }[]): string {
  const steps = flow.steps.filter((s) => !s.within).map((s) => `- ${s.id}: ${s.label} (${s.kind}${s.loop?.maxRounds ? `, at most ${s.loop.maxRounds} rounds` : ""}${s.agents.length ? `, worked by ${s.crew?.join(", ") ?? s.agents[0]}` : ", no agent"}${s.action && RUNNER_ACTIONS[runnerOf(flow) as "engine"]?.[s.action]?.required ? ", required" : ""})`).join("\n");
  const missing = shipped(flow.id)?.steps.filter((s) => !s.within && !flow.steps.some((x) => x.id === s.id)).map((s) => `${s.id} (${s.label})`) ?? [];
  return `The flow "${flow.name}": ${flow.purpose}\nIts steps:\n${steps}${missing.length ? `\nSteps it ships with that are left out now: ${missing.join(", ")}` : ""}\nWords told to the crew now: ${flow.brief ?? "none"}\nAgents: ${agents.map((a) => `${a.id} (${a.name}, made for ${a.station})`).join("; ")}\n\nThe person's words: ${words}`;
}

export function parseOps(text: string): FlowOp[] {
  const raw = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const j = JSON.parse(raw) as { ops?: unknown };
  if (!Array.isArray(j.ops)) throw new Error("no ops list");
  return j.ops.filter((o): o is FlowOp => !!o && typeof o === "object" && ["drop", "restore", "rounds", "crew", "brief"].includes((o as FlowOp).op)).slice(0, 12);
}

// ---------- SF's own proposals ----------

/**
 * What SF proposes from a flow's past runs (free, plain code), each a list of operations and why:
 *   a loop that ran out of rounds without passing in at least half the runs where it ran (two or more): one more round;
 *   a review or judge step that ran in four or more runs, cost money, and never caught anything: leave it out.
 */
/** Steps whose job is to catch problems: SF may propose leaving one out when it never caught any. */
const CATCHERS = new Set(["review", "evaluate"]);

export function proposalsFrom(flow: FlowDef, traces: RunTrace[]): { ops: FlowOp[]; why: string }[] {
  const out: { ops: FlowOp[]; why: string }[] = [];
  const table = runnerOf(flow) === "door" ? null : RUNNER_ACTIONS[runnerOf(flow) as "engine"];
  for (const s of flow.steps.filter((x) => !x.within && x.action)) {
    const k = key(s);
    const ran = traces.map((t) => t.steps[k]).filter((x): x is StepTrace => !!x?.ran);
    const max = s.loop?.maxRounds;
    if (max && max < MAX_ROUNDS_LIMIT) {
      const short = ran.filter((x) => x.rounds >= max && x.passed === false);
      if (short.length >= 2 && short.length * 2 >= ran.length) out.push({ ops: [{ op: "rounds", step: s.id, n: max + 1 }], why: `${s.label} ran out of its ${max} round${max > 1 ? "s" : ""} without passing in ${short.length} of the last ${ran.length} runs where it ran.` });
    }
    // Only a step whose job is to catch problems (a review, the product judge) is judged by what it caught.
    if (s.action && CATCHERS.has(s.action) && table && !table[s.action]?.required && ran.length >= 4 && ran.every((x) => x.found === 0)) {
      const usd = ran.reduce((a, x) => a + x.costUsd, 0);
      if (usd > 0) out.push({ ops: [{ op: "drop", step: s.id }], why: `${s.label} ran in the last ${ran.length} runs, cost ${money(usd)} in all, and never caught a problem.` });
    }
  }
  return out;
}

// ---------- proposals, trials, decisions ----------

export interface FlowProposal {
  id: number; flowId: string; baseVersion: number; at: string; by: "sf" | "words" | "you"; why: string; words?: string;
  ops: FlowOp[]; flow: FlowDef; replay: ReplayResult; costUsd: number;
  state: "proposed" | "armed" | "taken" | "tried" | "accepted" | "rejected";
  trial?: { run?: number; ticket?: number; outcome?: string; totalUsd?: number; at: string };
  decidedAt?: string; note?: string;
}

/** Every proposal, newest first, folded from the log. */
export function proposals(log: EventLog, flowId?: string): FlowProposal[] {
  const by = new Map<number, FlowProposal>();
  for (const e of log.list({ type: "flow.proposed", limit: 1e6 })) {
    const p = P(e);
    if (flowId && p.flowId !== flowId) continue;
    by.set(e.id, { id: e.id, flowId: p.flowId, baseVersion: p.baseVersion, at: e.ts, by: p.by, why: p.why, ...(p.words ? { words: p.words } : {}), ops: p.ops ?? [], flow: p.flow, replay: p.replay, costUsd: Number(p.costUsd ?? 0), state: "proposed" });
  }
  for (const e of log.list({ type: "flow.proposal", limit: 1e6 })) {
    const p = P(e);
    const x = by.get(Number(p.id));
    if (!x) continue;
    x.state = p.state;
    if (p.state === "taken") x.trial = { at: e.ts, ...(p.run != null ? { run: p.run } : {}), ...(p.ticket != null ? { ticket: p.ticket } : {}) };
    if (p.state === "tried") x.trial = { ...(x.trial ?? { at: e.ts }), ...(p.run != null ? { run: p.run } : {}), outcome: p.outcome, totalUsd: p.totalUsd };
    if (p.state === "accepted" || p.state === "rejected") x.decidedAt = e.ts;
    if (p.note) x.note = p.note;
  }
  return [...by.values()].reverse();
}
