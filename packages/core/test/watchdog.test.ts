import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TheRecord } from "../src/fence/record.js";
import { WATCH_DEFAULTS, cleanWatch, look, phoneLine, readAlive, runWatchdog, speak, writeAlive, type Alive, type Sender } from "../src/fence/watchdog.js";

const at = (secondsAgo: number, now = new Date("2026-11-27T18:00:00Z")) => new Date(now.getTime() - secondsAgo * 1000).toISOString();
const NOW = new Date("2026-11-27T18:00:00Z");
const run = (lastLineAgo = 5) => ({ ticket: "T4", startedAt: at(600), lastLineAt: at(lastLineAgo) });

describe("the watchdog's one look", () => {
  it("says nothing while SoftwareFactory is alive and the run talks, and goes home when it was closed on purpose", () => {
    expect(look({ pid: 1, at: at(3), running: run() }, WATCH_DEFAULTS, { spoke: {} }, NOW)).toEqual({ say: null, endRoom: false, done: false });
    expect(look({ pid: 1, at: at(3), closed: true, running: null }, WATCH_DEFAULTS, { spoke: {} }, NOW).done).toBe(true);
    expect(look(null, WATCH_DEFAULTS, { spoke: {} }, NOW)).toEqual({ say: null, endRoom: false, done: false });
  });

  it("speaks once and ends the room when SoftwareFactory went away in the middle of a run", () => {
    const state = { spoke: {} as Record<string, true> };
    const v = look({ pid: 1, at: at(120), running: run() }, WATCH_DEFAULTS, state, NOW);
    expect(v).toMatchObject({ endRoom: true, done: true, say: { ticket: "T4", why: "gone" } });
    expect(v.say!.line).toMatch(/went away while T4/);
    state.spoke[v.say!.key] = true;
    expect(look({ pid: 1, at: at(130), running: run() }, WATCH_DEFAULTS, state, NOW)).toMatchObject({ say: null, endRoom: false, done: true });
  });

  it("is quiet when SoftwareFactory went away with nothing running", () => {
    expect(look({ pid: 1, at: at(120), running: null }, WATCH_DEFAULTS, { spoke: {} }, NOW)).toEqual({ say: null, endRoom: false, done: true });
  });

  it("speaks once when a run has been silent too long, and does not end it", () => {
    const state = { spoke: {} as Record<string, true> };
    const v = look({ pid: 1, at: at(2), running: run(11 * 60) }, WATCH_DEFAULTS, state, NOW);
    expect(v).toMatchObject({ endRoom: false, done: false, say: { why: "silent" } });
    state.spoke[v.say!.key] = true;
    expect(look({ pid: 1, at: at(2), running: run(12 * 60) }, WATCH_DEFAULTS, state, NOW).say).toBeNull();
  });
});

describe("speaking", () => {
  it("always writes the line in the record, and sends it to the phone only when one is set", async () => {
    const r = new TheRecord();
    const sent: { url: string; body: string }[] = [];
    const send: Sender = async (url, body) => { sent.push({ url, body }); return { ok: true, status: 200 }; };
    expect(await speak({ record: r, settings: () => WATCH_DEFAULTS, send }, { line: "T4 has been silent.", ticket: "T4", why: "silent" })).toEqual({ phone: "not set" });
    expect(sent).toHaveLength(0);
    const on = cleanWatch({ phone: "ntfy", ntfyTopic: "abcdefghijklmnop1234" });
    expect(await speak({ record: r, settings: () => on, send }, { line: "T4 has been silent.", ticket: "T4", why: "silent" })).toEqual({ phone: "sent" });
    expect(sent).toEqual([{ url: "https://ntfy.sh/abcdefghijklmnop1234", body: "T4 has been silent." }]);
    expect(r.all().map((l) => [l.kind, l.who, l.ticket, (l.data as any).phone])).toEqual([["watchdog.spoke", "watchdog", "T4", "not set"], ["watchdog.spoke", "watchdog", "T4", "sent"]]);
    const broken: Sender = async () => { throw new Error("no network"); };
    expect(await speak({ record: r, settings: () => on, send: broken }, { line: "x", why: "gone" })).toEqual({ phone: "failed" });
  });

  it("keeps a phone line short and plain, and the settings honest", () => {
    expect(phoneLine("T4 \u001b[31mdone\n\n" + "x".repeat(400))).toHaveLength(160);
    expect(phoneLine("a‮b\tc")).toBe("a b c");
    expect(() => cleanWatch({ phone: "ntfy" })).toThrow(/channel/);
    expect(() => cleanWatch({ ntfyTopic: "short" })).toThrow(/16 to 64/);
    expect(() => cleanWatch({ ntfyServer: "http://plain.example" })).toThrow(/https/);
    expect(() => cleanWatch({ phone: "sms" })).toThrow();
    expect(() => cleanWatch({ stuckMinutes: 0 })).toThrow();
  });
});

describe("the watchdog as a program of its own", () => {
  it("ignores an old sign of life, then speaks, ends the room and goes home when SoftwareFactory dies mid-run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-watch-"));
    const r = new TheRecord();
    writeAlive(dir, { pid: 9, at: new Date(Date.now() - 3_600_000).toISOString(), closed: true, running: null });
    let ended = 0;
    const settings = () => ({ ...WATCH_DEFAULTS, goneSeconds: 15 });
    let clock = Date.now();
    const done = runWatchdog({ record: r, workDir: dir, settings, endRoom: async () => { ended++; }, now: () => new Date(clock) }, 10);
    await new Promise((ok) => setTimeout(ok, 40));
    expect(r.all()).toHaveLength(0);
    const alive: Alive = { pid: 10, at: new Date(clock).toISOString(), running: { ticket: "T4", startedAt: new Date(clock).toISOString(), lastLineAt: new Date(clock).toISOString() } };
    writeAlive(dir, alive);
    expect(readAlive(dir)).toMatchObject({ pid: 10 });
    await new Promise((ok) => setTimeout(ok, 40));
    expect(r.all()).toHaveLength(0);
    clock += 60_000; // SoftwareFactory was killed: no new sign of life for a minute
    await done;
    expect(ended).toBe(1);
    expect(r.all()).toHaveLength(1);
    expect(r.all()[0]).toMatchObject({ kind: "watchdog.spoke", ticket: "T4", data: { why: "gone" } });
  });
});
