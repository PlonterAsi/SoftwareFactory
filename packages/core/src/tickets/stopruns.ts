import type { EventLog, SfEvent } from "../events.js";
import type { Factory } from "../factory/loop.js";
import { isClosed, type TicketStatus } from "./model.js";

/**
 * SF-115: closing a ticket stops its runs. A ticket closed by hand, as a duplicate, or rejected no longer wants the
 * work, so each engine run started on it that is still at work, parked at a gate, or stopped and waiting to resume
 * is stopped for good (Factory.stop). The ticket's thread says which runs were stopped. Runs already ended are left.
 * Returns a function that stops listening.
 */
export function stopRunsOnClose(log: EventLog, factory: Pick<Factory, "stop" | "isActive" | "resumable">): () => void {
  const onEvent = (e: SfEvent) => {
    if (e.type !== "ticket.noted") return;
    const p = e.payload as { id?: number; status?: string; by?: string };
    if (p.id == null || !p.status || !isClosed(p.status as TicketStatus)) return;
    const runs = log.db.prepare("SELECT run FROM ticket_runs WHERE ticket_id = ? ORDER BY run").all(Number(p.id)) as { run: number }[];
    const stopped: number[] = [];
    for (const { run } of runs) {
      if (!factory.isActive(run) && !factory.resumable(run).ok) continue;
      const r = factory.stop(run, { by: p.by && p.by !== "you" ? p.by : "you", reason: "Its ticket was closed, so the run stopped." });
      if (r.ok) stopped.push(run);
    }
    if (stopped.length) log.append("ticket.noted", { id: Number(p.id), by: "factory", kind: "event", text: `The ticket is closed, so ${stopped.length === 1 ? `run #${stopped[0]} was` : `runs ${stopped.map((r) => `#${r}`).join(", ")} were`} stopped.` });
  };
  log.on("event", onEvent);
  return () => { log.off("event", onEvent); };
}
