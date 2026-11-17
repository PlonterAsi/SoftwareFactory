import { registerProjection, type Projection } from "../store/projections.js";

/**
 * The git manager's tables (docs/git.md), kept current event by event and rebuildable from the log.
 *
 *   project_git   one row per project: its repo once published, the worth-continuing verdict, the merge
 *                 policy ("ask" or "auto") and the run of right merges, and how far outside work was read
 *   merge_checks  the last confidence review of each ticket's PR
 *   versions      each version a project cut: tag, commit, the tickets in it and its release notes
 */
export const gitProjection: Projection = {
  name: "git",
  version: 1,
  tables: ["project_git", "merge_checks", "versions"],
  describe: "Repos, merge policy, merge checks and versions of each project",
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS project_git (
      project_id   INTEGER PRIMARY KEY,
      repo         TEXT,
      private      INTEGER,
      url          TEXT,
      published_at TEXT,
      verdict      TEXT,
      verdict_why  TEXT,
      verdict_at   TEXT,
      policy       TEXT NOT NULL DEFAULT 'ask',
      streak       INTEGER NOT NULL DEFAULT 0,
      merges       INTEGER NOT NULL DEFAULT 0,
      watched_at   TEXT,
      watched_sha  TEXT
    );
    CREATE TABLE IF NOT EXISTS merge_checks (
      ticket_id  INTEGER PRIMARY KEY,
      project_id INTEGER,
      repo       TEXT NOT NULL,
      number     INTEGER NOT NULL,
      sha        TEXT NOT NULL,
      ci         TEXT NOT NULL,
      confident  INTEGER NOT NULL,
      score      INTEGER NOT NULL,
      reasons    TEXT NOT NULL,
      at         TEXT NOT NULL,
      merged_by  TEXT
    );
    CREATE TABLE IF NOT EXISTS versions (
      project_id INTEGER NOT NULL,
      version    TEXT NOT NULL,
      sha        TEXT,
      notes      TEXT NOT NULL,
      tickets    TEXT NOT NULL,
      url        TEXT,
      at         TEXT NOT NULL,
      by         TEXT NOT NULL,
      PRIMARY KEY (project_id, version)
    )`);
  },
  apply(db, e) {
    const p = e.payload as Record<string, any>;
    const row = (id: unknown) => { db.prepare("INSERT OR IGNORE INTO project_git (project_id) VALUES (?)").run(Number(id)); return Number(id); };
    switch (e.type) {
      case "project.published": {
        const id = row(p.projectId);
        db.prepare("UPDATE project_git SET repo = ?, private = ?, url = ?, published_at = ? WHERE project_id = ?").run(String(p.repo), p.private === false ? 0 : 1, p.url ?? null, e.ts, id);
        break;
      }
      case "project.verdict": {
        const id = row(p.projectId);
        db.prepare("UPDATE project_git SET verdict = ?, verdict_why = ?, verdict_at = ? WHERE project_id = ?").run(String(p.verdict), String(p.why ?? ""), e.ts, id);
        break;
      }
      case "project.mergepolicy": {
        const id = row(p.projectId);
        db.prepare("UPDATE project_git SET policy = ? WHERE project_id = ?").run(p.mode === "auto" ? "auto" : "ask", id);
        break;
      }
      case "repo.watched": {
        const id = row(p.projectId);
        db.prepare("UPDATE project_git SET watched_at = ?, watched_sha = ? WHERE project_id = ?").run(String(p.at ?? e.ts), p.sha ?? null, id);
        break;
      }
      case "ticket.mergecheck":
        db.prepare("INSERT OR REPLACE INTO merge_checks (ticket_id, project_id, repo, number, sha, ci, confident, score, reasons, at, merged_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)")
          .run(Number(p.id), p.projectId ?? null, String(p.repo), Number(p.number), String(p.sha), String(p.ci), p.confident ? 1 : 0, Number(p.score ?? 0), JSON.stringify(p.reasons ?? []), e.ts);
        break;
      case "ticket.pr": {
        if (p.state !== "merged") break;
        const c = db.prepare("SELECT project_id, number, confident, merged_by FROM merge_checks WHERE ticket_id = ?").get(Number(p.id)) as { project_id: number | null; number: number; confident: number; merged_by: string | null } | undefined;
        if (!c || c.number !== Number(p.number) || c.merged_by) break;
        db.prepare("UPDATE merge_checks SET merged_by = ? WHERE ticket_id = ?").run(String(p.by ?? "github"), Number(p.id));
        if (c.project_id == null) break;
        row(c.project_id);
        // A merge SF called confident, and that went in, extends the run of right merges.
        if (c.confident) db.prepare("UPDATE project_git SET streak = streak + 1, merges = merges + 1 WHERE project_id = ?").run(c.project_id);
        else db.prepare("UPDATE project_git SET merges = merges + 1 WHERE project_id = ?").run(c.project_id);
        break;
      }
      case "ticket.mergewrong": {
        if (p.projectId == null) break;
        const id = row(p.projectId);
        db.prepare("UPDATE project_git SET streak = 0 WHERE project_id = ?").run(id);
        break;
      }
      case "project.version":
        db.prepare("INSERT OR REPLACE INTO versions (project_id, version, sha, notes, tickets, url, at, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(Number(p.projectId), String(p.version), p.sha ?? null, String(p.notes ?? ""), JSON.stringify(p.tickets ?? []), p.url ?? null, e.ts, String(p.by ?? "you"));
        break;
    }
  },
};

registerProjection(gitProjection);
