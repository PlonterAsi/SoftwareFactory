import type { EventLog } from "../events.js";
import type { OrderState } from "../order/model.js";
import { canonFor } from "../order/model.js";

/**
 * Two read-only views over the log for the Overseer:
 * - "since you left": what changed while the Bridge was closed or in the background;
 * - the status digest the Overseer agent reads before it answers you.
 * Both are plain code over tables and events; no model call.
 */

export interface SinceLine { kind: "shipped" | "failed" | "stopped" | "gate" | "conflict" | "filed" | "drop" | "spend" | "running"; text: string; ref?: number }
export interface SinceReport { fromEvent: number; toEvent: number; leftAt: string | null; awayMinutes: number; lines: SinceLine[] }

interface RunRow { id: number; idea: string; plan_name: string | null; outcome: string | null; reason: string | null; total_usd: number | null; dir: string | null; finished_at: string | null }

const runName = (r: RunRow) => r.plan_name ?? (r.idea.length > 50 ? r.idea.slice(0, 47) + "…" : r.idea);

/** Runs that are waiting at a gate right now, from the events (gates are not a table). */
export function waitingGates(log: EventLog): { run: number; gate: string; question: string }[] {
  const finished = new Set(log.list({ type: "factory.run.finished", limit: 1e6 }).map((e) => (e.payload as { run: number }).run));
  const last = new Map<number, { gate: string; state: string; question: string }>();
  for (const e of log.list({ type: "factory.gate", limit: 1e6 })) {
    const p = e.payload as { run: number; gate: string; state: string; question: string };
    last.set(p.run, p);
  }
  return [...last.entries()].filter(([run, g]) => g.state === "waiting" && !finished.has(run)).map(([run, g]) => ({ run, gate: g.gate, question: g.question }));
}

/** The newest "Bridge seen" marker, written by the Bridge as you leave it. */
export function lastSeen(log: EventLog): { eventId: number; ts: string } | null {
  const row = log.db.prepare("SELECT id, ts, payload FROM events WHERE type = 'bridge.seen' ORDER BY id DESC LIMIT 1").get() as { id: number; ts: string; payload: string } | undefined;
  if (!row) return null;
  const p = JSON.parse(row.payload) as { eventId: number };
  return { eventId: Number(p.eventId), ts: row.ts };
}

export function sinceReport(log: EventLog, order: OrderState, from?: number, now = Date.now()): SinceReport {
  const seen = lastSeen(log);
  const fromEvent = from ?? seen?.eventId ?? 0;
  const toEvent = Number((log.db.prepare("SELECT max(id) AS m FROM events").get() as { m: number | null }).m ?? 0);
  const leftAt = seen?.ts ?? null;
  const awayMinutes = leftAt ? Math.max(0, Math.round((now - Date.parse(leftAt)) / 60_000)) : 0;
  const lines: SinceLine[] = [];
  if (!fromEvent) return { fromEvent, toEvent, leftAt, awayMinutes, lines };

  const runs = log.db.prepare("SELECT id, idea, plan_name, outcome, reason, total_usd, dir, finished_at FROM factory_runs WHERE id > ? OR (finished_at IS NOT NULL AND id IN (SELECT json_extract(payload, '$.run') FROM events WHERE type = 'factory.run.finished' AND id > ?)) ORDER BY id")
    .all(fromEvent, fromEvent) as unknown as RunRow[];
  for (const r of runs) {
    if (r.outcome === "shipped") lines.push({ kind: "shipped", text: `Shipped ${runName(r)}${r.total_usd != null ? ` for $${r.total_usd.toFixed(4)}` : ""}.`, ref: r.id });
    else if (r.outcome === "failed") lines.push({ kind: "failed", text: `Run #${r.id} (${runName(r)}) failed: ${(r.reason ?? "").slice(0, 140)}`, ref: r.id });
    else if (r.outcome === "stopped") lines.push({ kind: "stopped", text: `Run #${r.id} (${runName(r)}) stopped: ${(r.reason ?? "").slice(0, 140)}`, ref: r.id });
    else if (!r.outcome) lines.push({ kind: "running", text: `Run #${r.id} (${runName(r)}) is still working.`, ref: r.id });
  }
  for (const g of waitingGates(log)) lines.push({ kind: "gate", text: `Run #${g.run} is waiting for you: ${g.question}`, ref: g.run });
  const open = order.conflicts.filter((c) => c.status === "open" && c.id > fromEvent);
  if (open.length) lines.push({ kind: "conflict", text: `${open.length} new conflict${open.length > 1 ? "s" : ""} between your rules need a tap in the Order deck.` });
  const filed = order.fragments.filter((f) => f.id > fromEvent && f.kind !== "noise");
  if (filed.length) {
    const where = new Map<string, number>();
    for (const f of filed) {
      const t = f.nodeId == null ? "the Unsorted belt" : order.nodes.find((n) => n.id === f.nodeId)?.title ?? "?";
      where.set(t, (where.get(t) ?? 0) + 1);
    }
    const top = [...where.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, n]) => `${n} to ${t}`).join(", ");
    lines.push({ kind: "filed", text: `${filed.length} new note${filed.length > 1 ? "s" : ""} filed: ${top}.` });
  }
  const drops = Number((log.db.prepare("SELECT count(*) AS n FROM drops WHERE id > ? AND status = 'filed'").get(fromEvent) as { n: number }).n);
  if (drops) lines.push({ kind: "drop", text: `${drops} note${drops > 1 ? "s" : ""} came in through the drop folder.` });
  const spend = Number((log.db.prepare("SELECT coalesce(sum(cost_usd), 0) AS s, count(*) AS n FROM agent_runs WHERE id > ? AND status = 'done'").get(fromEvent) as { s: number }).s);
  if (spend > 0) lines.push({ kind: "spend", text: `Agents spent $${spend.toFixed(4)} meanwhile.` });
  return { fromEvent, toEvent, leftAt, awayMinutes, lines };
}

/** What the Overseer agent reads before your message: short, factual, from the log. */
export function statusDigest(log: EventLog, order: OrderState, runtimeName: string): string {
  const out: string[] = [`Crew: ${runtimeName === "mock" ? "practice (free mock crew; it always builds a sample word counter)" : `real (${runtimeName})`}.`];
  const active = log.db.prepare("SELECT id, idea, plan_name FROM factory_runs WHERE outcome IS NULL ORDER BY id DESC LIMIT 3").all() as unknown as RunRow[];
  for (const r of active) out.push(`Running: run #${r.id} ${runName(r)}.`);
  for (const g of waitingGates(log)) out.push(`Waiting for the person: run #${g.run}: ${g.question}`);
  const recent = log.db.prepare("SELECT id, idea, plan_name, outcome, reason, total_usd, dir FROM factory_runs WHERE outcome IS NOT NULL ORDER BY id DESC LIMIT 4").all() as unknown as RunRow[];
  for (const r of recent) out.push(`Finished: run #${r.id} ${runName(r)}: ${r.outcome}${r.total_usd != null ? `, $${r.total_usd.toFixed(4)}` : ""}${r.outcome === "shipped" && r.dir ? `, repo at ${r.dir}` : r.reason ? ` (${r.reason.slice(0, 100)})` : ""}.`);
  const open = order.conflicts.filter((c) => c.status === "open").length;
  if (open) out.push(`Open conflicts between rules: ${open}.`);
  const tray = order.fragments.filter((f) => f.nodeId == null && f.state === "live" && f.kind !== "noise").length;
  if (tray) out.push(`Unsorted notes: ${tray}.`);
  const projects = order.nodes.filter((n) => n.parentId == null && n.mergedInto == null).sort((a, b) => b.lastActive.localeCompare(a.lastActive)).slice(0, 5);
  for (const p of projects) {
    const rules = canonFor(order, p.id).slice(0, 3).map((c) => c.fragment.text.slice(0, 90));
    out.push(`Project "${p.title}"${rules.length ? `; rules: ${rules.join(" | ")}` : ""}.`);
  }
  const spend = (log.db.prepare("SELECT coalesce(sum(cost_usd), 0) AS s FROM agent_runs WHERE status = 'done' AND started_at >= ?").get(new Date(Date.now() - 86_400_000).toISOString()) as { s: number }).s;
  out.push(`Agent spend in the last 24 h: $${Number(spend).toFixed(4)}.`);
  return out.join("\n");
}

/** The Overseer may end with "BUILD: <idea>"; the Bridge turns it into a Build button. */
export function buildSuggestion(text: string): { text: string; build?: string } {
  const m = text.match(/^\s*BUILD:\s*(.+?)\s*$/m);
  if (!m) return { text };
  return { text: text.replace(m[0], "").trim(), build: m[1].slice(0, 300) };
}
