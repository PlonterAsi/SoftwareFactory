#!/usr/bin/env node
// UI tour: the safety net for Bridge redesign work (docs/ui-tour.md).
// Starts a throwaway core (practice crew, temp database) and the Bridge dev server, makes one
// shipped build and one build waiting at the plan approval, then opens every page and every
// project panel, takes a screenshot of each and checks that it rendered: no console errors,
// no uncaught exceptions, and visible text in the page. Run it before and after a visual change
// and compare the two folders (contact-sheet.html puts them side by side).
//
//   npm run ui:tour                     screenshots into ui-tour-out/<timestamp>
//   npm run ui:tour -- --out before     into ui-tour-out/before
//
// Needs Playwright with Chromium (require("playwright")) and Git. Never touches your own data:
// the core runs on a new temp folder that is removed afterwards.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../..");
const argOut = process.argv.indexOf("--out");
const outName = argOut > 0 ? process.argv[argOut + 1] : new Date().toISOString().replace(/[:.]/g, "-");
const out = resolve(root, "ui-tour-out", outName);
mkdirSync(out, { recursive: true });

const CORE = "http://127.0.0.1:4317";
const BRIDGE = "http://localhost:5173";
const data = mkdtempSync(join(tmpdir(), "sf-ui-tour-"));
const kids = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(cmd, args, cwd, env = {}) {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  p.stdout.on("data", (d) => (log += d));
  p.stderr.on("data", (d) => (log += d));
  kids.push({ p, log: () => log });
  return p;
}

async function waitFor(url, what) {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch {}
    await sleep(500);
  }
  throw new Error(`${what} did not start on ${url}`);
}

const api = async (path, body) => {
  const r = await fetch(CORE + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  return r.json();
};

async function waitForGate(run, gate) {
  for (let i = 0; i < 120; i++) {
    const r = await fetch(`${CORE}/api/factory/runs/${run}/gate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gate, approve: true }) });
    if (r.ok) return;
    await sleep(500);
  }
  throw new Error(`run ${run} never reached ${gate}`);
}

const problems = [];
try {
  start(process.execPath, [require.resolve("tsx/cli"), "src/server.ts"], join(root, "packages/core"), { SF_DB: join(data, "factory.db"), SF_PORT: "4317", SF_RUNTIME: "mock", SF_AUTO_RESUME: "0", SF_DROP: join(data, "drop") });
  start(process.execPath, [[join(root, "apps/bridge/node_modules/vite/bin/vite.js"), join(root, "node_modules/vite/bin/vite.js")].find((f) => existsSync(f)), "--strictPort"], join(root, "apps/bridge"));
  await waitFor(CORE + "/api/health", "The core");
  await waitFor(BRIDGE, "The Bridge dev server");

  // Some life in the app: notes, one shipped build, one waiting at the plan approval.
  for (const text of ["Recipe box where I can tag recipes", "Rule: every app must have dark mode"]) await api("/api/signals", { text });
  const shipped = (await api("/api/factory/runs", { idea: "A word counter app with history of past counts" })).run;
  await waitForGate(shipped, "gateA");
  await waitForGate(shipped, "gateB");
  // The same idea built a second time: two engine cycles to lay side by side.
  const again = (await api("/api/factory/runs", { idea: "A word counter app with history of past counts", again: true })).run;
  await waitForGate(again, "gateA");
  await waitForGate(again, "gateB");
  const waiting = (await api("/api/factory/runs", { idea: "Habit tracker with streaks and a weekly heatmap" })).run;
  await sleep(4000);

  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let current = "";
  page.on("console", (m) => { if (m.type() === "error") problems.push(`${current}: console error: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`${current}: uncaught: ${e.message}`));

  const shots = [];
  const visit = async (hash, name) => {
    current = name;
    await page.goto(`${BRIDGE}/${hash}`);
    await page.waitForTimeout(1200);
    const text = (await page.locator("#root").innerText()).trim();
    if (text.length < 40) problems.push(`${name}: the page looks empty (${text.length} characters of text)`);
    await page.screenshot({ path: join(out, `${name}.png`) });
    shots.push(name);
  };

  await visit("#/", "home");
  const projects = await api("/api/projects");
  for (const p of (Array.isArray(projects) ? projects : projects.projects ?? [])) {
    if (p.id !== shipped && p.id !== waiting) continue;
    const tag = p.id === shipped ? "shipped" : "waiting";
    await visit(`#/p/${p.id}`, `${tag}`);
    const panels = await page.$$eval('a[href^="#/p/"]', (as) => [...new Set(as.map((a) => a.getAttribute("href")))]);
    for (const h of panels.filter((h) => h.split("/").length === 4)) await visit(h, `${tag}-${h.split("/")[3]}`);
  }
  for (const [h, n] of [["#/features", "features"], ["#/plugins", "plugins"], ["#/brain", "brain"], ["#/bases", "bases"], ["#/bridge", "factory-bridge"], ["#/bridge/score", "factory-bridge-score"], ["#/bridge/quarter", "factory-bridge-quarter"], ["#/factory", "all-builds"], ["#/factory/bay", "agents"], ["#/factory/tickets", "tickets"], ["#/factory/order", "rules-and-ideas"], ["#/factory/improve", "improve"], ["#/factory/cycles", "engine-cycles"], ["#/factory/data", "data-vault"], ["#/_kit", "kit"]]) await visit(h, n);
  // A run's Engine tab: the factory's review of its own work (the shipped build has one).
  current = "run-engine";
  await page.goto(`${BRIDGE}/#/factory`);
  await page.waitForTimeout(1000);
  // The floor opens on the newest build (the one waiting); the review is on the one that shipped.
  for (const sel of await page.locator("select").all()) {
    const done = await sel.locator("option").evaluateAll((os) => os.find((o) => /shipped/.test(o.textContent ?? ""))?.value ?? null);
    if (done) { await sel.selectOption(done); await page.waitForTimeout(600); break; }
  }
  const engineTab = page.getByRole("tab", { name: /^Engine/ }).first();
  if (await engineTab.count()) { await engineTab.click(); await page.waitForTimeout(400); await page.screenshot({ path: join(out, "run-engine.png") }); shots.push("run-engine"); }
  else problems.push("all-builds: the run deck has no Engine tab");
  // The Factory Bridge's Signal Loom: tapping the waiting lane opens its approval bar.
  current = "factory-bridge-gate";
  await page.goto(`${BRIDGE}/#/bridge`);
  await page.waitForTimeout(1000);
  const lane = page.locator(".loom-lane.wait").first();
  if (await lane.count()) { await lane.click(); await page.waitForTimeout(400); if (await page.locator(".loom-gate").count()) { await page.screenshot({ path: join(out, "factory-bridge-gate.png") }); shots.push("factory-bridge-gate"); } else problems.push("factory-bridge: tapping the waiting lane did not open its approval bar"); }
  else problems.push("factory-bridge: no waiting lane on the Signal Loom");
  current = "systems";
  await page.goto(`${BRIDGE}/#/`);
  await page.waitForTimeout(800);
  const sys = page.getByRole("button", { name: "Systems" }).first();
  if (await sys.count()) { await sys.click(); await page.waitForTimeout(600); await page.screenshot({ path: join(out, "systems.png") }); shots.push("systems"); }
  else problems.push("systems: no Systems button found");
  // Needs you, the helm and the keys (reload first so the Systems drawer is closed).
  await page.reload();
  await visit("#/needs", "needs");
  const waitingProject = (await api(`/api/projects/of?kind=factory_run&ref=${waiting}`)).projectId;
  if (waitingProject != null) await visit(`#/p/${waitingProject}/runs`, "waiting-runs");
  current = "helm";
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(400);
  await page.keyboard.type("habit");
  await page.waitForTimeout(300);
  if (await page.locator(".helm").count()) { await page.screenshot({ path: join(out, "helm.png") }); shots.push("helm"); }
  else problems.push("helm: Ctrl K did not open the helm");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  current = "keys";
  await page.keyboard.press("?");
  await page.waitForTimeout(300);
  if (await page.locator(".keys").count()) { await page.screenshot({ path: join(out, "keys.png") }); shots.push("keys"); }
  else problems.push("keys: ? did not open the shortcut list");
  await page.keyboard.press("Escape");
  await page.keyboard.press("g");
  await page.keyboard.press("n");
  await page.waitForTimeout(300);
  if (!page.url().endsWith("#/needs")) problems.push(`keys: g n went to ${page.url()}, not Needs you`);
  await page.keyboard.press("Control+j");
  await page.waitForTimeout(400);
  if (await page.locator(".s2-assist").count()) problems.push("Ctrl J did not hide the Assistant");
  await visit("#/needs", "needs-no-assistant");
  await browser.close();

  writeFileSync(join(out, "contact-sheet.html"), `<!doctype html><meta charset="utf-8"><title>UI tour ${outName}</title><style>body{background:#111;color:#ddd;font:14px system-ui;margin:20px}div{display:grid;grid-template-columns:repeat(auto-fill,minmax(480px,1fr));gap:16px}img{width:100%;border:1px solid #333}</style><h1>UI tour ${outName}</h1><p>${problems.length ? problems.length + " problems, see problems.txt" : "No problems found"}</p><div>${shots.map((s) => `<figure><img src="${s}.png"><figcaption>${s}</figcaption></figure>`).join("")}</div>`);
  writeFileSync(join(out, "problems.txt"), problems.join("\n") + "\n");
  console.log(`${shots.length} screens in ${out}`);
} catch (e) {
  problems.push(`tour stopped: ${e.message}`);
  for (const k of kids) console.error(k.log().slice(-2000));
} finally {
  for (const k of kids) { try { process.platform === "win32" ? spawn("taskkill", ["/pid", String(k.p.pid), "/t", "/f"]) : k.p.kill(); } catch {} }
  await sleep(500);
  try { rmSync(data, { recursive: true, force: true }); } catch {}
}
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log("No problems found");
