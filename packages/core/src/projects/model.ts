import type { SfEvent } from "../events.js";
import type { OrderState } from "../order/model.js";

/**
 * Projects: the top-level thing you work on. Everything else (Order Engine
 * ideas, factory runs, agents' calls, files, and whatever later parts add,
 * like tickets or improvement proposals) belongs to one project through a link.
 *
 * Like the rest of the core, projects are folded from the event log, so nothing
 * needs migrating: the history that existed before projects did is adopted as is.
 *
 *   project.created  { name, kind?, summary? }                  you made one (id = this event's id)
 *   project.updated  { projectId, name?, kind?, summary?, status? }
 *   project.linked   { projectId, kind, ref }                    move a thing into a project
 *   project.unlinked { projectId, kind, ref }                    take it out again
 *
 * Adoption rules, applied in log order:
 *   - every live root node of the Order Engine is a project of its own, with the node's id;
 *   - a factory run started without a project is a project of its own, with the run's id;
 *     the root node its intake Signal grows joins that same project;
 *   - a run started with { projectId } joins that project, and so does its intake node;
 *   - a root node grown from a Signal said in a project's chat joins that project;
 *   - when the Order Engine merges a root node into another, its project follows;
 *   - a project that was only adopted (not made by you) disappears once nothing is linked to it.
 *
 * One owner per thing: a (kind, ref) pair is linked to at most one project.
 */
export type ProjectStatus = "active" | "paused" | "shipped" | "archived";
export const PROJECT_STATUSES: ProjectStatus[] = ["active", "paused", "shipped", "archived"];
/** Kinds steer which panels a project's view shows first. Free text is allowed; these are the known ones. */
export const PROJECT_KINDS = ["app", "tool", "library", "research", "general"] as const;

/** Link kinds the core itself fills. Other parts of the app add their own (ticket, proposal, ...). */
export type CoreLinkKind = "order_node" | "factory_run";

export interface Project {
  id: number;
  name: string;
  kind: string;
  status: ProjectStatus;
  summary: string;
  /** you: made in the Bridge. factory: adopted from a factory run. order: adopted from an Order Engine root node. */
  origin: "you" | "factory" | "order";
  createdAt: string;
  updatedAt: string;
}

export interface ProjectLink {
  projectId: number;
  kind: string;
  ref: string;
  ts: string;
}

export interface ProjectsState {
  projects: Project[];
  links: ProjectLink[];
}

const key = (kind: string, ref: string | number) => `${kind}:${ref}`;

/** A readable name from a run's idea: its first line, cut at a word near 60 characters. */
export function nameFromIdea(idea: string): string {
  const line = idea.trim().split(/\r?\n/)[0].replace(/\s+/g, " ");
  if (line.length <= 60) return line || "Untitled project";
  const cut = line.slice(0, 60);
  const sp = cut.lastIndexOf(" ");
  return (sp > 30 ? cut.slice(0, sp) : cut) + "…";
}

export function foldProjects(events: SfEvent[], order?: Pick<OrderState, "nodes">): ProjectsState {
  const projects = new Map<number, Project>();
  const owner = new Map<string, ProjectLink>();
  const signals = new Map<number, { source: string; text: string; projectId?: number }>();
  const runs: { id: number; idea: string; nodeTaken: boolean }[] = [];

  const linksOf = (pid: number) => [...owner.values()].filter((l) => l.projectId === pid);
  const dropIfEmpty = (pid: number) => {
    const p = projects.get(pid);
    if (p && p.origin !== "you" && !linksOf(pid).length) projects.delete(pid);
  };
  const setOwner = (pid: number, kind: string, ref: string, ts: string) => {
    const k = key(kind, ref);
    const prev = owner.get(k);
    owner.set(k, { projectId: pid, kind, ref, ts });
    const p = projects.get(pid);
    if (p && ts > p.updatedAt) p.updatedAt = ts;
    if (prev && prev.projectId !== pid) dropIfEmpty(prev.projectId);
  };
  const adopt = (id: number, name: string, kind: string, origin: Project["origin"], ts: string) => {
    projects.set(id, { id, name, kind, status: "active", summary: "", origin, createdAt: ts, updatedAt: ts });
  };

  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, any>;
    switch (e.type) {
      case "signal.captured":
        signals.set(e.id, { source: String(p.source ?? ""), text: String(p.text ?? "").trim(), ...(p.projectId != null ? { projectId: Number(p.projectId) } : {}) });
        break;
      case "project.created":
        projects.set(e.id, {
          id: e.id, name: String(p.name ?? "Untitled project"), kind: String(p.kind ?? "general"), status: "active",
          summary: String(p.summary ?? ""), origin: "you", createdAt: e.ts, updatedAt: e.ts,
        });
        break;
      case "project.updated": {
        const x = projects.get(Number(p.projectId));
        if (!x) break;
        if (typeof p.name === "string" && p.name.trim()) x.name = p.name.trim();
        if (typeof p.kind === "string" && p.kind.trim()) x.kind = p.kind.trim();
        if (typeof p.summary === "string") x.summary = p.summary;
        if (PROJECT_STATUSES.includes(p.status)) x.status = p.status;
        // Renaming or describing an adopted project makes it yours: it stays even when emptied.
        if (x.origin !== "you" && (typeof p.name === "string" || typeof p.summary === "string")) x.origin = "you";
        x.updatedAt = e.ts;
        break;
      }
      case "project.linked": {
        const pid = Number(p.projectId);
        if (projects.has(pid) && p.kind && p.ref != null) setOwner(pid, String(p.kind), String(p.ref), e.ts);
        break;
      }
      case "project.unlinked": {
        const pid = Number(p.projectId);
        const k = key(String(p.kind), String(p.ref));
        if (owner.get(k)?.projectId !== pid) break;
        owner.delete(k);
        // A run or root node never floats free: it gets its own project back.
        if (p.kind === "factory_run" || p.kind === "order_node") {
          const id = Number(p.ref);
          if (!projects.has(id)) adopt(id, String(p.name ?? `#${id}`), p.kind === "factory_run" ? "app" : "general", p.kind === "factory_run" ? "factory" : "order", e.ts);
          setOwner(id, String(p.kind), String(p.ref), e.ts);
        }
        dropIfEmpty(pid);
        break;
      }
      case "factory.run.started": {
        const idea = String(p.idea ?? "").trim();
        runs.push({ id: e.id, idea, nodeTaken: false });
        const pid = Number(p.projectId);
        if (p.projectId != null && projects.has(pid)) setOwner(pid, "factory_run", String(e.id), e.ts);
        else {
          adopt(e.id, nameFromIdea(idea), "app", "factory", e.ts);
          setOwner(e.id, "factory_run", String(e.id), e.ts);
        }
        break;
      }
      case "factory.plan": {
        // A build that is its own project takes the name and summary of what was planned, so two builds of
        // one idea read apart ("Plan Diagram" vs "Plan Diagram View") instead of the same cut-off idea twice.
        const run = Number(p.run);
        const x = projects.get(run);
        const plan = (p.plan ?? {}) as { name?: unknown; summary?: unknown };
        const idea = runs.find((r) => r.id === run)?.idea;
        if (!x || x.origin !== "factory" || p.kept != null || idea == null || x.name !== nameFromIdea(idea)) break;
        if (typeof plan.name === "string" && plan.name.trim()) x.name = plan.name.trim().slice(0, 80);
        if (!x.summary && typeof plan.summary === "string") x.summary = plan.summary.trim().slice(0, 2000);
        break;
      }
      case "order.node": {
        if (p.parentId != null) break;
        const sig = p.signalId != null ? signals.get(Number(p.signalId)) : undefined;
        // A factory intake: the node joins the project of the run that captured it.
        const run = sig?.source === "factory" ? [...runs].reverse().find((r) => !r.nodeTaken && r.id < Number(p.signalId) && r.idea === sig.text) : undefined;
        const runOwner = run && owner.get(key("factory_run", run.id));
        if (run && runOwner) {
          run.nodeTaken = true;
          setOwner(runOwner.projectId, "order_node", String(e.id), e.ts);
        } else if (sig?.projectId != null && projects.has(sig.projectId)) {
          // Said in a project's chat: a new topic it opens stays in that project, never a stray project of its own.
          setOwner(sig.projectId, "order_node", String(e.id), e.ts);
        } else {
          adopt(e.id, String(p.title ?? `#${e.id}`), "general", "order", e.ts);
          setOwner(e.id, "order_node", String(e.id), e.ts);
        }
        break;
      }
    }
  }

  // Root nodes the Order Engine merged into another: their project follows the node.
  if (order) {
    const byId = new Map(order.nodes.map((n) => [n.id, n]));
    const rootOf = (id: number): number => {
      const seen = new Set<number>();
      let n = byId.get(id);
      while (n && !seen.has(n.id)) {
        seen.add(n.id);
        if (n.mergedInto != null) { n = byId.get(n.mergedInto); continue; }
        if (n.parentId != null) { n = byId.get(n.parentId); continue; }
        return n.id;
      }
      return id;
    };
    for (const l of [...owner.values()]) {
      if (l.kind !== "order_node") continue;
      const node = byId.get(Number(l.ref));
      if (!node || node.mergedInto == null) continue;
      const target = owner.get(key("order_node", rootOf(node.id)));
      if (target && target.projectId !== l.projectId) setOwner(target.projectId, "order_node", l.ref, l.ts);
    }
  }

  return { projects: [...projects.values()], links: [...owner.values()] };
}
