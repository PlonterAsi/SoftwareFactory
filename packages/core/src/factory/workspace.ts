import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

export interface FileBlock { path: string; content: string }

/** Pull `<<<FILE path ... FILE>>>` blocks out of an agent's answer. */
export function parseFileBlocks(text: string): FileBlock[] {
  const out: FileBlock[] = [];
    // Models sometimes close with "</FILE>>>" or "</FILE>"; accept those too.
  const re = /<<<FILE[ \t]+([^\n]+)\n([\s\S]*?)\n?(?:<\/FILE>{0,3}|FILE>>>)/g;
  for (const m of text.matchAll(re)) {
    let content = m[2];
    // Agents sometimes wrap the content in a code fence; drop it.
    const fenced = content.match(/^```[\w-]*\n([\s\S]*?)\n```\s*$/);
    if (fenced) content = fenced[1];
    out.push({ path: m[1].trim().replace(/^`|`$/g, ""), content: content.endsWith("\n") ? content : content + "\n" });
  }
  return out;
}

/** Pull the first fenced json block (or a bare object) out of an agent's answer. */
export function parseJsonBlock<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const raw = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(raw) as T;
}

/** Resolve a path an agent gave us, refusing anything that leaves the project folder. */
export function safePath(root: string, p: string): string {
  if (!p || isAbsolute(p) || p.includes("\0")) throw new Error(`Refused path "${p}"`);
  const rel = normalize(p);
  if (rel.startsWith("..") || rel.split(sep).includes("..") || rel.startsWith(".git")) throw new Error(`Refused path "${p}"`);
  return join(root, rel);
}

export const isLockedTest = (p: string) => normalize(p).split(sep)[0] === "test";

export interface WriteResult { written: { path: string; lines: number; bytes: number }[]; refused: { path: string; reason: string }[] }

/**
 * Write agent files into the project. With `lockTests`, anything under test/
 * is refused: the acceptance tests belong to the Tester and stay locked.
 */
export function writeFiles(root: string, files: FileBlock[], opts: { lockTests: boolean }): WriteResult {
  const res: WriteResult = { written: [], refused: [] };
  for (const f of files) {
    try {
      if (opts.lockTests && isLockedTest(f.path)) throw new Error("acceptance tests are locked");
      const abs = safePath(root, f.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.content);
      res.written.push({ path: relative(root, abs), lines: f.content.split("\n").length - 1, bytes: Buffer.byteLength(f.content) });
    } catch (e) {
      res.refused.push({ path: f.path, reason: (e as Error).message });
    }
  }
  return res;
}

/** Every file in the project except .git and node_modules, as path → content. */
export function readTree(root: string, dir = root, out: Record<string, string> = {}): Record<string, string> {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === "node_modules") continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) readTree(root, abs, out);
    else if (statSync(abs).size < 200_000) out[relative(root, abs)] = readFileSync(abs, "utf8");
  }
  return out;
}

/** Fingerprint of the locked tests, checked before every test run. */
export function testsHash(root: string): string {
  const tree = readTree(root);
  const h = createHash("sha256");
  for (const p of Object.keys(tree).filter(isLockedTest).sort()) h.update(p + "\0" + tree[p] + "\0");
  return h.digest("hex");
}

/** Syntax-check JavaScript files as ES modules; returns one message per broken file. */
export function syntaxErrors(root: string, paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths.filter((x) => /\.(c|m)?js$/.test(x))) {
    // Through stdin as an ES module: `node --check file.js` lets some broken files pass when it cannot tell the module type.
    const r = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: readFileSync(safePath(root, p)), encoding: "utf8" });
    if (r.status !== 0) out.push(`${p}: ${(r.stderr.split("\n").find((l) => /Error/.test(l)) ?? r.stderr).trim().slice(0, 300)}`);
  }
  return out;
}

export function git(root: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=SoftwareFactory", "-c", "user.email=factory@softwarefactory.local", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

export function initRepo(root: string) {
  mkdirSync(root, { recursive: true });
  if (!existsSync(join(root, ".git"))) git(root, "init", "-q", "-b", "main");
}

/** Commit everything; returns the short sha, or null when nothing changed. */
export function commitAll(root: string, message: string): string | null {
  git(root, "add", "-A");
  if (!git(root, "status", "--porcelain")) return null;
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "--short", "HEAD");
}

export interface TestCase { name: string; file: string; pass: boolean; error?: string; durationMs: number }
export interface TestRun { cases: TestCase[]; passed: number; failed: number; exitCode: number | null; timedOut: boolean; output: string }

/** node --test reporter: one JSON line per leaf test. Written to a temp file so it ships inside the compiled core. */
const REPORTER_SRC = `// node --test reporter: one JSON line per leaf test, so the core can draw a pass and fail grid.
export default async function* reporter(source) {
  for await (const event of source) {
    const d = event.data ?? {};
    if (event.type === "test:pass" || event.type === "test:fail") {
      if (d.details?.type === "suite") continue;
      const err = d.details?.error;
      const cause = err?.cause ?? err;
      yield JSON.stringify({
        kind: "case",
        name: d.name,
        file: d.file,
        pass: event.type === "test:pass",
        durationMs: d.details?.duration_ms,
        error: event.type === "test:fail" ? String(cause?.message ?? cause ?? "failed").slice(0, 1500) : undefined,
      }) + "\\n";
    } else if (event.type === "test:stderr" || event.type === "test:stdout") {
      yield JSON.stringify({ kind: event.type.slice(5), message: String(d.message).slice(0, 1500) }) + "\\n";
    }
  }
}
`;
let reporterPath: string | null = null;
function reporter(): string {
  if (!reporterPath || !existsSync(reporterPath)) {
    reporterPath = join(tmpdir(), `sf-jsonl-reporter-${process.pid}.mjs`);
    writeFileSync(reporterPath, REPORTER_SRC);
  }
  return reporterPath;
}

/** Run `node --test` in the project with a JSON-lines reporter, so each test is a cell in the grid. */
export function runTests(root: string, timeoutMs = 60_000): Promise<TestRun> {
  return new Promise((resolve) => {
    // Agents' code runs with a scrubbed environment: no keys or tokens leak in.
    const env = { PATH: process.env.PATH ?? "", HOME: root, NODE_ENV: "test" };
    const child = spawn(process.execPath, ["--test", `--test-reporter=${reporter()}`, "--test-reporter-destination=stdout"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      const cases: TestCase[] = [];
      const notes: string[] = [];
      for (const line of out.split("\n")) {
        if (!line.startsWith("{")) continue;
        try {
          const j = JSON.parse(line);
          if (j.kind === "case") cases.push({ name: j.name, file: j.file ? relative(root, j.file) : "", pass: j.pass, error: j.error, durationMs: j.durationMs ?? 0 });
          else if (j.kind === "stderr" || j.kind === "stdout") notes.push(j.message);
        } catch { /* not ours */ }
      }
      const failed = cases.filter((c) => !c.pass).length;
      // A crash before any test ran (syntax error, missing module) still counts as a failure.
      if (!cases.length && code !== 0) cases.push({ name: "test suite loads", file: "", pass: false, error: (err + notes.join("\n")).slice(0, 2000) || `exit ${code}`, durationMs: 0 });
      resolve({ cases, passed: cases.filter((c) => c.pass).length, failed: cases.filter((c) => !c.pass).length || failed, exitCode: code, timedOut, output: (notes.join("\n") + "\n" + err).trim().slice(0, 4000) });
    });
  });
}
