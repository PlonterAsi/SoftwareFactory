/** Stop rules (SF-25): when a fix loop should stop instead of looping. Pure: give it the history, get a reason or null. */

export interface RoundRecord {
  /** How many tests failed after this round. */
  failing: number;
  /** The names of the failing tests, joined; the same text twice means the fix changed nothing that matters. */
  names?: string;
  /** Content hash of each file changed in this round, by path. */
  files?: Record<string, string>;
  /** Content hash of those files just before this round wrote them, so a revert to the build's version counts too. */
  before?: Record<string, string>;
}

export const DEFAULT_MAX_RUN_MINUTES = 30;
/**
 * The wall-clock limit of one run. The setting was sized for a small run (up to $2); a product run with a real
 * budget gets time in proportion (run 2898 was stopped at 30 minutes with $5.33 of its $10 unspent, as the
 * product judge's findings came back). A $10 run gets five times the setting; never more than 4 hours.
 */
export const FULL_TIME_USD = 2;
export const MAX_RUN_MINUTES_CEILING = 240;
export function runMinutes(maxUsd: number, setting?: number): number {
  const base = setting ?? DEFAULT_MAX_RUN_MINUTES;
  return maxUsd <= FULL_TIME_USD ? base : Math.min(Math.max(base, MAX_RUN_MINUTES_CEILING), Math.round(base * (maxUsd / FULL_TIME_USD)));
}

export const SAME_TESTS_REASON = "The same tests failed twice in a row after a fix.";

export function stopReason(h: { rounds: RoundRecord[]; startedAt: number; now: number; maxMinutes?: number }): string | null {
  const limit = (h.maxMinutes ?? DEFAULT_MAX_RUN_MINUTES) * 60_000;
  if (h.now - h.startedAt > limit) return `The run took longer than ${h.maxMinutes ?? DEFAULT_MAX_RUN_MINUTES} minutes.`;
  const r = h.rounds;
  const last = r.at(-1);
  if (!last) return null;
  for (const [path, hash] of Object.entries(last.files ?? {})) {
    if (r.slice(0, -1).some((e) => e.files?.[path] === hash || e.before?.[path] === hash)) return `${path} went back to what it was in an earlier round; the fixes are going in circles.`;
  }
  if (last.failing > 0 && last.names && r.length >= 2 && r[r.length - 2].names === last.names) return SAME_TESTS_REASON;
  if (last.failing > 0 && r.length >= 3 && r[r.length - 2].failing >= r[r.length - 3].failing && last.failing >= r[r.length - 2].failing) {
    return "The number of failing tests did not fall for 2 rounds in a row.";
  }
  return null;
}
