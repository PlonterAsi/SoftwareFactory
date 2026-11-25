import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Bridge in a browser: the same screens the desktop window shows, served by the core at
 * http://127.0.0.1:4317/ so the installed app can be opened, checked and photographed from any browser
 * on the PC. The installer ships the built Bridge next to the core (core/webui); in the repo it is
 * apps/bridge/dist after a build. Returns false when the path is not ours or there is no built Bridge.
 */
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".map": "application/json; charset=utf-8",
};

export function webUiDir(from = import.meta.url): string | null {
  if (process.env.SF_WEBUI_DIR) return existsSync(join(process.env.SF_WEBUI_DIR, "index.html")) ? process.env.SF_WEBUI_DIR : null;
  for (const rel of ["./webui", "../webui", "../../../apps/bridge/dist"]) {
    const dir = fileURLToPath(new URL(rel, from));
    if (existsSync(join(dir, "index.html"))) return dir;
  }
  return null;
}

export function serveWebUi(req: IncomingMessage, res: ServerResponse, url: URL, dir: string | null = webUiDir()): boolean {
  if (req.method !== "GET" || !dir) return false;
  const p = url.pathname;
  if (p.startsWith("/api/") || p.startsWith("/plugins/") || p.startsWith("/ext/") || p.startsWith("/preview/")) return false;
  let rel: string;
  try { rel = normalize(decodeURIComponent(p)).replace(/^[\\/]+/, ""); } catch { return false; }
  if (rel.split(/[\\/]/).includes("..")) return false;
  let file = join(dir, rel || "index.html");
  if (!file.startsWith(dir + sep) && file !== join(dir, "index.html")) return false;
  const isFile = (f: string) => { try { return statSync(f).isFile(); } catch { return false; } };
  // The Bridge keeps its place in the address after "#", so any path without a file is the page itself.
  if (!isFile(file)) { if (extname(rel)) return false; file = join(dir, "index.html"); }
  res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-cache" });
  createReadStream(file).pipe(res);
  return true;
}
