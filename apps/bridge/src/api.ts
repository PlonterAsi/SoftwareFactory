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
