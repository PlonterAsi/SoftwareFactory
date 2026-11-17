import type { EventLog } from "../events.js";
import { projectOf, registerProjectFacet } from "../projects/service.js";

/**
 * Monthly budgets and the burn rate (SF behavior brief, phase 6). Money is read from the agent calls in the log,
 * so the numbers cannot drift from what was paid. A call is charged to a project when it was made for one: its
 * ticket's project, its build's project, or the project it names. The rest (the Archivist, the council, a chat)
 * counts toward the overall month only.
 *
 * Budgets are `budget.monthly` events: one for the whole of SoftwareFactory (projectId null) and one per project.
 * A month is the calendar month on this computer's clock. Nothing here is required: no budget, no limit.
 */
export interface MonthBudget { projectId: number | null; usd: number | null }

export interface MonthReport {
  /** "2026-11" */
  month: string;
  projectId: number | null;
  budgetUsd: number | null;
  spentUsd: number;
  /** Budget minus spent, never below 0; null with no budget. */
  leftUsd: number | null;
  /** Spend per day of this month so far, oldest first. */
  days: { day: string; usd: number }[];
  /** Average spend per day over the last 7 days (the burn rate). */
  burnUsd: number;
  /** Where the month ends at that rate. */
  projectedUsd: number;
  /** The day the budget runs out at that rate, when that is before the month ends. */
  runsOutOn: string | null;
  daysLeft: number;
  /** The overall report only: each project's month, biggest spender first. */
  projects?: { projectId: number; name: string; spentUsd: number; budgetUsd: number | null; leftUsd: number | null }[];
  /** The overall report only: what no project carries. */
  unassignedUsd?: number;
}

const round = (n: number, d = 4) => Number(n.toFixed(d));
const pad = (n: number) => String(n).padStart(2, "0");
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const monthKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const monthStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const nextMonthStart = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 1);

/** The budgets in force: the newest setting for overall and for each project. */
export function monthBudgets(log: EventLog): { overallUsd: number | null; projects: Map<number, number | null> } {
  const rows = log.db.prepare("SELECT payload FROM events WHERE type = 'budget.monthly' ORDER BY id").all() as { payload: string }[];
  let overallUsd: number | null = null;
  const projects = new Map<number, number | null>();
  for (const r of rows) {
    const p = JSON.parse(r.payload) as MonthBudget;
    const usd = typeof p.usd === "number" && p.usd > 0 ? p.usd : null;
    if (p.projectId == null) overallUsd = usd; else projects.set(Number(p.projectId), usd);
  }
  return { overallUsd, projects };
}

/** Set (or clear, with null) the monthly budget of a project, or of everything (projectId null). */
export function setMonthBudget(log: EventLog, projectId: number | null, usd: unknown): MonthReport {
  let v: number | null = null;
  if (usd !== null && usd !== undefined && usd !== "" && usd !== 0) {
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) throw new Error("A monthly budget is an amount in dollars, or empty for no limit.");
    v = Math.max(0.01, Number(usd.toFixed(2)));
  }
  if (projectId != null && !log.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) throw new Error(`No project #${projectId}`);
  log.append("budget.monthly", { projectId, usd: v });
  return monthReport(log, projectId);
}

interface Charge { ts: string; usd: number; projectId: number | null }

/** Every paid agent call since `since`, with the project it was made for (or null). */
export function charges(log: EventLog, since: Date): Charge[] {
  const rows = log.db.prepare(`SELECT ts, json_extract(payload, '$.costUsd') AS usd, json_extract(payload, '$.projectId') AS pid,
      json_extract(payload, '$.ticket') AS ticket, json_extract(payload, '$.factoryRun') AS run
    FROM events WHERE type IN ('agent.run.completed', 'agent.run.failed') AND ts >= ?`).all(since.toISOString()) as { ts: string; usd: number | null; pid: number | null; ticket: number | null; run: number | null }[];
  const hasTickets = !!log.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tickets'").get();
  const ofTicket = new Map<number, number | null>();
  const ofRun = new Map<number, number | null>();
  const out: Charge[] = [];
  for (const r of rows) {
    const usd = Number(r.usd) || 0;
    if (usd <= 0) continue;
    let projectId: number | null = r.pid != null ? Number(r.pid) : null;
    if (projectId == null && r.ticket != null && hasTickets) {
      const t = Number(r.ticket);
      if (!ofTicket.has(t)) ofTicket.set(t, ((log.db.prepare("SELECT project FROM tickets WHERE id = ?").get(t) as { project: number | null } | undefined)?.project ?? null));
      projectId = ofTicket.get(t) ?? null;
    }
    if (projectId == null && r.run != null) {
      const run = Number(r.run);
      if (!ofRun.has(run)) { try { ofRun.set(run, projectOf(log, { kind: "factory_run", ref: run })); } catch { ofRun.set(run, null); } }
      projectId = ofRun.get(run) ?? null;
    }
    out.push({ ts: r.ts, usd, projectId: projectId != null && Number.isFinite(projectId) ? projectId : null });
  }
  return out;
}

/** This month for one project, or for everything (projectId null), with the burn rate and where the month ends. */
export function monthReport(log: EventLog, projectId: number | null, now = new Date()): MonthReport {
  const start = monthStart(now);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const from = weekAgo < start ? weekAgo : start;
  const all = charges(log, from);
  const mine = projectId == null ? all : all.filter((c) => c.projectId === projectId);
  const inMonth = mine.filter((c) => Date.parse(c.ts) >= start.getTime());
  const spentUsd = round(inMonth.reduce((a, c) => a + c.usd, 0));
  const byDay = new Map<string, number>();
  for (const c of inMonth) { const k = localDay(new Date(c.ts)); byDay.set(k, (byDay.get(k) ?? 0) + c.usd); }
  const days: MonthReport["days"] = [];
  for (let d = new Date(start); d <= now; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) days.push({ day: localDay(d), usd: round(byDay.get(localDay(d)) ?? 0) });
  const burnUsd = round(mine.filter((c) => Date.parse(c.ts) >= weekAgo.getTime()).reduce((a, c) => a + c.usd, 0) / 7);
  const end = nextMonthStart(now);
  const daysLeft = Math.max(0, (end.getTime() - now.getTime()) / 86_400_000);
  const budgets = monthBudgets(log);
  const budgetUsd = projectId == null ? budgets.overallUsd : budgets.projects.get(projectId) ?? null;
  const leftUsd = budgetUsd == null ? null : round(Math.max(0, budgetUsd - spentUsd));
  let runsOutOn: string | null = null;
  if (leftUsd != null && burnUsd > 0) {
    const out = new Date(now.getTime() + (leftUsd / burnUsd) * 86_400_000);
    if (out < end) runsOutOn = localDay(out);
  }
  const report: MonthReport = { month: monthKey(now), projectId, budgetUsd, spentUsd, leftUsd, days, burnUsd, projectedUsd: round(spentUsd + burnUsd * daysLeft, 2), runsOutOn, daysLeft: Math.ceil(daysLeft) };
  if (projectId == null) {
    const per = new Map<number, number>();
    let unassigned = 0;
    for (const c of inMonth) { if (c.projectId == null) unassigned += c.usd; else per.set(c.projectId, (per.get(c.projectId) ?? 0) + c.usd); }
    for (const id of budgets.projects.keys()) if (!per.has(id)) per.set(id, 0);
    const names = new Map((log.db.prepare("SELECT id, name FROM projects").all() as { id: number; name: string }[]).map((r) => [Number(r.id), r.name]));
    report.projects = [...per].filter(([id]) => names.has(id)).map(([id, usd]) => {
      const b = budgets.projects.get(id) ?? null;
      return { projectId: id, name: names.get(id)!, spentUsd: round(usd), budgetUsd: b, leftUsd: b == null ? null : round(Math.max(0, b - usd)) };
    }).sort((a, b) => b.spentUsd - a.spentUsd || a.name.localeCompare(b.name));
    report.unassignedUsd = round(unassigned);
  }
  return report;
}

/**
 * What the crew may still spend this month on work for `projectId`: the smaller of what the overall budget and the
 * project's budget have left, with the sentence that says which one holds it. leftUsd null: no monthly limit.
 */
export function monthLeft(log: EventLog, projectId: number | null, now = new Date()): { leftUsd: number | null; why: string | null } {
  const budgets = monthBudgets(log);
  const pb = projectId != null ? budgets.projects.get(projectId) ?? null : null;
  if (budgets.overallUsd == null && pb == null) return { leftUsd: null, why: null };
  const all = charges(log, monthStart(now));
  const money = (n: number) => `$${n.toFixed(2)}`;
  const next = nextMonthStart(now).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  let leftUsd = Infinity, why: string | null = null;
  if (budgets.overallUsd != null) {
    const spent = all.reduce((a, c) => a + c.usd, 0);
    leftUsd = Math.max(0, budgets.overallUsd - spent);
    why = `this month's budget of ${money(budgets.overallUsd)} has ${money(leftUsd)} left (it renews ${next})`;
  }
  if (pb != null) {
    const spent = all.filter((c) => c.projectId === projectId).reduce((a, c) => a + c.usd, 0);
    const left = Math.max(0, pb - spent);
    if (left < leftUsd) { leftUsd = left; why = `this project's monthly budget of ${money(pb)} has ${money(left)} left (it renews ${next})`; }
  }
  return { leftUsd: round(leftUsd), why };
}

// The project page reads its month with the rest of the project (the Money tab).
registerProjectFacet({ id: "month", compute: (log, project) => monthReport(log, project.id) });
