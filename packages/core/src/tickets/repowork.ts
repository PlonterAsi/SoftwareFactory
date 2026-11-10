import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EventLog } from "../events.js";
import { runAgent } from "../agents.js";
import type { AgentRuntime } from "../runtime.js";
import type { AgentBay } from "../bay/bay.js";
import { commitAll, git, parseFileBlocks, writeFiles } from "../factory/workspace.js";

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

export interface RepoRef { source: string; dir: string; branch: string | null }

export const REPO_CONTRACT = [
  "Station contract: repo. You are working inside an existing code repository: the current folder is a clone on its own branch.",
  "Make the smallest change that does what the ticket asks, in the style of the code around it. Read before you edit.",
  "Do not run git and do not touch files outside this folder. If you cannot edit files, answer with <<<FILE path ... FILE>>> blocks holding whole files.",
  "End with at most 6 short lines: what you changed, and anything left for a person to decide.",
].join("\n");

const TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"];

/** The repo a project was imported from: the import's working copy, else a `repo` link that is a folder on this computer. */
export function repoOfProject(log: EventLog, project: number | null): RepoRef | null {
  if (project == null) return null;
  const has = (t: string) => !!log.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  if (has("repo_imports")) {
    const r = log.db.prepare("SELECT source, dir, branch FROM repo_imports WHERE project_id = ?").get(project) as { source: string; dir: string | null; branch: string | null } | undefined;
    if (r?.dir && existsSync(join(r.dir, ".git"))) return { source: r.source, dir: r.dir, branch: r.branch ?? null };
  }
  if (has("project_links")) {
    const rows = log.db.prepare("SELECT ref FROM project_links WHERE project_id = ? AND kind = 'repo'").all(project) as { ref: string }[];
    for (const { ref } of rows) if (existsSync(join(ref, ".git"))) return { source: ref, dir: ref, branch: null };
  }
  return null;
}

export const branchFor = (id: number, title: string) =>
  `sf/ticket-${id}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "work"}`;

/** Make (or reuse) the clone for one ticket and put it on the ticket's branch. Returns the clone folder and the base commit. */
export function prepareClone(repo: RepoRef, workRoot: string, id: number, branch: string): { dir: string; base: string } {
  const dir = resolve(workRoot, `ticket-${id}`);
  mkdirSync(workRoot, { recursive: true });
  if (!existsSync(join(dir, ".git"))) {
    // A plain clone: the original repo gets no worktree entry, branch or file from us.
    git(workRoot, "clone", "-q", "--no-hardlinks", repo.dir, dir);
  }
  const branches = git(dir, "branch", "--list", branch);
  if (branches) git(dir, "checkout", "-q", branch);
  else git(dir, "checkout", "-q", "-b", branch);
  let base: string;
  try { base = git(dir, "merge-base", "HEAD", "origin/HEAD").slice(0, 12); } catch { base = git(dir, "rev-parse", "--short=12", "HEAD"); }
  return { dir, base };
}

export interface RepoWorkResult { ok: boolean; dir: string; branch: string; base: string; sha: string | null; files: string[]; costUsd: number; summary: string; error?: string }

/** One Builder pass on the ticket in the clone, then a commit on the branch. Never pushes. */
export async function workInRepo(log: EventLog, runtime: AgentRuntime, bay: AgentBay | undefined, o: {
  id: number; title: string; document: string; repo: RepoRef; workRoot: string; maxUsd: number;
}): Promise<RepoWorkResult> {
  const branch = branchFor(o.id, o.title);
  const { dir, base } = prepareClone(o.repo, o.workRoot, o.id, branch);
  const b = bay?.crewFor("build")[0];
  const run = await runAgent(log, runtime, b?.id ?? "builder", {
    prompt: `${o.document}\n\nYou are on branch ${branch} of a clone of ${o.repo.source}.`,
    model: b?.model ?? "sonnet",
    systemPrompt: `${b?.role.split("Station contract:")[0].trim() ?? "You are the Builder: you write working code."}\n\n${REPO_CONTRACT}`,
    budgetUsd: Math.min(o.maxUsd, b?.budgetUsd ?? o.maxUsd),
    pluginDirs: b?.pluginDirs.length ? b.pluginDirs : undefined,
    tools: TOOLS,
    cwd: dir,
  }, { agentVersion: b?.version, station: "repo" });
  if (run.error || !run.result) return { ok: false, dir, branch, base, sha: null, files: [], costUsd: 0, summary: "", error: run.error ?? "no reply" };
  const blocks = parseFileBlocks(run.result.text);
  if (blocks.length) writeFiles(dir, blocks, { lockTests: false });
  const sha = commitAll(dir, `Ticket #${o.id}: ${o.title}\n\nWorked by SoftwareFactory on branch ${branch}. Not pushed.`);
  const files = sha ? git(dir, "diff", "--name-only", `${base}..HEAD`).split("\n").filter(Boolean) : [];
  const summary = run.result.text.replace(/<<<\s*FILE[\s\S]*?(?:FILE\s*>>>|$)/g, "").trim().split("\n").filter(Boolean).slice(-6).join("\n");
  return { ok: true, dir, branch, base, sha, files, costUsd: run.result.costUsd, summary };
}
