import { registerProjection, type Projection } from "../store/projections.js";

/**
 * The Bridge's own tables: app settings (crew mode and the rest) and the app's versions.
 * Both are derived from the event log like every other table, so they rebuild from it.
 */
type P = Record<string, any>;

export const settingsProjection: Projection = {
  name: "settings",
  version: 1,
  tables: ["settings"],
  describe: "App settings you changed, such as crew mode (newest value wins)",
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      ts    TEXT NOT NULL,
      event INTEGER NOT NULL
    )`);
  },
  apply(db, e) {
    if (e.type !== "settings.changed") return;
    const p = e.payload as P;
    db.prepare("INSERT OR REPLACE INTO settings (key, value, ts, event) VALUES (?, ?, ?, ?)").run(String(p.key), JSON.stringify(p.value ?? null), e.ts, e.id);
  },
};

export const appVersionsProjection: Projection = {
  name: "app_versions",
  version: 1,
  tables: ["app_versions"],
  describe: "Each version of the app this install ran, and when it updated",
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS app_versions (
      id           INTEGER PRIMARY KEY,
      ts           TEXT NOT NULL,
      from_version TEXT,
      to_version   TEXT NOT NULL
    )`);
  },
  apply(db, e) {
    if (e.type !== "app.updated") return;
    const p = e.payload as P;
    db.prepare("INSERT OR REPLACE INTO app_versions (id, ts, from_version, to_version) VALUES (?, ?, ?, ?)").run(e.id, e.ts, p.from ?? null, String(p.to));
  },
};

registerProjection(settingsProjection);
registerProjection(appVersionsProjection);
