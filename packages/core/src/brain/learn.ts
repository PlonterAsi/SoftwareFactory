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
 * Change: the rules and decisions the person wrote (the Order Engine's Canon, their own words only)
 * are offered to the Brain. Adding one makes it a principle that keeps its source; "not for the
 * Brain" is remembered so it is not offered again. No agent call, no cost.
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

export interface BrainSuggestion { fragment: number; text: string; kind: "rule" | "decision"; node: string | null; important: boolean; ts: string; title: string }

/** Agents that make or judge the product: where one of the person's rules goes unless they pick otherwise. */
const RULE_STATIONS: Slot[] = ["council", "design", "critique", "plan", "build", "review", "evaluate", "fix"];

/** The rule without the label the person typed in front of it ("Rule: ...", "Decision: ..."). */
const bare = (text: string) => text.trim().replace(/^(rule|decision|important)\s*[:\-]\s*/i, "").trim();

function titleOf(text: string): string {
  const words = bare(text).replace(/\s+/g, " ").trim().replace(/[.;:,]+$/, "").split(" ");
  const t = words.slice(0, 9).join(" ").replace(/^./, (c) => c.toUpperCase());
  return (words.length > 9 ? `${t}…` : t).slice(0, 110);
}

/** The person's own live rules and decisions that are not in the Brain yet and were not turned away. Important ones first. */
export function brainSuggestions(log: EventLog, order: OrderState, list: PrincipleView[] = principles(log)): BrainSuggestion[] {
  const taken = new Set<number>(list.map((p) => p.source?.fragment).filter((x): x is number => x != null));
  for (const e of log.list({ type: "brain.principle.saved", limit: 1e6 })) { const f = (e.payload as { source?: { fragment?: number } }).source?.fragment; if (f != null) taken.add(f); }
  for (const e of log.list({ type: "brain.suggestion.dismissed", limit: 1e6 })) taken.add(Number((e.payload as { fragment: number }).fragment));
  const nodes = new Map(order.nodes.map((n) => [n.id, n.title]));
  return order.fragments
    .filter((f) => f.state === "live" && f.origin === "explicit" && isCanonKind(f.kind) && !taken.has(f.id) && f.text.trim().length >= 12)
    .sort((a, b) => Number(b.important || b.pinned) - Number(a.important || a.pinned) || b.ts.localeCompare(a.ts))
    .slice(0, 30)
    .map((f) => ({ fragment: f.id, text: bare(f.text), kind: f.kind as "rule" | "decision", node: f.nodeId != null ? nodes.get(f.nodeId) ?? null : null, important: f.important || f.pinned, ts: f.ts, title: titleOf(f.text) }));
}

/** Make one of the person's rules a principle. The rule's own words are the text unless others are given. */
export function acceptSuggestion(log: EventLog, order: OrderState, fragment: number, input: { title?: string; text?: string; stations?: string[] } = {}, by = "you"): string {
  const s = brainSuggestions(log, order).find((x) => x.fragment === fragment);
  if (!s) throw new Error("That rule is not waiting: it is already in the Brain, was turned away, or is no longer live.");
  const stations = (input.stations ?? []).filter((x) => (SLOTS as readonly string[]).includes(x));
  return savePrinciple(log, null, {
    title: input.title?.trim() || s.title, text: input.text?.trim() || s.text, stations: stations.length ? stations : RULE_STATIONS, enabled: true,
    note: `From your ${s.kind}${s.node ? ` on "${s.node}"` : ""}`, source: { kind: "rule", fragment, node: s.node ?? undefined },
  }, by);
}

export function dismissSuggestion(log: EventLog, order: OrderState, fragment: number, by = "you") {
  const s = brainSuggestions(log, order).find((x) => x.fragment === fragment);
  if (!s) throw new Error("That rule is not waiting.");
  log.append("brain.suggestion.dismissed", { fragment, text: s.text.slice(0, 200), by });
}
