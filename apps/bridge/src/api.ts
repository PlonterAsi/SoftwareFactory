import { useEffect, useMemo, useState } from "react";

/** Same shapes the core writes to its event log. */
export interface SfEvent { id: number; ts: string; type: string; payload: any }
export interface Signal { id: number; ts: string; text: string; source: string }
export interface AgentRunView {
  runId: number;
  agent: string;
  station?: string;
  factoryRun?: number;
  prompt: string;
  model: string | null;
  startedAt: string;
  state: "running" | "done" | "failed";
  text?: string;
  error?: string;
  costUsd?: number;
  durationMs?: number;
  models?: string[];
  contextTokens?: number;
}

/** In the browser the dev server proxies /api; inside Tauri the core listens on localhost. */
export const API: string =
  import.meta.env.VITE_SF_API ?? (location.protocol.startsWith("http") ? "" : "http://127.0.0.1:4317");

export async function captureSignal(text: string) {
  const r = await fetch(`${API}/api/signals`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  if (!r.ok) throw new Error((await r.json()).error ?? "capture failed");
  return (await r.json()) as Signal;
}

export async function startFactoryRun(idea: string, maxUsd?: number) {
  const r = await fetch(`${API}/api/factory/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idea, maxUsd }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? "could not start the run");
  return j.run as number;
}

export async function decideGate(run: number, gate: string, approve: boolean, note?: string) {
  const r = await fetch(`${API}/api/factory/runs/${run}/gate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gate, approve, note }) });
  if (!r.ok) throw new Error((await r.json()).error ?? "gate failed");
}

export type StationState = "idle" | "active" | "pass" | "fail" | "incomplete" | "waiting";
export interface TestCaseView { name: string; file: string; pass: boolean; error?: string }
export interface FactoryRunView {
  run: number;
  idea: string;
  startedAt: string;
  maxUsd: number;
  spentUsd: number;
  maxFixRounds: number;
  stations: Record<string, { state: StationState; round?: number; note?: string }>;
  plan?: { name: string; summary: string; acceptance: string[]; tasks: { id: string; title: string; dependsOn: string[] }[] };
  dir?: string;
  tests: { round: number; passed: number; failed: number; cases: TestCaseView[] }[];
  files: Record<string, { lines: number; writes: number; last: string; locked: boolean }>;
  refused: { path: string; reason: string; station: string }[];
  visuals: { station: string; round?: number; pass: boolean; items: string[]; missing: string[] }[];
  waiting?: { gate: string; question: string };
  fixRounds: number;
  finished?: { outcome: "shipped" | "stopped" | "failed"; reason: string; totalUsd: number | null; agentCalls?: number; sha?: string };
}

/** Fold factory events into one view per run. */
export function foldRuns(events: SfEvent[]): FactoryRunView[] {
  const runs = new Map<number, FactoryRunView>();
  for (const e of events) {
    const p = e.payload ?? {};
    if (e.type === "factory.run.started") {
      runs.set(e.id, { run: e.id, idea: p.idea, startedAt: e.ts, maxUsd: p.maxUsd, spentUsd: 0, maxFixRounds: p.maxFixRounds, stations: {}, tests: [], files: {}, refused: [], visuals: [], fixRounds: 0 });
      continue;
    }
    const r = runs.get(p.run ?? p.factoryRun);
    if (!r) continue;
    switch (e.type) {
      case "factory.station":
        r.stations[p.station] = { state: p.state, round: p.round, note: p.note };
        r.spentUsd = p.spentUsd ?? r.spentUsd;
        r.maxUsd = p.maxUsd ?? r.maxUsd;
        if (p.station === "fix" && p.round) r.fixRounds = Math.max(r.fixRounds, p.round);
        break;
      case "factory.plan": r.plan = p.plan; r.dir = p.dir; break;
      case "factory.tests": r.tests.push({ round: p.round, passed: p.passed, failed: p.failed, cases: p.cases }); break;
      case "factory.files":
        for (const w of p.written ?? []) {
          const f = r.files[w.path] ?? { lines: 0, writes: 0, last: "", locked: false };
          r.files[w.path] = { lines: w.lines, writes: f.writes + 1, last: p.station, locked: p.station === "tests" };
        }
        for (const x of p.refused ?? []) r.refused.push({ ...x, station: p.station });
        break;
      case "factory.visual": r.visuals.push({ station: p.station, round: p.round, pass: p.pass, items: p.items, missing: p.missing }); break;
      case "factory.gate": r.waiting = p.state === "waiting" ? { gate: p.gate, question: p.question } : undefined; break;
      case "factory.run.finished": r.finished = { outcome: p.outcome, reason: p.reason, totalUsd: p.totalUsd, agentCalls: p.agentCalls, sha: p.sha }; r.waiting = undefined; if (p.totalUsd != null) r.spentUsd = p.totalUsd; break;
    }
  }
  return [...runs.values()];
}

export async function askOverseer(prompt: string, model: string) {
  const r = await fetch(`${API}/api/agent/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt, model }) });
  return r.json();
}

/** Subscribe to the core's event stream and fold it into views. Everything on screen is derived from events. */
export function useFactory() {
  const [events, setEvents] = useState<SfEvent[]>([]);
  const [online, setOnline] = useState(false);
  const [runtime, setRuntime] = useState<string>("…");

  useEffect(() => {
    let closed = false;
    fetch(`${API}/api/health`).then((r) => r.json()).then((h) => !closed && setRuntime(h.runtime)).catch(() => {});
    const es = new EventSource(`${API}/api/events`);
    es.onopen = () => setOnline(true);
    es.onerror = () => setOnline(false);
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as SfEvent;
      setEvents((prev) => (prev.some((p) => p.id === e.id) ? prev : [...prev, e]));
    };
    return () => { closed = true; es.close(); };
  }, []);

  const signals = useMemo<Signal[]>(
    () => events.filter((e) => e.type === "signal.captured").map((e) => ({ id: e.id, ts: e.ts, ...e.payload })),
    [events],
  );

  const runs = useMemo<AgentRunView[]>(() => {
    const byId = new Map<number, AgentRunView>();
    for (const e of events) {
      if (e.type === "agent.run.started") {
        byId.set(e.id, { runId: e.id, agent: e.payload.agent, station: e.payload.station, factoryRun: e.payload.factoryRun, prompt: e.payload.prompt, model: e.payload.model, startedAt: e.ts, state: "running" });
      } else if (e.type === "agent.run.completed" && byId.has(e.payload.runId)) {
        Object.assign(byId.get(e.payload.runId)!, { state: "done", ...e.payload });
      } else if (e.type === "agent.run.failed" && byId.has(e.payload.runId)) {
        Object.assign(byId.get(e.payload.runId)!, { state: "failed", error: e.payload.error });
      }
    }
    return [...byId.values()];
  }, [events]);

  const factoryRuns = useMemo(() => foldRuns(events), [events]);
  const totalUsd = runs.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  return { events, signals, runs, factoryRuns, online, runtime, totalUsd };
}

// ---- Order Engine (milestone 3) ----

export type FragmentKind = "idea" | "rule" | "decision" | "question" | "task" | "note" | "noise";
export interface OrderNode { id: number; kind: "project" | "idea" | "thread"; title: string; parentId: number | null; createdAt: string; signalId: number | null; by: string; mergedInto?: number; lastActive: string }
export interface Fragment {
  id: number; signalId: number; ts: string; text: string; kind: FragmentKind; nodeId: number | null; suggestedNodeId: number | null;
  confidence: number; important: boolean; pinned: boolean; origin: "explicit" | "inferred"; by: string; state: "live" | "superseded" | "faded"; supersededBy?: number; lastTouched: string;
}
export interface Conflict {
  id: number; ts: string; a: number; b: number; nodeId: number | null; reason: string; detectedBy: string; status: "open" | "resolved";
  winner?: number; loser?: number; rule?: string; effect?: string; by?: string; proposal?: { winner: number; rule: string; why: string };
}
export interface SweepItem { id: number; ts: string; action: "fade" | "raise" | "digest" | "merge-proposal" | "merge"; fragmentId?: number; nodeId?: number; intoNodeId?: number; summary?: string; reason: string; undone: boolean }
export interface OrderState {
  nodes: OrderNode[]; fragments: Fragment[]; conflicts: Conflict[]; sweeps: SweepItem[];
  ingests: { signalId: number; ts: string; mode: string; state: string; costUsd: number; fragments: number[]; note?: string }[];
  briefings: { id: number; ts: string; lines: { kind: string; text: string; ref?: number }[] }[];
  visuals: { id: number; signalId: number | null; scope: string; pass: boolean; items: string[]; missing: string[] }[];
  signals: Record<number, { ts: string; text: string; source: string }>;
  canon: Record<number, { id: number; inheritedFrom: number | null; rank: number }[]>;
  spentUsd: number; mode: string; maxUsd: number;
}

const EMPTY: OrderState = { nodes: [], fragments: [], conflicts: [], sweeps: [], ingests: [], briefings: [], visuals: [], signals: {}, canon: {}, spentUsd: 0, mode: "…", maxUsd: 0 };

async function post(path: string, body: unknown = {}) {
  const r = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? "request failed");
  return j;
}

export const orderApi = {
  move: (fragmentId: number, nodeId: number | null) => post(`/api/order/fragments/${fragmentId}/move`, { nodeId }),
  pin: (fragmentId: number, pinned: boolean) => post(`/api/order/fragments/${fragmentId}/pin`, { pinned }),
  resolve: (conflictId: number, winner: number) => post(`/api/order/conflicts/${conflictId}/resolve`, { winner }),
  sweep: () => post(`/api/order/sweep`),
  undo: (sweepId: number) => post(`/api/order/sweeps/${sweepId}/undo`),
  acceptMerge: (sweepId: number) => post(`/api/order/sweeps/${sweepId}/accept`),
  createNode: (kind: string, title: string, parentId: number | null) => post(`/api/order/nodes`, { kind, title, parentId }),
};

/**
 * The Order Engine's state is folded from the same event log by the core.
 * Refetch whenever an order event arrives; remember when each fragment
 * arrived so the star map can fly it in as a particle.
 */
export function useOrder(events: SfEvent[]) {
  const [state, setState] = useState<OrderState>(EMPTY);
  const [arrivals, setArrivals] = useState<Record<number, number>>({});
  const orderEvents = events.filter((e) => e.type.startsWith("order."));
  const lastId = orderEvents.at(-1)?.id ?? 0;
  const firstLoad = useMemo(() => ({ done: false }), []);
  useEffect(() => {
    let stop = false;
    const t = setTimeout(() => {
      fetch(`${API}/api/order/state`).then((r) => r.json()).then((s: OrderState) => {
        if (stop) return;
        setState(s);
        if (firstLoad.done) {
          const now = Date.now();
          setArrivals((prev) => {
            const next = { ...prev };
            for (const f of s.fragments) if (!(f.id in next)) next[f.id] = now;
            return next;
          });
        } else {
          firstLoad.done = true;
          setArrivals(Object.fromEntries(s.fragments.map((f) => [f.id, 0])));
        }
      }).catch(() => {});
    }, 120);
    return () => { stop = true; clearTimeout(t); };
  }, [lastId, firstLoad]);
  return { ...state, arrivals };
}
