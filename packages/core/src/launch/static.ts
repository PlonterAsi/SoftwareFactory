import { createReadStream, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon", ".bmp": "image/bmp",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".mp4": "video/mp4", ".webm": "video/webm",
  ".wasm": "application/wasm", ".pdf": "application/pdf",
};

/**
 * Resolve a URL path inside a folder, refusing anything that leaves it
 * (`..`, absolute paths, NUL, the .git folder). Returns null when refused.
 */
export function resolveInside(root: string, urlPath: string): string | null {
  let rel: string;
  try { rel = decodeURIComponent(urlPath); } catch { return null; }
  if (rel.includes("\0")) return null;
  rel = normalize(rel.replace(/^[/\\]+/, ""));
  const abs = resolve(root, rel);
  const back = relative(resolve(root), abs);
  if (back.startsWith("..") || isAbsolute(back)) return null;
  if (back.split(sep)[0] === ".git") return null;
  return abs;
}

/**
 * Serve one file of a folder: index.html for folders, the right content type,
 * no caching (the files change while you work). Answers 404 for anything outside the folder.
 */
export function serveStatic(res: ServerResponse, root: string, urlPath: string, method = "GET") {
  const abs = resolveInside(root, urlPath);
  if (!abs) return notFound(res);
  let file = abs;
  try {
    let st = statSync(file);
    if (st.isDirectory()) { file = join(file, "index.html"); st = statSync(file); }
    if (!st.isFile()) return notFound(res);
    res.writeHead(200, {
      "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "content-length": st.size,
      "cache-control": "no-store",
    });
    if (method === "HEAD") return res.end();
    createReadStream(file).on("error", () => res.end()).pipe(res);
  } catch { notFound(res); }
}

function notFound(res: ServerResponse) {
  res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
  res.end("<!doctype html><title>Not here</title><body style=\"font:14px system-ui;background:#070b12;color:#7488a3;padding:24px\">Nothing at this address in the project folder.</body>");
}
