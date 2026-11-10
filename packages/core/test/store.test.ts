import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventLog, OrderEngine, Factory, MockRuntime, captureSignal, listSignals, runAgent, costSummary, storeReport,
  registerProjection, SCHEMA_VERSION, type Projection,
} from "../src/index.js";

const tmp = (p = "sf-store-") => mkdtempSync(join(tmpdir(), p));
const rows = (log: EventLog, sql: string, ...args: (string | number)[]) => log.db.prepare(sql).all(...args) as Record<string, any>[];
const count = (log: EventLog, table: string) => Number((log.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);

/** A database with real history: Signals filed by the Order Engine, agent calls and a shipped factory run. */
async function seeded(dir: string) {
  const path = join(dir, "factory.db");
  const log = new EventLog(path);
  const order = new OrderEngine(log, null, { mode: "heuristic" });
  log.on("event", (e) => { if (e.type === "signal.captured") order.ingest({ id: e.id, text: (e.payload as any).text, source: "bridge" }); });
  captureSignal(log, "Project SoftwareFactory. Rule: approval stations must be minimal.");
  captureSignal(log, "idea: a star map of every project");
  await order.idle();
  const f = new Factory(log, new MockRuntime({ delayMs: 0 }), join(dir, "projects"));
  await f.wait(f.start("a CLI that counts words", { autoApprove: true }));
  return { path, log, order };
}

describe("storage: database, files and cache", () => {
  it("creates a versioned schema with organized tables on a fresh database", () => {
    const log = new EventLog();
    expect(Number((log.db.prepare("PRAGMA user_version").get() as any).user_version)).toBe(SCHEMA_VERSION);
    const tables = rows(log, "SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
    for (const t of ["events", "schema_migrations", "projections", "signals", "agent_runs", "factory_runs", "artifacts", "order_nodes", "order_fragments", "order_conflicts"]) expect(tables).toContain(t);
    expect(log.migration.backup).toBeNull();
  });

  it("keeps every table in step with the log, in the same transaction", async () => {
    const dir = tmp();
    const { log } = await seeded(dir);
    expect(listSignals(log).map((s) => s.text).slice(0, 2)).toEqual(["Project SoftwareFactory. Rule: approval stations must be minimal.", "idea: a star map of every project"]);
    const run = rows(log, "SELECT * FROM factory_runs")[0];
    expect(run).toMatchObject({ outcome: "shipped", fix_rounds: 1, agent_calls: 4 });
    expect(existsSync(run.dir)).toBe(true);
    // Artifacts point at real files, with hashes; a file rewritten by the fix round has 2 versions.
    const arts = rows(log, "SELECT path, sha256, versions FROM artifacts WHERE run = ?", run.id);
    expect(arts.map((a) => a.path)).toEqual(expect.arrayContaining(["SPEC.md", "src/count.js"]));
    expect(arts.every((a) => /^[0-9a-f]{64}$/.test(a.sha256))).toBe(true);
    expect(arts.find((a) => a.path === "src/count.js")!.versions).toBe(2);
    expect(rows(log, "SELECT status, count(*) AS n FROM agent_runs GROUP BY status")).toEqual([{ status: "done", n: 4 }]);
    expect(costSummary(log)).toMatchObject({ runs: 4, failed: 0 });
    expect(count(log, "order_nodes")).toBeGreaterThan(0);
    expect(rows(log, "SELECT kind FROM order_fragments WHERE important = 1").map((r) => r.kind)).toContain("rule");
    expect(log.projectionStatus().every((p) => p.lastEventId === log.lastId() && !p.error)).toBe(true);
    log.close();
  });

  it("upgrades a milestone 1 to 3 database without losing anything, after backing it up", async () => {
    const dir = tmp();
    const { path, log } = await seeded(dir);
    const before = { events: count(log, "events"), signals: count(log, "signals"), runs: count(log, "agent_runs"), frags: count(log, "order_fragments"), arts: count(log, "artifacts") };
    log.close();
    // Turn it back into the old layout: just the event log and its search index, no schema version.
    const raw = new DatabaseSync(path);
    for (const t of ["schema_migrations", "projections", "signals", "agent_runs", "factory_runs", "artifacts", "order_nodes", "order_fragments", "order_conflicts"]) raw.exec(`DROP TABLE ${t}`);
    raw.exec("PRAGMA user_version = 0");
    raw.close();

    const up = new EventLog(path);
    expect(up.migration).toMatchObject({ from: 0, to: SCHEMA_VERSION });
    expect(up.migration.backup && existsSync(up.migration.backup)).toBe(true);
    expect(count(up, "events")).toBe(before.events + 1); // + the store.migrated record
    expect(up.list({ type: "store.migrated" })[0].payload).toMatchObject({ from: 0, to: SCHEMA_VERSION });
    expect({ events: before.events, signals: count(up, "signals"), runs: count(up, "agent_runs"), frags: count(up, "order_fragments"), arts: count(up, "artifacts") }).toEqual(before);
    // The backup opens on its own and holds the old log.
    const bak = new DatabaseSync(up.migration.backup!);
    expect(Number((bak.prepare("SELECT count(*) AS n FROM events").get() as any).n)).toBe(before.events);
    bak.close();
    up.close();
    // Opening again changes nothing.
    const again = new EventLog(path);
    expect(again.migration.applied).toEqual([]);
    expect(again.list({ type: "store.migrated" }).length).toBe(1);
    again.close();
  });

  it("rebuilds every table from the log alone, to the same rows", async () => {
    const { log } = await seeded(tmp());
    const snap = () => ["signals", "agent_runs", "factory_runs", "artifacts", "order_nodes", "order_fragments", "order_conflicts"].map((t) => rows(log, `SELECT * FROM ${t} ORDER BY 1, 2`));
    const before = snap();
    log.db.exec("DELETE FROM agent_runs; DELETE FROM order_fragments;");
    log.rebuild();
    expect(snap()).toEqual(before);
    expect(log.list({ type: "store.rebuilt" }).length).toBe(1);
    log.close();
  });

  it("never loses an event to a broken projection, and reports it", () => {
    const broken: Projection = {
      name: "broken_test", version: 1, tables: ["broken_test"], describe: "test",
      migrate: (db) => db.exec("CREATE TABLE IF NOT EXISTS broken_test (id INTEGER PRIMARY KEY)"),
      apply: (db, e) => { db.prepare("INSERT INTO broken_test VALUES (?)").run(e.id); if (e.type === "signal.captured") throw new Error("boom"); },
    };
    const log = new EventLog();
    log.addProjection(broken);
    captureSignal(log, "still here");
    expect(listSignals(log).map((s) => s.text)).toEqual(["still here"]);
    expect(count(log, "broken_test")).toBe(0); // its half-done change was rolled back
    expect(log.projectionStatus().find((p) => p.name === "broken_test")!.error).toContain("boom");
  });

  it("lets other modules register tables that are backfilled from history", () => {
    const dir = tmp();
    const path = join(dir, "f.db");
    const a = new EventLog(path);
    captureSignal(a, "one"); captureSignal(a, "two");
    a.close();
    registerProjection({
      name: "signal_lengths", version: 1, tables: ["signal_lengths"], describe: "test",
      migrate: (db) => db.exec("CREATE TABLE IF NOT EXISTS signal_lengths (id INTEGER PRIMARY KEY, len INTEGER)"),
      apply: (db, e) => { if (e.type === "signal.captured") db.prepare("INSERT INTO signal_lengths VALUES (?, ?)").run(e.id, (e.payload as any).text.length); },
    });
    const b = new EventLog(path);
    expect(rows(b, "SELECT len FROM signal_lengths ORDER BY id").map((r) => r.len)).toEqual([3, 3]);
    b.close();
  });

  it("serves folded views from the cache until a new event lands", async () => {
    const log = new EventLog();
    const order = new OrderEngine(log, null, { mode: "heuristic" });
    order.state(); order.state(); order.state();
    const v = () => log.cache.stats().find((s) => s.name === "order")!;
    const hits = v().hits;
    expect(hits).toBeGreaterThanOrEqual(2);
    await order.ingest({ id: captureSignal(log, "Project X. Rule: always test").id, text: "Project X. Rule: always test" });
    expect(v().key).toBe(log.lastId());
    log.cache.clear();
    expect(order.state().fragments.length).toBeGreaterThan(0); // recomputed from the database
  });

  it("reports the three tiers, including files the database cannot find", async () => {
    const dir = tmp();
    const { log } = await seeded(dir);
    const run = rows(log, "SELECT dir FROM factory_runs")[0];
    rmSync(join(run.dir, "SPEC.md"));
    const r = storeReport(log, join(dir, "projects"));
    expect(r.database.schemaVersion).toBe(SCHEMA_VERSION);
    expect(r.database.tables.find((t) => t.name === "events")!.rows).toBe(log.lastId());
    expect(r.database.projections.every((p) => p.behind === 0)).toBe(true);
    expect(r.files.projects[0]).toMatchObject({ onDisk: true, missing: ["SPEC.md"] });
    expect(r.files.projects[0].files).toBeGreaterThan(3);
    expect(r.files.orphans).toEqual([]);
    expect(r.cache.views.map((v) => v.name)).toContain("order");
    log.close();
  });
});
