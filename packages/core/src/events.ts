import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";

/**
 * Append-only event log. Every Signal, agent run and (later) Fragment,
 * decision and sweep action is an event. Views are derived from it, which
 * gives history, replay and undo without extra bookkeeping.
 */
export type EventType =
  | "signal.captured"
  | "agent.run.started"
  | "agent.run.completed"
  | "agent.run.failed"
  | "factory.run.started"
  | "factory.run.finished"
  | "factory.station"
  | "factory.plan"
  | "factory.files"
  | "factory.tests"
  | "factory.tests.locked"
  | "factory.gate"
  | "factory.visual"
  | "factory.budget"
  | "order.node"
  | "order.fragment"
  | "order.fragment.moved"
  | "order.fragment.pinned"
  | "order.conflict"
  | "order.conflict.resolved"
  | "order.sweep"
  | "order.sweep.undone"
  | "order.ingest"
  | "order.briefing"
  | "order.visual"
  | "factory.council"
  | "factory.review"
  | "agent.verdict"
  | "bay.agent.saved"
  | "bay.agent.retired"
  | "bay.assign"
  | "bay.test"
  | "bay.visual";

export interface SfEvent<P = unknown> {
  id: number;
  ts: string;
  type: EventType;
  payload: P;
}

export class EventLog extends EventEmitter {
  readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    super();
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        ts      TEXT    NOT NULL,
        type    TEXT    NOT NULL,
        payload TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_type ON events(type);
      CREATE VIRTUAL TABLE IF NOT EXISTS signal_fts USING fts5(text, event_id UNINDEXED);
    `);
  }

  append<P>(type: EventType, payload: P, ts = new Date().toISOString()): SfEvent<P> {
    const res = this.db
      .prepare("INSERT INTO events (ts, type, payload) VALUES (?, ?, ?)")
      .run(ts, type, JSON.stringify(payload));
    const event: SfEvent<P> = { id: Number(res.lastInsertRowid), ts, type, payload };
    if (type === "signal.captured") {
      const text = (payload as { text?: string }).text ?? "";
      this.db.prepare("INSERT INTO signal_fts (text, event_id) VALUES (?, ?)").run(text, event.id);
    }
    this.emit("event", event);
    return event;
  }

  list(opts: { type?: EventType; sinceId?: number; limit?: number } = {}): SfEvent[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.type) { where.push("type = ?"); args.push(opts.type); }
    if (opts.sinceId !== undefined) { where.push("id > ?"); args.push(opts.sinceId); }
    const sql = `SELECT id, ts, type, payload FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id ASC LIMIT ?`;
    args.push(opts.limit ?? 1000);
    return (this.db.prepare(sql).all(...args) as { id: number; ts: string; type: EventType; payload: string }[])
      .map((r) => ({ id: Number(r.id), ts: r.ts, type: r.type, payload: JSON.parse(r.payload) }));
  }

  /** Full-text search over captured Signals, best match first. */
  searchSignals(query: string, limit = 20): SfEvent[] {
    const ids = this.db
      .prepare("SELECT event_id FROM signal_fts WHERE signal_fts MATCH ? ORDER BY rank LIMIT ?")
      .all(query, limit) as { event_id: number }[];
    if (!ids.length) return [];
    const rows = this.db
      .prepare(`SELECT id, ts, type, payload FROM events WHERE id IN (${ids.map(() => "?").join(",")})`)
      .all(...ids.map((r) => Number(r.event_id))) as { id: number; ts: string; type: EventType; payload: string }[];
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    return ids.map((r) => byId.get(Number(r.event_id))!).filter(Boolean)
      .map((r) => ({ id: Number(r.id), ts: r.ts, type: r.type, payload: JSON.parse(r.payload) }));
  }

  close() { this.db.close(); }
}
