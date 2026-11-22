import type { DatabaseSync } from "node:sqlite";

/**
 * The factory's one-build-a-day check, for a ticket's own engine run (run 8917). On 2026-11-22 SF-99's run #7899
 * shipped as a draft PR, and one more press of Work it a minute later started run #8917 on the same branch: a second
 * build of the same ask, at full price. A build that shipped today, or one stopped that can resume, is the answer;
 * "work it again anyway" (again) still starts a new one. Returns the duplicate error to throw, or null.
 */
export function rebuildRefusal(db: DatabaseSync, run: number, resumable: (run: number) => boolean, projectId: number): Error | null {
  const r = db.prepare("SELECT outcome, started_at, finished_at FROM factory_runs WHERE id = ?").get(run) as { outcome: string | null; started_at: string; finished_at: string | null } | undefined;
  const shipped = r?.outcome === "shipped" && (r.finished_at ?? r.started_at) > new Date(Date.now() - 24 * 3600_000).toISOString();
  const stopped = r?.outcome === "stopped" && resumable(run);
  if (!shipped && !stopped) return null;
  const what = shipped ? "already built it today" : "already started it and can resume";
  return Object.assign(new Error(`Run #${run} ${what}. Open that run, or work it again anyway.`), { duplicate: { duplicateOf: run, state: shipped ? "shipped" : "stopped", projectId } });
}

/** Why the engine route must not start a run for this ticket now: its run is live, the Builder is in its repo, or rebuildRefusal. */
export function engineRefusal(db: DatabaseSync, factory: { isActive(run: number): boolean; resumable(run: number): { ok: boolean } }, run: number | null, inRepo: boolean, again: boolean, projectId: number): Error | null {
  if (run != null && factory.isActive(run)) return new Error(`Run #${run} is already working this ticket.`);
  if (inRepo) return new Error("The Builder is already working this ticket in the repo.");
  return again || run == null ? null : rebuildRefusal(db, run, (r) => factory.resumable(r).ok, projectId);
}
