import type { IncomingMessage } from "node:http";
import type { EventLog } from "../events.js";
import { registerProjectFacet } from "../projects/service.js";
import { importDetail, importOf, latestMap, listImports, suggestionsOf, type RepoExplorer } from "./explorer.js";

/**
 * The imports API. Every write is an event, so the Bridge sees it on the stream.
 *
 *   GET  /api/imports                     every imported repo with its health and suggestion count
 *   POST /api/imports                     { source, name?, maxUsd? }   a git URL, owner/name, or a folder path
 *   GET  /api/imports/:projectId          the import, newest code map, module notes, suggestions, exploration log
 *   POST /api/imports/:projectId/explore  { maxUsd? }   explore again (pull, rescan, map what changed)
 */
export async function importsRoute(
  ctx: { log: EventLog; explorer: RepoExplorer; readJson: (req: IncomingMessage) => Promise<Record<string, unknown>>; canImport?: () => string | null },
  req: IncomingMessage,
  url: URL,
): Promise<[number, unknown] | null> {
  const { log, explorer } = ctx;
  const path = url.pathname;
  if (req.method === "GET" && path === "/api/imports") return [200, { imports: listImports(log), maxUsd: explorer.maxUsd, mode: explorer.mode() }];
  if (req.method === "POST" && path === "/api/imports") {
    const blocked = ctx.canImport?.();
    if (blocked) return [409, { error: blocked }];
    const body = await ctx.readJson(req);
    const r = explorer.importRepo(String(body.source ?? ""), { name: body.name ? String(body.name) : undefined, maxUsd: typeof body.maxUsd === "number" ? body.maxUsd : undefined });
    r.done.catch(() => {});
    return [202, { projectId: r.projectId, existing: r.existing }];
  }
  const m = path.match(/^\/api\/imports\/(\d+)(?:\/(explore))?$/);
  if (!m) return null;
  const id = Number(m[1]);
  if (req.method === "GET" && !m[2]) {
    const d = importDetail(log, id);
    return d ? [200, { ...d, busy: explorer.busy(id), maxUsd: explorer.maxUsd, mode: explorer.mode() }] : [404, { error: `Project #${id} was not imported from a repo` }];
  }
  if (req.method === "POST" && m[2] === "explore") {
    if (!importOf(log, id)) return [404, { error: `Project #${id} was not imported from a repo` }];
    const body = await ctx.readJson(req);
    explorer.explore(id, { maxUsd: typeof body.maxUsd === "number" ? body.maxUsd : undefined }).catch(() => {});
    return [202, { projectId: id }];
  }
  return null;
}

// Every imported project's detail carries its code facts.
registerProjectFacet({
  id: "code",
  compute(log, project) {
    const imp = importOf(log, project.id);
    if (!imp) return null;
    const m = latestMap(log, project.id);
    const s = suggestionsOf(log, project.id);
    return {
      source: imp.source, local: imp.local, dir: imp.dir, branch: imp.branch, head: imp.head, status: imp.status, spentUsd: imp.spentUsd,
      files: m?.map.files ?? null, lines: m?.map.lines ?? null, modules: m?.map.modules.length ?? null, health: m?.map.health.score ?? null,
      suggestions: s.length, openSuggestions: s.filter((x) => x.status === "pending" || x.status === "proposed").length,
    };
  },
});
