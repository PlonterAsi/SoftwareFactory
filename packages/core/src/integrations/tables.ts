import { registerProjection, type Projection } from "../store/projections.js";

/**
 * Finished projects added into SoftwareFactory, derived from the log:
 *
 *   integrations   one row per request to add a project (its form, the approval, where the copy lives, how often it ran)
 *
 * Events:
 *   integration.requested { projectId, form, title, slug, summary, sourceDir, sourceKind, sourceRef, sha, entry, checks, by }
 *   integration.decided   { id, approve, note?, by }                        the human gate
 *   integration.installed { id, dir, files, bytes, head }                   tool/panel: the frozen copy is in place
 *   integration.briefed   { id, brief }                                     source: the pull-request brief is ready
 *   integration.failed    { id, error }
 *   integration.removed   { id, by }
 *   integration.used      { id, ok, exitCode, ms, args }                    a tool feature ran
 *
 * A newer install of the same project and form replaces the older one (status "replaced").
 */
type P = Record<string, any>;

export const integrationsProjection: Projection = {
  name: "integrations",
  version: 1,
  tables: ["integrations"],
  describe: "Finished projects added into SoftwareFactory as features: approvals, installed copies, use",
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS integrations (
      id           INTEGER PRIMARY KEY,
      project_id   INTEGER NOT NULL,
      form         TEXT NOT NULL,
      title        TEXT NOT NULL,
      slug         TEXT NOT NULL,
      summary      TEXT NOT NULL DEFAULT '',
      source_dir   TEXT NOT NULL,
      source_kind  TEXT NOT NULL,
      source_ref   INTEGER,
      sha          TEXT,
      entry        TEXT,
      checks       TEXT NOT NULL DEFAULT '[]',
      status       TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      decided_at   TEXT,
      decided_by   TEXT,
      note         TEXT,
      dir          TEXT,
      head         TEXT,
      files        INTEGER,
      bytes        INTEGER,
      brief        TEXT,
      error        TEXT,
      uses         INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      last_ok      INTEGER
    );
    CREATE INDEX IF NOT EXISTS integrations_project ON integrations(project_id)`);
  },
  apply(db, e) {
    const p = e.payload as P;
    switch (e.type) {
      case "integration.requested":
        db.prepare(`INSERT OR REPLACE INTO integrations (id, project_id, form, title, slug, summary, source_dir, source_kind, source_ref, sha, entry, checks, status, requested_at, requested_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting', ?, ?)`)
          .run(e.id, Number(p.projectId), String(p.form), String(p.title ?? ""), String(p.slug ?? ""), String(p.summary ?? ""), String(p.sourceDir ?? ""),
            String(p.sourceKind ?? ""), p.sourceRef == null ? null : Number(p.sourceRef), p.sha ?? null, p.entry ?? null, JSON.stringify(p.checks ?? []), e.ts, String(p.by ?? "you"));
        return;
      case "integration.decided":
        db.prepare("UPDATE integrations SET status = ?, decided_at = ?, decided_by = ?, note = ? WHERE id = ? AND status = 'awaiting'")
          .run(p.approve ? "installing" : "rejected", e.ts, String(p.by ?? "you"), p.note ?? null, Number(p.id));
        return;
      case "integration.installed": {
        const row = db.prepare("SELECT project_id, form FROM integrations WHERE id = ?").get(Number(p.id)) as P | undefined;
        if (row) db.prepare("UPDATE integrations SET status = 'replaced' WHERE project_id = ? AND form = ? AND status = 'installed' AND id != ?").run(row.project_id, row.form, Number(p.id));
        db.prepare("UPDATE integrations SET status = 'installed', dir = ?, head = ?, files = ?, bytes = ?, error = NULL WHERE id = ?")
          .run(String(p.dir), p.head ?? null, Number(p.files ?? 0), Number(p.bytes ?? 0), Number(p.id));
        return;
      }
      case "integration.briefed":
        db.prepare("UPDATE integrations SET status = 'briefed', brief = ?, error = NULL WHERE id = ?").run(String(p.brief ?? ""), Number(p.id));
        return;
      case "integration.failed":
        db.prepare("UPDATE integrations SET status = 'failed', error = ? WHERE id = ?").run(String(p.error ?? "failed").slice(0, 500), Number(p.id));
        return;
      case "integration.removed":
        db.prepare("UPDATE integrations SET status = 'removed' WHERE id = ?").run(Number(p.id));
        return;
      case "integration.used":
        db.prepare("UPDATE integrations SET uses = uses + 1, last_used_at = ?, last_ok = ? WHERE id = ?").run(e.ts, p.ok ? 1 : 0, Number(p.id));
        return;
    }
  },
};

registerProjection(integrationsProjection);
