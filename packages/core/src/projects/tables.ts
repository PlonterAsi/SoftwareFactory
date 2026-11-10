import { registerProjection, type Projection } from "../store/projections.js";
import { ORDER_VIEW, orderView } from "../store/tables.js";
import { foldProjects, type ProjectsState } from "./model.js";

export const PROJECTS_VIEW = "projects";

/** Event types that can change who owns what. */
export const touchesProjects = (t: string) =>
  t.startsWith("project.") || t === "order.node" || t === "order.sweep" || t === "order.sweep.undone" || t === "factory.run.started";

/**
 * `projects` and `project_links`, rewritten from the projects fold after any event
 * that can change them. Rebuildable from the log at any time, like every table.
 */
export const projectsProjection: Projection = {
  name: "projects",
  version: 1,
  tables: ["projects", "project_links"],
  describe: "Projects, and which ideas, runs and other things belong to each",
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS projects (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      kind       TEXT NOT NULL,
      status     TEXT NOT NULL CHECK (status IN ('active', 'paused', 'shipped', 'archived')),
      summary    TEXT NOT NULL DEFAULT '',
      origin     TEXT NOT NULL CHECK (origin IN ('you', 'factory', 'order')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_links (
      project_id INTEGER NOT NULL,
      kind       TEXT NOT NULL,
      ref        TEXT NOT NULL,
      ts         TEXT NOT NULL,
      PRIMARY KEY (kind, ref)
    );
    CREATE INDEX IF NOT EXISTS project_links_project ON project_links(project_id)`);
  },
  flush(db, ctx, types) {
    if (![...types].some(touchesProjects)) return;
    const order = ctx.view(ORDER_VIEW, orderView);
    const st = ctx.view<ProjectsState>(PROJECTS_VIEW, (events) => foldProjects(events, order));
    db.exec("DELETE FROM projects; DELETE FROM project_links;");
    const p = db.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const x of st.projects) p.run(x.id, x.name, x.kind, x.status, x.summary, x.origin, x.createdAt, x.updatedAt);
    const l = db.prepare("INSERT INTO project_links VALUES (?, ?, ?, ?)");
    for (const x of st.links) l.run(x.projectId, x.kind, x.ref, x.ts);
  },
};

registerProjection(projectsProjection);
