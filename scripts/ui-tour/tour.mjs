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
  for (const [h, n] of [["#/features", "features"], ["#/plugins", "plugins"], ["#/brain", "brain"], ["#/bases", "bases"], ["#/factory", "factory-floor"], ["#/factory/bay", "agent-bay"], ["#/factory/order", "order"], ["#/factory/improve", "improve"], ["#/factory/data", "data-vault"], ["#/_kit", "kit"]]) await visit(h, n);
  current = "systems";
  await page.goto(`${BRIDGE}/#/`);
  await page.waitForTimeout(800);
  const sys = page.getByRole("button", { name: "Systems" }).first();
  if (await sys.count()) { await sys.click(); await page.waitForTimeout(600); await page.screenshot({ path: join(out, "systems.png") }); shots.push("systems"); }
  else problems.push("systems: no Systems button found");
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
