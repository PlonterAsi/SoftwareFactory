import { registerProjection, type Projection } from "../store/projections.js";

/**
 * The Agent Bay's and the Council's organized tables, derived from the event
 * log like every other table (docs/storage.md). Query them in any SQLite
 * browser, for example the pass rate of each agent version:
 *
 *   SELECT agent, version, avg(pass) AS pass_rate, count(*) AS verdicts
 *   FROM agent_verdicts GROUP BY agent, version;
 */
type P = Record<string, any>;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (v == null ? null : String(v));

export const bayProjection: Projection = {
  name: "bay",
  version: 1,
  tables: ["bay_agents", "bay_agent_versions", "bay_slots", "bay_tests", "agent_verdicts"],
  describe: "The Agent Bay: agents, every version of each, who works which station, test runs and verifier verdicts",
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS bay_agents (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      avatar      TEXT,
      station     TEXT,
      model       TEXT NOT NULL,
      budget_usd  REAL,
      plugins     TEXT,
      version     INTEGER NOT NULL,
      builtin     INTEGER NOT NULL DEFAULT 0,
      retired     INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bay_agent_versions (
      agent    TEXT NOT NULL,
      version  INTEGER NOT NULL,
      ts       TEXT NOT NULL,
      note     TEXT,
      saved_by TEXT,
      def      TEXT NOT NULL,
      PRIMARY KEY (agent, version)
    );
    CREATE TABLE IF NOT EXISTS bay_slots (
      slot  TEXT NOT NULL,
      seat  INTEGER NOT NULL,
      agent TEXT NOT NULL,
      ts    TEXT NOT NULL,
      PRIMARY KEY (slot, seat)
    );
    CREATE TABLE IF NOT EXISTS bay_tests (
      id       INTEGER PRIMARY KEY,
      agent    TEXT NOT NULL,
      version  INTEGER,
      station  TEXT,
      task     TEXT,
      status   TEXT NOT NULL CHECK (status IN ('running', 'pass', 'fail')),
      cost_usd REAL,
      checks   TEXT,
      started_at TEXT NOT NULL,
      ended_at   TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_verdicts (
      id          INTEGER PRIMARY KEY,
      ts          TEXT NOT NULL,
      agent       TEXT NOT NULL,
      version     INTEGER,
      station     TEXT,
      factory_run INTEGER,
      round       INTEGER,
      pass        INTEGER NOT NULL,
      note        TEXT
    );
    CREATE INDEX IF NOT EXISTS agent_verdicts_agent ON agent_verdicts(agent, version)`);
  },
  apply(db, e) {
    const p = e.payload as P;
    if (e.type === "bay.agent.saved") {
      const d = p.def ?? {};
      db.prepare(`INSERT INTO bay_agents (id, name, avatar, station, model, budget_usd, plugins, version, builtin, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar, station = excluded.station, model = excluded.model,
          budget_usd = excluded.budget_usd, plugins = excluded.plugins, version = excluded.version, updated_at = excluded.updated_at`)
        .run(String(p.id), String(d.name ?? p.id), str(d.avatar), str(d.station), String(d.model ?? "?"), num(d.budgetUsd), JSON.stringify(d.plugins ?? []), Number(p.version), p.builtin ? 1 : 0, e.ts, e.ts);
      db.prepare("INSERT OR REPLACE INTO bay_agent_versions (agent, version, ts, note, saved_by, def) VALUES (?, ?, ?, ?, ?, ?)")
        .run(String(p.id), Number(p.version), e.ts, str(p.note), str(p.by), JSON.stringify(d));
    } else if (e.type === "bay.agent.retired") {
      db.prepare("UPDATE bay_agents SET retired = ?, updated_at = ? WHERE id = ?").run(p.retired === false ? 0 : 1, e.ts, String(p.id));
    } else if (e.type === "bay.assign") {
      db.prepare("DELETE FROM bay_slots WHERE slot = ?").run(String(p.slot));
      (p.agents ?? []).forEach((a: string, i: number) => db.prepare("INSERT INTO bay_slots (slot, seat, agent, ts) VALUES (?, ?, ?, ?)").run(String(p.slot), i, String(a), e.ts));
    } else if (e.type === "bay.test") {
      if (p.state === "running") {
        db.prepare("INSERT OR REPLACE INTO bay_tests (id, agent, version, station, task, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)")
          .run(e.id, String(p.agent), num(p.version), str(p.station), str(p.task), e.ts);
      } else {
        db.prepare("UPDATE bay_tests SET status = ?, cost_usd = ?, checks = ?, ended_at = ? WHERE id = ?")
          .run(p.pass ? "pass" : "fail", num(p.costUsd), JSON.stringify(p.checks ?? []), e.ts, Number(p.id));
      }
    } else if (e.type === "agent.verdict") {
      db.prepare("INSERT OR REPLACE INTO agent_verdicts (id, ts, agent, version, station, factory_run, round, pass, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(e.id, e.ts, String(p.agent), num(p.version), str(p.station), num(p.run), num(p.round), p.pass ? 1 : 0, str(p.note));
    }
  },
};

export const councilProjection: Projection = {
  name: "council",
  version: 1,
  tables: ["council_sessions", "council_seats", "reviews"],
  describe: "Council sessions (one row per round, with the brief), each seat's take and vote, and every review of a build",
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS council_sessions (
      factory_run INTEGER NOT NULL,
      round       INTEGER NOT NULL,
      ts          TEXT NOT NULL,
      outcome     TEXT NOT NULL,
      votes       TEXT NOT NULL,
      agreed      TEXT NOT NULL,
      proposals   TEXT NOT NULL,
      concerns    TEXT NOT NULL,
      PRIMARY KEY (factory_run, round)
    );
    CREATE TABLE IF NOT EXISTS council_seats (
      factory_run INTEGER NOT NULL,
      round       INTEGER NOT NULL,
      seat        INTEGER NOT NULL,
      agent       TEXT NOT NULL,
      version     INTEGER,
      vote        TEXT,
      scope       TEXT,
      take        TEXT,
      error       TEXT,
      PRIMARY KEY (factory_run, round, seat)
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id          INTEGER PRIMARY KEY,
      factory_run INTEGER NOT NULL,
      round       INTEGER NOT NULL,
      agent       TEXT,
      verdict     TEXT NOT NULL,
      findings    TEXT NOT NULL,
      ts          TEXT NOT NULL
    )`);
  },
  apply(db, e) {
    const p = e.payload as P;
    if (e.type === "factory.council") {
      const b = p.brief ?? {};
      db.prepare("INSERT OR REPLACE INTO council_sessions (factory_run, round, ts, outcome, votes, agreed, proposals, concerns) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(Number(p.run), Number(p.round), e.ts, String(b.outcome ?? "?"), JSON.stringify(b.votes ?? {}), JSON.stringify(b.agreed ?? []), JSON.stringify(b.proposals ?? []), JSON.stringify(b.concerns ?? []));
      (p.seats ?? []).forEach((s: P, i: number) => db.prepare("INSERT OR REPLACE INTO council_seats (factory_run, round, seat, agent, version, vote, scope, take, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(Number(p.run), Number(p.round), i, String(s.agent), num(s.version), str(s.take?.vote), str(s.take?.scope), str(s.take?.take), str(s.error)));
    } else if (e.type === "factory.review") {
      db.prepare("INSERT OR REPLACE INTO reviews (id, factory_run, round, agent, verdict, findings, ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(e.id, Number(p.run), Number(p.round), str(p.agent), String(p.verdict), JSON.stringify(p.findings ?? []), e.ts);
    }
  },
};

registerProjection(bayProjection);
registerProjection(councilProjection);
