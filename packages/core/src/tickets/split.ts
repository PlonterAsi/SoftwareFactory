import type { EventLog } from "../events.js";
import type { AgentRuntime } from "../runtime.js";
import type { AgentBay } from "../bay/bay.js";
import { runAgent } from "../agents.js";
import { kitArgs, kitOf } from "../factory/crew.js";
import type { TicketKind, TicketStatus, TicketView } from "./model.js";
import { AUTO_KINDS, isClosed } from "./model.js";
import type { OpenTicket } from "./shapes.js";

/**
 * SF-66: the standing auto-work limit starts ready bugs and tasks by itself, but a ticket sized L waited for a person
 * forever ("Size L: split it into smaller tickets"), so the crew sat idle beside work it was allowed to do. The
 * Overseer now splits it on its own: one short call that turns it into two to five subtasks sized S or M, in the order
 * they should be built. Each subtask is ready, so the queue takes them like any other, and each builds on the ones
 * before it (SF-29). The ticket itself is worked through its subtasks and rolls up when they are done.
 */

/** What one split call may spend, from today's auto-work limit (inside the share the Overseer's reads may use). */
export const SPLIT_CAP_USD = 0.15;

export const SPLIT_CONTRACT = [
  "Station contract: split. You are splitting one ticket of SoftwareFactory that is too big for one Builder session into subtasks.",
  "Give 2 to 5 subtasks, in the order they should be built: each one a change one Builder session can make and test on its own (size S: one small change; M: a few files), building on the ones before it.",
  "Together they must do everything the ticket asks. Do not add work it does not ask for. Each body says what to change and how to know it works, in 1 to 4 sentences.",
  'Answer with ONE fenced json block and nothing else, shaped exactly like: {"subtasks": [{"title": "short imperative title", "body": "what to change and how to know it works", "size": "S"}]}',
].join("\n");

export interface SplitPart { title: string; body: string; size: "S" | "M" }

/** The subtasks in an Overseer's answer, or null when it gave no usable list (fewer than two, or no json). */
export function parseSplit(text: string): SplitPart[] | null {
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let parsed: unknown;
  try { parsed = JSON.parse(block); } catch { return null; }
  const list = (parsed as { subtasks?: unknown })?.subtasks;
  if (!Array.isArray(list)) return null;
  const parts = list
    .map((x) => x as { title?: unknown; body?: unknown; size?: unknown })
    .filter((x) => typeof x.title === "string" && x.title.trim())
    .slice(0, 5)
    .map((x) => ({
      title: String(x.title).trim().slice(0, 120),
      body: typeof x.body === "string" ? x.body.trim().slice(0, 2000) : "",
      // A part the Overseer still calls L goes in as M: splitting again would go past three levels.
      size: (String(x.size).toUpperCase() === "S" ? "S" : "M") as "S" | "M",
    }));
  return parts.length >= 2 ? parts : null;
}

/**
 * Why the Overseer does not split this ticket on its own, or null if it may: a ready bug or task sized L, in a
 * project, with no subtasks yet, that may hold subtasks (an epic's ticket or a top-level one, never a subtask: three
 * levels, never more), not blocked, not taken by you, not held, and not split before.
 */
export function splitRefusal(t: Pick<TicketView, "kind" | "status" | "size" | "project" | "blocked" | "assignee" | "children" | "parentId">, o: { parentKind?: TicketKind | null; handBrake?: boolean; triedBefore?: boolean }): string | null {
  if (t.status !== "ready" || t.size !== "L" || !AUTO_KINDS.includes(t.kind)) return "not a ready bug or task sized L";
  if (t.project == null) return "in no project";
  if (t.children.total > 0) return "already has subtasks";
  if (t.parentId != null && o.parentKind !== "plan") return "a subtask cannot hold subtasks";
  if (t.blocked) return "blocked";
  if (t.assignee === "you") return "you took it";
  if (o.handBrake) return "the thread says to hold it";
  if (o.triedBefore) return "the Overseer tried to split it before";
  return null;
}

/** What a split needs from the ticket store (Tickets passes itself). */
export interface SplitHost {
  log: EventLog;
  get(id: number): TicketView | undefined;
  open(o: OpenTicket): TicketView;
  edit(id: number, field: string, value: unknown, by?: string): TicketView;
  say(id: number, text: string, opts?: { status?: TicketStatus; by?: string; kind?: "note" | "reply" | "event"; costUsd?: number }): TicketView;
}

/** The Overseer has tried to split this ticket before (a split is tried once; after that it is yours). */
export function splitTried(log: EventLog, id: number): boolean {
  return !!log.db.prepare("SELECT 1 FROM events WHERE type = 'ticket.noted' AND json_extract(payload, '$.id') = ? AND json_extract(payload, '$.split') = 1 LIMIT 1").get(id);
}

/**
 * One split: the Overseer reads the ticket's work document and answers with its subtasks, which are opened under it,
 * sized and ready, in build order. Every note is the dispatcher's with `triage: 1`, so it counts against the share of
 * today's auto-work limit the Overseer's reads may use, and `split: 1`, so it is tried once.
 */
export async function splitTicket(h: SplitHost, runtime: AgentRuntime, bay: AgentBay | undefined, t: TicketView, document: string): Promise<{ ids: number[]; costUsd: number; error?: string }> {
  const a = bay?.get("overseer");
  const note = (text: string, capUsd: number) => h.log.append("ticket.noted", { id: t.id, by: "dispatcher", auto: 1, triage: 1, split: 1, capUsd, kind: "event", text });
  note(`It is sized L, too big for one Builder session, so the Overseer splits it on its own into subtasks the crew can take one by one (up to $${SPLIT_CAP_USD.toFixed(2)}, from today's auto-work limit). Write "hold" on the thread to keep the crew off it.`, 0);
  const run = await runAgent(h.log, runtime, a?.def.id ?? "overseer", {
    prompt: document,
    model: a?.def.model ?? "haiku",
    systemPrompt: `${a?.def.prompt ?? "You are a careful engineer."}\n\n${SPLIT_CONTRACT}`,
    budgetUsd: SPLIT_CAP_USD,
    ...(a ? kitArgs(kitOf(a.def)) : {}),
  }, { agentVersion: a?.version, station: "ticket", ticket: t.id });
  const costUsd = run.result?.costUsd ?? 0;
  const spent = Number(costUsd.toFixed(4));
  const parts = run.result ? parseSplit(run.result.text) : null;
  if (!parts) {
    const why = run.error ?? "it gave no usable list of subtasks";
    note(`The Overseer could not split it (${why}) for $${costUsd.toFixed(2)}. Split it yourself, or press Work it to give it the Feature flow.`, spent);
    return { ids: [], costUsd, error: why };
  }
  // Still the same ticket as when the call started: you may have taken it, held it or split it meanwhile.
  const now = h.get(t.id);
  if (!now || now.status !== "ready" || now.children.total > 0 || now.assignee === "you") {
    note(`The Overseer's split came back for $${costUsd.toFixed(2)}, but the ticket changed meanwhile, so nothing was added.`, spent);
    return { ids: [], costUsd };
  }
  const ids: number[] = [];
  for (const p of parts) {
    const c = h.open({ kind: t.kind, title: p.title, body: p.body, parent: t.id, project: t.project, priority: t.priority, by: "overseer", source: "factory" });
    h.edit(c.id, "size", p.size, "overseer");
    h.say(c.id, `Split from ${t.key} by the Overseer: part ${ids.length + 1} of ${parts.length}.`, { by: "overseer", kind: "reply", status: "ready" });
    ids.push(c.id);
  }
  const keys = ids.map((id) => h.get(id)?.key ?? `#${id}`);
  note(`Split by the Overseer into ${keys.join(", ")} for $${costUsd.toFixed(2)}. The crew takes them in this order, each building on the ones before; this ticket rolls up when they are done.`, spent);
  return { ids, costUsd };
}

/**
 * Where a bug or task stands once all its subtasks are done (SF-66): closed when every one is closed (merged or
 * rejected), built for your look when some wait for a look, or null while any is still open. Epics and taste
 * kinds roll up their own way.
 */
export function splitRollUp(parent: Pick<TicketView, "kind" | "status">, childStatuses: TicketStatus[]): { status: TicketStatus; text: string } | null {
  if (!AUTO_KINDS.includes(parent.kind) || !childStatuses.length || isClosed(parent.status)) return null;
  const n = childStatuses.length;
  const s = n === 1 ? "" : "s";
  if (childStatuses.every(isClosed)) return { status: "closed", text: `All ${n} subtask${s} are closed, so this is done.` };
  if (childStatuses.every((x) => x === "built" || isClosed(x)) && parent.status !== "built") return { status: "built", text: `All ${n} subtask${s} are built. Take a look at the ones waiting for it.` };
  return null;
}
