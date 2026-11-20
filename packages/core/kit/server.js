// SoftwareFactory app kit: the app's server. Written by SoftwareFactory; do not edit (it is rewritten on every build).
// Start it with the Run tab's Start (or `npm start`). It needs no arguments and no config file:
//   - serves the app's pages (index.html, web/, src/)
//   - keeps the app's data in data/db.json (created with the sample records on first start)
//   - a JSON API for every entity: GET/POST /api/<entity>, GET/PUT/DELETE /api/<entity>/<id>
//   - when the app needs the disk or the operating system, its own routes live in api.js
//   - when it needs research or judgment plain code cannot do, it asks one of your agents:
//     POST /api/_agent { task, input?, agent? } from a view, or ctx.ask(task, input) in api.js
//     (SoftwareFactory must be open; it runs the agent and logs what it cost)
//   - keeps a log of its errors in data/app.log (System → Log), keeps running after one, and files each as a bug
//     in its project in SoftwareFactory (when started from the Run tab): server errors, crashes, and the page's own
//   - when it needs data from the internet (a public API, a feed, a page), it reads it through this server:
//     GET /api/_fetch?url=https://... from a view (ctx.web(url) does it for you), or plain fetch() in api.js
import { createServer } from "node:http";
import { readFile, writeFile, rename, mkdir, readdir, stat, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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

// Errors: one line each in data/app.log (the last 1 MB, then app.log.1), and a bug in the app's project in
// SoftwareFactory when the Run tab started it (SF_PROJECT_ID). Nothing leaves this computer.
const logFile = join(dataDir, "app.log");
let logging = Promise.resolve();
function logLine(level, text) {
  const line = new Date().toISOString() + " " + level.toUpperCase() + " " + String(text).replace(/\r?\n/g, "\n    ") + "\n";
  logging = logging.then(async () => {
    await mkdir(dataDir, { recursive: true });
    const size = await stat(logFile).then((s) => s.size).catch(() => 0);
    if (size > 1e6) await rename(logFile, logFile + ".1").catch(() => {});
    await appendFile(logFile, line);
  }).catch(() => {});
  return logging;
}
const reported = new Map();
async function report(where, err) {
  const message = String((err && err.message) || err || "Unknown error").slice(0, 2000);
  const stack = err && err.stack ? String(err.stack).slice(0, 8000) : undefined;
  logLine("error", where + ": " + (stack || message));
  if (!process.env.SF_PROJECT_ID) return;
  // The same error from the same place is filed once a minute at most; SoftwareFactory counts the repeats.
  const key = where + "|" + message;
  if (Date.now() - (reported.get(key) || 0) < 60000) return;
  reported.set(key, Date.now());
  try {
    await fetch(CORE + "/api/apps/error", { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ project: Number(process.env.SF_PROJECT_ID), app: (schema.app && schema.app.name) || "the app", where, message, stack }) });
  } catch { /* SoftwareFactory is closed: the log keeps it */ }
}
// A crash in a route or a timer is logged and filed, and the app keeps serving.
process.on("uncaughtException", (e) => { report("server crash", e); });
process.on("unhandledRejection", (e) => { report("server crash", e); });

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

// Reading the internet for the app's own pages: the browser will not let a page read most sites (CORS), so the
// server reads them. Only http and https, only public addresses (never this computer or the home network, so a
// page cannot reach SoftwareFactory or the router through it), a GET only, at most 5 MB and 20 seconds, at most
// 3 redirects (each checked again). The answer comes back as it came, marked so it never runs as a page here.
const WEB_MAX = 5e6;
const privateIp = (ip) => {
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const x = ip.toLowerCase();
  return x === "::" || x === "::1" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe80") || x.startsWith("ff");
};
async function publicUrl(raw) {
  let u;
  try { u = new URL(String(raw || "")); } catch { throw Object.assign(new Error("Give a whole address, like https://example.com/data.json"), { status: 400 }); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw Object.assign(new Error("Only http and https addresses can be read"), { status: 400 });
  if (process.env.APP_WEB_ALLOW_LOCAL === "1") return u;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => { throw Object.assign(new Error("No such site: " + host), { status: 502 }); })).map((a) => a.address);
  if (!ips.length || ips.some(privateIp)) throw Object.assign(new Error("Only public internet addresses can be read, not this computer or the local network"), { status: 403 });
  return u;
}
async function web(raw) {
  let u = await publicUrl(raw);
  for (let hop = 0; ; hop++) {
    const r = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(20000), headers: { "user-agent": "SoftwareFactory-app" } })
      .catch((e) => { throw Object.assign(new Error("Could not reach " + u.host + ": " + (e.name === "TimeoutError" ? "no answer in 20 seconds" : e.message)), { status: 502 }); });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      if (hop >= 3) throw Object.assign(new Error("Too many redirects"), { status: 502 });
      u = await publicUrl(new URL(r.headers.get("location"), u).href);
      continue;
    }
    if (Number(r.headers.get("content-length") || 0) > WEB_MAX) throw Object.assign(new Error("The answer is larger than 5 MB"), { status: 413 });
    const chunks = [];
    let size = 0;
    for await (const c of r.body || []) { size += c.length; if (size > WEB_MAX) throw Object.assign(new Error("The answer is larger than 5 MB"), { status: 413 }); chunks.push(c); }
    return { status: r.status, type: r.headers.get("content-type") || "application/octet-stream", data: Buffer.concat(chunks) };
  }
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
  if (name === "_error" && req.method === "POST") {
    // The page's own errors (shell.js): logged and filed like the server's.
    const b = await body(req).catch(() => ({}));
    await report("page " + String(b.where || "").slice(0, 80), { message: String(b.message || "Unknown error"), stack: b.stack ? String(b.stack) : undefined });
    return send(res, 200, { ok: true });
  }
  if (name === "_log" && req.method === "GET") {
    await logging;
    const text = await readFile(logFile, "utf8").catch(() => "");
    return send(res, 200, { file: relative(root, logFile), lines: text.split("\n").filter(Boolean).slice(-200) });
  }
  if (name === "_agent" && req.method === "POST") {
    const b = await body(req);
    try { return send(res, 200, await ask(b.task, b.input, { agent: b.agent })); } catch (e) { return send(res, e.status || 502, { error: e.message }); }
  }
  if (name === "_fetch" && req.method === "GET") {
    // A page from another site must not use this app as its way out.
    if (req.headers["sec-fetch-site"] === "cross-site") return send(res, 403, { error: "not allowed" });
    try {
      const r = await web(url.searchParams.get("url"));
      res.writeHead(r.status, { "content-type": r.type, "x-fetched-status": String(r.status), "x-content-type-options": "nosniff", "content-security-policy": "sandbox", "cache-control": "no-store" });
      return res.end(r.data);
    } catch (e) { return send(res, e.status || 502, { error: e.message }); }
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
    report(req.method + " " + req.url.split("?")[0], e);
    send(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(Number(process.env.PORT) || 0, "127.0.0.1", () => {
  console.log("Ready on http://localhost:" + server.address().port + "/");
  console.log("Data: " + (process.env.APP_DATA_DIR ? dbFile : relative(root, dbFile)));
});
