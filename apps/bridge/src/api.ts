import { useEffect, useMemo, useState } from "react";

/** Same shapes the core writes to its event log. */
export interface SfEvent { id: number; ts: string; type: string; payload: any }
export interface Signal { id: number; ts: string; text: string; source: string }
export interface AgentRunView {
  runId: number;
  agent: string;
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
        byId.set(e.id, { runId: e.id, agent: e.payload.agent, prompt: e.payload.prompt, model: e.payload.model, startedAt: e.ts, state: "running" });
      } else if (e.type === "agent.run.completed" && byId.has(e.payload.runId)) {
        Object.assign(byId.get(e.payload.runId)!, { state: "done", ...e.payload });
      } else if (e.type === "agent.run.failed" && byId.has(e.payload.runId)) {
        Object.assign(byId.get(e.payload.runId)!, { state: "failed", error: e.payload.error });
      }
    }
    return [...byId.values()];
  }, [events]);

  const totalUsd = runs.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  return { events, signals, runs, online, runtime, totalUsd };
}
