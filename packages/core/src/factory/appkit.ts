import { spawn, spawnSync } from "node:child_process";
import { killTree } from "../launch/launcher.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { KIT_FILES } from "./kitFiles.js";
import { checkUi, type UiCheck } from "./uicheck.js";

/**
 * The app kit and the app check: how the Brain's principles "real-programs",
 * "crud-and-visibility" and "no-raw-data" are held in code.
 *
 * installKit writes the kit (packages/core/kit/) into a project: the server that starts with
 * no arguments and keeps data in data/db.json, the data core, the store and the frame that gives
 * every entity full CRUD and the app a System view. It runs before the build and before every
 * test round, so a kit file an agent changed is put back.
 *
 * checkApp proves, without a browser and for free, that the build is a real program:
 *   - the page check (index.html and every module it loads exist and parse, nothing from the internet)
 *   - it starts with one press: package.json "start" runs server.js, and nothing reads command-line arguments
 *   - src/schema.js loads, its schema is valid, every entity has sample records that pass its own rules
 *   - create, edit and delete work on every entity (on a copy of the sample data, in memory)
 *   - the page starts the app with the kit and the schema, and never asks the person to type JSON
 */
export const KIT_PATHS = Object.keys(KIT_FILES);

export const isKitFile = (p: string) => KIT_PATHS.includes(p);

/** Write the kit into the project; make package.json start the app and keep its data out of git. Returns kit files it had to put back. */
export function installKit(dir: string): string[] {
  const restored: string[] = [];
  for (const [p, content] of Object.entries(KIT_FILES)) {
    const abs = join(dir, p);
    const cur = existsSync(abs) ? readFileSync(abs, "utf8") : null;
    if (cur === content) continue;
    if (cur !== null) restored.push(p);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  const pkgPath = join(dir, "package.json");
  let pkg: Record<string, any> = {};
  try { pkg = JSON.parse(readFileSync(pkgPath, "utf8")); } catch { /* missing or broken: rebuilt below */ }
  const scripts = { ...(pkg.scripts ?? {}) };
  let changed = false;
  if (scripts.start !== "node server.js") { scripts.start = "node server.js"; changed = true; }
  if (!scripts.test) { scripts.test = "node --test"; changed = true; }
  if (pkg.type !== "module") { pkg.type = "module"; changed = true; }
  if (changed || !existsSync(pkgPath)) writeFileSync(pkgPath, JSON.stringify({ name: pkg.name ?? "app", ...pkg, scripts }, null, 2) + "\n");
  const ignore = join(dir, ".gitignore");
  const cur = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  const want = ["data/", "node_modules/"].filter((l) => !cur.split(/\r?\n/).includes(l));
  if (want.length) writeFileSync(ignore, (cur && !cur.endsWith("\n") ? cur + "\n" : cur) + want.join("\n") + "\n");
  return restored;
}

export interface AppCheck extends UiCheck {
  /** Entities with their record counts after seeding, and what CRUD proved. */
  entities: { name: string; seeds: number; crud: boolean }[];
}

/** The probe that runs in a child Node (the project's own code never runs inside the core). */
const PROBE = `
const [schemaUrl, dbUrl] = JSON.parse(process.env.SF_PROBE);
const out = { problems: [], entities: [] };
try {
  const schema = await import(schemaUrl);
  const k = await import(dbUrl);
  const bad = k.checkSchema(schema);
  if (bad.length) out.problems.push(...bad.map((b) => "src/schema.js: " + b));
  else {
    if (!schema.app || !schema.app.name) out.problems.push("src/schema.js exports no app with a name (export const app = { name, slug, tagline, summary })");
    const db = k.seedDb(schema);
    for (const e of schema.entities) {
      const row = { name: e.name, seeds: db.data[e.name].length, crud: false };
      out.entities.push(row);
      if (!row.seeds) { out.problems.push(e.name + " has no sample records: the app must open with realistic data in it (seed)"); continue; }
      for (const r of db.data[e.name]) {
        const errs = k.validate(schema, e.name, r, db);
        if (Object.keys(errs).length) { out.problems.push("a sample " + e.name + " breaks its own rules: " + Object.entries(errs).map(([f, m]) => f + " " + m).join(", ")); break; }
      }
      try {
        const copy = JSON.parse(JSON.stringify(db.data[e.name][0]));
        delete copy.id; delete copy.createdAt; delete copy.updatedAt;
        const made = k.createRecord(schema, db, e.name, copy);
        const f = e.fields.find((x) => (x.type || "text") === "text" || x.type === "longtext");
        k.updateRecord(schema, db, e.name, made.id, f ? { [f.name]: String(made[f.name] || "x") + " (edited)" } : {});
        for (const c of e.computed || []) { try { c.value(made, db); } catch (err) { out.problems.push(e.name + " computed value " + c.name + " throws: " + err.message); } }
        k.deleteRecord(schema, db, e.name, made.id);
        row.crud = true;
      } catch (err) { out.problems.push("create, edit or delete of a " + e.name + " fails: " + err.message); }
    }
    if (schema.flows !== undefined && !Array.isArray(schema.flows)) out.problems.push("src/schema.js flows must be a list");
  }
} catch (err) { out.problems.push("src/schema.js does not load in Node: " + (err && err.message || err)); }
console.log(JSON.stringify(out));
`;

export function checkApp(dir: string): AppCheck {
  const ui = checkUi(dir);
  const problems = [...ui.problems];
  const notes = [...ui.notes];
  const entities: AppCheck["entities"] = [];
  const read = (p: string) => { try { return readFileSync(join(dir, p), "utf8"); } catch { return null; } };

  // One press to start: npm start runs the kit's server; nothing reads arguments.
  let pkg: Record<string, any> | null = null;
  try { pkg = JSON.parse(read("package.json") ?? ""); } catch { problems.push("package.json is missing or is not valid JSON"); }
  if (pkg && pkg.scripts?.start !== "node server.js") problems.push(`package.json "start" must be "node server.js" (the app starts with one press, no arguments)`);
  for (const p of ["server.js", "api.js"]) {
    const s = read(p);
    if (s && /process\.argv/.test(s)) problems.push(`${p} reads command-line arguments: the app must start with no arguments`);
  }
  for (const p of KIT_PATHS) if (!existsSync(join(dir, p))) problems.push(`the app kit file ${p} is missing`);

  // The page starts the app on the kit, with the schema.
  const html = read("index.html") ?? "";
  if (html && !/web\/kit\/kit\.css/.test(html)) notes.push("index.html does not load web/kit/kit.css: the kit's screens will look unstyled");
  const appJs = read("web/app.js");
  if (appJs == null) problems.push("web/app.js is missing: it starts the app (startApp from ./kit/shell.js with ../src/schema.js)");
  else {
    if (!/startApp\s*\(/.test(appJs) || !/kit\/shell\.js/.test(appJs)) problems.push("web/app.js does not start the app with startApp from ./kit/shell.js: the entities would have no screens");
    if (!/src\/schema\.js/.test(appJs)) problems.push("web/app.js does not import ../src/schema.js");
  }
  // Never make the person type JSON.
  for (const f of ui.files.filter((x) => /\.(m|c)?js$/.test(x) && !isKitFile(x))) {
    const s = read(f) ?? "";
    if (/JSON\.parse\(\s*[\w$.[\]]*\.(value|textContent|innerText)\b/.test(s)) problems.push(`${f} parses JSON the person typed into a text box: give them a form instead`);
  }
  if (/placeholder\s*=\s*["'][^"']*[{[]\s*&quot;|placeholder\s*=\s*'[^']*\{\s*"/i.test(html)) problems.push("index.html asks the person to type JSON (a placeholder shows a JSON example)");

  // The model: load it in a child Node and run create, edit and delete on every entity.
  if (!existsSync(join(dir, "src", "schema.js"))) problems.push("src/schema.js is missing: the app's model (entities with fields and sample records, flows, features)");
  else if (existsSync(join(dir, "web", "kit", "db.js"))) {
    const args = JSON.stringify([pathToFileURL(join(dir, "src", "schema.js")).href, pathToFileURL(join(dir, "web", "kit", "db.js")).href]);
    const env = appEnv(dir, { SF_PROBE: args });
    const r = spawnSync(process.execPath, ["--input-type=module", "-"], { cwd: dir, input: PROBE, env, encoding: "utf8", timeout: 20_000, windowsHide: true });
    const line = (r.stdout ?? "").trim().split("\n").filter((l) => l.startsWith("{")).at(-1);
    if (!line) problems.push(`src/schema.js could not be checked: ${(r.stderr || r.error?.message || `exit ${r.status}`).toString().slice(0, 400)}`);
    else {
      const j = JSON.parse(line) as { problems: string[]; entities: AppCheck["entities"] };
      problems.push(...j.problems);
      entities.push(...j.entities);
    }
  }
  return { ...ui, pass: problems.length === 0, problems, notes, entities };
}

/** A scrubbed environment for the project's own code: no keys or tokens leak in. */
function appEnv(dir: string, extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", HOME: dir, NODE_ENV: "test", ...extra };
  if (process.platform === "win32") for (const k of ["SystemRoot", "SystemDrive", "windir", "TEMP", "TMP", "PATHEXT", "ComSpec"]) if (process.env[k]) env[k] = process.env[k];
  return env;
}

/**
 * Start the app the way the Run tab's Start does (node server.js, no arguments), on a free port
 * and a scratch data folder, and ask it for its page and its data. Problems, as sentences.
 */
export async function probeStart(dir: string, timeoutMs = 15_000, during?: (baseUrl: string) => Promise<string[]>): Promise<string[]> {
  if (!existsSync(join(dir, "server.js"))) return ["server.js is missing"];
  const data = mkdtempSync(join(tmpdir(), "sf-appcheck-"));
  const child = spawn(process.execPath, ["server.js"], { cwd: dir, env: appEnv(dir, { PORT: "0", APP_DATA_DIR: data }), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  try {
    const port = await new Promise<number>((res, rej) => {
      const t = setTimeout(() => rej(new Error(`it did not say "Ready on http://localhost:<port>/" within ${timeoutMs / 1000} s`)), timeoutMs);
      const look = () => { const m = out.match(/Ready on http:\/\/localhost:(\d+)/); if (m) { clearTimeout(t); res(Number(m[1])); } };
      child.stdout.on("data", look);
      child.on("exit", (code) => { clearTimeout(t); rej(new Error(`it stopped (exit ${code}): ${(err || out).trim().slice(0, 600)}`)); });
    });
    const problems: string[] = [];
    const get = async (path: string) => { const r = await fetch(`http://127.0.0.1:${port}${path}`); return { status: r.status, type: r.headers.get("content-type") ?? "", text: await r.text() }; };
    const page = await get("/");
    if (page.status !== 200 || !/html/.test(page.type)) problems.push(`the started app does not serve its page at / (status ${page.status})`);
    const db = await get("/api/_db");
    if (db.status !== 200) problems.push(`the started app does not serve its data at /api/_db (status ${db.status})`);
    else {
      const j = JSON.parse(db.text) as { data?: Record<string, unknown[]> };
      if (!j.data || !Object.values(j.data).some((l) => Array.isArray(l) && l.length)) problems.push("the started app has no sample data");
    }
    // More checks against the running app (the screens in a real browser), while it is up.
    if (during && !problems.length) problems.push(...await during(`http://127.0.0.1:${port}`));
    return problems;
  } catch (e) {
    return [`the app does not start with npm start: ${(e as Error).message}`];
  } finally {
    killTree(child, true);
    try { rmSync(data, { recursive: true, force: true }); } catch { /* the OS cleans tmp */ }
  }
}

/** The whole app check: what checkApp reads, then the app actually started once. */
export async function checkAppLive(dir: string, during?: (baseUrl: string) => Promise<string[]>): Promise<AppCheck> {
  const a = checkApp(dir);
  // Starting it only makes sense when the files it needs are there.
  if (!a.problems.some((p) => /server\.js|src\/schema\.js|kit file/.test(p))) {
    const started = await probeStart(dir, 15_000, during);
    a.problems.push(...started);
    a.pass = a.problems.length === 0;
  }
  return a;
}

/** The check as one cell in the test grid, the way the loop shows and fixes it. */
export function appCase(a: AppCheck) {
  const crud = a.entities.filter((e) => e.crud).length;
  return {
    name: `the app works: starts with one press, full CRUD on ${a.entities.length ? `${crud} of ${a.entities.length} entities` : "its entities"}, no raw data to type`,
    file: "src/schema.js",
    pass: a.pass,
    error: a.pass ? undefined : a.problems.slice(0, 10).join("\n"),
    durationMs: 0,
  };
}
