import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, MockRuntime, Tickets, createCore } from "../src/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "sf-cli-"));

describe("sf: the tickets from any terminal (gap 10, agent interfaces outside the app)", () => {
  it("opens, lists, shows, replies, marks asked and reads the inbox through the core's API", async () => {
    const log = new EventLog();
    const server = createServer(createCore({ log, runtime: new MockRuntime(), projectsDir: tmp(), dropDir: tmp() }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    process.env.SF_URL = `http://127.0.0.1:${port}`;
    // @ts-expect-error plain JS module
    const { run, parseArgs } = await import("../bin/sf.mjs");
    const out: string[] = [];
    const sf = async (...a: string[]) => { out.length = 0; await run(a, (s: string) => out.push(s)); return out.join("\n"); };
    try {
      expect(parseArgs(["open", "x", "--kind", "bug", "--asked"])).toEqual({ pos: ["open", "x"], flags: { kind: "bug", asked: true } });
      const opened = await sf("open", "Footer link is broken", "--kind", "bug", "--body", "It points to /contct.", "--size", "s");
      const key = opened.match(/Opened (\S+):/)![1];
      expect(await sf("list")).toContain("Footer link is broken");
      const shown = await sf("show", key);
      expect(shown).toMatch(/bug, open, size S/);
      expect(shown).toContain("It points to /contct.");
      expect(await sf("reply", key, "Seen in templates/base.html", "--status", "ready")).toMatch(/it is ready now/);
      expect(await sf("show", key)).toContain("Seen in templates/base.html");
      expect(await sf("asked", key)).toMatch(/asked for/);
      expect(JSON.parse(await sf("show", key, "--json")).asked).toBe(true);
      expect(await sf("doc", key)).toContain("Footer link is broken");
      await sf("open", "Should we keep the old logo?", "--kind", "question");
      expect(await sf("inbox")).toMatch(/answer .*old logo/);
      await expect(sf("show", "SF-9999")).rejects.toThrow(/No ticket/);
      await expect(sf("nope")).rejects.toThrow(/No command/);
    } finally {
      server.close();
      delete process.env.SF_URL;
    }
  });

  it("says plainly when the app is not running", async () => {
    process.env.SF_URL = "http://127.0.0.1:9";
    // @ts-expect-error plain JS module
    const { run } = await import("../bin/sf.mjs?down");
    await expect(run(["list"], () => {})).rejects.toThrow(/not running/);
    delete process.env.SF_URL;
  });
});

describe("many tickets at once (gap 6, list parity)", () => {
  it("moves, sizes, prioritizes and asks for many; one that refuses says why and the rest still move", () => {
    const log = new EventLog();
    const t = new Tickets(log);
    const a = t.open({ kind: "bug", title: "Footer link is broken" });
    const b = t.open({ kind: "task", title: "Test the home view" });
    const c = t.open({ kind: "task", title: "Already done" });
    t.say(c.id, "", { status: "closed" });
    expect(t.bulk([a.id, b.id], "size", "S").done).toEqual([a.id, b.id]);
    expect(t.bulk([a.id, b.id], "priority", "now").done).toHaveLength(2);
    expect(t.bulk([a.id, b.id], "status", "ready").done).toEqual([a.id, b.id]);
    expect(t.get(a.id)).toMatchObject({ status: "ready", size: "S", priority: "now" });
    const asked = t.bulk([a.id, b.id, c.id], "asked", true);
    expect(asked.done).toEqual([a.id, b.id]);
    expect(asked.failed).toEqual([{ id: c.id, key: c.key, error: expect.stringMatching(/closed/) }]);
    expect(t.detail(b.id)!.asked).toBe(true);
    expect(() => t.bulk([], "status", "ready")).toThrow(/at least one/);
    expect(() => t.bulk([a.id], "title", "x")).toThrow(/cannot be done/);
    const md = t.exportTickets([a.id, b.id]);
    expect(md).toMatch(new RegExp(`## ${a.key} Footer link is broken\\nbug, ready, size S`));
    expect(md).toContain(`## ${b.key} Test the home view`);
    const json = JSON.parse(t.exportTickets([a.id], "json"));
    expect(json[0].ticket.title).toBe("Footer link is broken");
    expect(json[0].document).toBeUndefined();
  });
});
