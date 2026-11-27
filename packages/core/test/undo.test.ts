import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHub } from "../src/tickets/github.js";
import { ticketsFrom } from "../src/fence/home.js";
import { TheRecord } from "../src/fence/record.js";
import { undoTicket } from "../src/fence/undo.js";

// Real git, a real project, no GitHub API: without a token the undo is pushed as a branch, and that branch is looked at.
describe("undo", () => {
  const root = mkdtempSync(join(tmpdir(), "sf-undo-"));
  const seed = join(root, "seed"), origin = join(root, "origin.git");
  const g = (dir: string, ...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  const commit = (file: string, text: string, msg: string) => { writeFileSync(join(seed, file), text); g(seed, "add", "-A"); g(seed, "commit", "-q", "-m", msg); g(seed, "push", "-q", origin, "main"); return g(seed, "rev-parse", "HEAD"); };
  const deps = (record: TheRecord) => ({ record, workDir: join(root, `sf-${Math.random().toString(36).slice(2)}`), github: new GitHub({ dataDir: mkdtempSync(join(tmpdir(), "sf-gh-")), gitUrl: () => origin }) });
  const accepted = (r: TheRecord, sha: string) => {
    r.append({ kind: "ticket.opened", who: "you", ticket: "T1", project: "o/p", data: { sentence: "Add a footer." } });
    r.append({ kind: "result.proposed", who: "SF itself", run: "T1-x", ticket: "T1", project: "o/p", data: { url: "https://github.com/o/p/pull/7", number: 7, base: "main", headSha: "a".repeat(40) } });
    r.append({ kind: "result.accepted", who: "you", run: "T1-x", ticket: "T1", project: "o/p", data: { number: 7, sha, base: "main" } });
  };
  let change = "";

  beforeAll(() => {
    mkdirSync(seed, { recursive: true });
    g(seed, "init", "-q", "-b", "main"); g(seed, "config", "user.email", "a@b.c"); g(seed, "config", "user.name", "Owner");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    commit("page.txt", "header\nbody\n", "first");
    change = commit("page.txt", "header\nbody\nfooter\n", "T1: Add a footer.");
    commit("other.txt", "later work\n", "later, somewhere else");
  });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  it("takes back exactly the accepted change, keeps later work, erases nothing, and the record says so", async () => {
    const r = new TheRecord();
    accepted(r, change);
    expect(ticketsFrom(r.all(), null)[0]).toMatchObject({ state: "accepted", canUndo: true });
    const before = g(origin, "rev-parse", "main");
    const u = await undoTicket(deps(r), "T1");
    expect(u).toMatchObject({ ok: true });
    const branch = g(origin, "branch", "--list", "sf/undo-t1-*").replace(/^[* ]+/, "");
    expect(g(origin, "show", `${branch}:page.txt`)).toBe("header\nbody");
    expect(g(origin, "show", `${branch}:other.txt`)).toBe("later work");
    expect(g(origin, "rev-parse", `${branch}^`)).toBe(before);
    expect(g(origin, "rev-parse", "main")).toBe(before);
    expect(g(origin, "log", "-1", "--format=%s", branch)).toBe("Undo T1: Add a footer.");
    expect(r.all().at(-1)).toMatchObject({ kind: "result.undone", who: "you", ticket: "T1", data: { takesBack: change } });
    expect(ticketsFrom(r.all(), null)[0]).toMatchObject({ state: "undone", canUndo: false });
    expect(await undoTicket(deps(r), "T1")).toMatchObject({ ok: false, why: expect.stringMatching(/already/) });
  });

  it("refuses when later work was built on the same lines, and when there is nothing to undo", async () => {
    commit("page.txt", "header\nbody\nfooter, now with links\n", "later, on the very same line");
    const r = new TheRecord();
    accepted(r, change);
    expect(await undoTicket(deps(r), "T1")).toMatchObject({ ok: false, why: expect.stringMatching(/built on top/) });
    expect(r.all().filter((l) => l.kind === "result.undone")).toHaveLength(0);
    const r2 = new TheRecord();
    accepted(r2, "c".repeat(40));
    expect(await undoTicket(deps(r2), "T1")).toMatchObject({ ok: false });
    expect(await undoTicket(deps(new TheRecord()), "T9")).toMatchObject({ ok: false });
  });
});
