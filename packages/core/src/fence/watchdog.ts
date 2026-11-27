import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TheRecord } from "./record.js";

/**
 * The watchdog (build step 1, slice 5): a small program of its own, beside SoftwareFactory and not inside it.
 * SoftwareFactory writes a sign of life every few seconds. The watchdog reads it, and speaks one line when
 * SoftwareFactory went away in the middle of a run, or when a run has been silent for too long. When
 * SoftwareFactory is gone it also ends whatever the run left working in the room, so nothing works on unseen.
 *
 * A line is always written to the record, and goes to the phone when a phone is set. A line to the phone
 * names the ticket and says what happened. It never carries the sentence, the project's name or any code.
 */

export interface Alive {
  pid: number;
  at: string;
  /** SoftwareFactory was closed on purpose: nothing to watch. */
  closed?: boolean;
  running: { ticket: string | null; startedAt: string; lastLineAt: string } | null;
}

export const aliveFile = (workDir: string) => join(workDir, "alive.json");
export function writeAlive(workDir: string, a: Alive): void {
  const tmp = `${aliveFile(workDir)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(a));
  renameSync(tmp, aliveFile(workDir));
}
export function readAlive(workDir: string): Alive | null {
  try { return existsSync(aliveFile(workDir)) ? (JSON.parse(readFileSync(aliveFile(workDir), "utf8")) as Alive) : null; } catch { return null; }
}

export interface PhoneSettings {
  /** "none": lines stay on the home screen. "ntfy": lines also go to one channel of the free ntfy app. */
  phone: "none" | "ntfy";
  ntfyServer: string;
  /** The channel's name. Whoever knows it can read the lines, so it is long and random. */
  ntfyTopic: string;
}
export interface WatchSettings extends PhoneSettings {
  /** A run with no new line for this long is called silent. */
  stuckMinutes: number;
  /** No sign of life for this long, in the middle of a run, and SoftwareFactory is called gone. */
  goneSeconds: number;
}
export const WATCH_DEFAULTS: WatchSettings = { phone: "none", ntfyServer: "https://ntfy.sh", ntfyTopic: "", stuckMinutes: 10, goneSeconds: 45 };

export function cleanWatch(raw: unknown, from: WatchSettings = WATCH_DEFAULTS): WatchSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const s: WatchSettings = {
    phone: r.phone === undefined ? from.phone : (r.phone as WatchSettings["phone"]),
    ntfyServer: typeof r.ntfyServer === "string" ? r.ntfyServer.trim().replace(/\/+$/, "") : from.ntfyServer,
    ntfyTopic: typeof r.ntfyTopic === "string" ? r.ntfyTopic.trim() : from.ntfyTopic,
    stuckMinutes: r.stuckMinutes === undefined ? from.stuckMinutes : Number(r.stuckMinutes),
    goneSeconds: r.goneSeconds === undefined ? from.goneSeconds : Number(r.goneSeconds),
  };
  if (s.phone !== "none" && s.phone !== "ntfy") throw new Error("The phone setting is either none or ntfy.");
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(s.ntfyServer)) throw new Error("The ntfy server is an https address, for example https://ntfy.sh.");
  if (s.ntfyTopic && !/^[A-Za-z0-9_-]{16,64}$/.test(s.ntfyTopic)) throw new Error("The ntfy channel name is 16 to 64 letters, digits, dashes or underscores. Long and random, because whoever knows it can read the lines.");
  if (s.phone === "ntfy" && !s.ntfyTopic) throw new Error("Give the ntfy channel a name first.");
  if (!Number.isInteger(s.stuckMinutes) || s.stuckMinutes < 1 || s.stuckMinutes > 240) throw new Error("Silent-for must be 1 to 240 minutes.");
  if (!Number.isInteger(s.goneSeconds) || s.goneSeconds < 15 || s.goneSeconds > 3600) throw new Error("Gone-after must be 15 to 3600 seconds.");
  return s;
}

export type Sender = (url: string, body: string, headers: Record<string, string>) => Promise<{ ok: boolean; status: number }>;
export const httpSender: Sender = async (url, body, headers) => {
  const r = await fetch(url, { method: "POST", body, headers, signal: AbortSignal.timeout(15_000) });
  return { ok: r.ok, status: r.status };
};

/** A line for a phone: short, plain letters, nothing that could carry a secret or a piece of the project. */
export const phoneLine = (line: string) => line.replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);

export interface SpeakDeps { record: TheRecord; settings: () => WatchSettings; send?: Sender }

/** Say one line: always into the record, and to the phone when one is set. Never throws. */
export async function speak(deps: SpeakDeps, what: { line: string; ticket?: string | null; why: string }): Promise<{ phone: "sent" | "not set" | "failed" }> {
  const s = deps.settings();
  let phone: "sent" | "not set" | "failed" = "not set";
  if (s.phone === "ntfy" && s.ntfyTopic) {
    try { phone = (await (deps.send ?? httpSender)(`${s.ntfyServer}/${s.ntfyTopic}`, phoneLine(what.line), { title: "SoftwareFactory", "content-type": "text/plain" })).ok ? "sent" : "failed"; }
    catch { phone = "failed"; }
  }
  try { deps.record.append({ kind: "watchdog.spoke", who: "watchdog", ticket: what.ticket ?? null, data: { line: what.line, why: what.why, phone } }); } catch { /* the line was still tried on the phone */ }
  return { phone };
}

export interface WatchState { spoke: Record<string, true> }
export interface WatchVerdict { say: { key: string; line: string; ticket: string | null; why: string } | null; endRoom: boolean; done: boolean }

/**
 * One look. `done` means there is nothing left to watch and the watchdog may go home. Each thing is said once:
 * `state.spoke` remembers what was said.
 */
export function look(alive: Alive | null, s: WatchSettings, state: WatchState, now: Date): WatchVerdict {
  if (!alive) return { say: null, endRoom: false, done: false };
  // Closed on purpose. If a run was working at that moment, the room is ended quietly, in case the window closed
  // faster than SoftwareFactory could end it itself.
  if (alive.closed) return { say: null, endRoom: !!alive.running, done: true };
  const age = (iso: string) => (now.getTime() - new Date(iso).getTime()) / 1000;
  const name = alive.running?.ticket ?? "a ticket";
  if (age(alive.at) > s.goneSeconds) {
    if (!alive.running) return { say: null, endRoom: false, done: true };
    const key = `gone ${alive.pid} ${alive.running.startedAt}`;
    if (state.spoke[key]) return { say: null, endRoom: false, done: true };
    return { say: { key, line: `SoftwareFactory went away while ${name} was being worked. The run was ended; nothing left the computer.`, ticket: alive.running.ticket, why: "gone" }, endRoom: true, done: true };
  }
  if (alive.running && age(alive.running.lastLineAt) > s.stuckMinutes * 60) {
    const key = `silent ${alive.running.startedAt}`;
    if (!state.spoke[key]) return { say: { key, line: `${name} has been silent for ${s.stuckMinutes} minutes. Look at the home screen, or press Stop.`, ticket: alive.running.ticket, why: "silent" }, endRoom: false, done: false };
  }
  return { say: null, endRoom: false, done: false };
}

export interface WatchdogDeps extends SpeakDeps {
  workDir: string;
  /** Ends everything of the worker's in the room. */
  endRoom: () => Promise<void>;
  now?: () => Date;
  /** How long to wait for SoftwareFactory's first sign of life before going home. */
  giveUpMs?: number;
}

/** The loop. Looks every `everyMs` until there is nothing left to watch. */
export async function runWatchdog(deps: WatchdogDeps, everyMs = 5000, signal?: AbortSignal): Promise<void> {
  const state: WatchState = { spoke: {} };
  const now = deps.now ?? (() => new Date());
  // A sign of life from before the watchdog started belongs to an earlier SoftwareFactory: it is not looked at.
  const born = now().getTime() - 2000;
  let everSeen = false;
  while (!signal?.aborted) {
    const seen = readAlive(deps.workDir);
    const fresh = seen && new Date(seen.at).getTime() >= born ? seen : null;
    if (fresh) everSeen = true;
    // SoftwareFactory never showed up (it did not start): nothing to watch, so the watchdog does not sit there for good.
    if (!everSeen && now().getTime() - born > (deps.giveUpMs ?? 120_000)) return;
    const v = look(fresh, deps.settings(), state, now());
    if (v.endRoom) {
      // One more look right before ending the room: if another SoftwareFactory has started meanwhile, its run is not ours to end.
      const again = readAlive(deps.workDir);
      const other = again && fresh && again.pid !== fresh.pid && !again.closed && (now().getTime() - new Date(again.at).getTime()) / 1000 <= deps.settings().goneSeconds;
      if (other) continue;
      await deps.endRoom().catch(() => undefined);
    }
    if (v.say) { state.spoke[v.say.key] = true; await speak(deps, v.say); }
    if (v.done) return;
    await new Promise((ok) => setTimeout(ok, everyMs));
  }
}
