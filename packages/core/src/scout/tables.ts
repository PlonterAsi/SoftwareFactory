import { registerProjection, type Projection } from "../store/projections.js";

/**
 * Scout's catalog as a table, derived from the event log like every other table (docs/storage.md). For example,
 * the best finds of the week:
 *
 *   SELECT title, category, verdict, score FROM scout_finds WHERE verdict != 'skip' AND ts > date('now', '-7 days') ORDER BY score DESC;
 */
type P = Record<string, any>;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (v == null ? null : String(v));

export const scoutProjection: Projection = {
  name: "scout",
  version: 1,
  tables: ["scout_finds"],
  describe: "Scout: every find (skills, plugins, MCP servers, prompts, tips, pages to follow) with its category, scores, verdict, trial and ticket",
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS scout_finds (
      id          INTEGER PRIMARY KEY,
      project_id  INTEGER NOT NULL,
      ts          TEXT NOT NULL,
      key         TEXT NOT NULL,
      url         TEXT NOT NULL,
      title       TEXT NOT NULL,
      source      TEXT NOT NULL,
      snippet     TEXT,
      meta        TEXT NOT NULL DEFAULT '{}',
      status      TEXT NOT NULL CHECK (status IN ('new', 'rated')),
      category    TEXT,
      summary     TEXT,
      scores      TEXT,
      score       REAL,
      verdict     TEXT,
      verdict_by  TEXT,
      verdict_note TEXT,
      where_used  TEXT,
      how         TEXT,
      risk        TEXT,
      minutes     REAL,
      usd         REAL,
      follow      INTEGER NOT NULL DEFAULT 0,
      trial       TEXT NOT NULL DEFAULT 'none',
      trial_note  TEXT,
      ticket_id   INTEGER,
      filed_by    TEXT,
      cost_usd    REAL NOT NULL DEFAULT 0,
      rated_at    TEXT,
      updated_at  TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS scout_finds_key ON scout_finds(project_id, key);
    CREATE INDEX IF NOT EXISTS scout_finds_project ON scout_finds(project_id, ts)`);
  },
  apply(db, e) {
    const p = e.payload as P;
    if (e.type === "scout.found") {
      db.prepare(`INSERT OR IGNORE INTO scout_finds (id, project_id, ts, key, url, title, source, snippet, meta, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`).run(e.id, Number(p.projectId), e.ts, String(p.key), String(p.url), String(p.title ?? p.url).slice(0, 300), String(p.source ?? "web"), str(p.snippet), JSON.stringify(p.meta ?? {}), e.ts);
    } else if (e.type === "scout.analyzed") {
      db.prepare(`UPDATE scout_finds SET status = 'rated', category = ?, summary = ?, scores = ?, score = ?, verdict = ?, verdict_by = 'scout', where_used = ?, how = ?, risk = ?,
        minutes = ?, usd = ?, follow = ?, trial = ?, cost_usd = cost_usd + ?, rated_at = ?, updated_at = ? WHERE id = ?`)
        .run(str(p.category), str(p.summary), JSON.stringify(p.scores ?? {}), num(p.score), str(p.verdict), str(p.where), str(p.how), str(p.risk),
          num(p.minutes), num(p.usd), p.follow ? 1 : 0, String(p.trial ?? "none"), num(p.costUsd) ?? 0, e.ts, e.ts, Number(p.id));
    } else if (e.type === "scout.judged") {
      db.prepare("UPDATE scout_finds SET verdict = ?, verdict_by = ?, verdict_note = ?, updated_at = ? WHERE id = ?").run(String(p.verdict), String(p.by ?? "you"), str(p.note), e.ts, Number(p.id));
    } else if (e.type === "scout.filed") {
      db.prepare("UPDATE scout_finds SET ticket_id = ?, filed_by = ?, updated_at = ? WHERE id = ?").run(Number(p.ticketId), String(p.by ?? "you"), e.ts, Number(p.id));
    } else if (e.type === "scout.trial") {
      db.prepare("UPDATE scout_finds SET trial = ?, trial_note = coalesce(?, trial_note), cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?").run(String(p.state), str(p.note), num(p.costUsd) ?? 0, e.ts, Number(p.id));
    }
  },
};

registerProjection(scoutProjection);
