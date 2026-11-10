import { registerProjection, type Projection } from "../store/projections.js";

/**
 * Imported repos and what the crew learned about them, derived from the log:
 *
 *   repo_imports      one row per imported repo (its project, source, working copy, last exploration)
 *   code_maps         one row per exploration: the static map of the repo at that commit
 *   code_modules      what each module is for, newest understanding, keyed by content hash (the cache)
 *   code_suggestions  every improvement or fix the crew suggested, and what became of it
 *
 * Events: repo.import.started, repo.imported, repo.import.failed,
 * repo.explore.started, repo.explore.station, repo.mapped, repo.module.understood,
 * repo.suggestion, repo.explore.finished; and the Council's improve.proposal /
 * improve.proposal.decided / improve.proposal.accepted when their source is a repo.suggestion.
 */
type P = Record<string, any>;

export const importsProjection: Projection = {
  name: "imports",
  version: 1,
  tables: ["repo_imports", "code_maps", "code_modules", "code_suggestions"],
  describe: "Imported git repos, their code maps, what each module does, and the crew's suggestions",
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS repo_imports (
      project_id  INTEGER PRIMARY KEY,
      source      TEXT NOT NULL,
      local       INTEGER NOT NULL,
      dir         TEXT NOT NULL,
      branch      TEXT,
      head        TEXT,
      status      TEXT NOT NULL,
      error       TEXT,
      imported_at TEXT NOT NULL,
      explored_at TEXT,
      explores    INTEGER NOT NULL DEFAULT 0,
      spent_usd   REAL NOT NULL DEFAULT 0,
      mapped_head TEXT
    );
    CREATE TABLE IF NOT EXISTS code_maps (
      project_id INTEGER NOT NULL,
      explore    INTEGER NOT NULL,
      ts         TEXT NOT NULL,
      head       TEXT,
      files      INTEGER NOT NULL,
      lines      INTEGER NOT NULL,
      modules    INTEGER NOT NULL,
      health     INTEGER NOT NULL,
      map        TEXT NOT NULL,
      PRIMARY KEY (project_id, explore)
    );
    CREATE TABLE IF NOT EXISTS code_modules (
      project_id INTEGER NOT NULL,
      module     TEXT NOT NULL,
      hash       TEXT NOT NULL,
      purpose    TEXT NOT NULL,
      role       TEXT NOT NULL,
      risks      TEXT NOT NULL,
      by         TEXT NOT NULL,
      ts         TEXT NOT NULL,
      PRIMARY KEY (project_id, module)
    );
    CREATE TABLE IF NOT EXISTS code_suggestions (
      id          TEXT PRIMARY KEY,
      project_id  INTEGER NOT NULL,
      event_id    INTEGER NOT NULL,
      ts          TEXT NOT NULL,
      title       TEXT NOT NULL,
      body        TEXT NOT NULL,
      kind        TEXT NOT NULL,
      lens        TEXT NOT NULL,
      severity    TEXT NOT NULL,
      effort      TEXT NOT NULL,
      files       TEXT NOT NULL,
      by          TEXT NOT NULL,
      status      TEXT NOT NULL,
      proposal_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS code_suggestions_project ON code_suggestions(project_id)`);
  },
  apply(db, e) {
    const p = e.payload as P;
    switch (e.type) {
      case "repo.import.started":
        db.prepare(`INSERT INTO repo_imports (project_id, source, local, dir, status, imported_at) VALUES (?, ?, ?, ?, 'importing', ?)
          ON CONFLICT(project_id) DO UPDATE SET source = excluded.source, local = excluded.local, dir = excluded.dir, status = 'importing', error = NULL`)
          .run(p.projectId, String(p.source), p.local ? 1 : 0, String(p.dir), e.ts);
        return;
      case "repo.imported":
        db.prepare("UPDATE repo_imports SET status = 'ready', branch = ?, head = ?, error = NULL WHERE project_id = ?").run(p.branch ?? null, p.head ?? null, p.projectId);
        return;
      case "repo.import.failed":
        db.prepare("UPDATE repo_imports SET status = 'failed', error = ? WHERE project_id = ?").run(String(p.error ?? "failed").slice(0, 500), p.projectId);
        return;
      case "repo.explore.started":
        db.prepare("UPDATE repo_imports SET status = 'exploring', explores = explores + 1, error = NULL WHERE project_id = ?").run(p.projectId);
        return;
      case "repo.mapped": {
        const m = p.map ?? {};
        db.prepare("INSERT OR REPLACE INTO code_maps (project_id, explore, ts, head, files, lines, modules, health, map) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(p.projectId, p.explore, e.ts, m.head ?? null, Number(m.files ?? 0), Number(m.lines ?? 0), (m.modules ?? []).length, Number(m.health?.score ?? 0), JSON.stringify(m));
        db.prepare("UPDATE repo_imports SET head = coalesce(?, head), branch = coalesce(?, branch) WHERE project_id = ?").run(m.head ?? null, m.branch ?? null, p.projectId);
        return;
      }
      case "repo.module.understood":
        db.prepare("INSERT OR REPLACE INTO code_modules (project_id, module, hash, purpose, role, risks, by, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(p.projectId, String(p.module), String(p.hash), String(p.purpose ?? ""), String(p.role ?? "other"), JSON.stringify(p.risks ?? []), String(p.by ?? "heuristic"), e.ts);
        return;
      case "repo.suggestion":
        db.prepare(`INSERT OR IGNORE INTO code_suggestions (id, project_id, event_id, ts, title, body, kind, lens, severity, effort, files, by, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
          .run(String(p.suggestionId), p.projectId, e.id, e.ts, String(p.title), String(p.body ?? ""), String(p.kind ?? "improvement"), String(p.lens ?? "code-health"),
            String(p.severity ?? "medium"), String(p.effort ?? "medium"), JSON.stringify(p.files ?? []), String(p.by ?? "heuristic"));
        return;
      case "repo.explore.finished":
        db.prepare("UPDATE repo_imports SET status = ?, explored_at = ?, spent_usd = spent_usd + ?, mapped_head = coalesce(?, mapped_head), error = ? WHERE project_id = ?")
          .run(p.outcome === "failed" ? "failed" : "ready", e.ts, Number(p.spentUsd ?? 0), p.head ?? null, p.outcome === "failed" ? String(p.error ?? "failed").slice(0, 500) : null, p.projectId);
        return;
      // The Council files each suggestion as a proposal and decides it; mirror that here.
      case "improve.proposal":
        if (p.source?.kind === "repo.suggestion" && p.source.suggestionId) {
          db.prepare("UPDATE code_suggestions SET status = 'proposed', proposal_id = ? WHERE id = ?").run(Number(p.id ?? e.id), String(p.source.suggestionId));
        }
        return;
      case "improve.proposal.decided": {
        const decision = String(p.decision ?? "");
        if (decision) db.prepare("UPDATE code_suggestions SET status = ? WHERE proposal_id = ?").run(decision, Number(p.id));
        return;
      }
      case "improve.proposal.accepted":
        if (p.source?.kind === "repo.suggestion" && p.source.suggestionId) db.prepare("UPDATE code_suggestions SET status = 'accepted' WHERE id = ?").run(String(p.source.suggestionId));
        return;
    }
  },
};

registerProjection(importsProjection);
