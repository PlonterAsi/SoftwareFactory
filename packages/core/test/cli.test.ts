import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, MockRuntime, createCore } from "../src/index.js";

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
