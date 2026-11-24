import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { detectProfiles, type RunProfile } from "../launch/detect.js";
import { findLocalUrl, freePort, killTree, projectEnv } from "../launch/launcher.js";
import { serveStatic } from "../launch/static.js";
import { withPathFirst } from "../runtime.js";
import type { ScreenText } from "./evaluate.js";
import { dumpScreen, findBrowser, pageText } from "./screencheck.js";
import type { TestCase, TestRun } from "./workspace.js";

/**
 * What the engine needs to work in a codebase it did not write (factory/reporun.ts): how its own tests
 * run, what has to be installed first, how its site starts, and what its pages show.
 *
 * An app the factory builds is always the same shape (Node.js, node --test, server.js), so the engine
 * could hard-code all of that. An imported repo is whatever its owner made: this module looks at the
 * folder and answers for Node.js and Python, the two stacks of Assaf's repos. Anything else gets "no
 * tests SoftwareFactory can run here", said plainly on the run, never a silent pass.
 *
 * Everything SoftwareFactory adds to the clone lives under `.sf/`, which git is told to leave out: the
 * Python environment, the plan and the feature list never reach the branch.
 */

/** SoftwareFactory's own folder inside a clone. */
export const SF_DIR = ".sf";

export interface TestCommand {
  label: string; file: string; args: string[]; shell?: boolean;
  /** go: `go test`; check: a command whose exit code is the result (a build, `go vet`). */
  kind: "pytest" | "unittest" | "npm" | "go" | "check";
  /** The folder it runs in, relative to the repo (a Go module or a Node package in a subfolder). Absent: the repo. */
  cwd?: string;
}

export interface RepoEnv {
  /** node, python, static... as the Run tab reads the folder. */
  stack: string[];
  /** The repo's own test commands. Empty when it has no tests SoftwareFactory knows how to run. */
  tests: TestCommand[];
  /** Folders put first on the PATH for its tests, its site and the agents' shell (its Python environment). */
  pathFirst: string[];
  /** Shell commands the agents may run here besides the usual ones. */
  commands: string[];
  /** What could not be set up, in plain words: shown on the run. */
  notes: string[];
  /** What one would type to run the tests, for the agents. */
  testHint: string;
}

const trim = (s: string, n = 3000) => (s.length > n ? `…${s.slice(-n)}` : s);
const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

/** Python test files in the repo, a few levels deep, never in SoftwareFactory's folder, an environment or packages. */
export function pythonTestFiles(dir: string, max = 200): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    if (out.length >= max || depth > 4) return;
    let names: string[] = [];
    try { names = readdirSync(join(dir, rel)); } catch { return; }
    for (const n of names) {
      if (n.startsWith(".") || n === "node_modules" || n === "venv" || n === "env" || n === "__pycache__" || n === "site-packages") continue;
      const p = rel ? `${rel}/${n}` : n;
      let st; try { st = statSync(join(dir, p)); } catch { continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (/^test_.*\.py$|_test\.py$/.test(n)) out.push(p);
    }
  };
  walk("", 0);
  return out;
}

/**
 * Code that lives in a subfolder of its own: a Go module (go.mod) or a Node package (package.json) one level
 * down, such as RoadToMill's backend/ (Go) and web/ (React). The repo root and npm workspaces are handled
 * elsewhere, so they are left out. Before this, an import of such a repo found "no known stack" and ran
 * Python's unittest on a stray script (RoadToMill, 24 Nov 2026).
 */
export function subPackages(dir: string): { go: string[]; node: string[] } {
  const out = { go: [] as string[], node: [] as string[] };
  const ws = new Set(workspaceDirs(dir));
  let names: string[] = [];
  try { names = readdirSync(dir).sort(); } catch { return out; }
  for (const n of names) {
    if (n.startsWith(".") || n === "node_modules" || n === SF_DIR || ws.has(n)) continue;
    let st; try { st = statSync(join(dir, n)); } catch { continue; }
    if (!st.isDirectory()) continue;
    if (isFile(join(dir, n, "go.mod"))) out.go.push(n);
    if (isFile(join(dir, n, "package.json"))) out.node.push(n);
  }
  return out;
}

function hasGo(): boolean {
  try { return spawnSync("go", ["version"], { encoding: "utf8", windowsHide: true, timeout: 10_000 }).status === 0; } catch { return false; }
}

/** Run one command to its end without holding up the core (an install can take minutes; the app must stay alive meanwhile). */
function sh(file: string, args: string[], o: { cwd: string; shell?: boolean; timeoutMs: number }): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    let child: ReturnType<typeof spawn>;
    try { child = spawn(file, args, { cwd: o.cwd, shell: !!o.shell, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: projectEnv(o.cwd, process.execPath, null) }); }
    catch (e) { return resolve({ status: 1, out: (e as Error).message }); }
    const timer = setTimeout(() => { out += `\n(stopped after ${Math.round(o.timeoutMs / 1000)} s)`; killTree(child, true); }, o.timeoutMs);
    child.stdout!.on("data", (x) => { out += x; });
    child.stderr!.on("data", (x) => { out += x; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ status: 1, out: `${out}\n${e.message}` }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ status: code, out }); });
  });
}

/** A Python that runs on this computer: `python3`, `python`, or the Windows launcher. Null when there is none. */
export function findPython(run = spawnSync): { file: string; args: string[] } | null {
  for (const [file, args] of [["python3", []], ["python", []], ["py", ["-3"]]] as [string, string[]][]) {
    try {
      const r = run(file, [...args, "--version"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
      if (r.status === 0 && /Python 3/.test(`${r.stdout}${r.stderr}`)) return { file, args };
    } catch { /* not this one */ }
  }
  return null;
}

/**
 * Look at a clone and get it ready to be worked in: install what its tests need (Node packages from the
 * lock file; Python packages into an environment under .sf/), and say how its tests run. Slow the first
 * time (an install), instant after. Nothing here changes a file git tracks.
 */
export async function prepareEnv(dir: string, o: { install?: boolean; platform?: NodeJS.Platform } = {}): Promise<RepoEnv> {
  const install = o.install !== false;
  const platform = o.platform ?? process.platform;
  const d = detectProfiles(dir);
  const env: RepoEnv = { stack: d.stack, tests: [], pathFirst: [], commands: [], notes: [], testHint: "" };

  // ---- Node.js ----
  const pkgText = read(join(dir, "package.json"));
  if (pkgText) {
    let pkg: Record<string, any> = {};
    try { pkg = JSON.parse(pkgText); } catch { env.notes.push("package.json does not parse"); }
    const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
    if (deps.length && !existsSync(join(dir, "node_modules"))) {
      if (!install) env.notes.push("its Node packages are not installed");
      else if (!existsSync(join(dir, "package-lock.json"))) env.notes.push("its Node packages are not installed and there is no package-lock.json to install them from exactly");
      else {
        const i = await sh("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dir, shell: true, timeoutMs: 600_000 });
        if (i.status !== 0) env.notes.push(`npm ci failed: ${trim(i.out, 400)}`);
      }
    }
    const test = String(pkg.scripts?.test ?? "");
    if (test && !/no test specified/.test(test)) env.tests.push({ label: "npm test", file: "npm", args: ["test", "--silent"], shell: true, kind: "npm" });
  }

  // ---- Python ----
  const reqs = ["requirements.txt", "requirements-dev.txt", "requirements_dev.txt", "dev-requirements.txt"].filter((f) => isFile(join(dir, f)));
  const pyFiles = pythonTestFiles(dir);
  const isPython = d.stack.includes("python") || reqs.length > 0 || pyFiles.length > 0;
  if (isPython) {
    const bin = join(dir, SF_DIR, "venv", platform === "win32" ? "Scripts" : "bin");
    const venvPy = join(bin, platform === "win32" ? "python.exe" : "python");
    const sys = findPython();
    if (!existsSync(venvPy) && install && sys) {
      const mk = await sh(sys.file, [...sys.args, "-m", "venv", join(dir, SF_DIR, "venv")], { cwd: dir, timeoutMs: 180_000 });
      if (mk.status !== 0) env.notes.push(`could not make a Python environment: ${trim(mk.out, 300)}`);
      else for (const f of reqs) {
        const i = await sh(venvPy, ["-m", "pip", "install", "-q", "--disable-pip-version-check", "-r", f], { cwd: dir, timeoutMs: 900_000 });
        if (i.status !== 0) env.notes.push(`pip install -r ${f} failed: ${trim(i.out, 400)}`);
      }
    }
    const py = existsSync(venvPy) ? venvPy : null;
    if (!py) env.notes.push(sys ? "its Python packages are not installed" : "there is no Python 3 on this computer, so its Python code cannot run here");
    else env.pathFirst.push(bin);
    env.commands.push("python", "python3", "pytest", "flask", "pip list", "pip show");
    if (pyFiles.length && py) {
      const wantsPytest = isFile(join(dir, "pytest.ini")) || isFile(join(dir, "conftest.py")) || /pytest/.test(reqs.map((f) => read(join(dir, f))).join("\n") + read(join(dir, "pyproject.toml")) + read(join(dir, "setup.cfg")) + read(join(dir, "tox.ini")))
        || pyFiles.slice(0, 40).some((f) => /^\s*(import pytest|from pytest)\b|@pytest\./m.test(read(join(dir, f))));
      let hasPytest = (await sh(py, ["-m", "pytest", "--version"], { cwd: dir, timeoutMs: 30_000 })).status === 0;
      if (wantsPytest && !hasPytest && install) {
        // Into SoftwareFactory's own environment under .sf/, never into the repo's files.
        hasPytest = (await sh(py, ["-m", "pip", "install", "-q", "--disable-pip-version-check", "pytest"], { cwd: dir, timeoutMs: 300_000 })).status === 0;
        if (!hasPytest) env.notes.push("its tests use pytest, which could not be installed");
      }
      if (hasPytest) env.tests.push({ label: "pytest", file: py, args: ["-m", "pytest", "-q", "-rA", "--tb=short", "-p", "no:cacheprovider"], kind: "pytest" });
      else if (!wantsPytest) env.tests.push({ label: "python -m unittest", file: py, args: ["-m", "unittest", "discover", "-v"], kind: "unittest" });
    }
  }
  // ---- Go modules and Node packages: at the root (Go) and one folder down (both) ----
  const subs = subPackages(dir);
  const goRoots = [...(isFile(join(dir, "go.mod")) ? [""] : []), ...subs.go];
  if (goRoots.length) {
    if (!env.stack.includes("go")) env.stack.push("go");
    if (!hasGo()) env.notes.push("there is no Go on this computer, so its Go code cannot be built or tested here");
    else {
      env.commands.push("go", "gofmt");
      for (const g of goRoots) {
        const where = g ? ` (${g})` : "";
        env.tests.push({ label: `go vet${where}`, file: "go", args: ["vet", "./..."], kind: "check", ...(g ? { cwd: g } : {}) });
        env.tests.push({ label: `go test${where}`, file: "go", args: ["test", "./..."], kind: "go", ...(g ? { cwd: g } : {}) });
      }
    }
  }
  for (const n of subs.node) {
    let pkg: Record<string, any> = {};
    try { pkg = JSON.parse(read(join(dir, n, "package.json"))); } catch { env.notes.push(`${n}/package.json does not parse`); continue; }
    if (!env.stack.includes("node")) env.stack.push("node");
    const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
    if (deps.length && !existsSync(join(dir, n, "node_modules"))) {
      if (!install) env.notes.push(`the Node packages of ${n}/ are not installed`);
      else if (!existsSync(join(dir, n, "package-lock.json"))) env.notes.push(`the Node packages of ${n}/ are not installed and it has no package-lock.json`);
      else {
        const i = await sh("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: join(dir, n), shell: true, timeoutMs: 600_000 });
        if (i.status !== 0) env.notes.push(`npm ci in ${n}/ failed: ${trim(i.out, 400)}`);
      }
    }
    const test = String(pkg.scripts?.test ?? "");
    // Its own tests when it has them; else its build, which type-checks a TypeScript app (RoadToMill's web/).
    if (test && !/no test specified/.test(test)) env.tests.push({ label: `npm test (${n})`, file: "npm", args: ["test", "--silent"], shell: true, kind: "npm", cwd: n });
    else if (pkg.scripts?.build) env.tests.push({ label: `npm run build (${n})`, file: "npm", args: ["run", "build"], shell: true, kind: "check", cwd: n });
    if (!env.commands.includes("npm")) env.commands.push("npm");
  }

  const hint = (t: TestCommand) => {
    const base = t.kind === "npm" ? "npm test" : t.kind === "pytest" ? "python -m pytest -q" : t.kind === "unittest" ? "python -m unittest discover" : `${t.file} ${t.args.join(" ")}`;
    return t.cwd ? `${base} (in ${t.cwd}/)` : base;
  };
  env.testHint = env.tests.map(hint).join(" and ");
  return env;
}

/** The cases a test command's output names, best effort: pytest -rA, unittest -v, TAP, and the tick lists of vitest, jest and mocha. */
export function parseCases(output: string, kind: TestCommand["kind"]): TestCase[] {
  const out: TestCase[] = [];
  const seen = new Set<string>();
  const add = (name: string, file: string, pass: boolean, error?: string) => {
    const key = `${file}::${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, file, pass, durationMs: 0, ...(error ? { error } : {}) });
  };
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(/\u001b\[[0-9;]*m/g, "");
    let m: RegExpMatchArray | null;
    if (kind === "check") continue;
    if (kind === "go") {
      // Without -v: "ok  	pkg	0.1s" per package that passed, "--- FAIL: TestX (0.00s)" per failing test, "FAIL	pkg" per package.
      if ((m = line.match(/^ok\s+(\S+)/))) add(m[1], m[1], true);
      else if ((m = line.match(/^\s*--- FAIL: (\S+)/))) add(m[1], "", false, "failed");
      else if ((m = line.match(/^FAIL\s+(\S+)\s/))) add(`${m[1]} (package)`, m[1], false, "failed");
      continue;
    }
    if (kind === "pytest") {
      if ((m = line.match(/^(PASSED|FAILED|ERROR)\s+(\S+?)(?:::(\S.*?))?(?:\s+-\s+(.*))?$/))) add(m[3] ?? m[2], m[2], m[1] === "PASSED", m[1] === "PASSED" ? undefined : (m[4] ?? m[1].toLowerCase()).slice(0, 1200));
    } else if (kind === "unittest") {
      // "test_home (tests.test_app.AppTest.test_home) ... ok" since Python 3.11; before that the brackets hold only the class.
      if ((m = line.match(/^(\w+) \(([\w.]+)\)(?: .*?)? \.\.\. (ok|FAIL|ERROR|skipped.*|expected failure)$/))) add(m[1], m[2].endsWith(`.${m[1]}`) ? m[2].slice(0, -m[1].length - 1) : m[2], !/^(FAIL|ERROR)$/.test(m[3]), /^(FAIL|ERROR)$/.test(m[3]) ? m[3].toLowerCase() : undefined);
    } else {
      if ((m = line.match(/^\s*(not ok|ok)\s+\d+\s*-?\s*(.+?)(?:\s+#\s*(.*))?$/))) { if (!/^(SKIP|TODO)/i.test(m[3] ?? "")) add(m[2].trim(), "", m[1] === "ok"); }
      else if ((m = line.match(/^\s*(✓|✔|√)\s+(.+?)(?:\s+\(?\d+(?:\.\d+)?\s*m?s\)?)?\s*$/))) add(m[2].trim(), "", true);
      else if ((m = line.match(/^\s*(×|✕|✗|✖)\s+(.+?)(?:\s+\(?\d+(?:\.\d+)?\s*m?s\)?)?\s*$/))) add(m[2].trim(), "", false, "failed");
      else if ((m = line.match(/^\s*FAIL\s+(\S+)\s+>\s+(.+)$/))) add(m[2].trim(), m[1], false, "failed");
    }
  }
  return out;
}

/** Run the repo's own tests, every command of them. With none, an empty run (no cases): the caller says so. */
export async function runRepoTests(dir: string, env: Pick<RepoEnv, "tests" | "pathFirst">, timeoutMs = 600_000): Promise<TestRun> {
  const all: TestRun = { cases: [], passed: 0, failed: 0, exitCode: 0, timedOut: false, output: "" };
  for (const t of env.tests) {
    const r = await new Promise<{ code: number | null; out: string; timedOut: boolean }>((resolve) => {
      const child = spawn(t.file, t.args, { cwd: t.cwd ? join(dir, t.cwd) : dir, shell: !!t.shell, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...withPathFirst(projectEnv(dir, process.execPath, null), env.pathFirst), CI: "1" } });
      let out = "";
      let timedOut = false;
      child.stdout.on("data", (x) => { out += x; });
      child.stderr.on("data", (x) => { out += x; });
      const timer = setTimeout(() => { timedOut = true; killTree(child, true); }, timeoutMs);
      child.on("error", (e) => { clearTimeout(timer); resolve({ code: 1, out: `${out}\n${e.message}`, timedOut }); });
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, timedOut }); });
    });
    const cases = parseCases(r.out, t.kind);
    // A run that failed without naming a failing test (it did not start, a file did not load) is one failing cell.
    if (r.code !== 0 && !cases.some((c) => !c.pass)) cases.push({ name: `${t.label} ${r.timedOut ? "did not finish in time" : `ended with an error (exit ${r.code})`}`, file: "", pass: false, durationMs: 0, error: trim(r.out, 1500) });
    if (r.code === 0 && !cases.length) cases.push({ name: `${t.label} passes`, file: "", pass: true, durationMs: 0 });
    all.cases.push(...cases);
    all.output += `$ ${t.label}\n${trim(r.out, 4000)}\n`;
    if (r.code !== 0) all.exitCode = r.code ?? 1;
    all.timedOut ||= r.timedOut;
  }
  all.passed = all.cases.filter((c) => c.pass).length;
  all.failed = all.cases.length - all.passed;
  all.output = trim(all.output, 6000);
  return all;
}

/** The way the Run tab would start this folder's site, if it has one: a web program first, else plain pages. */
export function siteProfile(dir: string): RunProfile | null {
  const pick = (d: string) => { const p = detectProfiles(d).profiles.filter((x) => !x.utility); return p.find((x) => x.kind === "web") ?? p.find((x) => x.kind === "static") ?? null; };
  const own = pick(dir);
  if (own?.kind === "web") return own;
  // A monorepo whose site is one of its workspaces (SoftwareFactory's own apps/bridge): run 9398's product judge
  // found "no site" at the top, so every screen criterion was left to code reading.
  for (const ws of [...workspaceDirs(dir), ...subPackages(dir).node]) {
    const p = pick(join(dir, ws));
    if (p?.kind === "web") return { ...p, cwd: ws, command: `${p.command} (in ${ws})` };
  }
  return own;
}

/** The workspace folders package.json names, with "dir/*" expanded one level. */
export function workspaceDirs(dir: string): string[] {
  let globs: unknown = [];
  try { const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")); globs = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages ?? []; } catch { return []; }
  const out: string[] = [];
  for (const g of (Array.isArray(globs) ? globs : []).map(String)) {
    if (g.includes("..")) continue;
    const m = g.match(/^(.*?)\/\*$/);
    if (!m) { if (existsSync(join(dir, g, "package.json"))) out.push(g); continue; }
    try { for (const n of readdirSync(join(dir, m[1])).sort()) if (existsSync(join(dir, m[1], n, "package.json"))) out.push(`${m[1]}/${n}`); } catch { /* no such folder */ }
  }
  return out;
}

/**
 * The backend a front end in a subfolder needs: its dev server proxies to a local port (vite's `proxy:
 * { '/api': 'http://127.0.0.1:8787' }`), and a Go program in the repo names that port. RoadToMill's web/ is
 * such a front end; started alone, every page said "RoadToMill did not answer (500)" to the product judge
 * (run 10486). Null when the site does not proxy, or no program in the repo names the port.
 */
export function backendFor(home: string, site: Pick<RunProfile, "cwd">): { port: number; cwd: string; file: string; args: string[]; label: string; addrFlag: boolean } | null {
  if (!site.cwd) return null;
  const conf = ["vite.config.ts", "vite.config.js", "vite.config.mts", "vite.config.mjs"].map((f) => read(join(home, site.cwd!, f))).find(Boolean) ?? "";
  const m = conf.match(/['"`]https?:\/\/(?:127\.0\.0\.1|localhost):(\d{2,5})/);
  if (!m) return null;
  const port = Number(m[1]);
  const goRoots = [...(isFile(join(home, "go.mod")) ? [""] : []), ...subPackages(home).go];
  for (const g of goRoots) {
    let mains: string[] = [];
    try { mains = readdirSync(join(home, g, "cmd")).sort(); } catch { continue; }
    for (const name of mains) {
      const src = (() => { try { return readdirSync(join(home, g, "cmd", name)).filter((f) => f.endsWith(".go") && !f.endsWith("_test.go")).map((f) => read(join(home, g, "cmd", name, f))).join("\n"); } catch { return ""; } })();
      if (new RegExp(`[:"']${port}\\b`).test(src)) return { port, cwd: g, file: "go", args: ["run", `./cmd/${name}`], label: `go run ./cmd/${name}${g ? ` (in ${g})` : ""}`, addrFlag: /flag\.String\(\s*"addr"/.test(src) };
    }
  }
  return null;
}

/** Whether something answers on a local port. */
async function answers(port: number): Promise<boolean> {
  try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) }); return true; } catch { return false; }
}

/**
 * Start the codebase's site the way the Run tab would, call `during` with its address, then stop it and
 * everything it started. Returns why it could not be started, or what `during` returned.
 */
export async function withSite<T>(dir: string, o: { pathFirst?: string[]; timeoutMs?: number }, during: (baseUrl: string) => Promise<T>): Promise<T | { skipped: string }> {
  const profile = siteProfile(dir);
  if (!profile) return { skipped: "this codebase has no site SoftwareFactory knows how to start (no web program or pages found)" };
  if (profile.kind === "static") {
    const root = join(dir, profile.root ?? "");
    const server = createServer((req, res) => serveStatic(res, root, new URL(req.url ?? "/", "http://x").pathname, req.method));
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    try { return await during(`http://127.0.0.1:${(server.address() as { port: number }).port}`); }
    finally { server.close(); }
  }
  const port = await freePort();
  const home = dir;
  // The site's own backend first, when its front end proxies to one (RoadToMill: web/ to backend/cmd/roadtomill).
  const back = backendFor(home, profile);
  let backChild: ReturnType<typeof spawn> | null = null;
  if (back) {
    // Its own copy on its own port, never an app already running on this PC (the owner's own RoadToMill on 8787):
    // a program with an -addr flag gets a free port; one without it is judged only when its port is free.
    if (!back.addrFlag && (await answers(back.port))) return { skipped: `port ${back.port}, where the site's backend "${back.label}" listens, is taken by another program on this computer (maybe the app you run yourself), so this copy cannot be started and judged` };
    const own = back.addrFlag ? await freePort() : back.port;
    // A backend often serves or embeds the front end's build and refuses to start without it (RoadToMill:
    // "web app not built"), so the front end is built first when it can be.
    try {
      const pkg = JSON.parse(read(join(home, profile.cwd!, "package.json")) || "{}");
      if (pkg.scripts?.build) await sh("npm", ["run", "build"], { cwd: join(home, profile.cwd!), shell: true, timeoutMs: 300_000 });
    } catch { /* no package.json to read: start the backend as it is */ }
    // It runs in the clone, so data it finds "from this folder upward" is the clone's own copy, not the owner's.
    backChild = spawn(back.file, [...back.args, ...(back.addrFlag ? ["-addr", `127.0.0.1:${own}`] : [])], { cwd: join(home, back.cwd), env: withPathFirst(projectEnv(home, process.execPath, null), o.pathFirst ?? []), stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    let backOut = "";
    backChild.stdout!.on("data", (x) => { backOut += x; });
    backChild.stderr!.on("data", (x) => { backOut += x; });
    // A first `go run` compiles: give it time, and stop waiting as soon as it answers or exits.
    let exited: number | null | undefined;
    backChild.on("exit", (c) => { exited = c; });
    const until = Date.now() + Math.max(o.timeoutMs ?? 40_000, 180_000);
    while (Date.now() < until && exited === undefined && !(await answers(own))) await new Promise((r) => setTimeout(r, 1000));
    if (exited !== undefined || !(await answers(own))) {
      killTree(backChild, true);
      return { skipped: `the site's backend "${back.label}" did not answer on port ${own}${exited !== undefined ? ` (exit ${exited})` : ""}: ${trim(backOut.trim(), 400)}` };
    }
    if (own !== back.port) {
      // On a port of its own the dev server's proxy cannot reach it, so the backend must serve the pages itself.
      const html = await fetch(`http://127.0.0.1:${own}/`, { signal: AbortSignal.timeout(5000) }).then((r) => /html/i.test(r.headers.get("content-type") ?? "")).catch(() => false);
      try {
        if (!html) return { skipped: `the site's backend "${back.label}" runs on its own port ${own} but serves no pages there, and its dev server only reaches port ${back.port}` };
        return await during(`http://127.0.0.1:${own}`);
      } catch (e) {
        return { skipped: `the site could not be started here: ${(e as Error).message}` };
      } finally { killTree(backChild, true); }
    }
  }
  dir = join(dir, profile.cwd ?? "");
  const env = { ...withPathFirst(projectEnv(home, process.execPath, port), [...(o.pathFirst ?? []), ...(profile.cwd ? [join(dir, "node_modules", ".bin")] : [])]), FLASK_RUN_PORT: String(port), FLASK_DEBUG: "0" };
  const exec = withDeclaredArgs(dir, profile.exec!);
  const child = "shell" in exec
    ? spawn(exec.shell, { cwd: dir, shell: true, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" })
    : spawn(exec.file === "node" ? process.execPath : ownPython(exec.file, o.pathFirst), exec.args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
  let out = "";
  try {
    const url = await new Promise<string>((res, rej) => {
      const limit = o.timeoutMs ?? 40_000;
      const t = setTimeout(() => rej(new Error(`"${profile.command}" printed no local address within ${limit / 1000} s`)), limit);
      const look = (x: Buffer) => { out += x; for (const l of String(x).split(/\r?\n/)) { const u = findLocalUrl(l); if (u) { clearTimeout(t); res(u.replace(/\/+$/, "")); } } };
      child.stdout!.on("data", look);
      child.stderr!.on("data", look);
      child.on("error", (e) => { clearTimeout(t); rej(e); });
      child.on("exit", (code) => { clearTimeout(t); rej(new Error(`"${profile.command}" stopped (exit ${code}): ${trim(out.trim(), 400)}`)); });
    });
    // It printed its address; give it a moment to answer on it.
    for (let i = 0; i < 20; i++) { try { await fetch(url, { signal: AbortSignal.timeout(2000) }); break; } catch { await new Promise((r) => setTimeout(r, 300)); } }
    return await during(url);
  } catch (e) {
    return { skipped: `the site could not be started here: ${(e as Error).message}` };
  } finally {
    killTree(child, true);
    if (backChild) killTree(backChild, true);
  }
}

/**
 * The arguments the repo itself starts its program with. A Dockerfile's CMD or a Procfile's web line that runs
 * the same script with more arguments ("python app.py 0") is how its authors start it, and a program that
 * reads sys.argv stops without them.
 */
export function declaredArgs(dir: string, script: string): string[] {
  const lines: string[][] = [];
  const split = (x: string) => x.trim().split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ""));
  try {
    const docker = readFileSync(join(dir, "Dockerfile"), "utf8").replace(/\\\r?\n/g, " ");
    for (const m of docker.matchAll(/^\s*(?:CMD|ENTRYPOINT)\s+(.+)$/gim)) {
      const body = m[1].trim();
      if (body.startsWith("[")) { try { lines.push((JSON.parse(body) as unknown[]).map(String)); } catch { /* not JSON form */ } }
      else lines.push(split(body));
    }
  } catch { /* no Dockerfile */ }
  try { for (const m of readFileSync(join(dir, "Procfile"), "utf8").matchAll(/^web:\s*(.+)$/gim)) lines.push(split(m[1])); } catch { /* no Procfile */ }
  const same = (t: string) => t.replace(/^\.\//, "").replace(/\\/g, "/") === script.replace(/^\.\//, "").replace(/\\/g, "/");
  for (const l of lines.reverse()) {
    if (!/^(python[\d.]*|py|node)(\.exe)?$/i.test(l[0] ?? "")) continue;
    const at = l.findIndex(same);
    const rest = at > 0 ? l.slice(at + 1) : [];
    if (rest.length && rest.length <= 8 && rest.every((a) => /^[\w@%+=:,./-]+$/.test(a))) return rest;
  }
  return [];
}

function withDeclaredArgs(dir: string, exec: NonNullable<RunProfile["exec"]>): NonNullable<RunProfile["exec"]> {
  if ("shell" in exec) return exec;
  const script = exec.args.filter((a) => !a.startsWith("-"));
  if (script.length !== 1 || exec.args[exec.args.length - 1] !== script[0]) return exec;
  return { ...exec, args: [...exec.args, ...declaredArgs(dir, script[0])] };
}

/** The codebase's own Python (its environment under .sf/) when the command asks for Python, else the command as it is. */
function ownPython(file: string, pathFirst: string[] = []): string {
  if (!/^(python3?|py)(\.exe)?$/i.test(file)) return file;
  for (const d of pathFirst) for (const n of ["python.exe", "python"]) if (isFile(join(d, n))) return join(d, n);
  return file;
}

/** Same-site pages a page links to, as paths. */
export function linkedPaths(html: string, max = 12): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*\bhref=["']([^"'#?]+)[^"']*["']/gi)) {
    const h = m[1].trim();
    if (!h || /^(https?:|mailto:|tel:|javascript:|\/\/)/i.test(h)) continue;
    if (/\.(png|jpe?g|gif|svg|webp|ico|css|js|pdf|zip|xml|json|txt|mp4|woff2?)$/i.test(h)) continue;
    const p = `/${h.replace(/^\.?\//, "")}`.replace(/\/+$/, "") || "/";
    if (p !== "/") out.add(p);
    if (out.size >= max) break;
  }
  return [...out];
}

/**
 * What the pages of a running site show, as a person would read them: the home page and the pages it links
 * to. Each is read in a real browser when the computer has one (so a page drawn by scripts is read as
 * drawn); otherwise its HTML is fetched, which is right for pages a server renders.
 */
export async function readPages(baseUrl: string, o: { browser?: string | null; max?: number; extra?: string[] } = {}): Promise<ScreenText[]> {
  const browser = o.browser === undefined ? findBrowser() : o.browser;
  const get = async (path: string): Promise<string> => {
    const url = `${baseUrl}${path}`;
    if (browser) { const d = await dumpScreen(browser, url); if (d.dom.trim()) return d.dom; }
    try { const r = await fetch(url, { signal: AbortSignal.timeout(15_000) }); return r.ok && /html/.test(r.headers.get("content-type") ?? "") ? await r.text() : ""; } catch { return ""; }
  };
  const home = await get("/");
  if (!home.trim()) return [];
  const out: ScreenText[] = [{ route: "", ...pageText(home) }];
  const paths = [...new Set([...(o.extra ?? []).map((p) => `/${p.replace(/^\/+/, "")}`), ...linkedPaths(home)])].filter((p) => p !== "/");
  for (const p of paths.slice(0, (o.max ?? 8) - 1)) {
    const html = await get(p);
    if (html.trim()) out.push({ route: p.replace(/^\//, ""), ...pageText(html) });
  }
  return out;
}

/** The whole look at a codebase's site, for the product judge: start it, read its pages, stop it. */
export async function readSite(dir: string, o: { pathFirst?: string[]; extra?: string[] } = {}): Promise<{ screens: ScreenText[] } | { skipped: string }> {
  if (process.env.SF_SCREEN_CHECK === "off") return { skipped: "the screen check is off" };
  const r = await withSite(dir, o, async (url) => readPages(url, { extra: o.extra }));
  if (!Array.isArray(r)) return r;
  return r.length ? { screens: r } : { skipped: "the site started but its home page gave nothing to read" };
}
