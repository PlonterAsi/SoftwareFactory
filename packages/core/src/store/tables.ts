import type { DatabaseSync } from "node:sqlite";
import type { SfEvent } from "../events.js";
import { foldOrder, type OrderState } from "../order/model.js";
import type { Projection } from "./projections.js";

/**
 * The core's organized tables, all derived from the event log (see projections.ts).
 * Open factory.db in any SQLite browser and these are what you query.
 */
type P = Record<string, any>;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (v == null ? null : String(v));

export const signalsProjection: Projection = {
  name: "signals",
  version: 1,
  tables: ["signals"],
  describe: "Everything you said or pasted, raw and never edited",
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS signals (
      id     INTEGER PRIMARY KEY,
      ts     TEXT NOT NULL,
      source TEXT NOT NULL,
      text   TEXT NOT NULL
    )`);
  },
  apply(db, e) {
    if (e.type !== "signal.captured") return;
    const p = e.payload as P;
    db.prepare("INSERT OR REPLACE INTO signals (id, ts, source, text) VALUES (?, ?, ?, ?)").run(e.id, e.ts, String(p.source ?? ""), String(p.text ?? ""));
  },
};

export const agentRunsProjection: Projection = {
  name: "agent_runs",
  version: 1,
  tables: ["agent_runs"],
  describe: "Every agent call: who, which model, how long, what it cost",
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_runs (
      id             INTEGER PRIMARY KEY,
      agent          TEXT NOT NULL,
      runtime        TEXT,
      model          TEXT,
      factory_run    INTEGER,
      station        TEXT,
      budget_usd     REAL,
      started_at     TEXT NOT NULL,
      ended_at       TEXT,
      status         TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
      cost_usd       REAL NOT NULL DEFAULT 0,
      duration_ms    INTEGER,
      context_tokens INTEGER,
      models         TEXT,
      error          TEXT
    );
    CREATE INDEX IF NOT EXISTS agent_runs_factory ON agent_runs(factory_run);
    CREATE INDEX IF NOT EXISTS agent_runs_started ON agent_runs(started_at)`);
  },
  apply(db, e) {
    const p = e.payload as P;
    if (e.type === "agent.run.started") {
      db.prepare(`INSERT OR REPLACE INTO agent_runs (id, agent, runtime, model, factory_run, station, budget_usd, started_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')`).run(e.id, String(p.agent ?? "?"), str(p.runtime), str(p.model), num(p.factoryRun), str(p.station), num(p.budgetUsd), e.ts);
    } else if (e.type === "agent.run.completed") {
      db.prepare(`UPDATE agent_runs SET status = 'done', ended_at = ?, cost_usd = ?, duration_ms = ?, context_tokens = ?, models = ? WHERE id = ?`)
        .run(e.ts, num(p.costUsd) ?? 0, num(p.durationMs), num(p.contextTokens), JSON.stringify(p.models ?? []), Number(p.runId));
    } else if (e.type === "agent.run.failed") {
      db.prepare(`UPDATE agent_runs SET status = 'failed', ended_at = ?, error = ?, cost_usd = ? WHERE id = ?`).run(e.ts, str(p.error), num(p.costUsd) ?? 0, Number(p.runId));
    }
  },
};

export const factoryRunsProjection: Projection = {
  name: "factory_runs",
  // v2: runs can resume (resumes, resumed_from).
  version: 2,
  tables: ["factory_runs", "artifacts"],
  describe: "Factory runs and every file they wrote (the files live on disk; these rows point at them)",
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS factory_runs (
      id          INTEGER PRIMARY KEY,
      idea        TEXT NOT NULL,
      runtime     TEXT,
      max_usd     REAL,
      started_at  TEXT NOT NULL,
      finished_at TEXT,
      outcome     TEXT,
      reason      TEXT,
      plan_name   TEXT,
      dir         TEXT,
      sha         TEXT,
      total_usd   REAL,
      agent_calls INTEGER,
      fix_rounds  INTEGER,
      resumes     INTEGER NOT NULL DEFAULT 0,
      resumed_from TEXT
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      run        INTEGER NOT NULL,
      path       TEXT    NOT NULL,
      station    TEXT,
      round      INTEGER,
      bytes      INTEGER NOT NULL,
      lines      INTEGER,
      sha256     TEXT,
      versions   INTEGER NOT NULL DEFAULT 1,
      event_id   INTEGER NOT NULL,
      updated_at TEXT    NOT NULL,
      PRIMARY KEY (run, path)
    )`);
  },
  apply(db, e) {
    const p = e.payload as P;
    switch (e.type) {
      case "factory.run.started":
        db.prepare("INSERT OR REPLACE INTO factory_runs (id, idea, runtime, max_usd, started_at) VALUES (?, ?, ?, ?, ?)").run(e.id, String(p.idea ?? ""), str(p.runtime), num(p.maxUsd), e.ts);
        break;
      case "factory.plan":
        db.prepare("UPDATE factory_runs SET dir = ?, plan_name = ?, sha = coalesce(?, sha) WHERE id = ?").run(str(p.dir), str(p.plan?.name), str(p.sha), Number(p.run));
        upsertArtifacts(db, e, { ...p, station: "plan", round: null });
        break;
      case "factory.run.finished":
        db.prepare(`UPDATE factory_runs SET finished_at = ?, outcome = ?, reason = ?, dir = coalesce(?, dir), sha = coalesce(?, sha),
          plan_name = coalesce(?, plan_name), total_usd = ?, agent_calls = ?, fix_rounds = ? WHERE id = ?`)
          .run(e.ts, str(p.outcome), str(p.reason), str(p.dir), str(p.sha), str(p.plan), num(p.totalUsd), num(p.agentCalls), num(p.fixRounds), Number(p.run));
        break;
      case "factory.run.resumed":
        // Back in flight: the stop that came before is history (still in the log).
        db.prepare("UPDATE factory_runs SET finished_at = NULL, outcome = NULL, reason = NULL, resumes = resumes + 1, resumed_from = ? WHERE id = ?").run(str(p.from), Number(p.run));
        break;
      case "factory.files":
        upsertArtifacts(db, e, p);
        break;
    }
  },
};

/** Record the files a station wrote; a file written again counts one more version. */
function upsertArtifacts(db: DatabaseSync, e: SfEvent, p: P) {
  const up = db.prepare(`INSERT INTO artifacts (run, path, station, round, bytes, lines, sha256, event_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (run, path) DO UPDATE SET station = excluded.station, round = excluded.round, bytes = excluded.bytes, lines = excluded.lines,
      sha256 = excluded.sha256, event_id = excluded.event_id, updated_at = excluded.updated_at, versions = artifacts.versions + 1`);
  for (const w of (p.written ?? []) as P[]) up.run(Number(p.run), String(w.path), str(p.station), num(p.round), num(w.bytes) ?? 0, num(w.lines), str(w.sha256), e.id, e.ts);
}

/** The Order Engine's tree, materialized from its fold after any order event. */
export const ORDER_VIEW = "order";
export const orderView = (events: SfEvent[]): OrderState => foldOrder(events);

export const orderProjection: Projection = {
  name: "order",
  version: 1,
  tables: ["order_nodes", "order_fragments", "order_conflicts"],
  describe: "The Order Engine's tree: projects, ideas, threads, fragments and conflicts",
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS order_nodes (
      id          INTEGER PRIMARY KEY,
      kind        TEXT NOT NULL,
      title       TEXT NOT NULL,
      parent_id   INTEGER,
      merged_into INTEGER,
      signal_id   INTEGER,
      by_agent    TEXT,
      created_at  TEXT NOT NULL,
      last_active TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS order_fragments (
      id                INTEGER PRIMARY KEY,
      signal_id         INTEGER NOT NULL,
      node_id           INTEGER,
      suggested_node_id INTEGER,
      kind              TEXT NOT NULL,
      text              TEXT NOT NULL,
      confidence        REAL NOT NULL,
      important         INTEGER NOT NULL,
      pinned            INTEGER NOT NULL,
      origin            TEXT NOT NULL,
      by_agent          TEXT,
      state             TEXT NOT NULL,
      superseded_by     INTEGER,
      ts                TEXT NOT NULL,
      last_touched      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS order_fragments_node ON order_fragments(node_id);
    CREATE TABLE IF NOT EXISTS order_conflicts (
      id      INTEGER PRIMARY KEY,
      ts      TEXT NOT NULL,
      a       INTEGER NOT NULL,
      b       INTEGER NOT NULL,
      node_id INTEGER,
      status  TEXT NOT NULL,
      reason  TEXT,
      winner  INTEGER,
      loser   INTEGER,
      rule    TEXT,
      effect  TEXT
    )`);
  },
  flush(db, ctx, types) {
    if (![...types].some((t) => t.startsWith("order."))) return;
    const st = ctx.view(ORDER_VIEW, orderView);
    db.exec("DELETE FROM order_nodes; DELETE FROM order_fragments; DELETE FROM order_conflicts;");
    const n = db.prepare("INSERT INTO order_nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const x of st.nodes) n.run(x.id, x.kind, x.title, x.parentId, x.mergedInto ?? null, x.signalId, x.by, x.createdAt, x.lastActive);
    const f = db.prepare("INSERT INTO order_fragments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const x of st.fragments) f.run(x.id, x.signalId, x.nodeId, x.suggestedNodeId, x.kind, x.text, x.confidence, x.important ? 1 : 0, x.pinned ? 1 : 0, x.origin, x.by, x.state, x.supersededBy ?? null, x.ts, x.lastTouched);
    const c = db.prepare("INSERT INTO order_conflicts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const x of st.conflicts) c.run(x.id, x.ts, x.a, x.b, x.nodeId, x.status, x.reason, x.winner ?? null, x.loser ?? null, x.rule ?? null, x.effect ?? null);
  },
};

export const CORE_PROJECTIONS: Projection[] = [signalsProjection, agentRunsProjection, factoryRunsProjection, orderProjection];
