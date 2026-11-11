import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import type { EventLog } from "../events.js";
import { registerProjectFacet } from "../projects/service.js";
import { INTEGRATION_FORMS, type IntegrationForm } from "./assess.js";
import { getIntegration, installedFeatures, listIntegrations, type Integrations } from "./service.js";

/**
 * The integrations API. Every write is an event, so the Bridge sees it on the stream.
 *
 *   GET  /api/integrations                       every request, newest first, and the installed features
 *   GET  /api/integrations/assess/:projectId     readiness checks and the forms it can take
 *   POST /api/integrations                       { projectId, form }   ask to add it (waits for your approval)
 *   GET  /api/integrations/:id
 *   POST /api/integrations/:id/decide            { approve, note? }    the gate
 *   POST /api/integrations/:id/remove
 *   POST /api/integrations/:id/run               { args?, stdin? }     run an installed tool
 *   GET  /ext/:id/<path>                          an installed panel's files
 */
export async function integrationsRoute(
  ctx: { log: EventLog; integrations: Integrations; readJson: (req: IncomingMessage) => Promise<Record<string, unknown>> },
  req: IncomingMessage,
  url: URL,
): Promise<[number, unknown] | null> {
  const { log, integrations } = ctx;
  const path = url.pathname;
  if (req.method === "GET" && path === "/api/integrations") return [200, { integrations: listIntegrations(log), installed: installedFeatures(log), dir: integrations.extDir }];
  const a = path.match(/^\/api\/integrations\/assess\/(\d+)$/);
  if (req.method === "GET" && a) {
    const r = integrations.assess(Number(a[1]));
    return r ? [200, { ...r, history: listIntegrations(log, { projectId: Number(a[1]) }) }] : [404, { error: `No project #${a[1]}` }];
  }
  if (req.method === "POST" && path === "/api/integrations") {
    const body = await ctx.readJson(req);
    const form = String(body.form ?? "") as IntegrationForm;
    if (!INTEGRATION_FORMS.includes(form)) return [400, { error: `form is one of ${INTEGRATION_FORMS.join(", ")}` }];
    try { return [201, integrations.request(Number(body.projectId), form)]; }
    catch (e) { return [409, { error: (e as Error).message }]; }
  }
  const m = path.match(/^\/api\/integrations\/(\d+)(?:\/(decide|remove|run))?$/);
  if (!m) return null;
  const id = Number(m[1]);
  if (req.method === "GET" && !m[2]) { const i = getIntegration(log, id); return i ? [200, i] : [404, { error: `No integration #${id}` }]; }
  if (req.method !== "POST" || !m[2]) return null;
  const body = await ctx.readJson(req);
  try {
    if (m[2] === "decide") return [200, integrations.decide(id, body.approve === true, { note: body.note ? String(body.note) : undefined })];
    if (m[2] === "remove") return [200, integrations.remove(id)];
    return [200, await integrations.runTool(id, String(body.args ?? ""), { stdin: body.stdin != null ? String(body.stdin) : undefined })];
  } catch (e) {
    return [409, { error: (e as Error).message }];
  }
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".wasm": "application/wasm",
  ".woff": "font/woff", ".woff2": "font/woff2", ".map": "application/json",
};

/** Serve an installed panel's files at /ext/:id/. Returns false when the path is not ours. */
export function serveExtension(integrations: Integrations, req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const m = url.pathname.match(/^\/ext\/(\d+)(\/.*)?$/);
  if (!m || req.method !== "GET") return false;
  // /ext/7 → /ext/7/ so the page's relative links resolve inside its folder.
  if (m[2] == null) { res.writeHead(302, { location: `/ext/${m[1]}/` }); res.end(); return true; }
  const file = integrations.panelFile(Number(m[1]), m[2].slice(1));
  if (!file) { res.writeHead(404, { "content-type": "text/plain" }); res.end("Not found"); return true; }
  res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-cache" });
  createReadStream(file).pipe(res);
  return true;
}

// Every project's detail says whether (and how) it lives inside SoftwareFactory.
registerProjectFacet({
  id: "integration",
  compute(log, project) {
    const all = listIntegrations(log, { projectId: project.id });
    if (!all.length) return null;
    return {
      installed: all.filter((i) => i.status === "installed").map((i) => ({ id: i.id, form: i.form, title: i.title, uses: i.uses })),
      awaiting: all.filter((i) => i.status === "awaiting").length,
      briefed: all.filter((i) => i.status === "briefed").length,
    };
  },
});
