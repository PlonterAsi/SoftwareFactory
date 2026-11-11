/**
 * The script that hosts one plugin's backend in its own Node process. It is written to
 * <plugins>/.runtime/runner.mjs and started with Node's permission model:
 *
 *   node --permission --allow-fs-read=<plugin folder> --allow-fs-read=<runner> runner.mjs <main>
 *
 * so the backend can read its own folder and nothing else, cannot write files, and cannot
 * start programs. It talks to the core with one JSON message per line on stdin/stdout,
 * and sees the core through a global `sf`:
 *
 *   sf.plugin                       its manifest
 *   sf.on("factory.run.*", (e) => …) receive events it subscribed to (needs events:read)
 *   sf.handle("summary", (args) => …) answer calls from its panels
 *   sf.emit("milestone", {…}, { projectId })  post a timeline entry (needs events:write)
 *   sf.data.get(key) / set(key, value) / all()  its own small store, kept in the core's database
 *   sf.log(…)  (console.log goes there too)   its log, shown on the Plugins page
 */
export const RUNNER_SOURCE = String.raw`// SoftwareFactory plugin runner (generated; do not edit).
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const main = process.argv[2];
const out = (m) => { try { process.stdout.write(JSON.stringify(m) + "\n"); } catch { /* host gone */ } };
const text = (a) => a.map((x) => typeof x === "string" ? x : x instanceof Error ? (x.stack || x.message) : (() => { try { return JSON.stringify(x); } catch { return String(x); } })()).join(" ");
const handlers = [];
const methods = new Map();
let data = {};
let manifest = null;

const matches = (p, t) => p === "*" || p === t || (p.endsWith(".*") && t.startsWith(p.slice(0, -1)));

globalThis.sf = Object.freeze({
  get plugin() { return manifest; },
  on(pattern, fn) { if (typeof fn === "function") handlers.push([String(pattern), fn]); },
  handle(method, fn) { if (typeof fn === "function") methods.set(String(method), fn); },
  emit(name, payload = {}, opts = {}) { out({ t: "emit", name: String(name), payload, projectId: opts.projectId ?? null }); },
  data: Object.freeze({
    get: (k) => data[k],
    all: () => ({ ...data }),
    set(k, v) { k = String(k); if (v === undefined || v === null) delete data[k]; else data[k] = v; out({ t: "set", key: k, value: v ?? null }); },
  }),
  log: (...a) => out({ t: "log", level: "info", text: text(a) }),
});
console.log = console.info = console.debug = (...a) => out({ t: "log", level: "info", text: text(a) });
console.warn = (...a) => out({ t: "log", level: "warn", text: text(a) });
console.error = (...a) => out({ t: "log", level: "error", text: text(a) });

async function onEvent(e) {
  for (const [p, fn] of handlers) {
    if (!matches(p, e.type)) continue;
    try { await fn(e); } catch (err) { console.error("handler for " + p + " failed:", err); }
  }
}

async function onCall(m) {
  const fn = methods.get(m.method);
  if (!fn) return out({ t: "reply", rid: m.rid, ok: false, error: "The plugin has no method \"" + m.method + "\"" });
  try { out({ t: "reply", rid: m.rid, ok: true, value: (await fn(m.args ?? {})) ?? null }); }
  catch (err) { out({ t: "reply", rid: m.rid, ok: false, error: String(err && err.message || err) }); }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.t === "init") {
    manifest = m.manifest; data = m.data ?? {};
    try { await import(pathToFileURL(main).href); }
    catch (err) { console.error("could not start:", err); process.exit(1); }
    out({ t: "ready" });
  } else if (m.t === "event") onEvent(m.event);
  else if (m.t === "call") onCall(m);
  else if (m.t === "stop") process.exit(0);
});
rl.on("close", () => process.exit(0));
`;

/** The helper every plugin page loads with <script src="/plugins/_sdk/sf.js"></script>. */
export const FRAME_SDK_SOURCE = String.raw`// SoftwareFactory plugin page helper.
(function () {
  var params = new URLSearchParams(location.search);
  var n = 0, waiting = new Map(), listeners = [];
  window.addEventListener("message", function (ev) {
    if (ev.source !== window.parent) return;
    var m = ev.data;
    if (!m || m.sf !== 1) return;
    if (m.rid && waiting.has(m.rid)) {
      var w = waiting.get(m.rid); waiting.delete(m.rid);
      m.ok ? w.res(m.value) : w.rej(new Error(m.error || "failed"));
    } else if (m.push === "event") {
      listeners.forEach(function (f) { try { f(m.event); } catch (e) { console.error(e); } });
    }
  });
  function ask(op, args) {
    return new Promise(function (res, rej) {
      var rid = ++n;
      waiting.set(rid, { res: res, rej: rej });
      window.parent.postMessage({ sf: 1, rid: rid, op: op, args: args || {} }, "*");
      setTimeout(function () { if (waiting.delete(rid)) rej(new Error("SoftwareFactory did not answer")); }, 15000);
    });
  }
  window.sf = {
    /** The project this tab is in (null on a page of its own). */
    projectId: params.get("project") ? Number(params.get("project")) : null,
    /** { plugin, project } */
    context: function () { return ask("context"); },
    /** Events of this project (or the whole factory on a page): { types?: ["factory.*"], limit? }. Needs events:read. */
    events: function (opts) { return ask("events", opts); },
    /** Call the plugin's backend: sf.handle(method, fn) there. */
    call: function (method, args) { return ask("call", { method: method, args: args }); },
    /** The plugin's own stored data. */
    data: function () { return ask("data"); },
    /** New events as they happen (same filter as events). Needs events:read. */
    onEvent: function (fn) { listeners.push(fn); ask("subscribe").catch(function () {}); },
  };
})();
`;

/** Base styles that make a plugin page look like the rest of the app: <link rel="stylesheet" href="/plugins/_sdk/sf.css">. */
export const FRAME_CSS_SOURCE = `:root{color-scheme:dark;--bg:#070b12;--panel:#0c1320;--panel-2:#101a2b;--line:#1c2a40;--ink:#d9e4f2;--muted:#7488a3;--accent:#4fd6e8;--gate:#f2b34b;--bad:#ff6b6b;--good:#5ee0a0;--display:"Chakra Petch",system-ui,sans-serif;--body:"IBM Plex Sans",system-ui,sans-serif;--mono:"IBM Plex Mono",ui-monospace,monospace}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--ink);font:14px/1.45 var(--body);padding:16px}
h1,h2,h3{font-family:var(--display);font-weight:600;letter-spacing:.04em;margin:0 0 8px}h1{font-size:18px}h2{font-size:15px}h3{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.12em}
.muted{color:var(--muted)}.mono{font-family:var(--mono);font-size:12px}.good{color:var(--good)}.bad{color:var(--bad)}.gate{color:var(--gate)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.row{display:flex;gap:12px;flex-wrap:wrap}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.big{font-family:var(--display);font-size:28px;font-weight:600}
button{background:var(--panel-2);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:6px 12px;font:inherit;cursor:pointer}button:hover{border-color:var(--accent)}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:500}
`;
