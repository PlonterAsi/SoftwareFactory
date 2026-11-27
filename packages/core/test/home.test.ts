import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanSettings, createHome, restOf, settingsFileIn, ticketsFrom, type HomeDeps } from "../src/fence/home.js";
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
    ci: async () => ({ state: "red", failed: ["web"], total: 3 }),
    mergePr: async (_r: unknown, n: number, sha: string) => { calls.push(`merge ${n} ${sha}`); return { sha: "b".repeat(40) }; },
  };
  return { gh: gh as unknown as HomeDeps["github"], calls };
}

function home(record: TheRecord, over: Partial<HomeDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sf-home-"));
  return createHome({ record, github: fakeGitHub().gh, settings: settingsFileIn(dir, { repo: "o/p", ladder: false }), hosts: ["127.0.0.1:1"], key: "k".repeat(48), work: async () => { throw new Error("not used"); }, ...over });
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

  it("keeps only what differs from the defaults in its file", () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-home-"));
    const f = settingsFileIn(dir, { repo: "o/p" });
    f.write({ ...f.read(), hold: true });
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({ hold: true });
    expect(f.read()).toMatchObject({ repo: "o/p", hold: true, slots: 1 });
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
    r.append({ kind: "ticket.opened", who: "you", ticket: "T3", project: "o/p", data: { sentence: "Third.", kind: "request" } });
    r.append({ kind: "ticket.opened", who: "you", ticket: "T4", project: "o/p", data: { sentence: "Fourth." } });
    const t = Object.fromEntries(ticketsFrom(r.all(), "T4").map((x) => [x.ticket, x]));
    expect(t.T1).toMatchObject({ state: "proposed", canAccept: true, number: 7, costUsd: 0.18, url: "https://github.com/o/p/pull/7" });
    expect(t.T1!.story.map((s) => s.what).join("\n")).toMatch(/you asked: Add a footer\.[\s\S]*proposed on GitHub/);
    expect(t.T2).toMatchObject({ state: "failed its checks", says: "a check failed: npm test", canAccept: false });
    expect(t.T3).toMatchObject({ state: "waiting", place: 1, canEdit: true });
    r.append({ kind: "stop.pressed", who: "you", ticket: "T3", data: {} });
    expect(ticketsFrom(r.all(), null).find((x) => x.ticket === "T3")).toMatchObject({ state: "stopped" });
    expect(t.T4).toMatchObject({ state: "working" });
    // A ticket from before there was a queue names no kind: it is never started by itself, until it is sent again.
    r.append({ kind: "ticket.opened", who: "you", ticket: "T5", project: "o/p", data: { sentence: "Old." } });
    expect(ticketsFrom(r.all(), null).find((x) => x.ticket === "T5")).toMatchObject({ state: "interrupted", canAgain: true });
    r.append({ kind: "ticket.queued", who: "you", ticket: "T5", project: "o/p", data: {} });
    expect(ticketsFrom(r.all(), null).find((x) => x.ticket === "T5")).toMatchObject({ state: "waiting" });
  });

  it("does not climb the ladder after a stop the owner pressed, however the run wrote its end", () => {
    const r = new TheRecord();
    r.append({ kind: "ticket.opened", who: "you", ticket: "T1", project: "o/p", data: { sentence: "X.", kind: "request" } });
    r.append({ kind: "run.started", who: "SF itself", run: "T1-a", ticket: "T1", project: "o/p", data: {} });
    r.append({ kind: "run.ended", who: "SF itself", run: "T1-a", ticket: "T1", project: "o/p", data: { end: "failed its checks", reason: "a check failed" } });
    expect(ticketsFrom(r.all(), null)[0]).toMatchObject({ climbable: true });
    const r2 = new TheRecord();
    r2.append({ kind: "ticket.opened", who: "you", ticket: "T1", project: "o/p", data: { sentence: "X.", kind: "request" } });
    r2.append({ kind: "run.started", who: "SF itself", run: "T1-a", ticket: "T1", project: "o/p", data: {} });
    r2.append({ kind: "stop.pressed", who: "you", ticket: "T1", project: "o/p", data: {} });
    r2.append({ kind: "run.ended", who: "SF itself", run: "T1-a", ticket: "T1", project: "o/p", data: { end: "failed its checks", reason: "a check failed" } });
    expect(ticketsFrom(r2.all(), null)[0]).toMatchObject({ climbable: false });
  });

  it("a held result cannot be accepted, an accepted one says so", () => {
    const r = new TheRecord();
    proposed(r, "T1", { held: true, reason: "a secret was found", url: undefined, number: undefined });
    expect(ticketsFrom(r.all(), null)[0]).toMatchObject({ state: "held", canAccept: false });
    expect(ticketsFrom(r.all(), null)[0]).toMatchObject({ canRelease: false, stops: [] });
    // The stop list holds too, and that one the owner can let go; once let go it is an ordinary proposal.
    const r3 = new TheRecord();
    proposed(r3, "T1", { held: true, reason: "it waits for your look", stop: [{ family: "new package", file: "package.json", why: "a new package: left-pad" }], url: undefined, number: undefined });
    expect(ticketsFrom(r3.all(), null)[0]).toMatchObject({ state: "held", canAccept: false, canRelease: true, stops: [{ family: "new package", file: "package.json" }] });
    r3.append({ kind: "result.proposed", who: "you", ticket: "T1", project: "o/p", data: { url: "https://github.com/o/p/pull/9", number: 9, released: true } });
    expect(ticketsFrom(r3.all(), null)[0]).toMatchObject({ state: "proposed", canAccept: true, canRelease: false, stops: [] });
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
    expect(r.all().at(-1)).toMatchObject({ kind: "result.accepted", who: "you", ticket: "T1", run: "T1-x", data: { number: 7, githubChecks: "red" } });
    expect(await h.look("T1")).toMatchObject({ ok: true, githubChecks: expect.stringMatching(/FAILED \(web\)/) });
    expect(await h.accept("T1")).toMatchObject({ ok: false, why: expect.stringMatching(/already/) });
  });

  it("does not accept an older proposal of a ticket that was sent to be worked again", async () => {
    const r = new TheRecord();
    proposed(r);
    r.append({ kind: "ticket.queued", who: "you", ticket: "T1", project: "o/p", data: {} });
    const g = fakeGitHub();
    const h = home(r, { github: g.gh });
    expect(await h.accept("T1")).toMatchObject({ ok: false });
    expect(await h.look("T1")).toMatchObject({ ok: false });
    expect(g.calls).toEqual([]);
  });

  it("refuses when the proposal changed on GitHub after it was checked, was closed, or was never made", async () => {
    const r = new TheRecord();
    proposed(r);
    const moved = fakeGitHub({ headSha: "c".repeat(40) });
    expect(await home(r, { github: moved.gh }).accept("T1")).toMatchObject({ ok: false, why: expect.stringMatching(/changed on GitHub/) });
    expect(moved.calls).toEqual([]);
    expect(await home(r, { github: fakeGitHub({ state: "closed" }).gh }).accept("T1")).toMatchObject({ ok: false, why: expect.stringMatching(/closed/) });
    expect(await home(r, { github: fakeGitHub({ base: "other" }).gh }).accept("T1")).toMatchObject({ ok: false });
    expect(await home(r, { github: fakeGitHub({ mergeable: false }).gh }).accept("T1")).toMatchObject({ ok: false, why: expect.stringMatching(/moved on/) });
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
    cookie = `${h.cookieName}=${h.cookie}`;
    return { h, url: `http://127.0.0.1:${port}`, port };
  }
  let cookie = "";
  const json = (key: string) => ({ "content-type": "application/json", "x-sf-key": key, cookie });
  const get = (u: string) => fetch(u, { headers: { cookie } });

  it("lets nobody in without the pass from SoftwareFactory's own window", async () => {
    const r = new TheRecord();
    proposed(r);
    const { url, h } = await serve(r);
    for (const path of ["/", "/api/step1/state", "/api/step1/events"]) expect((await fetch(`${url}${path}`)).status).toBe(403);
    expect((await fetch(`${url}/?pass=wrong`, { redirect: "manual" })).status).toBe(403);
    const inn = await fetch(`${url}/?pass=${h.pass}`, { redirect: "manual" });
    expect(inn.status).toBe(303);
    expect(inn.headers.get("set-cookie")).toMatch(/^sf[a-f0-9]{8}=[a-f0-9]+; HttpOnly; SameSite=Strict/);
    expect((await fetch(`${url}/?pass=${h.pass}`, { redirect: "manual" })).status).toBe(403);
    expect((await fetch(`${url}/api/step1/work`, { method: "POST", headers: { "content-type": "application/json", "x-sf-key": h.key }, body: "{}" })).status).toBe(403);
  });

  it("serves one page that fetches nothing from elsewhere, and state as data", async () => {
    const r = new TheRecord();
    proposed(r);
    const { url } = await serve(r);
    const page = await get(`${url}/`);
    expect(page.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
    const html = await page.text();
    expect(html).toContain("What should be done?");
    expect(html).not.toMatch(/src="http|href="http|@import|url\(/);
    expect(html).not.toContain("__SF_KEY__");
    const s = await (await get(`${url}/api/step1/state`)).json() as any;
    expect(s.tickets[0]).toMatchObject({ ticket: "T1", state: "proposed" });
    expect(JSON.stringify(s)).not.toContain("k".repeat(48));
  });

  it("answers only to its own name, and changes nothing without the page's key", async () => {
    const r = new TheRecord();
    const { url, port, h } = await serve(r);
    const { request } = await import("node:http");
    const foreign = await new Promise<number>((ok) => { request({ host: "127.0.0.1", port, path: "/api/step1/state", headers: { host: "evil.example", cookie } }, (res) => { res.resume(); ok(res.statusCode ?? 0); }).end(); });
    expect(foreign).toBe(403);
    expect((await fetch(`${url}/api/step1/work`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: "{}" })).status).toBe(403);
    expect((await fetch(`${url}/api/step1/work`, { method: "POST", headers: { "content-type": "text/plain", "x-sf-key": h.key, cookie }, body: "{}" })).status).toBe(403);
    expect((await fetch(`${url}/api/step1/settings`, { method: "POST", headers: json("wrong"), body: "{}" })).status).toBe(403);
    expect(r.all()).toHaveLength(0);
  });

  it("is a queue: tickets wait their turn, one is worked at a time, and stop reaches only the run", async () => {
    const r = new TheRecord();
    const seen: string[] = [];
    let stopped = false, release!: () => void;
    const work: HomeDeps["work"] = async (_st, ticket, sentence, signal) => {
      seen.push(`${ticket}: ${sentence}`);
      stopped = false;
      r.append({ kind: "run.started", who: "SF itself", run: `${ticket}-x`, ticket, project: "o/p", data: { model: "sonnet" } });
      await new Promise<void>((ok) => { release = ok; signal.addEventListener("abort", () => { stopped = true; ok(); }); });
      r.append({ kind: "run.ended", who: "SF itself", run: `${ticket}-x`, ticket, project: "o/p", data: { end: stopped ? "stopped" : "failed its checks", reason: stopped ? "you pressed stop" : "a check failed" } });
      return { ticket, run: `${ticket}-x`, end: "stopped", reason: "", url: null, branch: null, costUsd: 0 };
    };
    const { url, h } = await serve(r, { work });
    const post = (path: string, body: unknown) => fetch(`${url}/api/step1/${path}`, { method: "POST", headers: json(h.key), body: JSON.stringify(body) });
    const tick = () => new Promise((ok) => setTimeout(ok, 20));
    const of = async (ticket: string) => ((await (await get(`${url}/api/step1/state`)).json()) as any).tickets.find((t: any) => t.ticket === ticket);
    expect((await post("work", { sentence: "  " })).status).toBe(409);
    expect((await post("work", { sentence: "x", kind: "poem" })).status).toBe(409);
    expect(await (await post("work", { sentence: "Add a footer." })).json()).toEqual({ ok: true, ticket: "T1" });
    expect((await post("work", { sentence: "Another.", kind: "bug" })).status).toBe(200);
    expect((await post("work", { sentence: "A third." })).status).toBe(200);
    expect(await of("T1")).toMatchObject({ state: "working", sentence: "Add a footer.", kind: "request", canEdit: false, canRemove: false });
    expect(await of("T2")).toMatchObject({ state: "waiting", place: 1, kind: "bug" });
    expect(await of("T3")).toMatchObject({ state: "waiting", place: 2 });
    // A waiting ticket can be changed and taken off the list; a working one cannot.
    expect((await post("ticket/edit", { ticket: "T1", sentence: "No." })).status).toBe(409);
    expect((await post("ticket/remove", { ticket: "T1" })).status).toBe(409);
    expect((await post("ticket/edit", { ticket: "T3", sentence: "A third, better.", kind: "task" })).status).toBe(200);
    expect((await post("ticket/remove", { ticket: "T2" })).status).toBe(200);
    expect(await of("T2")).toMatchObject({ removed: true, place: null });
    expect(await of("T3")).toMatchObject({ sentence: "A third, better.", kind: "task", place: 1 });
    // Stop ends the run, and the next one that waits takes its turn with its changed words.
    expect((await post("stop", {})).status).toBe(200);
    await tick();
    expect(seen).toEqual(["T1: Add a footer.", "T3: A third, better."]);
    expect(await of("T1")).toMatchObject({ state: "stopped", canAgain: true });
    expect(r.story("T1").map((l) => l.kind)).toEqual(["ticket.opened", "run.started", "stop.pressed", "run.ended"]);
    // Sent again, it waits behind nothing and runs after the third.
    expect((await post("ticket/again", { ticket: "T1" })).status).toBe(200);
    expect(await of("T1")).toMatchObject({ state: "waiting", place: 1 });
    release(); await tick();
    expect(seen.at(-1)).toBe("T1: Add a footer.");
    expect(await of("T3")).toMatchObject({ state: "failed its checks" });
    // Put back on the list while the queue is held: it waits until the hold is let go.
    expect((await post("settings", { hold: true })).status).toBe(200);
    expect((await post("ticket/restore", { ticket: "T2" })).status).toBe(200);
    release(); await tick();
    expect(h.isRunning()).toBe(false);
    expect(await of("T2")).toMatchObject({ state: "waiting", removed: false });
    expect((await post("settings", { hold: false })).status).toBe(200);
    await tick();
    expect(seen.at(-1)).toBe("T2: Another.");
    release(); await tick();
    expect((await post("ticket/edit", { ticket: "T9", sentence: "x" })).status).toBe(409);
  });

  it("starts nothing of a kind whose limit is used up, says until when, and hands each run its own ceiling", async () => {
    const r = new TheRecord();
    r.append({ kind: "ticket.opened", who: "you", ticket: "T1", project: "o/p", data: { sentence: "Old.", kind: "request" } });
    r.append({ kind: "run.step", who: "worker", ticket: "T1", project: "o/p", costUsd: 3, data: { finished: true } });
    r.append({ kind: "run.ended", who: "SF itself", ticket: "T1", project: "o/p", data: { end: "failed its checks", reason: "x" } });
    const seen: { ticket: string; budget: number | undefined }[] = [];
    const { url, h } = await serve(r, { work: async (st, ticket) => { seen.push({ ticket, budget: st.budgetUsd }); r.append({ kind: "run.ended", who: "SF itself", ticket, project: "o/p", data: { end: "parked", reason: "x" } }); return {} as any; } });
    const post = (path: string, body: unknown) => fetch(`${url}/api/step1/${path}`, { method: "POST", headers: json(h.key), body: JSON.stringify(body) });
    expect((await post("settings", { gate: false, limitYou: 2, limitAlone: 4, runLimit: 5 })).status).toBe(200);
    await post("work", { sentence: "New." });
    await new Promise((ok) => setTimeout(ok, 20));
    expect(seen).toEqual([]);
    const st = h.state();
    expect(st.tickets.find((t) => t.ticket === "T2")).toMatchObject({ state: "waiting", bucket: "you" });
    expect(st.tickets.find((t) => t.ticket === "T2")!.limitUntil).toBe(st.limits.until);
    expect(st.limits).toMatchObject({ used: { you: 3, alone: 0 }, room: { you: 0, alone: 4 } });
    // What SoftwareFactory brings back by itself counts under limit 2, which has room: it goes on.
    r.append({ kind: "ticket.queued", who: "SF itself", ticket: "T1", project: "o/p", data: { returned: true } });
    h.pump();
    await new Promise((ok) => setTimeout(ok, 20));
    expect(seen).toEqual([{ ticket: "T1", budget: 4 }]);
    expect((await post("settings", { limitYou: 10 })).status).toBe(200);
    await new Promise((ok) => setTimeout(ok, 20));
    expect(seen[1]).toEqual({ ticket: "T2", budget: 5 });
    expect((await post("settings", { limitYou: -3 })).status).toBe(400);
    h.close();
  });

  it("says what happened since the owner last looked, in three groups, and Got it starts the count anew", async () => {
    const r = new TheRecord();
    proposed(r, "T1");
    proposed(r, "T2", { held: true, reason: "it waits for your look", stop: [{ family: "security", file: ".env.example", why: "x" }], url: undefined, number: undefined });
    r.append({ kind: "ticket.opened", who: "you", ticket: "T3", project: "o/p", data: { sentence: "Fix it.", kind: "request" } });
    r.append({ kind: "run.ended", who: "SF itself", ticket: "T3", project: "o/p", data: { end: "failed its checks", reason: "a check failed: npm run build" } });
    r.append({ kind: "ticket.opened", who: "you", ticket: "T4", project: "o/q", data: { sentence: "Only waiting.", kind: "request" } });
    const { url, h } = await serve(r, { work: async () => new Promise(() => undefined) });
    const post = (path: string, body: unknown) => fetch(`${url}/api/step1/${path}`, { method: "POST", headers: json(h.key), body: JSON.stringify(body) });
    const a = h.state().since;
    expect(a.seenAt).toBeNull();
    expect(a.items.map((x) => `${x.group} ${x.ticket}`)).toEqual(["yours T2", "ready T1", "unfinished T3"]);
    expect(a.items[2]!.says).toBe("a check failed: npm run build");
    expect(a.costUsd).toBeGreaterThan(0);
    expect((await post("seen", {})).status).toBe(200);
    expect(h.state().since).toMatchObject({ items: [], costUsd: 0, counts: { yours: 0, ready: 0, unfinished: 0 } });
    expect(h.state().since.seenAt).not.toBeNull();
    expect(h.state().tickets.filter((t) => !t.removed)).toHaveLength(4);
    // News after that: only what SoftwareFactory did, not what the owner did.
    r.append({ kind: "ticket.queued", who: "you", ticket: "T3", project: "o/p", data: {} });
    expect(h.state().since.items).toEqual([]);
    const n = r.all().filter((l) => l.kind === "home.seen").length;
    await post("seen", {});
    expect(r.all().filter((l) => l.kind === "home.seen")).toHaveLength(n);
    // News that came while the press was on its way is not waved off: Got it names the last line the page had read.
    const read = h.state().since.upTo;
    proposed(r, "T5");
    r.append({ kind: "run.ended", who: "SF itself", ticket: "T5", project: "o/p", data: { end: "crashed", reason: "x" } });
    r.append({ kind: "issue.linked", who: "SF itself", ticket: "T1", project: "o/p", data: { number: 3 } });
    await post("seen", { upTo: read });
    expect(h.state().since.items.map((x) => x.ticket)).toEqual(["T5"]);
    // Each group is cut by itself, and says how many it holds.
    for (let i = 6; i < 20; i++) proposed(r, `T${i}`);
    r.append({ kind: "ticket.opened", who: "you", ticket: "T30", project: "o/p", data: { sentence: "Fails.", kind: "request" } });
    r.append({ kind: "run.ended", who: "SF itself", ticket: "T30", project: "o/p", data: { end: "crashed", reason: "boom" } });
    const big = h.state().since;
    expect(big.counts).toMatchObject({ ready: 15, unfinished: 1 });
    expect(big.items.filter((x) => x.group === "ready")).toHaveLength(10);
    expect(big.items.some((x) => x.ticket === "T30")).toBe(true);
    h.close();
  });

  it("climbs the stuck ladder by itself: once more, another way, split, a few shared tries, then waits for the owner", async () => {
    const r = new TheRecord();
    const seen: { ticket: string; model: string; hint: string }[] = [];
    let n = 0;
    const { url, h } = await serve(r, {
      settings: settingsFileIn(mkdtempSync(join(tmpdir(), "sf-home-")), { repo: "o/p", gate: false, ladderModel: "opus", ladderSplitMinChars: 0 }),
      work: async (st, ticket) => {
        const run = `${ticket}-${++n}`;
        seen.push({ ticket, model: st.model, hint: st.hint ?? "" });
        r.append({ kind: "run.started", who: "SF itself", run, ticket, project: "o/p", data: {} });
        r.append({ kind: "run.checked", who: "SF itself", run, ticket, project: "o/p", data: { command: "npm run build", ok: false, tail: "TS2304 boom" } });
        r.append({ kind: "run.ended", who: "SF itself", run, ticket, project: "o/p", data: { end: "failed its checks", reason: "a check failed: npm run build" } });
        return {} as any;
      },
      split: async (q) => { expect(q.failed).toContain("TS2304 boom"); return { ok: true, parts: ["First half.", "Second half."], costUsd: 0.02 }; },
    });
    const post = (path: string, body: unknown) => fetch(`${url}/api/step1/${path}`, { method: "POST", headers: json(h.key), body: JSON.stringify(body) });
    await post("work", { sentence: "A big thing." });
    for (let i = 0; i < 40; i++) await new Promise((ok) => setTimeout(ok, 10));
    expect(seen.map((x) => x.ticket)).toEqual(["T1", "T1", "T1", "T2", "T3", "T2", "T3"]);
    expect(seen[0]).toMatchObject({ model: "sonnet", hint: "" });
    expect(seen[1]!.hint).toMatch(/did not finish[\s\S]*TS2304 boom/);
    expect(seen[2]).toMatchObject({ model: "opus" });
    expect(seen[2]!.hint).toMatch(/a different way/);
    const st = h.state();
    const of = (t: string) => st.tickets.find((x) => x.ticket === t)!;
    expect(of("T1")).toMatchObject({ state: "split", splitInto: ["T2", "T3"], canAgain: false, wasSplit: true });
    expect(of("T2")).toMatchObject({ state: "failed its checks", parent: "T1", bucket: "alone", sentence: "First half.", ladderUsed: 1 });
    expect(r.all().filter((l) => l.kind === "ticket.split")).toHaveLength(1);
    expect(r.all().filter((l) => l.kind === "ticket.queued").map((l) => (l.data as any).ladder)).toEqual(["once more", "another way", "once more", "once more"]);
    // Everything SoftwareFactory did here by itself counts under limit 2; only the first run was the owner's.
    expect(st.since.counts.unfinished).toBe(3);
    expect(st.since.cameBack).toBe(3);
    h.close();
  });

  it("lets a held result go only by the owner's own press, and only a stop-list hold", async () => {
    const r = new TheRecord();
    proposed(r, "T1", { held: true, reason: "a secret was found", url: undefined, number: undefined });
    proposed(r, "T2", { held: true, reason: "it waits for your look", stop: [{ family: "security", file: ".env.example", why: "a file that usually holds keys and passwords" }], url: undefined, number: undefined });
    const asked: string[] = [];
    const { url, h } = await serve(r, { release: async (ticket) => { asked.push(ticket); r.append({ kind: "result.proposed", who: "you", ticket, project: "o/p", data: { url: "https://github.com/o/p/pull/9", number: 9, released: true } }); return { ok: true, url: "https://github.com/o/p/pull/9", number: 9 }; } });
    const post = (path: string, body: unknown, key = h.key) => fetch(`${url}/api/step1/${path}`, { method: "POST", headers: json(key), body: JSON.stringify(body) });
    expect((await post("release", { ticket: "T2" }, "x".repeat(48))).status).not.toBe(200);
    expect((await post("release", { ticket: "T1" })).status).toBe(409);
    expect(asked).toEqual([]);
    expect((await post("release", { ticket: "T2" })).status).toBe(200);
    expect((await post("release", { ticket: "T2" })).status).toBe(409);
    expect(asked).toEqual(["T2"]);
    h.close();
  });

  it("starts nothing new once it is closing, and leaves another project's ticket waiting", async () => {
    const r = new TheRecord();
    const seen: string[] = [];
    const { url, h } = await serve(r, { work: async (_s, ticket, _t, signal) => { seen.push(ticket); r.append({ kind: "run.started", who: "SF itself", ticket, project: "o/p", data: {} }); await new Promise<void>((ok) => signal.addEventListener("abort", () => ok())); r.append({ kind: "run.ended", who: "SF itself", ticket, project: "o/p", data: { end: "stopped", reason: "you pressed stop" } }); return {} as any; } });
    const post = (path: string, body: unknown) => fetch(`${url}/api/step1/${path}`, { method: "POST", headers: json(h.key), body: JSON.stringify(body) });
    await post("work", { sentence: "One." }); await post("work", { sentence: "Two." });
    h.close(); h.stop();
    await new Promise((ok) => setTimeout(ok, 20));
    expect(seen).toEqual(["T1"]);
    expect(ticketsFrom(r.all(), null).find((t) => t.ticket === "T2")).toMatchObject({ state: "waiting" });
    // A fresh start on the same record, with Settings on another project: T2 stays where it is.
    const other = await serve(r, { settings: settingsFileIn(mkdtempSync(join(tmpdir(), "sf-home-")), { repo: "o/other", ladder: false }), work: async (_s, ticket) => { seen.push(`other ${ticket}`); return {} as any; } });
    other.h.pump();
    await new Promise((ok) => setTimeout(ok, 20));
    expect(seen).toEqual(["T1"]);
  });

  it("passes the ready gate before a run: the test of done is written first, and an unclear sentence is asked about once", async () => {
    const r = new TheRecord();
    const worked: { ticket: string; done?: string[] }[] = [];
    const asked: unknown[] = [];
    const gate: HomeDeps["gate"] = async (q) => {
      asked.push(q.asked);
      if (/better/.test(q.sentence) && !q.asked) return { ok: true, answer: { clear: false, kind: "request", done: [], guesses: [], question: "Which page should be better?", costUsd: 0.001 } };
      if (/broken reader/.test(q.sentence)) return { ok: false, why: "the reader gave no answer (exit 1)" };
      if (/limit day/.test(q.sentence)) return { ok: false, why: "the plan limit was reached" };
      return { ok: true, answer: { clear: true, kind: "bug", done: ["The footer shows the year."], guesses: ["The current year is meant."], question: null, costUsd: 0.001 } };
    };
    const { url, h } = await serve(r, { gate, work: async (st, ticket) => { worked.push({ ticket, done: st.done }); r.append({ kind: "run.ended", who: "SF itself", ticket, project: "o/p", data: { end: "failed its checks", reason: "x" } }); return {} as any; } });
    const post = (path: string, body: unknown) => fetch(`${url}/api/step1/${path}`, { method: "POST", headers: json(h.key), body: JSON.stringify(body) });
    const tick = () => new Promise((ok) => setTimeout(ok, 30));
    const of = async (ticket: string) => ((await (await get(`${url}/api/step1/state`)).json()) as any).tickets.find((t: any) => t.ticket === ticket);
    await post("work", { sentence: "Make it better." });
    await post("work", { sentence: "Show the year in the footer." });
    await tick();
    // The unclear one waits for an answer and holds nobody up; the clear one ran with its test of done.
    expect(await of("T1")).toMatchObject({ state: "asked", question: "Which page should be better?", says: "Which page should be better?" });
    expect(worked).toEqual([{ ticket: "T2", done: ["The footer shows the year."] }]);
    expect(await of("T2")).toMatchObject({ kind: "bug", done: ["The footer shows the year."] });
    expect(r.story("T2").map((l) => l.kind)).toEqual(["ticket.opened", "gate.passed", "run.ended"]);
    expect((await post("ticket/answer", { ticket: "T2", answer: "x" })).status).toBe(409);
    expect((await post("ticket/answer", { ticket: "T1", answer: " " })).status).toBe(409);
    expect((await post("ticket/answer", { ticket: "T1", answer: "The Money page." })).status).toBe(200);
    await tick();
    expect(asked.at(-1)).toEqual({ question: "Which page should be better?", answer: "The Money page." });
    expect(worked.at(-1)).toEqual({ ticket: "T1", done: ["The footer shows the year."] });
    // Sent again, the test of done stays as it was written: the gate is not asked a second time.
    const n = asked.length;
    await post("ticket/again", { ticket: "T1" });
    await tick();
    expect(asked.length).toBe(n);
    expect(worked.at(-1)).toEqual({ ticket: "T1", done: ["The footer shows the year."] });
    // A reader that cannot be asked holds nothing up.
    await post("work", { sentence: "A broken reader day." });
    await tick();
    expect(worked.at(-1)).toEqual({ ticket: "T3", done: [] });
    expect(r.story("T3").find((l) => l.kind === "gate.passed")!.data).toMatchObject({ skipped: expect.stringContaining("no answer") });
    // Switched off in Settings: no gate at all.
    await post("settings", { gate: false });
    await post("work", { sentence: "Make it better again." });
    await tick();
    expect(r.story("T4").map((l) => l.kind)).toEqual(["ticket.opened", "run.ended"]);
    // The plan limit met at the gate is not skipped over: the ticket is parked for it and the queue rests.
    await post("settings", { gate: true });
    await post("work", { sentence: "A limit day." });
    await tick();
    expect(worked.at(-1)!.ticket).toBe("T4");
    expect(await of("T5")).toMatchObject({ state: "parked", parkedFor: "limit" });
    expect(((await (await get(`${url}/api/step1/state`)).json()) as any).resting).toMatchObject({ why: "the plan limit was reached" });
  });

  it("rests after the plan limit, then brings the parked ticket back by itself, a set number of times", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const r = new TheRecord();
      const seen: string[] = [];
      let limit = true;
      const { url, h } = await serve(r, { settings: settingsFileIn(mkdtempSync(join(tmpdir(), "sf-home-")), { repo: "o/p", gate: false, ladder: false, parkedWaitMinutes: 10, parkedReturns: 1 }), work: async (_s, ticket) => {
        seen.push(ticket);
        r.append({ kind: "run.started", who: "SF itself", run: `${ticket}-${seen.length}`, ticket, project: "o/p", data: {} });
        r.append({ kind: "run.ended", who: "SF itself", run: `${ticket}-${seen.length}`, ticket, project: "o/p", data: limit ? { end: "parked", reason: "the plan limit was reached", parkedFor: "limit" } : { end: "crashed", reason: "done for the test" } });
        return {} as any;
      } });
      const post = (path: string, body: unknown) => fetch(`${url}/api/step1/${path}`, { method: "POST", headers: json(h.key), body: JSON.stringify(body) });
      const idle = () => new Promise((ok) => setImmediate(ok)).then(() => new Promise((ok) => setImmediate(ok)));
      await post("work", { sentence: "One." }); await post("work", { sentence: "Two." });
      await idle();
      // T1 met the limit: T2 does not start, the queue rests, and T1 says when it comes back.
      expect(seen).toEqual(["T1"]);
      const s1 = await (await fetch(`${url}/api/step1/state`, { headers: json(h.key) })).json() as any;
      expect(s1.resting).toMatchObject({ why: "the plan limit was reached" });
      expect(s1.tickets.find((t: any) => t.ticket === "T1")).toMatchObject({ state: "parked", parkedFor: "limit", returns: 0 });
      expect(Date.parse(s1.tickets.find((t: any) => t.ticket === "T1").returnsAt)).toBe(Date.parse(s1.resting.until));
      h.pump(); await idle();
      expect(seen).toEqual(["T1"]);
      // The wait is over: T2 waited longest and goes first, then T1 comes back by itself.
      limit = false;
      vi.setSystemTime(Date.now() + 11 * 60_000);
      h.pump(); await idle(); await idle();
      expect(seen).toEqual(["T1", "T2", "T1"]);
      expect(r.story("T1").filter((l) => l.kind === "ticket.queued").map((l) => [l.who, (l.data as any).returned, (l.data as any).time])).toEqual([["SF itself", true, 1]]);
      // It came back once, as Settings allow. Parked again, it waits for you.
      r.append({ kind: "ticket.queued", who: "you", ticket: "T1", project: "o/p", data: {} });
      limit = true; h.pump(); await idle();
      expect(seen).toEqual(["T1", "T2", "T1", "T1"]);
      vi.setSystemTime(Date.now() + 11 * 60_000);
      h.pump(); await idle();
      expect(seen.length).toBe(4);
      const s2 = await (await fetch(`${url}/api/step1/state`, { headers: json(h.key) })).json() as any;
      expect(s2.tickets.find((t: any) => t.ticket === "T1")).toMatchObject({ state: "parked", returns: 1, returnsAt: null });
      expect(s2.resting).toBeNull();
      h.close();
    } finally { vi.useRealTimers(); }
  });

  it("works two tickets at once when Settings give two slots, and stops one without touching the other", async () => {
    const r = new TheRecord();
    const live = new Map<string, boolean | undefined>();
    const { url, h } = await serve(r, { settings: settingsFileIn(mkdtempSync(join(tmpdir(), "sf-home-")), { repo: "o/p", gate: false, ladder: false, slots: 2 }), work: async (st, ticket, _t, signal) => {
      live.set(ticket, st.ownCell);
      r.append({ kind: "run.started", who: "SF itself", run: `${ticket}-a`, ticket, project: "o/p", data: {} });
      await new Promise<void>((ok) => signal.addEventListener("abort", () => ok()));
      r.append({ kind: "run.ended", who: "SF itself", run: `${ticket}-a`, ticket, project: "o/p", data: { end: "stopped", reason: "you pressed stop" } });
      live.delete(ticket);
      return {} as any;
    } });
    const post = (path: string, body: unknown) => fetch(`${url}/api/step1/${path}`, { method: "POST", headers: json(h.key), body: JSON.stringify(body) });
    const tick = () => new Promise((ok) => setTimeout(ok, 30));
    await post("work", { sentence: "One." }); await post("work", { sentence: "Two." }); await post("work", { sentence: "Three." });
    await tick();
    // Two work, each told it has a cell of its own; the third waits.
    expect([...live]).toEqual([["T1", true], ["T2", true]]);
    expect(h.state().runs.map((x) => x.ticket)).toEqual(["T1", "T2"]);
    expect(h.state().tickets.map((t) => [t.ticket, t.state])).toEqual([["T3", "waiting"], ["T2", "working"], ["T1", "working"]]);
    expect((await post("stop", { ticket: "T9" })).status).toBe(409);
    // Stop reaches one run. The other goes on, and the freed slot takes the third.
    expect((await post("stop", { ticket: "T1" })).status).toBe(200);
    await tick();
    expect([...live.keys()]).toEqual(["T2", "T3"]);
    expect(h.state().tickets.find((t) => t.ticket === "T1")).toMatchObject({ state: "stopped" });
    expect(r.all().filter((l) => l.kind === "stop.pressed").map((l) => l.ticket)).toEqual(["T1"]);
    // Stop with no name ends every run.
    h.close();
    expect((await post("stop", {})).status).toBe(200);
    await tick();
    expect(live.size).toBe(0);
  });

  it("brings a ticket that was cut off in the middle back by itself, once", async () => {
    const r = new TheRecord();
    r.append({ kind: "ticket.opened", who: "you", ticket: "T1", project: "o/p", data: { sentence: "Add a footer.", kind: "request" } });
    r.append({ kind: "run.started", who: "SF itself", run: "T1-a", ticket: "T1", project: "o/p", data: {} });
    expect(ticketsFrom(r.all(), null)[0]).toMatchObject({ state: "interrupted", cutOff: true, cutOffReturns: 0 });
    const seen: string[] = [];
    // The run is cut off again each time: it leaves a start and no end.
    const { h } = await serve(r, { settings: settingsFileIn(mkdtempSync(join(tmpdir(), "sf-home-")), { repo: "o/p", gate: false, ladder: false }), work: async (_s, ticket) => { seen.push(ticket); r.append({ kind: "run.started", who: "SF itself", run: `${ticket}-b`, ticket, project: "o/p", data: {} }); return {} as any; } });
    h.pump();
    await new Promise((ok) => setTimeout(ok, 30));
    expect(seen).toEqual(["T1"]);
    expect(r.story("T1").filter((l) => l.kind === "ticket.queued").map((l) => [l.who, (l.data as any).after])).toEqual([["SF itself", "cut off"]]);
    h.pump();
    await new Promise((ok) => setTimeout(ok, 30));
    expect(seen).toEqual(["T1"]);
    expect(ticketsFrom(r.all(), null)[0]).toMatchObject({ state: "interrupted", cutOffReturns: 1, returns: 0 });
  });

  it("ends the rest early only when you sent a ticket again", () => {
    const at = (m: number) => new Date(Date.UTC(2026, 10, 27, 20, m)).toISOString();
    const park = { id: 1, ts: at(0), kind: "run.ended", who: "SF itself", run: "a", ticket: "T1", project: "o/p", costUsd: null, flagged: false, data: { end: "parked", parkedFor: "limit" } } as any;
    expect(restOf([park], 30, Date.parse(at(10)))).toEqual({ until: at(30), why: "the plan limit was reached" });
    expect(restOf([park], 30, Date.parse(at(31)))).toBeNull();
    expect(restOf([park, { ...park, id: 2, kind: "ticket.queued", who: "you", data: {} }], 30, Date.parse(at(10)))).toBeNull();
    expect(restOf([park, { ...park, id: 2, kind: "ticket.queued", who: "SF itself", data: { returned: true } }], 30, Date.parse(at(10)))).not.toBeNull();
    // Another run starting just then does not end the rest.
    expect(restOf([park, { ...park, id: 2, kind: "run.started", data: {} }], 30, Date.parse(at(10)))).not.toBeNull();
    expect(() => cleanSettings({ parkedWaitMinutes: 0 })).toThrow(/1 to 1440/);
    expect(() => cleanSettings({ parkedReturns: 21 })).toThrow(/0 to 20/);
  });

  it("gives an end to a go that left no trace, so the queue never spins", async () => {
    const r = new TheRecord();
    let calls = 0;
    const { url, h } = await serve(r, { work: async () => { calls++; throw new Error("the room is gone"); } });
    await fetch(`${url}/api/step1/work`, { method: "POST", headers: json(h.key), body: JSON.stringify({ sentence: "Add a footer." }) });
    await new Promise((ok) => setTimeout(ok, 20));
    expect(calls).toBe(1);
    expect(ticketsFrom(r.all(), null)[0]).toMatchObject({ state: "crashed", says: "the room is gone" });
  });

  it("refuses a key that is not plain", () => {
    expect(() => homePage("</script>")).toThrow();
  });
});
