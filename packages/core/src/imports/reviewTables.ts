import { registerProjection, type Projection } from "../store/projections.js";

/**
 * Deep reviews of imported repos, derived from the log:
 *
 *   repo_reviews       one row per review: what was measured (evidence), what the app is (understanding),
 *                      the verdict, its stations and what it cost
 *   repo_review_notes  what the owner told the review: interview answers and corrections of single points
 *
 * Events: repo.review.started, repo.review.station, repo.review.evidence, repo.review.understood,
 * repo.review.verdict, repo.review.finished, repo.review.answered, repo.review.corrected,
 * repo.review.note.removed, repo.review.brief.saved.
 */
type P = Record<string, any>;

export const reviewsProjection: Projection = {
  name: "repo_reviews",
  version: 1,
  tables: ["repo_reviews", "repo_review_notes"],
  describe: "Deep reviews of imported repos: evidence, what the app is, the verdict, and what the owner said",
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS repo_reviews (
      id            INTEGER PRIMARY KEY,
      project_id    INTEGER NOT NULL,
      ts            TEXT NOT NULL,
      trigger       TEXT NOT NULL,
      mode          TEXT NOT NULL,
      status        TEXT NOT NULL,
      cap_usd       REAL NOT NULL DEFAULT 0,
      spent_usd     REAL NOT NULL DEFAULT 0,
      head          TEXT,
      stations      TEXT NOT NULL DEFAULT '[]',
      evidence      TEXT,
      understanding TEXT,
      understood_by TEXT,
      verdict       TEXT,
      verdict_by    TEXT,
      brief         TEXT,
      error         TEXT,
      ended_at      TEXT
    );
    CREATE INDEX IF NOT EXISTS repo_reviews_project ON repo_reviews(project_id);
    CREATE TABLE IF NOT EXISTS repo_review_notes (
      id         INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      ts         TEXT NOT NULL,
      kind       TEXT NOT NULL,
      about      TEXT NOT NULL,
      question   TEXT NOT NULL,
      text       TEXT NOT NULL,
      applied    INTEGER
    );
    CREATE INDEX IF NOT EXISTS repo_review_notes_project ON repo_review_notes(project_id)`);
  },
  apply(db, e) {
    const p = e.payload as P;
    switch (e.type as string) {
      case "repo.review.started":
        db.prepare("INSERT OR REPLACE INTO repo_reviews (id, project_id, ts, trigger, mode, status, cap_usd, head) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)")
          .run(e.id, p.projectId, e.ts, String(p.trigger ?? "manual"), String(p.mode ?? "heuristic"), Number(p.capUsd ?? 0), p.head ?? null);
        return;
      case "repo.review.station": {
        const row = db.prepare("SELECT stations FROM repo_reviews WHERE id = ?").get(p.review) as { stations: string } | undefined;
        if (!row) return;
        const list = (JSON.parse(row.stations) as P[]).filter((s) => s.station !== p.station);
        list.push({ station: String(p.station), state: String(p.state), note: p.note ?? null, spentUsd: p.spentUsd ?? null, ts: e.ts });
        db.prepare("UPDATE repo_reviews SET stations = ? WHERE id = ?").run(JSON.stringify(list), p.review);
        return;
      }
      case "repo.review.evidence":
        db.prepare("UPDATE repo_reviews SET evidence = ?, head = coalesce(?, head) WHERE id = ?").run(JSON.stringify(p.evidence ?? null), p.evidence?.head ?? null, p.review);
        return;
      case "repo.review.understood":
        db.prepare("UPDATE repo_reviews SET understanding = ?, understood_by = ? WHERE id = ?").run(JSON.stringify(p.understanding ?? null), String(p.by ?? "heuristic"), p.review);
        return;
      case "repo.review.verdict":
        db.prepare("UPDATE repo_reviews SET verdict = ?, verdict_by = ?, brief = ? WHERE id = ?").run(JSON.stringify(p.verdict ?? null), String(p.by ?? "heuristic"), p.brief ?? null, p.review);
        return;
      case "repo.review.finished":
        db.prepare("UPDATE repo_reviews SET status = ?, spent_usd = ?, error = ?, ended_at = ? WHERE id = ?")
          .run(p.outcome === "failed" ? "failed" : "done", Number(p.spentUsd ?? 0), p.outcome === "failed" ? String(p.error ?? "failed").slice(0, 600) : null, e.ts, p.review);
        // What the owner said before this review started has now been read by it.
        if (p.outcome !== "failed") db.prepare("UPDATE repo_review_notes SET applied = ? WHERE project_id = ? AND applied IS NULL AND id < ?").run(p.review, p.projectId, p.review);
        return;
      case "repo.review.answered":
        db.prepare("INSERT OR REPLACE INTO repo_review_notes (id, project_id, ts, kind, about, question, text) VALUES (?, ?, ?, 'answer', ?, ?, ?)")
          .run(e.id, p.projectId, e.ts, String(p.questionId ?? ""), String(p.question ?? ""), String(p.answer ?? ""));
        return;
      case "repo.review.corrected":
        db.prepare("INSERT OR REPLACE INTO repo_review_notes (id, project_id, ts, kind, about, question, text) VALUES (?, ?, ?, 'correction', ?, ?, ?)")
          .run(e.id, p.projectId, e.ts, String(p.about ?? ""), String(p.was ?? ""), String(p.text ?? ""));
        return;
      case "repo.review.note.removed":
        db.prepare("DELETE FROM repo_review_notes WHERE id = ? AND project_id = ?").run(p.id, p.projectId);
        return;
    }
  },
};

registerProjection(reviewsProjection);
