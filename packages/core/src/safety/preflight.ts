import { statfsSync } from "node:fs";
import type { EventLog } from "../events.js";
import { isSignInError, type CrewMode, type ToolCheck } from "../setup.js";

/**
 * Preflight: a free look at whether this PC can do paid work, taken before anything costs money (spec 3.1,
 * "a preflight step before a run spends money"). Plain code, no agent call:
 *
 *   git      the factory keeps every app in a repo, and tickets work in clones
 *   claude   the real crew runs Claude Code (the practice crew needs nothing)
 *   signin   the last agent call did not fail on sign-in in the last 30 minutes (auto-work only: a person's
 *            press goes through, since a signed-out call costs nothing and its success clears the hold;
 *            after 30 minutes auto-work tries once more by itself)
 *   disk     at least 1 GB free where SF keeps projects and working copies
 *
 * A failed check holds auto-work and refuses a Build or a ticket's Work it with the sentence that says what
 * to fix, instead of a paid run that dies on its first call.
 */
export type PreflightId = "git" | "claude" | "signin" | "disk";
export interface PreflightItem { id: PreflightId; ok: boolean; text: string }
export interface PreflightReport { ok: boolean; items: PreflightItem[]; problem: string | null }

export const PREFLIGHT_MIN_FREE_BYTES = 1024 ** 3;

export interface PreflightInput {
  mode: CrewMode;
  git: Pick<ToolCheck, "found">;
  claude: Pick<ToolCheck, "found" | "version">;
  /** Free bytes where SF works, or null when it cannot be read (then the check passes: unknown is not a stop). */
  freeBytes: number | null;
  /** The newest agent call that ended, failed or not. */
  lastCall?: { failed: boolean; raw?: string; at?: string } | null;
  /** A person pressed: the sign-in hold does not apply (auto-work is what it holds). */
  manual?: boolean;
  now?: number;
}

export const SIGNIN_HOLD_MS = 30 * 60_000;

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;

export function preflight(i: PreflightInput): PreflightReport {
  const items: PreflightItem[] = [
    i.git.found
      ? { id: "git", ok: true, text: "Git is installed." }
      : { id: "git", ok: false, text: "Git is not installed, so the factory has nowhere to keep what it builds. Install Git for Windows (git-scm.com/download/win)." },
  ];
  if (i.mode === "real") {
    items.push(i.claude.found
      ? { id: "claude", ok: true, text: `Claude Code is installed${i.claude.version ? ` (${i.claude.version})` : ""}.` }
      : { id: "claude", ok: false, text: "Claude Code is not installed, so the real crew cannot work. Install it and sign in, or switch to the practice crew." });
    const recent = !i.lastCall?.at || (i.now ?? Date.now()) - Date.parse(i.lastCall.at) < SIGNIN_HOLD_MS;
    const signedOut = !i.manual && !!i.lastCall?.failed && recent && isSignInError(i.lastCall.raw ?? "");
    items.push(signedOut
      ? { id: "signin", ok: false, text: "Claude Code's last call failed because it is not signed in. Open a terminal, run `claude`, sign in, then try again." }
      : { id: "signin", ok: true, text: "No sign-in failure since the last call that worked." });
  }
  if (i.freeBytes == null) items.push({ id: "disk", ok: true, text: "Free disk space could not be read; not holding work for it." });
  else if (i.freeBytes < PREFLIGHT_MIN_FREE_BYTES) items.push({ id: "disk", ok: false, text: `Only ${gb(i.freeBytes)} free where SF keeps projects; a build needs at least ${gb(PREFLIGHT_MIN_FREE_BYTES)}. Free some space, then try again.` });
  else items.push({ id: "disk", ok: true, text: `${gb(i.freeBytes)} free.` });
  const bad = items.find((x) => !x.ok);
  return { ok: !bad, items, problem: bad?.text ?? null };
}

/** Free bytes on the disk that holds `dir`, or null when the system will not say. */
export function freeBytesAt(dir: string): number | null {
  try { const s = statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}

/** The newest real agent call that ended: a failure counts only until a call succeeds after it. */
export function lastAgentCall(log: EventLog): { failed: boolean; raw?: string; at?: string } | null {
  const row = log.db.prepare("SELECT type, ts, payload FROM events WHERE type IN ('agent.run.completed', 'agent.run.failed') ORDER BY id DESC LIMIT 1").get() as { type: string; ts: string; payload: string } | undefined;
  if (!row) return null;
  if (row.type === "agent.run.completed") return { failed: false, at: row.ts };
  try { const p = JSON.parse(row.payload) as { raw?: string; error?: string }; return { failed: true, raw: String(p.raw ?? p.error ?? ""), at: row.ts }; } catch { return { failed: true, at: row.ts }; }
}
