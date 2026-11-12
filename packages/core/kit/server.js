// SoftwareFactory app kit: the app's server. Written by SoftwareFactory; do not edit (it is rewritten on every build).
// Start it with the Run tab's Start (or `npm start`). It needs no arguments and no config file:
//   - serves the app's pages (index.html, web/, src/)
//   - keeps the app's data in data/db.json (created with the sample records on first start)
//   - a JSON API for every entity: GET/POST /api/<entity>, GET/PUT/DELETE /api/<entity>/<id>
//   - when the app needs the disk or the operating system, its own routes live in api.js
//   - when it needs research or judgment plain code cannot do, it asks one of your agents:
//     POST /api/_agent { task, input?, agent? } from a view, or ctx.ask(task, input) in api.js
//     (SoftwareFactory must be open; it runs the agent and logs what it cost)
import { createServer } from "node:http";
import { readFile, writeFile, rename, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as schema from "./src/schema.js";
import { createRecord, updateRecord, deleteRecord, seedDb, importDb, query, entityOf, checkSchema } from "./web/kit/db.js";

const root = dirname(fileURLToPath(import.meta.url));
// The factory's app check points this at a scratch folder, so checking never touches your data.
const dataDir = process.env.APP_DATA_DIR || join(root, "data");
const dbFile = join(dataDir, "db.json");
const problems = checkSchema(schema);
if (problems.length) { console.error("The app's schema is not usable:\n- " + problems.join("\n- ")); process.exit(1); }

let db;
let saving = Promise.resolve();
try { db = JSON.parse(await readFile(dbFile, "utf8")); } catch { db = seedDb(schema); await save(); }
for (const e of schema.entities) if (!db.data[e.name]) db.data[e.name] = [];

function save() {
  // One write at a time, through a temporary file, so a crash never leaves half a file.
  saving = saving.then(async () => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(dbFile + ".tmp", JSON.stringify(db, null, 2));
    await rename(dbFile + ".tmp", dbFile);
  });
  return saving;
}

const ext = existsSync(join(root, "api.js")) ? await import(pathToFileURL(join(root, "api.js")).href) : null;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8" };
const PUBLIC = /^(index\.html|favicon\.ico|web\/.+|src\/.+|assets\/.+)$/;

function send(res, status, body, type) {
  res.writeHead(status, { "content-type": type || "application/json", "cache-control": "no-store" });
  res.end(type ? body : JSON.stringify(body));
}

async function body(req) {
  let s = "";
  for await (const c of req) { s += c; if (s.length > 20e6) throw new Error("too large"); }
  return s ? JSON.parse(s) : {};
}

// Your agents live in SoftwareFactory; the Run tab tells the app where (SF_CORE_URL).
const CORE = process.env.SF_CORE_URL || "http://127.0.0.1:4317";
async function ask(task, input, opts = {}) {
  let r;
  try {
    r = await fetch(CORE + "/api/apps/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task, input, agent: opts.agent, app: (schema.app && schema.app.name) || "an app" }) });
  } catch {
    throw Object.assign(new Error("Open SoftwareFactory to use this app's agent."), { status: 503 });
  }
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(out.error || "The agent could not answer."), { status: r.status });
  return out;
}

async function files(dir, out) {
  for (const name of await readdir(dir)) {
    if (name.startsWith(".") || name === "node_modules" || name === "data") continue;
    const p = join(dir, name);
    const s = await stat(p);
    if (s.isDirectory()) await files(p, out);
    else if (s.size < 400000) out.push({ path: relative(root, p).split(sep).join("/"), lines: (await readFile(p, "utf8")).split("\n").length });
  }
  return out;
}

async function api(req, res, url) {
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const [name, id] = parts;
  if (name === "_db" && req.method === "GET") return send(res, 200, db);
  if (name === "_reset" && req.method === "POST") { db = seedDb(schema); await save(); return send(res, 200, { db, record: null }); }
  if (name === "_import" && req.method === "POST") { db = importDb(schema, await body(req)); await save(); return send(res, 200, { db, record: null }); }
  if (name === "_system" && !id) return send(res, 200, { app: schema.app || {}, storage: relative(root, dbFile), files: (await files(root, [])).sort((a, b) => a.path.localeCompare(b.path)) });
  if (name === "_system" && id === "file") {
    const p = normalize(url.searchParams.get("path") || "");
    const abs = join(root, p);
    if (p.startsWith("..") || !abs.startsWith(root) || /(^|[\\/])(data|\.git|node_modules)([\\/]|$)/.test(p)) return send(res, 403, { error: "not allowed" });
    try { return send(res, 200, await readFile(abs, "utf8"), "text/plain; charset=utf-8"); } catch { return send(res, 404, { error: "no such file" }); }
  }
  if (name === "_agent" && req.method === "POST") {
    const b = await body(req);
    try { return send(res, 200, await ask(b.task, b.input, { agent: b.agent })); } catch (e) { return send(res, e.status || 502, { error: e.message }); }
  }
  if (ext && typeof ext.handle === "function") {
    const handled = await ext.handle(req, res, url, { db, schema, save, send, body: () => body(req), root, ask });
    if (handled) return;
  }
  let entity;
  try { entity = entityOf(schema, name); } catch { return send(res, 404, { error: "no such entity: " + name }); }
  try {
    if (!id && req.method === "GET") return send(res, 200, query(schema, db, entity.name, { q: url.searchParams.get("q") || "", sort: url.searchParams.get("sort"), desc: url.searchParams.get("desc") === "1" }));
    if (!id && req.method === "POST") { const record = createRecord(schema, db, entity.name, await body(req)); await save(); return send(res, 201, { db, record }); }
    const rec = db.data[entity.name].find((r) => r.id === Number(id));
    if (!rec) return send(res, 404, { error: "no " + entity.name + " #" + id });
    if (req.method === "GET") return send(res, 200, rec);
    if (req.method === "PUT" || req.method === "PATCH") { const record = updateRecord(schema, db, entity.name, id, await body(req)); await save(); return send(res, 200, { db, record }); }
    if (req.method === "DELETE") { const record = deleteRecord(schema, db, entity.name, id); await save(); return send(res, 200, { db, record }); }
    return send(res, 405, { error: "method not allowed" });
  } catch (e) {
    return send(res, e.errors ? 422 : 400, { error: e.message, errors: e.errors });
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/") || url.pathname === "/api") return await api(req, res, url);
    let p = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    if (p.endsWith("/")) p += "index.html";
    p = normalize(p).split(sep).join("/");
    if (!PUBLIC.test(p) || p.startsWith("..")) return send(res, 404, "Not found", "text/plain");
    const data = await readFile(join(root, p)).catch(() => null);
    if (!data) return send(res, 404, "Not found", "text/plain");
    res.writeHead(200, { "content-type": TYPES[extname(p)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  } catch (e) {
    send(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(Number(process.env.PORT) || 0, "127.0.0.1", () => {
  console.log("Ready on http://localhost:" + server.address().port + "/");
  console.log("Data: " + (process.env.APP_DATA_DIR ? dbFile : relative(root, dbFile)));
});
