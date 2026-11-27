import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanSettings, createHome, settingsFileIn, ticketsFrom, type HomeDeps } from "../src/fence/home.js";
import { homePage } from "../src/fence/homepage.js";
import { TheRecord } from "../src/fence/record.js";

const SHA = "a".repeat(40);
function proposed(r: TheRecord, ticket = "T1", over: Record<string, unknown> = {}) {
  r.append({ kind: "ticket.opened", who: "you", ticket, project: "o/p", data: { sentence: "Add a footer." } });
  r.append({ kind: "fence.tested", who: "SF itself", ticket, project: "o/p", data: { ok: true } });
  r.append({ kind: "run.started", who: "SF itself", run: `${ticket}-x`, ticket, project: "o/p", data: { model: "sonnet" } });
  r.append({ kind: "run.step", who: "worker", run: `${ticket}-x`, ticket, project: "o/p", costUsd: 0.18, data: { finished: true } });
  r.append({ kind: "run.ended", who: "SF itself", run: `${ticket}-x`, ticket, project: "o/p", data: { end: "passed", reason: "the work is done and its checks passed" } });
  r.append({ kind: "result.proposed", who: "SF itself", run: `${ticket}-x`, ticket, project: "o/p", data: { url: "https://github.com/o/p/pull/7", number: 7, branch: "sf/t1-x", base: "main", headSha: SHA, ...over } });
}

function fakeGitHub(pr: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const gh = {
    hasToken: () => true,
    prDetail: async () => ({ number: 7, url: "", state: "open", merged: false, draft: true, mergeSha: null, title: "T1: Add a footer.", headSha: SHA, base: "main", nodeId: "N1", ...pr }),
    markReady: async (id: string) => { calls.push(`ready ${id}`); },
    mergePr: async (_r: unknown, n: number, sha: string) => { calls.push(`merge ${n} ${sha}`); return { sha: "b".repeat(40) }; },
  };
  return { gh: gh as unknown as HomeDeps["github"], calls };
}

function home(record: TheRecord, over: Partial<HomeDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sf-home-"));
  return createHome({ record, github: fakeGitHub().gh, settings: settingsFileIn(dir, { repo: "o/p" }), hosts: ["127.0.0.1:1"], key: "k".repeat(48), work: async () => { throw new Error("not used"); }, ...over });
}

describe("the home screen's settings", () => {
  it("keeps what is right and says in a sentence what is wrong", () => {
    expect(cleanSettings({ repo: " o/p ", checks: [" npm test ", ""], maxTurns: 10 })).toMatchObject({ repo: "o/p", checks: ["npm test"], maxTurns: 10, model: "sonnet" });
    expect(() => cleanSettings({ repo: "not a repo" })).toThrow(/owner\/name/);
    expect(() => cleanSettings({ maxTurns: 0 })).toThrow(/Turns/);
    expect(() => cleanSettings({ timeLimitMinutes: 9999 })).toThrow(/time limit/);
    expect(() => cleanSettings({ model: "x; rm" })).toThrow(/model/);
    expect(() => cleanSettings({ base: "a..b" })).toThrow(/branch/);
    expect(() => cleanSettings({ checks: ["a\nb"] })).toThrow(/one line/);
  });

  it("saves a change to its file and writes it in the record; no change, no line", () => {
    const r = new TheRecord();
    const h = home(r);
    expect(h.saveSettings({ model: "opus", checks: ["npm test"] })).toMatchObject({ ok: true, settings: { model: "opus", repo: "o/p" } });
    expect(h.state().settings).toMatchObject({ model: "opus", checks: ["npm test"] });
    expect(r.all().at(-1)).toMatchObject({ kind: "setting.changed", who: "you", data: { changed: { model: { from: "sonnet", to: "opus" } } } });
    h.saveSettings({ model: "opus" });
    expect(r.all()).toHaveLength(1);
    expect(h.saveSettings({ maxTurns: -1 })).toMatchObject({ ok: false });
  });
});

describe("tickets, drawn from the record alone", () => {
  it("says where each ticket stands, newest first, with its cost and story", () => {
    const r = new TheRecord();
    proposed(r, "T1");
    r.append({ kind: "ticket.opened", who: "you", ticket: "T2", project: "o/p", data: { sentence: "Second." } });
    r.append({ kind: "run.ended", who: "SF itself", run: "T2-x", ticket: "T2", project: "o/p", data: { end: "failed its checks", reason: "a check failed: npm test" } });
    r.append({ kind: "ticket.opened", who: "you", ticket: "T3", project: "o/p", data: { sentence: "Third." } });
    r.append({ kind: "ticket.opened", who: "you", ticket: "T4", project: "o/p", data: { sentence: "Fourth." } });
    const t = Object.fromEntries(ticketsFrom(r.all(), "T4").map((x) => [x.ticket, x]));
    expect(t.T1).toMatchObject({ state: "proposed", canAccept: true, number: 7, costUsd: 0.18, url: "https://github.com/o/p/pull/7" });
    expect(t.T1!.story.map((s) => s.what).join("\n")).toMatch(/you asked: Add a footer\.[\s\S]*proposed on GitHub/);
    expect(t.T2).toMatchObject({ state: "failed its checks", says: "a check failed: npm test", canAccept: false });
    expect(t.T3).toMatchObject({ state: "interrupted" });
    expect(t.T4).toMatchObject({ state: "working" });
  });

  it("a held result cannot be accepted, an accepted one says so", () => {
    const r = new TheRecord();
    proposed(r, "T1", { held: true, reason: "a secret was found", url: undefined, number: undefined });
    expect(ticketsFrom(r.all(), null)[0]).toMatchObject({ state: "held", canAccept: false });
    const r2 = new TheRecord();
    proposed(r2, "T1");
    r2.append({ kind: "result.accepted", who: "you", ticket: "T1", project: "o/p", data: {} });
    expect(ticketsFrom(r2.all(), null)[0]).toMatchObject({ state: "accepted", canAccept: false });
  });
});

describe("accept", () => {
  it("puts exactly the checked commit into the project and writes it in the record", async () => {
    const r = new TheRecord();
    proposed(r);
    const g = fakeGitHub();
    const h = home(r, { github: g.gh });
    expect(await h.accept("T1")).toMatchObject({ ok: true });
    expect(g.calls).toEqual(["ready N1", `merge 7 ${SHA}`]);
    expect(r.all().at(-1)).toMatchObject({ kind: "result.accepted", who: "you", ticket: "T1", run: "T1-x", data: { number: 7 } });
    expect(await h.accept("T1")).toMatchObject({ ok: false, why: expect.stringMatching(/already/) });
  });

  it("refuses when the proposal changed on GitHub after it was checked, was closed, or was never made", async () => {
    const r = new TheRecord();
    proposed(r);
    const moved = fakeGitHub({ headSha: "c".repeat(40) });
    expect(await home(r, { github: moved.gh }).accept("T1")).toMatchObject({ ok: false, why: expect.stringMatching(/changed on GitHub/) });
    expect(moved.calls).toEqual([]);
    expect(await home(r, { github: fakeGitHub({ state: "closed" }).gh }).accept("T1")).toMatchObject({ ok: false, why: expect.stringMatching(/closed/) });
    expect(await home(r, { github: fakeGitHub({ base: "other" }).gh }).accept("T1")).toMatchObject({ ok: false });
    expect(await home(r).accept("T9")).toMatchObject({ ok: false });
    expect(r.all().filter((l) => l.kind === "result.accepted")).toHaveLength(0);
  });
});

describe("the page and its door", () => {
  let server: Server | null = null;
  afterEach(() => { server?.close(); server = null; });
  async function serve(record: TheRecord, over: Partial<HomeDeps> = {}) {
    let h!: ReturnType<typeof createHome>;
    server = createServer((req, res) => { void h.handler(req, res); });
    await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok));
    const port = (server.address() as AddressInfo).port;
    h = home(record, { hosts: [`127.0.0.1:${port}`], ...over });
    return { h, url: `http://127.0.0.1:${port}`, port };
  }
  const json = (key: string) => ({ "content-type": "application/json", "x-sf-key": key });

  it("serves one page that fetches nothing from elsewhere, and state as data", async () => {
    const r = new TheRecord();
    proposed(r);
    const { url } = await serve(r);
    const page = await fetch(`${url}/`);
    expect(page.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
    const html = await page.text();
    expect(html).toContain("What should be done?");
    expect(html).not.toMatch(/src="http|href="http|@import|url\(/);
    expect(html).not.toContain("__SF_KEY__");
    const s = await (await fetch(`${url}/api/step1/state`)).json() as any;
    expect(s.tickets[0]).toMatchObject({ ticket: "T1", state: "proposed" });
    expect(JSON.stringify(s)).not.toContain("k".repeat(48));
  });

  it("answers only to its own name, and changes nothing without the page's key", async () => {
    const r = new TheRecord();
    const { url, port, h } = await serve(r);
    const { request } = await import("node:http");
    const foreign = await new Promise<number>((ok) => { request({ host: "127.0.0.1", port, path: "/api/step1/state", headers: { host: "evil.example" } }, (res) => { res.resume(); ok(res.statusCode ?? 0); }).end(); });
    expect(foreign).toBe(403);
    expect((await fetch(`${url}/api/step1/work`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await fetch(`${url}/api/step1/work`, { method: "POST", headers: { "content-type": "text/plain", "x-sf-key": h.key }, body: "{}" })).status).toBe(403);
    expect((await fetch(`${url}/api/step1/settings`, { method: "POST", headers: json("wrong"), body: "{}" })).status).toBe(403);
    expect(r.all()).toHaveLength(0);
  });

  it("starts one run at a time, shows it working, and stop reaches the run", async () => {
    const r = new TheRecord();
    let stopped = false, release!: () => void;
    const work: HomeDeps["work"] = async (st, sentence, signal) => {
      r.append({ kind: "ticket.opened", who: "you", ticket: "T1", project: `${st.repo.owner}/${st.repo.name}`, data: { sentence } });
      await new Promise<void>((ok) => { release = ok; signal.addEventListener("abort", () => { stopped = true; ok(); }); });
      r.append({ kind: "run.ended", who: "SF itself", run: "T1-x", ticket: "T1", project: "o/p", data: { end: stopped ? "stopped" : "passed", reason: stopped ? "you pressed stop" : "ok" } });
      return { ticket: "T1", run: "T1-x", end: stopped ? "stopped" : "passed", reason: "", url: null, branch: null, costUsd: 0 };
    };
    const { url, h } = await serve(r, { work });
    expect((await fetch(`${url}/api/step1/work`, { method: "POST", headers: json(h.key), body: JSON.stringify({ sentence: "  " }) })).status).toBe(409);
    expect((await fetch(`${url}/api/step1/work`, { method: "POST", headers: json(h.key), body: JSON.stringify({ sentence: "Add a footer." }) })).status).toBe(200);
    expect((await fetch(`${url}/api/step1/work`, { method: "POST", headers: json(h.key), body: JSON.stringify({ sentence: "Another." }) })).status).toBe(409);
    const s = await (await fetch(`${url}/api/step1/state`)).json() as any;
    expect(s.running).toMatchObject({ ticket: "T1" });
    expect(s.tickets[0]).toMatchObject({ ticket: "T1", state: "working", sentence: "Add a footer." });
    expect((await fetch(`${url}/api/step1/stop`, { method: "POST", headers: json(h.key), body: "{}" })).status).toBe(200);
    await new Promise((ok) => setTimeout(ok, 20));
    expect(stopped).toBe(true);
    expect(h.isRunning()).toBe(false);
    expect(r.all().map((l) => l.kind)).toEqual(["ticket.opened", "stop.pressed", "run.ended"]);
    expect(r.all()[1]).toMatchObject({ who: "you", ticket: "T1" });
    void release;
  });

  it("refuses a key that is not plain", () => {
    expect(() => homePage("</script>")).toThrow();
  });
});
