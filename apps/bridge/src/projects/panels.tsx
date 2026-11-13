import type { ReactNode } from "react";
import type { BayState, OrderState, ProjectDetail, ProjectSummary, SfEvent, useFactory } from "../api";

/**
 * A project's workspace is made of panels. Each registered panel is one tab in
 * every project's view (or in the projects its `appliesTo` accepts), so a new
 * part of the app gets a place inside each project without touching the workspace.
 *
 *   registerProjectPanel({
 *     id: "tickets", title: "Tickets", order: 40,
 *     badge: (ctx) => ctx.project.rollup.linked.ticket ?? null,
 *     render: (ctx) => <Tickets projectId={ctx.project.id} />,
 *   });
 *
 * Register at module load and import the module once from main.tsx.
 */
export interface PanelContext {
  project: ProjectDetail;
  /** The whole event stream; filter with `inProject` for this project's share. */
  events: SfEvent[];
  factory: ReturnType<typeof useFactory>;
  /** The Order Engine's state narrowed to this project. */
  order: OrderState & { arrivals: Record<number, number> };
  bay: BayState;
  /** Switch to another panel of this project. */
  go: (panel: string) => void;
  /** Show a factory run on the Runs panel. */
  showRun: (run: number) => void;
  /** The run picked on the Runs panel, if any. */
  pickedRun: number | null;
}

/**
 * The five parts of a project, in the order work flows: what it is, making it, using it, making it
 * better, and what is known about it. A panel names its section; one without lands in "Know".
 */
export type Section = "brief" | "build" | "ship" | "improve" | "know";
export const SECTIONS: { id: Section; title: string }[] = [
  { id: "brief", title: "Brief" }, { id: "build", title: "Build" }, { id: "ship", title: "Ship" },
  { id: "improve", title: "Improve" }, { id: "know", title: "Know" },
];

export interface ProjectPanel {
  id: string;
  title: string;
  /** Which part of the project this tab belongs to. Optional; defaults to "know". */
  section?: Section;
  /** Lower comes first. Built-ins use 0 (Mission), 5 (Product), 10 (Ideas), 20 (Runs), 60 (Agents), 90 (History). */
  order: number;
  appliesTo?: (p: ProjectSummary) => boolean;
  /** A small count next to the tab, or null. */
  badge?: (ctx: PanelContext) => string | number | null;
  /** Make the tab red (something needs you). */
  alert?: (ctx: PanelContext) => boolean;
  render: (ctx: PanelContext) => ReactNode;
}

const registry = new Map<string, ProjectPanel>();

export function registerProjectPanel(p: ProjectPanel) { registry.set(p.id, p); }
export function unregisterProjectPanel(id: string) { registry.delete(id); }
export function registeredPanelIds(): string[] { return [...registry.keys()]; }

/** This project's panels grouped by section, sections in order, empty ones left out. */
export function sectionsFor(p: ProjectSummary): { id: Section; title: string; panels: ProjectPanel[] }[] {
  const all = panelsFor(p);
  return SECTIONS.map((s) => ({ ...s, panels: all.filter((x) => (x.section ?? "know") === s.id) })).filter((s) => s.panels.length);
}

export function panelsFor(p: ProjectSummary): ProjectPanel[] {
  return [...registry.values()].filter((x) => !x.appliesTo || x.appliesTo(p)).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

/** Does this event belong to the project? (its own events, its runs, its ideas, its linked things) */
export function inProject(e: SfEvent, d: Pick<ProjectDetail, "id" | "runIds" | "nodeIds" | "links">, sets = projectSets(d)): boolean {
  const p = e.payload ?? {};
  if (e.type.startsWith("project.")) return Number(p.projectId) === d.id || e.id === d.id;
  if (e.type === "factory.run.started") return sets.runs.has(e.id);
  if (e.type.startsWith("factory.")) return sets.runs.has(Number(p.run));
  if (e.type.startsWith("agent.run.")) return p.factoryRun != null && sets.runs.has(Number(p.factoryRun));
  if (e.type === "order.node") return sets.nodes.has(e.id);
  if (e.type === "order.fragment") return p.nodeId != null && sets.nodes.has(Number(p.nodeId));
  if (e.type === "order.conflict") return p.nodeId != null && sets.nodes.has(Number(p.nodeId));
  return false;
}

export function projectSets(d: Pick<ProjectDetail, "runIds" | "nodeIds">) {
  return { runs: new Set(d.runIds), nodes: new Set(d.nodeIds) };
}
