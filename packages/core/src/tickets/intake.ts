import type { EventLog } from "../events.js";
import type { OrderState } from "../order/model.js";
import { createProject, linkToProject, listProjects, projectDetail, projectOf, updateProject } from "../projects/service.js";
import type { Tickets } from "./tickets.js";
import { titleFrom, type TicketKind, type TicketView } from "./model.js";

/**
 * Not every idea is a project. "UI/UX improvement of SoftwareFactory" and
 * "Error handling and logs for all projects" are asks about things that
 * exist, so they belong on a ticket of that thing, not on a project of their
 * own (Assaf, 11 Nov 2026).
 *
 *   - SoftwareFactory has a project of its own (linked `self:softwarefactory`),
 *     so asks about the app itself, and the errors it catches, have a home;
 *   - the intake reads an idea before it becomes a project and says when it
 *     sounds like an ask about an existing project, offering a ticket there;
 *     it is a word check, free and instant, and it only offers: you choose;
 *   - an existing project can be turned into a ticket on another project: its
 *     description and notes become the ticket, its things move along, and the
 *     project is archived with a pointer to the ticket.
 */

export const SELF = { kind: "self", ref: "softwarefactory" } as const;
const SELF_SUMMARY = "SoftwareFactory itself: asks, bugs and ideas about this app. Errors the app catches are filed here.";

/** The SoftwareFactory project, made the first time it is needed. `node` makes it an Order Engine home, like any project you make. */
export function ensureSelfProject(log: EventLog, node?: (name: string) => number): number {
  const have = selfProject(log);
  if (have != null) return have;
  const id = createProject(log, { name: "SoftwareFactory", kind: "app", summary: SELF_SUMMARY, onTaken: "version" });
  linkToProject(log, id, SELF.kind, SELF.ref);
  if (node) linkToProject(log, id, "order_node", node("SoftwareFactory"));
  return id;
}

export function selfProject(log: EventLog): number | null {
  const has = log.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_links'").get();
  return has ? projectOf(log, SELF) : null;
}

export interface IntakeVerdict {
  /** project: start one. ask: it reads like an ask about an existing project. */
  verdict: "project" | "ask";
  projectId?: number;
  projectName?: string;
  /** The ticket kind it reads as. */
  kind?: TicketKind;
  /** One sentence for the person: why it reads that way. */
  why?: string;
  /** high: it names the project. low: it only sounds like an ask. */
  confidence?: "high" | "low";
  /** The same ask is already an open ticket there: open it rather than file it twice. */
  existing?: { id: number; title: string; status: string };
}

/** An open ticket on the project with the same title as this text, if there is one. */
export function filedAlready(log: EventLog, projectId: number, text: string): IntakeVerdict["existing"] | undefined {
  const has = log.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tickets'").get();
  if (!has) return undefined;
  const r = log.db.prepare("SELECT id, title, status FROM tickets WHERE project = ? AND status NOT IN ('closed', 'rejected') AND lower(trim(title)) = lower(trim(?)) ORDER BY id LIMIT 1")
    .get(projectId, titleFrom(text)) as { id: number; title: string; status: string } | undefined;
  return r ? { id: Number(r.id), title: r.title, status: r.status } : undefined;
}

const SELF_WORDS = /\b(software\s?factory|the factory|the bridge|this app|the app itself|the overseer|agent bay|order (engine|deck)|star map|data vault|ticket system|improvement council|all (of )?(my |the )?projects|every project|each project)\b/i;
const ASK_WORDS = /\b(ui\s*\/?\s*ux|ux|ui|improve(ment)?s?|improving|fix(es|ing)?|polish|redesign|refactor|clean ?up|error handling|errors?|logs?|logging|better|bugs?|crash(es)?|broken|slow|faster|performance|speed up|support for|integrat(e|ion) with|setting|settings|option to)\b/i;
const BUILD_WORDS = /\b(build|make|create|write|start)\s+(me\s+)?(an?|the|my)\s+(new\s+)?([\w-]+\s+){0,3}(app|application|tool|cli|website|site|page|game|script|bot|library|service|api|extension|plugin)\b|\bnew (app|tool|project|game|site|website)\b/i;
const BUG_WORDS = /\b(bug|crash(es|ed)?|broken|does ?n[o']t work|not working|fails?|failed|error\b(?!\s+handling))/i;
const STOP = new Set(["the", "and", "for", "with", "app", "project", "tool", "new", "my", "our", "of", "a", "an", "to", "in", "on", "improvement", "improvements"]);
const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9א-ת]+/).filter((w) => w.length >= 3 && !STOP.has(w));

/** Read an idea before it becomes a project. Free: words only, no agent call. */
/** `exclude`: a project asking about itself (its own name) is not an ask about another. */
export function classifyIntake(log: EventLog, text: string, exclude?: number): IntakeVerdict {
  const t = text.trim();
  if (!t) return { verdict: "project" };
  const kind: TicketKind = BUG_WORDS.test(t) ? "bug" : "request";
  const self = selfProject(log);
  const lower = ` ${t.toLowerCase()} `;

  // It names a project you have (not SoftwareFactory, which the self words cover).
  const named = listProjects(log).filter((p) => p.status !== "archived" && p.id !== self && p.id !== exclude).map((p) => {
    const name = p.name.toLowerCase().trim();
    const words = tokens(p.name);
    const whole = name.length >= 4 && lower.includes(name);
    const all = words.length > 0 && words.every((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t));
    return { p, score: whole ? 2 : all ? 1 : 0 };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || b.p.name.length - a.p.name.length)[0];
  if (named && (ASK_WORDS.test(t) || !BUILD_WORDS.test(t))) {
    return { verdict: "ask", projectId: named.p.id, projectName: named.p.name, kind, confidence: "high", why: `It names your project "${named.p.name}".` };
  }
  if (SELF_WORDS.test(t)) {
    return { verdict: "ask", projectId: self ?? undefined, projectName: "SoftwareFactory", kind, confidence: "high", why: /all (of )?(my |the )?projects|every project|each project/i.test(t) ? "It is something every project would get, and that is built into SoftwareFactory itself." : "It is about SoftwareFactory itself." };
  }
  if (ASK_WORDS.test(t) && !BUILD_WORDS.test(t)) {
    return { verdict: "ask", projectId: self ?? undefined, projectName: "SoftwareFactory", kind, confidence: "low", why: "It reads like a change to something that exists rather than a new thing to build." };
  }
  return { verdict: "project" };
}

export interface TurnedIntoTicket { ticket: TicketView; from: number; to: number; moved: number }

/**
 * Turn a project into a ticket on another project. The ticket gets the
 * project's name, description and notes; its notes, runs and tickets move to
 * the other project; the project is archived and says where it went.
 */
export function projectToTicket(log: EventLog, tickets: Tickets, order: Pick<OrderState, "fragments"> | null, from: number, o: { to: number; kind?: TicketKind; by?: string }): TurnedIntoTicket {
  const p = projectDetail(log, from);
  if (!p) throw new Error(`No project #${from}`);
  const target = projectDetail(log, o.to);
  if (!target) throw new Error(`No project #${o.to}`);
  if (from === o.to) throw new Error("A project cannot become a ticket on itself.");
  if (p.links.some((l) => l.kind === SELF.kind)) throw new Error("SoftwareFactory's own project stays a project.");
  if (p.status === "archived") throw new Error(`"${p.name}" is archived already.`);

  const nodes = new Set(p.nodeIds.map(Number));
  const notes = (order?.fragments ?? []).filter((f) => f.nodeId != null && nodes.has(Number(f.nodeId))).map((f) => `- ${f.text.replace(/\s+/g, " ").slice(0, 300)}`);
  const runs = p.runs.map((r) => `- run #${r.id}${r.outcome ? ` (${r.outcome})` : ""}: ${String(r.idea ?? "").split("\n")[0].slice(0, 120)}`);
  const body = [
    p.summary.trim(),
    notes.length ? ["", "Notes from the project:", ...notes.slice(0, 40)].join("\n") : "",
    runs.length ? ["", "Runs it had:", ...runs.slice(0, 20)].join("\n") : "",
    "", `Turned into a ticket from the project "${p.name}" (#${p.id}).`,
  ].filter((x) => x !== "").join("\n").trim();
  const kind: TicketKind = o.kind ?? "request";
  const ticket = tickets.open({
    kind, title: p.name, body, project: o.to, by: o.by ?? "you", source: o.by && o.by !== "you" ? "agent" : "you",
    answers: kind === "request" ? { need: p.summary.trim() || p.name } : kind === "task" ? { todo: p.summary.trim() || p.name } : kind === "idea" ? { core: p.summary.trim() || p.name } : {},
    fingerprint: `project:${p.id}`, ref: { project: p.id },
  });

  // Its things go where the work now lives: notes, runs, and the tickets it had.
  let moved = 0;
  // Its idea nodes fold into the other project's home node, so the star map shows one body, not two.
  const home = target.rootNodeIds[0];
  if (home != null && order) {
    for (const n of p.rootNodeIds) {
      if (Number(n) === Number(home)) continue;
      const frags = order.fragments.filter((f) => Number(f.nodeId) === Number(n)).map((f) => ({ fragmentId: f.id, from: Number(n) }));
      log.append("order.sweep", { action: "merge", nodeId: Number(n), intoNodeId: Number(home), moved: frags, reason: `"${p.name}" was turned into ticket #${ticket.id} on ${target.name}.` });
    }
  }
  for (const l of p.links) {
    if (l.kind === "order_node" || l.kind === "factory_run" || l.kind === "ticket" || l.kind === "chat") {
      if (l.kind === "ticket" && Number(l.ref) === ticket.id) continue;
      linkToProject(log, o.to, l.kind, l.ref);
      if (l.kind === "ticket") tickets.edit(Number(l.ref), "project", o.to, o.by ?? "you");
      moved++;
    }
  }
  updateProject(log, from, { status: "archived", summary: `Turned into ticket #${ticket.id} on ${target.name}.${p.summary.trim() ? ` Was: ${p.summary.trim()}` : ""}`.slice(0, 2000) });
  return { ticket: tickets.get(ticket.id)!, from, to: o.to, moved };
}
