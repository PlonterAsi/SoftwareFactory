import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import { syntaxErrors } from "./workspace.js";

/**
 * The page check: every project the factory builds has a screen (visualizeEverything),
 * and this proves the screen can load, without a browser and for free.
 *
 *   - index.html sits at the project root (the Run tab previews it as "Pages")
 *   - every local script and stylesheet it names exists; nothing loads from the internet
 *   - every module the page reaches (its scripts and what they import, transitively)
 *     exists, parses, and imports nothing a browser cannot load (node:fs, bare packages)
 *   - ids the scripts look up by getElementById / querySelector("#id") exist in the page (a note only)
 *   - a server.js, when there is one, listens on process.env.PORT and parses
 *
 * The loop runs it next to the locked tests: a problem shows as a failing cell
 * in the test grid and goes to the Fixer like any failing test.
 */
export interface UiCheck {
  pass: boolean;
  /** What would stop the page from working. */
  problems: string[];
  /** Worth a look, but not a failure (an id built at runtime looks missing, for example). */
  notes: string[];
  /** The page's own files: index.html and every module it reaches. */
  files: string[];
  server: boolean;
}

const read = (p: string) => { try { return statSync(p).isFile() ? readFileSync(p, "utf8") : null; } catch { return null; } };
const rel = (root: string, abs: string) => relative(root, abs).split(sep).join("/");
const isRemote = (u: string) => /^(https?:)?\/\//i.test(u);
const isIgnorable = (u: string) => /^(data:|blob:|#|mailto:|javascript:)/i.test(u) || !u.trim();

/** Static import specifiers of an ES module: import x from "a", import "a", export * from "a", import("a"). */
export function importsOf(src: string): string[] {
  const out = new Set<string>();
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
  for (const m of code.matchAll(/(?:^|[;\s}])(?:import|export)\s+(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"']+)["']/g)) out.add(m[1]);
  for (const m of code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) out.add(m[1]);
  return [...out];
}

export function checkUi(root: string): UiCheck {
  const problems: string[] = [];
  const notes: string[] = [];
  const files: string[] = [];
  const serverSrc = read(join(root, "server.js")) ?? read(join(root, "server.mjs"));
  const server = serverSrc != null;
  if (serverSrc != null) {
    if (!/process\.env\.PORT/.test(serverSrc)) problems.push("server.js does not listen on process.env.PORT (the Run tab gives it a free port)");
    if (!/\blisten\s*\(/.test(serverSrc)) problems.push("server.js never calls listen()");
    if (!/https?:\/\/(localhost|127\.0\.0\.1)/.test(serverSrc)) notes.push("server.js should print its address (http://localhost:PORT/) so the Run tab can open it");
  }
  const html = read(join(root, "index.html"));
  if (html == null) {
    problems.push("index.html is missing at the project root: every project needs a page the Run tab can show");
    return { pass: false, problems, notes, files, server };
  }
  files.push("index.html");
  if (!/<body[\s>]/i.test(html) && !/<(main|div|section|form|canvas)[\s>]/i.test(html)) problems.push("index.html has no body content to show");

  // Scripts and styles the page loads.
  const modules: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1];
    const src = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
    if (src) {
      if (isRemote(src)) { problems.push(`index.html loads a script from the internet (${src}); everything must ship in the folder`); continue; }
      if (isIgnorable(src)) continue;
      const abs = join(root, normalize(src.replace(/^\.?\//, "").split(/[?#]/)[0]));
      if (!existsSync(abs)) { problems.push(`index.html loads ${src}, which does not exist`); continue; }
      modules.push(abs);
    } else if (/\btype\s*=\s*["']module["']/i.test(attrs) && m[2].trim()) {
      for (const spec of importsOf(m[2])) resolveImport(root, join(root, "index.html"), spec, "an inline script in index.html", problems, modules);
    }
  }
  for (const m of html.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const href = m[1];
    if (!/rel\s*=\s*["']?stylesheet/i.test(m[0]) || isIgnorable(href)) continue;
    if (isRemote(href)) { problems.push(`index.html loads a stylesheet from the internet (${href}); everything must ship in the folder`); continue; }
    const abs = join(root, normalize(href.replace(/^\.?\//, "").split(/[?#]/)[0]));
    if (!existsSync(abs)) problems.push(`index.html loads ${href}, which does not exist`);
    else files.push(rel(root, abs));
  }
  if (!modules.length && !/<script\b[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html)) notes.push("the page runs no script: it cannot do anything yet");

  // Walk the module graph the browser will load.
  const seen = new Set<string>();
  const queue = [...modules];
  const scriptText: string[] = [];
  while (queue.length) {
    const abs = queue.shift()!;
    if (seen.has(abs)) continue;
    seen.add(abs);
    const r = rel(root, abs);
    if (r.startsWith("..")) { problems.push(`the page imports ${r}, outside the project folder`); continue; }
    files.push(r);
    const src = read(abs) ?? "";
    scriptText.push(src);
    for (const spec of importsOf(src)) resolveImport(root, abs, spec, r, problems, queue);
  }
  const js = files.filter((f) => /\.(c|m)?js$/.test(f));
  problems.push(...syntaxErrors(root, js).map((e) => `does not parse: ${e}`));

  // Ids the scripts look for that the page does not have.
  const ids = new Set([...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]));
  const wanted = new Set<string>();
  for (const s of scriptText) {
    for (const m of s.matchAll(/getElementById\(\s*["']([\w-]+)["']\s*\)/g)) wanted.add(m[1]);
    for (const m of s.matchAll(/querySelector(?:All)?\(\s*["']#([\w-]+)["']\s*\)/g)) wanted.add(m[1]);
  }
  const missing = [...wanted].filter((id) => !ids.has(id));
  if (missing.length) notes.push(`the scripts look up ${missing.map((i) => `#${i}`).join(", ")}, which index.html does not have (fine only if the script creates them)`);
  return { pass: problems.length === 0, problems, notes, files: [...new Set(files)], server };
}

function resolveImport(root: string, from: string, spec: string, label: string, problems: string[], queue: string[]) {
  if (/^node:/.test(spec) || /^(fs|path|os|child_process|http|https|crypto|url|util|stream|events|readline|process|buffer|zlib|net)(\/|$)/.test(spec)) {
    problems.push(`${label} imports "${spec}", which a browser cannot load: keep Node-only code out of what the page imports`);
    return;
  }
  if (isRemote(spec)) { problems.push(`${label} imports ${spec} from the internet; everything must ship in the folder`); return; }
  if (!spec.startsWith(".") && !spec.startsWith("/")) { problems.push(`${label} imports the package "${spec}"; the page can only import files in the folder (no packages)`); return; }
  const base = spec.startsWith("/") ? root : dirname(from);
  const abs = join(base, normalize(spec.replace(/^\//, "").split(/[?#]/)[0]));
  if (!existsSync(abs)) { problems.push(`${label} imports ${spec}, which does not exist${/\.(c|m)?js$/.test(spec) ? "" : " (a browser needs the full file name, with .js)"}`); return; }
  queue.push(abs);
}

/** The check as one cell in the test grid, the way the loop shows and fixes it. */
export function uiCase(u: UiCheck) {
  return {
    name: "the page loads (index.html and every module it imports)",
    file: "index.html",
    pass: u.pass,
    error: u.pass ? undefined : u.problems.slice(0, 8).join("\n"),
    durationMs: 0,
  };
}
