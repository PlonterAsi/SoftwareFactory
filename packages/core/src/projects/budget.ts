import type { EventLog, SfEvent } from "../events.js";
import { projectDetail, registerProjectFacet } from "./service.js";

/**
 * Money limits per project and per version (Assaf, 2026-11-13: "give a project a limit of funds per product or
 * version"). Until now the only limits were one per run and one per agent call; nothing knew which product the
 * money went to.
 *
 *  - A project may have a total: every build in it draws from that, and a build cannot start, or be given more
 *    in the middle, beyond what is left.
 *  - A project may set what a version gets by default: the first version (a new app) and each later one (a
 *    feature or a screen on top of what shipped). A build started without its own limit takes that.
 *
 * Nothing here is required: a project with no budget behaves as before. Settings are `project.budget` events;
 * spend is read from the agent calls in the log, so the numbers cannot drift from what was paid.
 */
export interface ProjectBudget {
  /** The most this project may ever spend; null for no limit. */
  totalUsd: number | null;
  /** What the first version (a new app) gets when the build is started without its own limit. */
  firstUsd: number | null;
  /** What each later version (a feature or screen on top) gets. */
  nextUsd: number | null;
}
export interface VersionSpend { run: number; version: number; kind: "first" | "next"; idea: string; startedAt: string; maxUsd: number; spentUsd: number; outcome: string }
export interface BudgetReport extends ProjectBudget {
  spentUsd: number;
  /** Money builds still running may yet spend (their limit minus what they spent). */
  heldUsd: number;
  /** What a new build could get now; null when the project has no total. */
  leftUsd: number | null;
  versions: VersionSpend[];
}

/** The engine's own defaults when neither the build nor the project says. */
export const DEFAULT_FIRST_USD = 1.5;
export const DEFAULT_NEXT_USD = 1.5;
/** Below this a build cannot do anything useful, so it is not started. */
export const MIN_BUILD_USD = 0.25;

interface Folded { settings: Map<number, ProjectBudget>; runs: Map<number, { idea: string; startedAt: string; maxUsd: number; spentUsd: number; outcome: string; onTop: boolean }> }

function fold(events: SfEvent[]): Folded {
  const settings = new Map<number, ProjectBudget>();
  const runs: Folded["runs"] = new Map();
  for (const e of events) {
    const p = e.payload as Record<string, any>;
    switch (e.type) {
      case "project.budget": settings.set(Number(p.projectId), { totalUsd: num(p.totalUsd), firstUsd: num(p.firstUsd), nextUsd: num(p.nextUsd) }); break;
      case "factory.run.started": runs.set(e.id, { idea: String(p.idea ?? ""), startedAt: e.ts, maxUsd: Number(p.maxUsd ?? 0), spentUsd: 0, outcome: "running", onTop: !!p.screen }); break;
      case "factory.budget": { const r = runs.get(Number(p.run)); if (r && typeof p.maxUsd === "number") r.maxUsd = p.maxUsd; break; }
      case "factory.run.resumed": { const r = runs.get(Number(p.run)); if (r) r.outcome = "running"; break; }
      case "factory.run.finished": { const r = runs.get(Number(p.run)); if (r) r.outcome = String(p.outcome ?? "stopped"); break; }
      case "agent.run.completed": case "agent.run.failed": { const r = runs.get(Number(p.factoryRun)); if (r) r.spentUsd += Number(p.costUsd) || 0; break; }
    }
  }
  return { settings, runs };
}
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) && x > 0 ? Number(x.toFixed(2)) : null);
const money = (n: number) => `$${n.toFixed(2)}`;

/** A project's budget and where its money went, one line per version. */
export function budgetOf(log: EventLog, projectId: number, runIds: number[]): BudgetReport {
  const f = log.view("project-budgets", fold);
  const b = f.settings.get(projectId) ?? { totalUsd: null, firstUsd: null, nextUsd: null };
  const versions = runIds.map((id) => ({ id, r: f.runs.get(id) })).filter((x) => x.r).sort((a, c) => a.id - c.id)
    .map((x, i): VersionSpend => ({ run: x.id, version: i + 1, kind: x.r!.onTop ? "next" : "first", idea: x.r!.idea.split("\n")[0].slice(0, 120), startedAt: x.r!.startedAt, maxUsd: x.r!.maxUsd, spentUsd: Number(x.r!.spentUsd.toFixed(4)), outcome: x.r!.outcome }));
  const spentUsd = Number(versions.reduce((a, v) => a + v.spentUsd, 0).toFixed(4));
  const heldUsd = Number(versions.filter((v) => v.outcome === "running").reduce((a, v) => a + Math.max(0, v.maxUsd - v.spentUsd), 0).toFixed(4));
  return { ...b, spentUsd, heldUsd, leftUsd: b.totalUsd == null ? null : Number(Math.max(0, b.totalUsd - spentUsd - heldUsd).toFixed(4)), versions };
}

export function projectBudget(log: EventLog, projectId: number): BudgetReport | null {
  const d = projectDetail(log, projectId);
  return d ? budgetOf(log, projectId, d.runIds) : null;
}

/** Set, change or clear (null) any of the three numbers. A total below what is already spent is refused. */
export function setProjectBudget(log: EventLog, projectId: number, patch: Partial<Record<keyof ProjectBudget, unknown>>): BudgetReport {
  const now = projectBudget(log, projectId);
  if (!now) throw new Error(`No project #${projectId}`);
  const pick = (k: keyof ProjectBudget) => {
    if (!(k in patch) || patch[k] === undefined) return now[k];
    const v = patch[k];
    if (v === null || v === "" || v === 0) return null;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`${k} must be an amount in dollars, or empty for no limit`);
    // Whole cents, and a positive amount never rounds down to "no limit".
    return Math.max(0.01, Number(v.toFixed(2)));
  };
  const next: ProjectBudget = { totalUsd: pick("totalUsd"), firstUsd: pick("firstUsd"), nextUsd: pick("nextUsd") };
  if (next.totalUsd != null && next.totalUsd < now.spentUsd) throw new Error(`This project has already spent ${money(now.spentUsd)}; its total cannot be set below that.`);
  log.append("project.budget", { projectId, ...next });
  return projectBudget(log, projectId)!;
}

/**
 * What a new build in this project may spend: what was asked, else the project's default for that kind of
 * version, else the engine's, and never more than the project has left. Refuses when too little is left.
 */
export function buildAllowance(log: EventLog, projectId: number, kind: "first" | "next", asked?: number): { maxUsd?: number; note?: string } | { error: string } {
  const b = projectBudget(log, projectId);
  const set = b ? (kind === "first" ? b.firstUsd : b.nextUsd) : null;
  // Nothing asked and nothing set: the factory's own default for that kind of build.
  if (!b || (b.leftUsd == null && asked == null && set == null)) return { maxUsd: asked };
  const want = asked ?? set ?? (kind === "first" ? DEFAULT_FIRST_USD : DEFAULT_NEXT_USD);
  if (b.leftUsd == null) return { maxUsd: want };
  if (b.leftUsd < MIN_BUILD_USD) return { error: `This project's budget of ${money(b.totalUsd!)} is used up (${money(b.spentUsd)} spent${b.heldUsd ? `, ${money(b.heldUsd)} held by a build that is running` : ""}). Raise the project's total on its page to build again.` };
  if (want <= b.leftUsd) return { maxUsd: want };
  return { maxUsd: Number(b.leftUsd.toFixed(2)), note: `The project has ${money(b.leftUsd)} left of ${money(b.totalUsd!)}, so this build gets that instead of ${money(want)}.` };
}

/** How much more a running build may be given (the "Add 50% more" approval): never beyond the project's total. */
export function extraAllowance(log: EventLog, run: number, wantUsd: number, projectOfRun: (run: number) => number | null): number {
  const pid = projectOfRun(run);
  const b = pid == null ? null : projectBudget(log, pid);
  if (!b || b.leftUsd == null) return wantUsd;
  return Number(Math.max(0, Math.min(wantUsd, b.leftUsd)).toFixed(2));
}

registerProjectFacet({ id: "budget", compute: (log, project, links) => budgetOf(log, project.id, links.filter((l) => l.kind === "factory_run").map((l) => Number(l.ref))) });
