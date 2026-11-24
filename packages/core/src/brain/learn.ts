import type { EventLog } from "../events.js";
import { isCanonKind, type OrderState } from "../order/model.js";
import { principles, savePrinciple, type PrincipleView } from "./brain.js";
import { SLOTS, type Slot } from "../bay/agentfile.js";

/**
 * How the Brain shows it is alive, and how it changes without being typed into.
 *
 * Use: every agent call on a station reads the principles that name that station (bay.crewFor →
 * systemPromptFor), so the calls in `agent_runs` are the Brain's reads. Counted per principle from
 * the moment its current version was saved.
 *
 * (Offering the person's rules to the Brain was removed on 24 Nov 2026: none was ever added.)
 */
export interface PrincipleUse { reads: number; lastReadAt: string | null }
export interface BrainChange { id: number; ts: string; what: "saved" | "reset" | "dismissed"; principle: string | null; title: string; by: string; note?: string; fromRule: boolean }
export interface BrainUse {
  /** Agent calls that read at least one principle. */
  reads: number;
  lastReadAt: string | null;
  changes: number;
  lastChangeAt: string | null;
  byPrinciple: Record<string, PrincipleUse>;
  history: BrainChange[];
}

export function brainUse(log: EventLog, list: PrincipleView[] = principles(log)): BrainUse {
  const byPrinciple: Record<string, PrincipleUse> = {};
  const row = (stations: string[], since: string | null): PrincipleUse => {
    if (!stations.length) return { reads: 0, lastReadAt: null };
    try {
      const marks = stations.map(() => "?").join(",");
      const r = log.db.prepare(`SELECT count(*) AS n, max(started_at) AS last FROM agent_runs WHERE station IN (${marks})${since ? " AND started_at >= ?" : ""}`)
        .get(...stations, ...(since ? [since] : [])) as { n: number; last: string | null };
      return { reads: Number(r.n), lastReadAt: r.last ?? null };
    } catch { return { reads: 0, lastReadAt: null }; }
  };
  for (const p of list) byPrinciple[p.id] = p.enabled ? row(p.stations, p.updatedAt) : { reads: 0, lastReadAt: null };
  const all = row([...new Set(list.filter((p) => p.enabled).flatMap((p) => p.stations))], null);

  const titles = new Map(list.map((p) => [p.id, p.title]));
  const history: BrainChange[] = ["brain.principle.saved", "brain.principle.reset", "brain.suggestion.dismissed"]
    .flatMap((t) => log.list({ type: t, limit: 1e6 }))
    .sort((a, b) => b.id - a.id)
    .map((e) => {
      const p = e.payload as { id?: string; title?: string; by?: string; note?: string; source?: unknown; fragment?: number; text?: string };
      const what = e.type === "brain.principle.saved" ? "saved" as const : e.type === "brain.principle.reset" ? "reset" as const : "dismissed" as const;
      return { id: e.id, ts: e.ts, what, principle: p.id ?? null, title: p.title ?? (p.id ? titles.get(p.id) ?? p.id : String(p.text ?? "").slice(0, 80)), by: p.by ?? "you", note: p.note, fromRule: !!p.source };
    });
  return { reads: all.reads, lastReadAt: all.lastReadAt, changes: history.length, lastChangeAt: history[0]?.ts ?? null, byPrinciple, history: history.slice(0, 50) };
}


/** Agents that make or judge the product: where one of the person's rules goes unless they pick otherwise. */
const RULE_STATIONS: Slot[] = ["council", "design", "critique", "plan", "build", "review", "evaluate", "fix"];
