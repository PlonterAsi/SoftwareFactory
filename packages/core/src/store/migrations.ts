import type { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Versioned schema for the core database (factory.db).
 *
 * The schema version lives in `PRAGMA user_version`; every applied step is also
 * recorded in `schema_migrations` with its time, so the Bridge can show the
 * history. Steps only ever add: nothing here drops or rewrites the event log.
 * Before an existing database is upgraded, a full copy is written next to it.
 */
export interface Migration {
  version: number;
  name: string;
  up: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "Event log: append-only events and full-text search over Signals",
    // IF NOT EXISTS: databases made by milestones 1 to 3 already have these and adopt them as-is.
    up: `
      CREATE TABLE IF NOT EXISTS events (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        ts      TEXT    NOT NULL,
        type    TEXT    NOT NULL,
        payload TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_type ON events(type);
      CREATE VIRTUAL TABLE IF NOT EXISTS signal_fts USING fts5(text, event_id UNINDEXED);
    `,
  },
  {
    version: 2,
    name: "Store bookkeeping: projection versions, progress and health",
    up: `
      CREATE TABLE IF NOT EXISTS projections (
        name          TEXT    PRIMARY KEY,
        version       INTEGER NOT NULL,
        last_event_id INTEGER NOT NULL DEFAULT 0,
        rebuilt_at    TEXT    NOT NULL,
        error         TEXT
      );
    `,
  },
];

export const SCHEMA_VERSION = MIGRATIONS.at(-1)!.version;

export interface MigrationReport {
  from: number;
  to: number;
  applied: { version: number; name: string }[];
  /** Copy written before upgrading a database that already held data. */
  backup: string | null;
}

export interface AppliedMigration { version: number; name: string; appliedAt: string }

const KEEP_BACKUPS = 3;

/** Bring the database up to the latest schema. Safe to call on every open. */
export function migrate(db: DatabaseSync, path: string): MigrationReport {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    applied_at TEXT    NOT NULL
  )`);
  const from = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  const pending = MIGRATIONS.filter((m) => m.version > from);
  const report: MigrationReport = { from, to: from, applied: [], backup: null };
  if (!pending.length) return report;

  if (path !== ":memory:" && hasData(db)) report.backup = backup(db, path, from);

  for (const m of pending) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(m.up);
      db.prepare("INSERT OR REPLACE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, new Date().toISOString());
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`Database migration ${m.version} (${m.name}) failed: ${(e as Error).message}`);
    }
    report.applied.push({ version: m.version, name: m.name });
    report.to = m.version;
  }
  return report;
}

export function appliedMigrations(db: DatabaseSync): AppliedMigration[] {
  return (db.prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version").all() as { version: number; name: string; applied_at: string }[])
    .map((r) => ({ version: Number(r.version), name: r.name, appliedAt: r.applied_at }));
}

/** Backups of this database, newest first. */
export function listBackups(path: string): { file: string; bytes: number }[] {
  if (path === ":memory:" || !existsSync(dirname(path))) return [];
  const prefix = basename(path) + ".v";
  return readdirSync(dirname(path))
    .filter((f) => f.startsWith(prefix) && f.endsWith(".bak"))
    .sort().reverse()
    .map((f) => ({ file: join(dirname(path), f), bytes: statSize(join(dirname(path), f)) }));
}

function hasData(db: DatabaseSync): boolean {
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'").get();
  if (!t) return false;
  return !!db.prepare("SELECT 1 FROM events LIMIT 1").get();
}

function backup(db: DatabaseSync, path: string, from: number): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = `${path}.v${from}-${stamp}.bak`;
  db.prepare("VACUUM INTO ?").run(file);
  for (const old of listBackups(path).slice(KEEP_BACKUPS)) rmSync(old.file, { force: true });
  return file;
}

function statSize(file: string): number {
  try { return statSync(file).size; } catch { return 0; }
}
