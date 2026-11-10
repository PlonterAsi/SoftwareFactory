import type { EventLog, SfEvent } from "../events.js";
import type { StationId } from "./loop.js";

export interface VisualResult { pass: boolean; items: string[]; missing: string[] }

/**
 * visualizeEverything, as code. Before a station may pass, every kind of thing
 * it produced must have the event its Bridge view is drawn from
 * (skills/visualize-everything/SKILL.md has the table).
 */
export function visualCheck(log: EventLog, run: number, station: StationId, round?: number): VisualResult {
  const evs = log.list({ sinceId: run - 1, limit: 1e6 }).filter((e) => (e.payload as { run?: number; factoryRun?: number })?.run === run || (e.payload as { factoryRun?: number })?.factoryRun === run || e.id === run);
  const items: string[] = [];
  const missing: string[] = [];
  const need = (label: string, ok: boolean) => (ok ? items : missing).push(label);
  const of = (type: string, pred: (p: any) => boolean = () => true) => evs.filter((e: SfEvent) => e.type === type && pred(e.payload));
  const sameRound = (p: any) => round === undefined || p.round === round;

  need(`${station}: box on the factory floor`, of("factory.station", (p) => p.station === station && p.state === "active").length > 0);

  const agentStation = ({ plan: "plan", tests: "tests", build: "build", fix: "fix" } as Record<string, string>)[station];
  if (agentStation) {
    const started = log.list({ type: "agent.run.started", sinceId: run - 1, limit: 1e6 }).filter((e) => (e.payload as any).factoryRun === run && (e.payload as any).station === agentStation);
    const doneIds = new Set(log.list({ type: "agent.run.completed", sinceId: run - 1, limit: 1e6 }).map((e) => (e.payload as any).runId));
    need(`${station}: agent calls as timeline pulses (${started.length})`, started.length > 0 && started.every((s) => doneIds.has(s.id)));
  }
  if (station === "intake") need("idea: star on the star map", log.list({ type: "signal.captured", sinceId: run - 1, limit: 1e6 }).some((e) => (e.payload as any).source === "factory"));
  if (station === "plan") {
    const plan = of("factory.plan").at(-1)?.payload as any;
    need(`plan: task graph (${plan?.plan?.tasks?.length ?? 0} tasks)`, !!plan?.plan?.tasks?.length);
  }
  if (station === "tests" || station === "build" || station === "fix") {
    const files = of("factory.files", (p) => p.station === station && sameRound(p)).at(-1)?.payload as any;
    need(`${station}: files on the heat map (${files?.written?.length ?? 0})`, !!files?.written?.length);
  }
  if (station === "test" || station === "fix") {
    const t = of("factory.tests", (p) => p.round === (round ?? 0)).at(-1)?.payload as any;
    need(`tests: pass and fail grid (${t ? `${t.passed} pass, ${t.failed} fail` : "none"})`, !!t?.cases?.length);
  }
  return { pass: missing.length === 0, items, missing };
}
