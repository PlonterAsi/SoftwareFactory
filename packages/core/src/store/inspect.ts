import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EventLog, ProjectionStatus } from "../events.js";
import { appliedMigrations, listBackups, SCHEMA_VERSION, type AppliedMigration } from "./migrations.js";
import type { CacheEntryStats } from "./cache.js";

/**
 * One picture of the three storage tiers, for the Bridge's Data deck:
 * the database (event log + organized tables), the files on disk the database
 * points at, and the in-memory cache.
 */
export interface StoreReport {
  database: {
    path: string;
    bytes: number;
    walBytes: number;
    schemaVersion: number;
    latestSchema: number;
    migrations: AppliedMigration[];
    backups: { file: string; bytes: number }[];
    events: { total: number; lastId: number; byType: { type: string; count: number }[] };
    tables: { name: string; rows: number; projection: string | null }[];
    projections: (ProjectionStatus & { behind: number })[];
  };
  files: {
    root: string;
    exists: boolean;
    projects: { run: number; name: string; dir: string; onDisk: boolean; files: number; bytes: number; tracked: number; missing: string[] }[];
    /** Folders on disk that no factory run points at. */
    orphans: string[];
  };
  cache: { views: CacheEntryStats[]; hits: number; misses: number };
}

export function storeReport(log: EventLog, projectsDir: string): StoreReport {
  const db = log.db;
  const lastId = log.lastId();
  const projections = log.projectionStatus().map((p) => ({ ...p, behind: Math.max(0, lastId - p.lastEventId) }));
  const owner = new Map(projections.flatMap((p) => p.tables.map((t) => [t, p.name] as const)));
  const tableNames = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'signal_fts_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  const tables = tableNames.map((name) => ({
    name,
    rows: Number((db.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n),
    projection: owner.get(name) ?? null,
  }));
  const byType = (db.prepare("SELECT type, count(*) AS count FROM events GROUP BY type ORDER BY count DESC").all() as { type: string; count: number }[])
    .map((r) => ({ type: r.type, count: Number(r.count) }));
  const pageSize = Number((db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size);
  const pages = Number((db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count);
  const views = log.cache.stats();
  return {
    database: {
      path: log.path,
      bytes: pageSize * pages,
      walBytes: log.path === ":memory:" ? 0 : size(log.path + "-wal"),
      schemaVersion: Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version),
      latestSchema: SCHEMA_VERSION,
      migrations: appliedMigrations(db),
      backups: listBackups(log.path),
      events: { total: byType.reduce((s, r) => s + r.count, 0), lastId, byType },
      tables,
      projections,
    },
    files: filesReport(log, projectsDir),
    cache: { views, hits: views.reduce((s, v) => s + v.hits, 0), misses: views.reduce((s, v) => s + v.misses, 0) },
  };
}

function filesReport(log: EventLog, projectsDir: string): StoreReport["files"] {
  const root = resolve(projectsDir);
  const runs = log.db.prepare("SELECT id, coalesce(plan_name, idea) AS name, dir FROM factory_runs WHERE dir IS NOT NULL ORDER BY id").all() as { id: number; name: string; dir: string }[];
  const tracked = log.db.prepare("SELECT path FROM artifacts WHERE run = ?");
  const projects = runs.map((r) => {
    const onDisk = existsSync(r.dir);
    const walk = onDisk ? countTree(r.dir) : { files: 0, bytes: 0 };
    const paths = (tracked.all(r.id) as { path: string }[]).map((x) => x.path);
    return {
      run: Number(r.id), name: r.name, dir: r.dir, onDisk, ...walk, tracked: paths.length,
      missing: paths.filter((p) => !existsSync(join(r.dir, p))).slice(0, 20),
    };
  });
  const known = new Set(runs.map((r) => resolve(r.dir)));
  const orphans = existsSync(root)
    ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !known.has(join(root, d.name))).map((d) => d.name)
    : [];
  return { root, exists: existsSync(root), projects, orphans };
}

function countTree(dir: string): { files: number; bytes: number } {
  let files = 0, bytes = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const abs = join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) { files++; bytes += size(abs); }
    }
  };
  walk(dir);
  return { files, bytes };
}

function size(file: string): number {
  try { return statSync(file).size; } catch { return 0; }
}
