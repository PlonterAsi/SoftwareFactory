import type { IncomingMessage } from "node:http";
import type { EventLog } from "../events.js";
import type { Factory } from "../factory/loop.js";
import type { OrderEngine } from "../order/engine.js";
import { createProject, linkToProject, listProjects, projectDetail, projectOf, unlinkFromProject, updateProject } from "./service.js";

/**
 * The projects API. Every write is an event, so the Bridge sees it on the stream.
 *
 *   GET  /api/projects                    every project with its rollup
 *   POST /api/projects                    { name, kind?, summary? }  (also gives it an Order Engine node, so ideas can be filed there)
 *   GET  /api/projects/of?kind=&ref=      which project owns a thing
 *   GET  /api/projects/:id                detail: links, node tree, runs, agents, files, facets
 *   POST /api/projects/:id                { name?, kind?, summary?, status? }
 *   POST /api/projects/:id/links          { kind, ref }   move a thing into this project
 *   POST /api/projects/:id/unlink         { kind, ref }
 *   POST /api/projects/:id/runs           { idea, maxUsd? }   start a factory run in this project
 *   POST /api/projects/:id/screen         { maxUsd? }   give the project's newest shipped build a screen (a page), same folder, next version
 */
export async function projectsRoute(
  ctx: { log: EventLog; order: OrderEngine; factory: Factory; readJson: (req: IncomingMessage) => Promise<Record<string, unknown>>; canBuild?: () => string | null },
  req: IncomingMessage,
  url: URL,
): Promise<[number, unknown] | null> {
  const { log } = ctx;
  const path = url.pathname;
  if (req.method === "GET" && path === "/api/projects") return [200, listProjects(log)];
  if (req.method === "GET" && path === "/api/projects/of") {
    const kind = url.searchParams.get("kind") ?? "";
    const ref = url.searchParams.get("ref") ?? "";
    return [200, { projectId: projectOf(log, { kind, ref }) }];
  }
  if (req.method === "POST" && path === "/api/projects") {
    const body = await ctx.readJson(req);
    const id = createProject(log, { name: String(body.name ?? ""), kind: body.kind ? String(body.kind) : undefined, summary: body.summary ? String(body.summary) : undefined });
    // Its own root in the Order Engine, so the Archivist can file ideas into it.
    const node = ctx.order.createNode("project", String(body.name));
    linkToProject(log, id, "order_node", node);
    return [201, projectDetail(log, id)];
  }
  const m = path.match(/^\/api\/projects\/(\d+)(?:\/(links|unlink|runs|screen))?$/);
  if (!m) return null;
  const id = Number(m[1]);
  if (req.method === "GET" && !m[2]) {
    const d = projectDetail(log, id);
    return d ? [200, d] : [404, { error: `No project #${id}` }];
  }
  if (req.method !== "POST") return null;
  const body = await ctx.readJson(req);
  if (!m[2]) {
    updateProject(log, id, {
      name: body.name !== undefined ? String(body.name) : undefined,
      kind: body.kind !== undefined ? String(body.kind) : undefined,
      summary: body.summary !== undefined ? String(body.summary) : undefined,
      status: body.status !== undefined ? (String(body.status) as any) : undefined,
    });
    return [200, projectDetail(log, id)];
  }
  if (m[2] === "links") { linkToProject(log, id, String(body.kind ?? ""), String(body.ref ?? "")); return [200, projectDetail(log, id)]; }
  if (m[2] === "unlink") { unlinkFromProject(log, id, String(body.kind ?? ""), String(body.ref ?? "")); return [200, projectDetail(log, id)]; }
  if (m[2] === "runs") {
    if (!projectDetail(log, id)) return [404, { error: `No project #${id}` }];
    const blocked = ctx.canBuild?.();
    if (blocked) return [409, { error: blocked }];
    const run = ctx.factory.start(String(body.idea ?? ""), { projectId: id, maxUsd: typeof body.maxUsd === "number" ? body.maxUsd : undefined });
    return [202, { run, projectId: id }];
  }
  if (m[2] === "screen") {
    if (!projectDetail(log, id)) return [404, { error: `No project #${id}` }];
    const blocked = ctx.canBuild?.();
    if (blocked) return [409, { error: blocked }];
    // The newest build of this project that shipped.
    const base = log.list({ type: "factory.run.finished", limit: 1e6 }).map((e) => e.payload as { run: number; outcome: string })
      .filter((p) => p.outcome === "shipped" && projectOf(log, { kind: "factory_run", ref: String(p.run) }) === id).at(-1);
    if (!base) return [409, { error: "This project has no finished factory build to add a screen to. Imported projects can get one through an improvement or a ticket." }];
    try {
      const run = ctx.factory.addScreen(base.run, { projectId: id, maxUsd: typeof body.maxUsd === "number" ? body.maxUsd : undefined });
      return [202, { run, projectId: id, baseRun: base.run }];
    } catch (e) {
      return [409, { error: (e as Error).message }];
    }
  }
  return null;
}
