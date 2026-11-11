import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import { PERMISSION_TEXT } from "./manifest.js";
import type { PluginHost } from "./host.js";
import { FRAME_CSS_SOURCE, FRAME_SDK_SOURCE } from "./runner.js";

/**
 * The plugins API. Every change is an event, so the Bridge sees it on the stream.
 *
 *   GET  /api/plugins                         installed plugins, bundled examples, the folder, what each permission means
 *   POST /api/plugins/install                 { dir } or { example }   copy a plugin folder in (it starts off)
 *   GET  /api/plugins/:id
 *   POST /api/plugins/:id/enable              the one approval: grants what its manifest asks for
 *   POST /api/plugins/:id/disable
 *   POST /api/plugins/:id/remove
 *   GET  /api/plugins/:id/log
 *   GET  /api/plugins/:id/data
 *   GET  /api/plugins/:id/events?projectId=&types=a,b&limit=   needs events:read
 *   POST /api/plugins/:id/call                { method, args }  its backend answers
 *   GET  /plugins/:id/<path>                  an enabled plugin's pages and their files
 *   GET  /plugins/_sdk/sf.js, sf.css          the helper and base styles every plugin page can load
 */
export async function pluginsRoute(
  ctx: { plugins: PluginHost; readJson: (req: IncomingMessage) => Promise<Record<string, unknown>> },
  req: IncomingMessage,
  url: URL,
): Promise<[number, unknown] | null> {
  const { plugins } = ctx;
  const path = url.pathname;
  if (req.method === "GET" && path === "/api/plugins") {
    return [200, { plugins: plugins.list(), examples: plugins.examples(), dir: plugins.root, permissions: PERMISSION_TEXT }];
  }
  if (req.method === "POST" && path === "/api/plugins/install") {
    const body = await ctx.readJson(req);
    try {
      if (body.example) {
        const ex = plugins.examples().find((x) => x.id === String(body.example));
        if (!ex) return [404, { error: `No example plugin "${body.example}"` }];
        return [201, plugins.install(ex.dir, { from: `example:${ex.id}` })];
      }
      if (!body.dir) return [400, { error: "Send { dir } (a folder with a plugin.json) or { example }" }];
      return [201, plugins.install(String(body.dir))];
    } catch (e) { return [409, { error: (e as Error).message }]; }
  }
  const m = path.match(/^\/api\/plugins\/([a-z0-9-]+)(?:\/(enable|disable|remove|log|data|events|call))?$/);
  if (!m) return null;
  const id = m[1];
  const op = m[2];
  try {
    if (req.method === "GET") {
      if (!op) { const v = plugins.get(id); return v ? [200, v] : [404, { error: `No plugin ${id}` }]; }
      if (op === "log") return [200, { log: plugins.logOf(id) }];
      if (op === "data") return [200, { data: plugins.data(id) }];
      if (op === "events") {
        const pid = url.searchParams.get("projectId");
        const types = url.searchParams.get("types")?.split(",").map((s) => s.trim()).filter(Boolean);
        const limit = Number(url.searchParams.get("limit") ?? 500);
        return [200, { events: plugins.events(id, { projectId: pid ? Number(pid) : null, types, limit }) }];
      }
      return null;
    }
    if (req.method !== "POST" || !op) return null;
    const body = await ctx.readJson(req);
    if (op === "enable") return [200, plugins.enable(id)];
    if (op === "disable") return [200, plugins.disable(id)];
    if (op === "remove") return [200, plugins.remove(id)];
    if (op === "call") return [200, { value: await plugins.call(id, String(body.method ?? ""), body.args ?? {}) }];
    return null;
  } catch (e) {
    return [409, { error: (e as Error).message }];
  }
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".wasm": "application/wasm",
  ".woff": "font/woff", ".woff2": "font/woff2",
};

/** Serve /plugins/_sdk/* and an enabled plugin's files at /plugins/:id/. Returns false when the path is not ours. */
export function servePluginFile(plugins: PluginHost, req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (req.method !== "GET" || !url.pathname.startsWith("/plugins/")) return false;
  if (url.pathname === "/plugins/_sdk/sf.js" || url.pathname === "/plugins/_sdk/sf.css") {
    const js = url.pathname.endsWith(".js");
    res.writeHead(200, { "content-type": js ? TYPES[".js"] : TYPES[".css"], "cache-control": "no-cache" });
    res.end(js ? FRAME_SDK_SOURCE : FRAME_CSS_SOURCE);
    return true;
  }
  const m = url.pathname.match(/^\/plugins\/([a-z0-9-]+)\/(.*)$/);
  if (!m) return false;
  const file = plugins.file(m[1], m[2]);
  if (!file) { res.writeHead(404, { "content-type": "text/plain" }); res.end("Not found (is the plugin turned on?)"); return true; }
  // Pages run in a sandboxed frame; this keeps them from being framed anywhere else or loading other sites' scripts.
  res.writeHead(200, {
    "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-cache",
    "content-security-policy": "default-src 'self' 'unsafe-inline' data: blob:; connect-src 'none'; frame-ancestors *",
  });
  createReadStream(file).pipe(res);
  return true;
}
