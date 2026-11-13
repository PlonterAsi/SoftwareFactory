import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { runTests, type TestCase, type TestRun } from "./workspace.js";

/**
 * The tests are tried before they are locked (run 2366): the Tester's file ended with a stray line that
 * threw "game is not defined" once the tests were over, so the locked suite could never pass, whatever
 * the code did, and the night went into fixing code that was right.
 *
 * Before any code exists, every module a test imports is missing. This copies the project to a temp
 * folder, puts a stub in place of each missing module (a callable stand-in for every name the tests
 * import, which answers anything with itself), and runs the tests. Assertions fail, as they must with
 * no code. But a test FILE that fails as a whole with a ReferenceError or SyntaxError broke on its own
 * lines: no code could ever fix it, so it goes back to the Tester before it is locked. Free: no AI call.
 */

const STUB = `const h = {
  get(t, p) {
    if (p === "then") return undefined;
    if (p === Symbol.toPrimitive) return () => 0;
    if (p === Symbol.iterator) return function* () {};
    if (p === Symbol.asyncIterator) return async function* () {};
    if (p === "toString" || p === "valueOf") return () => "";
    return s;
  },
  apply() { return s; },
  construct() { return s; },
};
const s = new Proxy(function () {}, h);
export default s;
`;

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** The relative modules each test file imports, with the names it takes from them. */
export function relativeImports(src: string): { spec: string; names: string[] }[] {
  const out = new Map<string, Set<string>>();
  const add = (spec: string, names: string[] = []) => { const s = out.get(spec) ?? new Set(); names.forEach((n) => s.add(n)); out.set(spec, s); };
  for (const m of src.matchAll(/import\s+([\w$\s{},*]*?)\s*from\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const clause = m[1];
    const names: string[] = [];
    const braces = clause.match(/\{([^}]*)\}/);
    if (braces) for (const part of braces[1].split(",")) { const n = part.trim().split(/\s+as\s+/)[0].trim(); if (IDENT.test(n) && n !== "default") names.push(n); }
    add(m[2], names);
  }
  for (const m of src.matchAll(/import\s*["'](\.{1,2}\/[^"']+)["']/g)) add(m[1]);
  for (const m of src.matchAll(/import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) add(m[1]);
  // Named exports a dynamic import destructures: const { a, b } = await import("../src/x.js")
  for (const m of src.matchAll(/\{([^}]*)\}\s*=\s*await\s+import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) add(m[2], m[1].split(",").map((p) => p.trim().split(/\s*:\s*/)[0].trim()).filter((n) => IDENT.test(n) && n !== "default"));
  return [...out].map(([spec, names]) => ({ spec, names: [...names] }));
}

function stubFor(path: string, names: string[]): string {
  if (/\.json$/i.test(path)) return "{}";
  return STUB + (names.length ? `export const ${names.map((n) => `${n} = s`).join(", ")};\n` : "");
}

/** A test file that failed as a whole (node names the file-level failure after the file). */
export const isFileLevel = (c: TestCase) => !c.pass && !!c.file && c.name.replace(/\\/g, "/").endsWith(c.file);

/** An error that no code under test could cause: the test file's own lines are broken. */
const OWN_FAULT = /\b(ReferenceError|SyntaxError)\b/;

/** Try the tests against stubs. Returns one message per test file that breaks on its own, or [] when they look sound. */
export async function dryRunTests(dir: string, testPaths: string[], timeoutMs = 60_000): Promise<string[]> {
  const tmp = mkdtempSync(join(tmpdir(), "sf-testdry-"));
  try {
    cpSync(dir, tmp, { recursive: true, filter: (src) => !/[\\/]\.git([\\/]|$)/.test(src) && !/[\\/]node_modules([\\/]|$)/.test(src) });
    const stubs = new Map<string, Set<string>>();
    for (const t of testPaths) {
      const abs = join(tmp, t);
      if (!existsSync(abs)) continue;
      for (const { spec, names } of relativeImports(readFileSync(abs, "utf8"))) {
        const target = posix.normalize(posix.join(posix.dirname(t.replace(/\\/g, "/")), spec));
        if (target.startsWith("..") || existsSync(join(tmp, target))) continue;
        const s = stubs.get(target) ?? new Set();
        names.forEach((n) => s.add(n));
        stubs.set(target, s);
      }
    }
    for (const [p, names] of stubs) { mkdirSync(dirname(join(tmp, p)), { recursive: true }); writeFileSync(join(tmp, p), stubFor(p, [...names])); }
    const r: TestRun = await runTests(tmp, timeoutMs);
    const ours = (f: string) => testPaths.some((t) => t.replace(/\\/g, "/") === f);
    const out = new Map<string, string>();
    for (const c of r.cases) if (isFileLevel(c) && ours(c.file) && OWN_FAULT.test(c.error ?? "")) out.set(c.file, c.error ?? "");
    // An error thrown outside any test (a stray line run by a timer, as in run 2366) is a note on the file, not a case.
    for (const n of r.fileNotes ?? []) if (ours(n.file) && !out.has(n.file) && OWN_FAULT.test(n.message)) out.set(n.file, n.message);
    return [...out].map(([file, e]) => `${file}: fails on its own lines, outside any test, before any code could matter: ${e.slice(0, 400)}`);
  } catch {
    // A dry run that cannot run proves nothing either way: the tests are locked as before.
    return [];
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* the OS cleans tmp */ }
  }
}

/**
 * Evidence in a real run that a locked test file, not the code, is at fault: it fails as a whole although
 * tests in it passed (what broke runs outside any test), or it fails on a ReferenceError or SyntaxError
 * thrown from the test file itself.
 */
export function lockedTestFaults(run: TestRun, isLocked: (p: string) => boolean): TestCase[] {
  return run.cases.filter((c) => isFileLevel(c) && isLocked(c.file) && (
    run.cases.some((o) => o.pass && o.file === c.file) ||
    (/\bSyntaxError\b/.test(c.error ?? "") && (c.error ?? "").includes(c.file.split("/").pop()!))
  ));
}
