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
//   5. checks the Data vault report (tables healthy, files tracked)
//   6. kills the app mid-run, starts it again, and expects the run to resume
//      from its last completed station and ship
//   7. closes the app normally and expects the core to exit with it
//   8. unpacks the portable zip and checks it starts too
//
// Usage (Windows):
//   node scripts/smoke/windows-smoke.mjs --installer out/SoftwareFactory-setup.exe --portable out/SoftwareFactory-portable.zip --out smoke-out
//
// Writes smoke-out/report.md (also appended to the job summary), core logs and screenshots.

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]?.startsWith("--") ? "1" : all[i + 1] ?? "1"]] : acc), []));
const OUT = resolve(args.out ?? "smoke-out");
const API = "http://127.0.0.1:4317";
const IDENT = "dev.plonter.softwarefactory";
const DATA = join(process.env.APPDATA ?? join(process.env.HOME ?? ".", ".config"), IDENT);
const APP_ENV = { ...process.env, SF_RUNTIME: "mock", SF_MOCK_DELAY_MS: args.delay ?? "400", SF_DROP: join(OUT, "drop") };
mkdirSync(OUT, { recursive: true });

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

async function api(path, init) {
  const r = await fetch(API + path, { ...init, headers: { "content-type": "application/json" } });
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
  while (Date.now() - t0 < timeoutMs) {
    try { last = await fn(); if (last) return last; } catch (e) { last = null; }
    await sleep(everyMs);
  }
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
  rmSync(DATA, { recursive: true, force: true });
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

  // ---------- 4b. add the shipped project into SoftwareFactory as a tool, and use it ----------
  try {
    const owner = (await api(`/api/projects/of?kind=factory_run&ref=${run1}`)).body.projectId;
    const asked = await api("/api/integrations", { method: "POST", body: JSON.stringify({ projectId: owner, form: "tool" }) });
    const approved = asked.status === 201 ? await api(`/api/integrations/${asked.body.id}/decide`, { method: "POST", body: JSON.stringify({ approve: true }) }) : asked;
    check("a shipped project is added as a feature after approval", approved.body?.status === "installed" && existsSync(approved.body.dir ?? ""), JSON.stringify(approved.body).slice(0, 300));
    const used = await api(`/api/integrations/${asked.body.id}/run`, { method: "POST", body: JSON.stringify({ args: "", stdin: "one two three" }) });
    check("the installed feature runs on the bundled Node.js", used.body?.exitCode === 0 && /3/.test(used.body.stdout ?? ""), JSON.stringify(used.body).slice(0, 300));
  } catch (e) {
    check("a shipped project is added as a feature after approval", false, e.message);
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
  if (!down) { kill(pid, true); spawnSync("taskkill", ["/IM", "node.exe", "/F"]); await waitDown(10_000); }
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
    const dir = join(OUT, "portable");
    rmSync(dir, { recursive: true, force: true });
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

try {
  await main();
} catch (e) {
  fatal = e.message;
  log("FATAL", e.stack ?? e.message);
} finally {
  if (app?.child?.pid) kill(app.child.pid, true);
  saveLogs("final");
  process.exitCode = report() ? 0 : 1;
}
