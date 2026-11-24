import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventLog } from "../events.js";
import { projectOf } from "../projects/service.js";
import { type TimelineCat } from "./tables.js";
import { selfProject } from "./intake.js";
import { type TicketCheck } from "./precheck.js";
import { STATUSES, isClosed, keyFromName, keyText, nextMoves, type LinkView, type NoteView, type Relation, type TicketView } from "./model.js";
import { SELECT, toView, type Row } from "./rows.js";
import { TICKET_FILE_MAX, WAITING_ON_YOU, type AutoWork, fileMime, stepOfSession, type BoardCard, type BoardLane, type TicketDetail, type TicketFile, type TicketFilter, type TicketsOptions, type TicketStep, type TimelineEntry, type WaitingItem } from "./shapes.js";

/**
 * Reading tickets: one ticket, lists, its notes, timeline, links, steps and files (attached here too), and the board.
 * Tickets (tickets.ts) builds on it with everything that changes a ticket or works it.
 */
export abstract class TicketReads {
  /** Tickets the Builder is working in a repo clone right now. */
  protected inRepo = new Map<number, Promise<void>>();

  constructor(protected log: EventLog, protected opts: TicketsOptions = {}) {}

  /** Filled in by Tickets: what is known about one ticket, whether it is being worked, its flow, and its checks. */
  abstract detail(id: number): TicketDetail | undefined;
  protected abstract isWorking(t: TicketView): boolean;
  abstract flowOf(t: TicketView, repo?: boolean): { id: string; name: string; runner: string; why: string; chosen: boolean } | null;
  abstract checks(project?: number | null): { ticket: TicketView; projectName: string | null; flow: { id: string; name: string } | null; check: TicketCheck }[];

  /** Filled in by Tickets: the auto-work rule in force. */
  abstract autoWork(): AutoWork;

  // ---- what auto-work spent and tried (read from the log) -----------------

  /** What today's auto starts (by the dispatcher) may spend together: their caps added up, for the daily limit. */
  autoUsdToday(): number {
    const day = new Date().toISOString().slice(0, 10);
    const rows = this.log.db.prepare("SELECT json_extract(payload, '$.capUsd') AS cap FROM events WHERE type = 'ticket.noted' AND json_extract(payload, '$.by') = 'dispatcher' AND json_extract(payload, '$.auto') = 1 AND coalesce(json_extract(payload, '$.text'), '') NOT LIKE 'The supervisor tries run%' AND ts >= ?").all(day) as { cap: number | null }[];
    // Starts written before caps were recorded count at the bug-and-task cap.
    const starts = rows.reduce((a, r) => a + (typeof r.cap === "number" ? r.cap : this.autoWork().maxUsd), 0);
    // The supervisor's tries that started (factory/supervisor.ts) come out of the same daily limit. Its first build
    // (24 Nov) wrote a dispatcher note before a try that then failed; those notes spent nothing and are left out above.
    const sup = this.log.db.prepare("SELECT sum(json_extract(payload, '$.addUsd')) AS usd FROM events WHERE type = 'factory.supervisor' AND json_extract(payload, '$.action') = 'retry' AND ts >= ?").get(day) as { usd: number | null };
    return starts + Number(sup?.usd ?? 0);
  }

  /** How many tickets the Builder is working in a repo clone right now (the light route). */
  repoWorkCount(): number { return this.inRepo.size; }

  /** What the Overseer's own reads of open tickets cost today. */
  protected triageUsdToday(): number {
    const day = new Date().toISOString().slice(0, 10);
    const r = this.log.db.prepare("SELECT sum(json_extract(payload, '$.capUsd')) AS usd FROM events WHERE type = 'ticket.noted' AND json_extract(payload, '$.by') = 'dispatcher' AND json_extract(payload, '$.triage') = 1 AND ts >= ?").get(day) as { usd: number | null };
    return Number(r?.usd ?? 0);
  }

  /** How often the crew started or retried this ticket on its own. */
  protected autoTries(id: number): number {
    return Number((this.log.db.prepare("SELECT count(*) AS n FROM events WHERE type = 'ticket.noted' AND json_extract(payload, '$.by') = 'dispatcher' AND json_extract(payload, '$.auto') = 1 AND json_extract(payload, '$.triage') IS NULL AND json_extract(payload, '$.id') = ?").get(id) as { n: number }).n);
  }

  /** Tickets you asked for (the last word on each, its own or its epic's), by id. */
  protected askedIds(): Set<number> {
    const rows = this.log.db.prepare("SELECT json_extract(payload, '$.id') AS id, json_extract(payload, '$.on') AS on_ FROM events WHERE type = 'ticket.asked' ORDER BY id").all() as { id: number; on_: number }[];
    const out = new Set<number>();
    for (const r of rows) { if (r.on_) out.add(Number(r.id)); else out.delete(Number(r.id)); }
    return out;
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

  /**
   * The ticket's one timeline, oldest first and append-only: its thread (what people said, status moves,
   * branch, push and PR) and what the crew did for it (each step of its runs, agent calls, decisions at the
   * gates, retries, the run starting and ending), merged in the order it happened.
   */
  timeline(id: number): TimelineEntry[] {
    const rows = this.log.db.prepare(`SELECT event_id, ts, by_name, cat, text, cost_usd, status, NULL AS run FROM ticket_notes WHERE ticket_id = ?
      UNION ALL SELECT event_id, ts, by_name, cat, text, cost_usd, NULL AS status, run FROM ticket_trace WHERE ticket_id = ? ORDER BY event_id`).all(id, id) as Row[];
    return rows.map((r) => ({ eventId: Number(r.event_id), ts: r.ts, by: r.by_name, cat: r.cat as TimelineCat, text: r.text, costUsd: r.cost_usd ?? null, status: r.status ?? null, run: r.run == null ? null : Number(r.run) }));
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

  /** The harness steps of the ticket's latest pass in its repo, in order, each with where it stands. */
  steps(id: number): TicketStep[] {
    const rows = this.log.db.prepare("SELECT ts, payload FROM events WHERE type = 'ticket.step' AND json_extract(payload, '$.id') = ? ORDER BY id").all(id) as { ts: string; payload: string }[];
    let out: TicketStep[] = [];
    let first: string | null = null;
    for (const r of rows) {
      const p = JSON.parse(r.payload) as { step: string; state: TicketStep["state"]; note?: string };
      first ??= p.step;
      // The first step running again is a new pass: show that one.
      if (p.step === first && p.state === "running") out = [];
      const at = out.find((x) => x.step === p.step);
      if (at) Object.assign(at, { state: p.state, note: p.note ?? "", at: r.ts });
      else out.push({ step: p.step, state: p.state, note: p.note ?? "", at: r.ts });
    }
    return out;
  }

  /** Where a ticket's files live: next to the work folder, one folder per ticket. Null without a work folder. */
  protected filesDir(id: number): string | null {
    return this.opts.workRoot ? join(this.opts.workRoot, "..", "ticket-files", String(id)) : null;
  }

  /** The files on a ticket, from the log (a file whose bytes were removed by hand is left out). */
  files(id: number): TicketFile[] {
    const dir = this.filesDir(id);
    if (!dir) return [];
    const rows = this.log.db.prepare("SELECT ts, payload FROM events WHERE type = 'ticket.file' AND json_extract(payload, '$.id') = ? ORDER BY id").all(id) as { ts: string; payload: string }[];
    const out: TicketFile[] = [];
    for (const r of rows) {
      const p = JSON.parse(r.payload);
      const path = join(dir, String(p.file));
      if (p.removed) { const i = out.findIndex((f) => f.file === p.file); if (i >= 0) out.splice(i, 1); continue; }
      if (!existsSync(path)) continue;
      out.push({ file: String(p.file), name: String(p.name), size: Number(p.size), mime: String(p.mime), by: String(p.by), at: r.ts, path, image: String(p.mime).startsWith("image/") });
    }
    return out;
  }

  /**
   * Put a file on a ticket (gap 4): a screenshot, a log, a report. The bytes go to the ticket's folder on this PC,
   * never into the log; the thread says it was added, and the work document lists it so an agent can read it.
   */
  attach(id: number, name: string, bytes: Buffer, o: { mime?: string; by?: string } = {}): TicketFile {
    const t = this.must(id);
    const dir = this.filesDir(id);
    if (!dir) throw new Error("This core has no folder for ticket files.");
    if (!bytes.length) throw new Error("The file is empty.");
    if (bytes.length > TICKET_FILE_MAX) throw new Error(`The file is ${(bytes.length / 1048576).toFixed(1)} MB; a ticket takes files up to 15 MB.`);
    const clean = String(name ?? "").split(/[\\/]/).pop()!.replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").trim().slice(0, 100) || "file";
    const n = this.log.db.prepare("SELECT count(*) AS n FROM events WHERE type = 'ticket.file' AND json_extract(payload, '$.id') = ?").get(id) as { n: number };
    const file = `${Number(n.n) + 1}-${clean}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), bytes);
    const by = o.by ?? "you";
    const mime = fileMime(clean, o.mime);
    this.log.append("ticket.file", { id, file, name: clean, size: bytes.length, mime, by });
    this.log.append("ticket.noted", { id, by, kind: "event", text: `Added the file ${clean} (${bytes.length < 1024 ? `${bytes.length} bytes` : bytes.length < 1048576 ? `${Math.round(bytes.length / 1024)} KB` : `${(bytes.length / 1048576).toFixed(1)} MB`}).` });
    void t;
    return this.files(id).find((f) => f.file === file)!;
  }

  /** Take a file off a ticket. The bytes stay in the folder; the ticket no longer shows it. */
  detach(id: number, file: string, by = "you"): TicketFile[] {
    const f = this.files(id).find((x) => x.file === file);
    if (!f) throw new Error(`There is no file ${file} on this ticket.`);
    this.log.append("ticket.file", { id, file, removed: true, by });
    this.log.append("ticket.noted", { id, by, kind: "event", text: `Took the file ${f.name} off.` });
    return this.files(id);
  }

  /** Tickets as Markdown (a list to paste anywhere) or JSON (each ticket's detail without its long work document). */
  exportTickets(ids: number[], format: "md" | "json" = "md"): string {
    const rows = [...new Set(ids.map(Number))].map((id) => this.detail(id)).filter((d): d is TicketDetail => !!d);
    if (format === "json") return JSON.stringify(rows.map(({ document: _d, timeline: _t, ...d }) => d), null, 2);
    return rows.map(({ ticket: t, notes, links }) => [
      `## ${t.key} ${t.title}`,
      `${t.kind}, ${t.status}${t.size ? `, size ${t.size}` : ""}${t.priority ? `, ${t.priority.replace("_", " ")}` : ""}${t.pr ? `, PR #${t.pr.number} (${t.pr.state}) ${t.pr.url}` : ""}`,
      ...(t.body ? ["", t.body] : []),
      ...(links.length ? ["", ...links.map((l) => `- ${l.relation.replace("_", " ")} ${l.key ?? `#${l.to}`} ${l.title ?? ""}`.trimEnd())] : []),
      ...(notes.filter((n) => n.text).length ? ["", "Thread:", ...notes.filter((n) => n.text).slice(-10).map((n) => `- ${n.ts.slice(0, 16).replace("T", " ")} ${n.by}${n.status ? ` (${n.status})` : ""}: ${n.text.split("\n")[0].slice(0, 300)}`)] : []),
    ].join("\n")).join("\n\n");
  }

  document(id: number): string {
    const d = this.detail(id);
    if (!d) throw new Error(`No ticket #${id}`);
    return d.document;
  }

  // ---- the home board (SF behavior brief 4.1) ---------------------------------

  /**
   * Every ticket across projects in four lanes: Needs you (first), Running, In review, Done. Each card says
   * the flow it follows and, while it runs, the step it is on, so the board can draw the live flow beside it.
   */
  board(o: { project?: number | null; doneDays?: number } = {}): { lanes: Record<BoardLane, BoardCard[]>; counts: Record<BoardLane, number> } {
    const names = new Map((this.log.db.prepare("SELECT id, name FROM projects").all() as { id: number; name: string }[]).map((r) => [Number(r.id), r.name]));
    const lanes: Record<BoardLane, BoardCard[]> = { needs: [], running: [], review: [], done: [] };
    const placed = new Set<number>();
    const card = (t: TicketView, extra: Partial<BoardCard> = {}): BoardCard => {
      const f = this.flowOf(t);
      return { id: t.id, key: t.key, title: t.title, kind: t.kind, status: t.status, project: t.project, projectName: t.project != null ? names.get(t.project) ?? null : null,
        flow: f ? { id: f.id, name: f.name, runner: f.runner } : null, run: t.run, pr: t.pr ? { number: t.pr.number, url: t.pr.url, state: t.pr.state } : null, updatedAt: t.updatedAt, ...extra };
    };
    const put = (lane: BoardLane, c: BoardCard) => { if (placed.has(c.id)) return; placed.add(c.id); lanes[lane].push(c); };
    const station = this.log.db.prepare("SELECT payload FROM events WHERE type = 'factory.station' AND json_extract(payload, '$.run') = ? ORDER BY id DESC LIMIT 1");
    const lastStep = this.log.db.prepare("SELECT payload FROM events WHERE type = 'ticket.step' AND json_extract(payload, '$.id') = ? ORDER BY id DESC LIMIT 1");
    const scope = o.project ?? undefined;
    // Running first, so a run waiting at your OK moves to Needs you with the step it waits on.
    for (const t of this.list({ view: "all", status: "in_progress", project: scope, limit: 300 })) {
      if (t.run != null) {
        const sp = station.get(t.run) as { payload: string } | undefined;
        const st = sp ? JSON.parse(sp.payload) as { station?: string; state?: string } : null;
        const live = this.isWorking(t);
        if (st?.state === "waiting") { put("needs", card(t, { need: "gate", say: `Waiting for your OK at ${st.station === "gateA" ? "the plan" : st.station === "gateB" ? "the build" : st.station}`, step: st.station ?? null, live: true })); continue; }
        put("running", card(t, { step: st?.station ?? null, live }));
      } else {
        const sp = lastStep.get(t.id) as { payload: string } | undefined;
        const name = sp ? String(JSON.parse(sp.payload).step) : null;
        put("running", card(t, { step: name ? stepOfSession(name) : null, stepName: name, live: this.inRepo.has(t.id) }));
      }
    }
    for (const c of this.checks(scope)) put("needs", card(c.ticket, { need: "check", say: c.check.questions[0]?.ask ?? "Questions before it costs money", questions: c.check.questions.length }));
    for (const w of this.waiting(scope)) {
      if (w.ticket.status === "built" && w.ticket.pr?.state === "open") continue; // its PR is in review
      put("needs", card(w.ticket, { need: w.need, say: w.say }));
    }
    // A crew PR whose CI passed waits for a merge: on Needs you with SF's merge review (docs/git.md). The rest are in review.
    const hasChecks = !!this.log.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'merge_checks'").get();
    const mergeRow = hasChecks ? this.log.db.prepare("SELECT number, ci, confident, score, reasons, merged_by FROM merge_checks WHERE ticket_id = ?") : null;
    for (const t of this.list({ view: "all", project: scope, limit: 500 })) {
      if (t.pr?.state !== "open" || isClosed(t.status)) continue;
      const m = mergeRow?.get(t.id) as { number: number; ci: string; confident: number; score: number; reasons: string; merged_by: string | null } | undefined;
      if (m && m.number === t.pr.number && m.ci === "green" && !m.merged_by && t.source !== "outside") {
        const miss = (JSON.parse(m.reasons) as { ok: boolean; text: string }[]).filter((r) => !r.ok);
        put("needs", card(t, { need: "merge", say: m.confident ? `PR #${t.pr.number} is ready to merge: every check of SF's review passed` : `PR #${t.pr.number} passed CI. ${miss[0]?.text ?? ""}`.trim(), merge: { confident: !!m.confident, score: m.score, number: m.number } }));
      } else put("review", card(t, { say: m?.ci === "red" ? `PR #${t.pr.number}: CI failed` : t.source === "outside" ? `PR #${t.pr.number}, made outside SF` : `Draft PR #${t.pr.number}: checks run, its merge moves it on` }));
    }
    const since = new Date(Date.now() - (o.doneDays ?? 14) * 86_400_000).toISOString();
    for (const t of this.list({ view: "closed", project: scope, limit: 200 })) if (t.status === "closed" && (t.closedAt ?? t.updatedAt) >= since) put("done", card(t));
    lanes.done.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    lanes.done.splice(40);
    return { lanes, counts: { needs: lanes.needs.length, running: lanes.running.length, review: lanes.review.length, done: lanes.done.length } };
  }

  protected byRun(run: number): TicketView | undefined {
    const r = this.log.db.prepare("SELECT * FROM tickets WHERE run = ?").get(run) as Row | undefined;
    return r ? toView(r) : undefined;
  }

  /** The project a run belongs to (the projects model knows; a run started from a ticket joins the ticket's). */
  protected projectOfRun(run: number): number | null {
    return projectOf(this.log, { kind: "factory_run", ref: run });
  }

  /** The project an Order Engine node belongs to. */
  protected rootOf(nodeId: number): number | null {
    return projectOf(this.log, { kind: "order_node", ref: nodeId });
  }

  protected must(id: number): TicketView {
    const t = this.get(Number(id));
    if (!t) throw new Error(`No ticket #${id}`);
    return t;
  }
}
