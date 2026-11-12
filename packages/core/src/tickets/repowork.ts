import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EventLog } from "../events.js";
import { runAgent } from "../agents.js";
import type { AgentRuntime } from "../runtime.js";
import type { AgentBay } from "../bay/bay.js";
import { commitAll, git, parseFileBlocks, writeFiles } from "../factory/workspace.js";
import { importOf, moduleNotes } from "../imports/explorer.js";
import { describeSecrets, scanFiles } from "../safety/secrets.js";
import { fastGates } from "../safety/gates.js";
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
  "Do not run git and do not touch files outside this folder. If you cannot edit files, answer with <<<FILE path ... FILE>>> blocks holding whole files.",
  "End with at most 6 short lines: what you changed, and anything left for a person to decide.",
].join("\n");

const TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"];

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

export interface RepoWorkResult { ok: boolean; dir: string; branch: string; base: string; sha: string | null; files: string[]; costUsd: number; summary: string; error?: string }

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

/** One Builder pass on the ticket in the clone, then a commit on the branch. Never pushes. */
export async function workInRepo(log: EventLog, runtime: AgentRuntime, bay: AgentBay | undefined, o: {
  id: number; key: string; title: string; document: string; repo: RepoRef; workRoot: string; maxUsd: number; git?: (dir: string, ...args: string[]) => string; projectId?: number | null;
}): Promise<RepoWorkResult> {
  const branch = branchFor(o.key, o.title);
  const { dir, base } = prepareClone(o.repo, o.workRoot, o.id, branch, o.git);
  const b = bay?.crewFor("build")[0];
  const run = await runAgent(log, runtime, b?.id ?? "builder", {
    prompt: `${o.document}\n\nYou are on branch ${branch} of a clone of ${o.repo.source}.${overviewBlock(log, o.projectId)}`,
    model: b?.model ?? "sonnet",
    systemPrompt: `${b?.role.split("Station contract:")[0].trim() ?? "You are the Builder: you write working code."}\n\n${REPO_CONTRACT}`,
    budgetUsd: Math.min(o.maxUsd, b?.budgetUsd ?? o.maxUsd),
    pluginDirs: b?.pluginDirs.length ? b.pluginDirs : undefined,
    // The working-copy tools, plus the Builder's own skills and MCP servers.
    tools: [...new Set([...TOOLS, ...(b?.tools ?? [])])],
    mcpConfig: b?.mcpConfig,
    cwd: dir,
  }, { agentVersion: b?.version, station: "repo" });
  if (run.error || !run.result) return { ok: false, dir, branch, base, sha: null, files: [], costUsd: 0, summary: "", error: run.error ?? "no reply" };
  const blocks = parseFileBlocks(run.result.text);
  if (blocks.length) writeFiles(dir, blocks, { lockTests: false });
  // The secret gate (SF-17): nothing that looks like a real key is committed, whatever wrote it.
  const touched = git(dir, "status", "--porcelain", "--untracked-files=all").split("\n").map((l) => l.slice(3).trim().replace(/^"|"$/g, "")).filter(Boolean);
  const hits = scanFiles(Object.fromEntries(touched.filter((f) => existsSync(join(dir, f))).map((f) => [f, readFileSync(join(dir, f), "utf8")])));
  if (hits.length) return { ok: false, dir, branch, base, sha: null, files: touched, costUsd: run.result.costUsd, summary: "", error: `Not committed: the change holds what looks like a real secret.\n${describeSecrets(hits)}` };
  // Fast gates (SF-26): syntax, tsc and lint on the change, free, before it is committed.
  const gates = fastGates(dir, touched);
  for (const g of gates.results) log.append("factory.fastgate", { ticket: o.key, gate: g.gate, state: g.state, note: g.note, messages: g.messages.slice(0, 20) });
  if (!gates.ok) return { ok: false, dir, branch, base, sha: null, files: touched, costUsd: run.result.costUsd, summary: "", error: `Not committed: ${gates.messages}` };
  const sha = commitAll(dir, `${o.key}: ${o.title}\n\nWorked by SoftwareFactory's crew on branch ${branch}.`);
  const files = sha ? git(dir, "diff", "--name-only", `${base}..HEAD`).split("\n").filter(Boolean) : [];
  const summary = run.result.text.replace(/<<<\s*FILE[\s\S]*?(?:FILE\s*>>>|$)/g, "").trim().split("\n").filter(Boolean).slice(-6).join("\n");
  return { ok: true, dir, branch, base, sha, files, costUsd: run.result.costUsd, summary };
}
