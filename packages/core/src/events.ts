import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { migrate, type MigrationReport } from "./store/migrations.js";
import { registeredProjections, type Projection, type ProjectionContext } from "./store/projections.js";
import { CORE_PROJECTIONS } from "./store/tables.js";
import { ViewCache } from "./store/cache.js";

/**
 * The core database (factory.db) and its append-only event log.
 *
 * Three tiers, see docs/storage.md:
 *   database: the `events` table is the source of truth; typed tables
 *             (signals, agent_runs, factory_runs, artifacts, order_*) are kept
 *             current in the same transaction as every append, and rebuilt
 *             from the log whenever their version changes;
 *   files:    generated project repos on disk, pointed at by `artifacts` rows;
 *   cache:    folded views in memory, keyed by the newest event id, always
 *             safe to drop.
 */
export type EventType =
  | "settings.changed"
  | "drop.filed"
  | "drop.skipped"
  | "bridge.seen"
  | "signal.captured"
  | "agent.run.started"
  | "agent.run.completed"
  | "agent.run.failed"
  | "factory.run.started"
  | "factory.run.finished"
  | "factory.run.resumed"
  | "factory.station"
  | "factory.plan"
  | "factory.files"
  | "factory.tests"
  | "factory.tests.locked"
  | "factory.gate"
  | "factory.visual"
  | "factory.fastgate"
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
  | "bay.visual"
  | "ticket.opened"
  | "ticket.edited"
  | "ticket.noted"
  | "ticket.linked"
  | "ticket.run"
  | "ticket.line.moved"
  | "ticket.keyed"
  | "ticket.pr"
  | "ticket.requested"
  | "ticket.branch"
  | "improve.session"
  | "improve.seat"
  | "improve.proposal"
  | "improve.proposal.decided"
  | "improve.proposal.accepted"
  | "improve.proposal.linked"
  | "improve.visual"
  | "store.migrated"
  | "store.rebuilt"
  | "app.updated"
  | "project.created"
  | "project.updated"
  | "project.linked"
  | "project.unlinked"
  // Other parts of the app (tickets, improvement proposals, ...) add their own types.
  | (string & {});

export interface SfEvent<P = unknown> {
  id: number;
  ts: string;
  type: EventType;
  payload: P;
}

export interface ProjectionStatus {
  name: string;
  describe: string;
  version: number;
  tables: string[];
  lastEventId: number;
  rebuiltAt: string;
  error: string | null;
}

type Row = { id: number; ts: string; type: EventType; payload: string };
const toEvent = (r: Row): SfEvent => ({ id: Number(r.id), ts: r.ts, type: r.type, payload: JSON.parse(r.payload) });

export class EventLog extends EventEmitter {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly cache = new ViewCache();
  /** What opening this database did to its schema. */
  readonly migration: MigrationReport;
  private projections = new Map<string, Projection>();
  private ctx: ProjectionContext = { view: (name, compute) => this.view(name, compute) };

  constructor(path = ":memory:") {
    super();
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.migration = migrate(this.db, path);
    for (const p of [...CORE_PROJECTIONS, ...registeredProjections()]) this.addProjection(p);
    if (this.migration.backup) {
      this.append("store.migrated", { from: this.migration.from, to: this.migration.to, applied: this.migration.applied, backup: this.migration.backup });
    }
  }

  append<P>(type: EventType, payload: P, ts = new Date().toISOString()): SfEvent<P> {
    let event!: SfEvent<P>;
    this.db.exec("SAVEPOINT sf_append");
    try {
      const res = this.db.prepare("INSERT INTO events (ts, type, payload) VALUES (?, ?, ?)").run(ts, type, JSON.stringify(payload));
      event = { id: Number(res.lastInsertRowid), ts, type, payload };
      if (type === "signal.captured") {
        const text = (payload as { text?: string }).text ?? "";
        this.db.prepare("INSERT INTO signal_fts (text, event_id) VALUES (?, ?)").run(text, event.id);
      }
      for (const p of this.projections.values()) this.project(p, [event], new Set([type]));
      const names = [...this.projections.keys()];
      this.db.prepare(`UPDATE projections SET last_event_id = ? WHERE name IN (${names.map(() => "?").join(",")})`).run(event.id, ...names);
      this.db.exec("RELEASE sf_append");
    } catch (e) {
      this.db.exec("ROLLBACK TO sf_append; RELEASE sf_append");
      throw e;
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
    return (this.db.prepare(sql).all(...args) as Row[]).map(toEvent);
  }

  /** One event by id. */
  get(id: number): SfEvent | undefined {
    const row = this.db.prepare("SELECT id, ts, type, payload FROM events WHERE id = ?").get(id) as Row | undefined;
    return row ? toEvent(row) : undefined;
  }

  /** Id of the newest event, 0 for an empty log. */
  lastId(): number {
    return Number((this.db.prepare("SELECT coalesce(max(id), 0) AS id FROM events").get() as { id: number }).id);
  }

  /** A view folded from the whole log, served from the cache until a new event lands. */
  view<T>(name: string, compute: (events: SfEvent[]) => T): T {
    return this.cache.get(name, this.lastId(), () => compute(this.list({ limit: 1e9 })));
  }

  /** Full-text search over captured Signals, best match first. */
  searchSignals(query: string, limit = 20): SfEvent[] {
    const ids = this.db
      .prepare("SELECT event_id FROM signal_fts WHERE signal_fts MATCH ? ORDER BY rank LIMIT ?")
      .all(query, limit) as { event_id: number }[];
    if (!ids.length) return [];
    const rows = this.db
      .prepare(`SELECT id, ts, type, payload FROM events WHERE id IN (${ids.map(() => "?").join(",")})`)
      .all(...ids.map((r) => Number(r.event_id))) as Row[];
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    return ids.map((r) => byId.get(Number(r.event_id))!).filter(Boolean).map(toEvent);
  }

  /**
   * Attach a projection: create its tables, and fill them from the log if they
   * are new, behind, or of an older version. Safe to call for one already attached.
   */
  addProjection(p: Projection) {
    this.projections.set(p.name, p);
    const row = this.db.prepare("SELECT version, last_event_id FROM projections WHERE name = ?").get(p.name) as { version: number; last_event_id: number } | undefined;
    if (!row || Number(row.version) !== p.version) return this.rebuildOne(p);
    p.migrate(this.db);
    if (Number(row.last_event_id) < this.lastId()) this.backfill(p, Number(row.last_event_id));
  }

  /** Drop and rebuild one projection's tables (or all of them) from the log. The log is untouched. */
  rebuild(name?: string): ProjectionStatus[] {
    const targets = [...this.projections.values()].filter((p) => !name || p.name === name);
    if (name && !targets.length) throw new Error(`No projection named "${name}"`);
    const t0 = performance.now();
    this.cache.clear();
    for (const p of targets) this.rebuildOne(p);
    this.append("store.rebuilt", { projections: targets.map((p) => p.name), events: this.lastId(), ms: Number((performance.now() - t0).toFixed(1)) });
    return this.projectionStatus();
  }

  projectionStatus(): ProjectionStatus[] {
    const rows = this.db.prepare("SELECT name, version, last_event_id, rebuilt_at, error FROM projections").all() as { name: string; version: number; last_event_id: number; rebuilt_at: string; error: string | null }[];
    const byName = new Map(rows.map((r) => [r.name, r]));
    return [...this.projections.values()].map((p) => {
      const r = byName.get(p.name);
      return { name: p.name, describe: p.describe, version: p.version, tables: p.tables, lastEventId: Number(r?.last_event_id ?? 0), rebuiltAt: r?.rebuilt_at ?? "", error: r?.error ?? null };
    });
  }

  close() { this.db.close(); }

  private rebuildOne(p: Projection) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const t of p.tables) this.db.exec(`DROP TABLE IF EXISTS "${t.replace(/"/g, "")}"`);
      p.migrate(this.db);
      this.db.prepare("INSERT OR REPLACE INTO projections (name, version, last_event_id, rebuilt_at, error) VALUES (?, ?, 0, ?, NULL)").run(p.name, p.version, new Date().toISOString());
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.backfill(p, 0);
  }

  /** Replay events after `afterId` into one projection, in one transaction. */
  private backfill(p: Projection, afterId: number) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const types = new Set<string>();
      let last = afterId;
      for (;;) {
        const page = this.list({ sinceId: last, limit: 5000 });
        if (!page.length) break;
        this.project(p, page, null);
        for (const e of page) types.add(e.type);
        last = page.at(-1)!.id;
      }
      if (p.flush && types.size) this.flushOne(p, types);
      this.db.prepare("UPDATE projections SET last_event_id = ? WHERE name = ?").run(last, p.name);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * Apply events to one projection. A projection bug must never lose an event:
   * its change is rolled back, the error is recorded for the Bridge, and a
   * rebuild (after the fix) brings the table back in line with the log.
   */
  private project(p: Projection, events: SfEvent[], flushTypes: Set<string> | null) {
    this.db.exec("SAVEPOINT sf_projection");
    try {
      if (p.apply) for (const e of events) p.apply(this.db, e);
      if (flushTypes && p.flush) p.flush(this.db, this.ctx, flushTypes);
      this.db.exec("RELEASE sf_projection");
    } catch (e) {
      this.db.exec("ROLLBACK TO sf_projection; RELEASE sf_projection");
      this.db.prepare("UPDATE projections SET error = ? WHERE name = ?").run(`event ${events.at(-1)?.id ?? this.lastId()}: ${(e as Error).message}`.slice(0, 500), p.name);
    }
  }

  private flushOne(p: Projection, types: Set<string>) {
    this.project({ ...p, apply: undefined }, [], types);
  }
}
