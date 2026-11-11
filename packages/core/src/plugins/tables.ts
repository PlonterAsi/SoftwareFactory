import { registerProjection, type Projection } from "../store/projections.js";

/**
 * Plugins, derived from the log:
 *
 *   plugins       one row per plugin id: where it lives, its manifest, on or off, why it stopped
 *   plugin_data   each plugin's own small store (key → JSON value)
 *
 * Events:
 *   plugin.installed { id, name, version, dir, manifest, from, by }   copied into <data>/plugins/<id>/ (a newer copy replaces the old)
 *   plugin.enabled   { id, permissions, by }                          the one approval: you saw what it may do
 *   plugin.disabled  { id, reason, by }                               by you, or by the host after repeated crashes
 *   plugin.failed    { id, error }                                    its backend crashed or would not start
 *   plugin.removed   { id, by }
 *   plugin.data      { id, key, value }                               value null deletes the key
 *   plugin.log       { id, level, text }
 *   plugin.emitted   { id, name, payload, projectId? }                its own timeline entries (events:write)
 */
type P = Record<string, any>;

export const pluginsProjection: Projection = {
  name: "plugins",
  version: 1,
  tables: ["plugins", "plugin_data"],
  describe: "Plugins: installed folders, on or off, their permissions and their own data",
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS plugins (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      version      TEXT NOT NULL,
      dir          TEXT NOT NULL,
      manifest     TEXT NOT NULL,
      source       TEXT,
      status       TEXT NOT NULL,
      granted      TEXT NOT NULL DEFAULT '[]',
      error        TEXT,
      crashes      INTEGER NOT NULL DEFAULT 0,
      installed_at TEXT NOT NULL,
      enabled_at   TEXT,
      event_id     INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plugin_data (
      plugin_id  TEXT NOT NULL,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (plugin_id, key)
    )`);
  },
  apply(db, e) {
    const p = e.payload as P;
    const id = String(p.id ?? "");
    switch (e.type) {
      case "plugin.installed": {
        // A reinstall keeps the plugin on if it was on and asks for nothing new; otherwise it waits to be turned on again.
        const prev = db.prepare("SELECT status, granted FROM plugins WHERE id = ?").get(id) as P | undefined;
        const wanted: string[] = Array.isArray(p.manifest?.permissions) ? p.manifest.permissions : [];
        const granted: string[] = prev ? JSON.parse(prev.granted) : [];
        const keepOn = prev?.status === "enabled" && wanted.every((x) => granted.includes(x));
        db.prepare(`INSERT INTO plugins (id, name, version, dir, manifest, source, status, granted, installed_at, event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name, version = excluded.version, dir = excluded.dir, manifest = excluded.manifest,
            source = excluded.source, status = excluded.status, granted = excluded.granted, installed_at = excluded.installed_at, event_id = excluded.event_id, error = NULL, crashes = 0`)
          .run(id, String(p.name ?? id), String(p.version ?? ""), String(p.dir ?? ""), JSON.stringify(p.manifest ?? {}), p.from ?? null,
            keepOn ? "enabled" : "installed", JSON.stringify(keepOn ? granted : []), e.ts, e.id);
        return;
      }
      case "plugin.enabled":
        db.prepare("UPDATE plugins SET status = 'enabled', granted = ?, enabled_at = ?, error = NULL, crashes = 0 WHERE id = ? AND status != 'removed'")
          .run(JSON.stringify(Array.isArray(p.permissions) ? p.permissions : []), e.ts, id);
        return;
      case "plugin.disabled":
        db.prepare("UPDATE plugins SET status = 'disabled', error = COALESCE(?, error) WHERE id = ? AND status != 'removed'").run(p.reason ?? null, id);
        return;
      case "plugin.failed":
        db.prepare("UPDATE plugins SET crashes = crashes + 1, error = ? WHERE id = ?").run(String(p.error ?? "failed").slice(0, 500), id);
        return;
      case "plugin.removed":
        db.prepare("UPDATE plugins SET status = 'removed' WHERE id = ?").run(id);
        db.prepare("DELETE FROM plugin_data WHERE plugin_id = ?").run(id);
        return;
      case "plugin.data":
        if (p.value === null || p.value === undefined) db.prepare("DELETE FROM plugin_data WHERE plugin_id = ? AND key = ?").run(id, String(p.key));
        else db.prepare(`INSERT INTO plugin_data (plugin_id, key, value, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(id, String(p.key), JSON.stringify(p.value), e.ts);
        return;
    }
  },
};

registerProjection(pluginsProjection);
