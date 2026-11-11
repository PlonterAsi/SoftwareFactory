import { registerProjection, type Projection } from "../store/projections.js";

/**
 * The Improvement Council's organized tables, derived from the event log like
 * every other table (docs/storage.md). For example, what the person thinks of
 * each lens:
 *
 *   SELECT lens.value AS lens, status, count(*) FROM improve_proposals, json_each(lenses) AS lens GROUP BY 1, 2;
 */
type P = Record<string, any>;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (v == null ? null : String(v));

export const improveProjection: Projection = {
  name: "improve",
  version: 1,
  tables: ["improve_sessions", "improve_proposals"],
  describe: "Improvement Council: every session (subject, lenses, cost) and every proposal with your answer (accepted, rejected, parked)",
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS improve_sessions (
      id           INTEGER PRIMARY KEY,
      ts           TEXT NOT NULL,
      trigger      TEXT NOT NULL,
      target_kind  TEXT NOT NULL,
      target_id    INTEGER,
      target_title TEXT NOT NULL,
      seats        INTEGER NOT NULL,
      status       TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
      cost_usd     REAL NOT NULL DEFAULT 0,
      proposals    INTEGER NOT NULL DEFAULT 0,
      suppressed   INTEGER NOT NULL DEFAULT 0,
      note         TEXT,
      ended_at     TEXT
    );
    CREATE TABLE IF NOT EXISTS improve_proposals (
      id           INTEGER PRIMARY KEY,
      ts           TEXT NOT NULL,
      session      INTEGER,
      target_kind  TEXT NOT NULL,
      target_id    INTEGER,
      target_title TEXT NOT NULL,
      title        TEXT NOT NULL,
      why          TEXT,
      change       TEXT NOT NULL,
      impact       TEXT NOT NULL,
      effort       TEXT NOT NULL,
      lenses       TEXT NOT NULL,
      score        REAL NOT NULL,
      status       TEXT NOT NULL CHECK (status IN ('inbox', 'accepted', 'rejected', 'parked')),
      decided_at   TEXT,
      note         TEXT,
      ticket_id    INTEGER,
      signal_id    INTEGER
    );
    CREATE INDEX IF NOT EXISTS improve_proposals_target ON improve_proposals(target_kind, target_id);
    CREATE INDEX IF NOT EXISTS improve_proposals_status ON improve_proposals(status)`);
  },
  apply(db, e) {
    const p = e.payload as P;
    switch (e.type) {
      case "improve.session":
        if (p.state === "started") {
          db.prepare("INSERT OR REPLACE INTO improve_sessions (id, ts, trigger, target_kind, target_id, target_title, seats, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'running')")
            .run(e.id, e.ts, String(p.trigger ?? "manual"), String(p.target?.kind ?? "factory"), num(p.target?.id), String(p.target?.title ?? ""), Number(p.seats?.length ?? 0));
        } else {
          db.prepare("UPDATE improve_sessions SET status = ?, cost_usd = ?, proposals = ?, suppressed = ?, note = ?, ended_at = ? WHERE id = ?")
            .run(p.state === "failed" ? "failed" : "done", num(p.costUsd) ?? 0, Number(p.proposals?.length ?? 0), Number(p.suppressed?.length ?? 0), str(p.note), e.ts, Number(p.session));
        }
        break;
      case "improve.proposal":
        db.prepare(`INSERT OR REPLACE INTO improve_proposals (id, ts, session, target_kind, target_id, target_title, title, why, change, impact, effort, lenses, score, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'inbox')`)
          .run(e.id, e.ts, num(p.session), String(p.target?.kind ?? "factory"), num(p.target?.id), String(p.target?.title ?? ""), String(p.title), str(p.why), String(p.change),
            String(p.impact ?? "medium"), String(p.effort ?? "medium"), JSON.stringify(p.lenses ?? []), Number(p.score ?? 0));
        break;
      case "improve.proposal.decided":
        db.prepare("UPDATE improve_proposals SET status = ?, decided_at = ?, note = ? WHERE id = ?").run(String(p.decision), e.ts, str(p.note), Number(p.id));
        break;
      case "improve.proposal.linked":
        db.prepare("UPDATE improve_proposals SET ticket_id = coalesce(?, ticket_id), signal_id = coalesce(?, signal_id) WHERE id = ?").run(num(p.ticketId), num(p.signalId), Number(p.id));
        break;
    }
  },
};

registerProjection(improveProjection);
