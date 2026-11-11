import type { EventLog, SfEvent } from "../events.js";
import { runAgent } from "../agents.js";
import type { AgentRuntime } from "../runtime.js";
import type { Factory } from "../factory/loop.js";
import type { AgentBay } from "../bay/bay.js";
import "./tables.js";
import { projectOf, registerProjectFacet } from "../projects/service.js";
import { EDITABLE } from "./tables.js";
import { branchFor, repoOfProject, workInRepo, type RepoRef } from "./repowork.js";
import { selfProject } from "./intake.js";
import {
  FORMS, HAND_BRAKE, KINDS, PRIORITIES, RELATIONS, TICKET_SEVERITIES, STATUSES, TASTE_KINDS,
  ideaFromTicket, isClosed, keyFromName, keyText, nextMoves, refuseMove, refuseParent, titleFrom, workDocument,
  type LinkView, type NoteView, type Priority, type Relation, type TicketSeverity, type TicketKind, type TicketStatus, type TicketView,
} from "./model.js";

export interface OpenTicket {
  kind?: TicketKind;
  title?: string;
  body?: string;
  answers?: Record<string, string>;
  project?: number | null;
  priority?: Priority | null;
  severity?: TicketSeverity | null;
  assignee?: string | null;
  parent?: number | null;
  tags?: string[];
  /** Who opened it: "you", or an agent id. */
  by?: string;
  /** Where it came from: you, order, council, agent, factory, improve. */
  source?: string;
  /** The same fingerprint twice adds a note to the open ticket instead of a second ticket. */
  fingerprint?: string;
  links?: { relation: Relation; to: number }[];
  /** The `ticket.requested` event this ticket answers, and the requester's own reference. */
  request?: number;
  ref?: unknown;
}

export interface TicketFilter {
  project?: number | null;
  /** open (default), look (built, for your look), agents (an agent works it), plans, closed, all. */
  view?: "open" | "look" | "you" | "agents" | "plans" | "closed" | "all";
  /** Only the children of this epic or ticket. */
  parent?: number;
  kind?: TicketKind;
  status?: TicketStatus;
  q?: string;
  limit?: number;
}

/**
 * Waiting on you: built (take a look), a question (answer it), or an idea or
 * request an agent opened (build it or not). Taste stays yours.
 */
export const WAITING_ON_YOU = `t.status NOT IN ('closed', 'rejected') AND (
  t.status = 'built'
  OR (t.kind = 'question')
  OR (t.kind IN ('idea', 'request') AND t.status = 'open' AND t.opened_by != 'you'))`;

export interface WaitingItem {
  ticket: TicketView;
  projectName: string | null;
  /** look: it is built; answer: a question; decide: an agent's idea or request, build it or not. */
  need: "look" | "answer" | "decide";
  /** One line for the row. */
  say: string;
  /** The moves that answer it from the row itself. */
  moves: { to: TicketStatus; label: string }[];
}

export interface TicketDetail {
  ticket: TicketView;
  notes: NoteView[];
  links: LinkView[];
  lines: TicketView[];
  parent: TicketView | null;
  moves: { to: TicketStatus; label: string }[];
  document: string;
  run: { id: number; outcome: string | null; station: string | null; state: string | null; spentUsd: number | null } | null;
  /** The imported repo this ticket's project came from: "Work it" works there, on a branch of a clone. */
  repo: RepoRef | null;
  /** The Builder is working it in the repo right now. */
  working: boolean;
}

type Row = Record<string, any>;

/**
 * Every read of a ticket goes through this select: the row, its project's key,
 * its parent's kind (for its level), whether an open ticket blocks it, and how
 * many of its children are done. Columns of the ticket itself are `t.`.
 */
const SELECT = `SELECT t.*, k.key AS project_key, p.kind AS parent_kind,
  EXISTS (SELECT 1 FROM ticket_links l JOIN tickets b ON b.id = l.from_id
          WHERE l.to_id = t.id AND l.relation = 'blocks' AND b.status NOT IN ('closed', 'rejected')) AS is_blocked,
  (SELECT count(*) FROM tickets c WHERE c.parent_id = t.id) AS n_children,
  (SELECT count(*) FROM tickets c WHERE c.parent_id = t.id AND c.status IN ('built', 'closed', 'rejected')) AS n_done
  FROM tickets t LEFT JOIN ticket_keys k ON k.project = t.project LEFT JOIN tickets p ON p.id = t.parent_id`;

const toView = (r: Row): TicketView => ({
  id: Number(r.id), key: keyText(r.project_key ?? null, r.number == null ? null : Number(r.number), Number(r.id)), number: r.number == null ? null : Number(r.number),
  level: r.kind === "plan" ? "epic" : r.parent_id == null || r.parent_kind === "plan" ? "ticket" : "subtask",
  blocked: !!r.is_blocked, children: { total: Number(r.n_children ?? 0), done: Number(r.n_done ?? 0) }, kind: r.kind, title: r.title, body: r.body ?? "", answers: JSON.parse(r.answers ?? "{}"), project: r.project == null ? null : Number(r.project),
  status: r.status, priority: r.priority ?? null, severity: r.severity ?? null, assignee: r.assignee ?? null, parentId: r.parent_id == null ? null : Number(r.parent_id),
  lineOrder: r.line_order == null ? null : Number(r.line_order), tags: JSON.parse(r.tags ?? "[]"), source: r.source, openedBy: r.opened_by, fingerprint: r.fingerprint ?? null,
  run: r.run == null ? null : Number(r.run), branch: r.branch ?? null, branchDir: r.branch_dir ?? null, createdAt: r.created_at, updatedAt: r.updated_at, closedAt: r.closed_at ?? null, lastNote: r.last_note ?? null,
});

/** The contract appended to any agent asked about a ticket. The practice crew answers it too. */
export const TICKET_CONTRACT = "Station contract: ticket. You are reading one ticket of SoftwareFactory. Reply in at most 6 short lines: what you understand, the smallest next step, and anything missing. End with one line `STATUS: ready` if it can be built as written, or `STATUS: open` if it needs an answer first.";

/**
 * Tickets: open, edit one field at a time, talk, move, link, plan, and hand a
 * ticket to the crew. Every write is one event; the `tickets` projection keeps
 * the tables. Agents and the factory write back onto the ticket by themselves.
 */
export class Tickets {
  /** Ticket ids being asked of an agent right now (one call at a time per ticket). */
  private asking = new Set<number>();
  /** Tickets the Builder is working in a repo clone right now. */
  private inRepo = new Map<number, Promise<void>>();

  constructor(private log: EventLog, private opts: { runtime?: AgentRuntime; factory?: Factory; bay?: AgentBay; budgetUsd?: number; workRoot?: string } = {}) {
    log.on("event", (e: SfEvent) => {
      try { this.react(e); } catch (err) { console.error("tickets: reacting to", e.type, "failed:", err); }
    });
  }

  // ---- reading -------------------------------------------------------------

  get(id: number): TicketView | undefined {
    const r = this.log.db.prepare(`${SELECT} WHERE t.id = ?`).get(id) as Row | undefined;
    return r ? toView(r) : undefined;
  }

  /** A ticket by what people say: "SF-42", "#7" or "7". */
  byKey(text: string): TicketView | undefined {
    const s = String(text ?? "").trim().toUpperCase();
    const k = s.match(/^([A-Z][A-Z0-9]{1,5})-(\d+)$/);
    if (k) {
      const r = this.log.db.prepare(`${SELECT} WHERE k.key = ? AND t.number = ?`).get(k[1], Number(k[2])) as Row | undefined;
      return r ? toView(r) : undefined;
    }
    const n = s.match(/^#?(\d+)$/);
    return n ? this.get(Number(n[1])) : undefined;
  }

  /**
   * A project's ticket key, given the first time a ticket lands there and kept
   * when the project is renamed: SoftwareFactory's own project is SF; others
   * take letters from their name.
   */
  keyFor(project: number | null): string | null {
    if (project == null) return null;
    const have = this.log.db.prepare("SELECT key FROM ticket_keys WHERE project = ?").get(project) as { key: string } | undefined;
    if (have) return have.key;
    const taken = new Set((this.log.db.prepare("SELECT key FROM ticket_keys").all() as { key: string }[]).map((r) => r.key));
    let key: string;
    if (project === selfProject(this.log) && !taken.has("SF")) key = "SF";
    else {
      const row = this.log.db.prepare("SELECT name FROM projects WHERE id = ?").get(project) as { name: string } | undefined;
      // SF stays free for SoftwareFactory's own project, even before it exists.
      key = keyFromName(row?.name ?? `P${project}`, new Set([...taken, "SF"]));
    }
    this.log.append("ticket.keyed", { project, key });
    return key;
  }

  /** Give a key to every project that has tickets but none yet (tickets opened before keys existed). */
  backfillKeys(): number {
    const rows = this.log.db.prepare("SELECT DISTINCT t.project FROM tickets t LEFT JOIN ticket_keys k ON k.project = t.project WHERE t.project IS NOT NULL AND k.key IS NULL ORDER BY t.project").all() as { project: number }[];
    for (const r of rows) this.keyFor(Number(r.project));
    return rows.length;
  }

  list(f: TicketFilter = {}): TicketView[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    const view = f.view ?? "open";
    if (f.project != null) { where.push("t.project = ?"); args.push(f.project); }
    if (view === "open") where.push("t.status NOT IN ('closed', 'rejected')");
    else if (view === "look") where.push("t.status = 'built'");
    else if (view === "you") where.push(WAITING_ON_YOU);
    else if (view === "agents") where.push("t.status NOT IN ('closed', 'rejected') AND (t.run IS NOT NULL OR (t.assignee IS NOT NULL AND t.assignee != 'you'))");
    else if (view === "plans") where.push("(t.kind = 'plan' OR t.parent_id IS NOT NULL)");
    else if (view === "closed") where.push("t.status IN ('closed', 'rejected')");
    if (f.kind) { where.push("t.kind = ?"); args.push(f.kind); }
    if (f.status) { where.push("t.status = ?"); args.push(f.status); }
    if (f.parent != null) { where.push("t.parent_id = ?"); args.push(f.parent); }
    if (f.q && f.q.trim()) {
      // Reads the title, the description, the answers, the tags and the thread; "#12" finds ticket 12, "SF-4" ticket 4 of SF.
      const q = f.q.trim();
      const n = q.match(/^#?(\d+)$/);
      const k = q.toUpperCase().match(/^([A-Z][A-Z0-9]{1,5})-(\d+)$/);
      const like = `%${q.replace(/[%_]/g, "")}%`;
      where.push(`(${n ? "t.id = ? OR " : ""}${k ? "(k.key = ? AND t.number = ?) OR " : ""}t.title LIKE ? OR t.body LIKE ? OR t.answers LIKE ? OR t.tags LIKE ? OR t.id IN (SELECT ticket_id FROM ticket_notes WHERE text LIKE ?))`);
      if (n) args.push(Number(n[1]));
      if (k) args.push(k[1], Number(k[2]));
      args.push(like, like, like, like, like);
    }
    const order = "CASE t.priority WHEN 'now' THEN 0 WHEN 'this_week' THEN 1 WHEN 'next' THEN 2 WHEN 'someday' THEN 3 ELSE 4 END, t.updated_at DESC";
    // Plans view: each epic, then its tickets in their order, then each ticket's subtasks.
    const tree = "coalesce(p.parent_id, t.parent_id, t.id), CASE WHEN t.parent_id IS NULL THEN 0 ELSE 1 END, coalesce(p.line_order, t.line_order), CASE WHEN p.parent_id IS NULL THEN 0 ELSE 1 END, t.line_order";
    const sql = `${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${view === "plans" ? tree : order} LIMIT ?`;
    args.push(f.limit ?? 200);
    return (this.log.db.prepare(sql).all(...args) as Row[]).map(toView);
  }

  /**
   * Waiting on you, across every project: each ticket with the one thing it
   * needs from you and the moves that answer it, so most take a single tap.
   */
  waiting(project?: number | null): WaitingItem[] {
    const rows = this.list({ view: "you", project: project ?? undefined, limit: 300 });
    const names = new Map((this.log.db.prepare("SELECT id, name FROM projects").all() as { id: number; name: string }[]).map((r) => [Number(r.id), r.name]));
    const why = (t: TicketView): WaitingItem["need"] =>
      t.status === "built" ? "look" : t.kind === "question" ? "answer" : "decide";
    const rank = { look: 0, answer: 1, decide: 2 } as const;
    return rows
      .map((t) => {
        const need = why(t);
        const moves: WaitingItem["moves"] = need === "look" ? nextMoves(t.status, t.kind)
          : need === "decide" ? [{ to: "ready", label: "Yes, build it" }, { to: "rejected", label: "No" }]
          : [];
        return { ticket: t, projectName: t.project != null ? names.get(t.project) ?? null : null, need, moves,
          say: need === "look" ? "Built: take a look" : need === "answer" ? (t.answers.ask && t.answers.ask !== t.title ? t.answers.ask : "Needs your answer") : `${t.kind === "idea" ? "An idea" : "A request"} from ${t.openedBy}: build it?` };
      })
      .sort((a, b) => rank[a.need] - rank[b.need] || b.ticket.updatedAt.localeCompare(a.ticket.updatedAt));
  }

  /** Counts for the chips and the summary line: by status, by kind, waiting for your look. */
  counts(project?: number | null) {
    const scope = project != null ? "WHERE project = ?" : "";
    const args = project != null ? [project] : [];
    const byStatus = Object.fromEntries((this.log.db.prepare(`SELECT status, count(*) AS n FROM tickets ${scope} GROUP BY status`).all(...args) as { status: string; n: number }[]).map((r) => [r.status, Number(r.n)]));
    const byKind = Object.fromEntries((this.log.db.prepare(`SELECT kind, count(*) AS n FROM tickets ${scope ? `${scope} AND` : "WHERE"} status NOT IN ('closed', 'rejected') GROUP BY kind`).all(...args) as { kind: string; n: number }[]).map((r) => [r.kind, Number(r.n)]));
    const open = STATUSES.filter((s) => !isClosed(s)).reduce((n, s) => n + (byStatus[s] ?? 0), 0);
    const oldest = this.log.db.prepare(`SELECT id, title, created_at FROM tickets ${scope ? `${scope} AND` : "WHERE"} status NOT IN ('closed', 'rejected') ORDER BY created_at LIMIT 1`).get(...args) as Row | undefined;
    const you = Number((this.log.db.prepare(`SELECT count(*) AS n FROM tickets t WHERE ${WAITING_ON_YOU}${project != null ? " AND t.project = ?" : ""}`).get(...args) as { n: number }).n);
    return { byStatus, byKind, open, look: byStatus.built ?? 0, you, total: Object.values(byStatus).reduce((a, b) => a + b, 0), oldest: oldest ? { id: Number(oldest.id), title: oldest.title, createdAt: oldest.created_at } : null };
  }

  notes(id: number): NoteView[] {
    return (this.log.db.prepare("SELECT * FROM ticket_notes WHERE ticket_id = ? ORDER BY event_id").all(id) as Row[]).map((r) => ({
      eventId: Number(r.event_id), ts: r.ts, by: r.by_name, kind: r.kind, text: r.text, status: r.status ?? null, costUsd: r.cost_usd ?? null,
    }));
  }

  /** Links seen from this ticket, both ways (a link made on one side shows on the other). */
  links(id: number): LinkView[] {
    const rows = this.log.db.prepare(`SELECT l.from_id, l.to_id, l.relation, t.title, t.status, t.number, k.key FROM ticket_links l JOIN tickets t ON t.id = CASE WHEN l.from_id = ? THEN l.to_id ELSE l.from_id END
      LEFT JOIN ticket_keys k ON k.project = t.project WHERE l.from_id = ? OR l.to_id = ? ORDER BY l.ts`).all(id, id, id) as Row[];
    return rows.map((r) => {
      const out = Number(r.from_id) === id;
      const rel = r.relation as Relation;
      // Seen from the other side, "duplicate of" and "blocks" read backwards.
      const back: Partial<Record<Relation, string>> = { duplicate_of: "duplicated_by", blocks: "blocked_by", derived_from: "spawned" };
      return { from: id, to: out ? Number(r.to_id) : Number(r.from_id), relation: (out ? rel : (back[rel] ?? rel)) as Relation, title: r.title, status: r.status,
        key: keyText(r.key ?? null, r.number == null ? null : Number(r.number), out ? Number(r.to_id) : Number(r.from_id)) };
    });
  }

  lines(planId: number): TicketView[] {
    return (this.log.db.prepare(`${SELECT} WHERE t.parent_id = ? ORDER BY t.line_order`).all(planId) as Row[]).map(toView);
  }

  detail(id: number): TicketDetail | undefined {
    const t = this.get(id);
    if (!t) return undefined;
    const notes = this.notes(id), links = this.links(id), lines = this.lines(id);
    let run: TicketDetail["run"] = null;
    if (t.run != null) {
      const r = this.log.db.prepare("SELECT outcome, total_usd FROM factory_runs WHERE id = ?").get(t.run) as Row | undefined;
      const st = this.log.db.prepare("SELECT payload FROM events WHERE type = 'factory.station' AND json_extract(payload, '$.run') = ? ORDER BY id DESC LIMIT 1").get(t.run) as { payload: string } | undefined;
      const sp = st ? JSON.parse(st.payload) : null;
      run = { id: t.run, outcome: r?.outcome ?? null, station: sp?.station ?? null, state: sp?.state ?? null, spentUsd: r?.total_usd ?? sp?.spentUsd ?? null };
    }
    return {
      ticket: t, notes, links, lines, parent: t.parentId != null ? this.get(t.parentId) ?? null : null,
      moves: nextMoves(t.status, t.kind), document: workDocument(t, notes, links, lines), run,
      repo: repoOfProject(this.log, t.project), working: this.inRepo.has(id),
    };
  }

  document(id: number): string {
    const d = this.detail(id);
    if (!d) throw new Error(`No ticket #${id}`);
    return d.document;
  }

  // ---- writing -------------------------------------------------------------

  open(o: OpenTicket): TicketView {
    const kind: TicketKind = o.kind && KINDS.includes(o.kind) ? o.kind : "task";
    const answers = Object.fromEntries(Object.entries(o.answers ?? {}).filter(([k, v]) => FORMS[kind].some((q) => q.key === k) && String(v ?? "").trim()).map(([k, v]) => [k, String(v).trim().slice(0, 4000)]));
    const body = String(o.body ?? "").trim().slice(0, 20_000);
    // The kind's required question can be answered by the description: nothing is lost for want of a field.
    const req = FORMS[kind].find((q) => q.required);
    if (req && !answers[req.key] && body) answers[req.key] = body.split(/\n\s*\n/)[0].slice(0, 2000);
    const title = titleFrom(String(o.title ?? "").trim() || answers[req?.key ?? ""] || body);
    if (!title) throw new Error("A ticket needs a title or a few words about it.");
    if (req && !answers[req.key]) answers[req.key] = title;
    const by = String(o.by ?? "you");
    if (o.fingerprint) {
      const same = this.log.db.prepare("SELECT id, status FROM tickets WHERE fingerprint = ?").get(o.fingerprint) as { id: number; status: TicketStatus } | undefined;
      if (same) {
        this.log.append("ticket.noted", { id: Number(same.id), kind: "event", text: `Seen again${by !== "you" ? ` by ${by}` : ""}: ${title}`, by });
        return this.get(Number(same.id))!;
      }
    }
    const parent = o.parent != null ? this.get(o.parent) : undefined;
    if (o.parent != null && !parent) throw new Error(`No ticket #${o.parent} to sit under.`);
    const project = o.project ?? parent?.project ?? null;
    if (parent) {
      const why = refuseParent({ kind, project }, { id: parent.id, kind: parent.kind, parentId: parent.parentId, project: parent.project, parentKind: parent.parentId != null ? this.get(parent.parentId)?.kind ?? null : null });
      if (why) throw new Error(why);
    }
    const id = Number((this.log.db.prepare("SELECT coalesce(max(id), 0) + 1 AS n FROM tickets").get() as { n: number }).n);
    this.keyFor(project);
    this.log.append("ticket.opened", {
      id, number: this.nextNumber(project), kind, title, body, answers, project, by, source: o.source ?? (by === "you" ? "you" : "agent"),
      priority: o.priority && PRIORITIES.includes(o.priority) ? o.priority : null,
      severity: kind === "bug" && o.severity && TICKET_SEVERITIES.includes(o.severity) ? o.severity : null,
      assignee: o.assignee ?? null, parent: o.parent ?? null, tags: (o.tags ?? []).map(String).filter(Boolean).slice(0, 12), fingerprint: o.fingerprint ?? null,
      ...(o.request != null ? { request: o.request } : {}), ...(o.ref !== undefined ? { ref: o.ref } : {}),
    });
    this.linkProject(id, project);
    for (const l of o.links ?? []) this.link(id, l.to, l.relation, by);
    return this.get(id)!;
  }

  /** The next ticket number inside a project. */
  private nextNumber(project: number | null): number {
    return Number((this.log.db.prepare("SELECT coalesce(max(number), 0) + 1 AS n FROM tickets WHERE project IS ?").get(project) as { n: number }).n);
  }

  /** Change one field; nothing else is touched. */
  edit(id: number, field: string, value: unknown, by = "you", key?: string): TicketView {
    const t = this.must(id);
    if (field === "answer") {
      if (!key || !FORMS[t.kind].some((q) => q.key === key)) throw new Error(`A ${t.kind} has no question "${key}"`);
      this.log.append("ticket.edited", { id, field, key, value: String(value ?? "").slice(0, 4000), by });
      return this.get(id)!;
    }
    if (field === "status") throw new Error("Move a ticket with a status move, so the thread says why.");
    if (!(field in EDITABLE)) throw new Error(`"${field}" cannot be edited`);
    if (field === "kind" && !KINDS.includes(value as TicketKind)) throw new Error(`Unknown kind "${value}"`);
    if (field === "priority" && value != null && value !== "" && !PRIORITIES.includes(value as Priority)) throw new Error(`Unknown priority "${value}"`);
    if (field === "severity" && value != null && value !== "" && !TICKET_SEVERITIES.includes(value as TicketSeverity)) throw new Error(`Unknown severity "${value}"`);
    if (field === "parent" && value != null && value !== "") {
      const p = this.get(Number(value));
      if (!p) throw new Error(`No ticket #${value} to sit under.`);
      const why = refuseParent({ id, kind: t.kind, project: t.project, hasChildren: t.children.total > 0 },
        { id: p.id, kind: p.kind, parentId: p.parentId, project: p.project, parentKind: p.parentId != null ? this.get(p.parentId)?.kind ?? null : null });
      if (why) throw new Error(why);
    }
    if (field === "kind" && value === "plan" && t.parentId != null) throw new Error("An epic sits at the top: take it out of its parent first.");
    if (field === "kind" && t.kind === "plan" && value !== "plan" && t.children.total > 0) throw new Error("This epic still holds tickets; move them out first.");
    if (field === "title" && !String(value ?? "").trim()) throw new Error("A ticket needs a title.");
    const v = field === "tags" ? (Array.isArray(value) ? value.map(String).filter(Boolean) : String(value ?? "").split(",").map((s) => s.trim()).filter(Boolean))
      : field === "project" || field === "parent" ? (value == null || value === "" ? null : Number(value)) : value;
    if (field === "project") {
      const to = v as number | null;
      if (to === t.project) return t;
      if (t.parentId != null || t.children.total > 0) throw new Error("Move the whole epic, not one of its parts: a ticket and its parent stay in one project.");
      this.keyFor(to);
      this.log.append("ticket.edited", { id, field, value: to, number: this.nextNumber(to), was: t.key, by });
      this.log.append("ticket.noted", { id, by, kind: "event", text: `Was ${t.key}; now ${this.get(id)!.key}` });
      this.linkProject(id, to);
      return this.get(id)!;
    }
    this.log.append("ticket.edited", { id, field, value: v, by });
    // Converting keeps the answers that still fit; the rest stay in the record, unseen.
    return this.get(id)!;
  }

  /** Say something on the thread, and optionally move the status in the same step. */
  say(id: number, text: string, opts: { status?: TicketStatus; by?: string; kind?: "note" | "reply" | "event"; costUsd?: number } = {}): TicketView {
    const t = this.must(id);
    const by = opts.by ?? "you";
    const said = String(text ?? "").trim().slice(0, 8000);
    if (opts.status) {
      if (!STATUSES.includes(opts.status)) throw new Error(`Unknown status "${opts.status}"`);
      const why = refuseMove(t.kind, t.status, opts.status, by);
      if (why) throw new Error(why);
      this.log.append("ticket.noted", { id, by, status: opts.status, text: said || `Moved to ${opts.status.replace("_", " ")}`, kind: opts.kind ?? "note", costUsd: opts.costUsd });
    } else {
      if (!said) throw new Error("Nothing to say.");
      this.log.append("ticket.noted", { id, by, text: said, kind: opts.kind ?? "note", costUsd: opts.costUsd });
    }
    return this.get(id)!;
  }

  link(id: number, to: number, relation: Relation, by = "you", removed = false): TicketView {
    this.must(id); this.must(to);
    if (id === to) throw new Error("A ticket cannot link to itself.");
    if (!RELATIONS.includes(relation)) throw new Error(`Unknown link "${relation}"`);
    this.log.append("ticket.linked", { id, to, relation, by, removed });
    // A duplicate closes with the link that says so.
    const t = this.get(id)!;
    if (!removed && relation === "duplicate_of" && !isClosed(t.status)) this.log.append("ticket.noted", { id, by, status: "closed", text: `Closed as a duplicate of #${to}` });
    return this.get(id)!;
  }

  moveLine(id: number, dir: "up" | "down"): TicketView[] {
    const t = this.must(id);
    if (t.parentId == null) throw new Error("This ticket is not a line of a plan.");
    this.log.append("ticket.line.moved", { id, dir, by: "you" });
    return this.lines(t.parentId);
  }

  /** A new ticket from this one, linked "derived from". */
  spawn(id: number, o: OpenTicket): TicketView {
    const t = this.must(id);
    return this.open({ project: t.project, ...o, links: [...(o.links ?? []), { relation: "derived_from", to: id }] });
  }

  // ---- the crew ------------------------------------------------------------

  /**
   * "Work it": the ticket goes into the factory loop. The run starts from the
   * work document, the ticket moves to in progress, and the run writes back
   * onto the ticket when it ends (see react()).
   */
  work(id: number, o: { maxUsd?: number; autoApprove?: boolean; where?: "auto" | "repo" | "new" } = {}): { ticket: TicketView; run: number | null; branch?: string } {
    const t = this.must(id);
    if (isClosed(t.status)) throw new Error("This ticket is closed; reopen it first.");
    const repo = o.where === "new" ? null : repoOfProject(this.log, t.project);
    if (o.where === "repo" && !repo) throw new Error("This ticket's project has no imported repo to work in.");
    if (repo) return this.workRepo(t, repo, o.maxUsd);
    const factory = this.opts.factory;
    if (!factory) throw new Error("The factory is not running in this core.");
    if (t.run != null && factory.isActive(t.run)) throw new Error(`Run #${t.run} is already working this ticket.`);
    const run = factory.start(ideaFromTicket(t, this.document(id)), { maxUsd: o.maxUsd, autoApprove: o.autoApprove, ...(t.project != null ? { projectId: t.project } : {}) });
    this.log.append("ticket.run", { id, run, by: "you" });
    if (t.status !== "in_progress") this.log.append("ticket.noted", { id, by: "factory", status: "in_progress", text: `The crew took it: factory run #${run}` });
    return { ticket: this.get(id)!, run };
  }

  /** Wait for a ticket's repo work to finish (tests, the CLI). */
  waitRepo(id: number): Promise<void> { return this.inRepo.get(id) ?? Promise.resolve(); }

  /**
   * The ticket's project is an imported repo: the Builder works it on a new
   * branch of a clone (never main, never the original, never pushed) and the
   * ticket says where the branch is. It stays built for your look.
   */
  private workRepo(t: TicketView, repo: RepoRef, maxUsd?: number): { ticket: TicketView; run: null; branch: string } {
    const { runtime, bay, workRoot } = this.opts;
    if (!runtime || !workRoot) throw new Error("No crew or work folder in this core.");
    if (this.inRepo.has(t.id)) throw new Error("The Builder is already working this ticket in the repo.");
    const doc = this.document(t.id);
    const branch = branchFor(t.id, t.title);
    const by = bay?.crewFor("build")[0]?.id ?? "builder";
    this.log.append("ticket.noted", { id: t.id, by, status: t.status === "in_progress" ? undefined : "in_progress", text: `Working it in a clone of ${repo.source}, on a new branch. The original repo is not touched and nothing is pushed.` });
    const job = workInRepo(this.log, runtime, bay, { id: t.id, title: t.title, document: doc, repo, workRoot, maxUsd: Math.min(maxUsd ?? 0.6, 1.5) })
      .then((r) => {
        if (!r.ok) {
          this.log.append("ticket.noted", { id: t.id, by, status: "open", text: `The Builder could not work it: ${r.error}` });
          return;
        }
        this.log.append("ticket.branch", { id: t.id, by, source: repo.source, dir: r.dir, branch: r.branch, base: r.base, sha: r.sha, files: r.files.slice(0, 200), costUsd: r.costUsd });
        const now = this.get(t.id)!;
        if (isClosed(now.status)) return;
        const take = `To take it into your repo: git fetch "${r.dir}" ${r.branch}, then review and merge it yourself.`;
        this.log.append("ticket.noted", {
          id: t.id, by, kind: "reply", costUsd: r.costUsd, status: r.sha && now.status !== "built" ? "built" : r.sha ? undefined : "open",
          text: r.sha ? `${r.summary || "Done."}\n\nChanged ${r.files.length} file(s) on ${r.branch} (from ${r.base}). ${take}` : `${r.summary || "No change was made."}\n\nNothing changed on ${r.branch}.`,
        });
      })
      .catch((e) => { this.log.append("ticket.noted", { id: t.id, by, status: "open", text: `Working it in the repo failed: ${(e as Error).message}` }); })
      .finally(() => this.inRepo.delete(t.id));
    this.inRepo.set(t.id, job);
    return { ticket: this.get(t.id)!, run: null, branch };
  }

  /**
   * Ask an agent: the assignee (or the Overseer) reads the work document and
   * replies on the thread. One short call, capped; it may move an open ticket to ready.
   */
  async ask(id: number, agentId?: string): Promise<{ ticket: TicketView; reply?: string; error?: string; costUsd?: number }> {
    const { runtime, bay } = this.opts;
    if (!runtime) throw new Error("No crew in this core.");
    const t = this.must(id);
    if (this.asking.has(id)) throw new Error("An agent is already reading this ticket.");
    const want = agentId ?? (t.assignee && t.assignee !== "you" ? t.assignee : "overseer");
    const a = bay?.get(want) ?? bay?.get("overseer");
    const name = a?.def.name ?? want;
    const cap = Math.min(this.opts.budgetUsd ?? 0.1, a?.def.budgetUsd ?? 0.1);
    this.asking.add(id);
    try {
      const run = await runAgent(this.log, runtime, a?.def.id ?? want, {
        prompt: this.document(id),
        model: a?.def.model ?? "haiku",
        systemPrompt: `${a?.def.prompt ?? "You are a careful engineer."}\n\n${TICKET_CONTRACT}`,
        budgetUsd: cap,
      }, { agentVersion: a?.version, station: "ticket" });
      if (run.error || !run.result) {
        this.say(id, `${name} could not answer: ${run.error ?? "no reply"}`, { by: a?.def.id ?? want, kind: "event" });
        return { ticket: this.get(id)!, error: run.error ?? "no reply" };
      }
      const text = run.result.text.trim();
      const ready = /STATUS:\s*ready/i.test(text);
      const now = this.get(id)!;
      const reply = text.replace(/\n?STATUS:\s*\w+\s*$/i, "").trim() || text;
      if (ready && now.status === "open") this.say(id, reply, { by: a?.def.id ?? want, kind: "reply", status: "ready", costUsd: run.result.costUsd });
      else this.say(id, reply, { by: a?.def.id ?? want, kind: "reply", costUsd: run.result.costUsd });
      return { ticket: this.get(id)!, reply, costUsd: run.result.costUsd };
    } finally {
      this.asking.delete(id);
    }
  }

  // ---- agents and rules write back -----------------------------------------

  /** Keep tickets in step with the rest of the factory. Runs synchronously for every event. */
  /**
   * When the last ticket of an epic is done, the epic is built and waits for
   * your look (an epic is taste: it never closes by itself). A reopened ticket
   * says so on its epic.
   */
  private rollUp(id: number) {
    const t = this.get(id);
    if (!t || t.parentId == null) return;
    const epic = this.get(t.parentId);
    if (!epic || epic.kind !== "plan") return;
    const { total, done } = epic.children;
    if (total > 0 && done === total && ["open", "ready", "in_progress"].includes(epic.status)) {
      this.log.append("ticket.noted", { id: epic.id, by: "factory", status: "built", text: `All ${total} ticket${total === 1 ? "" : "s"} of this epic are done. Take a look.` });
    } else if (!isClosed(t.status) && t.status !== "built" && epic.status === "built") {
      this.log.append("ticket.noted", { id: epic.id, by: "factory", kind: "event", text: `${t.key} was reopened, so this epic is not all done any more.` });
    }
  }

  private react(e: SfEvent) {
    const p = e.payload as Record<string, any>;
    if (e.type === "ticket.noted" && p.status) this.rollUp(Number(p.id));
    if (e.type === "factory.run.finished") {
      const run = Number(p.run);
      const t = this.byRun(run);
      if (t) return this.runEnded(t, run, p);
      // A run that failed on its own (not from a ticket) becomes a bug, so it is not forgotten.
      if (p.outcome === "failed") {
        const started = this.log.get(run)?.payload as { idea?: string } | undefined;
        this.open({
          kind: "bug", title: `Factory run #${run} failed: ${String(started?.idea ?? "").split("\n")[0].slice(0, 60)}`, by: "factory", source: "factory", fingerprint: `run-failed:${run}`,
          answers: { expected: "The run ships a tested repo." }, body: `The run stopped with: ${p.reason ?? "no reason given"}.`,
          project: this.projectOfRun(run),
        });
      }
    } else if (e.type === "factory.gate" && p.state === "waiting") {
      const t = this.byRun(Number(p.run));
      if (t) this.log.append("ticket.noted", { id: t.id, by: "factory", kind: "event", text: `Run #${p.run} waits for you at the ${String(p.gate).replace("gateA", "plan gate").replace("gateB", "build gate")}: ${p.question ?? ""}`.trim() });
    } else if (e.type === "order.fragment") {
      // The Order Engine files what you say; a task or a question it files becomes a ticket under its project.
      const kind = p.kind === "task" ? "task" : p.kind === "question" ? "question" : null;
      if (!kind || p.nodeId == null || !String(p.text ?? "").trim()) return;
      // A factory run's own idea is already a run (and maybe a ticket); only what you said becomes a ticket.
      const src = this.log.db.prepare("SELECT json_extract(payload, '$.source') AS s FROM events WHERE id = ?").get(Number(p.signalId)) as { s: string | null } | undefined;
      if (src?.s === "factory") return;
      const fid = Number(p.id ?? e.id);
      this.open({
        kind, title: String(p.text), by: "archivist", source: "order", fingerprint: `fragment:${fid}`,
        answers: kind === "task" ? { todo: String(p.text) } : { ask: String(p.text) }, project: this.rootOf(Number(p.nodeId)),
      });
    } else if (e.type === "ticket.requested") {
      // Any module asks for a ticket without owning ticket numbers: an import's suggestion, a tool, a script.
      this.open({
        kind: p.kind, title: p.title, body: p.body, answers: p.answers, project: p.project ?? null, priority: p.priority, severity: p.severity,
        by: p.by ?? String(p.source ?? "agent"), source: String(p.source ?? "agent"), fingerprint: p.fingerprint ?? `request:${e.id}`, tags: p.tags,
        request: e.id, ref: p.ref,
      });
    } else if (e.type === ("improve.proposal.accepted" as SfEvent["type"])) {
      // A code suggestion from an imported repo is a task on that repo; anything else is an idea, which is taste.
      const fromRepo = p.source?.kind === "repo.suggestion" && p.source.suggestionId != null;
      const t = this.open({
        kind: fromRepo ? "task" : "idea", title: String(p.title ?? "An improvement"), body: String(p.body ?? ""), by: "council", source: "improve",
        fingerprint: fromRepo ? `suggestion:${p.source.suggestionId}` : `improve:${p.id}`,
        answers: fromRepo ? { todo: String(p.body || p.title || "") } : { core: String(p.title ?? ""), problem: String(p.body ?? ""), why_now: p.lens ? `Seen through the ${p.lens} lens${p.impact ? `, impact ${p.impact}` : ""}${p.effort ? `, effort ${p.effort}` : ""}` : "" },
        project: p.target?.kind === "project" && p.target.id != null ? Number(p.target.id) : null,
        tags: ["improvement"],
      });
      this.log.append("improve.proposal.linked" as SfEvent["type"], { id: p.id, ticketId: t.id });
    }
  }

  private runEnded(t: TicketView, run: number, p: Record<string, any>) {
    if (isClosed(t.status)) {
      // A late run never reopens what you closed; it only says what happened.
      this.log.append("ticket.noted", { id: t.id, by: "factory", kind: "event", text: `Run #${run} ended ${p.outcome} after the ticket was closed.` });
      return;
    }
    if (p.outcome !== "shipped") {
      this.log.append("ticket.noted", { id: t.id, by: "factory", status: p.resumable ? "in_progress" : "open", text: `Run #${run} ${p.outcome}: ${p.reason ?? ""}`.trim() });
      if (t.status === "in_progress" && p.resumable) return;
      return;
    }
    const tests = this.log.db.prepare("SELECT payload FROM events WHERE type = 'factory.tests' AND json_extract(payload, '$.run') = ? ORDER BY id DESC LIMIT 1").get(run) as { payload: string } | undefined;
    const tp = tests ? JSON.parse(tests.payload) as { passed: number; failed: number } : null;
    const green = !!tp && tp.passed > 0 && tp.failed === 0;
    const where = p.dir ? ` in ${p.dir}` : "";
    const say = `Run #${run} shipped${where}${p.sha ? ` at ${String(p.sha).slice(0, 7)}` : ""}: ${tp ? `${tp.passed} tests green${tp.failed ? `, ${tp.failed} red` : ""}` : "no test report"}, $${Number(p.totalUsd ?? 0).toFixed(4)}.`;
    this.log.append("ticket.noted", { id: t.id, by: "factory", status: t.status === "built" ? undefined : "built", text: say });
    // The one who checks is not the one who builds: a bug or task with green tests closes by the rule,
    // unless it is taste, or someone pulled the hand brake in words on the thread.
    const brake = this.notes(t.id).some((n) => (n.kind === "note") && HAND_BRAKE.test(n.text));
    if (green && !TASTE_KINDS.includes(t.kind) && !brake) {
      this.log.append("ticket.noted", { id: t.id, by: "qa-rule", status: "closed", text: `Closed by the QA rule: built by run #${run}, all ${tp!.passed} locked tests green, no hand brake on the thread. Reopen it if it is not good.` });
    } else if (brake) {
      this.log.append("ticket.noted", { id: t.id, by: "qa-rule", kind: "event", text: "Left built for your look: the thread asks for it." });
    }
  }

  private byRun(run: number): TicketView | undefined {
    const r = this.log.db.prepare("SELECT * FROM tickets WHERE run = ?").get(run) as Row | undefined;
    return r ? toView(r) : undefined;
  }

  /** The project a run belongs to (the projects model knows; a run started from a ticket joins the ticket's). */
  private projectOfRun(run: number): number | null {
    return projectOf(this.log, { kind: "factory_run", ref: run });
  }

  /** The project an Order Engine node belongs to. */
  private rootOf(nodeId: number): number | null {
    return projectOf(this.log, { kind: "order_node", ref: nodeId });
  }

  /** Tell the projects model this ticket belongs to a project, so the project's rollup counts it. */
  private linkProject(id: number, project: number | null) {
    if (project == null || !this.log.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(project)) return;
    this.log.append("project.linked", { projectId: project, kind: "ticket", ref: String(id) });
  }

  private must(id: number): TicketView {
    const t = this.get(Number(id));
    if (!t) throw new Error(`No ticket #${id}`);
    return t;
  }
}

/** Every project's page shows its tickets: open, for your look, and the newest few. */
registerProjectFacet({
  id: "tickets",
  compute(log, project) {
    const rows = log.db.prepare("SELECT id, kind, title, status FROM tickets WHERE project = ? ORDER BY updated_at DESC LIMIT 5").all(project.id) as Row[];
    const c = log.db.prepare("SELECT count(*) FILTER (WHERE status NOT IN ('closed', 'rejected')) AS open, count(*) FILTER (WHERE status = 'built') AS look, count(*) AS total FROM tickets WHERE project = ?").get(project.id) as Row;
    const you = log.db.prepare(`SELECT count(*) AS n FROM tickets t WHERE t.project = ? AND ${WAITING_ON_YOU}`).get(project.id) as Row;
    return { open: Number(c.open), look: Number(c.look), you: Number(you.n), total: Number(c.total), recent: rows.map((r) => ({ id: Number(r.id), kind: r.kind, title: r.title, status: r.status })) };
  },
});
