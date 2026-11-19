import { existsSync } from "node:fs";
import { join } from "node:path";
import { git } from "../factory/workspace.js";
import { repoOfProject, type RepoRef } from "./repowork.js";
import { hideTokens, parseGitHubRepo, type MergedPr } from "./github.js";
import { TASTE_KINDS, isClosed, type TicketView } from "./model.js";
import { TicketReads } from "./reads.js";
import type { Row } from "./rows.js";
import { ticketNumbersIn } from "./shapes.js";

/**
 * Tickets on GitHub: a worked branch goes out as a draft PR (or is sent by your press), and merged pull
 * requests move their tickets on, the crew's own and any whose title names a ticket.
 */
export abstract class TicketPrs extends TicketReads {
  /**
   * The branch goes to GitHub as a draft PR, when the crew may ship: the real
   * crew, a token that can write, and never main. The ticket waits for your
   * look; CI runs on the PR, and its merge moves the ticket on (followPrs).
   * Returns false when it stays a local branch, after saying why.
   */
  protected async openPr(id: number, repo: RepoRef, r: { dir: string; branch: string; base: string; files: string[]; summary: string; costUsd: number; checks?: string[] }): Promise<boolean> {
    const gh = this.opts.github;
    const t = this.get(id)!;
    const why = !gh ? "GitHub access is not set up in this core." : this.opts.canShip?.() ?? (gh.hasToken() ? null : "No GitHub access yet: add a token in Systems, GitHub access, and the crew opens a PR next time.");
    if (why) { this.log.append("ticket.noted", { id, by: "factory", kind: "event", text: `The branch stays on this computer: ${why}` }); return false; }
    let baseBranch = "main";
    try { baseBranch = gh!.git(r.dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").replace(/^origin\//, ""); } catch { /* main */ }
    const pr = await gh!.openPr({
      repo: repo.github!, dir: r.dir, branch: r.branch, base: baseBranch, title: `${t.key}: ${t.title}`.slice(0, 200),
      body: [`Ticket **${t.key}** (${t.kind}) from SoftwareFactory, worked by the crew.`, "", r.summary || "", "", `Changed ${r.files.length} file(s).`, "", r.checks?.length ? `Checks passed: ${r.checks.join(", ")}.` : "", "", "_Opened as a draft by SoftwareFactory's crew. It never pushes to main; merging is a person's call or the auto-merge rule._"].join("\n").slice(0, 6000),
    });
    this.log.append("ticket.pr", { id, by: "factory", repo: `${repo.github!.owner}/${repo.github!.name}`, number: pr.number, url: pr.url, branch: r.branch, state: "open" });
    const now = this.get(id)!;
    this.log.append("ticket.noted", {
      id, by: "factory", kind: "reply", costUsd: r.costUsd, status: now.status !== "built" && !isClosed(now.status) ? "built" : undefined,
      text: `${r.summary || "Done."}\n\nOpened draft PR #${pr.number}: ${pr.url}. Windows CI runs on it; when it merges, this ticket moves on by itself.`,
    });
    return true;
  }

  /**
   * Your press on a built ticket whose branch stayed on this computer: send that
   * branch to GitHub. With a token it becomes a draft PR like the crew's own.
   * Without one, this PC's own Git sign-in pushes it and the ticket carries the
   * address that starts the pull request. Only the ticket's branch, never main.
   */
  async send(id: number, by = "you"): Promise<TicketView> {
    const t = this.must(id);
    const gh = this.opts.github;
    const repo = repoOfProject(this.log, t.project);
    if (!repo) throw new Error("This ticket's project has no repo to send a branch to.");
    if (t.pr) throw new Error(`This ticket already has pull request #${t.pr.number}.`);
    if (!t.branch || !t.branchDir) throw new Error("There is no branch yet: press Work it first.");
    if (this.inRepo.has(id)) throw new Error("The Builder is still working this ticket.");
    if (this.sending.has(id)) throw new Error("This branch is already on its way to GitHub.");
    if (!existsSync(join(t.branchDir, ".git"))) throw new Error("The folder with this branch is gone. Press Work it to build it again.");
    if (!repo.github) {
      // A folder on this computer: the branch is added to it and nothing else moves (not its files, not its current branch).
      if (!existsSync(join(repo.source, ".git"))) throw new Error(`The original folder (${repo.source}) is not on this computer any more.`);
      try { git(repo.source, "fetch", "-q", t.branchDir, `${t.branch}:${t.branch}`); }
      catch (e) { throw new Error(/checked out|non-fast-forward|rejected/i.test((e as Error).message) ? `Your folder already has a branch ${t.branch} that differs or is open in it. Switch away from it there, then press again.` : `Could not add the branch to your folder: ${(e as Error).message.slice(0, 300)}`); }
      this.log.append("ticket.pushed", { id, by, repo: repo.source, branch: t.branch, url: null });
      this.log.append("ticket.noted", { id, by: "factory", kind: "event", text: `Branch ${t.branch} is now in ${repo.source}. Your files there did not change; merge the branch when you want it.` });
      return this.get(id)!;
    }
    if (!gh) throw new Error("GitHub access is not set up in this core.");
    const why = this.opts.canShip?.();
    if (why) throw new Error(`Not sent: ${why}.`);
    this.sending.add(id);
    try {
      let base = "main";
      try { base = gh.git(t.branchDir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").replace(/^origin\//, ""); } catch { /* main */ }
      if (gh.hasToken()) {
        let files: string[] = [];
        try { files = gh.git(t.branchDir, "diff", "--name-only", `origin/${base}...${t.branch}`).split("\n").filter(Boolean); } catch { /* unknown */ }
        gh.git(t.branchDir, "checkout", "-q", t.branch);
        await this.openPr(id, repo, { dir: t.branchDir, branch: t.branch, base, files, summary: "", costUsd: 0 });
      } else {
        await gh.pushBranch({ repo: repo.github, dir: t.branchDir, branch: t.branch, base });
        const url = gh.compareUrl(repo.github, base, t.branch);
        this.log.append("ticket.pushed", { id, by, repo: `${repo.github.owner}/${repo.github.name}`, branch: t.branch, base, url });
        this.log.append("ticket.noted", { id, by: "factory", kind: "event", text: `The branch is on GitHub. Open the pull request there (${url}), name it ${t.key}, and its merge moves this ticket on by itself.` });
      }
    } finally { this.sending.delete(id); }
    return this.get(id)!;
  }
  protected sending = new Set<number>();

  /** Follow every open PR of a ticket: merged moves it on, closed without a merge sends it back. */
  async followPrs(): Promise<number> {
    const gh = this.opts.github;
    if (!gh?.hasToken()) return 0;
    const rows = this.log.db.prepare("SELECT id, pr_repo, pr_number FROM tickets WHERE pr_state = 'open' AND pr_number IS NOT NULL").all() as Row[];
    let moved = 0;
    for (const row of rows) {
      const [owner, name] = String(row.pr_repo).split("/");
      try {
        const pr = await gh.pr({ owner, name }, Number(row.pr_number));
        if (pr.state === "open") continue;
        const id = Number(row.id);
        this.log.append("ticket.pr", { id, by: "github", repo: row.pr_repo, number: pr.number, url: pr.url, state: pr.merged ? "merged" : "closed", sha: pr.mergeSha });
        const t = this.get(id)!;
        moved++;
        if (isClosed(t.status)) continue;
        if (pr.merged) {
          // Merged after CI: work kinds are done; taste kinds wait for your look on the next version.
          const done = !TASTE_KINDS.includes(t.kind);
          this.log.append("ticket.noted", { id, by: "github", status: done ? "closed" : t.status === "built" ? undefined : "built", text: `PR #${pr.number} was merged.${done ? " Closed: it ships with the next version." : " It ships with the next version; take a look then."}` });
        } else {
          this.log.append("ticket.noted", { id, by: "github", status: "open", text: `PR #${pr.number} was closed without merging, so this ticket is open again.` });
        }
      } catch (e) { console.error("tickets: following PR", row.pr_number, "failed:", hideTokens((e as Error).message)); }
    }
    return moved;
  }

  /**
   * Work merged outside the ticket's own PR still moves its ticket: a merged pull
   * request whose title or branch names a ticket ("SF-13", "SF-16, 17, 18", "SF-57/58",
   * "sf/SF-24-...") is linked to it, and the ticket moves on as if the crew's PR
   * had merged. Each PR counts once per ticket, so a ticket you reopen stays open.
   */
  async followMerges(): Promise<number> {
    const gh = this.opts.github;
    if (!gh) return 0;
    const has = (t: string) => !!this.log.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    if (!has("project_links")) return 0;
    const projects = this.log.db.prepare("SELECT k.project, k.key, l.ref FROM ticket_keys k JOIN project_links l ON l.project_id = k.project AND l.kind = 'github' GROUP BY k.project").all() as { project: number; key: string; ref: string }[];
    const seen = this.log.db.prepare("SELECT 1 FROM events WHERE type = 'ticket.pr' AND json_extract(payload, '$.id') = ? AND json_extract(payload, '$.number') = ? AND json_extract(payload, '$.state') = 'merged' LIMIT 1");
    let moved = 0;
    for (const p of projects) {
      const repo = parseGitHubRepo(p.ref);
      if (!repo) continue;
      let prs: MergedPr[];
      try { prs = await gh.mergedPrs(repo); } catch (e) { console.error("tickets: reading merged PRs of", p.ref, "failed:", hideTokens((e as Error).message)); continue; }
      // Oldest first, so a ticket named by several PRs ends on the newest.
      for (const pr of prs.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt))) {
        for (const number of ticketNumbersIn(`${pr.title}\n${pr.branch}`, p.key)) {
          const t = this.byKey(`${p.key}-${number}`);
          if (!t || seen.get(t.id, pr.number)) continue;
          // A ticket opened after the merge only mentions old work; it is not done by it.
          if (t.createdAt > pr.mergedAt) continue;
          this.log.append("ticket.pr", { id: t.id, by: "github", repo: `${repo.owner}/${repo.name}`, number: pr.number, url: pr.url, state: "merged", sha: pr.mergeSha });
          moved++;
          if (isClosed(t.status)) continue;
          const done = !TASTE_KINDS.includes(t.kind);
          this.log.append("ticket.noted", { id: t.id, by: "github", status: done ? "closed" : t.status === "built" ? undefined : "built", text: `PR #${pr.number} "${pr.title.slice(0, 120)}" names this ticket and was merged.${done ? " Closed: it is in the app." : " It is in the app; take a look and close it."}` });
        }
      }
    }
    return moved;
  }

  /**
   * Link a ticket to a pull request that was opened outside SoftwareFactory (a thread's PR, your own).
   * From then on it is followed like the crew's own: already merged moves the ticket now, open waits for the merge.
   */
  async linkPr(id: number, ref: string | number, by = "you"): Promise<TicketView> {
    const t = this.must(id);
    const gh = this.opts.github;
    const repo = repoOfProject(this.log, t.project)?.github;
    if (!gh || !repo) throw new Error("This ticket's project has no GitHub repo, so there is no pull request to link.");
    const m = String(ref ?? "").trim().match(/(?:^#?|\/pull\/)(\d+)\/?$/);
    if (!m) throw new Error("Give the pull request's number (84) or its GitHub address.");
    const pr = await gh.pr(repo, Number(m[1]));
    const state = pr.merged ? "merged" : pr.state;
    this.log.append("ticket.pr", { id, by, repo: `${repo.owner}/${repo.name}`, number: pr.number, url: pr.url, state, sha: pr.mergeSha });
    if (pr.merged && !isClosed(t.status)) {
      const done = !TASTE_KINDS.includes(t.kind);
      this.log.append("ticket.noted", { id, by: "github", status: done ? "closed" : t.status === "built" ? undefined : "built", text: `PR #${pr.number} "${pr.title.slice(0, 120)}" was linked and is already merged.${done ? " Closed: it is in the app." : " It is in the app; take a look and close it."}` });
    }
    return this.get(id)!;
  }

  /** Wait for a ticket's repo work to finish (tests, the CLI). */
  waitRepo(id: number): Promise<void> { return this.inRepo.get(id) ?? Promise.resolve(); }
}
