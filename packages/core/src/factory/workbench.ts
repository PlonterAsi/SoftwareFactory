import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentRuntime } from "../runtime.js";
import { git } from "./workspace.js";

/**
 * The workbench: what turns a Builder or Fixer from "write whole files as text and hope" into an
 * agent that works the way an engineer does. It gets the project folder as its working directory,
 * file tools, and a shell limited to the commands it needs to see its own work: run the tests, run
 * the program, read the output. It edits, runs, reads the failure, fixes, and runs again, inside
 * one call, until the tests pass or its cap is spent.
 *
 * The core never takes its word for it: after the call the core puts back anything the agent may
 * not change (the locked tests, the kit), then runs every check itself. The agent's own runs are
 * how it finds the problem; the core's runs are the verdict.
 *
 * Why (run 2366, 2026-11-12): the Fixer, with read-only tools, answered twice "I can't run
 * node --test here and the failure output you gave me is empty; please paste it", and was paid
 * $0.39 to change nothing.
 */

/** File tools plus the shell. */
export const WORKBENCH_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash"];

/**
 * Commands the agent may run without a prompt, as Claude Code allow rules (`Bash(prefix:*)`).
 * Anything else is refused headless. `node` runs the project's own code, which the core already
 * does on every test round, so it adds no new kind of risk. No network tools, no installs, no git
 * writes, nothing outside the folder by design of the working directory.
 */
export const WORKBENCH_COMMANDS = [
  "node", "npm test", "npm run test", "npm run build", "npm run lint", "npm run typecheck", "npx tsc", "npx vitest", "npx eslint",
  "ls", "dir", "cat", "type", "head", "tail", "wc", "grep", "find", "pwd", "echo",
  "git status", "git diff", "git log", "git show",
];

/** Can this runtime give an agent a workbench? Only a real Claude Code crew; the practice crew answers in file blocks. */
export function hasWorkbench(runtime: AgentRuntime): boolean {
  const r = (runtime as { current?: AgentRuntime }).current ?? runtime;
  return r.name.startsWith("claude-code");
}

/** The contract added to a station agent that has the workbench. */
export function workbenchContract(o: { test: string; protect: string[]; extra?: string }): string {
  return [
    "You have a workbench: the current folder is the project, you can edit files with Edit and Write, and you have a shell for these commands: " + WORKBENCH_COMMANDS.join(", ") + ".",
    "Work in a loop until it is done: make the change, run the tests yourself (`" + o.test + "`), read every failure in full, find the cause, fix it, and run them again. Do not stop at the first green run if you changed something after it; run them once more at the end.",
    "When a test fails, read the error and the stack before you change anything. If the output is unclear, run the one failing file directly with node to see the raw error.",
    `Never change ${o.protect.join(" or ")}: they are locked and the core puts them back. If you are sure a locked test itself is wrong (it cannot pass for any correct code), do not work around it: end your answer with one line \`TEST_WRONG: <file>: <the evidence>\`.`,
    "Write files with the tools, not as text in your answer. Do not run git commands that change anything, and do not install packages.",
    ...(o.extra ? [o.extra] : []),
    "End with at most 6 short lines: what was wrong, what you changed, and the last test result you saw (pass and fail counts).",
  ].join("\n");
}

/** The path in one `git status --porcelain` line. The git helper trims its output, so the first line may have lost its leading space. */
export const statusPath = (line: string) => line.replace(/^[ MADRCU?!T]{1,2} /, "").trim().replace(/^"|"$/g, "").replace(/^.* -> /, "");

/** Files changed in the folder since the last commit (tracked and new), as posix paths. */
export function changedFiles(dir: string): string[] {
  return git(dir, "status", "--porcelain", "--untracked-files=all").split("\n").filter(Boolean).map(statusPath);
}

/**
 * Put back what the agent may not change: tracked files under the protected paths go back to the
 * last commit, new files there are removed. Returns the paths that had to be put back.
 */
export function restoreProtected(dir: string, isProtected: (p: string) => boolean): string[] {
  const touched = changedFiles(dir).filter(isProtected);
  restoreFromHead(dir, touched);
  return touched;
}

/**
 * Put files back exactly as the last commit holds them, byte for byte. Not `git checkout`: with
 * core.autocrlf (Git for Windows' default) that writes CRLF, and the locked tests' fingerprint no longer
 * matches ("The locked acceptance tests were changed"). Files the commit does not have are removed.
 */
export function restoreFromHead(dir: string, paths: string[]): void {
  for (const p of paths) {
    const r = spawnSync("git", ["cat-file", "blob", `HEAD:${p}`], { cwd: dir, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    const abs = join(dir, p);
    if (r.status === 0) { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, r.stdout); }
    else if (existsSync(abs)) rmSync(abs, { force: true, recursive: true });
  }
}

/** What the agent left on disk, in the shape of a writeFiles result (so the heat map draws it). */
export function writtenOnDisk(dir: string, paths: string[]): { path: string; lines: number; bytes: number; sha256: string }[] {
  const out: { path: string; lines: number; bytes: number; sha256: string }[] = [];
  for (const p of paths) {
    const abs = join(dir, p);
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    const content = readFileSync(abs);
    out.push({ path: p, lines: content.toString("utf8").split("\n").length - 1, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") });
  }
  return out;
}

/** The `TEST_WRONG: file: evidence` line an agent ends with when it believes a locked test is wrong. */
export function testDispute(text: string): { file: string; evidence: string } | null {
  const m = text.match(/^\s*TEST_WRONG:\s*([^:\n]+?):\s*(.+)$/m);
  return m ? { file: m[1].trim().replace(/^`|`$/g, ""), evidence: m[2].trim().slice(0, 1500) } : null;
}

/** The last lines of an agent's answer, without file blocks: what it says it did. */
export function answerSummary(text: string, lines = 6): string {
  return text.replace(/<<<\s*FILE[\s\S]*?(?:FILE\s*>>>|$)/g, "").trim().split("\n").map((l) => l.trim()).filter(Boolean).slice(-lines).join("\n").slice(0, 800);
}
