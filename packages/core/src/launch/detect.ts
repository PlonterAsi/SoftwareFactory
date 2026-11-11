import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * How a finished project can be run, found by looking at its folder.
 *
 *   web      a program that serves pages; the Bridge shows them in a preview frame once it prints its address
 *   static   plain pages (an index.html); the core serves the folder itself, nothing to start
 *   cli      a command-line tool; takes arguments and typed input, its output shows in the console
 *   program  anything else that runs: a script, its tests, a build
 *
 * Nothing here runs anything; `Launcher` does.
 */
export type ProfileKind = "web" | "static" | "cli" | "program";

export type Exec =
  /** Start a file directly (no shell). "node" means the Node.js the core runs on, so no install is needed. */
  | { file: string; args: string[] }
  /** A command line for the system shell (package.json scripts, cargo run, ...). */
  | { shell: string };

export interface RunProfile {
  /** Stable within a folder, for example "script:dev", "bin:wc", "static:dist". */
  id: string;
  kind: ProfileKind;
  label: string;
  /** What you would type in a terminal in the project folder. */
  command: string;
  exec?: Exec;
  /** For static: the folder to serve, relative to the project folder ("" is the folder itself). */
  root?: string;
  /** An arguments box is shown. */
  args: boolean;
  /** The one Start presses by default. */
  recommended?: boolean;
  /** Something to know first, in plain words (for example: install its packages). */
  note?: string;
  /** Shown with less weight: installs, tests, builds. */
  utility?: boolean;
}

export interface Detection {
  dir: string;
  exists: boolean;
  profiles: RunProfile[];
  /** What the folder looks like: node, python, rust, go, static, unknown. */
  stack: string[];
}

const SKIP_SCRIPTS = /^(pre|post)|^(lint|format|prettier|eslint|typecheck|tsc|clean|prepare|release|deploy|publish|version|ci)(:|$)/;
const WEB_HINTS = /\b(vite|next|nuxt|astro|remix|svelte-kit|webpack(-dev-server| serve)|react-scripts start|parcel|http-server|live-server|serve\b|browser-sync|ng serve|vue-cli-service serve|gatsby develop|eleventy --serve|storybook|wrangler dev)\b|--port\b|\bPORT=/;
const SERVER_CODE = /\bcreateServer\s*\(|\bexpress\s*\(|\bfastify\s*\(|\bnew\s+Hono\b|\bBun\.serve\b|\.listen\s*\(\s*(process\.env\.PORT|\d{2,5}|port)/;
const PY_WEB = /\b(Flask|FastAPI|streamlit|gradio|http\.server|uvicorn|django|aiohttp)\b/;

const readText = (p: string, max = 200_000) => {
  try { const s = statSync(p); return s.isFile() && s.size <= max ? readFileSync(p, "utf8") : ""; } catch { return ""; }
};
const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** Quote an argument for display or a shell line. */
export function quoteArg(a: string): string {
  // Backslashes stay as they are: they are Windows path separators, not escapes.
  return /^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/(["$`])/g, "\\$1")}"`;
}

/** Split an arguments box the way a shell would: spaces separate, quotes group. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && (s[i + 1] === '"' || s[i + 1] === "\\")) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") { q = c; has = true; }
    else if (/\s/.test(c)) { if (cur || has) out.push(cur); cur = ""; has = false; }
    else cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** Look at a project folder and list the ways to run it, the best first. */
export function detectProfiles(dir: string): Detection {
  if (!isDir(dir)) return { dir, exists: false, profiles: [], stack: [] };
  const profiles: RunProfile[] = [];
  const stack = new Set<string>();
  const add = (p: RunProfile) => { if (!profiles.some((x) => x.id === p.id)) profiles.push(p); };

  // ---- Node.js ----
  const pkgText = readText(join(dir, "package.json"));
  let pkg: Record<string, any> | null = null;
  try { pkg = pkgText ? JSON.parse(pkgText) : null; } catch { pkg = null; }
  let installNote: string | undefined;
  if (pkg) {
    stack.add("node");
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if (Object.keys(deps).length && !isDir(join(dir, "node_modules"))) {
      installNote = "It uses packages that are not installed yet: run Install packages first.";
      add({ id: "install", kind: "program", label: "Install packages", command: "npm install", exec: { shell: "npm install" }, args: false, utility: true, note: "Needs npm (it comes with Node.js from nodejs.org)." });
    }
    const scripts: Record<string, string> = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
    const order = ["dev", "start", "serve", "preview", "watch"];
    const names = Object.keys(scripts).filter((n) => typeof scripts[n] === "string" && !SKIP_SCRIPTS.test(n))
      .sort((a, b) => (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 99 : order.indexOf(b)));
    for (const name of names) {
      const body = scripts[name];
      const utility = /^(test|build)(:|$)/.test(name) || /^(install|setup|bootstrap)$/.test(name);
      let web = !utility && WEB_HINTS.test(body);
      if (!utility && !web) {
        // `node server.js` and friends: look inside the file it runs.
        const m = body.match(/\bnode\s+(?:--\S+\s+)*([\w./\\-]+\.(?:c|m)?js)\b/);
        if (m && SERVER_CODE.test(readText(join(dir, m[1])))) web = true;
      }
      add({
        id: `script:${name}`, kind: web ? "web" : "program",
        label: name === "test" ? "Run its tests" : name === "build" ? "Build it" : `npm run ${name}`,
        command: `npm run ${name}`, exec: { shell: body }, args: !web && !utility, utility,
        note: installNote,
      });
    }
    // Command-line tools it declares.
    const bins: Record<string, string> = typeof pkg.bin === "string" ? { [String(pkg.name ?? "cli").replace(/^@.*\//, "")]: pkg.bin } : pkg.bin && typeof pkg.bin === "object" ? pkg.bin : {};
    for (const [name, file] of Object.entries(bins)) {
      if (typeof file !== "string" || !isFile(join(dir, file))) continue;
      add({ id: `bin:${name}`, kind: "cli", label: name, command: `node ${quoteArg(file)}`, exec: { file: "node", args: [file] }, args: true });
    }
    // A main file and no start script: run it.
    if (typeof pkg.main === "string" && !scripts.start && isFile(join(dir, pkg.main)) && !profiles.some((p) => p.exec && "file" in p.exec && p.exec.args[0] === pkg!.main)) {
      const web = SERVER_CODE.test(readText(join(dir, pkg.main)));
      add({ id: `main:${pkg.main}`, kind: web ? "web" : "program", label: `node ${pkg.main}`, command: `node ${quoteArg(pkg.main)}`, exec: { file: "node", args: [pkg.main] }, args: !web, note: installNote });
    }
  }
  // bin/ scripts that package.json does not declare (the factory writes these).
  if (isDir(join(dir, "bin"))) {
    for (const f of safeList(join(dir, "bin")).filter((n) => /\.(c|m)?js$/.test(n)).sort()) {
      const rel = `bin/${f}`;
      if (profiles.some((p) => p.exec && "file" in p.exec && p.exec.args[0]?.replace(/^\.\//, "") === rel)) continue;
      stack.add("node");
      add({ id: `bin:${f.replace(/\.(c|m)?js$/, "")}`, kind: "cli", label: f.replace(/\.(c|m)?js$/, ""), command: `node ${rel}`, exec: { file: "node", args: [rel] }, args: true, note: installNote });
    }
  }
  // A lone server or script file at the top.
  if (!pkg?.scripts?.start) {
    for (const f of ["server.js", "server.mjs", "app.js", "app.mjs", "index.js", "index.mjs", "main.js"]) {
      if (!isFile(join(dir, f)) || profiles.some((p) => p.exec && "file" in p.exec && p.exec.args[0] === f)) continue;
      const web = SERVER_CODE.test(readText(join(dir, f)));
      if (!web && profiles.some((p) => p.kind !== "program" || !p.utility)) continue;
      stack.add("node");
      add({ id: `file:${f}`, kind: web ? "web" : "program", label: `node ${f}`, command: `node ${f}`, exec: { file: "node", args: [f] }, args: !web, note: installNote });
    }
  }

  // ---- Plain pages ----
  const hasBundler = profiles.some((p) => p.kind === "web" && p.id.startsWith("script:"));
  for (const sub of ["dist", "build", "out", "public", "docs", "site", "www", ""]) {
    if (!isFile(join(dir, sub, "index.html"))) continue;
    const html = readText(join(dir, sub, "index.html"));
    // A bundler's source page (it imports /src/main.tsx) only works through its dev server.
    if (hasBundler && (sub === "" || sub === "public") && /src=["']\/?src\/.+\.(t|j)sx?["']/.test(html)) continue;
    stack.add("static");
    add({ id: `static:${sub || "."}`, kind: "static", label: sub ? `Pages in ${sub}/` : "Pages", command: `open ${sub ? sub + "/" : ""}index.html`, root: sub, args: false });
  }

  // ---- Python ----
  const pyCmd = process.platform === "win32" ? "python" : "python3";
  for (const f of ["main.py", "app.py", "server.py", "manage.py", "run.py"]) {
    if (!isFile(join(dir, f))) continue;
    stack.add("python");
    const src = readText(join(dir, f));
    if (f === "manage.py") { add({ id: "py:django", kind: "web", label: "Django server", command: `${pyCmd} manage.py runserver`, exec: { file: pyCmd, args: ["manage.py", "runserver"] }, args: false }); continue; }
    if (/\bstreamlit\b/.test(src)) { add({ id: `py:${f}`, kind: "web", label: `streamlit run ${f}`, command: `streamlit run ${f}`, exec: { shell: `streamlit run ${f} --server.headless true` }, args: false }); continue; }
    const web = PY_WEB.test(src);
    add({ id: `py:${f}`, kind: web ? "web" : "program", label: `${pyCmd} ${f}`, command: `${pyCmd} ${f}`, exec: { file: pyCmd, args: ["-u", f] }, args: !web });
  }
  if (isFile(join(dir, "pyproject.toml")) || isFile(join(dir, "requirements.txt"))) stack.add("python");

  // ---- Rust, Go ----
  if (isFile(join(dir, "Cargo.toml"))) { stack.add("rust"); add({ id: "cargo:run", kind: "program", label: "cargo run", command: "cargo run", exec: { file: "cargo", args: ["run"] }, args: true, note: "Needs Rust (rustup.rs)." }); }
  if (isFile(join(dir, "go.mod"))) { stack.add("go"); add({ id: "go:run", kind: "program", label: "go run .", command: "go run .", exec: { file: "go", args: ["run", "."] }, args: true, note: "Needs Go (go.dev)." }); }

  // ---- Windows start scripts ----
  for (const f of ["start.bat", "run.bat", "start.cmd", "run.cmd"]) {
    if (process.platform === "win32" && isFile(join(dir, f))) add({ id: `bat:${f}`, kind: "program", label: f, command: f, exec: { shell: f }, args: true });
  }

  // The best one first: something you can see, then a tool, then the rest; utilities last.
  const rank = (p: RunProfile) => (p.utility ? 10 : 0) + (p.kind === "web" ? 0 : p.kind === "static" ? 1 : p.kind === "cli" ? 2 : 3);
  profiles.sort((a, b) => rank(a) - rank(b));
  const best = profiles.find((p) => !p.utility);
  if (best) best.recommended = true;
  return { dir, exists: true, profiles, stack: [...stack] };
}

function safeList(dir: string): string[] {
  try { return existsSync(dir) ? readdirSync(dir) : []; } catch { return []; }
}
