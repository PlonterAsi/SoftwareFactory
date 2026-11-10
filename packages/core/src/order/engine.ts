import type { EventLog, EventType } from "../events.js";
import type { AgentRuntime } from "../runtime.js";
import { runAgent } from "../agents.js";
import {
  canonFor, descendants, foldOrder, isCanonKind, lineage, precedence,
  type Conflict, type Fragment, type NodeKind, type OrderState,
} from "./model.js";
import { ARCHIVIST_ROLE, FILE_AT, archivistPrompt, heuristicArchivist, parseArchivistPlan, type ArchivistPlan } from "./archivist.js";
import { polarity, replacesCue, similarity, tokens } from "./text.js";

export interface OrderOptions {
  /** "agent": the Archivist agent files Signals (heuristics as fallback). "heuristic": free, no model calls. */
  mode?: "agent" | "heuristic";
  model?: string;
  /** Spend cap for one Archivist call, USD. */
  perCallUsd?: number;
  /** Spend cap for all Archivist calls in one day (UTC), USD. Past it the engine files with heuristics and says so. */
  maxUsd?: number;
  /** Non-pinned notes and ideas untouched this long fade from views. */
  fadeDays?: number;
  /** Open questions older than this are raised once in the briefing. */
  questionDays?: number;
  /** A node with this many live fragments since its last digest gets a digest. */
  digestAt?: number;
  now?: () => Date;
}

export interface IngestResult { signalId: number; mode: "agent" | "heuristic"; fragments: Fragment[]; conflicts: Conflict[]; costUsd: number; note?: string }

/**
 * The Order Engine: messy thinking in, order out.
 *
 * On every Signal: split → classify → route → emphasize → filter → check conflicts
 * → visualizeEverything. In the background: fade, raise old questions, digest,
 * propose merges, then one daily briefing. Every step is an event; sweeps can be
 * undone; nothing you said is ever deleted or rewritten.
 */
export class OrderEngine {
  readonly opts: Required<Omit<OrderOptions, "now">> & { now: () => Date };
  private queue: Promise<unknown> = Promise.resolve();
  private cache: { lastId: number; state: OrderState } | null = null;

  constructor(private log: EventLog, private runtime: AgentRuntime | null, opts: OrderOptions = {}) {
    this.opts = {
      mode: opts.mode ?? (runtime && runtime.name !== "mock" ? "agent" : "heuristic"),
      model: opts.model ?? "haiku",
      perCallUsd: opts.perCallUsd ?? 0.03,
      maxUsd: opts.maxUsd ?? 0.5,
      fadeDays: opts.fadeDays ?? 14,
      questionDays: opts.questionDays ?? 7,
      digestAt: opts.digestAt ?? 12,
      now: opts.now ?? (() => new Date()),
    };
    // An ingest cut off by a restart would show as "filing…" forever; close it honestly.
    for (const r of this.state().ingests) if (r.state === "started") this.emit("order.ingest", { signalId: r.signalId, mode: r.mode, state: "done", costUsd: r.costUsd, fragments: [], note: "The core restarted while this Signal was being filed. Re-file it from the Unsorted tray." });
  }

  /** Current state, folded from the log (cached until a new event lands). */
  state(): OrderState {
    const last = this.log.list({ sinceId: this.cache?.lastId ?? 0, limit: 1 });
    if (this.cache && !last.length) return this.cache.state;
    const all = this.log.list({ limit: 1e7 });
    const state = foldOrder(all);
    this.cache = { lastId: all.at(-1)?.id ?? 0, state };
    return state;
  }

  /** Archivist spend today (UTC); the daily cap applies to this. */
  spentUsd(): number {
    const day = this.opts.now().toISOString().slice(0, 10);
    return this.state().ingests.filter((r) => r.ts.startsWith(day)).reduce((s, r) => s + (r.costUsd || 0), 0);
  }

  private emit(type: EventType, payload: unknown) { return this.log.append(type, payload, this.opts.now().toISOString()); }

  /** File one Signal. Calls run one at a time, so the tree is always consistent. */
  ingest(signal: { id: number; text: string; source?: string }): Promise<IngestResult> {
    const next = this.queue.then(() => this.ingestNow(signal));
    this.queue = next.catch(() => {});
    return next;
  }

  /** Wait until every queued Signal is filed. */
  idle(): Promise<unknown> { return this.queue; }

  private async ingestNow(signal: { id: number; text: string; source?: string }): Promise<IngestResult> {
    let mode = this.opts.mode;
    let note: string | undefined;
    if (mode === "agent" && this.spentUsd() + this.opts.perCallUsd > this.opts.maxUsd) {
      mode = "heuristic";
      note = `Today's Archivist budget of $${this.opts.maxUsd.toFixed(2)} is spent, so this Signal was filed by heuristics.`;
    }
    this.emit("order.ingest", { signalId: signal.id, mode, state: "started" });
    let plan: ArchivistPlan | null = null;
    let costUsd = 0;
    if (mode === "agent" && this.runtime) {
      const st = this.state();
      const run = await runAgent(this.log, this.runtime, "archivist", {
        prompt: archivistPrompt(signal.text, st), systemPrompt: ARCHIVIST_ROLE, model: this.opts.model, budgetUsd: this.opts.perCallUsd,
      }, { station: "order" });
      costUsd = run.result?.costUsd ?? 0;
      try {
        if (run.error) throw new Error(run.error);
        plan = parseArchivistPlan(run.result!.text, this.state());
      } catch (e) {
        note = `The Archivist's answer could not be used (${(e as Error).message.slice(0, 160)}), so heuristics filed this Signal.`;
        mode = "heuristic";
      }
    }
    plan ??= heuristicArchivist(signal.text, this.state());
    const result = this.apply(signal, plan, mode === "agent" ? "archivist" : "heuristic");
    this.emit("order.ingest", { signalId: signal.id, mode, state: "done", costUsd, fragments: result.fragments.map((f) => f.id), note });
    return { ...result, signalId: signal.id, mode, costUsd, note };
  }

  /** Turn a checked proposal into events: nodes, fragments, conflicts, visual check. */
  private apply(signal: { id: number; source?: string }, plan: ArchivistPlan, by: string) {
    const origin = signal.source?.startsWith("agent") ? "inferred" : "explicit";
    const refs = new Map<string, number>();
    const resolve = (r: number | string | null): number | null => (r == null ? null : typeof r === "number" ? r : refs.get(r) ?? null);
    const newNodes: number[] = [];
    for (const n of plan.nodes) {
      const parent = n.kind === "project" ? null : resolve(n.parent);
      const st = this.state();
      const twin = st.nodes.find((x) => x.mergedInto == null && x.kind === n.kind && x.parentId === parent && similarity(x.title, n.title) >= 0.7);
      if (twin) { refs.set(n.ref, twin.id); continue; }
      const e = this.emit("order.node", { kind: n.kind, title: n.title, parentId: parent, signalId: signal.id, by });
      refs.set(n.ref, e.id);
      newNodes.push(e.id);
    }
    const ids: number[] = [];
    const hints = new Map<number, number[]>();
    for (const f of plan.fragments) {
      const target = resolve(f.node);
      const file = f.kind !== "noise" && f.confidence >= FILE_AT && target != null;
      const e = this.emit("order.fragment", {
        signalId: signal.id, text: f.text, kind: f.kind, nodeId: file ? target : null, suggestedNodeId: file ? null : target,
        confidence: Number(f.confidence.toFixed(2)), important: f.important, origin, by,
      });
      ids.push(e.id);
      if (f.contradicts.length) hints.set(e.id, f.contradicts);
    }
    const conflicts: Conflict[] = [];
    for (const id of ids) conflicts.push(...this.checkConflicts(id, hints.get(id) ?? [], by));
    const st = this.state();
    const fragments = st.fragments.filter((f) => ids.includes(f.id));
    this.visualCheck(signal.id, fragments, newNodes, conflicts.map((c) => c.id));
    return { fragments, conflicts: this.state().conflicts.filter((c) => conflicts.some((x) => x.id === c.id)) };
  }

  /**
   * Compare a new rule or decision with the closest Canon on its line of nodes
   * (ancestors, itself, descendants). Plain code finds clashes of polarity
   * ("never X" against "X") and replacements ("instead", "no longer"); the
   * agent Archivist can add clashes of meaning. Precedence then decides, or a
   * conflict card asks.
   */
  private checkConflicts(fragmentId: number, hinted: number[], by: string): Conflict[] {
    const st = this.state();
    const f = st.fragments.find((x) => x.id === fragmentId);
    if (!f || f.nodeId == null || !isCanonKind(f.kind)) return [];
    const scope = new Set([...lineage(st, f.nodeId).map((n) => n.id), ...descendants(st, f.nodeId)]);
    const open = new Set(st.conflicts.filter((c) => c.status === "open").flatMap((c) => [`${c.a}:${c.b}`, `${c.b}:${c.a}`]));
    const found: { other: Fragment; reason: string; detectedBy: string }[] = [];
    const ft = tokens(f.text);
    for (const o of st.fragments) {
      if (o.id === f.id || o.state !== "live" || !isCanonKind(o.kind) || o.nodeId == null || !scope.has(o.nodeId) || open.has(`${o.id}:${f.id}`)) continue;
      if (hinted.includes(o.id)) { found.push({ other: o, reason: "The Archivist says these clash.", detectedBy: by }); continue; }
      const sim = similarity(ft, tokens(o.text));
      if (sim < 0.2) continue;
      if (polarity(f.text) !== polarity(o.text)) found.push({ other: o, reason: `Same subject (${Math.round(sim * 100)}% overlap), opposite direction: one says do, the other says don't.`, detectedBy: "code" });
      else if (replacesCue(f.text) && sim >= 0.3) found.push({ other: o, reason: `The newer line says it replaces something (${Math.round(sim * 100)}% overlap).`, detectedBy: "code" });
    }
    const out: Conflict[] = [];
    for (const { other, reason, detectedBy } of found) {
      const st2 = this.state();
      const a = st2.fragments.find((x) => x.id === other.id)!;
      const b = st2.fragments.find((x) => x.id === f.id)!;
      if (a.state !== "live" || b.state !== "live") continue;
      const verdict = precedence(st2, a, b);
      const newer = a.signalId > b.signalId ? a : b;
      const proposal = verdict ? undefined : { winner: newer.id, rule: "proposed", why: "Proposed: keep the newer line. One tap to accept, or keep the other." };
      const ev = this.emit("order.conflict", { a: a.id, b: b.id, nodeId: b.nodeId, reason, detectedBy, proposal });
      if (verdict) this.emit("order.conflict.resolved", { conflictId: ev.id, winner: verdict.winner, loser: verdict.loser, rule: verdict.rule, effect: verdict.effect, why: verdict.why, by: "engine" });
      out.push(this.state().conflicts.find((c) => c.id === ev.id)!);
    }
    return out;
  }

  /** visualizeEverything for one Signal: every new thing must have the event its Bridge view draws from. */
  private visualCheck(signalId: number, fragments: Fragment[], newNodes: number[], conflictIds: number[]) {
    const st = this.state();
    const items: string[] = [];
    const missing: string[] = [];
    const need = (label: string, ok: boolean) => (ok ? items : missing).push(label);
    const nodeIds = new Set(st.nodes.map((n) => n.id));
    for (const id of newNodes) {
      const n = st.nodes.find((x) => x.id === id);
      need(`${n?.kind ?? "node"} "${n?.title}": body on the star map`, !!n && (n.parentId == null ? n.kind === "project" : nodeIds.has(n.parentId)));
    }
    const shown = fragments.filter((f) => f.kind !== "noise");
    const filed = shown.filter((f) => f.nodeId != null);
    need(`${filed.length} fragments: particles to their node`, filed.every((f) => nodeIds.has(f.nodeId!)));
    const tray = shown.length - filed.length;
    if (tray) need(`${tray} fragments: asteroids in the Unsorted belt`, true);
    const noise = fragments.length - shown.length;
    if (noise) need(`${noise} noise fragments: kept in the raw log, hidden`, true);
    for (const nodeId of new Set(filed.filter((f) => isCanonKind(f.kind)).map((f) => f.nodeId!))) {
      const c = canonFor(st, nodeId);
      need(`Canon of "${st.nodes.find((n) => n.id === nodeId)?.title}": constellation (${c.length} rules)`, c.length > 0);
    }
    for (const id of conflictIds) {
      const c = st.conflicts.find((x) => x.id === id);
      const ok = !!c && st.fragments.some((f) => f.id === c.a) && st.fragments.some((f) => f.id === c.b);
      need(`conflict #${id}: red link${c?.status === "open" ? " and a conflict card" : ` (resolved: ${c?.rule})`}`, ok);
    }
    this.emit("order.visual", { signalId, scope: "ingest", pass: missing.length === 0, items, missing });
  }

  // ---- your hands on the tree (each one is an event, so it is undoable by another) ----

  createNode(kind: NodeKind, title: string, parentId: number | null = null) {
    const t = title.trim();
    if (!t) throw new Error("A node needs a title");
    if (kind !== "project" && (parentId == null || !this.state().nodes.some((n) => n.id === parentId))) throw new Error("An idea or thread needs a parent node");
    return this.emit("order.node", { kind, title: t.slice(0, 80), parentId: kind === "project" ? null : parentId, signalId: null, by: "you" }).id;
  }

  /** Drag a fragment to a node (or back to the tray with null). A rule moved into a node is checked against its Canon. */
  moveFragment(fragmentId: number, nodeId: number | null) {
    const st = this.state();
    if (!st.fragments.some((f) => f.id === fragmentId)) throw new Error("No such fragment");
    if (nodeId != null && !st.nodes.some((n) => n.id === nodeId)) throw new Error("No such node");
    this.emit("order.fragment.moved", { fragmentId, nodeId, by: "you" });
    return this.checkConflicts(fragmentId, [], "you");
  }

  pin(fragmentId: number, pinned = true) {
    if (!this.state().fragments.some((f) => f.id === fragmentId)) throw new Error("No such fragment");
    this.emit("order.fragment.pinned", { fragmentId, pinned });
  }

  /** Answer a conflict card (or overturn the engine's call): keep `winner`. */
  resolveConflict(conflictId: number, winner: number) {
    const c = this.state().conflicts.find((x) => x.id === conflictId);
    if (!c) throw new Error("No such conflict");
    if (winner !== c.a && winner !== c.b) throw new Error("The winner must be one of the two rules");
    this.emit("order.conflict.resolved", { conflictId, winner, loser: winner === c.a ? c.b : c.a, rule: "your-call", effect: "supersede", why: "You chose.", by: "you" });
  }

  // ---- background sweep and the daily briefing ----

  /** One sweep: fade, raise old questions, digest, propose merges; then one briefing. */
  sweep() {
    const st = this.state();
    const now = this.opts.now().getTime();
    const age = (ts: string) => (now - Date.parse(ts)) / 86_400_000;
    const done = (action: string, pred: (s: OrderState["sweeps"][number]) => boolean) => st.sweeps.some((s) => s.action === action && !s.undone && pred(s));
    const made: number[] = [];

    for (const f of st.fragments) {
      if (f.state !== "live" || f.pinned || f.important || isCanonKind(f.kind) || f.kind === "noise") continue;
      if (f.kind === "question") {
        if (age(f.lastTouched) >= this.opts.questionDays && !done("raise", (s) => s.fragmentId === f.id))
          made.push(this.emit("order.sweep", { action: "raise", fragmentId: f.id, nodeId: f.nodeId, reason: `Open for ${Math.floor(age(f.lastTouched))} days.` }).id);
        continue;
      }
      if (age(f.lastTouched) >= this.opts.fadeDays)
        made.push(this.emit("order.sweep", { action: "fade", fragmentId: f.id, nodeId: f.nodeId, reason: `Untouched for ${Math.floor(age(f.lastTouched))} days. It stays in the log; touch or pin it to bring it back.` }).id);
    }

    for (const n of st.nodes) {
      if (n.mergedInto != null) continue;
      const last = st.sweeps.filter((s) => s.action === "digest" && s.nodeId === n.id && !s.undone).at(-1);
      const fresh = st.fragments.filter((f) => f.nodeId === n.id && f.state === "live" && f.kind !== "noise" && (!last || f.id > last.id));
      if (fresh.length < this.opts.digestAt) continue;
      made.push(this.emit("order.sweep", { action: "digest", nodeId: n.id, summary: this.digest(st, n.id), reason: `${fresh.length} new fragments since the last digest.` }).id);
    }

    const ideas = st.nodes.filter((n) => n.mergedInto == null && n.kind !== "project");
    const words = (id: number) => [...st.nodes.find((n) => n.id === id)!.title.split(/\s+/), ...st.fragments.filter((f) => f.nodeId === id && f.state === "live").map((f) => f.text)].join(" ");
    for (let i = 0; i < ideas.length; i++) for (let j = i + 1; j < ideas.length; j++) {
      const [a, b] = [ideas[i], ideas[j]];
      if (a.parentId !== b.parentId || a.kind !== b.kind) continue;
      const s = Math.max(similarity(a.title, b.title), similarity(words(a.id), words(b.id)));
      if (s < 0.5) continue;
      if (done("merge-proposal", (x) => (x.nodeId === b.id && x.intoNodeId === a.id) || (x.nodeId === a.id && x.intoNodeId === b.id))) continue;
      made.push(this.emit("order.sweep", { action: "merge-proposal", nodeId: b.id, intoNodeId: a.id, reason: `"${b.title}" and "${a.title}" look like the same idea started twice (${Math.round(s * 100)}% overlap).` }).id);
    }
    const briefing = this.briefing();
    return { actions: made, briefing };
  }

  /** A digest in plain code: the Canon, the open questions and the latest ideas. */
  private digest(st: OrderState, nodeId: number): string {
    const live = st.fragments.filter((f) => f.nodeId === nodeId && f.state === "live" && f.kind !== "noise");
    const canon = canonFor(st, nodeId).filter((c) => c.inheritedFrom == null).slice(0, 5).map((c) => `• ${c.fragment.text}`);
    const qs = live.filter((f) => f.kind === "question").slice(-3).map((f) => `? ${f.text}`);
    const ideas = live.filter((f) => f.kind === "idea" || f.kind === "task").slice(-3).map((f) => `→ ${f.text}`);
    return [`${live.length} live fragments.`, ...canon, ...qs, ...ideas].join("\n");
  }

  acceptMerge(proposalId: number) {
    const st = this.state();
    const p = st.sweeps.find((s) => s.id === proposalId && s.action === "merge-proposal" && !s.undone);
    if (!p || p.nodeId == null || p.intoNodeId == null) throw new Error("No such merge proposal");
    const moved = st.fragments.filter((f) => f.nodeId === p.nodeId).map((f) => ({ fragmentId: f.id, from: f.nodeId }));
    return this.emit("order.sweep", { action: "merge", nodeId: p.nodeId, intoNodeId: p.intoNodeId, moved, reason: `Merge accepted (proposal #${proposalId}).` }).id;
  }

  undoSweep(sweepId: number) {
    const s = this.state().sweeps.find((x) => x.id === sweepId);
    if (!s) throw new Error("No such sweep action");
    if (s.undone) return;
    this.emit("order.sweep.undone", { sweepId });
  }

  /** Non-urgent items batched into one Overseer briefing instead of interrupting you. */
  briefing() {
    const st = this.state();
    const since = st.briefings.at(-1)?.id ?? 0;
    const lines: { kind: string; text: string; ref?: number }[] = [];
    const tray = st.fragments.filter((f) => f.nodeId == null && f.kind !== "noise" && f.state === "live");
    if (tray.length) lines.push({ kind: "unsorted", text: `${tray.length} fragment${tray.length > 1 ? "s" : ""} in the Unsorted tray. Drag each onto a star to file it.` });
    for (const c of st.conflicts.filter((x) => x.status === "open")) lines.push({ kind: "conflict", text: `Conflict needs your call: ${this.short(st, c.a)} vs ${this.short(st, c.b)}`, ref: c.id });
    for (const c of st.conflicts.filter((x) => x.status === "resolved" && x.id > since && x.by === "engine")) lines.push({ kind: "resolved", text: `Resolved by ${c.rule}: kept ${this.short(st, c.winner!)}`, ref: c.id });
    for (const s of st.sweeps.filter((x) => x.id > since && !x.undone)) {
      if (s.action === "merge-proposal") lines.push({ kind: "merge", text: s.reason, ref: s.id });
      if (s.action === "raise") lines.push({ kind: "question", text: `Still open: ${this.short(st, s.fragmentId!)}`, ref: s.id });
      if (s.action === "digest") lines.push({ kind: "digest", text: `Digest of "${st.nodes.find((n) => n.id === s.nodeId)?.title}" is ready.`, ref: s.id });
    }
    const faded = st.sweeps.filter((x) => x.id > since && !x.undone && x.action === "fade").length;
    if (faded) lines.push({ kind: "faded", text: `${faded} stale fragment${faded > 1 ? "s" : ""} faded from view (undoable, nothing deleted).` });
    if (!lines.length) lines.push({ kind: "calm", text: "All in order. Nothing needs you." });
    const e = this.emit("order.briefing", { lines });
    this.emit("order.visual", { signalId: null, scope: "briefing", pass: true, items: [`briefing: ${lines.length} lines in the Overseer channel`], missing: [] });
    return { id: e.id, lines };
  }

  private short(st: OrderState, fragmentId: number) {
    const t = st.fragments.find((f) => f.id === fragmentId)?.text ?? `#${fragmentId}`;
    return `"${t.length > 70 ? t.slice(0, 67) + "…" : t}"`;
  }
}
