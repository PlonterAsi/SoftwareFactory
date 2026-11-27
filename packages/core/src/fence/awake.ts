/**
 * Time the computer was awake (docs/fence.md, "Sleep is not run time").
 *
 * A laptop that sleeps for four hours has not worked for four hours. A plain timer counts the sleep, so a run's
 * time limit would pass in its sleep and a quiet run would be called silent on waking. Here time is counted in
 * small steps, and a step that took far longer than it should is a sleep: it counts as one step, not as its length.
 */
export interface AwakeOpts { now?: () => number; stepMs?: number }

/** Calls `fire` once, after `ms` of awake time. Returns the cancel. */
export function awakeTimer(ms: number, fire: () => void, o: AwakeOpts = {}): () => void {
  const now = o.now ?? Date.now, step = Math.max(50, Math.min(o.stepMs ?? 5000, ms));
  let awake = 0, last = now(), done = false;
  const t = setInterval(() => {
    const n = now(), d = n - last;
    last = n;
    // A step that ran long, or a clock set back, is not work time.
    awake += d < 0 ? 0 : Math.min(d, step * 3);
    if (awake >= ms && !done) { done = true; clearInterval(t); fire(); }
  }, step);
  return () => { done = true; clearInterval(t); };
}

/** Sleeps seen by one watcher: when it woke and how long the sleep was. */
export interface Sleeps { list: { wokeAt: number; ms: number }[]; last: number | null }
export const noSleeps = (): Sleeps => ({ list: [], last: null });

/** Call at every look. A gap far longer than the look's own pace is written down as a sleep. */
export function noteLook(s: Sleeps, now: number, everyMs: number): void {
  if (s.last !== null && now - s.last > everyMs * 3 + 10_000) { s.list.push({ wokeAt: now, ms: now - s.last - everyMs }); if (s.list.length > 200) s.list.shift(); }
  s.last = now;
}

/** How long ago `at` was, in awake milliseconds: sleeps that came after it do not count. */
export function awakeAge(s: Sleeps, at: number, now: number): number {
  return Math.max(0, now - at - s.list.filter((x) => x.wokeAt > at).reduce((a, x) => a + x.ms, 0));
}
