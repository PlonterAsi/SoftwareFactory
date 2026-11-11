import { registerProjection, type Projection } from "../store/projections.js";

/**
 * Every time a project was started from the Bridge, derived from the log:
 *
 *   launch_sessions  one row per start: which project and folder, how it ran, its address, how it ended
 *
 * Events: launch.started, launch.url, launch.stopped, launch.exited.
 * Output lines stay in memory while the core runs; the last lines are kept on launch.exited.
 */
type P = Record<string, any>;

export const launchProjection: Projection = {
  name: "launch",
  version: 1,
  tables: ["launch_sessions"],
  describe: "Projects started from the Bridge: how they ran, their preview address, how they ended",
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS launch_sessions (
      id          INTEGER PRIMARY KEY,
      project_id  INTEGER NOT NULL,
      profile_id  TEXT NOT NULL,
      kind        TEXT NOT NULL,
      label       TEXT NOT NULL,
      command     TEXT NOT NULL,
      args        TEXT,
      dir         TEXT NOT NULL,
      root        TEXT,
      mode        TEXT NOT NULL,
      port        INTEGER,
      url         TEXT,
      started_at  TEXT NOT NULL,
      ended_at    TEXT,
      exit_code   INTEGER,
      ended_how   TEXT,
      tail        TEXT
    );
    CREATE INDEX IF NOT EXISTS launch_sessions_project ON launch_sessions (project_id, id);`);
  },
  apply(db, e) {
    const p = e.payload as P;
    switch (e.type) {
      case "launch.started":
        db.prepare(`INSERT OR REPLACE INTO launch_sessions (id, project_id, profile_id, kind, label, command, args, dir, root, mode, port, url, started_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(e.id, Number(p.projectId), String(p.profileId), String(p.kind), String(p.label), String(p.command), p.args ?? null, String(p.dir), p.root ?? null, String(p.mode ?? "inline"), p.port ?? null, p.url ?? null, e.ts);
        // Opened in its own window, or plain pages: the app does not watch a process, so it is done once it starts.
        if (p.mode === "window") db.prepare("UPDATE launch_sessions SET ended_at = ?, ended_how = 'window' WHERE id = ?").run(e.ts, e.id);
        break;
      case "launch.url":
        db.prepare("UPDATE launch_sessions SET url = ? WHERE id = ?").run(String(p.url), Number(p.session));
        break;
      case "launch.exited":
        db.prepare("UPDATE launch_sessions SET ended_at = ?, exit_code = ?, ended_how = ?, tail = ? WHERE id = ?")
          .run(e.ts, p.code ?? null, String(p.how ?? "exited"), Array.isArray(p.tail) ? p.tail.join("\n").slice(-4000) : null, Number(p.session));
        break;
    }
  },
};

registerProjection(launchProjection);
