import { useEffect, useMemo, useState } from "react";

/** Same shapes the core writes to its event log. */
export interface SfEvent { id: number; ts: string; type: string; payload: any }
/** projectId: the project chat it was said in; absent: the General chat. */
export interface Signal { id: number; ts: string; text: string; source: string; projectId?: number }
export interface AgentRunView {
  runId: number;
  agent: string;
  station?: string;
  factoryRun?: number;
  /** The project chat an Overseer question was asked in. */
  projectId?: number;
  /** A test run from the Agent Bay, not a conversation. */
  bayTest?: boolean;
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

/**
 * In the browser the dev server proxies /api. Inside the desktop app the page is served
 * from tauri://localhost (macOS/Linux) or http://tauri.localhost (Windows), so talk to the
 * core on 127.0.0.1 directly; `tauri dev` loads the Vite server, whose proxy also works.
 */
const inTauriBundle = "__TAURI_INTERNALS__" in window && !location.host.startsWith("127.0.0.1");
export const API: string =
  import.meta.env.VITE_SF_API ?? (inTauriBundle || !location.protocol.startsWith("http") ? "http://127.0.0.1:4317" : "");

export async function captureSignal(text: string, projectId?: number) {
  const r = await fetch(`${API}/api/signals`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, projectId }) });
  if (!r.ok) throw new Error((await r.json()).error ?? "capture failed");
  return (await r.json()) as Signal;
}

/** A Build the core held back because a run already does that idea. "Build again anyway" sends { again: true }. */
export interface DuplicateRun { duplicateOf: number; state: "running" | "shipped" | "stopped"; projectId: number | null }
/** The run a failed Build points at instead, if that is why it failed. */
export const duplicateOf = (e: unknown): DuplicateRun | null => {
  const d = (e as { data?: Partial<DuplicateRun> } | null)?.data;
  return d && typeof d.duplicateOf === "number" ? (d as DuplicateRun) : null;
};
/** Ideas compared the way the core compares them: case, spacing and closing punctuation do not matter. */
export const normIdea = (idea: string) => idea.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!?\s]+$/, "");

export async function startFactoryRun(idea: string, maxUsd?: number, projectId?: number, again?: boolean) {
  const r = await fetch(`${API}/api/factory/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idea, maxUsd, projectId, ...(again ? { again } : {}) }) });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error ?? "could not start the run"), { data: j });
  return j.run as number;
}

export async function resumeRun(run: number) {
  const r = await fetch(`${API}/api/factory/runs/${run}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? "could not resume the run");
  return j as { run: number; from: string };
}

export async function decideGate(run: number, gate: string, approve: boolean, note?: string) {
  const r = await fetch(`${API}/api/factory/runs/${run}/gate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gate, approve, note }) });
  if (!r.ok) throw new Error((await r.json()).error ?? "gate failed");
}

export type StationState = "idle" | "active" | "pass" | "fail" | "incomplete" | "waiting" | "skipped";
export type Vote = "build" | "reshape" | "drop";
export interface SeatView { agent: string; name: string; version: number; round: number; take?: { take: string; proposals: string[]; concerns: string[]; vote: Vote; scope: string }; error?: string }
export interface CouncilBriefView { rounds: number; votes: Record<string, Vote>; outcome: Vote; agreed: string[]; proposals: string[]; concerns: string[] }
export interface ReviewView { round: number; agent: string; verdict: "pass" | "fix"; findings: { severity: "high" | "low"; text: string }[]; /** Each acceptance criterion, checked by running the product (H8). */ criteria?: { text: string; pass: boolean; evidence: string }[] }
export interface TestCaseView { name: string; file: string; pass: boolean; error?: string }
/** A gate a run waits at. For a failed step: which one, how many tries, and whether the last try failed the same way. */
export interface GateWaitView { gate: string; question: string; at: string; action?: string; kind?: "retry" | "council" | "rounds" | "budget"; station?: string; attempt?: number; error?: string; same?: boolean }
export interface FactoryRunView {
  run: number;
  idea: string;
  startedAt: string;
  maxUsd: number;
  spentUsd: number;
  maxFixRounds: number;
  stations: Record<string, { state: StationState; round?: number; note?: string }>;
  plan?: { name: string; summary: string; acceptance: string[]; tasks: { id: string; title: string; dependsOn: string[] }[] };
  /** What the gaps check found missing from the plan, and whether it was added before the approval. */
  planGaps?: { missing: string[]; added: boolean }[];
  dir?: string;
  tests: { round: number; passed: number; failed: number; cases: TestCaseView[] }[];
  files: Record<string, { lines: number; writes: number; last: string; locked: boolean }>;
  refused: { path: string; reason: string; station: string }[];
  visuals: { station: string; round?: number; pass: boolean; items: string[]; missing: string[] }[];
  waiting?: GateWaitView;
  /** A failed step you sent back with Retry, while it runs again. */
  retrying?: { station: string; attempt: number; at: string };
  fixRounds: number;
  council: { round: number; seats: SeatView[]; brief: CouncilBriefView }[];
  /** Discovery: each round's product documents and the Critic's scores; the last entry is what the plan is built from. */
  discovery: DiscoveryRoundView[];
  /** The build loop: the app as a list of features, built one per session (empty when the build was one call). */
  features: FeatureView[];
  reviews: ReviewView[];
  /** The product judge: each round's requirement checks and scores from the running app. */
  evaluations: EvaluationView[];
  /** The engine review: what this run says about the factory itself (written when the run ends, from its own log). */
  retro?: EngineReviewView;
  /** The engine's loop (H5, H6): every fix attempt, what it changed and what came of it, and each step up the ladder. */
  loop: LoopEventView[];
  finished?: { outcome: "shipped" | "stopped" | "failed"; reason: string; totalUsd: number | null; agentCalls?: number; sha?: string; resumable?: boolean };
  /** Picked up again after the app closed: from which station, how many times, and whether on its own. */
  resumed?: { from: string; auto: boolean; count: number; at: string };
}

export interface EvaluationView { round: number; pass: boolean; skipped?: string; bar: number; screens: number; requirements: { id: string; met: boolean; evidence: string }[]; scores: Record<string, number>; problems: { where: string; problem: string; fix: string }[] }
export interface EngineReviewView {
  outcome: string; reason: string; spentUsd: number; maxUsd: number; minutes: number;
  stages: { station: string; calls: number; failedCalls: number; costUsd: number; seconds: number; rounds: number; state: string }[];
  agents: { agent: string; calls: number; failedCalls: number; costUsd: number; passes: number; fails: number; lastNote?: string }[];
  good: string[]; bad: string[];
}
export interface FeatureView { id: string; title: string; state: "building" | "built" | "empty" | "regressed" | "broken"; attempt: number; /** Its place in the build order and how many features the build has. */ index?: number; of?: number; passed?: number; failed?: number; files?: string[]; broke?: string[]; crashed?: string[] }
export interface ProductDocsView {
  brief: { who: string; problem: string; promise: string; notThis: string[] };
  research: { finding: string; source?: string }[];
  journeys: { moment: string; goal: string; steps: string[] }[];
  screens: { id: string; name: string; purpose: string; shows: string[]; actions: string[] }[];
  requirements: { id: string; text: string; from: "person" | "design"; must: boolean }[];
  rules?: { name: string; rule: string }[];
  assumptions: string[];
}
export interface DiscoveryRoundView { round: number; docs: ProductDocsView; critique: { scores: Record<string, number>; problems: { where: string; problem: string; fix: string }[] } | null; pass: boolean; bar: number; settled?: string }

export type LoopEventView =
  | { kind: "attempt"; at: string; round: number; agent: string; model: string; before: number; after: number; files: string[]; said: string; dispute?: string; ladder: string }
  | { kind: "ladder"; at: string; from: string; to: string; reason: string; round: number }
  | { kind: "relocked"; at: string; files: string[]; reason: string }
  | { kind: "kept"; at: string; evidence: string; said: string };

/** Fold factory events into one view per run. */
export function foldRuns(events: SfEvent[]): FactoryRunView[] {
  const runs = new Map<number, FactoryRunView>();
  for (const e of events) {
    const p = e.payload ?? {};
    if (e.type === "factory.run.started") {
      runs.set(e.id, { run: e.id, idea: p.idea, startedAt: e.ts, maxUsd: p.maxUsd, spentUsd: 0, maxFixRounds: p.maxFixRounds, stations: {}, tests: [], files: {}, refused: [], visuals: [], fixRounds: 0, council: [], discovery: [], features: [], reviews: [], evaluations: [], loop: [] });
      continue;
    }
    const r = runs.get(p.run ?? p.factoryRun);
    if (!r) continue;
    switch (e.type) {
      case "factory.station":
        r.stations[p.station] = { state: p.state, round: p.round, note: p.note };
        if (r.retrying?.station === p.station && p.state !== "active") r.retrying = undefined;
        r.spentUsd = p.spentUsd ?? r.spentUsd;
        r.maxUsd = p.maxUsd ?? r.maxUsd;
        if (p.station === "fix" && p.round) r.fixRounds = Math.max(r.fixRounds, p.round);
        break;
      case "factory.plan": r.plan = p.plan; r.dir = p.dir; break;
      case "factory.plan.gaps": (r.planGaps ??= []).push({ missing: p.missing ?? [], added: p.added !== false }); break;
      case "factory.council": r.council.push({ round: p.round, seats: p.seats, brief: p.brief }); break;
      case "factory.retro": r.retro = { outcome: p.outcome, reason: p.reason ?? "", spentUsd: p.spentUsd ?? 0, maxUsd: p.maxUsd ?? 0, minutes: p.minutes ?? 0, stages: p.stages ?? [], agents: p.agents ?? [], good: p.good ?? [], bad: p.bad ?? [] }; break;
      case "factory.evaluation": r.evaluations.push({ round: p.round, pass: !!p.pass, skipped: p.skipped, bar: p.bar ?? 4, screens: p.screens ?? 0, requirements: p.requirements ?? [], scores: p.scores ?? {}, problems: p.problems ?? [] }); break;
      case "factory.feature": {
        const f: FeatureView = { id: p.id, title: p.title, state: p.state, attempt: p.attempt ?? 1, index: p.index, of: p.of, passed: p.passed, failed: p.failed, files: p.files, broke: p.broke, crashed: p.crashed };
        const at = r.features.findIndex((x) => x.id === p.id);
        if (at >= 0) r.features[at] = f; else r.features.push(f);
        break;
      }
      case "factory.discovery": r.discovery.push({ round: p.round, docs: p.docs, critique: p.critique ?? null, pass: !!p.pass, bar: p.bar ?? 4, settled: p.settled }); break;
      case "factory.review": r.reviews.push({ round: p.round, agent: p.agent, verdict: p.verdict, findings: p.findings, criteria: p.criteria }); break;
      case "factory.attempt": r.loop.push({ kind: "attempt", at: e.ts, round: p.round, agent: p.agent, model: p.model, before: p.before, after: p.after, files: p.files ?? [], said: p.said ?? "", dispute: p.dispute, ladder: p.ladder }); break;
      case "factory.ladder": r.loop.push({ kind: "ladder", at: e.ts, from: p.from, to: p.to, reason: p.reason, round: p.round }); break;
      case "factory.tests.locked": if (p.relocked) r.loop.push({ kind: "relocked", at: e.ts, files: p.files ?? [], reason: p.reason ?? "" }); break;
      case "factory.tests.disputed": r.loop.push({ kind: "kept", at: e.ts, evidence: p.evidence ?? "", said: p.said ?? "" }); break;
      case "factory.tests": r.tests.push({ round: p.round, passed: p.passed, failed: p.failed, cases: p.cases }); break;
      case "factory.files":
        for (const w of p.written ?? []) {
          const f = r.files[w.path] ?? { lines: 0, writes: 0, last: "", locked: false };
          r.files[w.path] = { lines: w.lines, writes: f.writes + 1, last: p.station, locked: p.station === "tests" };
        }
        for (const x of p.refused ?? []) r.refused.push({ ...x, station: p.station });
        break;
      case "factory.visual": r.visuals.push({ station: p.station, round: p.round, pass: p.pass, items: p.items, missing: p.missing }); break;
      case "factory.gate":
        r.waiting = p.state === "waiting" ? { gate: p.gate, question: p.question, at: e.ts, action: p.action, kind: p.kind, station: p.station, attempt: p.attempt, error: p.error, same: p.same } : undefined;
        if (p.state === "approved" && p.kind === "retry" && p.station) r.retrying = { station: p.station, attempt: (p.attempt ?? 1) + 1, at: e.ts };
        break;
      case "factory.run.finished": r.finished = { outcome: p.outcome, reason: p.reason, totalUsd: p.totalUsd, agentCalls: p.agentCalls, sha: p.sha, resumable: !!p.resumable || /^The core restarted/.test(p.reason ?? "") }; r.waiting = undefined; r.retrying = undefined; if (p.totalUsd != null) r.spentUsd = p.totalUsd; break;
      case "factory.run.resumed":
        r.finished = undefined;
        r.resumed = { from: p.from, auto: !!p.auto, count: (r.resumed?.count ?? 0) + 1, at: e.ts };
        if (p.spentUsd != null) r.spentUsd = p.spentUsd;
        // Stations after the resume point start over: show them idle again, not as they were cut off.
        for (const [k, v] of Object.entries(r.stations)) if (v.state === "active") r.stations[k] = { ...v, state: "idle", note: "cut off when the app closed" };
        break;
    }
  }
  return [...runs.values()];
}

export async function askOverseer(prompt: string, model: string, projectId?: number) {
  const r = await fetch(`${API}/api/agent/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt, model, projectId }) });
  return r.json();
}

/** Subscribe to the core's event stream and fold it into views. Everything on screen is derived from events. */
export function useFactory() {
  const [events, setEvents] = useState<SfEvent[]>([]);
  const [online, setOnline] = useState(false);
  const [runtime, setRuntime] = useState<string>("…");
  const [mode, setMode] = useState<CrewMode | null>(null);
  const settingsAt = events.filter((e) => e.type === "settings.changed").at(-1)?.id ?? 0;

  // Which crew is working: asked again whenever the core reconnects or a setting changes.
  useEffect(() => {
    if (!online) return;
    let closed = false;
    fetch(`${API}/api/health`).then((r) => r.json()).then((h) => { if (!closed) { setRuntime(h.runtime); setMode(h.mode ?? (h.runtime === "mock" ? "practice" : "real")); } }).catch(() => {});
    return () => { closed = true; };
  }, [online, settingsAt]);

  useEffect(() => {
    let closed = false;
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
        byId.set(e.id, { runId: e.id, agent: e.payload.agent, station: e.payload.station, factoryRun: e.payload.factoryRun, projectId: e.payload.projectId, bayTest: !!e.payload.bayTest, prompt: e.payload.prompt, model: e.payload.model, startedAt: e.ts, state: "running" });
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
  return { events, signals, runs, factoryRuns, online, runtime, mode, totalUsd };
}

// ---- Order Engine (milestone 3) ----

export type FragmentKind = "idea" | "rule" | "decision" | "question" | "task" | "note" | "noise";
export interface OrderNode { id: number; kind: "project" | "idea" | "thread"; title: string; parentId: number | null; createdAt: string; signalId: number | null; by: string; mergedInto?: number; lastActive: string }
export interface Fragment {
  id: number; signalId: number; ts: string; text: string; kind: FragmentKind; nodeId: number | null; suggestedNodeId: number | null; alternatives?: number[];
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

export async function post(path: string, body: unknown = {}) {
  const r = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error ?? "request failed"), { data: j });
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

// ---- Agent Bay (milestone 4) ----

export const SLOTS = ["council", "design", "critique", "plan", "tests", "build", "review", "evaluate", "fix", "order", "overseer", "improve", "map", "survey"] as const;
export type Slot = (typeof SLOTS)[number];
export const SLOT_LABEL: Record<Slot, string> = { council: "Council", design: "Product design", critique: "Design critic", plan: "Spec and plan", tests: "Acceptance tests", build: "Build", review: "Review", evaluate: "Product judge", fix: "Fix", order: "Order Engine", overseer: "Assistant", improve: "Improvement Council", map: "Code map", survey: "Code survey" };
export interface AgentDef { id: string; name: string; avatar: string; description: string; station: Slot | "none"; model: string; budgetUsd: number; plugins: string[]; skills: string[]; tools: string[]; mcp?: string[]; sample: string; prompt: string }
/** What an agent's settings can choose from (core: bay/kits.ts). */
export interface BayLibrary { skills: { name: string; description: string; source: "bundled" | "yours" }[]; tools: { name: string; note: string }[]; mcp: { name: string; command: string; note?: string; source?: "bundled" | "yours" }[]; mcpFile: string | null }
export interface AgentView { def: AgentDef; version: number; builtin: boolean; retired: boolean; createdAt: string; updatedAt: string; versions: { version: number; ts: string; note: string; by: string }[] }
export interface BayTest { id: number; ts: string; agent: string; version: number; station: string; task: string; state: "running" | "done"; pass?: boolean; checks?: { label: string; pass: boolean }[]; output?: string; error?: string; costUsd?: number }
export interface AgentStats {
  calls: number; failed: number; costUsd: number; avgUsd: number; verdicts: { pass: number; total: number }; passRate: number | null;
  runs: number; avgRounds: number | null; lastAt: string | null; state: "idle" | "thinking" | "blocked"; current?: string;
  byVersion: Record<number, { calls: number; costUsd: number; pass: number; total: number }>;
  cache?: { read: number; write: number; input: number; hitRate: number | null };
}
export interface BayState {
  agents: AgentView[]; slots: Record<Slot, string[]>; seats: Record<Slot, number>; tests: BayTest[]; stats: Record<string, AgentStats>;
  visuals: { id: number; ts: string; scope: string; pass: boolean; items: string[]; missing: string[] }[]; models: string[];
  library?: BayLibrary;
}
const EMPTY_BAY: BayState = { agents: [], slots: {} as Record<Slot, string[]>, seats: {} as Record<Slot, number>, tests: [], stats: {}, visuals: [], models: ["haiku", "sonnet", "opus"] };

export const bayApi = {
  create: (def: Partial<AgentDef>) => post(`/api/bay/agents`, def) as Promise<AgentView>,
  save: (id: string, def: Partial<AgentDef>, expectVersion: number, note?: string) => post(`/api/bay/agents/${id}/save`, { def, expectVersion, note }) as Promise<AgentView>,
  clone: (id: string, name?: string) => post(`/api/bay/agents/${id}/clone`, { name }) as Promise<AgentView>,
  rollback: (id: string, version: number) => post(`/api/bay/agents/${id}/rollback`, { version }) as Promise<AgentView>,
  retire: (id: string, retired = true) => post(`/api/bay/agents/${id}/retire`, { retired }),
  test: (id: string, task?: string) => post(`/api/bay/agents/${id}/test`, { task }) as Promise<BayTest>,
  assign: (slot: Slot, agents: string[]) => post(`/api/bay/slots/${slot}`, { agents }),
  draft: (description: string) => post(`/api/bay/draft`, { description }) as Promise<AgentView>,
  importFile: (text: string) => post(`/api/bay/import`, { text }) as Promise<AgentView>,
  version: async (id: string, version: number) => (await fetch(`${API}/api/bay/agents/${id}/versions/${version}`)).json() as Promise<{ version: number; def: AgentDef; note: string }>,
  fileUrl: (id: string, version?: number) => `${API}/api/bay/agents/${id}/file${version ? `?version=${version}` : ""}`,
};

/** The Bay's state is folded by the core; refetch whenever a Bay event or an agent call lands, so crew cards stay live. */
export function useBay(events: SfEvent[]) {
  const [state, setState] = useState<BayState>(EMPTY_BAY);
  const lastId = events.filter((e) => e.type.startsWith("bay.") || e.type.startsWith("agent.")).at(-1)?.id ?? 0;
  useEffect(() => {
    let stop = false;
    const t = setTimeout(() => {
      fetch(`${API}/api/bay/state`).then((r) => r.json()).then((s: BayState) => { if (!stop) setState(s); }).catch(() => {});
    }, 150);
    return () => { stop = true; clearTimeout(t); };
  }, [lastId]);
  return state;
}

// ---- Setup, drop folder, "since you left" (milestone 5) ----

export type CrewMode = "practice" | "real";
export interface ToolCheck { found: boolean; path?: string; version?: string; hint: string }
export interface DropView { id: number; ts: string; file: string; bytes: number; signalId: number | null; status: "filed" | "skipped"; note?: string }
export interface SetupView {
  mode: CrewMode; runtime: string; node: { version: string; ok: boolean; path: string }; claude: ToolCheck; git: ToolCheck;
  realReady: boolean; blocker?: string; paths: { data: string; projects: string; drop: string }; drops: DropView[];
}
export interface SinceView { fromEvent: number; toEvent: number; leftAt: string | null; awayMinutes: number; lines: { kind: string; text: string; ref?: number }[] }

export const setupApi = {
  get: async (fresh = false) => (await fetch(`${API}/api/setup${fresh ? "?fresh=1" : ""}`)).json() as Promise<SetupView>,
  mode: (mode: CrewMode) => post(`/api/setup/mode`, { mode }) as Promise<SetupView>,
  drop: (dir: string) => post(`/api/setup/drop`, { dir }) as Promise<{ dir: string }>,
  scanDrop: () => post(`/api/setup/drop/scan`) as Promise<{ drops: DropView[] }>,
  open: (target: "projects" | "drop" | "data" | "run", run?: number) => post(`/api/open`, { target, run }) as Promise<{ dir: string }>,
  since: async () => (await fetch(`${API}/api/since`)).json() as Promise<SinceView>,
  // keepalive: this is sent as the window hides or closes.
  seen: (eventId: number) => fetch(`${API}/api/presence`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventId }), keepalive: true }).catch(() => {}),
};

/** The desktop shell's own commands (core process status, restart). Absent in a plain browser. */
export async function shell<T>(cmd: string): Promise<T | null> {
  const t = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (c: string, a?: unknown) => Promise<T> } }).__TAURI_INTERNALS__;
  if (!t) return null;
  try { return await t.invoke(cmd); } catch { return null; }
}
export interface CoreStatus { running: boolean; error: string | null; node: string; entry: string; log: string; logTail: string; dataDir: string; bundledNode: boolean }

/** The Overseer may end a reply with "BUILD: <idea>"; that line becomes a Build button. */
export function splitBuild(text: string): { text: string; build?: string } {
  const m = text.match(/^\s*BUILD:\s*(.+?)\s*$/m);
  return m ? { text: text.replace(m[0], "").trim(), build: m[1] } : { text };
}

// ---- Projects ----
export type ProjectStatus = "active" | "paused" | "shipped" | "archived";
export const PROJECT_STATUSES: ProjectStatus[] = ["active", "paused", "shipped", "archived"];
export const PROJECT_KINDS = ["app", "tool", "library", "research", "general"];
export interface ProjectRollup {
  runs: number; shipped: number; failed: number; running: number; agentCalls: number; spendUsd: number;
  nodes: number; fragments: number; important: number; openConflicts: number; linked: Record<string, number>; lastActive: string;
}
export interface ProjectSummary {
  id: number; name: string; kind: string; status: ProjectStatus; summary: string; origin: "you" | "factory" | "order";
  createdAt: string; updatedAt: string; rollup: ProjectRollup;
}
export interface ProjectLink { projectId: number; kind: string; ref: string; ts: string }
export interface ProjectDetail extends ProjectSummary {
  links: ProjectLink[]; nodeIds: number[]; rootNodeIds: number[]; runIds: number[]; runs: Record<string, any>[];
  agents: { agent: string; calls: number; costUsd: number; lastAt: string }[];
  artifacts: { files: number; bytes: number }; facets: Record<string, unknown>;
}

export const projectsApi = {
  list: async () => { const r = await fetch(`${API}/api/projects`); if (!r.ok) throw new Error("could not list projects"); return (await r.json()) as ProjectSummary[]; },
  get: async (id: number) => { const r = await fetch(`${API}/api/projects/${id}`); const j = await r.json(); if (!r.ok) throw new Error(j.error ?? "no such project"); return j as ProjectDetail; },
  create: (name: string, kind?: string, summary?: string) => post(`/api/projects`, { name, kind, summary }) as Promise<ProjectDetail>,
  update: (id: number, patch: Partial<Pick<ProjectSummary, "name" | "kind" | "summary" | "status">>) => post(`/api/projects/${id}`, patch) as Promise<ProjectDetail>,
  link: (id: number, kind: string, ref: string | number) => post(`/api/projects/${id}/links`, { kind, ref: String(ref) }) as Promise<ProjectDetail>,
  unlink: (id: number, kind: string, ref: string | number) => post(`/api/projects/${id}/unlink`, { kind, ref: String(ref) }) as Promise<ProjectDetail>,
  /** onTop: add the idea to the app this project already shipped (next version, same folder and data) instead of a new app. */
  build: (id: number, idea: string, maxUsd?: number, again?: boolean, onTop?: boolean) => post(`/api/projects/${id}/runs`, { idea, maxUsd, ...(again ? { again } : {}), ...(onTop ? { onTop } : {}) }) as Promise<{ run: number; projectId: number }>,
  /** Move everything of this project into another; this one goes away (archived if you made it). */
  merge: (id: number, into: number) => post(`/api/projects/${id}/merge`, { into }) as Promise<ProjectDetail>,
};

/** Events that can change a project's list or numbers. */
const PROJECT_EVENT = (t: string) => t.startsWith("project.") || t.startsWith("integration.") || t.startsWith("order.") || t.startsWith("factory.run.") || t === "agent.run.completed" || t === "launch.started" || t === "launch.exited";

/** Every project with its rollup, refetched (debounced) when something that changes them lands. */
export function useProjects(events: SfEvent[], online: boolean) {
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const at = events.filter((e) => PROJECT_EVENT(e.type) || e.type.includes(".linked")).at(-1)?.id ?? 0;
  useEffect(() => {
    if (!online) return;
    let stop = false;
    const t = setTimeout(() => {
      projectsApi.list().then((l) => { if (!stop) { setList(l); setErr(null); } }).catch((x) => { if (!stop) setErr((x as Error).message); });
    }, 150);
    return () => { stop = true; clearTimeout(t); };
  }, [at, online]);
  return { list, err };
}

/** One project's detail, refetched when its numbers may have changed. */
export function useProject(id: number | null, events: SfEvent[], online: boolean) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const at = events.filter((e) => PROJECT_EVENT(e.type) || e.type.includes(".linked")).at(-1)?.id ?? 0;
  useEffect(() => { setDetail(null); setErr(null); }, [id]);
  useEffect(() => {
    if (!online || id == null) return;
    let stop = false;
    const t = setTimeout(() => {
      projectsApi.get(id).then((d) => { if (!stop) { setDetail(d); setErr(null); } }).catch((x) => { if (!stop) setErr((x as Error).message); });
    }, 150);
    return () => { stop = true; clearTimeout(t); };
  }, [id, at, online]);
  return { detail, err };
}

/** Narrow the Order Engine's state to one project's nodes (and the unsorted notes it is the best guess for). */
export function orderFor(order: OrderState & { arrivals?: Record<number, number> }, nodeIds: number[]): OrderState & { arrivals: Record<number, number> } {
  const ids = new Set(nodeIds);
  const fragments = order.fragments.filter((f) => (f.nodeId != null ? ids.has(f.nodeId) : f.suggestedNodeId != null && ids.has(f.suggestedNodeId)));
  const fids = new Set(fragments.map((f) => f.id));
  return {
    ...order,
    arrivals: order.arrivals ?? {},
    nodes: order.nodes.filter((n) => ids.has(n.id)),
    fragments,
    conflicts: order.conflicts.filter((c) => (c.nodeId != null && ids.has(c.nodeId)) || fids.has(c.a) || fids.has(c.b)),
    sweeps: order.sweeps.filter((s) => (s.nodeId != null && ids.has(s.nodeId)) || (s.fragmentId != null && fids.has(s.fragmentId))),
    visuals: order.visuals,
    canon: Object.fromEntries(Object.entries(order.canon).filter(([k]) => ids.has(Number(k)))),
  };
}

// ---- Run tab: start finished projects from their own folders ----
export type RunKind = "web" | "static" | "cli" | "program";
export interface UsageField { id: string; label: string; kind: "positional" | "flag" | "option"; type: "folder" | "file" | "number" | "text" | "switch"; required: boolean; flag?: string; suggestions?: string[]; hint?: string }
export interface UsageExample { label: string; argv: string[]; stdin?: string; note?: string }
export interface UsageView { summary: string | null; synopsis: string | null; fields: UsageField[]; examples: UsageExample[]; readsStdin: boolean; sources: string[] }
export interface RunProfileView { id: string; kind: RunKind; label: string; command: string; root?: string; args: boolean; recommended?: boolean; note?: string; utility?: boolean; usage?: UsageView }
export interface BrowseView { path: string; parent: string | null; home: string; roots: string[]; entries: { name: string; path: string; dir: boolean; size?: number }[]; error: string | null }
export interface ProjectFolderView {
  dir: string; source: "folder" | "import" | "run"; label: string; ref?: number; exists: boolean;
  /** For builds: what was built, the idea it came from, whether it is the project's own build line, and what it is. */
  name?: string; summary?: string; idea?: string; own?: boolean; app?: "kit" | "page" | "other";
}
export type LaunchState = "starting" | "running" | "serving" | "exited" | "stopped" | "failed";
export interface LaunchSession {
  id: number; projectId: number; profileId: string; kind: RunKind; label: string; command: string; args: string | null; dir: string; root: string | null;
  mode: "inline" | "window"; state: LaunchState; port: number | null; url: string | null; startedAt: string; endedAt: string | null; exitCode: number | null;
  pid: number | null; stdinOpen: boolean; lines: number;
}
export interface OutputLine { n: number; ts: string; stream: "out" | "err" | "in" | "sys"; text: string }
export interface LaunchInfo { projectId: number; folders: ProjectFolderView[]; dir: string | null; exists: boolean; stack: string[]; profiles: RunProfileView[]; sessions: LaunchSession[]; running: LaunchSession[] }

export interface DataFileView { path: string; kind: "table" | "json" | "text"; bytes: number; modified: string; role: "sample" | "data" | "fixture" | "doc" | "file"; note?: string }
export interface MadeSample { path: string; kind: DataFileView["kind"]; from: string }
const qs = (o: Record<string, string | null | undefined>) => { const e = Object.entries(o).filter(([, v]) => v); return e.length ? "?" + e.map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&") : ""; };
async function getJson(path: string, what: string) {
  const r = await fetch(`${API}${path}`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? what);
  return j;
}

export const launchApi = {
  /** One press: the best way to run it, on sample data made for it if it needs a file. */
  go: (id: number, dir?: string | null, profileId?: string) => post(`/api/launch/projects/${id}/go`, { dir: dir ?? undefined, profileId }) as Promise<{ session: LaunchSession; why: string; made: MadeSample[] }>,
  files: (id: number, dir?: string | null) => getJson(`/api/launch/projects/${id}/files${qs({ dir })}`, "could not list its files") as Promise<{ dir: string; files: DataFileView[] }>,
  file: (id: number, path: string, dir?: string | null) => getJson(`/api/launch/projects/${id}/files${qs({ dir, path })}`, "could not open that file") as Promise<{ path: string; kind: DataFileView["kind"]; content: string; bytes: number }>,
  saveFile: (id: number, path: string, content: string, dir?: string | null, create = false) => post(`/api/launch/projects/${id}/files`, { dir: dir ?? undefined, path, content, create }) as Promise<{ files: DataFileView[] }>,
  deleteFile: (id: number, path: string, dir?: string | null) => post(`/api/launch/projects/${id}/files`, { dir: dir ?? undefined, path, delete: true }) as Promise<{ files: DataFileView[] }>,
  renameFile: (id: number, from: string, to: string, dir?: string | null) => post(`/api/launch/projects/${id}/files`, { dir: dir ?? undefined, from, to }) as Promise<{ files: DataFileView[] }>,
  samples: (id: number, dir?: string | null, want?: DataFileView["kind"]) => post(`/api/launch/projects/${id}/samples`, { dir: dir ?? undefined, want }) as Promise<{ made: MadeSample[]; files: DataFileView[] }>,
  info: async (id: number, dir?: string | null) => {
    const r = await fetch(`${API}/api/launch/projects/${id}${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? "could not read the project folder");
    return j as LaunchInfo;
  },
  start: (id: number, body: { profileId: string; args?: string; argv?: string[]; stdin?: string; dir?: string; mode?: "inline" | "window" }) => post(`/api/launch/projects/${id}/start`, body) as Promise<LaunchSession>,
  stop: (sid: number) => post(`/api/launch/sessions/${sid}/stop`) as Promise<LaunchSession>,
  input: (sid: number, text: string | null) => post(`/api/launch/sessions/${sid}/input`, text == null ? { end: true } : { text }),
  session: async (sid: number) => {
    const r = await fetch(`${API}/api/launch/sessions/${sid}`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? "no such session");
    return j as { session: LaunchSession; lines: OutputLine[]; dropped: number };
  },
  addFolder: (id: number, dir: string) => post(`/api/launch/projects/${id}/folder`, { dir }),
  terminal: (id: number, dir?: string | null) => post(`/api/launch/projects/${id}/terminal`, { dir: dir ?? undefined }),
  open: (url: string) => post(`/api/launch/open`, { url }),
  browse: async (path?: string | null) => {
    const r = await fetch(`${API}/api/launch/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? "could not read that folder");
    return j as BrowseView;
  },
};

// ---- Project chats ----

/** Where messages live beyond what they carry themselves: see packages/core/src/chat/routes.ts. */
export interface ChatRoutes { filed: Record<number, number[]>; factoryRuns: Record<number, number> }

/** The chat routes, refetched (debounced) when a Signal is filed or a project or run changes. */
export function useChatRoutes(events: SfEvent[], online: boolean) {
  const [routes, setRoutes] = useState<ChatRoutes>({ filed: {}, factoryRuns: {} });
  const at = events.filter((e) => e.type === "signal.captured" || PROJECT_EVENT(e.type)).at(-1)?.id ?? 0;
  useEffect(() => {
    if (!online) return;
    let stop = false;
    const t = setTimeout(() => {
      fetch(`${API}/api/chat/routes`).then((r) => (r.ok ? r.json() : null)).then((j) => { if (!stop && j) setRoutes(j); }).catch(() => {});
    }, 250);
    return () => { stop = true; clearTimeout(t); };
  }, [at, online]);
  return routes;
}
