import { registerProjection, type Projection } from "../store/projections.js";

/**
 * Tickets as organized tables, derived from the `ticket.*` events like every
 * other table (docs/storage.md). For example, what waits for your look:
 *
 *   SELECT id, kind, title FROM tickets WHERE status = 'built' ORDER BY updated_at;
 */
type P = Record<string, any>;
const str = (v: unknown) => (v == null || v === "" ? null : String(v));
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Fields `ticket.edited` may change, and the column each one writes. */
export const EDITABLE: Record<string, string> = {
  title: "title", body: "body", kind: "kind", priority: "priority", severity: "severity", assignee: "assignee",
  project: "project", tags: "tags", parent: "parent_id", size: "size", flow: "flow",
};

export const ticketsProjection: Projection = {
  name: "tickets",
  version: 8,
  tables: ["tickets", "ticket_notes", "ticket_links", "ticket_keys", "ticket_runs", "ticket_trace"],
  describe: "Tickets: units of work per project, their append-only timeline (notes, agent replies, status moves, agent steps, decisions, retries, branches and PRs) and links",
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS tickets (
      id          INTEGER PRIMARY KEY,
      event_id    INTEGER NOT NULL,
      number      INTEGER,
      kind        TEXT NOT NULL,
      title       TEXT NOT NULL,
      body        TEXT NOT NULL DEFAULT '',
      answers     TEXT NOT NULL DEFAULT '{}',
      project     INTEGER,
      status      TEXT NOT NULL,
      priority    TEXT,
      severity    TEXT,
      size        TEXT,
      assignee    TEXT,
      parent_id   INTEGER,
      line_order  INTEGER,
      tags        TEXT NOT NULL DEFAULT '[]',
      source      TEXT NOT NULL,
      opened_by   TEXT NOT NULL,
      fingerprint TEXT,
      run         INTEGER,
      branch      TEXT,
      branch_dir  TEXT,
      pushed_url  TEXT,
      pr_repo     TEXT,
      pr_number   INTEGER,
      pr_url      TEXT,
      pr_state    TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      closed_at   TEXT,
      last_note   TEXT,
      flow        TEXT
    );
    CREATE INDEX IF NOT EXISTS tickets_project ON tickets(project, status);
    CREATE INDEX IF NOT EXISTS tickets_run ON tickets(run);
    CREATE INDEX IF NOT EXISTS tickets_number ON tickets(project, number);
    CREATE TABLE IF NOT EXISTS ticket_keys (
      project INTEGER PRIMARY KEY,
      key     TEXT NOT NULL UNIQUE
    );
    CREATE INDEX IF NOT EXISTS tickets_parent ON tickets(parent_id, line_order);
    CREATE UNIQUE INDEX IF NOT EXISTS tickets_fingerprint ON tickets(fingerprint) WHERE fingerprint IS NOT NULL;
    CREATE TABLE IF NOT EXISTS ticket_notes (
      event_id  INTEGER PRIMARY KEY,
      ticket_id INTEGER NOT NULL,
      ts        TEXT NOT NULL,
      by_name   TEXT NOT NULL,
      kind      TEXT NOT NULL CHECK (kind IN ('note', 'reply', 'status', 'event')),
      text      TEXT NOT NULL,
      status    TEXT,
      cost_usd  REAL,
      cat       TEXT NOT NULL DEFAULT 'event'
    );
    CREATE INDEX IF NOT EXISTS ticket_notes_ticket ON ticket_notes(ticket_id, event_id);
    CREATE TABLE IF NOT EXISTS ticket_runs (
      run       INTEGER PRIMARY KEY,
      ticket_id INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ticket_trace (
      event_id  INTEGER PRIMARY KEY,
      ticket_id INTEGER NOT NULL,
      ts        TEXT NOT NULL,
      by_name   TEXT NOT NULL,
      cat       TEXT NOT NULL,
      text      TEXT NOT NULL,
      run       INTEGER,
      cost_usd  REAL
    );
    CREATE INDEX IF NOT EXISTS ticket_trace_ticket ON ticket_trace(ticket_id, event_id);
    CREATE TABLE IF NOT EXISTS ticket_links (
      from_id  INTEGER NOT NULL,
      to_id    INTEGER NOT NULL,
      relation TEXT NOT NULL,
      ts       TEXT NOT NULL,
      PRIMARY KEY (from_id, to_id, relation)
    )`);
  },
  apply(db, e) {
    const p = e.payload as P;
    const note = (kind: string, text: string, status: string | null = null, cost: number | null = null, cat: TimelineCat = kind === "note" || kind === "reply" ? "said" : kind === "status" ? "status" : "event") => {
      db.prepare("INSERT OR REPLACE INTO ticket_notes (event_id, ticket_id, ts, by_name, kind, text, status, cost_usd, cat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(e.id, Number(p.id), e.ts, String(p.by ?? "you"), kind, text, status, cost, cat);
      db.prepare("UPDATE tickets SET updated_at = ?, last_note = ? WHERE id = ?").run(e.ts, text.slice(0, 200), Number(p.id));
    };
    // A ticket's number inside its project: given by the service, or the next one (older events had none).
    const numberIn = (project: number | null, given: unknown) => num(given) ?? Number((db.prepare("SELECT coalesce(max(number), 0) + 1 AS n FROM tickets WHERE project IS ?").get(project) as { n: number }).n);
    // How a ticket is said in the thread: "SF-4" when its project has a key, else "#4".
    const said = (id: number) => {
      const r = db.prepare("SELECT t.number, k.key FROM tickets t LEFT JOIN ticket_keys k ON k.project = t.project WHERE t.id = ?").get(id) as { number: number | null; key: string | null } | undefined;
      return r?.key && r.number != null ? `${r.key}-${r.number}` : `#${id}`;
    };
    if (e.type === "ticket.opened") {
      const lineOrder = p.parent != null
        ? Number((db.prepare("SELECT coalesce(max(line_order), 0) + 1 AS n FROM tickets WHERE parent_id = ?").get(Number(p.parent)) as { n: number }).n)
        : null;
      const project = num(p.project);
      db.prepare(`INSERT OR REPLACE INTO tickets (id, event_id, number, kind, title, body, answers, project, status, priority, severity, assignee, parent_id, line_order, tags, source, opened_by, fingerprint, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(Number(p.id), e.id, numberIn(project, p.number), String(p.kind), String(p.title), String(p.body ?? ""), JSON.stringify(p.answers ?? {}), num(p.project), str(p.priority), str(p.severity), str(p.assignee),
          num(p.parent), lineOrder, JSON.stringify(p.tags ?? []), String(p.source ?? "you"), String(p.by ?? "you"), str(p.fingerprint), e.ts, e.ts);
      note("event", `Opened by ${p.by ?? "you"}${p.source && p.source !== "you" ? ` (from ${p.source})` : ""}`);
    } else if (e.type === "ticket.edited") {
      const field = String(p.field);
      if (field === "answer") {
        const row = db.prepare("SELECT answers FROM tickets WHERE id = ?").get(Number(p.id)) as { answers: string } | undefined;
        if (!row) return;
        const answers = { ...JSON.parse(row.answers), [String(p.key)]: String(p.value ?? "") };
        db.prepare("UPDATE tickets SET answers = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(answers), e.ts, Number(p.id));
        return;
      }
      const col = EDITABLE[field];
      if (!col) return;
      let value: unknown = p.value;
      if (field === "tags") value = JSON.stringify(Array.isArray(p.value) ? p.value : []);
      else if (field === "project" || field === "parent") value = num(p.value);
      else value = str(p.value);
      if (field === "project") {
        // A move to another project takes the next number (and key) there; the thread keeps the old one.
        db.prepare("UPDATE tickets SET project = ?, number = ?, updated_at = ? WHERE id = ?").run(value as number | null, numberIn(value as number | null, p.number), e.ts, Number(p.id));
      } else if (field === "parent") {
        const order = value == null ? null : Number((db.prepare("SELECT coalesce(max(line_order), 0) + 1 AS n FROM tickets WHERE parent_id = ?").get(value as number) as { n: number }).n);
        db.prepare("UPDATE tickets SET parent_id = ?, line_order = ?, updated_at = ? WHERE id = ?").run(value as number | null, order, e.ts, Number(p.id));
      } else {
        db.prepare(`UPDATE tickets SET ${col} = ?, updated_at = ? WHERE id = ?`).run(value as string | number | null, e.ts, Number(p.id));
      }
      if (field === "kind" || field === "assignee" || field === "project" || field === "parent" || field === "size") {
        note("event", `${field === "parent" ? "parent" : field} set to ${p.value == null || p.value === "" ? "nothing" : field === "parent" ? said(Number(p.value)) : p.value}`);
      }
    } else if (e.type === "ticket.noted") {
      const status = str(p.status);
      if (status) {
        db.prepare("UPDATE tickets SET status = ?, closed_at = CASE WHEN ? IN ('closed', 'rejected') THEN ? ELSE NULL END WHERE id = ?").run(status, status, e.ts, Number(p.id));
      }
      const kind = status ? "status" : String(p.kind ?? "note") === "reply" ? "reply" : String(p.kind ?? "note") === "event" ? "event" : "note";
      note(kind, String(p.text ?? ""), status, num(p.costUsd), p.step ? "step" : undefined);
    } else if (e.type === "ticket.linked") {
      const from = Number(p.id), to = Number(p.to), rel = String(p.relation);
      if (p.removed) db.prepare("DELETE FROM ticket_links WHERE from_id = ? AND to_id = ? AND relation = ?").run(from, to, rel);
      else db.prepare("INSERT OR REPLACE INTO ticket_links (from_id, to_id, relation, ts) VALUES (?, ?, ?, ?)").run(from, to, rel, e.ts);
      note("event", `${p.removed ? "Unlinked" : "Linked"} ${rel.replace("_", " ")} ${said(to)}`);
    } else if (e.type === "ticket.run") {
      db.prepare("UPDATE tickets SET run = ? WHERE id = ?").run(Number(p.run), Number(p.id));
      // From here on, what the run does lands on this ticket's timeline too (traceOf below).
      db.prepare("INSERT OR REPLACE INTO ticket_runs (run, ticket_id) VALUES (?, ?)").run(Number(p.run), Number(p.id));
      note("event", `Factory run #${p.run} started on this ticket`, null, null, "run");
    } else if (e.type === "ticket.branch") {
      // New work on the branch: what was sent before is behind, so the ticket offers to send again.
      db.prepare("UPDATE tickets SET branch = ?, branch_dir = ?, pushed_url = CASE WHEN ? THEN NULL ELSE pushed_url END WHERE id = ?").run(String(p.branch), String(p.dir), p.sha ? 1 : 0, Number(p.id));
      note("event", p.sha ? `Branch ${p.branch} at ${String(p.sha).slice(0, 7)}: ${(p.files ?? []).length} file(s) changed in ${p.dir}.` : `Branch ${p.branch} in ${p.dir}: nothing changed.`, null, null, "git");
    } else if (e.type === "ticket.pushed") {
      // The branch is on GitHub (sent on your press, with this PC's own Git sign-in); `url` starts its pull request.
      db.prepare("UPDATE tickets SET pushed_url = ?, updated_at = ? WHERE id = ?").run(p.url ? String(p.url) : "local", e.ts, Number(p.id));
      note("event", p.url ? `Branch ${p.branch} sent to ${p.repo} on GitHub` : `Branch ${p.branch} added to ${p.repo}`, null, null, "git");
    } else if (e.type === "ticket.pr") {
      // The ticket's pull request: opened by the crew, then merged or closed on GitHub.
      db.prepare("UPDATE tickets SET pr_repo = ?, pr_number = ?, pr_url = ?, pr_state = ?, updated_at = ? WHERE id = ?").run(String(p.repo), Number(p.number), String(p.url), String(p.state), e.ts, Number(p.id));
      note("event", p.state === "open" ? `PR #${p.number} opened on ${p.repo}` : `PR #${p.number} ${p.state}`, null, null, "git");
    } else if (e.type === "ticket.keyed") {
      // A project's ticket key ("SF"), given once; it stays when the project is renamed.
      db.prepare("INSERT OR IGNORE INTO ticket_keys (project, key) VALUES (?, ?)").run(Number(p.project), String(p.key));
    } else if (e.type === "ticket.line.moved") {
      // Swap with the neighbour above or below in the plan.
      const t = db.prepare("SELECT parent_id, line_order FROM tickets WHERE id = ?").get(Number(p.id)) as { parent_id: number | null; line_order: number | null } | undefined;
      if (!t || t.parent_id == null || t.line_order == null) return;
      const nb = db.prepare(`SELECT id, line_order FROM tickets WHERE parent_id = ? AND line_order ${p.dir === "up" ? "<" : ">"} ? ORDER BY line_order ${p.dir === "up" ? "DESC" : "ASC"} LIMIT 1`)
        .get(t.parent_id, t.line_order) as { id: number; line_order: number } | undefined;
      if (!nb) return;
      db.prepare("UPDATE tickets SET line_order = ? WHERE id = ?").run(nb.line_order, Number(p.id));
      db.prepare("UPDATE tickets SET line_order = ? WHERE id = ?").run(t.line_order, nb.id);
    } else {
      // What the crew does for a ticket: the steps of its run, agent calls, decisions, retries, its branch.
      const tr = traceOf(e.type, p, (run) => (db.prepare("SELECT ticket_id FROM ticket_runs WHERE run = ?").get(run) as { ticket_id: number } | undefined)?.ticket_id ?? null);
      if (tr) db.prepare("INSERT OR REPLACE INTO ticket_trace (event_id, ticket_id, ts, by_name, cat, text, run, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(e.id, tr.ticket, e.ts, tr.by, tr.cat, tr.text, tr.run, tr.cost);
    }
  },
};

/**
 * What a timeline row is about: what people said, a status move, a step the crew took, an agent call, a
 * decision (a gate or a question to you), a retry, the run starting or ending, git (branch, push, PR), or
 * anything else that happened to the ticket.
 */
export const TIMELINE_CATS = ["said", "status", "step", "agent", "decision", "retry", "run", "git", "event"] as const;
export type TimelineCat = (typeof TIMELINE_CATS)[number];

const STATION_WORD: Record<string, string> = {
  intake: "Intake", council: "Council", discover: "Design loop", plan: "Plan", gateA: "Your OK on the plan", tests: "Tests", build: "Build",
  test: "Test", fix: "Fix", review: "Review", evaluate: "Product judge", gateB: "Your OK on the build", ship: "Ship",
};
const STATE_WORD: Record<string, string> = { pass: "passed", fail: "failed", incomplete: "stopped unfinished", skipped: "skipped" };
const clip = (v: unknown, n = 300) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/**
 * The timeline row an engine or agent event adds to a ticket, or null. `ticketOfRun` says which ticket a
 * factory run works (from ticket.run). Plain, so the tests read it without a database.
 */
export function traceOf(type: string, p: P, ticketOfRun: (run: number) => number | null): { ticket: number; by: string; cat: TimelineCat; text: string; run: number | null; cost: number | null } | null {
  if (type === "ticket.step") {
    // The light route's harness steps: what failed or was skipped is already noted on the thread.
    if (p.state !== "passed" || p.id == null) return null;
    return { ticket: Number(p.id), by: "factory", cat: "step", text: `${p.step}: passed`, run: null, cost: null };
  }
  if (type === "ticket.checked") {
    // The check before money (tickets/precheck.ts): what it asked, or that it was clear to run.
    if (p.id == null) return null;
    const qs = Array.isArray(p.questions) ? (p.questions as { ask?: string }[]) : [];
    const text = p.verdict === "go" ? `Checked before money: clear to run${p.answered ? ` (${p.answered} answer${p.answered === 1 ? "" : "s"} from you)` : ""}`
      : `Checked before money: ${qs.length} question${qs.length === 1 ? "" : "s"} for you first. ${qs.map((q) => clip(q.ask, 160)).join(" ")}`;
    return { ticket: Number(p.id), by: String(p.by ?? "factory"), cat: "decision", text, run: null, cost: null };
  }
  if (type.startsWith("agent.run.")) {
    if (type !== "agent.run.completed" && type !== "agent.run.failed") return null;
    const run = num(p.factoryRun);
    const ticket = num(p.ticket) ?? (run != null ? ticketOfRun(run) : null);
    if (ticket == null) return null;
    const model = Array.isArray(p.models) && p.models.length ? String(p.models[0]).replace(/^claude-/, "").replace(/-\d.*$/, "") : p.model ? String(p.model) : null;
    const at = p.station ? ` at ${STATION_WORD[String(p.station)]?.toLowerCase() ?? p.station}${p.round ? `, round ${p.round}` : ""}` : "";
    const text = type === "agent.run.completed"
      ? `${p.agent} answered${at}${model ? ` · ${model}` : ""}${typeof p.durationMs === "number" ? ` · ${(p.durationMs / 1000).toFixed(1)}s` : ""}`
      : `${p.agent} failed${at}: ${clip(p.error, 240)}`;
    return { ticket, by: String(p.agent ?? "agent"), cat: "agent", text, run, cost: num(p.costUsd) };
  }
  if (!type.startsWith("factory.")) return null;
  const run = num(p.run);
  const ticket = run != null ? ticketOfRun(run) : null;
  if (ticket == null || run == null) return null;
  const row = (cat: TimelineCat, text: string, by = "factory") => ({ ticket, by, cat, text, run, cost: null });
  const where = STATION_WORD[String(p.station)] ?? String(p.station ?? "");
  switch (type) {
    case "factory.station": {
      const word = STATE_WORD[String(p.state)];
      if (!word) return null; // active and waiting: the step's end, or the gate, says it
      return row("step", `${where}${p.round ? ` round ${p.round}` : ""} ${word}${p.note ? `: ${clip(p.note, 240)}` : ""}`);
    }
    case "factory.gate": {
      const gate = p.gate === "gateA" ? "Your OK on the plan" : p.gate === "gateB" ? "Your OK on the build" : "A question to you";
      if (p.state === "waiting") return row("decision", `${gate}: waiting${p.question ? ` (${clip(p.question, 240)})` : ""}`);
      if (p.kind === "retry") return row("retry", `${where || "A step"} ${p.state === "approved" ? `tried again${p.attempt ? ` (attempt ${Number(p.attempt) + 1})` : ""}` : "not tried again"} by ${p.by ?? "you"}${p.note ? `: ${clip(p.note, 200)}` : ""}`, String(p.by ?? "you"));
      return row("decision", `${gate}: ${p.state === "approved" ? "approved" : "sent back"} by ${p.by ?? "you"}${p.note ? `: ${clip(p.note, 240)}` : ""}`, String(p.by ?? "you"));
    }
    case "factory.attempt": return row("retry", `Fix round ${p.round ?? "?"}: ${p.before ?? "?"} failing before, ${p.after ?? "?"} after${p.ladder && p.ladder !== "same" ? ` (${p.ladder})` : ""}`);
    case "factory.ladder": return row("retry", `The fix loop stepped up from ${p.from} to ${p.to}: ${clip(p.reason, 200)}`);
    case "factory.continued": return row("retry", `${where} continued: ${clip(p.reason, 240)}`);
    case "factory.run.resumed": return row("run", `Run #${run} picked up again at ${STATION_WORD[String(p.from)] ?? p.from}${p.auto ? " by itself" : ""}`);
    case "factory.run.finished": return row("run", `Run #${run} ${p.outcome}${p.reason ? `: ${clip(p.reason, 300)}` : ""}`);
    case "factory.repo": return row("git", `Working on branch ${p.branch} from ${String(p.base ?? "").slice(0, 7)} in a clone of ${p.name ?? p.source}`);
    case "factory.branch": return row("git", `Branch ${p.branch} ready${p.pr && typeof p.pr === "object" ? `, draft PR #${(p.pr as P).number}` : ""}`);
    default: return null;
  }
}

registerProjection(ticketsProjection);
