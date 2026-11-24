import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { git, runAsync } from "../factory/workspace.js";

/**
 * The crew's test step, made fair (24 Nov audit: 31 of 34 crew test steps failed, and the Builder's fix rounds were
 * shown only the tail of the output, which was Node's "SQLite is experimental" warnings, never the failing test).
 *
 * 1. The tests that touch the change run with a JSON report and Node's warnings off, so each failure is a named test
 *    with its message.
 * 2. Tests that failed run once more: one that passes the second time is flaky, not the change's fault.
 * 3. Tests that still fail run on the base (the change stashed): one that fails there too was already broken on main.
 * Only failures the change brought are held against it; the rest are named in the note so nobody loses them.
 */
export interface FailedTest { file: string; name: string; message: string }
export interface VitestRun { status: number | null; failures: FailedTest[] | null; raw: string }
export type VitestRunner = (cwd: string, args: string[]) => Promise<VitestRun>;

/** Node and vitest, quiet and colourless, so what comes back is the tests. */
export const QUIET_ENV = { NODE_NO_WARNINGS: "1", FORCE_COLOR: "0", NO_COLOR: "1" };

/** The failing tests in a vitest JSON report; null when the report is not one. A file that failed to load counts as one failure. */
export function vitestFailures(json: string, root: string): FailedTest[] | null {
  let r: { testResults?: { name?: string; status?: string; message?: string; assertionResults?: { status?: string; fullName?: string; title?: string; failureMessages?: string[] }[] }[] };
  try { r = JSON.parse(json); } catch { return null; }
  if (!r || !Array.isArray(r.testResults)) return null;
  const out: FailedTest[] = [];
  for (const t of r.testResults) {
    const file = relative(root, t.name ?? "").replace(/\\/g, "/") || String(t.name ?? "");
    const failed = (t.assertionResults ?? []).filter((a) => a.status === "failed");
    for (const a of failed) out.push({ file, name: a.fullName || a.title || "(unnamed test)", message: clean(a.failureMessages?.[0] ?? "") });
    if (!failed.length && t.status === "failed") out.push({ file, name: "(the file failed to run)", message: clean(t.message ?? "") });
  }
  return out;
}

const clean = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "").split("\n").filter((l) => !/ExperimentalWarning|--trace-warnings|DEP0\d+|node_modules|at new Promise|^\s*at (async )?\S+ \(node:/.test(l)).slice(0, 12).join("\n").slice(0, 900);
const key = (f: FailedTest) => `${f.file}\u0000${f.name}`;

/** Failures as the Builder should read them: which test, in which file, and its message. */
export function describeFailures(list: FailedTest[]): string {
  return list.slice(0, 15).map((f) => `× ${f.file} › ${f.name}${f.message ? `\n    ${f.message.split("\n").join("\n    ")}` : ""}`).join("\n") + (list.length > 15 ? `\n…and ${list.length - 15} more` : "");
}

/** Raw output with Node's warning lines and colours taken out, newest last; for when no JSON report came back. */
export function quietTail(raw: string, n = 3000): string {
  const s = raw.replace(/\u001b\[[0-9;]*m/g, "").split("\n").filter((l) => !/ExperimentalWarning|--trace-warnings|--trace-deprecation|DEP0\d+|Passing args to a child process/.test(l)).join("\n").trim();
  return s.length > n ? `…${s.slice(-n)}` : s;
}

/** Run vitest with a JSON report into a temporary file. */
export const runVitest: VitestRunner = async (cwd, args) => {
  const tmp = mkdtempSync(join(tmpdir(), "sf-vitest-"));
  const out = join(tmp, "report.json");
  try {
    const p = await runAsync("npx", ["vitest", ...args, "--reporter=json", `--outputFile=${JSON.stringify(out)}`], { cwd, shell: true, timeout: 300_000, env: { ...process.env, ...QUIET_ENV } });
    let json = "";
    try { json = readFileSync(out, "utf8"); } catch { /* no report: vitest did not get that far */ }
    return { status: p.status, failures: json ? vitestFailures(json, cwd) : null, raw: `${p.stdout ?? ""}\n${p.stderr ?? ""}` };
  } finally { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }
};

export interface RecheckResult { ok: boolean; output: string; flaky: FailedTest[]; preexisting: FailedTest[]; blamed: FailedTest[] }

/**
 * The tests that touch `changed` in package folder `cwd` (inside the clone `repoDir`), judged fairly: see the file note.
 * `stash` swaps the change out and back in for the base run; it is git by default and swapped out in tests.
 */
export async function testsWithRecheck(repoDir: string, cwd: string, changed: string[], o: { run?: VitestRunner; stash?: { out: () => void; back: () => void } } = {}): Promise<RecheckResult> {
  const run = o.run ?? runVitest;
  const first = await run(cwd, ["related", "--run", "--passWithNoTests", ...changed.map((f) => JSON.stringify(f))]);
  if (first.status === 0) return { ok: true, output: "", flaky: [], preexisting: [], blamed: [] };
  if (!first.failures?.length) {
    // No report, or a failing exit with no failed test in it: hand over the output with the noise taken out.
    return { ok: false, output: quietTail(first.raw), flaky: [], preexisting: [], blamed: [] };
  }
  const files = [...new Set(first.failures.map((f) => f.file))];
  // 2. Once more: what passes now was flaky.
  const again = await run(cwd, ["run", "--passWithNoTests", ...files.map((f) => JSON.stringify(f))]);
  const againKeys = new Set((again.failures ?? first.failures).map(key));
  const still = again.status === 0 ? [] : first.failures.filter((f) => againKeys.has(key(f)));
  const flaky = first.failures.filter((f) => !still.includes(f));
  if (!still.length) return { ok: true, output: note(flaky, []), flaky, preexisting: [], blamed: [] };
  // 3. On the base: what fails there too was already broken.
  const stash = o.stash ?? {
    out: () => { git(repoDir, "stash", "push", "--include-untracked", "-m", "sf-baseline-check"); },
    back: () => { git(repoDir, "stash", "pop"); },
  };
  let baseKeys = new Set<string>();
  let swapped = false;
  try {
    stash.out(); swapped = true;
    const stillFiles = [...new Set(still.map((f) => f.file))];
    const base = await run(cwd, ["run", "--passWithNoTests", ...stillFiles.map((f) => JSON.stringify(f))]);
    if (base.status !== 0 && base.failures) baseKeys = new Set(base.failures.map(key));
  } catch { /* the base could not run: hold every remaining failure against the change */ }
  finally { if (swapped) stash.back(); }
  const preexisting = still.filter((f) => baseKeys.has(key(f)));
  const blamed = still.filter((f) => !baseKeys.has(key(f)));
  if (!blamed.length) return { ok: true, output: note(flaky, preexisting), flaky, preexisting, blamed };
  return { ok: false, output: `${describeFailures(blamed)}${note(flaky, preexisting) ? `\n\n${note(flaky, preexisting)}` : ""}`, flaky, preexisting, blamed };
}

function note(flaky: FailedTest[], pre: FailedTest[]): string {
  return [
    flaky.length ? `Flaky, not held against the change (failed once, passed on a second run): ${flaky.map((f) => `${f.file} › ${f.name}`).join("; ")}.` : "",
    pre.length ? `Already failing on the base before this change, not held against it: ${pre.map((f) => `${f.file} › ${f.name}`).join("; ")}.` : "",
  ].filter(Boolean).join("\n");
}
