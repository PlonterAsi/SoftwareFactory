import { createHash } from "node:crypto";
import type { EventLog } from "../events.js";
import type { Tickets } from "./tickets.js";
import type { TicketView } from "./model.js";

/**
 * Every error becomes a bug ticket by itself, with what was around it. The
 * idea comes from the error rule in Assaf's suite: no error is lost in a log
 * nobody reads, nothing is sent to an outside service, and secrets never
 * leave.
 *
 *   - one bug per error, not per occurrence: the fingerprint is the message
 *     with its numbers and quoted values blanked, plus the first stack frame
 *     without line numbers, so the same fault after an edit is still one bug;
 *   - a repeat adds "Seen again" to the thread, at most once in ten minutes,
 *     counting the ones in between;
 *   - a repeat after you closed the bug opens a new one linked to the old,
 *     because a closed ticket never moves by itself; a rejected one stays
 *     rejected (you said it is not a bug);
 *   - at most `perHour` new bugs an hour, so a loop of errors cannot bury the
 *     list; the rest are counted, and the count is said on the next one.
 */

export interface CapturedError {
  message: string;
  stack?: string;
  /** Where it happened: a route ("POST /api/tickets"), a screen ("bridge #/p/3/tickets"), a job. */
  where: string;
  /** core, bridge or shell. */
  from?: string;
  /** What was around it: the screen, the last events, the request. Scrubbed and capped. */
  context?: Record<string, unknown>;
  project?: number | null;
}

export interface CaptureResult { ticket: number; again: boolean }

/** Tokens and keys never reach a ticket. */
export function scrub(text: string): string {
  return text
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[token]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[key]")
    .replace(/\b(xox[abpr]-[A-Za-z0-9-]{10,})\b/g, "[token]")
    .replace(/\b(Bearer|token|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [secret]")
    .replace(/((?:password|passwd|secret|api[_-]?key|token|authorization)["']?\s*[:=]\s*["']?)(?!Bearer\b|Basic\b|token\b|\[)[^\s"',;}]{4,}/gi, "$1[secret]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1[secret]@");
}

const normal = (m: string) => m.replace(/(["'`]).*?\1/g, "…").replace(/\b0x[0-9a-f]+\b|\d+(\.\d+)?/gi, "N").replace(/\s+/g, " ").trim().slice(0, 200);

/** The first frame of the stack that is ours, without line and column. */
function firstFrame(stack?: string): string {
  const lines = (stack ?? "").split("\n").map((l) => l.trim()).filter((l) => /^at\s|@/.test(l));
  const ours = lines.find((l) => !/node:internal|node_modules|<anonymous>/.test(l)) ?? lines[0] ?? "";
  // No line or column, no query string (Vite adds ?t=...), no folders: the same function in the same file.
  return ours.replace(/\?[^\s):]*/g, "").replace(/(:\d+)+(\)?)$/, "$2").replace(/[^\s(@]*[\\/]/g, "");
}

export function errorFingerprint(e: Pick<CapturedError, "message" | "stack" | "from">): string {
  const h = createHash("sha1").update(`${e.from ?? "core"}|${normal(e.message)}|${firstFrame(e.stack)}`).digest("hex").slice(0, 16);
  return `error:${h}`;
}

/** A thrown error that is a fault in the code, not a sentence for the person ("A ticket needs a title"). */
export function isFault(e: unknown): boolean {
  if (!(e instanceof Error)) return true;
  if (e instanceof SyntaxError) return false; // a body that is not JSON: the caller's mistake
  if ((e as { code?: string }).code?.startsWith?.("SQLITE_CONSTRAINT")) return false;
  return e.constructor !== Error;
}

/** What was around an error, one "key: value" line each; the ticket page shows text as it is. */
function lines(o: Record<string, unknown>): string {
  return Object.entries(o).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length)).map(([k, v]) =>
    Array.isArray(v) ? `${k}:\n${v.map((x) => `  - ${typeof x === "object" ? Object.values(x as object).join("  ") : String(x)}`).join("\n")}`
      : `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join("\n");
}

export class ErrorCapture {
  private hour = { start: 0, opened: 0, dropped: 0 };
  private lastNote = new Map<string, { at: number; since: number; noted?: boolean }>();
  /** Off while an error is being filed, so a fault in filing cannot loop. */
  private busy = false;

  constructor(private log: EventLog, private tickets: Tickets, private opts: { perHour?: number; now?: () => number; /** Where an error with no project of its own is filed (SoftwareFactory's own project). */ project?: () => number | null } = {}) {}

  private now() { return this.opts.now?.() ?? Date.now(); }

  capture(c: CapturedError): CaptureResult | null {
    if (this.busy) return null;
    this.busy = true;
    try { return this.file(c); } catch (err) { console.error("could not file an error as a ticket:", err); return null; } finally { this.busy = false; }
  }

  private file(c: CapturedError): CaptureResult | null {
    const message = scrub(String(c.message ?? "Unknown error")).split("\n")[0].slice(0, 300) || "Unknown error";
    const stack = c.stack ? scrub(String(c.stack)).split("\n").slice(0, 30).join("\n").slice(0, 6000) : "";
    const where = scrub(String(c.where ?? "")).slice(0, 200);
    const from = String(c.from ?? "core");
    const fp = errorFingerprint({ message, stack, from });
    const db = this.log.db;
    const same = db.prepare("SELECT id, status FROM tickets WHERE fingerprint = ? OR fingerprint LIKE ? ORDER BY id DESC LIMIT 1").get(fp, `${fp}@%`) as { id: number; status: string } | undefined;
    const now = this.now();

    if (same && same.status !== "closed") {
      // Rejected stays rejected; anything open hears about it, now and then.
      const n = this.lastNote.get(fp);
      if (n && now - n.at < 10 * 60_000) { n.since++; return { ticket: Number(same.id), again: true }; }
      const times = (n?.since ?? 0) + 1;
      const more = times > 1 ? `, ${times} times since ${n?.noted ? "the last note" : "it was filed"}` : "";
      this.log.append("ticket.noted", { id: Number(same.id), kind: "event", text: `Seen again${where ? ` in ${where}` : ""}${more}.`, by: "error catcher" });
      this.lastNote.set(fp, { at: now, since: 0, noted: true });
      return { ticket: Number(same.id), again: true };
    }

    if (now - this.hour.start > 3600_000) this.hour = { start: now, opened: 0, dropped: this.hour.dropped };
    if (this.hour.opened >= (this.opts.perHour ?? 20)) { this.hour.dropped++; return null; }
    this.hour.opened++;

    const context = c.context ? scrub(lines(c.context)).slice(0, 4000) : "";
    const dropped = this.hour.dropped;
    this.hour.dropped = 0;
    const body = [
      `${from === "bridge" ? "The Bridge" : from === "shell" ? "The app window" : "The core"} hit an error${where ? ` in ${where}` : ""}:`,
      `\n${message}`,
      stack ? ["", "Stack:", stack].join("\n") : "",
      context ? ["", "Around it:", context].join("\n") : "",
      same ? `\nThis happened before as #${same.id}, which you closed.` : "",
      dropped ? `\n${dropped} more error${dropped === 1 ? " was" : "s were"} not filed in the last hour (at most ${this.opts.perHour ?? 20} new bugs an hour).` : "",
    ].filter(Boolean).join("\n");
    const t: TicketView = this.tickets.open({
      kind: "bug", title: `Error${where ? ` in ${where.split(" ").slice(0, 2).join(" ")}` : ""}: ${message}`.slice(0, 90),
      body, by: "error catcher", source: "error", severity: from === "core" && /uncaught/i.test(where) ? "blocking" : "annoying",
      answers: { expected: "No error." },
      fingerprint: same ? `${fp}@${now}` : fp, tags: ["error", from], project: c.project ?? this.opts.project?.() ?? null,
      links: same ? [{ to: Number(same.id), relation: "related" }] : undefined,
    });
    this.lastNote.set(fp, { at: now, since: 0 });
    return { ticket: t.id, again: false };
  }
}
