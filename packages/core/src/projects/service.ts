import type { EventLog } from "../events.js";
import { PROJECT_STATUSES, type Project, type ProjectLink, type ProjectStatus } from "./model.js";
import "./tables.js";

/**
 * Reads and writes for projects. Reads come from the organized tables
 * (projects, project_links, factory_runs, agent_runs, order_*); writes are
 * events, so the Bridge sees every change on the stream.
 */
export interface ProjectRollup {
  runs: number;
  shipped: number;
  failed: number;
  running: number;
  agentCalls: number;
  spendUsd: number;
  /** Order Engine nodes in the project's trees (roots included). */
  nodes: number;
  fragments: number;
  important: number;
  openConflicts: number;
  /** Things other parts of the app linked here, by kind (ticket, proposal, ...). */
  linked: Record<string, number>;
  lastActive: string;
}

export interface ProjectSummary extends Project { rollup: ProjectRollup }

export interface ProjectDetail extends ProjectSummary {
  links: ProjectLink[];
  /** Every Order Engine node in the project, roots first. */
  nodeIds: number[];
  rootNodeIds: number[];
  runIds: number[];
  runs: Record<string, unknown>[];
  agents: { agent: string; calls: number; costUsd: number; lastAt: string }[];
  artifacts: { files: number; bytes: number };
  /** Extra sections other parts of the app add (see registerProjectFacet). */
  facets: Record<string, unknown>;
}

/** A section another part of the app adds to every project's detail (tickets, improvement proposals, ...). */
export interface ProjectFacet {
  id: string;
  compute(log: EventLog, project: ProjectSummary, links: ProjectLink[]): unknown;
}
const facets = new Map<string, ProjectFacet>();
export function registerProjectFacet(f: ProjectFacet) { facets.set(f.id, f); }

type Row = Record<string, any>;
const all = (log: EventLog, sql: string, ...args: (string | number)[]) => log.db.prepare(sql).all(...args) as Row[];

function toProject(r: Row): Project {
  return { id: Number(r.id), name: r.name, kind: r.kind, status: r.status, summary: r.summary, origin: r.origin, createdAt: r.created_at, updatedAt: r.updated_at };
}

/** Everything needed to roll projects up, read once. */
function snapshot(log: EventLog) {
  const projects = all(log, "SELECT * FROM projects ORDER BY id").map(toProject);
  const links = all(log, "SELECT project_id, kind, ref, ts FROM project_links").map((r) => ({ projectId: Number(r.project_id), kind: String(r.kind), ref: String(r.ref), ts: String(r.ts) }));
  const nodes = all(log, "SELECT id, parent_id, merged_into, last_active FROM order_nodes");
  const children = new Map<number, number[]>();
  for (const n of nodes) {
    // A merged node's children already moved to its target; the merged node itself is counted under its target too.
    const parent = n.merged_into ?? n.parent_id;
    if (parent == null) continue;
    children.set(Number(parent), [...(children.get(Number(parent)) ?? []), Number(n.id)]);
  }
  const nodeActive = new Map(nodes.map((n) => [Number(n.id), String(n.last_active)]));
  const frag = new Map<number, { n: number; imp: number }>();
  for (const r of all(log, "SELECT node_id, count(*) AS n, sum(important) AS imp FROM order_fragments WHERE state = 'live' AND kind != 'noise' AND node_id IS NOT NULL GROUP BY node_id")) frag.set(Number(r.node_id), { n: Number(r.n), imp: Number(r.imp ?? 0) });
  const conflicts = new Map<number, number>();
  for (const r of all(log, "SELECT node_id, count(*) AS n FROM order_conflicts WHERE status = 'open' AND node_id IS NOT NULL GROUP BY node_id")) conflicts.set(Number(r.node_id), Number(r.n));
  const runs = new Map(all(log, "SELECT * FROM factory_runs").map((r) => [Number(r.id), r]));
  const calls = new Map<number, { n: number; usd: number; last: string }>();
  for (const r of all(log, "SELECT factory_run, count(*) AS n, coalesce(sum(cost_usd), 0) AS usd, max(started_at) AS last FROM agent_runs WHERE factory_run IS NOT NULL GROUP BY factory_run")) calls.set(Number(r.factory_run), { n: Number(r.n), usd: Number(r.usd), last: String(r.last) });

  const subtree = (roots: number[]) => {
    const out: number[] = [];
    const seen = new Set<number>();
    const stack = [...roots];
    while (stack.length) {
      const id = stack.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      stack.push(...(children.get(id) ?? []));
    }
    return out;
  };

  const roll = (p: Project): { summary: ProjectSummary; links: ProjectLink[]; nodeIds: number[]; roots: number[]; runIds: number[] } => {
    const mine = links.filter((l) => l.projectId === p.id);
    const roots = mine.filter((l) => l.kind === "order_node").map((l) => Number(l.ref));
    const nodeIds = subtree(roots);
    const runIds = mine.filter((l) => l.kind === "factory_run").map((l) => Number(l.ref)).sort((a, b) => a - b);
    const r: ProjectRollup = { runs: runIds.length, shipped: 0, failed: 0, running: 0, agentCalls: 0, spendUsd: 0, nodes: nodeIds.length, fragments: 0, important: 0, openConflicts: 0, linked: {}, lastActive: p.updatedAt };
    const touch = (ts: unknown) => { if (typeof ts === "string" && ts > r.lastActive) r.lastActive = ts; };
    for (const id of runIds) {
      const row = runs.get(id);
      if (row) {
        if (row.outcome === "shipped") r.shipped++;
        else if (row.outcome === "failed") r.failed++;
        else if (row.outcome == null) r.running++;
        touch(row.started_at); touch(row.finished_at);
      }
      const c = calls.get(id);
      if (c) { r.agentCalls += c.n; r.spendUsd += c.usd; touch(c.last); }
    }
    for (const id of nodeIds) {
      const f = frag.get(id);
      if (f) { r.fragments += f.n; r.important += f.imp; }
      r.openConflicts += conflicts.get(id) ?? 0;
      touch(nodeActive.get(id));
    }
    for (const l of mine) {
      if (l.kind !== "order_node" && l.kind !== "factory_run") r.linked[l.kind] = (r.linked[l.kind] ?? 0) + 1;
      touch(l.ts);
    }
    r.spendUsd = Number(r.spendUsd.toFixed(6));
    return { summary: { ...p, rollup: r }, links: mine, nodeIds, roots, runIds };
  };

  return { projects, runs, roll };
}

/** Every project with its rollup, most recently active first. Archived ones are included; the Bridge files them away. */
export function listProjects(log: EventLog): ProjectSummary[] {
  const s = snapshot(log);
  return s.projects.map((p) => s.roll(p).summary).sort((a, b) => (b.rollup.lastActive > a.rollup.lastActive ? 1 : b.rollup.lastActive < a.rollup.lastActive ? -1 : b.id - a.id));
}

export function projectDetail(log: EventLog, id: number): ProjectDetail | null {
  const s = snapshot(log);
  const p = s.projects.find((x) => x.id === id);
  if (!p) return null;
  const r = s.roll(p);
  const runList = r.runIds.length ? r.runIds : [-1];
  const marks = runList.map(() => "?").join(",");
  const agents = all(log, `SELECT agent, count(*) AS calls, coalesce(sum(cost_usd), 0) AS usd, max(started_at) AS last FROM agent_runs WHERE factory_run IN (${marks}) GROUP BY agent ORDER BY usd DESC`, ...runList)
    .map((a) => ({ agent: String(a.agent), calls: Number(a.calls), costUsd: Number(Number(a.usd).toFixed(6)), lastAt: String(a.last) }));
  const art = all(log, `SELECT count(*) AS n, coalesce(sum(bytes), 0) AS b FROM artifacts WHERE run IN (${marks})`, ...runList)[0];
  const extra: Record<string, unknown> = {};
  for (const f of facets.values()) {
    try { extra[f.id] = f.compute(log, r.summary, r.links); } catch (e) { extra[f.id] = { error: (e as Error).message }; }
  }
  return {
    ...r.summary, links: r.links, nodeIds: r.nodeIds, rootNodeIds: r.roots, runIds: r.runIds,
    runs: r.runIds.map((id) => s.runs.get(id)).filter(Boolean) as Row[],
    agents, artifacts: { files: Number(art?.n ?? 0), bytes: Number(art?.b ?? 0) }, facets: extra,
  };
}

/**
 * Which project owns a thing. For an Order Engine node, its root (following merges) decides;
 * for anything else, its own link. Returns null when nothing owns it.
 */
export function projectOf(log: EventLog, thing: { kind: string; ref: string | number }): number | null {
  let kind = thing.kind;
  let ref = String(thing.ref);
  if (kind === "order_node") {
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(ref)) break;
      seen.add(ref);
      const own = log.db.prepare("SELECT project_id FROM project_links WHERE kind = 'order_node' AND ref = ?").get(ref) as Row | undefined;
      if (own) return Number(own.project_id);
      const n = log.db.prepare("SELECT parent_id, merged_into FROM order_nodes WHERE id = ?").get(Number(ref)) as Row | undefined;
      const up = n?.merged_into ?? n?.parent_id;
      if (up == null) return null;
      ref = String(up);
    }
    return null;
  }
  const row = log.db.prepare("SELECT project_id FROM project_links WHERE kind = ? AND ref = ?").get(kind, ref) as Row | undefined;
  return row ? Number(row.project_id) : null;
}

function mustExist(log: EventLog, id: number) {
  if (!log.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id)) throw new Error(`No project #${id}`);
}

const clean = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export function createProject(log: EventLog, input: { name: string; kind?: string; summary?: string }): number {
  const name = clean(input.name, 80);
  if (!name) throw new Error("A project needs a name");
  return log.append("project.created", { name, kind: clean(input.kind, 24) || "general", summary: String(input.summary ?? "").trim().slice(0, 2000) }).id;
}

export function updateProject(log: EventLog, id: number, patch: { name?: string; kind?: string; summary?: string; status?: ProjectStatus }) {
  mustExist(log, id);
  const out: Record<string, unknown> = { projectId: id };
  if (patch.name !== undefined) { const n = clean(patch.name, 80); if (!n) throw new Error("A project needs a name"); out.name = n; }
  if (patch.kind !== undefined) out.kind = clean(patch.kind, 24) || "general";
  if (patch.summary !== undefined) out.summary = String(patch.summary).trim().slice(0, 2000);
  if (patch.status !== undefined) {
    if (!PROJECT_STATUSES.includes(patch.status)) throw new Error(`Status is one of ${PROJECT_STATUSES.join(", ")}`);
    out.status = patch.status;
  }
  if (Object.keys(out).length === 1) throw new Error("Nothing to change");
  log.append("project.updated", out);
}

/** Move a thing into a project (it leaves the project it was in). */
export function linkToProject(log: EventLog, id: number, kind: string, ref: string | number) {
  mustExist(log, id);
  const k = clean(kind, 40);
  if (!/^[a-z][a-z0-9_]*$/.test(k)) throw new Error("A link kind is lower_snake_case, like ticket or order_node");
  const r = String(ref).trim();
  if (!r) throw new Error("A link needs a ref");
  if (k === "order_node") {
    const n = log.db.prepare("SELECT parent_id FROM order_nodes WHERE id = ?").get(Number(r)) as Row | undefined;
    if (!n) throw new Error(`No Order Engine node #${r}`);
    if (n.parent_id != null) throw new Error("Only a root node (a project in the Order Engine) can move between projects; its ideas and threads come with it.");
  }
  if (k === "factory_run" && !log.db.prepare("SELECT 1 FROM factory_runs WHERE id = ?").get(Number(r))) throw new Error(`No factory run #${r}`);
  log.append("project.linked", { projectId: id, kind: k, ref: r });
}

export function unlinkFromProject(log: EventLog, id: number, kind: string, ref: string | number) {
  const row = log.db.prepare("SELECT project_id FROM project_links WHERE kind = ? AND ref = ?").get(kind, String(ref)) as Row | undefined;
  if (!row || Number(row.project_id) !== id) throw new Error("That is not linked to this project");
  const name = kind === "factory_run" ? (log.db.prepare("SELECT idea FROM factory_runs WHERE id = ?").get(Number(ref)) as Row | undefined)?.idea
    : kind === "order_node" ? (log.db.prepare("SELECT title FROM order_nodes WHERE id = ?").get(Number(ref)) as Row | undefined)?.title : undefined;
  log.append("project.unlinked", { projectId: id, kind, ref: String(ref), ...(name ? { name: String(name).slice(0, 60) } : {}) });
}

/**
 * Merge a project into another: every run, idea, ticket and other thing linked to it moves over,
 * and its project goes away. One made by the factory or the Order Engine disappears on its own once
 * empty; one you made is archived, so nothing you named is lost. Returns the project kept.
 */
export function mergeProject(log: EventLog, from: number, into: number): number {
  if (!Number.isInteger(into) || into <= 0) throw new Error("Say which project to merge into");
  if (from === into) throw new Error("A project cannot merge into itself");
  mustExist(log, from);
  mustExist(log, into);
  const links = log.db.prepare("SELECT kind, ref FROM project_links WHERE project_id = ? ORDER BY ts").all(from) as Row[];
  for (const l of links) {
    const kind = String(l.kind);
    const ref = String(l.ref);
    // A non-root node follows its root; only roots carry an owner link, so this is a guard, not a skip of real work.
    try { linkToProject(log, into, kind, ref); } catch (e) { if (kind !== "order_node") throw e; }
  }
  const left = log.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(from);
  if (left) log.append("project.updated", { projectId: from, status: "archived", mergedInto: into });
  return into;
}
