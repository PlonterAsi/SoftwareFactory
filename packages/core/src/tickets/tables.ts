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
  project: "project", tags: "tags", parent: "parent_id",
};

export const ticketsProjection: Projection = {
  name: "tickets",
  version: 3,
  tables: ["tickets", "ticket_notes", "ticket_links", "ticket_keys"],
  describe: "Tickets: units of work per project, their append-only thread (notes, agent replies, status moves, events) and links",
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
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      closed_at   TEXT,
      last_note   TEXT
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
      cost_usd  REAL
    );
    CREATE INDEX IF NOT EXISTS ticket_notes_ticket ON ticket_notes(ticket_id, event_id);
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
    const note = (kind: string, text: string, status: string | null = null, cost: number | null = null) => {
      db.prepare("INSERT OR REPLACE INTO ticket_notes (event_id, ticket_id, ts, by_name, kind, text, status, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(e.id, Number(p.id), e.ts, String(p.by ?? "you"), kind, text, status, cost);
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
      if (field === "kind" || field === "assignee" || field === "project" || field === "parent") {
        note("event", `${field === "parent" ? "parent" : field} set to ${p.value == null || p.value === "" ? "nothing" : field === "parent" ? said(Number(p.value)) : p.value}`);
      }
    } else if (e.type === "ticket.noted") {
      const status = str(p.status);
      if (status) {
        db.prepare("UPDATE tickets SET status = ?, closed_at = CASE WHEN ? IN ('closed', 'rejected') THEN ? ELSE NULL END WHERE id = ?").run(status, status, e.ts, Number(p.id));
      }
      note(status ? "status" : String(p.kind ?? "note") === "reply" ? "reply" : String(p.kind ?? "note") === "event" ? "event" : "note", String(p.text ?? ""), status, num(p.costUsd));
    } else if (e.type === "ticket.linked") {
      const from = Number(p.id), to = Number(p.to), rel = String(p.relation);
      if (p.removed) db.prepare("DELETE FROM ticket_links WHERE from_id = ? AND to_id = ? AND relation = ?").run(from, to, rel);
      else db.prepare("INSERT OR REPLACE INTO ticket_links (from_id, to_id, relation, ts) VALUES (?, ?, ?, ?)").run(from, to, rel, e.ts);
      note("event", `${p.removed ? "Unlinked" : "Linked"} ${rel.replace("_", " ")} ${said(to)}`);
    } else if (e.type === "ticket.run") {
      db.prepare("UPDATE tickets SET run = ? WHERE id = ?").run(Number(p.run), Number(p.id));
      note("event", `Factory run #${p.run} started on this ticket`);
    } else if (e.type === "ticket.branch") {
      db.prepare("UPDATE tickets SET branch = ?, branch_dir = ? WHERE id = ?").run(String(p.branch), String(p.dir), Number(p.id));
      note("event", p.sha ? `Branch ${p.branch} at ${String(p.sha).slice(0, 7)}: ${(p.files ?? []).length} file(s) changed in ${p.dir}. Not pushed.` : `Branch ${p.branch} in ${p.dir}: nothing changed.`);
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
    }
  },
};

registerProjection(ticketsProjection);
