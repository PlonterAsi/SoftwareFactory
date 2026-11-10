import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, posix } from "node:path";

/**
 * The free part of exploring a repo: a static scan of its working copy.
 *
 * No agent and no network. It reads the files once and works out languages,
 * modules (workspace packages or top-level folders), the dependencies between
 * them, external packages, entry points, tests and health signals. Every
 * module gets a content hash, so a later exploration only asks agents about
 * modules whose hash changed. Nothing is ever written to the scanned folder.
 */
export interface ScannedFile { path: string; module: string; lang: string; lines: number; bytes: number; test: boolean }

export interface CodeModule {
  id: string;
  files: number;
  lines: number;
  bytes: number;
  /** Main language by lines. */
  lang: string;
  tests: number;
  /** A test file elsewhere imports this module directly. */
  testedBy: boolean;
  /** Content hash of every file in the module: unchanged hash = cached understanding. */
  hash: string;
  /** Up to 6 notable files (largest first). */
  top: string[];
  /** Exported names seen in the module (JS/TS/Python/Rust), up to 20. */
  exports: string[];
  /** Name from the module's own manifest, e.g. "@sf/core". */
  pkg?: string;
  /** TODO/FIXME/HACK/XXX markers. */
  todos: number;
  entry: boolean;
}

export interface CodeEdge { from: string; to: string; weight: number }

export interface HealthFlag { id: string; level: "high" | "medium" | "low"; text: string; files?: string[] }

export interface CodeMap {
  root: string;
  head: string | null;
  branch: string | null;
  files: number;
  lines: number;
  bytes: number;
  /** Lines per language, biggest first. */
  languages: { lang: string; files: number; lines: number }[];
  modules: CodeModule[];
  edges: CodeEdge[];
  /** External packages by manifest. */
  dependencies: { manifest: string; name: string; dev: boolean }[];
  entryPoints: { path: string; why: string }[];
  tests: { files: number; command: string | null; frameworks: string[] };
  health: { score: number; flags: HealthFlag[] };
  /** Largest source files, for the hotspot list. */
  largest: { path: string; lines: number }[];
  /** A few TODO lines, for the surveyor. */
  todos: { path: string; line: number; text: string }[];
  /** Files skipped (binary, too big, over the limit). */
  skipped: number;
  ms: number;
}

const LANG: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
  ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
  ".py": "Python", ".rs": "Rust", ".go": "Go", ".java": "Java", ".kt": "Kotlin", ".cs": "C#", ".cpp": "C++", ".cc": "C++", ".c": "C", ".h": "C",
  ".hpp": "C++", ".rb": "Ruby", ".php": "PHP", ".swift": "Swift", ".dart": "Dart", ".scala": "Scala", ".lua": "Lua", ".sh": "Shell", ".ps1": "PowerShell",
  ".sql": "SQL", ".html": "HTML", ".css": "CSS", ".scss": "CSS", ".vue": "Vue", ".svelte": "Svelte",
  ".json": "JSON", ".yml": "YAML", ".yaml": "YAML", ".toml": "TOML", ".md": "Markdown", ".mdx": "Markdown",
};
/** Languages that count as code (the rest is config or docs). */
const CODE = new Set(["TypeScript", "JavaScript", "Python", "Rust", "Go", "Java", "Kotlin", "C#", "C++", "C", "Ruby", "PHP", "Swift", "Dart", "Scala", "Lua", "Shell", "PowerShell", "SQL", "Vue", "Svelte", "HTML", "CSS"]);
const IGNORE_DIRS = new Set([".git", "node_modules", "dist", "build", "out", "target", "vendor", ".venv", "venv", "__pycache__", ".next", ".nuxt", ".cache", "coverage", ".turbo", ".idea", ".vscode", ".sf-data", "bin/Debug", "obj"]);
const MANIFESTS = ["package.json", "Cargo.toml", "pyproject.toml", "setup.py", "go.mod", "pom.xml", "build.gradle", "composer.json", "Gemfile", "pubspec.yaml"];
const GROUP_DIRS = new Set(["src", "lib", "app", "apps", "packages", "crates", "libs", "services", "modules", "components", "internal", "cmd", "pkg"]);
const TEST_RE = /(^|\/)(tests?|__tests__|spec|specs|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$|Tests?\.(cs|java|kt)$/;
const LOCK_RE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum|bun\.lockb?)$/;
const MAX_FILES = 20_000;
const MAX_BYTES = 1_000_000;

export interface ScanOptions { maxFiles?: number }

/** Scan a working copy. Read-only. */
export function scanRepo(root: string, opts: ScanOptions = {}): CodeMap {
  const t0 = performance.now();
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`No folder at ${root}`);
  const git = gitInfo(root);
  let paths = git.files ?? walk(root);
  const limit = opts.maxFiles ?? MAX_FILES;
  let skipped = Math.max(0, paths.length - limit);
  paths = paths.filter((p) => !p.split("/").some((seg) => IGNORE_DIRS.has(seg))).slice(0, limit);

  const manifestDirs = new Map<string, string | undefined>();
  for (const p of paths) {
    const base = posix.basename(p);
    const dir = posix.dirname(p);
    if (MANIFESTS.includes(base) && dir !== ".") manifestDirs.set(dir, base === "package.json" ? pkgName(join(root, p)) : base === "Cargo.toml" ? cargoName(join(root, p)) : undefined);
  }
  const moduleOf = (p: string) => moduleFor(p, manifestDirs);

  const files: ScannedFile[] = [];
  const contents = new Map<string, string>();
  const hashes = new Map<string, ReturnType<typeof createHash>>();
  const todos: CodeMap["todos"] = [];
  const todoCount = new Map<string, number>();
  const exportsBy = new Map<string, Set<string>>();
  for (const p of paths) {
    const full = join(root, p);
    let st;
    try { st = statSync(full); } catch { skipped++; continue; }
    if (!st.isFile()) continue;
    const lang = LOCK_RE.test(p) ? "Lockfile" : LANG[extname(p).toLowerCase()] ?? (/(^|\/)(Dockerfile|Makefile)$/.test(p) ? "Build" : "Other");
    const module = moduleOf(p);
    const h = hashes.get(module) ?? createHash("sha1");
    hashes.set(module, h);
    if (st.size > MAX_BYTES) { skipped++; h.update(`${p}:${st.size}\n`); files.push({ path: p, module, lang, lines: 0, bytes: st.size, test: TEST_RE.test(p) }); continue; }
    const buf = readFileSync(full);
    h.update(p).update("\0").update(buf);
    if (buf.subarray(0, 8000).includes(0)) { skipped++; files.push({ path: p, module, lang: "Binary", lines: 0, bytes: st.size, test: false }); continue; }
    const text = buf.toString("utf8");
    // Lockfiles are generated: listed, hashed, but their lines say nothing about the code.
    const lines = text && lang !== "Lockfile" ? text.split("\n").length : 0;
    files.push({ path: p, module, lang, lines, bytes: st.size, test: TEST_RE.test(p) });
    if (CODE.has(lang) || lang === "JSON" || lang === "TOML") contents.set(p, text);
    if (CODE.has(lang)) {
      const lineArr = text.split("\n");
      for (let i = 0; i < lineArr.length; i++) {
        if (/\b(TODO|FIXME|HACK|XXX)\b/.test(lineArr[i])) {
          todoCount.set(module, (todoCount.get(module) ?? 0) + 1);
          if (todos.length < 40) todos.push({ path: p, line: i + 1, text: lineArr[i].trim().slice(0, 160) });
        }
      }
      const ex = exportsBy.get(module) ?? new Set<string>();
      exportsBy.set(module, ex);
      if (ex.size < 20) for (const name of exportedNames(text, lang)) { if (ex.size >= 20) break; ex.add(name); }
    }
  }

  // Entry points.
  const entryPoints: CodeMap["entryPoints"] = [];
  const have = new Set(files.map((f) => f.path));
  for (const p of paths.filter((x) => posix.basename(x) === "package.json")) {
    const j = readJsonSafe(contents.get(p));
    if (!j) continue;
    const dir = posix.dirname(p) === "." ? "" : posix.dirname(p) + "/";
    // Only files that are in the repo (a "main" pointing at build output is not an entry point you can read).
    const add = (rel: unknown, why: string) => { if (typeof rel === "string" && rel) { const path = posix.normalize(dir + rel.replace(/^\.\//, "")); if (have.has(path)) entryPoints.push({ path, why }); } };
    add(j.main, `${p}: main`);
    if (typeof j.bin === "string") add(j.bin, `${p}: bin`);
    else if (j.bin && typeof j.bin === "object") for (const [k, v] of Object.entries(j.bin)) add(v, `${p}: bin ${k}`);
    for (const s of ["start", "dev", "serve"]) if (typeof j.scripts?.[s] === "string") entryPoints.push({ path: p, why: `npm run ${s}: ${String(j.scripts[s]).slice(0, 80)}` });
  }
  for (const f of files) {
    const b = posix.basename(f.path);
    if (/^(main|__main__|cli|server|app)\.(ts|js|mjs|py|rs|go)$/.test(b) && !f.test) entryPoints.push({ path: f.path, why: "named like an entry point" });
    else if (b === "index.html" && f.path.split("/").length <= 3) entryPoints.push({ path: f.path, why: "web page" });
    else if (b === "Dockerfile") entryPoints.push({ path: f.path, why: "container image" });
  }
  const entrySeen = new Set<string>();
  const entries = entryPoints.filter((e) => (entrySeen.has(e.path + e.why) ? false : (entrySeen.add(e.path + e.why), true))).slice(0, 30);

  // Dependencies between modules (relative and workspace imports) and external packages.
  const pkgToModule = new Map<string, string>();
  for (const [dir, name] of manifestDirs) if (name) pkgToModule.set(name, moduleOf(`${dir}/x`));
  const topDirs = new Set(files.map((f) => f.path.split("/")[0]));
  const edgeW = new Map<string, number>();
  const testedBy = new Set<string>();
  const addEdge = (a: string, b: string, test = false) => {
    if (test) testedBy.add(b);
    if (a !== b) edgeW.set(`${a}\u0000${b}`, (edgeW.get(`${a}\u0000${b}`) ?? 0) + 1);
  };
  for (const f of files) {
    const text = contents.get(f.path);
    if (!text || !CODE.has(f.lang)) continue;
    for (const spec of importsOf(text, f.lang)) {
      if (spec.startsWith(".")) {
        const target = resolveRel(f.path, spec, have);
        if (target) addEdge(f.module, moduleOf(target), f.test);
      } else {
        const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
        const m = pkgToModule.get(name);
        if (m) addEdge(f.module, m, f.test);
        else if (f.lang === "Python" && topDirs.has(spec.split(".")[0])) {
          const guess = files.find((x) => x.path.startsWith(spec.split(".").join("/")));
          if (guess) addEdge(f.module, guess.module);
        }
      }
    }
  }
  const edges = [...edgeW].map(([k, weight]) => { const [from, to] = k.split("\u0000"); return { from, to, weight }; }).sort((a, b) => b.weight - a.weight).slice(0, 400);

  const dependencies: CodeMap["dependencies"] = [];
  for (const p of paths) {
    const b = posix.basename(p);
    if (b === "package.json") {
      const j = readJsonSafe(contents.get(p));
      for (const [k, dev] of [["dependencies", false], ["devDependencies", true]] as const) for (const name of Object.keys(j?.[k] ?? {})) dependencies.push({ manifest: p, name, dev });
    } else if (b === "Cargo.toml" || b === "pyproject.toml") {
      const text = contents.get(p) ?? "";
      for (const sect of text.split(/^\[/m)) {
        const head = sect.split("]")[0];
        if (/^(dev-)?dependencies$/.test(head) || /^tool\.poetry\.(dev-)?dependencies$/.test(head)) {
          for (const line of sect.split("\n").slice(1)) {
            const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/);
            if (m && m[1] !== "python") dependencies.push({ manifest: p, name: m[1], dev: head.includes("dev") });
          }
        }
        if (head === "project") {
          const deps = sect.match(/dependencies\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? "";
          for (const m of deps.matchAll(/["']([A-Za-z0-9_.-]+)/g)) dependencies.push({ manifest: p, name: m[1], dev: false });
        }
      }
    } else if (b === "requirements.txt") {
      for (const line of (readSafe(join(root, p)) ?? "").split("\n")) { const m = line.match(/^\s*([A-Za-z0-9_.-]+)/); if (m) dependencies.push({ manifest: p, name: m[1], dev: false }); }
    } else if (b === "go.mod") {
      for (const m of (contents.get(p) ?? readSafe(join(root, p)) ?? "").matchAll(/^\s*([a-z0-9.-]+\.[a-z]+\/\S+)\s+v/gm)) dependencies.push({ manifest: p, name: m[1], dev: false });
    }
  }

  // Tests.
  const testFiles = files.filter((f) => f.test && CODE.has(f.lang));
  const frameworks = new Set<string>();
  let command: string | null = null;
  const rootPkg = readJsonSafe(contents.get("package.json"));
  if (typeof rootPkg?.scripts?.test === "string" && !/no test specified/.test(rootPkg.scripts.test)) command = `npm test (${String(rootPkg.scripts.test).slice(0, 60)})`;
  for (const d of dependencies) if (/^(vitest|jest|mocha|ava|pytest|@playwright\/test|cypress)$/.test(d.name)) frameworks.add(d.name);
  if (testFiles.some((f) => /node:test/.test(contents.get(f.path) ?? ""))) frameworks.add("node:test");
  if (have.has("Cargo.toml") || [...manifestDirs.keys()].some((d) => have.has(`${d}/Cargo.toml`))) { frameworks.add("cargo test"); command ??= "cargo test"; }
  if (testFiles.some((f) => f.lang === "Python")) { frameworks.add("pytest"); command ??= "pytest"; }
  if (have.has("go.mod")) { frameworks.add("go test"); command ??= "go test ./..."; }

  // Modules.
  const byModule = new Map<string, ScannedFile[]>();
  for (const f of files) byModule.set(f.module, [...(byModule.get(f.module) ?? []), f]);
  const entryModules = new Set(entries.map((e) => moduleOf(e.path)));
  const modules: CodeModule[] = [...byModule].map(([id, fs]) => {
    const langs = new Map<string, number>();
    for (const f of fs) if (CODE.has(f.lang)) langs.set(f.lang, (langs.get(f.lang) ?? 0) + f.lines);
    if (!langs.size) for (const f of fs) if (f.lang !== "Binary" && f.lang !== "Lockfile") langs.set(f.lang, (langs.get(f.lang) ?? 0) + f.lines + 1);
    const lang = [...langs].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fs[0].lang;
    const dir = [...manifestDirs.keys()].find((d) => d === id);
    return {
      id, files: fs.length, lines: fs.reduce((s, f) => s + f.lines, 0), bytes: fs.reduce((s, f) => s + f.bytes, 0), lang,
      tests: fs.filter((f) => f.test && CODE.has(f.lang)).length, testedBy: testedBy.has(id), hash: hashes.get(id)!.digest("hex").slice(0, 16),
      top: fs.filter((f) => CODE.has(f.lang) && !f.test).sort((a, b) => b.lines - a.lines).slice(0, 6).map((f) => f.path),
      exports: [...(exportsBy.get(id) ?? [])], ...(dir && manifestDirs.get(dir) ? { pkg: manifestDirs.get(dir) } : {}),
      todos: todoCount.get(id) ?? 0, entry: entryModules.has(id),
    };
  }).sort((a, b) => b.lines - a.lines);

  const languages = new Map<string, { files: number; lines: number }>();
  for (const f of files) { const l = languages.get(f.lang) ?? { files: 0, lines: 0 }; l.files++; l.lines += f.lines; languages.set(f.lang, l); }
  const code = files.filter((f) => CODE.has(f.lang) && !f.test);
  const largest = [...code].sort((a, b) => b.lines - a.lines).slice(0, 12).map((f) => ({ path: f.path, lines: f.lines }));

  const map: CodeMap = {
    root, head: git.head, branch: git.branch, files: files.length, lines: files.reduce((s, f) => s + f.lines, 0), bytes: files.reduce((s, f) => s + f.bytes, 0),
    languages: [...languages].map(([lang, v]) => ({ lang, ...v })).sort((a, b) => b.lines - a.lines),
    modules, edges, dependencies: dependencies.slice(0, 300), entryPoints: entries,
    tests: { files: testFiles.length, command, frameworks: [...frameworks] },
    health: { score: 100, flags: [] }, largest, todos, skipped, ms: 0,
  };
  map.health = health(map, have, files);
  map.ms = Math.round(performance.now() - t0);
  return map;
}

/** Health signals anyone would check first. Free, deterministic, explainable. */
function health(map: CodeMap, have: Set<string>, files: ScannedFile[]): CodeMap["health"] {
  const flags: HealthFlag[] = [];
  const any = (re: RegExp) => [...have].some((p) => re.test(p));
  const codeLines = map.languages.filter((l) => CODE.has(l.lang)).reduce((s, l) => s + l.lines, 0);
  if (!any(/^readme(\.\w+)?$/i)) flags.push({ id: "no-readme", level: "medium", text: "No README at the top of the repo" });
  if (!map.tests.files && codeLines > 0) flags.push({ id: "no-tests", level: "high", text: "No test files found" });
  else if (!map.tests.command && map.tests.files) flags.push({ id: "no-test-command", level: "low", text: "Tests exist but there is no one-line command to run them (no test script)" });
  if (!any(/^\.github\/workflows\/.+\.ya?ml$/) && !any(/^\.gitlab-ci\.yml$/) && !any(/^azure-pipelines\.yml$/)) flags.push({ id: "no-ci", level: "medium", text: "No CI workflow: nothing checks a change before it lands" });
  if (!any(/^(licen[cs]e|copying)(\.\w+)?$/i)) flags.push({ id: "no-license", level: "low", text: "No LICENSE file" });
  const npm = [...have].filter((p) => posix.basename(p) === "package.json");
  if (npm.length && !any(/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/)) flags.push({ id: "no-lockfile", level: "medium", text: "package.json without a lockfile: installs are not reproducible" });
  const secrets = [...have].filter((p) => /(^|\/)\.env(\.[\w-]+)?$/.test(p) && !/\.(example|sample|template)$/.test(p) || /\.(pem|key|p12|pfx)$/.test(p) || /(^|\/)id_rsa$/.test(p));
  if (secrets.length) flags.push({ id: "secret-files", level: "high", text: `File${secrets.length > 1 ? "s" : ""} that usually hold secrets ${secrets.length > 1 ? "are" : "is"} in the repo`, files: secrets.slice(0, 8) });
  const huge = files.filter((f) => CODE.has(f.lang) && !f.test && f.lines > 800);
  if (huge.length) flags.push({ id: "large-files", level: huge.some((f) => f.lines > 1500) ? "medium" : "low", text: `${huge.length} source file${huge.length > 1 ? "s" : ""} over 800 lines: hard to read and review`, files: huge.sort((a, b) => b.lines - a.lines).slice(0, 8).map((f) => `${f.path} (${f.lines})`) });
  const untested = map.modules.filter((m) => m.lines > 300 && !m.tests && !m.testedBy && CODE.has(m.lang) && !/(^|\/)(docs?|examples?|scripts?|tests?)$/i.test(m.id));
  if (untested.length && map.tests.files) flags.push({ id: "untested-modules", level: "medium", text: `${untested.length} sizable module${untested.length > 1 ? "s are" : " is"} not imported by any test`, files: untested.slice(0, 8).map((m) => m.id) });
  const todos = map.modules.reduce((s, m) => s + m.todos, 0);
  if (todos >= 5) flags.push({ id: "todos", level: todos >= 30 ? "medium" : "low", text: `${todos} TODO/FIXME markers in the code` });
  const ratio = codeLines ? files.filter((f) => f.test).reduce((s, f) => s + f.lines, 0) / codeLines : 0;
  if (map.tests.files && ratio < 0.1 && codeLines > 1000) flags.push({ id: "thin-tests", level: "low", text: `Tests are ${(ratio * 100).toFixed(0)}% of the code by lines` });
  const cost = { high: 22, medium: 10, low: 4 } as const;
  const score = Math.max(0, 100 - flags.reduce((s, f) => s + cost[f.level], 0));
  return { score, flags };
}

/**
 * Which module a file belongs to. Inside its nearest workspace package (or the
 * repo root), the first folder is the module; a src/lib/app folder is looked
 * through one level, so packages/core/src/order/engine.ts is in
 * packages/core/src/order. Loose files sit in their package's own module.
 */
export function moduleFor(p: string, manifestDirs: Map<string, unknown> | Set<string>): string {
  const parts = p.split("/");
  let base = 0;
  for (let i = parts.length - 1; i >= 1; i--) if (manifestDirs.has(parts.slice(0, i).join("/"))) { base = i; break; }
  const prefix = parts.slice(0, base);
  const rest = parts.slice(base);
  if (rest.length === 1) return prefix.length ? prefix.join("/") : "(root)";
  if (GROUP_DIRS.has(rest[0]) && rest.length > 2) return [...prefix, rest[0], rest[1]].join("/");
  return [...prefix, rest[0]].join("/");
}

export function importsOf(text: string, lang: string): string[] {
  const out: string[] = [];
  if (lang === "TypeScript" || lang === "JavaScript" || lang === "Vue" || lang === "Svelte") {
    for (const m of text.matchAll(/(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*\(?\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  } else if (lang === "Python") {
    for (const m of text.matchAll(/^\s*(?:from\s+(\.*[\w.]*)\s+import|import\s+([\w.]+))/gm)) out.push(m[1] ?? m[2]);
  } else if (lang === "Rust") {
    for (const m of text.matchAll(/^\s*use\s+crate::(\w+)/gm)) out.push(`./${m[1]}`);
  }
  return out.filter(Boolean);
}

function exportedNames(text: string, lang: string): string[] {
  const out: string[] = [];
  const re = lang === "Python" ? /^(?:def|class)\s+([A-Za-z]\w*)/gm
    : lang === "Rust" ? /^\s*pub\s+(?:async\s+)?(?:fn|struct|enum|trait)\s+(\w+)/gm
      : lang === "Go" ? /^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/gm
        : /export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of text.matchAll(re)) out.push(m[1]);
  return out;
}

function resolveRel(from: string, spec: string, have: Set<string>): string | null {
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
  const noExt = base.replace(/\.(js|mjs|cjs|jsx)$/, "");
  for (const c of [base, `${noExt}.ts`, `${noExt}.tsx`, `${noExt}.js`, `${noExt}.jsx`, `${noExt}.mjs`, `${noExt}.py`, `${noExt}.rs`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/mod.rs`, `${base}/__init__.py`]) if (have.has(c)) return c;
  return null;
}

function gitInfo(root: string): { head: string | null; branch: string | null; files: string[] | null } {
  try {
    const run = (args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    // Inside a work tree? (Comparing paths is unreliable on Windows: 8.3 short names, drive case, slashes.)
    if (run(["rev-parse", "--is-inside-work-tree"]).trim() !== "true") return { head: null, branch: null, files: null };
    let head: string | null = null;
    let branch: string | null = null;
    try { head = run(["rev-parse", "HEAD"]).trim(); } catch { /* empty repo */ }
    try { branch = run(["rev-parse", "--abbrev-ref", "HEAD"]).trim(); } catch { /* none */ }
    // Paths come back relative to `root`, so a folder inside a bigger repo works too.
    const files = run(["ls-files", "-co", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
    return { head, branch, files: files.length ? files : null };
  } catch {
    return { head: null, branch: null, files: null };
  }
}


function walk(root: string): string[] {
  const out: string[] = [];
  const stack = [""];
  while (stack.length && out.length < MAX_FILES * 2) {
    const rel = stack.pop()!;
    let entries;
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!IGNORE_DIRS.has(e.name)) stack.push(p); }
      else if (e.isFile()) out.push(p);
    }
  }
  return out.sort();
}

function readSafe(p: string): string | null { try { return readFileSync(p, "utf8"); } catch { return null; } }
function readJsonSafe(text: string | undefined): any { try { return text ? JSON.parse(text) : null; } catch { return null; } }
function pkgName(p: string): string | undefined { const j = readJsonSafe(readSafe(p) ?? undefined); return typeof j?.name === "string" ? j.name : undefined; }
function cargoName(p: string): string | undefined { return (readSafe(p) ?? "").match(/^\[package\][\s\S]*?^name\s*=\s*"([^"]+)"/m)?.[1]; }
