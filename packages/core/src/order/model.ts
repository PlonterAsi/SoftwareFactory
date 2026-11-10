import type { SfEvent } from "../events.js";

/**
 * The Order Engine's model. Everything here is folded from the event log, so
 * history, replay and undo come for free: nothing is edited in place and raw
 * Signals are never touched.
 *
 *   Signal (raw, immutable) → Fragments (one atomic piece each) → filed under a Node
 *   Node: project ▸ idea ▸ thread (ideas can spawn child ideas)
 *   Canon of a node: its live rule and decision Fragments plus its ancestors',
 *   ranked by plain code (see precedence), never rewritten by a model.
 */
export type FragmentKind = "idea" | "rule" | "decision" | "question" | "task" | "note" | "noise";
export type NodeKind = "project" | "idea" | "thread";
export type FragmentState = "live" | "superseded" | "faded";

export interface OrderNode {
  id: number;
  kind: NodeKind;
  title: string;
  parentId: number | null;
  createdAt: string;
  signalId: number | null;
  by: string;
  /** When another node absorbed this one (an accepted merge). */
  mergedInto?: number;
  lastActive: string;
}

export interface Fragment {
  id: number;
  signalId: number;
  ts: string;
  text: string;
  kind: FragmentKind;
  /** null: in the Unsorted tray. */
  nodeId: number | null;
  /** Where the Archivist would put it when it was not sure enough to file it. */
  suggestedNodeId: number | null;
  confidence: number;
  /** Marked by its wording ("important", "must", "never") or pinned by you. */
  important: boolean;
  pinned: boolean;
  /** explicit: your own words. inferred: an agent proposed it. */
  origin: "explicit" | "inferred";
  by: string;
  state: FragmentState;
  supersededBy?: number;
  lastTouched: string;
}

export interface Conflict {
  id: number;
  ts: string;
  a: number;
  b: number;
  nodeId: number | null;
  reason: string;
  detectedBy: string;
  status: "open" | "resolved";
  winner?: number;
  loser?: number;
  rule?: string;
  effect?: "supersede" | "scoped" | "keep-both";
  by?: string;
  /** The engine's proposed answer for an open card. */
  proposal?: { winner: number; rule: string; why: string };
}

export type SweepAction = "fade" | "raise" | "digest" | "merge-proposal" | "merge";

export interface SweepItem {
  id: number;
  ts: string;
  action: SweepAction;
  fragmentId?: number;
  nodeId?: number;
  intoNodeId?: number;
  moved?: { fragmentId: number; from: number | null }[];
  summary?: string;
  reason: string;
  undone: boolean;
}

export interface IngestRecord {
  signalId: number;
  ts: string;
  mode: "agent" | "heuristic";
  state: "started" | "done";
  costUsd: number;
  fragments: number[];
  note?: string;
}

export interface Briefing { id: number; ts: string; lines: { kind: string; text: string; ref?: number }[] }

export interface VisualCheck { id: number; signalId: number | null; scope: string; pass: boolean; items: string[]; missing: string[] }

export interface OrderState {
  nodes: OrderNode[];
  fragments: Fragment[];
  conflicts: Conflict[];
  sweeps: SweepItem[];
  ingests: IngestRecord[];
  briefings: Briefing[];
  visuals: VisualCheck[];
  signals: Record<number, { ts: string; text: string; source: string }>;
}

export const ORDER_EVENT_PREFIX = "order.";

/** Fold the event log into the Order Engine's state. */
export function foldOrder(events: SfEvent[]): OrderState {
  const nodes = new Map<number, OrderNode>();
  const frags = new Map<number, Fragment>();
  const conflicts = new Map<number, Conflict>();
  const sweeps = new Map<number, SweepItem>();
  const ingests = new Map<number, IngestRecord>();
  const briefings: Briefing[] = [];
  const visuals: VisualCheck[] = [];
  const signals: OrderState["signals"] = {};

  const touchNode = (id: number | null | undefined, ts: string) => {
    let n = id != null ? nodes.get(id) : undefined;
    while (n) { if (ts > n.lastActive) n.lastActive = ts; n = n.parentId != null ? nodes.get(n.parentId) : undefined; }
  };
  const applySweep = (s: SweepItem, undo: boolean) => {
    if (s.action === "fade" && s.fragmentId != null) {
      const f = frags.get(s.fragmentId);
      if (f && (undo ? f.state === "faded" : f.state === "live")) f.state = undo ? "live" : "faded";
    }
    if (s.action === "merge" && s.nodeId != null) {
      const n = nodes.get(s.nodeId);
      if (n) n.mergedInto = undo ? undefined : s.intoNodeId;
      for (const m of s.moved ?? []) {
        const f = frags.get(m.fragmentId);
        if (f) f.nodeId = undo ? m.from : s.intoNodeId ?? f.nodeId;
      }
      // Child nodes follow their parent into the merge target.
      for (const c of nodes.values()) {
        if (!undo && c.parentId === s.nodeId) { c.parentId = s.intoNodeId ?? c.parentId; (c as any)._mergedFrom = s.nodeId; }
        if (undo && (c as any)._mergedFrom === s.nodeId) { c.parentId = s.nodeId; delete (c as any)._mergedFrom; }
      }
    }
  };

  for (const e of events) {
    const p = e.payload as any;
    switch (e.type) {
      case "signal.captured":
        signals[e.id] = { ts: e.ts, text: p.text, source: p.source };
        break;
      case "order.node":
        nodes.set(e.id, { id: e.id, kind: p.kind, title: p.title, parentId: p.parentId ?? null, createdAt: e.ts, signalId: p.signalId ?? null, by: p.by ?? "archivist", lastActive: e.ts });
        break;
      case "order.fragment":
        frags.set(e.id, {
          id: e.id, signalId: p.signalId, ts: e.ts, text: p.text, kind: p.kind, nodeId: p.nodeId ?? null, suggestedNodeId: p.suggestedNodeId ?? null,
          confidence: p.confidence ?? 0, important: !!p.important, pinned: false, origin: p.origin ?? "explicit", by: p.by ?? "archivist", state: "live", lastTouched: e.ts,
        });
        touchNode(p.nodeId, e.ts);
        break;
      case "order.fragment.moved": {
        const f = frags.get(p.fragmentId);
        if (f) { f.nodeId = p.nodeId ?? null; f.confidence = 1; f.lastTouched = e.ts; touchNode(f.nodeId, e.ts); }
        break;
      }
      case "order.fragment.pinned": {
        const f = frags.get(p.fragmentId);
        if (f) { f.pinned = !!p.pinned; f.lastTouched = e.ts; if (f.pinned && f.state === "faded") f.state = "live"; }
        break;
      }
      case "order.conflict":
        conflicts.set(e.id, { id: e.id, ts: e.ts, a: p.a, b: p.b, nodeId: p.nodeId ?? null, reason: p.reason, detectedBy: p.detectedBy, status: "open", proposal: p.proposal });
        break;
      case "order.conflict.resolved": {
        const c = conflicts.get(p.conflictId);
        if (!c) break;
        // A later answer replaces an earlier one: bring the old loser back first.
        if (c.status === "resolved" && c.effect === "supersede" && c.loser != null) {
          const old = frags.get(c.loser);
          if (old && old.state === "superseded" && old.supersededBy === c.winner) { old.state = "live"; old.supersededBy = undefined; }
        }
        Object.assign(c, { status: "resolved", winner: p.winner, loser: p.loser, rule: p.rule, effect: p.effect, by: p.by });
        if (p.effect === "supersede") {
          const l = frags.get(p.loser);
          if (l) { l.state = "superseded"; l.supersededBy = p.winner; }
        }
        break;
      }
      case "order.sweep": {
        const s: SweepItem = { id: e.id, ts: e.ts, action: p.action, fragmentId: p.fragmentId, nodeId: p.nodeId, intoNodeId: p.intoNodeId, moved: p.moved, summary: p.summary, reason: p.reason, undone: false };
        sweeps.set(e.id, s);
        applySweep(s, false);
        break;
      }
      case "order.sweep.undone": {
        const s = sweeps.get(p.sweepId);
        if (s && !s.undone) { s.undone = true; applySweep(s, true); }
        break;
      }
      case "order.ingest": {
        const r: IngestRecord = ingests.get(p.signalId) ?? { signalId: p.signalId, ts: e.ts, mode: p.mode, state: p.state, costUsd: 0, fragments: [] };
        Object.assign(r, { mode: p.mode, state: p.state, costUsd: p.costUsd ?? r.costUsd, fragments: p.fragments ?? r.fragments, note: p.note ?? r.note });
        ingests.set(p.signalId, r);
        break;
      }
      case "order.briefing":
        briefings.push({ id: e.id, ts: e.ts, lines: p.lines });
        break;
      case "order.visual":
        visuals.push({ id: e.id, signalId: p.signalId ?? null, scope: p.scope, pass: p.pass, items: p.items, missing: p.missing });
        break;
    }
  }
  return {
    nodes: [...nodes.values()], fragments: [...frags.values()], conflicts: [...conflicts.values()], sweeps: [...sweeps.values()],
    ingests: [...ingests.values()], briefings, visuals, signals,
  };
}

/** A node and every ancestor, nearest first. */
export function lineage(state: Pick<OrderState, "nodes">, nodeId: number | null): OrderNode[] {
  const byId = new Map(state.nodes.map((n) => [n.id, n]));
  const out: OrderNode[] = [];
  let n = nodeId != null ? byId.get(nodeId) : undefined;
  const seen = new Set<number>();
  while (n && !seen.has(n.id)) { out.push(n); seen.add(n.id); n = n.parentId != null ? byId.get(n.parentId) : undefined; }
  return out;
}

export function depth(state: Pick<OrderState, "nodes">, nodeId: number | null): number {
  return lineage(state, nodeId).length;
}

/** Every node below this one. */
export function descendants(state: Pick<OrderState, "nodes">, nodeId: number): number[] {
  const out: number[] = [];
  const walk = (id: number) => { for (const n of state.nodes) if (n.parentId === id && !out.includes(n.id)) { out.push(n.id); walk(n.id); } };
  walk(nodeId);
  return out;
}

export const isCanonKind = (k: FragmentKind) => k === "rule" || k === "decision";

export interface CanonEntry { fragment: Fragment; inheritedFrom: number | null; rank: number }

/**
 * The Canon of a node: live rules and decisions on it and its ancestors.
 * A more specific rule that won a conflict hides the general one here only
 * (the general rule still holds everywhere else). Ranked in plain code:
 * your words, then the more specific node, then important, then newer.
 */
export function canonFor(state: OrderState, nodeId: number): CanonEntry[] {
  const line = lineage(state, nodeId);
  const lineIds = line.map((n) => n.id);
  const hidden = new Set<number>();
  for (const c of state.conflicts) {
    if (c.status !== "resolved" || c.effect !== "scoped" || c.winner == null || c.loser == null) continue;
    const w = state.fragments.find((f) => f.id === c.winner);
    if (w?.nodeId != null && lineIds.includes(w.nodeId)) hidden.add(c.loser);
  }
  const entries: CanonEntry[] = [];
  for (const f of state.fragments) {
    if (f.state !== "live" || !isCanonKind(f.kind) || f.nodeId == null || hidden.has(f.id)) continue;
    const at = lineIds.indexOf(f.nodeId);
    if (at < 0) continue;
    const rank = (f.origin === "explicit" ? 1000 : 0) + (100 - at * 10) + (f.important || f.pinned ? 5 : 0);
    entries.push({ fragment: f, inheritedFrom: at === 0 ? null : f.nodeId, rank });
  }
  return entries.sort((x, y) => y.rank - x.rank || y.fragment.ts.localeCompare(x.fragment.ts));
}

export interface Verdict { winner: number; loser: number; rule: string; effect: "supersede" | "scoped"; why: string }

/**
 * Conflict resolution order from the plan, as code:
 *  1. your explicit words beat anything an agent inferred;
 *  2. the more specific node beats the more general one (for that node only);
 *  3. newer beats older, when both are explicit and at the same level;
 *  4. important beats unmarked;
 *  5. still tied: null, and a conflict card asks you.
 * Two guards on rule 3, because both would change a goal, so the engine asks:
 * a newer, unmarked line never silently overrides a rule marked important or
 * pinned, and a marked rule on a project itself is never replaced without you.
 */
export function precedence(state: OrderState, a: Fragment, b: Fragment): Verdict | null {
  const pair = (w: Fragment, l: Fragment, rule: string, effect: Verdict["effect"], why: string): Verdict => ({ winner: w.id, loser: l.id, rule, effect, why });
  if (a.origin !== b.origin) {
    const [w, l] = a.origin === "explicit" ? [a, b] : [b, a];
    return pair(w, l, "explicit-over-inferred", "supersede", "Your own words beat a rule an agent inferred.");
  }
  const da = depth(state, a.nodeId), db = depth(state, b.nodeId);
  if (da !== db && a.nodeId !== b.nodeId) {
    const [w, l] = da > db ? [a, b] : [b, a];
    return pair(w, l, "specific-over-general", "scoped", "The rule on the more specific node wins there; the general rule still holds elsewhere.");
  }
  const markA = a.important || a.pinned, markB = b.important || b.pinned;
  if (a.signalId !== b.signalId) {
    const [w, l] = a.signalId > b.signalId ? [a, b] : [b, a];
    const wMark = w === a ? markA : markB, lMark = w === a ? markB : markA;
    if (lMark && !wMark) return null; // guard: ask before an unmarked line overrides a marked rule
    if (lMark && depth(state, l.nodeId) === 1) return null; // guard: replacing a marked project-level rule changes the project's goal, so ask
    return pair(w, l, "newer-over-older", "supersede", "Both are your words at the same level, so the newer one replaces the older.");
  }
  if (markA !== markB) {
    const [w, l] = markA ? [a, b] : [b, a];
    return pair(w, l, "important-over-unmarked", "supersede", "The rule marked important wins.");
  }
  return null;
}
