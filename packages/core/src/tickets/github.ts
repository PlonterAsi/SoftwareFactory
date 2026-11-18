import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { git } from "../factory/workspace.js";

/**
 * GitHub write access for the crew: push a ticket's branch and open a draft
 * pull request for it, then follow the PR until it is merged or closed.
 * Assaf's rule (11 Nov 2026): the crew may open PRs on SoftwareFactory, but
 * never push to main.
 *
 * The token is a fine-grained GitHub token you paste once in Systems
 * (Contents and Pull requests, read and write, on the repos you choose). It is
 * kept in `github-token` in the data folder, on this PC only: never in the
 * database, the event log, a ticket or an agent's prompt. It goes only to
 * github.com, as a header, never in a URL, so git and error messages never
 * print it.
 */

export interface GitHubRepo { owner: string; name: string }
export interface PullRequest { number: number; url: string; state: "open" | "closed"; merged: boolean; draft: boolean; mergeSha: string | null; title: string }
/** A merged pull request, with the words that may name tickets (its title and branch). */
export interface MergedPr extends PullRequest { branch: string; mergedAt: string }
/** A pull request as the git manager reads it. */
export interface PrDetail extends PullRequest { headSha: string; branch: string; base: string; nodeId: string; author: string; additions: number; deletions: number; changedFiles: number; mergeable: boolean | null; createdAt: string; updatedAt: string; mergedAt: string | null }
/** CI on one commit: green (all passed), red (one failed), running, or none (no CI). */
export interface CiState { state: "green" | "red" | "running" | "none"; failed: string[]; total: number }
export interface Commit { sha: string; message: string; author: string; at: string }

const TOKEN_FILE = "github-token";
const TOKEN_RE = /^(gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}$/;
/** Branches the crew never pushes to, whatever a caller asks. */
const PROTECTED = /^(main|master|production|prod|release(\/.*)?)$/i;

/** "owner/name", a github.com URL, or a git remote URL → { owner, name }. */
export function parseGitHubRepo(s: string): GitHubRepo | null {
  const m = String(s ?? "").trim().match(/^(?:https?:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], name: m[2] } : null;
}

/** Remove anything that looks like a GitHub token from text before it is written anywhere. */
export const hideTokens = (s: string) => s.replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[token]");

/** The GitHub CLI's login on this PC (`gh auth token`), or null when gh is missing or signed out. */
export function ghCliToken(): string | null {
  try {
    const r = spawnSync("gh", ["auth", "token", "-h", "github.com"], { windowsHide: true, timeout: 5000, encoding: "utf8" });
    return r.status === 0 ? String(r.stdout ?? "").trim() || null : null;
  } catch { return null; }
}

export class GitHub {
  constructor(private o: { dataDir: string; api?: string; fetch?: typeof fetch; gitUrl?: (r: GitHubRepo) => string; cli?: () => string | null }) {}

  private get file() { return join(this.o.dataDir, TOKEN_FILE); }
  private get api() { return this.o.api ?? "https://api.github.com"; }
  private get http() { return this.o.fetch ?? fetch; }
  /** Where git clones and pushes; tests point it at a local bare repo. */
  remote(r: GitHubRepo): string { return this.o.gitUrl ? this.o.gitUrl(r) : `https://github.com/${r.owner}/${r.name}.git`; }

  hasToken(): boolean { return !!this.token(); }
  private pasted(): string | null {
    try { const t = readFileSync(this.file, "utf8").trim(); return t || null; } catch { return null; }
  }
  private ghCache: { at: number; t: string | null } | null = null;
  /** The GitHub CLI login on this PC (`gh auth token`), if any. Held in memory for a minute, never written anywhere. */
  private cli(): string | null {
    // Only the installed app passes ghCliToken; tests and cores without it never read the real login.
    if (!this.o.cli) return null;
    if (this.ghCache && Date.now() - this.ghCache.at < 60_000) return this.ghCache.t;
    let t: string | null = null;
    try { const s = this.o.cli()?.trim() ?? ""; if (TOKEN_RE.test(s)) t = s; } catch { /* no login */ }
    this.ghCache = { at: Date.now(), t };
    return t;
  }
  private token(): string | null { return this.pasted() ?? this.cli(); }
  /** Where the token in use comes from, for Systems. */
  tokenSource(): "pasted" | "gh" | null { return this.pasted() ? "pasted" : this.cli() ? "gh" : null; }
  /** The GitHub login the token belongs to, or null when it cannot be read. */
  async login(): Promise<string | null> {
    try { return String((await this.call<any>("GET", "/user")).login ?? "") || null; } catch { return null; }
  }
  setToken(token: string | null) {
    if (!token) { if (existsSync(this.file)) unlinkSync(this.file); return; }
    const t = token.trim();
    if (!TOKEN_RE.test(t)) throw new Error("That does not look like a GitHub token (they start with github_pat_ or ghp_).");
    writeFileSync(this.file, t, { mode: 0o600 });
    try { chmodSync(this.file, 0o600); } catch { /* Windows keeps it in the user's own data folder */ }
  }

  private async call<T>(method: string, path: string, body?: unknown, o: { anonymous?: boolean } = {}): Promise<T> {
    const token = this.token();
    if (!token && !o.anonymous) throw new Error("No GitHub access yet: add a token in Systems, GitHub access.");
    const r = await this.http(`${this.api}${path}`, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json", "user-agent": "SoftwareFactory" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({})) as any;
    if (!r.ok) throw new Error(hideTokens(`GitHub said ${r.status}${j?.message ? `: ${j.message}` : ""}`));
    return j as T;
  }

  /**
   * A repository's code at a branch, tag or commit, as one .tar.gz (for add-ons installed from GitHub). With a token
   * it can read private repositories; without one only public ones.
   */
  async tarball(repo: string, ref: string): Promise<Buffer> {
    const token = this.token();
    const r = await this.http(`${this.api}/repos/${repo}/tarball/${encodeURIComponent(ref)}`, {
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "SoftwareFactory" },
    });
    if (!r.ok) throw new Error(r.status === 404 ? `GitHub has no ${repo} at ${ref}${token ? "" : ", or it is private: add GitHub access in Systems"}` : hideTokens(`GitHub said ${r.status}`));
    return Buffer.from(await r.arrayBuffer());
  }

  /** Can the token push to this repo? Answers in a sentence when it cannot. */
  async check(repo: GitHubRepo): Promise<{ ok: boolean; why?: string }> {
    if (!this.hasToken()) return { ok: false, why: "No GitHub access yet: add a token in Systems, GitHub access." };
    try {
      const r = await this.call<{ permissions?: { push?: boolean } }>("GET", `/repos/${repo.owner}/${repo.name}`);
      return r.permissions?.push ? { ok: true } : { ok: false, why: `The token can read ${repo.owner}/${repo.name} but not write to it: give it Contents and Pull requests, read and write.` };
    } catch (e) { return { ok: false, why: (e as Error).message }; }
  }

  /** git with the token as a header (never in the URL), so nothing git prints carries it. */
  git(dir: string, ...args: string[]): string {
    const token = this.token();
    const auth = token ? ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`] : [];
    try { return git(dir, ...auth, ...args); } catch (e) { throw new Error(hideTokens((e as Error).message)); }
  }

  /** Push the branch (never a protected one) and open a draft PR into `base`, or return the one already open. */
  async openPr(o: { repo: GitHubRepo; dir: string; branch: string; base: string; title: string; body: string }): Promise<PullRequest> {
    if (PROTECTED.test(o.branch) || o.branch === o.base) throw new Error(`The crew never pushes to ${o.branch}.`);
    this.git(o.dir, "push", "-q", this.remote(o.repo), `HEAD:refs/heads/${o.branch}`);
    const open = await this.call<any[]>("GET", `/repos/${o.repo.owner}/${o.repo.name}/pulls?state=open&head=${encodeURIComponent(`${o.repo.owner}:${o.branch}`)}`);
    if (open.length) return toPr(open[0]);
    return toPr(await this.call<any>("POST", `/repos/${o.repo.owner}/${o.repo.name}/pulls`, { title: o.title, head: o.branch, base: o.base, body: o.body, draft: true }));
  }

  /**
   * Push one branch on a person's press, when there is no token: plain git, so this PC's own Git sign-in
   * decides (Git for Windows asks in its own window the first time). Never a protected branch. It runs
   * beside the core, not inside it, so a sign-in window cannot freeze the app; it gives up after `timeoutMs`.
   */
  async pushBranch(o: { repo: GitHubRepo; dir: string; branch: string; base?: string; timeoutMs?: number }): Promise<void> {
    if (PROTECTED.test(o.branch) || o.branch === o.base) throw new Error(`The crew never pushes to ${o.branch}.`);
    if (this.hasToken()) { this.git(o.dir, "push", "-q", this.remote(o.repo), `${o.branch}:refs/heads/${o.branch}`); return; }
    await new Promise<void>((done, fail) => {
      const c = spawn("git", ["push", "-q", this.remote(o.repo), `${o.branch}:refs/heads/${o.branch}`], { cwd: o.dir, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      let err = "";
      c.stderr?.on("data", (d) => { err += String(d); });
      const t = setTimeout(() => { c.kill(); fail(new Error("GitHub did not answer in time. If a sign-in window opened, finish it and press again.")); }, o.timeoutMs ?? 120_000);
      c.on("error", (e) => { clearTimeout(t); fail((e as NodeJS.ErrnoException).code === "ENOENT" ? new Error("Git is not installed (or not on PATH).") : e); });
      c.on("close", (code) => {
        clearTimeout(t);
        if (code === 0) return done();
        const said = hideTokens(err.trim());
        fail(new Error(/auth|denied|403|could not read Username|terminal prompts disabled/i.test(said)
          ? `This computer is not signed in to GitHub for ${o.repo.owner}/${o.repo.name}. Add a token in Systems, GitHub access, and press again.`
          : `GitHub did not take the branch: ${said.slice(0, 300) || "git push failed"}`));
      });
    });
  }

  /** Where a person starts the pull request for a pushed branch, in the browser. */
  compareUrl(repo: GitHubRepo, base: string, branch: string): string {
    return `https://github.com/${repo.owner}/${repo.name}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`;
  }

  /**
   * The repo's merged pull requests, most recently touched first (one page of 100).
   * A read: it uses the token when there is one, and works without it on a public repo.
   */
  async mergedPrs(repo: GitHubRepo): Promise<MergedPr[]> {
    const rows = await this.call<any[]>("GET", `/repos/${repo.owner}/${repo.name}/pulls?state=closed&sort=updated&direction=desc&per_page=100`, undefined, { anonymous: true });
    return (Array.isArray(rows) ? rows : []).filter((j) => j?.merged_at).map((j) => ({ ...toPr(j), branch: String(j.head?.ref ?? ""), mergedAt: String(j.merged_at) }));
  }

  // ---- the git manager (docs/git.md) ----------------------------------------

  /** A new repo under the token's account. Private unless asked otherwise. */
  async createRepo(name: string, o: { private?: boolean; description?: string } = {}): Promise<GitHubRepo & { url: string }> {
    const j = await this.call<any>("POST", "/user/repos", { name, private: o.private !== false, description: (o.description ?? "").slice(0, 300), auto_init: false });
    return { owner: String(j.owner?.login ?? ""), name: String(j.name ?? name), url: String(j.html_url ?? "") };
  }

  /** The repo's default branch (main when it cannot be read). */
  async defaultBranch(repo: GitHubRepo): Promise<string> {
    try { return String((await this.call<any>("GET", `/repos/${repo.owner}/${repo.name}`, undefined, { anonymous: true })).default_branch ?? "main") || "main"; } catch { return "main"; }
  }

  /** One pull request with what the merge check reads: head commit, size, author, branch. */
  async prDetail(repo: GitHubRepo, number: number): Promise<PrDetail> {
    const j = await this.call<any>("GET", `/repos/${repo.owner}/${repo.name}/pulls/${number}`, undefined, { anonymous: true });
    return { ...toPr(j), headSha: String(j.head?.sha ?? ""), branch: String(j.head?.ref ?? ""), base: String(j.base?.ref ?? "main"), nodeId: String(j.node_id ?? ""), author: String(j.user?.login ?? ""),
      additions: Number(j.additions ?? 0), deletions: Number(j.deletions ?? 0), changedFiles: Number(j.changed_files ?? 0), mergeable: j.mergeable ?? null, createdAt: String(j.created_at ?? ""), updatedAt: String(j.updated_at ?? ""), mergedAt: j.merged_at ?? null };
  }

  /** The files a pull request changes (first 100). */
  async prFiles(repo: GitHubRepo, number: number): Promise<string[]> {
    const rows = await this.call<any[]>("GET", `/repos/${repo.owner}/${repo.name}/pulls/${number}/files?per_page=100`, undefined, { anonymous: true });
    return (Array.isArray(rows) ? rows : []).map((f) => String(f.filename ?? "")).filter(Boolean);
  }

  /** CI on a commit: every check run and status, folded into one word. */
  async ci(repo: GitHubRepo, sha: string): Promise<CiState> {
    const runs = await this.call<any>("GET", `/repos/${repo.owner}/${repo.name}/commits/${sha}/check-runs?per_page=100`, undefined, { anonymous: true }).catch(() => ({ check_runs: [] }));
    const stat = await this.call<any>("GET", `/repos/${repo.owner}/${repo.name}/commits/${sha}/status`, undefined, { anonymous: true }).catch(() => ({ statuses: [] }));
    const items = [
      ...((runs.check_runs ?? []) as any[]).map((r) => ({ name: String(r.name), done: r.status === "completed", ok: ["success", "skipped", "neutral"].includes(r.conclusion) })),
      ...((stat.statuses ?? []) as any[]).map((r) => ({ name: String(r.context), done: r.state !== "pending", ok: r.state === "success" })),
    ];
    const failed = items.filter((i) => i.done && !i.ok).map((i) => i.name);
    const state: CiState["state"] = !items.length ? "none" : failed.length ? "red" : items.some((i) => !i.done) ? "running" : "green";
    return { state, failed, total: items.length };
  }

  /** A draft PR becomes ready for review (GitHub refuses to merge a draft). */
  async markReady(nodeId: string): Promise<void> {
    await this.call("POST", "/graphql", { query: "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { id } } }", variables: { id: nodeId } });
  }

  /** Merge a pull request (squash), only if its head is still the commit that was checked. */
  async mergePr(repo: GitHubRepo, number: number, sha: string, title?: string): Promise<{ sha: string }> {
    const j = await this.call<any>("PUT", `/repos/${repo.owner}/${repo.name}/pulls/${number}/merge`, { merge_method: "squash", sha, ...(title ? { commit_title: title.slice(0, 250) } : {}) });
    return { sha: String(j.sha ?? "") };
  }

  /** Pull requests touched most recently first (one page of 50): open, closed and merged. */
  async recentPrs(repo: GitHubRepo): Promise<PrDetail[]> {
    const rows = await this.call<any[]>("GET", `/repos/${repo.owner}/${repo.name}/pulls?state=all&sort=updated&direction=desc&per_page=50`, undefined, { anonymous: true });
    return (Array.isArray(rows) ? rows : []).map((j) => ({ ...toPr(j), headSha: String(j.head?.sha ?? ""), branch: String(j.head?.ref ?? ""), base: String(j.base?.ref ?? "main"), nodeId: String(j.node_id ?? ""), author: String(j.user?.login ?? ""),
      additions: 0, deletions: 0, changedFiles: 0, mergeable: null, createdAt: String(j.created_at ?? ""), updatedAt: String(j.updated_at ?? ""), mergedAt: j.merged_at ?? null }));
  }

  /** Commits on a branch since a time (newest first, one page of 50). */
  async commits(repo: GitHubRepo, branch: string, since?: string): Promise<Commit[]> {
    const q = `sha=${encodeURIComponent(branch)}&per_page=50${since ? `&since=${encodeURIComponent(since)}` : ""}`;
    const rows = await this.call<any[]>("GET", `/repos/${repo.owner}/${repo.name}/commits?${q}`, undefined, { anonymous: true });
    return (Array.isArray(rows) ? rows : []).map((c) => ({ sha: String(c.sha), message: String(c.commit?.message ?? ""), author: String(c.author?.login ?? c.commit?.author?.name ?? ""), at: String(c.commit?.committer?.date ?? c.commit?.author?.date ?? "") }));
  }

  /** A release: its tag on `sha`, its notes as the body. */
  async release(repo: GitHubRepo, o: { tag: string; sha: string; name: string; notes: string }): Promise<{ url: string }> {
    const j = await this.call<any>("POST", `/repos/${repo.owner}/${repo.name}/releases`, { tag_name: o.tag, target_commitish: o.sha, name: o.name, body: o.notes.slice(0, 20_000) });
    return { url: String(j.html_url ?? "") };
  }

  /** Send a local repo to a repo just made for it: its branch as main, and its tags. Only into an empty repo. */
  async publishPush(dir: string, repo: GitHubRepo, branch = "HEAD"): Promise<void> {
    this.git(dir, "push", "-q", this.remote(repo), `${branch}:refs/heads/main`);
    try { this.git(dir, "push", "-q", "--tags", this.remote(repo)); } catch { /* no tags */ }
  }

  async pr(repo: GitHubRepo, number: number): Promise<PullRequest> {
    return toPr(await this.call<any>("GET", `/repos/${repo.owner}/${repo.name}/pulls/${number}`, undefined, { anonymous: true }));
  }
}

const toPr = (j: any): PullRequest => ({
  number: Number(j.number), url: String(j.html_url), state: j.state === "closed" ? "closed" : "open", merged: !!j.merged || !!j.merged_at, draft: !!j.draft, mergeSha: j.merge_commit_sha ?? null, title: String(j.title ?? ""),
});
