import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, Tickets, git } from "../src/index.js";
import { prepareClone, type RepoRef } from "../src/tickets/repowork.js";

/** SF-94: crew work a restart or the PC going to sleep cut off picks up again instead of staying stuck. */

describe("a ticket cut off by a restart", () => {
  const open = (t: Tickets, status: "ready" | "open") => {
    const x = t.open({ project: 7, title: "Cut off", body: "A ticket the crew was working when the app closed." });
    if (status === "ready") t.say(x.id, "", { status: "ready" });
    t.say(x.id, "Working it in a clone, on branch sf/x.", { status: "in_progress", by: "builder", kind: "event" });
    return x.id;
  };

  it("goes back to the status it had before the crew took it, once, and says so", () => {
    const log = new EventLog();
    const t = new Tickets(log);
    const a = open(t, "ready"), b = open(t, "open");
    expect(t.recoverInterrupted().sort()).toEqual([a, b].sort());
    expect(t.get(a)!.status).toBe("ready");
    expect(t.get(b)!.status).toBe("open");
    expect(t.notes(a).at(-1)!.text).toMatch(/app closed while the crew was working this/);
    // Nothing is In progress any more, so a second start finds nothing to do.
    expect(t.recoverInterrupted()).toEqual([]);
  });

  it("leaves engine runs to the factory and work going on in this process alone", () => {
    const log = new EventLog();
    const t = new Tickets(log);
    const id = open(t, "ready");
    log.append("ticket.run", { id, run: 42, by: "you" });
    expect(t.recoverInterrupted()).toEqual([]);
    expect(t.get(id)!.status).toBe("in_progress");
  });

  it("waits in Open for a person once it was cut off twice before", () => {
    const log = new EventLog();
    const t = new Tickets(log);
    const id = open(t, "ready");
    for (let i = 0; i < 2; i++) {
      t.recoverInterrupted();
      t.say(id, "Working it again.", { status: "in_progress", by: "builder", kind: "event" });
    }
    t.recoverInterrupted();
    expect(t.get(id)!.status).toBe("open");
    expect(t.notes(id).at(-1)!.text).toMatch(/cut off twice before/);
  });
});

describe("prepareClone after a clone was cut off", () => {
  it("moves the half clone aside and clones again, so the ticket's branch can be made", () => {
    const src = mkdtempSync(join(tmpdir(), "sf-cut-src-"));
    git(src, "init", "-q", "-b", "main");
    writeFileSync(join(src, "a.txt"), "one\n");
    git(src, "add", "-A");
    git(src, "commit", "-q", "-m", "init");
    const ref: RepoRef = { source: src, dir: src, branch: null };
    const workRoot = mkdtempSync(join(tmpdir(), "sf-cut-work-"));
    // What a `git clone` killed after its fetch leaves: a .git with origin's objects and refs, but no HEAD commit and no checkout.
    const half = join(workRoot, "ticket-5");
    mkdirSync(half);
    git(half, "init", "-q");
    git(half, "remote", "add", "origin", src);
    git(half, "fetch", "-q", "origin");
    const { dir } = prepareClone(ref, workRoot, 5, "sf/SF-5-cut");
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("sf/SF-5-cut");
    expect(existsSync(join(dir, "a.txt"))).toBe(true);
    // Moved aside, never deleted.
    expect(readdirSync(workRoot).some((n) => n.startsWith("ticket-5.broken-"))).toBe(true);
  });

  it("keeps a clone that has work in it", () => {
    const src = mkdtempSync(join(tmpdir(), "sf-cut-src-"));
    git(src, "init", "-q", "-b", "main");
    writeFileSync(join(src, "a.txt"), "one\n");
    git(src, "add", "-A");
    git(src, "commit", "-q", "-m", "init");
    const ref: RepoRef = { source: src, dir: src, branch: null };
    const workRoot = mkdtempSync(join(tmpdir(), "sf-cut-work-"));
    const first = prepareClone(ref, workRoot, 6, "sf/SF-6-keep");
    writeFileSync(join(first.dir, "b.txt"), "work in progress\n");
    prepareClone(ref, workRoot, 6, "sf/SF-6-keep");
    expect(existsSync(join(first.dir, "b.txt"))).toBe(true);
    expect(readdirSync(workRoot)).toEqual(["ticket-6"]);
  });
});
