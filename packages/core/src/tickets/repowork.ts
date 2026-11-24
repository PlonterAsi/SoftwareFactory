import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EventLog } from "../events.js";
import { runAgent } from "../agents.js";
import type { AgentRuntime } from "../runtime.js";
import type { AgentBay } from "../bay/bay.js";
import { commitAll, git, parseFileBlocks, runAsync, writeFiles } from "../factory/workspace.js";
import { importOf, moduleNotes } from "../imports/explorer.js";
import { reviewBrief } from "../imports/review.js";
import { describeSecrets, scanFiles } from "../safety/secrets.js";
import { fastGates } from "../safety/gates.js";
import { describeIntegrity, testIntegrity } from "../safety/testguard.js";
import { stopReason } from "../factory/stoprules.js";
import { WORKBENCH_COMMANDS, WORKBENCH_TOOLS, statusPath, workbenchContract } from "../factory/workbench.js";
import { parseGitHubRepo, type GitHubRepo } from "./github.js";
import { SMALL_CHANGE_FLOW, crewPick, roundsOf, stepsToRun, type FlowDef } from "../flows/flow.js";
import { noteLesson } from "../bay/memory.js";
import { isClosed, type TicketView } from "./model.js";
import { VERIFY_ASK } from "./verify.js";
import { QUIET_ENV, quietTail, testsWithRecheck } from "./testrecheck.js";

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
  VERIFY_ASK,
].join("\n");

/** The ticket Builder's workbench: file tools and the shell (factory/workbench.ts), so it runs the tests it touches. */
const TOOLS = WORKBENCH_TOOLS;
const REPO_BENCH = workbenchContract({
  test: "npm test (or npx vitest run <file> inside the package you changed)",
  protect: ["existing tests to make them pass (fix the code instead; add new tests for new behaviour)", "anything under .git"],
  extra: "Dependencies are already installed. Typecheck what you changed (npx tsc --noEmit -p <the package's tsconfig>) before you finish.",
});

/**
 * The repo a project's tickets are worked in: the import's working copy (with
 * `github` when it was imported from there, so its branches can be sent), else
 * a `repo` link that is a folder on this computer, else a `github` link
 * ("owner/name"; SoftwareFactory's own project has one), cloned from GitHub.
 */
export function repoOfProject(log: EventLog, project: number | null): RepoRef | null {
  if (project == null) return null;
  const has = (t: string) => !!log.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const r = has("repo_imports") ? importOf(log, project) : null;
  if (r?.dir && existsSync(join(r.dir, ".git"))) {
    // Imported from GitHub: it is worked from the copy on this computer (no sign-in needed), and its branches go to GitHub.
    const github = r.local ? null : parseGitHubRepo(r.source);
    return { source: r.source, dir: r.dir, branch: r.branch ?? null, ...(github ? { github } : {}) };
  }
  if (has("project_links")) {
    const rows = log.db.prepare("SELECT ref FROM project_links WHERE project_id = ? AND kind = 'repo'").all(project) as { ref: string }[];
    const gh = log.db.prepare("SELECT ref FROM project_links WHERE project_id = ? AND kind = 'github' ORDER BY rowid LIMIT 1").get(project) as { ref: string } | undefined;
    // A folder on this computer; once published (docs/git.md) its branches go to the GitHub repo it was sent to.
    const published = gh ? parseGitHubRepo(gh.ref) : null;
    for (const { ref } of rows) if (existsSync(join(ref, ".git"))) return { source: ref, dir: ref, branch: null, ...(published ? { github: published } : {}) };
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

/** A sibling ticket's branch, not on main yet, that this ticket's clone builds on (SF-29). */
export interface StackBranch { key: string; branch: string; dir: string }

/**
 * SF-29: the work of a ticket's siblings that is not on main yet, so a line of a plan builds on the lines before it
 * instead of beside them (19 Nov: the Scout slices SF-60 to SF-63 each needed the one before, and each clone started
 * from main without it). Siblings are the tickets under the same parent, in the plan's order; only the ones before
 * this ticket count, so two tickets never build on each other. A sibling counts while its branch is still the
 * crew's: built for your look or with an open pull request, never closed, never merged (merged work is on main).
 */
export function siblingStack(lines: Pick<TicketView, "id" | "key" | "status" | "branch" | "branchDir" | "pr">[], id: number): StackBranch[] {
  const i = lines.findIndex((x) => x.id === id);
  if (i <= 0) return [];
  return lines.slice(0, i)
    .filter((s) => s.branch && s.branchDir && !isClosed(s.status) && (s.status === "built" || s.pr?.state === "open") && s.pr?.state !== "merged" && s.pr?.state !== "closed" && existsSync(join(s.branchDir, ".git")))
    .map((s) => ({ key: s.key, branch: s.branch!, dir: s.branchDir! }));
}

/** What a clone took from its siblings: the branches merged in, and the ones left out with why. */
export interface Stacked { merged: string[]; skipped: { key: string; why: string }[] }

/**
 * A clone with a commit to stand on: false for one a cut-off `git clone` left behind, which may have fetched
 * origin's branches but never checked anything out (no HEAD commit, no local branch, no origin/HEAD).
 */
function hasCommit(dir: string): boolean {
  try { git(dir, "rev-parse", "--verify", "-q", "HEAD^{commit}"); return true; } catch { /* unborn HEAD */ }
  try { return git(dir, "for-each-ref", "--count=1", "refs/heads") !== ""; } catch { return false; }
}

/**
 * Make (or reuse) the clone for one ticket and put it on the ticket's branch. Returns the clone folder and the base
 * commit. `stack`: sibling branches to merge in first (SF-29), each from its own clone; one that does not merge
 * cleanly is left out (the merge is undone) and named in `stacked.skipped`. With a stack the base is the commit after
 * those merges, so the ticket's changed files and the test integrity guard cover only its own work.
 */
export function prepareClone(repo: RepoRef, workRoot: string, id: number, branch: string, run: (dir: string, ...args: string[]) => string = git, folder = `ticket-${id}`, stack: StackBranch[] = []): { dir: string; base: string; stacked: Stacked } {
  const dir = resolve(workRoot, folder);
  mkdirSync(workRoot, { recursive: true });
  // SF-94: a clone the app was cut off in the middle of (a restart, the PC asleep) has a .git but no commit, and every
  // later pass failed on "HEAD is not a commit". It holds no work, so it is moved aside (never deleted) and cloned again.
  if (existsSync(join(dir, ".git")) && !hasCommit(dir)) renameSync(dir, `${dir}.broken-${Date.now()}`);
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
  const stacked: Stacked = { merged: [], skipped: [] };
  let fresh = 0;
  for (const s of stack) {
    if (resolve(s.dir) === dir) continue;
    try {
      git(dir, "fetch", "-q", s.dir, `${s.branch}`);
      // Already in (an earlier pass took it, or main has it): nothing to do.
      try { git(dir, "merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"); stacked.merged.push(s.key); continue; } catch { /* not in yet */ }
      // Always a merge commit, never a fast-forward: the first-parent line then holds only this ticket's own commits.
      git(dir, "merge", "-q", "--no-ff", "--no-edit", "-m", `Build on ${s.key} (${s.branch}), not merged yet`, "FETCH_HEAD");
      stacked.merged.push(s.key);
      fresh++;
    } catch (e) {
      try { git(dir, "merge", "--abort"); } catch { /* no merge was started */ }
      const msg = (e as Error).message;
      stacked.skipped.push({ key: s.key, why: /conflict/i.test(msg) ? "it conflicts with this ticket's branch" : msg.split("\n")[0].slice(0, 200) });
    }
  }
  // The base this ticket's own work is measured from, kept in the clone's git config so a later pass finds it again.
  // A pass that merged a sibling in, before the ticket has work of its own, moves the base to just after it; once
  // the ticket has its own commits the base stays put, so they are never dropped (a sibling taken later then shows
  // in this ticket's changed files too, which only widens what the gates look at).
  const key = `branch.${branch}.sfbase`;
  let kept = "";
  try { kept = git(dir, "config", "--get", key); } catch { /* no stacked pass yet */ }
  // Down the first-parent line only: the commits a sibling brought in are not this ticket's own.
  const ownWork = (from: string) => git(dir, "rev-list", "--count", "--no-merges", "--first-parent", `${from}..HEAD`) !== "0";
  let base = kept;
  if (fresh && (!kept || !ownWork(kept))) {
    let main = "";
    try { main = git(dir, "merge-base", "HEAD", "origin/HEAD"); } catch { /* no origin */ }
    // Commits of the ticket's own from before any stacking (an earlier unstacked pass) keep the main base.
    const before = !kept && main ? git(dir, "rev-list", "--count", "--no-merges", "--first-parent", `${main}..HEAD`) !== "0" : false;
    base = before ? main.slice(0, 12) : git(dir, "rev-parse", "--short=12", "HEAD");
    git(dir, "config", key, base);
  }
  if (!base) { try { base = git(dir, "merge-base", "HEAD", "origin/HEAD").slice(0, 12); } catch { base = git(dir, "rev-parse", "--short=12", "HEAD"); } }
  return { dir, base, stacked };
}

export interface RepoWorkResult { /** The Builder's whole first answer (its "How to verify" steps). */ builderText?: string; ok: boolean; dir: string; branch: string; base: string; sha: string | null; files: string[]; costUsd: number; summary: string; error?: string; /** The checks that passed (gates, test integrity, tests, review). */ checks?: string[]; /** The flow ends with a draft PR step (false: the branch stays here by the flow's choice). */ handover?: boolean }

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
/** Check output leads with what failed (tickets/testrecheck.ts), so its head is kept. */
const head = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…` : s);

// Never spawnSync here: a test run takes minutes, and a blocked core answers nothing meanwhile (20 Nov).
const sh = (cmd: string, args: string[], cwd: string, timeout = 300_000) => runAsync(cmd, args, { cwd, shell: true, timeout });

/** Install a fresh clone's dependencies once (npm ci --ignore-scripts). Returns why it could not, or null. */
export async function ensureDeps(dir: string): Promise<string | null> {
  if (existsSync(join(dir, "node_modules"))) return null;
  if (!existsSync(join(dir, "package-lock.json"))) return "dependencies are not installed and there is no package-lock.json";
  const i = await sh("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], dir, 600_000);
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
    gates: async (dir, files) => {
      await ensureDeps(dir);
      const out: string[] = [];
      for (const [root, rel] of byPackage(files.filter((f) => existsSync(join(dir, f))))) {
        const g = await fastGates(join(dir, root), rel);
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
export async function defaultRunTests(dir: string, files: string[]): Promise<CheckResult> {
  const roots = byPackage(files);
  const withTests = [...roots].filter(([r]) => {
    try { return !!JSON.parse(readFileSync(join(dir, r, "package.json"), "utf8")).scripts?.test; } catch { return false; }
  });
  if (!withTests.length) return { ok: true, output: "no package with a test script holds a changed file", skipped: true };
  const deps = await ensureDeps(dir);
  if (deps) return { ok: true, output: `${deps}, so the tests could not run`, skipped: true };
  let out = "";
  const ran: string[] = [];
  const notes: string[] = [];
  for (const [r, changed] of withTests) {
    const cwd = join(dir, r);
    let usesVitest = false;
    try { const pj = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")); usesVitest = /vitest/.test(String(pj.scripts?.test)) || !!pj.devDependencies?.vitest; } catch { /* plain npm test */ }
    if (usesVitest) {
      // Named failures, a second run for flaky ones, and the base for ones already broken (tickets/testrecheck.ts).
      const t = await testsWithRecheck(dir, cwd, changed);
      if (!t.ok) out += `vitest related in ${r} failed:\n${t.output}\n`;
      else { ran.push(`cd ${r} && npx vitest related --run ${changed.join(" ")}`); if (t.output) notes.push(t.output); }
      continue;
    }
    const p = await runAsync("npm", ["test", "--silent"], { cwd, shell: true, timeout: 300_000, env: { ...process.env, ...QUIET_ENV } });
    if (p.status !== 0) out += `npm test in ${r} failed:\n${quietTail(`${p.stdout ?? ""}\n${p.stderr ?? ""}`)}\n`;
    else ran.push(`cd ${r} && npm test`);
  }
  return { ok: !out, output: out || [...ran, ...notes].join("\n") };
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
  /** The session flow to follow (flows/flow.ts): its steps in order, its fix round limits, its brief. Default: Small change. */
  flow?: FlowDef;
  /** Sibling tickets' branches, not merged yet, to build on (SF-29; siblingStack()). */
  stack?: StackBranch[];
}): Promise<RepoWorkResult> {
  const flow = o.flow ?? SMALL_CHANGE_FLOW;
  const branch = branchFor(o.key, o.title);
  const { dir, base, stacked } = prepareClone(o.repo, o.workRoot, o.id, branch, o.git, undefined, o.stack ?? []);
  if (stacked.merged.length || stacked.skipped.length) {
    log.append("ticket.noted", { id: o.id, by: "factory", kind: "event", stacked: stacked.merged, text: [
      stacked.merged.length ? `Built on ${stacked.merged.join(", ")}: their work is not on main yet, so it was merged into ${branch} first. This ticket's pull request shows their changes too until they merge.` : "",
      ...stacked.skipped.map((x) => `Not built on ${x.key}: ${x.why}.`),
    ].filter(Boolean).join(" ") });
  }
  const stackNote = stacked.merged.length ? `\n\nThis branch already holds the work of ${stacked.merged.join(", ")} (earlier tickets of the same plan, not merged yet). Build on it; do not redo or undo it.` : "";
  const c = o.checks ?? {};
  // The agents the flow names for Build and Review, else whoever works those stations in the Bay.
  const b = bay?.crewFor("build", crewPick(flow, "build"))[0];
  const rv = bay?.crewFor("review", crewPick(flow, "review"))[0];
  let spent = 0;
  const left = () => Math.max(0, o.maxUsd - spent);
  const step = (name: string, state: "running" | "passed" | "failed" | "skipped", note = "") => {
    log.append("ticket.step", { id: o.id, key: o.key, step: name, state, note: note.slice(0, 500) });
    // The ticket's own timeline on the Bridge shows what did not pass.
    if (state === "failed" || state === "skipped") log.append("ticket.noted", { id: o.id, by: "factory", kind: "event", step: name, text: `${name}: ${state}${note ? `. ${note.split("\n").slice(0, 3).join(" ").slice(0, 300)}` : ""}` });
  };
  const fail = (error: string, files: string[] = []): RepoWorkResult => ({ ok: false, dir, branch, base, sha: null, files, costUsd: spent, summary: "", error, checks: passed });
  const passed: string[] = [];
  // One Builder call (the first build, or a fix). `share` is the largest part of the budget it may use.
  const build = async (prompt: string, share: number, name: string) => {
    step(name, "running");
    const run = await runAgent(log, runtime, b?.id ?? "builder", {
      prompt,
      model: b?.model ?? "sonnet",
      systemPrompt: `${b?.role.split("Station contract:")[0].trim() ?? "You are the Builder: you write working code."}\n\n${REPO_CONTRACT}\n${flow.brief ? `${flow.brief}\n` : ""}${REPO_BENCH}`,
      budgetUsd: Math.min(left(), share, b?.budgetUsd ?? share),
      pluginDirs: b?.pluginDirs.length ? b.pluginDirs : undefined,
      // The working-copy tools, plus the Builder's own skills and MCP servers.
      tools: [...new Set([...TOOLS, ...(b?.tools ?? [])])],
      mcpConfig: b?.mcpConfig,
      cwd: dir,
      commands: WORKBENCH_COMMANDS,
      timeoutMs: 25 * 60_000,
    }, { agentVersion: b?.version, station: "repo", workbench: true, ticket: o.id });
    spent += run.result?.costUsd ?? 0;
    if (run.error || !run.result) { step(name, "failed", run.error ?? "no reply"); return { text: "", error: run.error ?? "no reply" }; }
    const blocks = parseFileBlocks(run.result.text);
    if (blocks.length) writeFiles(dir, blocks, { lockTests: false });
    step(name, "passed");
    return { text: run.result.text };
  };

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
      // What ran goes on the step, so the ticket's verification can say how it was tested.
      step(name, "passed", r.output);
      if (!passed.includes(name)) passed.push(name);
    }
    return null;
  };

  /** A Reviewer reads the diff. */
  const review = async (): Promise<{ error?: string; high: string[] }> => {
    step("review", "running");
    git(dir, "add", "-A");
    const diff = git(dir, "diff", "--cached", "--no-color").slice(0, 20000);
    const rr = await runAgent(log, runtime, rv?.id ?? "reviewer", {
      prompt: `Ticket: ${o.title}\n\nThe diff:\n${diff}`,
      model: rv?.model ?? "sonnet",
      systemPrompt: `${rv?.memory ? `${rv.memory}\n\n` : ""}You are the Reviewer. Read the diff for bugs, missed requirements and risks, and for gaming the tests: deleted, skipped or weakened tests, tests changed to match wrong output, or expected values hard-coded in the source (each of these is high).${flow.brief ? `\n\nThe work was asked for this way: ${flow.brief}` : ""}\n\nStation contract: review. Answer only with JSON: { "verdict": "pass"|"fail", "findings": [{ "severity": "high"|"medium"|"low", "text": "..." }] }. High means it must be fixed before merge.`,
      budgetUsd: Math.min(left(), o.maxUsd * 0.2, rv?.budgetUsd ?? o.maxUsd),
    }, { agentVersion: rv?.version, station: "review", ticket: o.id });
    spent += rr.result?.costUsd ?? 0;
    return { error: rr.error, high: rr.result ? highFindings(rr.result.text) : [] };
  };

  // The flow's steps, in its order (flows/flow.ts, runner "session").
  let summary = "";
  let builderText = "";
  let sha: string | null = null;
  let handover = false;
  for (const s of stepsToRun(flow)) {
    switch (s.action) {
      case "orient": {
        // The Builder runs the tests itself, so the clone's dependencies go in before it starts (once; skipped when present).
        if (o.checks) { const why = await ensureDeps(dir); if (why) step("install", "skipped", why); }
        step("orient", "passed", "repo rules and code map added to the prompt");
        break;
      }
      case "build": {
        const first = await build(`${o.document}\n\nYou are on branch ${branch} of a clone of ${o.repo.source}.${repoGuidance(dir)}${reviewBrief(log, o.projectId)}${overviewBlock(log, o.projectId)}${stackNote}`, o.maxUsd * 0.5, "build");
        if (first.error) return fail(first.error);
        builderText = first.text.replace(/<<<\s*FILE[\s\S]*?(?:FILE\s*>>>|$)/g, "").slice(-4000);
        summary = first.text.replace(/<<<\s*FILE[\s\S]*?(?:FILE\s*>>>|$)/g, "").trim().split("\n").filter(Boolean).slice(-6).join("\n");
        break;
      }
      case "checks": {
        // Checks, with the flow's number of fix rounds on a failure (two as shipped).
        const failures: string[] = [];
        const rounds = roundsOf(flow, "checks", MAX_FIX_ROUNDS);
        let bad = await check();
        for (let round = 1; bad && round <= rounds; round++) {
          failures.push(`${bad.name}: ${bad.output}`);
          if (bad.name === "secrets") break;
          const why = c.stopRule?.({ round, failures, costUsd: spent, maxUsd: o.maxUsd }) ?? (left() < o.maxUsd * 0.1 ? "the budget for this ticket is used up" : null);
          if (why) { step("fix", "skipped", why); break; }
          const fixed = await build(`The ${bad.name} check failed on your change to the ticket "${o.title}". Fix the cause (not the check) and change nothing else.\n\n${head(bad.output, 4000)}`, o.maxUsd * 0.15, `fix ${round}`);
          if (fixed.error) break;
          bad = await check();
        }
        if (bad) return fail(`Not committed: ${bad.name} still failing after ${failures.length} round(s).\n${head(bad.output, 1500)}`, changedFiles(dir));
        break;
      }
      case "review": {
        // A high finding gets the flow's number of fix rounds (one as shipped), each followed by the checks.
        if (left() <= 0) break;
        const rounds = roundsOf(flow, "review", 1);
        let res = await review();
        for (let r = 0; ; ) {
          if (res.error) { step("review", "skipped", res.error); break; }
          if (!res.high.length) { step("review", "passed", r ? "high findings fixed" : ""); passed.push("review"); break; }
          step("review", "failed", res.high.join("; "));
          // What the Reviewer sent back becomes a lesson of the agent that built it (bay/memory.ts), for its next work anywhere.
          if (r === 0) for (const h of res.high.slice(0, 2)) noteLesson(log, b?.id ?? "builder", `A reviewer sent back my change for: ${h.slice(0, 240)}`, "review", `ticket:${o.id}`);
          const fixed = await build(`A reviewer found high-severity problems in your change to "${o.title}". Fix them and change nothing else.\n\n${res.high.map((h) => `- ${trim(h, 600)}`).join("\n")}`, o.maxUsd * 0.15, "review fix");
          const again = fixed.error ? { name: "review fix", output: fixed.error } : await check();
          if (again) return fail(`Not committed: ${again.name} failed after the review fix.\n${head(again.output, 1500)}`, changedFiles(dir));
          r++;
          if (r >= rounds || left() <= 0) { step("review", "passed", "high findings fixed"); passed.push("review"); break; }
          res = await review();
        }
        break;
      }
      case "commit": {
        sha = commitAll(dir, `${o.key}: ${o.title}\n\nWorked by SoftwareFactory's crew on branch ${branch}.`);
        step("commit", sha ? "passed" : "skipped", sha ?? "nothing changed");
        break;
      }
      case "handover": handover = true; break;
      default: return fail(`The flow "${flow.name}" asks for "${s.action}", which one Builder session cannot do.`);
    }
  }
  const files = sha ? git(dir, "diff", "--name-only", `${base}..HEAD`).split("\n").filter(Boolean) : [];
  return { ok: true, dir, branch, base, sha, files, costUsd: spent, summary, checks: passed, handover, builderText };
}
