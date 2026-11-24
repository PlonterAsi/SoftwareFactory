import { spawn, type ChildProcess } from "node:child_process";

/**
 * Sleep is not work (2026-11-24). Run 10486 (Gig Station) built 5 of 6 features in 35 minutes, then the PC slept from
 * 10:27 to 14:19. On waking, the Builder's 25-minute timer fired at once ("took too long"), and the run, its tests green
 * and its review passed, was stopped as "longer than 90 minutes": four hours of sleep counted as run time.
 *
 * Two answers live here:
 * - a sleep ledger: a light tick notices when the clock jumps (the PC slept, or the process was frozen), and every clock
 *   that measures work (a run's limit, an agent call's limit, the stuck watch) leaves those gaps out;
 * - keep-awake: while the crew is working, Windows is asked not to sleep on idle (SetThreadExecutionState), the way a
 *   download or a video player does. A closed lid or the power button still wins. SF_KEEP_AWAKE=off turns it off.
 */

/** A tick that comes this late means the clock jumped: the PC slept or the process was held. */
export const SLEEP_GAP_MS = 60_000;
const TICK_MS = 5_000;
const KEEP_GAPS = 200;

const gaps: { from: number; to: number }[] = [];
let lastTick = Date.now();
let ticker: NodeJS.Timeout | null = null;

/** Start noticing clock jumps (once per process; the timer never holds the process open). */
export function watchSleep(): void {
  if (ticker) return;
  lastTick = Date.now();
  ticker = setInterval(observeClock, TICK_MS);
  ticker.unref?.();
}

/**
 * Look at the clock now: a jump since the last look is recorded as sleep. The tick does this every 5 s; a watchdog
 * calls it before it judges, so a timer that fires the moment the PC wakes sees the sleep first. Only while the
 * sleep watch runs (without it, the last look may simply be old).
 */
export function observeClock(now = Date.now()): void {
  if (!ticker) return;
  if (now - lastTick > SLEEP_GAP_MS) noteGap(lastTick + TICK_MS, now);
  if (now > lastTick) lastTick = now;
}

/** Record a stretch the PC was asleep (the tick calls it; tests call it directly). */
export function noteGap(from: number, to: number): void {
  if (to <= from) return;
  gaps.push({ from, to });
  if (gaps.length > KEEP_GAPS) gaps.splice(0, gaps.length - KEEP_GAPS);
}

/** How much of [from, to] the PC spent asleep, in ms. */
export function sleptBetween(from: number, to: number): number {
  let ms = 0;
  for (const g of gaps) ms += Math.max(0, Math.min(to, g.to) - Math.max(from, g.from));
  return ms;
}

/** The last sleep that ended at or after `since`, if any (for the supervisor's page). */
export function lastSleep(since = 0): { from: number; to: number } | null {
  return [...gaps].reverse().find((g) => g.to >= since) ?? null;
}

/** Tests only: forget every gap. */
export function clearSleepLedger(): void { gaps.length = 0; lastTick = Date.now(); }

/**
 * A clock of awake time: it moves while the PC is awake, not while it sleeps. `idle()` is the awake time since the
 * last `beat()`. Used by an agent call (output is progress) and by the stuck watch.
 */
export class AwakeClock {
  private readonly began: number;
  private lastBeat: number;
  constructor(private now: () => number = Date.now) { this.began = now(); this.lastBeat = this.began; }
  beat(): void { this.lastBeat = this.now(); }
  /** Awake ms since the clock began. */
  elapsed(): number { observeClock(); const n = this.now(); return n - this.began - sleptBetween(this.began, n); }
  /** Awake ms since the last beat. */
  idle(): number { observeClock(); const n = this.now(); return n - this.lastBeat - sleptBetween(this.lastBeat, n); }
}

// ---- keep-awake ------------------------------------------------------------------------------------------------

/**
 * ES_CONTINUOUS | ES_SYSTEM_REQUIRED, held by a small PowerShell that lives as long as the crew works. Display sleep
 * is left alone. The state ends with that process, and the process ends within 30 s of the core, so a core that dies
 * never leaves the PC unable to sleep.
 */
/** The hold ends by itself when the core is gone: Windows does not end a child with its parent. */
const holdScript = (corePid: number) => [
  "$sig = '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'",
  "$k = Add-Type -MemberDefinition $sig -Name SfAwake -Namespace Sf -PassThru",
  `while (Get-Process -Id ${corePid} -ErrorAction SilentlyContinue) { [void]$k::SetThreadExecutionState([uint32]2147483649); Start-Sleep -Seconds 30 }`,
].join("; ");

/** For tests: the script the hold runs. */
export const holdScriptFor = holdScript;

export interface KeepAwake { readonly on: boolean; readonly why: string; set(want: boolean): void; stop(): void }

/** Holds the PC awake while `set(true)`; a no-op off Windows, under tests, or with SF_KEEP_AWAKE=off. */
export function keepAwake(o: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; spawnHold?: () => ChildProcess } = {}): KeepAwake {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const off = env.SF_KEEP_AWAKE === "off" ? "turned off (SF_KEEP_AWAKE=off)" : env.VITEST && !o.spawnHold ? "not under tests" : platform !== "win32" && !o.spawnHold ? "only on Windows" : "";
  let child: ChildProcess | null = null;
  const start = o.spawnHold ?? (() => spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(holdScript(process.pid), "utf16le").toString("base64")], { stdio: "ignore", windowsHide: true }));
  const api: KeepAwake = {
    get on() { return !!child; },
    get why() { return off || (child ? "the crew is working: the PC stays awake" : "nothing is working: the PC may sleep"); },
    set(want: boolean) {
      if (off) return;
      if (want && !child) {
        try {
          child = start();
          child.on("exit", () => { child = null; });
          child.on("error", () => { child = null; });
        } catch { child = null; }
      } else if (!want && child) {
        try { child.kill(); } catch { /* already gone */ }
        child = null;
      }
    },
    stop() { api.set(false); },
  };
  return api;
}
