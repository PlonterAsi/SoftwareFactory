#!/usr/bin/env node
// End-to-end smoke test of the *installed* SoftwareFactory app on Windows.
//
// Runs in GitHub Actions on a Windows runner after every build, and gates the
// "latest" release: a build that fails here is never published.
//
//   1. installs SoftwareFactory-setup.exe silently (/S)
//   2. seeds the data folder with an old (milestone 1 to 3) database, so the
//      upgrade path runs for real: backup, migrations, tables backfilled
//   3. launches the app; the bundled Node core must answer on 127.0.0.1:4317
//      and the Bridge window must open its event stream to the core
//   4. builds one idea into a tested, tagged git repo on the free practice crew
//      and runs it from inside the app (Run tab): the shipped CLI with arguments,
//      and a small web app through a package.json script, previewed, then stopped
//   5. checks the Data vault report (tables healthy, files tracked)
//   6. kills the app mid-run, starts it again, and expects the run to resume
//      from its last completed station and ship
//   7. closes the app normally and expects the core to exit with it
//   8. unpacks the portable zip and checks it starts too
//   Safe by design: deletes nothing (an existing data folder is moved aside), and runs only on CI or with --test-machine.
//   9. in-app update: installs an older version (0.0.1, built by CI to look for updates on this
//      test's local server), launches it, and expects it to find this build, download and verify
//      it, stop its core, install it and start again as the new version with the data intact
//
// Usage (Windows):
//   node scripts/smoke/windows-smoke.mjs --installer out/SoftwareFactory-setup.exe --portable out/SoftwareFactory-portable.zip \
//     [--old-installer smoke-update/SoftwareFactory-old-setup.exe --update-sig smoke-update/SoftwareFactory-setup.exe.testsig --version 0.2.41] --out smoke-out
//
// Writes smoke-out/report.md (also appended to the job summary), core logs and screenshots.

import { spawn, spawnSync } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]?.startsWith("--") ? "1" : all[i + 1] ?? "1"]] : acc), []));
const OUT = resolve(args.out ?? "smoke-out");
const API = "http://127.0.0.1:4317";
const IDENT = "dev.plonter.softwarefactory";
const DATA = join(process.env.APPDATA ?? join(process.env.HOME ?? ".", ".config"), IDENT);
const APP_ENV = { ...process.env, SF_RUNTIME: "mock", SF_MOCK_DELAY_MS: args.delay ?? "400", SF_DROP: join(OUT, "drop") };
// Safety: this test installs and uninstalls SoftwareFactory and starts from an empty data folder.
// It deletes nothing (an existing data folder is moved aside to a dated backup), and it runs only
// on a CI machine or when told this is a test machine, never by accident on a PC with real work.
if (!process.env.CI && !args["test-machine"]) {
  console.error("Refusing to run: this smoke test reinstalls SoftwareFactory and moves its data folder aside.\nRun it on CI, or on a test machine with --test-machine.");
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });
const STAMP = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
/** Move a folder out of the way instead of deleting it. */
function moveAside(dir) {
  if (!existsSync(dir)) return null;
  const to = `${dir}.before-smoke-${STAMP}`;
  renameSync(dir, to);
  log("moved aside (nothing deleted):", dir, "->", to);
  return to;
}

const results = [];
let fatal = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[smoke ${new Date().toISOString().slice(11, 19)}]`, ...a);

function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail: String(detail ?? "") });
  log(ok ? "PASS" : "FAIL", name, detail ? `(${String(detail).slice(0, 300)})` : "");
  return !!ok;
}
/** A check the rest of the test depends on: stop here when it fails. */
function must(name, ok, detail) {
  if (!check(name, ok, detail)) throw new Error(`${name}: ${detail}`);
}

// Connection errors the test met and got past (a GET retried once). Listed in the report,
// so a flaky core shows up as a warning with its cause instead of failing the run silently.
const blips = [];
let launchedCorePid = null;
let polling = 0;
/** Why a fetch failed, in one line: undici hides the socket error in `cause`. */
function why(e) {
  const c = e?.cause;
  return [e?.message, c?.code, c?.message].filter(Boolean).join(" / ");
}
async function api(path, init) {
  let r;
  try {
    r = await fetch(API + path, { ...init, headers: { "content-type": "application/json" } });
  } catch (e) {
    // Polling while the core starts or stops: a refused connection is the expected answer.
    if (polling) throw e;
    const method = init?.method ?? "GET";
    const detail = `${method} ${path}: ${why(e)}; core pid ${launchedCorePid ?? "?"} ${launchedCorePid ? (alive(launchedCorePid) ? "alive" : "GONE") : ""}`;
    // Only a GET is safe to send twice; a POST that failed might have been half done.
    if (method !== "GET") throw new Error(detail, { cause: e });
    log("connection blip, retrying once:", detail);
    blips.push(detail);
    await sleep(500);
    try {
      r = await fetch(API + path, { ...init, headers: { "content-type": "application/json" } });
    } catch (e2) {
      throw new Error(`${detail}; retry failed too: ${why(e2)}`, { cause: e2 });
    }
  }
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}
async function health() {
  try { return (await api("/api/health")).body; } catch { return null; }
}
async function until(what, fn, timeoutMs, everyMs = 500) {
  const t0 = Date.now();
  let last;
  polling++;
  try {
    while (Date.now() - t0 < timeoutMs) {
      try { last = await fn(); if (last) return last; } catch (e) { last = null; }
      await sleep(everyMs);
    }
  } finally { polling--; }
  log(`timed out after ${timeoutMs} ms waiting for ${what}`);
  return null;
}

function ps(script) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
}
function screenshot(name) {
  const file = join(OUT, `${name}.png`);
  const r = ps(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('${file}'); 'ok'`);
  log("screenshot", name, r.status === 0 ? file : r.stderr.slice(0, 200));
}

function findExe(dir) {
  if (!existsSync(dir)) return null;
  const exe = readdirSync(dir).find((f) => /\.exe$/i.test(f) && !/^uninstall/i.test(f));
  return exe ? join(dir, exe) : null;
}

let app = null;
function launch(exe, label) {
  log("launching", exe);
  const child = spawn(exe, [], { env: APP_ENV, detached: true, stdio: "ignore", cwd: OUT });
  child.on("error", (e) => log("launch error", label, e.message));
  child.unref();
  app = { child, exe, label };
  return child;
}
function kill(pid, force) {
  return spawnSync("taskkill", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], { encoding: "utf8" });
}
async function waitDown(ms) {
  return until("the core to stop", async () => !(await health()), ms, 300);
}
function saveLogs(tag) {
  for (const f of ["core.log", "core.prev.log"]) {
    const p = join(DATA, f);
    if (existsSync(p)) copyFileSync(p, join(OUT, `${tag}-${f}`));
  }
}
async function waitBridge(ms) {
  // The Bridge window, once its page loads, holds an event stream open to the core.
  return until("the Bridge window to connect", async () => {
    const h = await health();
    const origins = Object.keys(h?.clients?.streams ?? {});
    return origins.find((o) => /tauri/i.test(o)) ?? null;
  }, ms, 1000);
}
async function waitRun(id, ms) {
  return until(`run #${id} to finish`, async () => {
    const r = await api(`/api/factory/runs/${id}`);
    return r.body?.outcome ? r.body : null;
  }, ms, 1000);
}

let backups = 0;
async function main() {
  // ---------- 1. install ----------
  const installer = resolve(args.installer ?? "out/SoftwareFactory-setup.exe");
  must("installer exists", existsSync(installer), installer);
  moveAside(DATA);
  const inst = spawnSync(installer, ["/S"], { encoding: "utf8", timeout: 300_000 });
  check("silent install exits 0", inst.status === 0, `status ${inst.status} ${inst.error?.message ?? ""}`);
  const candidates = [join(process.env.LOCALAPPDATA ?? "", "SoftwareFactory"), join(process.env.ProgramFiles ?? "C:\\Program Files", "SoftwareFactory")];
  const installDir = candidates.find((d) => findExe(d));
  must("app installed", installDir, `looked in ${candidates.join(", ")}`);
  const exe = findExe(installDir);
  log("installed at", installDir, "exe", exe);
  const bundledNode = join(installDir, "node", "node.exe");
  const coreDir = join(installDir, "core");
  must("installer ships Node.js", existsSync(bundledNode), bundledNode);
  must("installer ships the core", existsSync(join(coreDir, "server.js")), coreDir);

  // ---------- 2. an old database to upgrade ----------
  mkdirSync(DATA, { recursive: true });
  const db = join(DATA, "factory.db");
  const seed = join(OUT, "seed-old-db.mjs");
  writeFileSync(seed, `
const { EventLog } = await import(${JSON.stringify(pathToFileURL(join(coreDir, "events.js")).href)});
const { DatabaseSync } = await import("node:sqlite");
const db = process.argv[2];
const log = new EventLog(db);
log.append("signal.captured", { text: "A note from before the upgrade: the smoke test seeded it", source: "bridge" });
const a = log.append("agent.run.started", { agent: "overseer", runtime: "mock", model: null, prompt: "hello" });
log.append("agent.run.completed", { runId: a.id, agent: "overseer", text: "hi", costUsd: 0.0001, durationMs: 1, models: ["mock"], runtime: "mock", contextTokens: 0 });
log.close();
// Back to the milestone 1 to 3 layout: only the event log and its search index, no schema version.
const raw = new DatabaseSync(db);
for (const { name } of raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all())
  if (!["events", "sqlite_sequence"].includes(name) && !name.startsWith("signal_fts")) raw.exec('DROP TABLE IF EXISTS "' + name + '"');
raw.exec("PRAGMA user_version = 0");
raw.close();
console.log("seeded", db);
`);
  const s = spawnSync(bundledNode, [seed, db], { encoding: "utf8" });
  must("old database seeded with the bundled Node", s.status === 0, (s.stdout + s.stderr).trim().slice(-400));

  // ---------- 3. launch ----------
  launch(exe, "installed");
  const h = await until("the core to answer", health, 120_000, 1000);
  saveLogs("installed-start");
  must("bundled core answers on 127.0.0.1:4317", h?.ok, h ? JSON.stringify(h) : readTail(join(DATA, "core.log")));
  launchedCorePid = h.pid ?? null;
  check("practice crew is on", h.runtime === "mock" && h.mode === "practice", `${h.runtime} / ${h.mode}`);
  const nodeV = spawnSync(bundledNode, ["-p", "process.version"], { encoding: "utf8" }).stdout.trim();
  check("the core runs on the bundled Node.js", h.node === nodeV, `core ${h.node}, bundled ${nodeV}`);
  const origin = await waitBridge(90_000);
  screenshot("1-bridge-open");
  check("the Bridge window reached the core", origin, origin ?? `streams: ${JSON.stringify((await health())?.clients)}`);

  // ---------- upgrade path ----------
  const st = (await api("/api/store")).body;
  const d = st.database;
  check("database upgraded to the latest schema", d.schemaVersion === d.latestSchema, `${d.schemaVersion} of ${d.latestSchema}`);
  backups = d.backups.length;
  check("a backup was written before the upgrade", d.backups.length >= 1 && existsSync(d.backups[0].file ?? ""), JSON.stringify(d.backups));
  check("the upgrade is recorded in the log", d.events.byType.some((t) => t.type === "store.migrated"), "store.migrated");
  const signals = d.tables.find((t) => t.name === "signals")?.rows ?? 0;
  const runs = d.tables.find((t) => t.name === "agent_runs")?.rows ?? 0;
  check("old history backfilled into the tables", signals >= 1 && runs >= 1, `signals ${signals}, agent_runs ${runs}`);

  // ---------- 4. one full build on the practice crew ----------
  const start = await api("/api/factory/runs", { method: "POST", body: JSON.stringify({ idea: "a CLI that counts words", autoApprove: true }) });
  must("a factory run starts", start.status === 202, JSON.stringify(start.body));
  const run1 = start.body.run;
  const fin1 = await waitRun(run1, 240_000);
  screenshot("2-run-shipped");
  must("the practice run ships", fin1?.outcome === "shipped", JSON.stringify(fin1));
  const tag = spawnSync("git", ["-C", fin1.dir, "tag"], { encoding: "utf8" }).stdout.trim();
  const commits = spawnSync("git", ["-C", fin1.dir, "log", "--oneline"], { encoding: "utf8" }).stdout.trim().split("\n").length;
  check("the shipped repo is tagged v0.1.0", tag === "v0.1.0", `${fin1.dir}: tag "${tag}", ${commits} commits`);
  const testsRun = spawnSync(bundledNode, ["--test"], { cwd: fin1.dir, encoding: "utf8" });
  check("the shipped repo's tests pass on their own", testsRun.status === 0, testsRun.stdout.split("\n").filter((l) => /^# (pass|fail)/.test(l)).join(", "));

  // ---------- 4a. project chats: what is said in a project's chat stays in that project ----------
  try {
    const cp = (await api(`/api/projects/of?kind=factory_run&ref=${run1}`)).body.projectId;
    const said = await api("/api/signals", { method: "POST", body: JSON.stringify({ text: "Smoke note for this project's chat: keep it offline.", projectId: cp }) });
    check("a note said in a project's chat is saved in that chat", said.status === 201 && said.body.projectId === cp, JSON.stringify(said.body).slice(0, 200));
    const routed = await until("the Order Engine to file the chat note", async () => { const r = (await api("/api/chat/routes")).body; return r?.filed?.[said.body.id] ? r : null; }, 30_000, 500);
    check("the chat note is filed under that same project", routed?.filed?.[said.body.id]?.includes(cp) && routed?.factoryRuns?.[run1] === cp, JSON.stringify({ filed: routed?.filed?.[said.body.id], run: routed?.factoryRuns?.[run1], cp }));
  } catch (e) {
    check("project chats work in the installed app", false, String(e).slice(0, 300));
  }

  // ---------- 4b. run finished projects from inside the app (Run tab) ----------
  try {
    const pid1 = (await api(`/api/projects/of?kind=factory_run&ref=${run1}`)).body.projectId;
    const li = (await api(`/api/launch/projects/${pid1}`)).body;
    // A factory build is a real program: its first choice on the Run tab is Start (npm start, no arguments, no files to write).
    const appP = li.profiles?.[0];
    check("the shipped project is an app, and Start is first on the Run tab", appP?.kind === "web" && appP.id === "script:start" && appP.recommended && li.dir === fin1.dir && existsSync(join(fin1.dir, "src", "schema.js")), JSON.stringify({ dir: li.dir, profiles: li.profiles?.map((p) => `${p.id}${p.recommended ? "*" : ""}`) }));
    if (appP?.kind === "web") {
      const as = (await api(`/api/launch/projects/${pid1}/start`, { method: "POST", body: JSON.stringify({ profileId: appP.id }) })).body;
      const up1 = await until("the app prints its address", async () => { const r = (await api(`/api/launch/sessions/${as.id}`)).body; return r.session?.url ? r : null; }, 30_000);
      const base = up1?.session.url ?? "http://127.0.0.1:1/";
      const j = async (path, init) => { try { const r = await fetch(new URL(path, base), init); return { status: r.status, body: await r.json().catch(() => null) }; } catch (e) { return { status: 0, body: String(e) }; } };
      let html = "";
      try { html = await (await fetch(base)).text(); } catch (e) { html = String(e); }
      const db0 = await j("api/_db");
      check("the started app serves its screens and opens with sample data (bundled Node, no arguments)", /<script type="module" src="web\/app.js">/.test(html) && (db0.body?.data?.piece?.length ?? 0) >= 1, JSON.stringify({ url: up1?.session.url, html: html.slice(0, 80), pieces: db0.body?.data?.piece?.length }));
      const made = await j("api/piece", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Smoke piece", text: "one two three", goal: 10, status: "draft" }) });
      const id = made.body?.record?.id;
      const bad = await j("api/piece", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "no title" }) });
      const edited = id ? await j(`api/piece/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal: 20 }) }) : null;
      const gone = id ? await j(`api/piece/${id}`, { method: "DELETE" }) : null;
      const onDisk = existsSync(join(fin1.dir, "data", "db.json"));
      check("full CRUD in the started app: create, validate, edit, delete, kept in data/db.json", made.status === 201 && bad.status === 422 && edited?.body?.record?.goal === 20 && gone?.status === 200 && onDisk, JSON.stringify({ made: made.status, bad: bad.status, edited: edited?.body?.record?.goal, gone: gone?.status, onDisk }));
      await api(`/api/launch/sessions/${as.id}/stop`, { method: "POST", body: "{}" });
    }
    // One Start press for a tool that needs a CSV nobody has: the app makes one from its spec, runs it, and the file can be edited in the app.
    const csvDir = join(OUT, "csv-tool");
    mkdirSync(join(csvDir, "bin"), { recursive: true });
    writeFileSync(join(csvDir, "SPEC.md"), "# Expense summary\n\nSums a CSV of expenses by category. The CSV has the columns date, category, amount.\n\nusage: expenses <file.csv>\n");
    writeFileSync(join(csvDir, "bin", "expenses.js"), `import { readFileSync } from "node:fs";\nconst f = process.argv[2];\nif (!f) { console.error("usage: expenses <file.csv>"); process.exit(2); }\nconst [h, ...rows] = readFileSync(f, "utf8").trim().split(/\\r?\\n/);\nconst c = h.split(","), ci = c.indexOf("category"), ai = c.indexOf("amount"), by = {};\nfor (const r of rows) { const x = r.split(","); by[x[ci]] = (by[x[ci]] ?? 0) + Number(x[ai]); }\nfor (const [k, v] of Object.entries(by)) console.log(k + ": " + v.toFixed(2));\n`);
    const cp2 = (await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "Smoke CSV tool" }) })).body.id;
    await api(`/api/launch/projects/${cp2}/folder`, { method: "POST", body: JSON.stringify({ dir: csvDir }) });
    const g = (await api(`/api/launch/projects/${cp2}/go`, { method: "POST", body: "{}" })).body;
    const gd = g?.session ? await until("the one-press run ends", async () => { const r = (await api(`/api/launch/sessions/${g.session.id}`)).body; return r.session?.state === "exited" ? r : null; }, 30_000) : null;
    const go = (gd?.lines ?? []).filter((l) => l.stream === "out").map((l) => l.text);
    check("one Start press runs a CSV tool on a sample made from its spec (no file, no arguments)", gd?.session.exitCode === 0 && g.made?.[0]?.path === "samples/date-category.csv" && go.some((t) => /^food: \d+\.\d\d$/.test(t)), JSON.stringify({ g: g?.error ?? g?.why, made: g?.made, out: go.slice(0, 3) }));
    await api(`/api/launch/projects/${cp2}/files`, { method: "POST", body: JSON.stringify({ path: "samples/date-category.csv", content: "date,category,amount\n2024-01-01,books,40\n2024-01-02,books,2\n" }) });
    const g2 = (await api(`/api/launch/projects/${cp2}/go`, { method: "POST", body: "{}" })).body;
    const gd2 = g2?.session ? await until("the edited run ends", async () => { const r = (await api(`/api/launch/sessions/${g2.session.id}`)).body; return r.session?.state === "exited" ? r : null; }, 30_000) : null;
    const go2 = (gd2?.lines ?? []).map((l) => l.text);
    check("a sample edited in the app's data editor is what the next Start uses", go2.includes("books: 42.00"), JSON.stringify(go2.slice(-4)));
    const webDir = join(OUT, "web-app");
    mkdirSync(webDir, { recursive: true });
    writeFileSync(join(webDir, "package.json"), JSON.stringify({ name: "smoke-web", type: "module", scripts: { start: "node server.js" } }));
    writeFileSync(join(webDir, "server.js"), `import { createServer } from "node:http";\nconst s = createServer((q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end("<h1>smoke web app</h1>"); });\ns.listen(Number(process.env.PORT), "127.0.0.1", () => console.log("Ready on http://localhost:" + s.address().port + "/"));\n`);
    const wp = (await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "Smoke web app", kind: "app" }) })).body.id;
    await api(`/api/launch/projects/${wp}/folder`, { method: "POST", body: JSON.stringify({ dir: webDir }) });
    const ws = (await api(`/api/launch/projects/${wp}/start`, { method: "POST", body: "{}" })).body;
    const up = await until("the web app prints its address", async () => { const r = (await api(`/api/launch/sessions/${ws.id}`)).body; return r.session?.url ? r : null; }, 30_000);
    let page = "";
    try { page = await (await fetch(up?.session.url ?? "http://127.0.0.1:1/")).text(); } catch (e) { page = String(e); }
    check("a web app starts from its npm script and its page is served for the preview", ws.profileId === "script:start" && page.includes("smoke web app"), JSON.stringify({ profile: ws.profileId, url: up?.session.url, page: page.slice(0, 80) }));
    await api(`/api/launch/sessions/${ws.id}/stop`, { method: "POST", body: "{}" });
    const stopped = await until("the web app stops", async () => { const r = (await api(`/api/launch/sessions/${ws.id}`)).body; return r.session?.state === "stopped" ? r : null; }, 15_000);
    let gone = false;
    try { await fetch(up?.session.url ?? "http://127.0.0.1:1/", { signal: AbortSignal.timeout(3000) }); } catch { gone = true; }
    check("Stop ends the web app and everything it started (port closed)", stopped && gone, JSON.stringify({ state: stopped?.session.state, portClosed: gone }));
  } catch (e) {
    check("running projects from the app", false, (e && e.message) || String(e));
  }

  // ---------- 4c. add the shipped project into SoftwareFactory as a tool, and use it ----------
  try {
    const owner = (await api(`/api/projects/of?kind=factory_run&ref=${run1}`)).body.projectId;
    // A factory app joins SoftwareFactory as a panel (its screens), not as a command-line tool.
    const asked = await api("/api/integrations", { method: "POST", body: JSON.stringify({ projectId: owner, form: "panel" }) });
    const approved = asked.status === 201 ? await api(`/api/integrations/${asked.body.id}/decide`, { method: "POST", body: JSON.stringify({ approve: true }) }) : asked;
    check("a shipped project is added as a feature after approval", approved.body?.status === "installed" && existsSync(approved.body.dir ?? ""), JSON.stringify(approved.body).slice(0, 300));
    let shown = "";
    try { shown = await (await fetch(`http://127.0.0.1:4317/ext/${asked.body.id}/web/kit/shell.js`)).text(); } catch (e) { shown = String(e); }
    check("the installed feature's screens are served inside SoftwareFactory", shown.includes("startApp"), shown.slice(0, 120));
  } catch (e) {
    check("a shipped project is added as a feature after approval", false, e.message);
  }

  // ---------- 4d. plugins: the bundled example installs, turns on, and its locked-down backend answers ----------
  try {
    const list = (await api("/api/plugins")).body;
    check("the bundled example plugin ships with the app", list.examples?.some((x) => x.id === "run-stats"), JSON.stringify(list.examples ?? list).slice(0, 300));
    await api("/api/plugins/install", { method: "POST", body: JSON.stringify({ example: "run-stats" }) });
    const on = await api("/api/plugins/run-stats/enable", { method: "POST", body: "{}" });
    const called = await api("/api/plugins/run-stats/call", { method: "POST", body: JSON.stringify({ method: "totals" }) });
    check("a plugin's backend runs in its own process on the bundled Node.js and answers", on.body?.status === "enabled" && typeof called.body?.value?.shipped === "number", JSON.stringify({ on: on.body?.status, err: on.body?.error, called: called.body }).slice(0, 300));
    await api("/api/plugins/run-stats/remove", { method: "POST", body: "{}" });
  } catch (e) {
    check("plugins work in the installed app", false, e.message);
  }

  // ---------- 5. Data vault ----------
  const vault = (await api("/api/store")).body;
  const broken = vault.database.projections.filter((p) => p.error || p.behind > 0);
  check("every organized table is healthy and current", broken.length === 0, broken.map((p) => `${p.name}: ${p.error ?? `${p.behind} behind`}`).join("; ") || `${vault.database.projections.length} projections`);
  const proj = vault.files.projects.find((p) => p.run === run1);
  check("the run's files are on disk and tracked", proj?.onDisk && proj.tracked > 0 && proj.missing.length === 0, JSON.stringify(proj));
  const rebuilt = await api("/api/store/rebuild", { method: "POST", body: "{}" });
  check("Rebuild from log works", rebuilt.status === 200 && rebuilt.body.database.projections.every((p) => !p.error), `status ${rebuilt.status}`);

  // ---------- 6. kill mid-run, start again, resume ----------
  const start2 = await api("/api/factory/runs", { method: "POST", body: JSON.stringify({ idea: "a CLI that counts words, second copy", autoApprove: true }) });
  const run2 = start2.body.run;
  const cutAt = await until("run 2 to reach the tests or build station", async () => {
    const r = (await api(`/api/factory/runs/${run2}`)).body;
    return r.station && ["tests", "build"].includes(r.station.station) && r.station.state === "active" ? r.station.station : null;
  }, 120_000, 100);
  must("run 2 got going", cutAt, cutAt ? `cut at ${cutAt}` : "never reached tests/build");
  const k = kill(app.child.pid, true);
  log("killed the app at", cutAt, k.stdout.trim());
  const killedDown = await waitDown(20_000);
  check("the app and its core stop when killed", killedDown, killedDown ? "" : "the core still answers after taskkill /T /F");
  saveLogs("killed");
  launch(exe, "installed-again");
  const again = await until("the core to answer again", health, 120_000, 1000);
  must("the app starts again", again, again ? "" : readTail(join(DATA, "core.log")));
  await waitBridge(60_000);
  const fin2 = await waitRun(run2, 240_000);
  saveLogs("resumed");
  screenshot("3-run-resumed");
  check(`the interrupted run resumed (cut at ${cutAt}) and shipped`, fin2?.outcome === "shipped" && fin2.resumes >= 1, JSON.stringify({ outcome: fin2?.outcome, resumes: fin2?.resumes, from: fin2?.resumed_from, reason: fin2?.reason }));

  // ---------- 7. a normal close takes the core with it ----------
  const pid = app.child.pid;
  const corePid = (await health())?.pid;
  const closed = ps(`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { [void]$p.CloseMainWindow(); 'sent' } else { 'gone' }`);
  log("asked the window to close:", closed.stdout.trim(), closed.stderr.trim());
  const appGone = await until("the app to exit", async () => !alive(pid), 30_000, 300);
  check("closing the window exits the app", appGone, appGone ? "" : `app pid ${pid} still running`);
  const down = await waitDown(15_000);
  check("closing the window stops the core", down, down ? "" : `core pid ${corePid} still answers${alive(corePid) ? " (process alive)" : ""}`);
  if (!down) { kill(pid, true); if (corePid) kill(corePid, true); await waitDown(10_000); }
  saveLogs("closed");

  // ---------- 7b. the shell killed alone (crash, Task Manager): the core must not linger ----------
  launch(exe, "installed-orphan-check");
  const h3 = await until("the core to answer", health, 120_000, 1000);
  if (h3) {
    spawnSync("taskkill", ["/PID", String(app.child.pid), "/F"]);
    const gone = await waitDown(15_000);
    check("the core exits when the app is killed alone (no orphan on port 4317)", gone, gone ? "" : `core pid ${h3.pid} ${alive(h3.pid) ? "still running" : "gone but port busy"}`);
    if (!gone && h3.pid) { spawnSync("taskkill", ["/PID", String(h3.pid), "/F"]); await waitDown(10_000); }
  }

  // ---------- 8. portable zip ----------
  if (args.portable) {
    const zip = resolve(args.portable);
    const dir = join(OUT, `portable-${STAMP}`);
    const x = ps(`Expand-Archive -Force -Path '${zip}' -DestinationPath '${dir}'`);
    must("portable zip unpacks", x.status === 0, x.stderr);
    const pexe = join(dir, "SoftwareFactory", "SoftwareFactory.exe");
    must("portable exe present", existsSync(pexe), pexe);
    launch(pexe, "portable");
    const ph = await until("the portable core to answer", health, 120_000, 1000);
    check("the portable app's core answers", ph?.ok, ph ? "" : readTail(join(DATA, "core.log")));
    const pst = ph ? (await api("/api/store")).body.database : null;
    check("the portable app reopens the same database without another upgrade", pst && pst.schemaVersion === pst.latestSchema && pst.backups.length === backups, `${pst?.backups.length} backups, was ${backups}`);
    check("the portable Bridge window reached the core", await waitBridge(60_000), "");
    screenshot("4-portable");
    ps(`$p = Get-Process -Id ${app.child.pid} -ErrorAction SilentlyContinue; if ($p) { [void]$p.CloseMainWindow() }`);
    const pdown = await waitDown(30_000);
    check("closing the portable app stops its core", pdown, pdown ? "" : "the core outlived the window");
    kill(app.child.pid, true);
    await waitDown(10_000);
    saveLogs("portable");
  }
}

// ---------- 9. in-app update from an older installed version ----------
async function updatePhase() {
  const oldInstaller = resolve(args["old-installer"]);
  const newInstaller = resolve(args.installer ?? "out/SoftwareFactory-setup.exe");
  const NEW = args.version;
  must("an older build to update from exists", existsSync(oldInstaller), oldInstaller);
  must("the test signature for this build exists", existsSync(args["update-sig"] ?? ""), args["update-sig"]);
  must("this build's version is known", /^\d+\.\d+\.\d+$/.test(NEW ?? ""), NEW);

  // The update server the old build was built to ask: http://127.0.0.1:4399. It behaves like GitHub
  // for a private repo: the manifest and the installer answer only with the read token (404 without),
  // the installer only for Accept: application/octet-stream, and it is served from another host by
  // redirect, where the token must not follow (GitHub's file storage refuses requests that carry it).
  const TOKEN = "smoke-test-read-token";
  const hits = [];
  const refused = [];
  const manifest = {
    version: NEW, notes: "Smoke test update", pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    platforms: { "windows-x86_64": { signature: readFileSync(args["update-sig"], "utf8").trim(), url: "http://127.0.0.1:4399/repos/x/y/releases/assets/1" } },
  };
  const server = createServer((req, res) => {
    const path = req.url?.split("?")[0];
    hits.push(path);
    const auth = req.headers.authorization ?? "";
    log("update server:", req.method, req.url, `host=${req.headers.host}`, auth ? "with token" : "no token", `accept=${req.headers.accept}`);
    const deny = (why) => { refused.push(`${path}: ${why}`); res.writeHead(404); res.end(); };
    if (path === "/latest.json") {
      if (auth !== `Bearer ${TOKEN}`) return deny("no token");
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(manifest));
    }
    if (path === "/repos/x/y/releases/assets/1") {
      if (auth !== `Bearer ${TOKEN}`) return deny("no token");
      if (req.headers.accept !== "application/octet-stream") return deny(`accept ${req.headers.accept}`);
      res.writeHead(302, { location: "http://localhost:4399/storage/SoftwareFactory-setup.exe" });
      return res.end();
    }
    if (path === "/storage/SoftwareFactory-setup.exe") {
      if (auth) { refused.push(`${path}: the token followed the redirect`); res.writeHead(400); return res.end(); }
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": statSync(newInstaller).size });
      return createReadStream(newInstaller).pipe(res);
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(4399, "127.0.0.1", r));
  let exeName = "softwarefactory.exe";
  try {
    const inst = spawnSync(oldInstaller, ["/S"], { encoding: "utf8", timeout: 300_000 });
    check("the older version (0.0.1) installs over this one", inst.status === 0, `status ${inst.status}`);
    const installDir = [join(process.env.LOCALAPPDATA ?? "", "SoftwareFactory"), join(process.env.ProgramFiles ?? "C:\\Program Files", "SoftwareFactory")].find((d) => findExe(d));
    const exe = findExe(installDir);
    exeName = basename(exe);
    // The read token, as Systems > Updates saves it (the repo may be private).
    writeFileSync(join(DATA, "updater-token"), TOKEN);
    launch(exe, "old-version");
    const h = await until("the old version's core", health, 120_000, 1000);
    must("the old version runs", h?.appVersion === "0.0.1", h ? `appVersion ${h.appVersion}` : readTail(join(DATA, "core.log")));
    const oldCore = h.pid;
    const marker = `A note written on 0.0.1, before the update (${Date.now()})`;
    const sig = await api("/api/signals", { method: "POST", body: JSON.stringify({ text: marker, source: "bridge" }) });
    check("a note is saved on the old version", sig.status === 201, JSON.stringify(sig.body).slice(0, 200));
    screenshot("5-old-version");
    // A Node process left running from the app's own node.exe (an orphaned plugin or app
    // server) locks the file. The installer must stop it rather than fail with
    // "Error opening file for writing: ...\\node\\node.exe".
    const stray = spawn(join(installDir, "node", "node.exe"), ["-e", "setInterval(() => {}, 1e9)"], { detached: true, stdio: "ignore", windowsHide: true });
    stray.unref();
    await sleep(1_000);
    check("a stray process holds the bundled node.exe before the update", alive(stray.pid), `pid ${stray.pid}`);

    // The Bridge checks 5 s after opening, finds NEW, counts down 15 s (factory idle), then installs.
    const found = await until("the old version to ask for updates", async () => hits.some((u) => u.startsWith("/latest.json")), 90_000, 500);
    check("the old version looked for an update by itself, with its read token", found && !refused.some((r) => r.startsWith("/latest.json")), `requests: ${hits.join(", ") || "none"}; refused: ${refused.join("; ") || "none"}`);
    await sleep(8_000);
    screenshot("6-update-countdown");
    const fetched = await until("the old version to download this build", async () => hits.includes("/storage/SoftwareFactory-setup.exe"), 90_000, 500);
    check("it downloaded the new installer after the idle countdown, the way a private GitHub release serves it", fetched && refused.length === 0, `requests: ${hits.join(", ")}; refused: ${refused.join("; ") || "none"}`);
    const oldGone = await until("the old app to hand over", async () => !alive(app.child.pid), 90_000, 500);
    check("the old app closed itself to install", oldGone, oldGone ? "" : `pid ${app.child.pid} still running`);
    check("the old core stopped before the installer ran", !alive(oldCore), `core pid ${oldCore}`);
    screenshot("7-installing");

    // The installer replaces the app and starts the new version by itself.
    const back = await until(`the app to come back as v${NEW}`, async () => { const x = await health(); return x?.appVersion === NEW ? x : null; }, 240_000, 1000);
    saveLogs("updated");
    check(`the app restarted by itself as v${NEW}`, back, back ? `core pid ${back.pid}` : `health now: ${JSON.stringify(await health())?.slice(0, 200)}`);
    if (!back) { launch(findExe(installDir), "after-update"); await until("the updated core", health, 120_000, 1000); }
    const after = await health();
    check(`the installed app is now v${NEW}`, after?.appVersion === NEW, `appVersion ${after?.appVersion}`);
    check("the installer stopped the stray node.exe instead of failing on the locked file", !alive(stray.pid), `pid ${stray.pid}`);
    await waitBridge(60_000);
    screenshot("8-updated");
    const notes = (await api("/api/signals")).body;
    check("the note written before the update is still there", Array.isArray(notes) && notes.some((n) => (n.text ?? n.payload?.text) === marker), `${Array.isArray(notes) ? notes.length : "?"} notes`);
    const ups = (await api("/api/updates")).body;
    check("the update is in the version history", ups?.history?.[0]?.from === "0.0.1" && ups.history[0].to === NEW, JSON.stringify(ups?.history?.slice(0, 2)));
    const st2 = (await api("/api/store")).body.database;
    check("the database is healthy after the update", st2.schemaVersion === st2.latestSchema && st2.projections.every((p) => !p.error), `${st2.schemaVersion} of ${st2.latestSchema}`);
  } finally {
    server.close();
    // The updated app was started by the installer, not by this script: stop it by name.
    spawnSync("taskkill", ["/IM", exeName, "/T", "/F"]);
    await waitDown(15_000);
  }
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function readTail(p) {
  try { return readFileSync(p, "utf8").slice(-1500); } catch { return `(no ${p})`; }
}

function report() {
  const failed = results.filter((r) => !r.ok);
  const lines = [
    `## Windows smoke test: ${fatal || failed.length ? "FAILED" : "passed"}`,
    "",
    `${results.length - failed.length} of ${results.length} checks passed${fatal ? `; stopped early: ${fatal}` : ""}.`,
    "",
    ...(blips.length ? [`⚠️ ${blips.length} connection blip(s) to the core, each passed on one retry:`, "", ...blips.map((b) => `- ${b}`), ""] : []),
    "| | Check | Detail |",
    "|---|---|---|",
    ...results.map((r) => `| ${r.ok ? "✅" : "❌"} | ${r.name} | ${r.detail.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 300)} |`),
    "",
  ];
  writeFileSync(join(OUT, "report.md"), lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  return failed.length === 0 && !fatal;
}

/** After a fatal error: say in the job log whether the core is alive, answering, listening and what it last printed. */
async function diagnose() {
  try {
    log("diagnosis: core pid", launchedCorePid ?? "unknown", launchedCorePid ? (alive(launchedCorePid) ? "is alive" : "is GONE") : "");
    let h = null;
    try { h = await (await fetch(API + "/api/health")).json(); } catch (e) { h = `no answer: ${why(e)}`; }
    log("diagnosis: /api/health now:", typeof h === "string" ? h : JSON.stringify(h).slice(0, 400));
    const ns = spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" });
    const lines = (ns.stdout ?? "").split(/\r?\n/).filter((l) => l.includes(":4317"));
    const states = lines.reduce((m, l) => { const st = l.trim().split(/\s+/)[3] ?? "?"; m[st] = (m[st] ?? 0) + 1; return m; }, {});
    log("diagnosis: sockets on :4317 by state", JSON.stringify(states));
    for (const f of ["core.log", "core.prev.log"]) {
      const p = join(DATA, f);
      if (existsSync(p)) log(`diagnosis: last lines of ${f}:\n` + readFileSync(p, "utf8").split(/\r?\n/).slice(-30).join("\n"));
    }
  } catch (e) {
    log("diagnosis failed:", e.message);
  }
}

try {
  await main();
  if (args["old-installer"]) await updatePhase();
} catch (e) {
  fatal = e.message;
  log("FATAL", e.stack ?? e.message);
  await diagnose();
} finally {
  if (app?.child?.pid) kill(app.child.pid, true);
  saveLogs("final");
  process.exitCode = report() ? 0 : 1;
}
