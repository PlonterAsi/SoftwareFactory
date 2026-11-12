import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EventLog } from "../events.js";
import { runAgent } from "../agents.js";
import type { AgentRuntime } from "../runtime.js";
import type { AgentBay } from "../bay/bay.js";
import { commitAll, git, parseFileBlocks, writeFiles } from "../factory/workspace.js";
import { importOf, moduleNotes } from "../imports/explorer.js";
import { describeSecrets, scanFiles } from "../safety/secrets.js";
import { fastGates } from "../safety/gates.js";
import { describeIntegrity, testIntegrity } from "../safety/testguard.js";
import { stopReason } from "../factory/stoprules.js";
import { WORKBENCH_COMMANDS, WORKBENCH_TOOLS, statusPath, workbenchContract } from "../factory/workbench.js";
import { parseGitHubRepo, type GitHubRepo } from "./github.js";

/**
 * Working a ticket inside an existing codebase (a project imported from a git
 * repo). The rules, from Assaf's design for imported repos:
 *
 *   - the crew works on a new branch, never on main;
 *   - the imported repo itself is never written to: the work happens in a
 *     clone of it in the factory's own folder, so the original stays as it was;
 *   - nothing is pushed anywhere; the ticket says where the branch is and how
 *     to take it, and taking it is the person's call.
 *
 * The Builder gets the ticket's work document and file tools in the clone
 * (Read, Edit, Write, Glob, Grep; no shell). Whatever it writes, or answers as
 * file blocks, is committed on the branch, and the ticket moves to built for
 * your look. It never closes by rule: no locked tests ran.
 */

/** Where a ticket is worked: `dir` is what git clones (a folder, or a remote URL); `github` when it lives on GitHub, so a PR can be opened. */
export interface RepoRef { source: string; dir: string; branch: string | null; github?: GitHubRepo }

export const REPO_CONTRACT = [
  "Station contract: repo. You are working inside an existing code repository: the current folder is a clone on its own branch.",
  "Make the smallest change that does what the ticket asks, in the style of the code around it. Read before you edit.",
  "Do not touch files outside this folder. If you cannot edit files, answer with <<<FILE path ... FILE>>> blocks holding whole files.",
].join("\n");

/** The ticket Builder's workbench: file tools and the shell (factory/workbench.ts), so it runs the tests it touches. */
const TOOLS = WORKBENCH_TOOLS;
const REPO_BENCH = workbenchContract({
  test: "npm test (or npx vitest run <file> inside the package you changed)",
  protect: ["existing tests to make them pass (fix the code instead; add new tests for new behaviour)", "anything under .git"],
  extra: "Dependencies are already installed. Typecheck what you changed (npx tsc --noEmit -p <the package's tsconfig>) before you finish.",
});

/**
 * The repo a project's tickets are worked in: the import's working copy, else
 * a `repo` link that is a folder on this computer, else a `github` link
 * ("owner/name"; SoftwareFactory's own project has one), cloned from GitHub.
 */
export function repoOfProject(log: EventLog, project: number | null): RepoRef | null {
  if (project == null) return null;
  const has = (t: string) => !!log.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const r = has("repo_imports") ? importOf(log, project) : null;
  if (r?.dir && existsSync(join(r.dir, ".git"))) return { source: r.source, dir: r.dir, branch: r.branch ?? null };
  if (has("project_links")) {
    const rows = log.db.prepare("SELECT ref FROM project_links WHERE project_id = ? AND kind = 'repo'").all(project) as { ref: string }[];
    for (const { ref } of rows) if (existsSync(join(ref, ".git"))) return { source: ref, dir: ref, branch: null };
    const gh = log.db.prepare("SELECT ref FROM project_links WHERE project_id = ? AND kind = 'github' ORDER BY rowid LIMIT 1").get(project) as { ref: string } | undefined;
    const g = gh ? parseGitHubRepo(gh.ref) : null;
    if (g) {
      const github = r?.source ? parseGitHubRepo(r.source) ?? g : g;
      return { source: `github.com/${github.owner}/${github.name}`, dir: `https://github.com/${github.owner}/${github.name}.git`, branch: null, github };
    }
  }
  if (r?.source) {
    // An import whose working copy is gone, from GitHub: clone it again from there.
    const g = parseGitHubRepo(r.source);
    if (g) return { source: `github.com/${g.owner}/${g.name}`, dir: `https://github.com/${g.owner}/${g.name}.git`, branch: r.branch ?? null, github: g };
  }
  return null;
}

/** The ticket's branch, named by its key: sf/SF-12-short-title (sf/ticket-12-… outside a project). */
export const branchFor = (key: string, title: string) =>
  `sf/${key.startsWith("#") ? `ticket-${key.slice(1)}` : key}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "work"}`;

/** Make (or reuse) the clone for one ticket and put it on the ticket's branch. Returns the clone folder and the base commit. */
export function prepareClone(repo: RepoRef, workRoot: string, id: number, branch: string, run: (dir: string, ...args: string[]) => string = git): { dir: string; base: string } {
  const dir = resolve(workRoot, `ticket-${id}`);
  mkdirSync(workRoot, { recursive: true });
  if (!existsSync(join(dir, ".git"))) {
    // A plain clone: the original repo gets no worktree entry, branch or file from us.
    run(workRoot, "clone", "-q", "--no-hardlinks", repo.dir, dir);
  } else if (repo.github) {
    // A clone of a GitHub repo starts each pass from the newest main, so a PR does not trail behind.
    try { run(dir, "fetch", "-q", "origin"); } catch { /* offline: work from what the clone has */ }
  }
  const branches = git(dir, "branch", "--list", branch);
  if (branches) git(dir, "checkout", "-q", branch);
  else {
    let from = "HEAD";
    if (repo.github) { try { from = git(dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"); } catch { /* keep HEAD */ } }
    git(dir, "checkout", "-q", "-b", branch, from);
  }
  let base: string;
  try { base = git(dir, "merge-base", "HEAD", "origin/HEAD").slice(0, 12); } catch { base = git(dir, "rev-parse", "--short=12", "HEAD"); }
  return { dir, base };
}

export interface RepoWorkResult { ok: boolean; dir: string; branch: string; base: string; sha: string | null; files: string[]; costUsd: number; summary: string; error?: string; /** The checks that passed (gates, test integrity, tests, review). */ checks?: string[] }

/**
 * The codebase overview the Cartographer and Surveyor already wrote (SF-20): each module's purpose,
 * role and risks, about 1,000 tokens. The Builder starts from it instead of re-exploring the repo.
 */
export function overviewBlock(log: EventLog, projectId: number | null | undefined, maxChars = 4000): string {
  if (projectId == null) return "";
  let notes: ReturnType<typeof moduleNotes>;
  try { notes = moduleNotes(log, projectId); } catch { return ""; }
  if (!notes.size) return "";
  const rank = (r: string) => (r === "core" ? 0 : r === "entry" ? 1 : r === "ui" ? 2 : r === "test" ? 5 : 3);
  const lines = [...notes].sort((a, b) => rank(a[1].role) - rank(b[1].role)).map(([m, x]) => `- ${m} [${x.role}]: ${x.purpose}${x.risks.length ? ` (risks: ${x.risks.slice(0, 2).join("; ")})` : ""}`);
  let out = "";
  for (const l of lines) { if (out.length + l.length > maxChars) break; out += `\n${l}`; }
  return `\n\nCodebase overview (from the Cartographer's map of this repo; start here, then read only what you need):${out}`;
}

/** One check's verdict: `output` is what failed (trimmed before it goes back to the Builder). `skipped`: it could not run, so it is not listed as passed. */
export interface CheckResult { ok: boolean; output: string; skipped?: boolean }

/**
 * The checks of the ticket loop, passed in so they can be swapped (and faked in tests).
 * Each defaults to a pass, except `runTests`, which runs the changed packages' `test` script.
 * Wire in the fast gates (H2), the test integrity guard (H3) and the stop rules (H4) here.
 */
export interface LoopChecks {
  /** Fast gates over the changed files (H2). */
  gates?: (dir: string, files: string[]) => CheckResult | Promise<CheckResult>;
  /** Test integrity guard against the base commit (H3). */
  integrity?: (dir: string, base: string) => CheckResult | Promise<CheckResult>;
  /** A reason to stop fixing, or null (H4). Gets the failing outputs so far and the spend. */
  stopRule?: (s: { round: number; failures: string[]; costUsd: number; maxUsd: number }) => string | null;
  /** The tests that touch the changed files. */
  runTests?: (dir: string, files: string[]) => CheckResult | Promise<CheckResult>;
}

const PASS: CheckResult = { ok: true, output: "" };
const MAX_FIX_ROUNDS = 2;
const trim = (s: string, n = 3000) => (s.length > n ? `…${s.slice(-n)}` : s);

const sh = (cmd: string, args: string[], cwd: string, timeout = 300_000) => spawnSync(cmd, args, { cwd, encoding: "utf8", shell: true, windowsHide: true, timeout });

/** Install a fresh clone's dependencies once (npm ci --ignore-scripts). Returns why it could not, or null. */
export function ensureDeps(dir: string): string | null {
  if (existsSync(join(dir, "node_modules"))) return null;
  if (!existsSync(join(dir, "package-lock.json"))) return "dependencies are not installed and there is no package-lock.json";
  const i = sh("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], dir, 600_000);
  return i.status === 0 ? null : `npm ci failed: ${trim(`${i.stdout ?? ""}\n${i.stderr ?? ""}`, 800)}`;
}

/** The changed files grouped by top-level package (packages/x, apps/x, else "."), paths relative to it. */
function byPackage(files: string[]): Map<string, string[]> {
  const roots = new Map<string, string[]>();
  for (const f of files) {
    const m = f.match(/^((?:packages|apps)\/[^/]+)\//);
    const r = m ? m[1] : ".";
    roots.set(r, [...(roots.get(r) ?? []), m ? f.slice(r.length + 1) : f]);
  }
  return roots;
}

/**
 * The real checks of the ticket loop (SF-23): the fast gates (SF-26) per changed package, so a
 * monorepo's tsconfig is found; the test integrity guard (SF-24); the stop rules (SF-25) over the
 * failures so far and the run's wall clock.
 */
export function harnessChecks(o: { maxMinutes?: number; now?: () => number } = {}): LoopChecks {
  const now = o.now ?? Date.now;
  const startedAt = now();
  return {
    gates: (dir, files) => {
      ensureDeps(dir);
      const out: string[] = [];
      for (const [root, rel] of byPackage(files.filter((f) => existsSync(join(dir, f))))) {
        const g = fastGates(join(dir, root), rel);
        if (!g.ok) out.push(root === "." ? g.messages : `In ${root}:\n${g.messages}`);
      }
      return { ok: !out.length, output: out.join("\n\n") };
    },
    integrity: (dir, base) => {
      const f = testIntegrity(dir, base);
      return { ok: !f.length, output: f.length ? `${describeIntegrity(f)}\nFix the code, not the tests.` : "" };
    },
    // The same failure twice means the fix changed nothing that matters; past the wall clock, stop too.
    stopRule: (s) => stopReason({ rounds: s.failures.map((f) => ({ failing: 1, names: f })), startedAt, now: now(), maxMinutes: o.maxMinutes }),
  };
}

/**
 * Default test run: for each top-level package (packages/x, apps/x, else the root) holding a changed
 * file and having a `test` script, the tests that touch the changed files (`vitest related` when the
 * package uses vitest, else its `test` script). A fresh clone has no dependencies: they are installed
 * once (`npm ci --ignore-scripts`); when that is not possible the check is skipped, never passed.
 */
export function defaultRunTests(dir: string, files: string[]): CheckResult {
  const roots = byPackage(files);
  const withTests = [...roots].filter(([r]) => {
    try { return !!JSON.parse(readFileSync(join(dir, r, "package.json"), "utf8")).scripts?.test; } catch { return false; }
  });
  if (!withTests.length) return { ok: true, output: "no package with a test script holds a changed file", skipped: true };
  const deps = ensureDeps(dir);
  if (deps) return { ok: true, output: `${deps}, so the tests could not run`, skipped: true };
  let out = "";
  for (const [r, changed] of withTests) {
    const cwd = join(dir, r);
    let usesVitest = false;
    try { const pj = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")); usesVitest = /vitest/.test(String(pj.scripts?.test)) || !!pj.devDependencies?.vitest; } catch { /* plain npm test */ }
    const p = usesVitest
      ? sh("npx", ["vitest", "related", "--run", "--passWithNoTests", ...changed.map((f) => JSON.stringify(f))], cwd)
      : sh("npm", ["test", "--silent"], cwd);
    if (p.status !== 0) out += `${usesVitest ? "vitest related" : "npm test"} in ${r} failed:\n${trim(`${p.stdout ?? ""}\n${p.stderr ?? ""}`)}\n`;
  }
  return { ok: !out, output: out };
}

// The git helper trims its output, so the first status line can lose its leading space: parse by pattern, not by column.
const changedFiles = (dir: string) => git(dir, "status", "--porcelain", "--untracked-files=all").split("\n").filter(Boolean).map(statusPath).filter(Boolean);

/** The repo's own guidance for the Builder, trimmed: CLAUDE.md and .claude/rules/*.md. */
export function repoGuidance(dir: string, maxChars = 6000): string {
  const parts: string[] = [];
  const add = (name: string, p: string) => { try { parts.push(`--- ${name} ---\n${readFileSync(p, "utf8").trim()}`); } catch { /* absent */ } };
  add("CLAUDE.md", join(dir, "CLAUDE.md"));
  const rules = join(dir, ".claude", "rules");
  if (existsSync(rules)) for (const f of readdirSync(rules).filter((n) => n.endsWith(".md")).sort()) add(`.claude/rules/${f}`, join(rules, f));
  const text = parts.join("\n\n");
  return text ? `\n\nThis repo's own rules (follow them):\n${text.length > maxChars ? `${text.slice(0, maxChars)}\n…(trimmed)` : text}` : "";
}

/** Bad findings from the Reviewer's JSON answer ({ findings: [{ severity, text }] }): the high ones. */
export function highFindings(text: string): string[] {
  const j = text.match(/```json\s*([\s\S]*?)```/)?.[1] ?? text.match(/\{[\s\S]*\}/)?.[0];
  try {
    const f = (JSON.parse(j ?? "{}") as { findings?: { severity?: string; text?: string }[] }).findings ?? [];
    return f.filter((x) => String(x.severity).toLowerCase() === "high").map((x) => String(x.text ?? "").trim()).filter(Boolean);
  } catch { return []; }
}

/**
 * The ticket loop in the clone: orient (the repo's rules and the code map), build, then the checks
 * (fast gates, test integrity, the tests that touch the changed files). A failure goes back to the
 * Builder with the trimmed output, at most two fix rounds. Then a Reviewer reads the diff; a high
 * finding gets one fix round and the checks again. It commits only when every check passed;
 * otherwise the branch is left uncommitted and the result says what failed. Never pushes.
 * The whole run stays within `maxUsd`: about half for the build, the rest for fixes and review.
 */
export async function workInRepo(log: EventLog, runtime: AgentRuntime, bay: AgentBay | undefined, o: {
  id: number; key: string; title: string; document: string; repo: RepoRef; workRoot: string; maxUsd: number; git?: (dir: string, ...args: string[]) => string; projectId?: number | null; checks?: LoopChecks;
}): Promise<RepoWorkResult> {
  const branch = branchFor(o.key, o.title);
  const { dir, base } = prepareClone(o.repo, o.workRoot, o.id, branch, o.git);
  const c = o.checks ?? {};
  const b = bay?.crewFor("build")[0];
  const rv = bay?.crewFor("review")[0];
  let spent = 0;
  const left = () => Math.max(0, o.maxUsd - spent);
  const step = (name: string, state: "running" | "passed" | "failed" | "skipped", note = "") => {
    log.append("ticket.step", { id: o.id, key: o.key, step: name, state, note: note.slice(0, 500) });
    // The ticket's own timeline on the Bridge shows what did not pass.
    if (state === "failed" || state === "skipped") log.append("ticket.noted", { id: o.id, by: "factory", kind: "event", text: `${name}: ${state}${note ? `. ${note.split("\n").slice(0, 3).join(" ").slice(0, 300)}` : ""}` });
  };
  const fail = (error: string, files: string[] = []): RepoWorkResult => ({ ok: false, dir, branch, base, sha: null, files, costUsd: spent, summary: "", error, checks: passed });
  const passed: string[] = [];
  // One Builder call (the first build, or a fix). `share` is the largest part of the budget it may use.
  const build = async (prompt: string, share: number, name: string) => {
    step(name, "running");
    const run = await runAgent(log, runtime, b?.id ?? "builder", {
      prompt,
      model: b?.model ?? "sonnet",
      systemPrompt: `${b?.role.split("Station contract:")[0].trim() ?? "You are the Builder: you write working code."}\n\n${REPO_CONTRACT}\n${REPO_BENCH}`,
      budgetUsd: Math.min(left(), share, b?.budgetUsd ?? share),
      pluginDirs: b?.pluginDirs.length ? b.pluginDirs : undefined,
      // The working-copy tools, plus the Builder's own skills and MCP servers.
      tools: [...new Set([...TOOLS, ...(b?.tools ?? [])])],
      mcpConfig: b?.mcpConfig,
      cwd: dir,
      commands: WORKBENCH_COMMANDS,
      timeoutMs: 25 * 60_000,
    }, { agentVersion: b?.version, station: "repo", workbench: true });
    spent += run.result?.costUsd ?? 0;
    if (run.error || !run.result) { step(name, "failed", run.error ?? "no reply"); return { text: "", error: run.error ?? "no reply" }; }
    const blocks = parseFileBlocks(run.result.text);
    if (blocks.length) writeFiles(dir, blocks, { lockTests: false });
    step(name, "passed");
    return { text: run.result.text };
  };

  // The Builder runs the tests itself, so the clone's dependencies go in before it starts (once; skipped when present).
  if (o.checks) { const why = ensureDeps(dir); if (why) step("install", "skipped", why); }
  step("orient", "passed", "repo rules and code map added to the prompt");
  const first = await build(`${o.document}\n\nYou are on branch ${branch} of a clone of ${o.repo.source}.${repoGuidance(dir)}${overviewBlock(log, o.projectId)}`, o.maxUsd * 0.5, "build");
  if (first.error) return fail(first.error);
  const summary = first.text.replace(/<<<\s*FILE[\s\S]*?(?:FILE\s*>>>|$)/g, "").trim().split("\n").filter(Boolean).slice(-6).join("\n");

  /** Every check, in order; the first failure comes back as { name, output }. */
  const check = async (): Promise<{ name: string; output: string } | null> => {
    const files = changedFiles(dir);
    // The secret gate (SF-17): nothing that looks like a real key is committed, whatever wrote it.
    const hits = scanFiles(Object.fromEntries(files.filter((f) => existsSync(join(dir, f))).map((f) => [f, readFileSync(join(dir, f), "utf8")])));
    if (hits.length) return { name: "secrets", output: `The change holds what looks like a real secret.\n${describeSecrets(hits)}` };
    const list: [string, () => CheckResult | Promise<CheckResult>][] = [
      ["gates", () => (c.gates ?? (() => PASS))(dir, files)],
      ["test integrity", () => (c.integrity ?? (() => PASS))(dir, base)],
      ["tests", () => (c.runTests ?? defaultRunTests)(dir, files)],
    ];
    for (const [name, fn] of list) {
      step(name, "running");
      const r = await fn();
      if (!r.ok) { step(name, "failed", r.output); return { name, output: r.output }; }
      if (r.skipped) { step(name, "skipped", r.output); continue; }
      step(name, "passed");
      if (!passed.includes(name)) passed.push(name);
    }
    return null;
  };

  // Checks, with at most two fix rounds on a failure.
  const failures: string[] = [];
  let bad = await check();
  for (let round = 1; bad && round <= MAX_FIX_ROUNDS; round++) {
    failures.push(`${bad.name}: ${bad.output}`);
    if (bad.name === "secrets") break;
    const why = c.stopRule?.({ round, failures, costUsd: spent, maxUsd: o.maxUsd }) ?? (left() < o.maxUsd * 0.1 ? "the budget for this ticket is used up" : null);
    if (why) { step("fix", "skipped", why); break; }
    const fixed = await build(`The ${bad.name} check failed on your change to the ticket "${o.title}". Fix the cause (not the check) and change nothing else.\n\n${trim(bad.output)}`, o.maxUsd * 0.15, `fix ${round}`);
    if (fixed.error) break;
    bad = await check();
  }
  if (bad) return fail(`Not committed: ${bad.name} still failing after ${failures.length} round(s).\n${trim(bad.output, 1500)}`, changedFiles(dir));

  // A Reviewer reads the diff; a high finding gets one fix round, then the checks again.
  if (left() > 0) {
    step("review", "running");
    git(dir, "add", "-A");
    const diff = git(dir, "diff", "--cached", "--no-color").slice(0, 20000);
    const rr = await runAgent(log, runtime, rv?.id ?? "reviewer", {
      prompt: `Ticket: ${o.title}\n\nThe diff:\n${diff}`,
      model: rv?.model ?? "sonnet",
      systemPrompt: `You are the Reviewer. Read the diff for bugs, missed requirements and risks, and for gaming the tests: deleted, skipped or weakened tests, tests changed to match wrong output, or expected values hard-coded in the source (each of these is high).\n\nStation contract: review. Answer only with JSON: { "verdict": "pass"|"fail", "findings": [{ "severity": "high"|"medium"|"low", "text": "..." }] }. High means it must be fixed before merge.`,
      budgetUsd: Math.min(left(), o.maxUsd * 0.2, rv?.budgetUsd ?? o.maxUsd),
    }, { agentVersion: rv?.version, station: "review" });
    spent += rr.result?.costUsd ?? 0;
    const high = rr.result ? highFindings(rr.result.text) : [];
    if (rr.error) step("review", "skipped", rr.error);
    else if (!high.length) { step("review", "passed"); passed.push("review"); }
    else {
      step("review", "failed", high.join("; "));
      const fixed = await build(`A reviewer found high-severity problems in your change to "${o.title}". Fix them and change nothing else.\n\n${high.map((h) => `- ${trim(h, 600)}`).join("\n")}`, o.maxUsd * 0.15, "review fix");
      const again = fixed.error ? { name: "review fix", output: fixed.error } : await check();
      if (again) return fail(`Not committed: ${again.name} failed after the review fix.\n${trim(again.output, 1500)}`, changedFiles(dir));
      step("review", "passed", "high findings fixed");
      passed.push("review");
    }
  }

  const sha = commitAll(dir, `${o.key}: ${o.title}\n\nWorked by SoftwareFactory's crew on branch ${branch}.`);
  const files = sha ? git(dir, "diff", "--name-only", `${base}..HEAD`).split("\n").filter(Boolean) : [];
  step("commit", sha ? "passed" : "skipped", sha ?? "nothing changed");
  return { ok: true, dir, branch, base, sha, files, costUsd: spent, summary, checks: passed };
}
