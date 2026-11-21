import type { EventLog } from "../events.js";
import type { NoteView, TicketStatus, TicketView } from "./model.js";

/** How a ticket cut off by a restart says so on its thread (SF-94). */
export const INTERRUPTED = "The app closed while the crew was working this";

/**
 * SF-94: where a light-route ticket a restart cut off goes back to, and what its thread says. It returns to the status
 * it had before the crew took it (ready or open); one already cut off twice goes back to open, for a person to look at.
 */
export function recoveryOf(notes: NoteView[]): { status: TicketStatus; text: string } {
  const cut = notes.filter((n) => n.by === "factory" && n.text.startsWith(INTERRUPTED)).length;
  const took = notes.map((n) => n.status).lastIndexOf("in_progress");
  const before = notes.slice(0, Math.max(0, took)).reverse().find((n) => n.status != null && n.status !== "in_progress")?.status;
  const status: TicketStatus = cut >= 2 ? "open" : before === "ready" ? "ready" : "open";
  const text = `${INTERRUPTED} (a restart or the computer going to sleep), so it goes back to ${status === "ready" ? "Ready for the crew" : "Open"}.${cut >= 2 ? " It was cut off twice before, so it waits for you." : " Its clone and branch are kept; the next pass picks up from there."}`;
  return { status, text };
}

/**
 * SF-94: work a restart or the PC going to sleep cut off. Called once when the core starts, after the engine's own
 * runs were resumed: a ticket still In progress on the light route (a Builder session in its clone, no factory run)
 * has nobody working it in this process, and nothing else ever moved it on (SF-81 sat In progress for 16 hours).
 * It goes back in line (recoveryOf), so the dispatcher can take it again within the auto-work caps (asked work counts
 * each start against its own try cap). Its clone and branch stay as they were. Each note is a ticket event, which asks
 * the dispatcher to look again. Returns the ticket ids put back.
 */
export function recoverInterrupted(inProgress: TicketView[], isWorking: (t: TicketView) => boolean, notes: (id: number) => NoteView[], log: EventLog): number[] {
  const out: number[] = [];
  for (const t of inProgress) {
    if (t.run != null || isWorking(t)) continue;
    const { status, text } = recoveryOf(notes(t.id));
    log.append("ticket.noted", { id: t.id, by: "factory", kind: "event", status, text });
    out.push(t.id);
  }
  return out;
}
