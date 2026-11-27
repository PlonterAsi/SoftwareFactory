import { randomBytes } from "node:crypto";
import { type GitHub, parseGitHubRepo } from "../tickets/github.js";
import type { TheRecord } from "./record.js";
import { history, plainGit, quiet } from "./ticketrun.js";

/**
 * Undo (build step 1, slice 4): an accepted change is taken back by a new commit made by SoftwareFactory, on
 * top of the project as it is today. Nothing is erased: the history keeps the change and its undo, and so does
 * the record. The undo is worked out on the Windows side as data, in the bare history; no file is checked out.
 *
 * It takes back exactly what the accept put in, and leaves later work alone. When later work was built on the
 * very lines the change touched, git cannot take it back cleanly: SoftwareFactory then refuses and says so.
 */
export interface UndoDeps { record: TheRecord; github: GitHub; workDir: string }
export type UndoResult = { ok: true; sha: string | null; url: string } | { ok: false; why: string };

export async function undoTicket(deps: UndoDeps, ticket: string): Promise<UndoResult> {
  const { record, github } = deps;
  const lines = record.story(ticket);
  if (lines.some((l) => l.kind === "result.undone")) return { ok: false, why: "This one was undone already." };
  const acc = [...lines].reverse().find((l) => l.kind === "result.accepted");
  const prop = [...lines].reverse().find((l) => l.kind === "result.proposed");
  const a = (acc?.data ?? {}) as Record<string, any>, p = (prop?.data ?? {}) as Record<string, any>;
  const sha = typeof a.sha === "string" && /^[0-9a-f]{40}$/.test(a.sha) ? a.sha : null;
  const base = typeof p.base === "string" ? p.base : "";
  const repo = parseGitHubRepo(acc?.project ?? "");
  if (!acc || !sha || !base || !repo) return { ok: false, why: "The record does not say what was put into the project for this ticket, so there is nothing to undo from here." };
  const sentence = String((lines.find((l) => l.kind === "ticket.opened")?.data as any)?.sentence ?? "").split("\n")[0]!.slice(0, 100);
  try {
    const h = history({ github }, { repo, base, workDir: deps.workDir });
    const tip = plainGit(h.dir, "rev-parse", `refs/remotes/origin/${base}`);
    try { plainGit(h.dir, "merge-base", "--is-ancestor", sha, tip); } catch { return { ok: false, why: "The accepted change is not in the project any more, so there is nothing to undo." }; }
    // The project as it is today, minus exactly what that one commit brought in.
    let tree: string;
    try { tree = plainGit(h.dir, "merge-tree", "--write-tree", `--merge-base=${sha}`, tip, `${sha}^`).split("\n")[0]!.trim(); }
    catch { return { ok: false, why: "Later work was built on top of this change, so it cannot be taken back by itself. Undo it by hand on GitHub, or ask for a ticket that removes it." }; }
    if (!/^[0-9a-f]{40}$/.test(tree)) return { ok: false, why: "The undo could not be worked out." };
    if (tree === plainGit(h.dir, "rev-parse", `${tip}^{tree}`)) return { ok: false, why: "The project already looks as if this change was never made." };
    const who = ["-c", "user.name=SoftwareFactory", "-c", "user.email=softwarefactory@softwarefactory.invalid"];
    const message = `Undo ${ticket}: ${quiet(sentence)}\n\nTakes back ${sha.slice(0, 12)}, on your press of Undo in SoftwareFactory.`;
    const commit = plainGit(h.dir, ...who, "commit-tree", tree, "-p", tip, "-m", message);
    const branch = `sf/undo-${ticket.toLowerCase()}-${randomBytes(4).toString("hex")}`;
    plainGit(h.dir, "update-ref", `refs/heads/${branch}`, commit);
    const stamp = { who: "you", run: acc.run, ticket, project: acc.project };
    if (!github.hasToken()) {
      await github.pushBranch({ repo, dir: h.dir, branch, base });
      const url = github.compareUrl(repo, base, branch);
      record.append({ kind: "result.undone", ...stamp, data: { url, branch, base, takesBack: sha } });
      return { ok: true, sha: null, url };
    }
    plainGit(h.dir, "symbolic-ref", "HEAD", `refs/heads/${branch}`);
    let pr;
    try { pr = await github.openPr({ repo, dir: h.dir, branch, base, title: `Undo ${ticket}: ${quiet(sentence)}`.slice(0, 120), body: `Takes back ${sha} (ticket **${ticket}**), on the owner's press of Undo in SoftwareFactory. The history keeps both steps.` }); }
    finally { plainGit(h.dir, "symbolic-ref", "HEAD", `refs/heads/${base}`); }
    const detail = await github.prDetail(repo, pr.number);
    if (detail.headSha !== commit) return { ok: false, why: "The undo on GitHub is not the one SoftwareFactory made, so it was not put in." };
    if (detail.draft) await github.markReady(detail.nodeId);
    const merged = await github.mergePr(repo, pr.number, commit, detail.title);
    record.append({ kind: "result.undone", ...stamp, data: { url: pr.url, number: pr.number, sha: merged.sha, branch, base, takesBack: sha } });
    return { ok: true, sha: merged.sha, url: pr.url };
  } catch (e) {
    return { ok: false, why: `The undo did not go through: ${(e as Error).message.slice(0, 200)}` };
  }
}
