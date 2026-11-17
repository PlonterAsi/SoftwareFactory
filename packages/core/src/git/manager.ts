import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EventLog } from "../events.js";
import { git } from "../factory/workspace.js";
import { updateProject } from "../projects/service.js";
import { hideTokens, parseGitHubRepo, type GitHub, type GitHubRepo } from "../tickets/github.js";
import { TASTE_KINDS, isClosed, type TicketView } from "../tickets/model.js";
import { repoOfProject } from "../tickets/repowork.js";
import { ticketNumbersIn, type Tickets } from "../tickets/tickets.js";
import { reviewMerge, type MergeReview } from "./confidence.js";
import { highest, nextVersion, releaseNotes, suggestBump, type Bump, type VersionTicket } from "./notes.js";
import "./tables.js";

/**
 * The git manager (SF behavior brief 1.5, 2.1, 3.4, 3.5, 4.4; docs/git.md). SoftwareFactory runs git for
 * every project:
 *
 *   local first   a new project lives in a folder on this computer until it is judged worth continuing.
 *                 Continue (or Publish, at any time) makes a private GitHub repo and sends the code there.
 *   merge policy  every crew PR gets a confidence review when its CI ends. Each project starts on "ask":
 *                 the PR waits on Needs you with the review beside it. After a run of right merges SF
 *                 offers "auto", where it merges a confident PR by itself. A merge marked not right
 *                 ends the run and puts the project back on "ask".
 *   outside work  commits and PRs made outside SF join the ticket they name, or a new ticket that says
 *                 it was made outside SF. The first look at a repo only remembers where it stands.
 *   versions      merged tickets are grouped into a version with release notes written from the tickets,
 *                 tagged (a GitHub release, or a tag in the local folder) and kept on a version timeline.
 *
 * Nothing here pays for an agent. GitHub is reached only with the token from Systems.
 */
export type MergePolicy = "ask" | "auto";
export type ProjectVerdict = "continue" | "park" | "drop";
export const AUTO_AFTER = 3;

export interface ProjectGit {
  projectId: number;
  name: string;
  /** Where its code lives: a GitHub repo, a folder on this computer, or nowhere yet. */
  where: "github" | "local" | "none";
  repo: string | null;
  url: string | null;
  private: boolean | null;
  localDir: string | null;
  publishedAt: string | null;
  verdict: { verdict: ProjectVerdict; why: string; at: string } | null;
  policy: MergePolicy;
  /** Merges in a row that SF called confident and that went in. */
  streak: number;
  merges: number;
  /** "ask" with a run of right merges: SF offers auto. */
  offerAuto: boolean;
  watchedAt: string | null;
  versions: VersionView[];
  /** Merged tickets not in a version yet, and what the next version would be. */
  next: { version: string; bump: Bump; tickets: VersionTicket[]; notes: string } | null;
  /** Why it cannot be published now (no token, no code yet, already on GitHub), or null. */
  cannotPublish: string | null;
}
export interface VersionView { version: string; sha: string | null; notes: string; tickets: number[]; url: string | null; at: string; by: string }
export interface MergeCheckView extends MergeReview { ticketId: number; repo: string; number: number; sha: string; ci: string; at: string; mergedBy: string | null }

type Row = Record<string, any>;

export class GitManager {
  constructor(private log: EventLog, private tickets: Tickets, private o: { github?: GitHub; canShip?: () => string | null } = {}) {}

  private get gh() { return this.o.github; }
  private db() { return this.log.db; }

  // ---- reading -------------------------------------------------------------

  /** The folder on this computer that holds the project's code: a linked repo folder, else its newest shipped build. */
  localDir(projectId: number): string | null {
    const links = this.db().prepare("SELECT kind, ref FROM project_links WHERE project_id = ?").all(projectId) as { kind: string; ref: string }[];
    for (const l of links) if (l.kind === "repo" && existsSync(join(l.ref, ".git"))) return l.ref;
    const runs = links.filter((l) => l.kind === "factory_run").map((l) => Number(l.ref)).filter(Number.isFinite);
    if (!runs.length) return null;
    const r = this.db().prepare(`SELECT dir FROM factory_runs WHERE id IN (${runs.map(() => "?").join(",")}) AND outcome = 'shipped' AND dir IS NOT NULL ORDER BY id DESC LIMIT 1`).get(...runs) as { dir: string } | undefined;
    return r?.dir && existsSync(join(r.dir, ".git")) ? r.dir : null;
  }

  private githubOf(projectId: number): GitHubRepo | null {
    const r = repoOfProject(this.log, projectId);
    return r?.github ?? null;
  }

  private row(projectId: number): Row | undefined {
    return this.db().prepare("SELECT * FROM project_git WHERE project_id = ?").get(projectId) as Row | undefined;
  }

  status(projectId: number): ProjectGit {
    const p = this.db().prepare("SELECT id, name FROM projects WHERE id = ?").get(projectId) as { id: number; name: string } | undefined;
    if (!p) throw new Error(`There is no project #${projectId}.`);
    const r = this.row(projectId);
    const gh = this.githubOf(projectId);
    const localDir = this.localDir(projectId);
    const policy: MergePolicy = r?.policy === "auto" ? "auto" : "ask";
    const versions = this.versions(projectId);
    const pending = this.unversioned(projectId);
    const last = highest([...versions.map((v) => v.version), ...(localDir && !gh ? this.localTags(localDir) : [])]);
    const bump = suggestBump(pending);
    const version = nextVersion(last, bump);
    return {
      projectId, name: p.name, where: gh ? "github" : localDir ? "local" : "none",
      repo: gh ? `${gh.owner}/${gh.name}` : null, url: gh ? (r?.url ?? `https://github.com/${gh.owner}/${gh.name}`) : null,
      private: r?.private == null ? null : !!r.private, localDir, publishedAt: r?.published_at ?? null,
      verdict: r?.verdict ? { verdict: r.verdict, why: r.verdict_why ?? "", at: r.verdict_at } : null,
      policy, streak: Number(r?.streak ?? 0), merges: Number(r?.merges ?? 0), offerAuto: policy === "ask" && Number(r?.streak ?? 0) >= AUTO_AFTER,
      watchedAt: r?.watched_at ?? null, versions,
      next: pending.length ? { version, bump, tickets: pending, notes: releaseNotes(version, p.name, pending) } : null,
      cannotPublish: gh ? "It is already on GitHub." : !localDir ? "There is no code for it on this computer yet: build it first." : !this.gh?.hasToken() ? "No GitHub access yet: add a token in Systems, GitHub access." : null,
    };
  }

  versions(projectId: number): VersionView[] {
    return (this.db().prepare("SELECT * FROM versions WHERE project_id = ? ORDER BY at DESC").all(projectId) as Row[])
      .map((v) => ({ version: v.version, sha: v.sha, notes: v.notes, tickets: JSON.parse(v.tickets), url: v.url, at: v.at, by: v.by }));
  }

  /** The last confidence review of a ticket's PR, or null. */
  mergeCheck(ticketId: number): MergeCheckView | null {
    const r = this.db().prepare("SELECT * FROM merge_checks WHERE ticket_id = ?").get(ticketId) as Row | undefined;
    return r ? { ticketId, repo: r.repo, number: r.number, sha: r.sha, ci: r.ci, confident: !!r.confident, score: r.score, reasons: JSON.parse(r.reasons), at: r.at, mergedBy: r.merged_by } : null;
  }

  private localTags(dir: string): string[] {
    try { return git(dir, "tag", "--list", "v*").split("\n").filter(Boolean); } catch { return []; }
  }

  /** Tickets of this project merged (or, in a local project, closed) since its last version, not in any version yet. */
  unversioned(projectId: number): VersionTicket[] {
    const inVersion = new Set<number>(this.versions(projectId).flatMap((v) => v.tickets));
    const merged = new Map<number, number>();
    for (const e of this.db().prepare("SELECT payload FROM events WHERE type = 'ticket.pr' AND json_extract(payload, '$.state') = 'merged' ORDER BY id").all() as { payload: string }[]) {
      const p = JSON.parse(e.payload);
      merged.set(Number(p.id), Number(p.number));
    }
    const local = !this.githubOf(projectId);
    const rows = this.tickets.list({ view: "all", project: projectId, limit: 1000 });
    return rows
      .filter((t) => !inVersion.has(t.id) && (merged.has(t.id) || (local && t.status === "closed" && t.level !== "epic")))
      .sort((a, b) => a.id - b.id)
      .map((t) => ({ id: t.id, key: t.key, kind: t.kind, title: t.title, source: t.source ?? null, pr: merged.get(t.id) ?? null }));
  }

  // ---- local first, then a repo ------------------------------------------

  /** Make a private GitHub repo for the project and send its code there (main and tags). */
  async publish(projectId: number, o: { name?: string; private?: boolean; by?: string } = {}): Promise<ProjectGit> {
    const s = this.status(projectId);
    if (s.cannotPublish) throw new Error(s.cannotPublish);
    const gh = this.gh!;
    const dir = s.localDir!;
    const name = (o.name?.trim() || s.name).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90) || `project-${projectId}`;
    let made: GitHubRepo & { url: string };
    try { made = await gh.createRepo(name, { private: o.private !== false, description: `${s.name}, built with SoftwareFactory` }); }
    catch (e) { throw new Error(/422|already exists/i.test((e as Error).message) ? `A repo named ${name} already exists on your account: pick another name.` : (e as Error).message); }
    try { await gh.publishPush(dir, made); }
    catch (e) { throw new Error(`The repo ${made.owner}/${made.name} was made, but the code did not reach it: ${hideTokens((e as Error).message).slice(0, 300)}`); }
    let sha: string | null = null;
    try { sha = git(dir, "rev-parse", "HEAD"); } catch { /* unknown */ }
    const repo = `${made.owner}/${made.name}`;
    this.log.append("project.linked", { projectId, kind: "github", ref: repo });
    this.log.append("project.published", { projectId, repo, url: made.url, private: o.private !== false, sha, from: dir, by: o.by ?? "you" });
    // Its first look at the new repo remembers where it stands, so its own history is not "outside work".
    this.log.append("repo.watched", { projectId, repo, at: new Date().toISOString(), sha });
    return this.status(projectId);
  }

  /** Worth continuing? Continue publishes it to a private repo; park pauses it; drop archives it. Each keeps its reasons. */
  async verdict(projectId: number, v: ProjectVerdict, why = "", by = "you"): Promise<ProjectGit> {
    if (!["continue", "park", "drop"].includes(v)) throw new Error("A verdict is continue, park or drop.");
    if (v === "continue" && this.status(projectId).where !== "github") await this.publish(projectId, { by });
    if (v === "park") updateProject(this.log, projectId, { status: "paused" });
    if (v === "drop") updateProject(this.log, projectId, { status: "archived" });
    if (v === "continue") { const st = this.db().prepare("SELECT status FROM projects WHERE id = ?").get(projectId) as { status: string } | undefined; if (st && st.status !== "active") updateProject(this.log, projectId, { status: "active" }); }
    this.log.append("project.verdict", { projectId, verdict: v, why: String(why).slice(0, 2000), by });
    return this.status(projectId);
  }

  // ---- the merge policy ----------------------------------------------------

  setPolicy(projectId: number, mode: MergePolicy, by = "you"): ProjectGit {
    if (mode !== "ask" && mode !== "auto") throw new Error('The merge policy is "ask" or "auto".');
    if (!this.db().prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) throw new Error(`There is no project #${projectId}.`);
    this.log.append("project.mergepolicy", { projectId, mode, by });
    return this.status(projectId);
  }

  /** A merge that was not right: the run of right merges starts again, and "auto" goes back to "ask". */
  notRight(ticketId: number, why = "", by = "you"): ProjectGit | null {
    const t = this.tickets.get(ticketId);
    if (!t) throw new Error(`There is no ticket #${ticketId}.`);
    this.log.append("ticket.mergewrong", { id: ticketId, projectId: t.project, why: String(why).slice(0, 1000), by });
    this.tickets.say(ticketId, `The merge was not right${why ? `: ${why}` : ""}. SF starts counting right merges again${t.project != null && this.row(t.project)?.policy === "auto" ? " and asks you before merging in this project" : ""}.`, { by, kind: "event" });
    if (t.project == null) return null;
    if (this.row(t.project)?.policy === "auto") this.log.append("project.mergepolicy", { projectId: t.project, mode: "ask", by: "sf" });
    return this.status(t.project);
  }

  /** Read the ticket's open PR and review it for a merge. Records a new review when the commit or CI changed. */
  async check(ticketId: number): Promise<MergeCheckView | null> {
    const t = this.tickets.get(ticketId);
    const gh = this.gh;
    if (!t?.pr || t.pr.state !== "open" || !gh) return null;
    const repo = parseGitHubRepo(t.pr.repo ?? "");
    if (!repo) return null;
    const pr = await gh.prDetail(repo, t.pr.number);
    if (pr.state !== "open") return this.mergeCheck(ticketId);
    const ci = await gh.ci(repo, pr.headSha);
    const before = this.mergeCheck(ticketId);
    if (before && before.sha === pr.headSha && before.ci === ci.state) return before;
    const files = await gh.prFiles(repo, pr.number).catch(() => [] as string[]);
    const decisions = Object.entries(t.answers ?? {}).filter(([k]) => /^check\.(money|data|secrets|public|legal)$/.test(k)).map(([k]) => k.slice(6));
    const review = reviewMerge({ ci, steps: this.tickets.steps(ticketId), files, lines: pr.additions + pr.deletions, kind: t.kind, decisions, crew: pr.branch.startsWith("sf/") && t.source !== "outside" });
    this.log.append("ticket.mergecheck", { id: ticketId, projectId: t.project, repo: `${repo.owner}/${repo.name}`, number: pr.number, sha: pr.headSha, ci: ci.state, ...review });
    return this.mergeCheck(ticketId);
  }

  /**
   * Merge the ticket's PR: your press, or SF's own under "auto" on a confident review. Never while CI runs or failed.
   * The PR is marked ready if it is a draft, then squashed into the repo's main; the ticket moves on as with any merge.
   */
  async merge(ticketId: number, by = "you"): Promise<TicketView> {
    const t = this.tickets.get(ticketId);
    if (!t) throw new Error(`There is no ticket #${ticketId}.`);
    if (!t.pr || t.pr.state !== "open") throw new Error("This ticket has no open pull request to merge.");
    const gh = this.gh;
    if (!gh?.hasToken()) throw new Error("No GitHub access yet: add a token in Systems, GitHub access.");
    const repo = parseGitHubRepo(t.pr.repo ?? "")!;
    const c = await this.check(ticketId);
    if (!c) throw new Error("The pull request could not be read.");
    if (c.ci === "red") throw new Error(`CI failed on PR #${c.number}, so it is not merged. ${c.reasons.find((r) => r.key === "ci")?.text ?? ""}`.trim());
    if (c.ci === "running") throw new Error(`CI is still running on PR #${c.number}. It can merge when it ends.`);
    if (by === "sf" && !c.confident) throw new Error("SF merges by itself only on a confident review.");
    const pr = await gh.prDetail(repo, c.number);
    if (pr.draft) await gh.markReady(pr.nodeId);
    const done = await gh.mergePr(repo, c.number, c.sha, `${t.key}: ${t.title} (#${c.number})`);
    this.log.append("ticket.pr", { id: ticketId, by, repo: `${repo.owner}/${repo.name}`, number: c.number, url: t.pr.url, state: "merged", sha: done.sha || null });
    const now = this.tickets.get(ticketId)!;
    if (!isClosed(now.status)) {
      const closes = !TASTE_KINDS.includes(now.kind);
      this.log.append("ticket.noted", { id: ticketId, by: by === "sf" ? "sf" : by, status: closes ? "closed" : now.status === "built" ? undefined : "built",
        text: `${by === "sf" ? "SF merged" : "Merged"} PR #${c.number}${by === "sf" ? `: every check of its review passed (${c.reasons.length} of ${c.reasons.length})` : ""}.${closes ? " Closed: it goes into the next version." : " It goes into the next version; take a look then."}` });
    }
    return this.tickets.get(ticketId)!;
  }

  /**
   * One pass over every open crew PR: review it once its CI ended, and under "auto" merge a confident one.
   * Auto merges happen only with the real crew (the practice crew never ships).
   */
  async tend(): Promise<{ checked: number; merged: number }> {
    const gh = this.gh;
    if (!gh?.hasToken()) return { checked: 0, merged: 0 };
    let checked = 0, merged = 0;
    const rows = this.db().prepare("SELECT id, project FROM tickets WHERE pr_state = 'open' AND pr_number IS NOT NULL").all() as { id: number; project: number | null }[];
    for (const r of rows) {
      try {
        const before = this.mergeCheck(Number(r.id));
        const c = await this.check(Number(r.id));
        if (c && c !== before && (!before || before.at !== c.at)) checked++;
        if (!c || c.ci !== "green" || !c.confident || c.mergedBy) continue;
        if (r.project == null || this.row(Number(r.project))?.policy !== "auto" || this.o.canShip?.()) continue;
        await this.merge(Number(r.id), "sf");
        merged++;
      } catch (e) { console.error("git: tending ticket", r.id, "failed:", hideTokens((e as Error).message)); }
    }
    return { checked, merged };
  }

  // ---- outside work ----------------------------------------------------------

  /** Every project with a GitHub repo, read for work done outside SF. */
  async watchAll(): Promise<number> {
    // Only with a token: without one GitHub allows 60 reads an hour, which the PR follow already uses.
    if (!this.gh?.hasToken()) return 0;
    const ids = (this.db().prepare("SELECT DISTINCT project_id FROM project_links WHERE kind = 'github'").all() as { project_id: number }[]).map((r) => Number(r.project_id));
    let n = 0;
    for (const id of ids) { try { n += await this.watch(id); } catch (e) { console.error("git: watching project", id, "failed:", hideTokens((e as Error).message)); } }
    return n;
  }

  /**
   * Read the repo for PRs and commits made outside SF since the last look. A PR that names a ticket joins it;
   * any other PR gets its own "made outside SF" ticket; commits straight to main become one ticket per look.
   * The first look only remembers where the repo stands. Returns how many tickets it opened or joined.
   */
  async watch(projectId: number): Promise<number> {
    const gh = this.gh;
    const repo = this.githubOf(projectId);
    if (!gh || !repo) return 0;
    const name = `${repo.owner}/${repo.name}`;
    const since = this.row(projectId)?.watched_at as string | undefined;
    const startedAt = new Date().toISOString();
    const branch = await gh.defaultBranch(repo);
    if (!since) {
      const head = (await gh.commits(repo, branch).catch(() => []))[0]?.sha ?? null;
      this.log.append("repo.watched", { projectId, repo: name, at: startedAt, sha: head, first: true });
      return 0;
    }
    const key = (this.db().prepare("SELECT key FROM ticket_keys WHERE project = ?").get(projectId) as { key: string } | undefined)?.key ?? null;
    const known = new Set((this.db().prepare("SELECT json_extract(payload, '$.number') AS n FROM events WHERE type = 'ticket.pr' AND json_extract(payload, '$.repo') = ?").all(name) as { n: number }[]).map((r) => Number(r.n)));
    const knownShas = new Set((this.db().prepare("SELECT json_extract(payload, '$.sha') AS s FROM events WHERE type = 'ticket.pr' AND json_extract(payload, '$.repo') = ? AND json_extract(payload, '$.sha') IS NOT NULL").all(name) as { s: string }[]).map((r) => String(r.s)));
    let touched = 0;
    const prs = (await gh.recentPrs(repo)).filter((p) => p.updatedAt > since && !known.has(p.number)).sort((a, b) => a.number - b.number);
    for (const pr of prs) {
      const state = pr.merged || pr.mergedAt ? "merged" : pr.state;
      const named = key ? ticketNumbersIn(`${pr.title}\n${pr.branch}`, key).map((n) => this.tickets.byKey(`${key}-${n}`)).filter((t): t is TicketView => !!t) : [];
      if (named.length) {
        // It names a ticket: it joins that ticket's timeline (a merge there is followed like any other).
        for (const t of named) {
          this.log.append("ticket.pr", { id: t.id, by: "github", repo: name, number: pr.number, url: pr.url, branch: pr.branch, state, sha: pr.mergeSha });
          this.tickets.say(t.id, `PR #${pr.number} "${pr.title.slice(0, 120)}" by ${pr.author || "someone"} names this ticket${state === "merged" ? " and was merged" : state === "open" ? " and is open" : " and was closed"}. It was made outside SF.`,
            { by: "github", kind: "event", ...(state === "merged" && !isClosed(t.status) ? { status: TASTE_KINDS.includes(t.kind) ? (t.status === "built" ? undefined : "built") : "closed" } : {}) } as any);
          touched++;
        }
        continue;
      }
      if (pr.branch.startsWith("sf/")) continue; // the crew's own branch whose ticket was not found: not outside work
      const t = this.tickets.open({ kind: "task", title: pr.title || `PR #${pr.number}`, project: projectId, by: "github", source: "outside", tags: ["outside"], fingerprint: `outside:${name}#${pr.number}`,
        body: `Made outside SF: pull request #${pr.number} by ${pr.author || "someone"} on ${name} (${pr.url}), from branch ${pr.branch}.` });
      this.log.append("ticket.pr", { id: t.id, by: "github", repo: name, number: pr.number, url: pr.url, branch: pr.branch, state, sha: pr.mergeSha });
      if (state === "merged") this.tickets.say(t.id, `PR #${pr.number} was merged outside SF.`, { by: "github", status: "closed", kind: "event" });
      else if (state === "closed") this.tickets.say(t.id, `PR #${pr.number} was closed without merging.`, { by: "github", status: "closed", kind: "event" });
      touched++;
    }
    // Commits straight to the main branch, not from a pull request SF knows and not naming a ticket.
    const commits = (await gh.commits(repo, branch, since).catch(() => [])).filter((c) => c.at > since && !knownShas.has(c.sha));
    const loose = [] as typeof commits;
    for (const c of commits) {
      if (/\(#\d+\)\s*$|^Merge pull request #\d+/m.test(c.message.split("\n")[0])) continue;
      const named = key ? ticketNumbersIn(c.message, key).map((n) => this.tickets.byKey(`${key}-${n}`)).filter((t): t is TicketView => !!t) : [];
      if (named.length) {
        for (const t of named) this.tickets.say(t.id, `Commit ${c.sha.slice(0, 7)} "${c.message.split("\n")[0].slice(0, 120)}" by ${c.author || "someone"} names this ticket. It was made outside SF, straight on ${branch}.`, { by: "github", kind: "event" });
        touched += named.length;
      } else loose.push(c);
    }
    if (loose.length) {
      const t = this.tickets.open({ kind: "task", title: loose.length === 1 ? loose[0].message.split("\n")[0].slice(0, 120) : `${loose.length} commits made outside SF`, project: projectId, by: "github", source: "outside", tags: ["outside"],
        fingerprint: `outside:${name}@${loose[loose.length - 1].sha}`,
        body: [`Made outside SF: ${loose.length} commit${loose.length === 1 ? "" : "s"} straight on ${branch} of ${name}.`, "", ...loose.slice().reverse().map((c) => `- ${c.sha.slice(0, 7)} ${c.message.split("\n")[0].slice(0, 160)} (${c.author || "someone"})`)].join("\n") });
      this.tickets.say(t.id, `Already on ${branch}, so it is closed. It goes into the next version.`, { by: "github", status: "closed", kind: "event" });
      this.log.append("ticket.pr", { id: t.id, by: "github", repo: name, number: 0, url: `https://github.com/${name}/commit/${loose[0].sha}`, state: "merged", sha: loose[0].sha });
      touched++;
    }
    this.log.append("repo.watched", { projectId, repo: name, at: startedAt, sha: commits[0]?.sha ?? this.row(projectId)?.watched_sha ?? null, prs: prs.length, commits: commits.length });
    return touched;
  }

  // ---- versions --------------------------------------------------------------

  /** Cut the next version: its tickets, notes and tag (a GitHub release, or a tag in the local folder). */
  async cutVersion(projectId: number, o: { bump?: Bump; notes?: string; by?: string } = {}): Promise<VersionView> {
    const s = this.status(projectId);
    if (!s.next) throw new Error(s.versions.length ? `Nothing was merged since ${s.versions[0].version}.` : "Nothing was merged yet, so there is nothing to put in a version.");
    const last = highest([...s.versions.map((v) => v.version), ...(s.where === "local" && s.localDir ? this.localTags(s.localDir) : [])]);
    const version = o.bump ? nextVersion(last, o.bump) : s.next.version;
    const notes = (o.notes?.trim() || releaseNotes(version, s.name, s.next.tickets)).slice(0, 20_000);
    let sha: string | null = null, url: string | null = null;
    const gh = this.gh;
    if (s.where === "github") {
      if (!gh?.hasToken()) throw new Error("No GitHub access yet: add a token in Systems, GitHub access.");
      const repo = this.githubOf(projectId)!;
      const branch = await gh.defaultBranch(repo);
      sha = (await gh.commits(repo, branch))[0]?.sha ?? null;
      if (!sha) throw new Error(`Could not read the newest commit on ${branch}.`);
      url = (await gh.release(repo, { tag: version, sha, name: `${s.name} ${version}`, notes })).url || null;
    } else if (s.where === "local" && s.localDir) {
      sha = git(s.localDir, "rev-parse", "HEAD");
      git(s.localDir, "tag", "-a", version, "-m", notes);
    } else throw new Error("This project has no code yet, so there is nothing to tag.");
    this.log.append("project.version", { projectId, version, sha, notes, tickets: s.next.tickets.map((t) => t.id), url, by: o.by ?? "you" });
    return this.versions(projectId).find((v) => v.version === version)!;
  }
}
