/** Pure mapper for the ticket Run map: station and PR nodes from the ticket detail. No React, no fetch. */
export const STATION_ORDER = ["intake", "council", "discover", "plan", "gateA", "tests", "build", "test", "fix", "review", "evaluate", "gateB", "ship"];
/** Run states that mean a gate is parked on the person (core writes 'waiting', runbase.ts). */
export const PARKED_STATES = ["waiting"];

export type MapStatus = "done" | "current" | "waiting" | "failed" | "stopped" | "notstarted";
export const STATUS_WORD: Record<MapStatus, string> = { done: "Done", current: "Current", waiting: "Waiting on you", failed: "Failed", stopped: "Stopped", notstarted: "Not started" };
export const STATUS_ICON: Record<MapStatus, string> = { done: "✓", current: "●", waiting: "⏸", failed: "✕", stopped: "■", notstarted: "○" };

export interface MapNode { key: string; label: string; status: MapStatus; word: string; icon: string; round: number | null; target: "run" | "merge" }
export interface MapHeader { runId: number | null; spentUsd: number | null }
export interface TicketMapData { header: MapHeader; nodes: MapNode[] }
export type MapCi = "passed" | "failed" | "running" | "none";

interface RunIn { id?: number; outcome?: string | null; station?: string | null; state?: string | null; spentUsd?: number | null }
interface MapInput {
  run?: RunIn | null;
  steps?: { step?: string }[] | null;
  pr?: { state?: string } | null;
  check?: { ci?: string; reasons?: { ok?: boolean }[] } | null;
}

/** MergeBox's words to the design's words; anything unknown is none. */
export function mapCi(ci: unknown): MapCi {
  return ci === "green" ? "passed" : ci === "red" ? "failed" : ci === "running" ? "running" : "none";
}

const node = (key: string, status: MapStatus, round: number | null, target: MapNode["target"]): MapNode =>
  ({ key, label: key, status, word: STATUS_WORD[status], icon: STATUS_ICON[status], round, target });

function stationStatus(run: RunIn | null | undefined, i: number, key: string): MapStatus {
  if (!run) return "notstarted";
  if (run.outcome === "shipped") return "done";
  const at = run.station ? STATION_ORDER.indexOf(run.station) : -1;
  if (at < 0 || i > at) return "notstarted";
  if (i < at) return "done";
  if (run.outcome === "stopped") return "stopped";
  if (run.outcome) return "failed";
  if ((key === "gateA" || key === "gateB") && PARKED_STATES.includes(run.state ?? "")) return "waiting";
  return "current";
}

function prStatus(state: string | undefined, check: MapInput["check"]): MapStatus {
  if (state === "merged") return "done";
  if (state === "closed") return "failed";
  if (state !== "open") return "notstarted";
  const ci = check ? mapCi(check.ci) : null;
  const lineFailed = !!check?.reasons?.some((r) => r?.ok === false);
  if (lineFailed || ci === "failed") return "failed";
  if (!check || ci === "running") return "current";
  return "waiting";
}

export function buildTicketMap(d: MapInput | null | undefined): TicketMapData {
  try {
    const run = d?.run ?? null;
    const steps = Array.isArray(d?.steps) ? d!.steps! : [];
    const header: MapHeader = { runId: run?.id ?? null, spentUsd: typeof run?.spentUsd === "number" ? run.spentUsd : null };
    const nodes: MapNode[] = run ? STATION_ORDER.map((s, i) => {
      const n = steps.filter((x) => x?.step === s).length;
      return node(s, stationStatus(run, i, s), n >= 2 ? n : null, "run");
    }) : [];
    if (run && d?.pr) nodes.push(node("PR", prStatus(d.pr.state, d.check), null, "merge"));
    return { header, nodes };
  } catch {
    return { header: { runId: null, spentUsd: null }, nodes: [] };
  }
}
