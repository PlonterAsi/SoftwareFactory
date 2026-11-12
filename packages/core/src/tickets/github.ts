import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
export interface PullRequest { number: number; url: string; state: "open" | "closed"; merged: boolean; draft: boolean; mergeSha: string | null }

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

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = this.token();
    if (!token) throw new Error("No GitHub access yet: add a token in Systems, GitHub access.");
    const r = await this.http(`${this.api}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json", "user-agent": "SoftwareFactory" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({})) as any;
    if (!r.ok) throw new Error(hideTokens(`GitHub said ${r.status}${j?.message ? `: ${j.message}` : ""}`));
    return j as T;
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

  async pr(repo: GitHubRepo, number: number): Promise<PullRequest> {
    return toPr(await this.call<any>("GET", `/repos/${repo.owner}/${repo.name}/pulls/${number}`));
  }
}

const toPr = (j: any): PullRequest => ({
  number: Number(j.number), url: String(j.html_url), state: j.state === "closed" ? "closed" : "open", merged: !!j.merged || !!j.merged_at, draft: !!j.draft, mergeSha: j.merge_commit_sha ?? null,
});
