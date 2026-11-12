import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { failureLines } from "../factory/trim.js";
import { syntaxErrors } from "../factory/workspace.js";
import { describeSecrets, scanFiles } from "./secrets.js";

/**
 * Fast gates (SF-26): cheap, free checks that run after every build or fix, before the slower test run.
 * In order, stopping at the first failure: syntax, tsc --noEmit, lint, secret scan.
 * A missing tool skips its gate with a note; it never fails the step. No AI call.
 */
export type GateName = "syntax" | "tsc" | "lint" | "secrets";
export interface GateResult { gate: GateName; state: "pass" | "fail" | "skipped"; note?: string; messages: string[] }
export interface FastGates { ok: boolean; results: GateResult[]; /** What the agent reads: file:line and what to fix. Empty when ok. */ messages: string }

const run = (cmd: string, args: string[], cwd: string) =>
  spawnSync(cmd, args, { cwd, encoding: "utf8", windowsHide: true, timeout: 120_000, shell: process.platform === "win32" });

/** The local binary of a tool (node_modules/.bin), or null. */
const localBin = (dir: string, name: string) => {
  const p = join(dir, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
  return existsSync(p) ? p : null;
};

function readJson(file: string): any { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } }

/** Lines of tool output that name a file and line, trimmed to the failing ones. */
function toolMessages(output: string): string[] {
  const t = failureLines(output, 40, 2000);
  return t ? t.split("\n").filter(Boolean) : [];
}

export function fastGates(dir: string, files: string[]): FastGates {
  const results: GateResult[] = [];
  const done = (r: GateResult) => { results.push(r); return r.state === "fail"; };
  const finish = (): FastGates => {
    const bad = results.find((r) => r.state === "fail");
    return { ok: !bad, results, messages: bad ? `Fast check "${bad.gate}" failed. Fix this first:\n${bad.messages.join("\n")}` : "" };
  };

  // 1. Syntax of the changed JavaScript files.
  const broken = syntaxErrors(dir, files.filter((f) => /\.[cm]?js$/.test(f) && existsSync(join(dir, f))));
  if (done({ gate: "syntax", state: broken.length ? "fail" : "pass", messages: broken.map((b) => `${b} (syntax error: fix it)`) })) return finish();

  // 2. tsc --noEmit, when the folder is a TypeScript project.
  if (!existsSync(join(dir, "tsconfig.json"))) done({ gate: "tsc", state: "skipped", note: "no tsconfig.json", messages: [] });
  else {
    const bin = localBin(dir, "tsc");
    const r = bin ? run(bin, ["--noEmit", "--pretty", "false"], dir) : run("tsc", ["--noEmit", "--pretty", "false"], dir);
    if (r.error || (!bin && r.status !== 0 && /not (found|recognized)|ENOENT/i.test(`${r.stderr}${r.stdout}`))) done({ gate: "tsc", state: "skipped", note: "tsc is not installed", messages: [] });
    else if (done({ gate: "tsc", state: r.status === 0 ? "pass" : "fail", messages: r.status === 0 ? [] : toolMessages(`${r.stdout}\n${r.stderr}`) })) return finish();
  }

  // 3. lint, when the folder has a lint script or an eslint config.
  const pkg = readJson(join(dir, "package.json"));
  const script = typeof pkg?.scripts?.lint === "string" ? pkg.scripts.lint : null;
  const eslintCfg = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", ".eslintrc", ".eslintrc.js", ".eslintrc.json", ".eslintrc.cjs"].some((f) => existsSync(join(dir, f)));
  if (!script && !eslintCfg) done({ gate: "lint", state: "skipped", note: "no lint script or config", messages: [] });
  else if (!script && !localBin(dir, "eslint")) done({ gate: "lint", state: "skipped", note: "eslint is not installed", messages: [] });
  else if (script && !existsSync(join(dir, "node_modules"))) done({ gate: "lint", state: "skipped", note: "dependencies are not installed", messages: [] });
  else {
    const r = script ? run("npm", ["run", "--silent", "lint"], dir) : run(localBin(dir, "eslint")!, ["--format", "unix", ...files.filter((f) => /\.[cm]?[jt]sx?$/.test(f))], dir);
    if (r.error) done({ gate: "lint", state: "skipped", note: "the lint tool could not start", messages: [] });
    else if (done({ gate: "lint", state: r.status === 0 ? "pass" : "fail", messages: r.status === 0 ? [] : toolMessages(`${r.stdout}\n${r.stderr}`) })) return finish();
  }

  // 4. The secret scan (SF-17) on the changed files.
  const texts: Record<string, string> = {};
  for (const f of files) { try { if (existsSync(join(dir, f))) texts[f] = readFileSync(join(dir, f), "utf8"); } catch { /* a folder or unreadable file */ } }
  const hits = scanFiles(texts);
  done({ gate: "secrets", state: hits.length ? "fail" : "pass", messages: hits.length ? [...describeSecrets(hits).split("\n"), "Read keys from an environment variable instead."] : [] });
  return finish();
}
