import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, git } from "../src/index.js";
import type { AgentRequest, AgentResult, AgentRuntime } from "../src/runtime.js";
import { prepareClone, siblingStack, workInRepo, type RepoRef } from "../src/tickets/repowork.js";

/** SF-29: a ticket of a plan builds on its earlier siblings' branches that are not merged yet. */

function repo(): { ref: RepoRef; workRoot: string } {
  const src = mkdtempSync(join(tmpdir(), "sf-stack-src-"));
  git(src, "init", "-q", "-b", "main");
  writeFileSync(join(src, "shared.txt"), "one\n");
  git(src, "add", "-A");
  git(src, "commit", "-q", "-m", "init");
  return { ref: { source: src, dir: src, branch: null }, workRoot: mkdtempSync(join(tmpdir(), "sf-stack-work-")) };
}

/** A sibling's clone with one commit on its branch. */
function sibling(r: ReturnType<typeof repo>, id: number, file: string, text: string) {
  const branch = `sf/SF-${id}-part`;
  const { dir } = prepareClone(r.ref, r.workRoot, id, branch);
  writeFileSync(join(dir, file), text);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `SF-${id}`);
  return { key: `SF-${id}`, branch, dir };
}

describe("siblingStack", () => {
  const base = { branch: "sf/x", branchDir: tmpdir(), pr: null };
  it("takes earlier siblings whose branch is built or has an open PR, never merged, closed or later ones", () => {
    const d = mkdtempSync(join(tmpdir(), "sf-stack-dir-"));
    git(d, "init", "-q");
    const lines = [
      { ...base, id: 1, key: "SF-1", status: "built" as const, branchDir: d },
      { ...base, id: 2, key: "SF-2", status: "in_progress" as const, branchDir: d },
      { ...base, id: 3, key: "SF-3", status: "in_progress" as const, branchDir: d, pr: { repo: "o/n", number: 3, url: "", state: "open" as const } },
      { ...base, id: 4, key: "SF-4", status: "built" as const, branchDir: d, pr: { repo: "o/n", number: 4, url: "", state: "merged" as const } },
      { ...base, id: 5, key: "SF-5", status: "closed" as const, branchDir: d },
      { ...base, id: 6, key: "SF-6", status: "built" as const, branch: null, branchDir: null },
      { ...base, id: 7, key: "SF-7", status: "open" as const, branch: null, branchDir: null },
      { ...base, id: 8, key: "SF-8", status: "built" as const, branchDir: d },
    ];
    expect(siblingStack(lines, 7).map((s) => s.key)).toEqual(["SF-1", "SF-3"]);
    expect(siblingStack(lines, 1)).toEqual([]);
    expect(siblingStack(lines, 99)).toEqual([]);
    // A branch whose clone is gone is left out.
    expect(siblingStack([{ ...lines[0], branchDir: join(d, "gone") }, lines[6]], 7)).toEqual([]);
  });
});

describe("prepareClone with a stack", () => {
  it("merges the siblings' branches in and measures the ticket's work from after them", () => {
    const r = repo();
    const a = sibling(r, 1, "a.txt", "from SF-1\n");
    const c = prepareClone(r.ref, r.workRoot, 2, "sf/SF-2-next", undefined, undefined, [a]);
    expect(c.stacked).toEqual({ merged: ["SF-1"], skipped: [] });
    expect(existsSync(join(c.dir, "a.txt"))).toBe(true);
    // The ticket's own commit is the only change from the base.
    writeFileSync(join(c.dir, "b.txt"), "mine\n");
    git(c.dir, "add", "-A");
    git(c.dir, "commit", "-q", "-m", "SF-2");
    expect(git(c.dir, "diff", "--name-only", `${c.base}..HEAD`)).toBe("b.txt");
    // A second pass takes nothing new and keeps the base, so the ticket's earlier work still counts as its own.
    const again = prepareClone(r.ref, r.workRoot, 2, "sf/SF-2-next", undefined, undefined, [a]);
    expect(again.base).toBe(c.base);
    expect(again.stacked.merged).toEqual(["SF-1"]);
  });

  it("leaves out a sibling that conflicts, undoes the merge and says why", () => {
    const r = repo();
    const a = sibling(r, 1, "shared.txt", "SF-1 wrote this\n");
    const b = sibling(r, 2, "shared.txt", "SF-2 wrote that\n");
    const c = prepareClone(r.ref, r.workRoot, 3, "sf/SF-3-last", undefined, undefined, [a, b]);
    expect(c.stacked.merged).toEqual(["SF-1"]);
    expect(c.stacked.skipped).toEqual([{ key: "SF-2", why: "it conflicts with this ticket's branch" }]);
    expect(git(c.dir, "status", "--porcelain")).toBe("");
  });

  it("with no stack, the base is where the branch left main, as before", () => {
    const r = repo();
    const c = prepareClone(r.ref, r.workRoot, 1, "sf/SF-1-alone");
    expect(c.stacked).toEqual({ merged: [], skipped: [] });
    expect(c.base).toBe(git(c.dir, "rev-parse", "--short=12", "HEAD"));
  });
});

class Fake implements AgentRuntime {
  readonly name = "fake";
  calls: AgentRequest[] = [];
  async run(req: AgentRequest): Promise<AgentResult> {
    this.calls.push(req);
    const reviewer = /Station contract: review/.test(req.systemPrompt ?? "");
    const text = reviewer ? "```json\n" + JSON.stringify({ verdict: "pass", findings: [] }) + "\n```" : "<<<FILE src/own.txt\nmine\nFILE>>>\nDid it.";
    return { text, costUsd: 0.01, durationMs: 1, models: ["fake"], runtime: "fake", contextTokens: 0 };
  }
}

describe("workInRepo with a stack", () => {
  it("tells the Builder what the branch already holds, notes it on the ticket and lists only its own files", async () => {
    const r = repo();
    const a = sibling(r, 1, "a.txt", "from SF-1\n");
    const log = new EventLog();
    const rt = new Fake();
    const ok = { ok: true, output: "" };
    const res = await workInRepo(log, rt, undefined, { id: 2, key: "SF-2", title: "Next part", document: "# SF-2", repo: r.ref, workRoot: r.workRoot, maxUsd: 0.6, checks: { runTests: () => ok }, stack: [a] });
    expect(res.ok).toBe(true);
    expect(res.files).toEqual(["src/own.txt"]);
    expect(rt.calls[0].prompt).toMatch(/already holds the work of SF-1/);
    const notes = (log.db.prepare("SELECT payload FROM events WHERE type = 'ticket.noted'").all() as { payload: string }[]).map((x) => JSON.parse(x.payload).text as string);
    expect(notes.some((t) => /^Built on SF-1/.test(t))).toBe(true);
  });
});
