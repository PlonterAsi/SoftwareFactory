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
    // What differs from the defaults, and always the protected settings: a default that changes later must not move what the owner set.
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({ hold: true, limitPeriod: "month", limitYou: 100, limitAlone: 50, ownSharePercent: 20, runLimit: 5, runFloor: 0.5, stopPaths: [] });
    expect(f.read()).toMatchObject({ repo: "o/p", hold: true, slots: 1 });
  });

  it("saves a change to its file and writes it in the record; no change, no line", () => {
    const r = new TheRecord();
    const h = home(r);
    expect(h.saveSettings({ model: "opus", checks: ["npm test"] })).toMatchObject({ ok: true, settings: { model: "opus", repo: "o/p" } });
    expect(h.state().settings).toMatchObject({ model: "opus", checks: ["npm test"] });
    expect(r.all().at(-1)).toMatchObject({ kind: "setting.changed", who: "you", data: { changed: { model: { from: "sonnet", to: "opus" } } } });
    h.saveSettings({ model: "opus" });
    expect(r.all().filter((l) => l.who === "you")).toHaveLength(1);
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
    // A page that moves on by itself, not a redirect: the app window comes from its own start page, and a strict cookie does not ride a redirect.
    expect(inn.status).toBe(200);
    expect(await inn.text()).toContain('location.replace("/")');
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
    expect(r.all().filter((l) => l.who !== "SF itself")).toHaveLength(0);
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
    // The limits are protected: a save that changes them is refused until each change is named by hand, and nothing is saved meanwhile.
    const first = await post("settings", { gate: false, limitYou: 2, limitAlone: 4, runLimit: 5 });
    expect(first.status).toBe(400);
    expect(((await first.json()) as any).needsHand.map((c: any) => c.key)).toEqual(["limitYou", "limitAlone"]);
    expect(h.state().settings).toMatchObject({ gate: true, limitYou: 100 });
    expect((await post("settings", { gate: false, limitYou: 2, limitAlone: 4, runLimit: 5, byHand: ["limitYou"] })).status).toBe(400);
    expect((await post("settings", { gate: false, limitYou: 2, limitAlone: 4, runLimit: 5, byHand: ["limitYou", "limitAlone"] })).status).toBe(200);
    expect((r.all().filter((l) => l.kind === "setting.changed").at(-1)!.data as any).byHand).toEqual(["limitYou", "limitAlone"]);
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
    expect((await post("settings", { limitYou: 10, byHand: ["limitYou"] })).status).toBe(200);
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

  it("works the tickets of every awake project from one queue, each from its own card", async () => {
    const r = new TheRecord();
    const seen: { ticket: string; repo: string; base: string; checks: string[] }[] = [];
    const dir = mkdtempSync(join(tmpdir(), "sf-home-"));
    const h = createHome({ record: r, github: fakeGitHub().gh, settings: settingsFileIn(dir, { repo: "o/p", base: "main", checks: ["npm test"], ladder: false, gate: false, bringInOnAdd: false }), hosts: ["127.0.0.1:1"], key: "k".repeat(48),
      work: async (st, ticket) => { seen.push({ ticket, repo: `${st.repo.owner}/${st.repo.name}`, base: st.base, checks: st.checks }); r.append({ kind: "run.ended", who: "SF itself", ticket, project: `${st.repo.owner}/${st.repo.name}`, data: { end: "parked", reason: "x" } }); return {} as any; } });
    expect(h.state().projects).toMatchObject([{ repo: "o/p", chosen: true, colour: "grey", says: "Nothing open. Nothing has shown yet that it runs here." }]);
    // A second project: added, not chosen. A ticket of the first is still worked from the first one's card.
    expect(h.project({ repo: "nope" })).toMatchObject({ ok: false });
    expect(h.project({ repo: "o/q", name: "Second" })).toEqual({ ok: true });
    expect(h.state().settings).toMatchObject({ repo: "o/p", checks: ["npm test"] });
    // Chosen: new tickets go to it, the Settings fields are its own, and the first keeps its card.
    expect(h.project({ repo: "o/q", choose: true })).toEqual({ ok: true });
    expect(h.state().settings).toMatchObject({ repo: "o/q", base: "", checks: [], projects: [{ repo: "o/p", base: "main", checks: ["npm test"] }, { repo: "o/q", name: "Second" }] });
    h.saveSettings({ base: "dev" });
    h.project({ repo: "o/p", asleep: true });
    r.append({ kind: "ticket.opened", who: "you", ticket: "T1", project: "o/p", data: { sentence: "For the sleeper.", kind: "request" } });
    r.append({ kind: "ticket.opened", who: "you", ticket: "T2", project: "x/unknown", data: { sentence: "For nobody.", kind: "request" } });
    expect(h.start("For nobody.", "request", "x/unknown")).toMatchObject({ ok: false, why: expect.stringMatching(/not on the list/) });
    h.start("For the second.", "request", "O/Q");
    await new Promise((ok) => setTimeout(ok, 20));
    expect(seen).toEqual([{ ticket: "T3", repo: "o/q", base: "dev", checks: [] }]);
    expect(h.state().projects.filter((p) => p.listed).map((p) => [p.repo, p.colour, p.says])).toEqual([["o/p", "grey", "Asleep: 1 ticket kept, none is worked."], ["o/q", "amber", "1 ticket did not finish."]]);
    // Awake again: its ticket is worked from its own card, though another project is the chosen one.
    h.project({ repo: "o/p", asleep: false });
    await new Promise((ok) => setTimeout(ok, 20));
    expect(seen[1]).toEqual({ ticket: "T1", repo: "o/p", base: "main", checks: ["npm test"] });
    // The most projects cannot be set under how many there are: the settings stay whole.
    expect(h.saveSettings({ maxProjects: 1 })).toMatchObject({ ok: false, why: expect.stringMatching(/2 projects/) });
    expect(h.state().settings.projects).toHaveLength(2);
    // Naming a listed project in the Settings form chooses it with its own card, not with the form's fields.
    expect(h.saveSettings({ repo: "https://github.com/o/p", base: "dev", checks: [], prepare: [] })).toMatchObject({ ok: true, settings: { repo: "o/p", base: "main", checks: ["npm test"] } });
    expect(h.state().settings.projects.find((c) => c.repo === "o/q")).toMatchObject({ base: "dev" });
    expect(h.project({ repo: "o/q", choose: true })).toEqual({ ok: true });
    // Off the list: the chosen one only when it is the last; the tickets stay in the record.
    expect(h.project({ repo: "o/q", remove: true })).toMatchObject({ ok: false, why: expect.stringMatching(/Choose another/) });
    expect(h.project({ repo: "o/p", remove: true })).toEqual({ ok: true });
    // Its tickets do not hide: the project is shown as not on the list, and so is one that never had a card.
    expect(h.state().projects.map((p) => [p.repo, p.listed, p.colour]).sort()).toEqual([["o/p", false, "grey"], ["o/q", true, "amber"], ["x/unknown", false, "grey"]]);
    expect(h.state().projects.find((p) => p.repo === "o/p")!.says).toBe("Not on the list: 1 ticket kept, none is worked. Choose it to bring it back.");
    expect(h.state().tickets.some((t) => t.ticket === "T1")).toBe(true);
    expect(r.all().filter((l) => l.kind === "setting.changed" && l.who === "you").length).toBeGreaterThan(4);
  });

  it("brings a new project in at once: one run that changes nothing, no gate, no ladder, and the project says whether it runs here", async () => {
    const r = new TheRecord();
    const seen: { ticket: string; repo: string; tryOnly: boolean; sentence: string }[] = [];
    let gates = 0, end = "failed its checks";
    const dir = mkdtempSync(join(tmpdir(), "sf-home-"));
    const h = createHome({ record: r, github: fakeGitHub().gh, settings: settingsFileIn(dir, { repo: "o/p", checks: ["npm test"] }), hosts: ["127.0.0.1:1"], key: "k".repeat(48),
      gate: async () => { gates++; return { ok: false, why: "not used" } as any; },
      work: async (st, ticket, sentence) => {
        const project = `${st.repo.owner}/${st.repo.name}`, run = `${ticket}-${seen.length}`;
        seen.push({ ticket, repo: project, tryOnly: !!st.tryOnly, sentence });
        r.append({ kind: "run.started", who: "SF itself", run, ticket, project, data: { model: "sonnet", tryOnly: true } });
        r.append({ kind: "run.checked", who: "SF itself", run, ticket, project, data: { command: "npm test", ok: end === "passed" } });
        r.append({ kind: "run.ended", who: "SF itself", run, ticket, project, data: { end, reason: end === "passed" ? "the project runs here: 1 of 1 check passed" : "a check failed: npm test" } });
        return {} as any;
      } });
    expect(h.state().projects[0]).toMatchObject({ repo: "o/p", proof: null, bringing: false, says: "Nothing open. Nothing has shown yet that it runs here." });
    expect(h.project({ repo: "o/q" })).toEqual({ ok: true });
    await new Promise((ok) => setTimeout(ok, 20));
    expect(seen).toEqual([{ ticket: "T1", repo: "o/q", tryOnly: true, sentence: expect.stringMatching(/^Bring this project in/) }]);
    expect(gates).toBe(0);
    // It failed: the ladder leaves it alone, its words cannot be changed, and the project says a ticket did not finish.
    await new Promise((ok) => setTimeout(ok, 20));
    expect(seen).toHaveLength(1);
    expect(h.state().tickets[0]).toMatchObject({ ticket: "T1", bringIn: true, state: "failed its checks", canEdit: false, climbable: false, canAgain: true });
    expect(h.state().projects.find((p) => p.repo === "o/q")).toMatchObject({ colour: "amber", proof: null });
    expect(h.edit("T1", "Do something else.", "request")).toMatchObject({ ok: false });
    // Shown again by name: the same ticket is sent again (no failed twin stays), still as a try, and now its check passes.
    end = "passed";
    expect(h.project({ repo: "o/q", bringIn: true })).toEqual({ ok: true });
    await new Promise((ok) => setTimeout(ok, 20));
    expect(seen[1]).toMatchObject({ ticket: "T1", tryOnly: true });
    const q = h.state().projects.find((p) => p.repo === "o/q")!;
    expect(q).toMatchObject({ proof: { checks: 1, ticket: "T1" }, bringing: false, colour: "grey" });
    expect(q.says).not.toMatch(/Nothing has shown/);
    expect(h.state().tickets.find((t) => t.ticket === "T1")).toMatchObject({ state: "passed", bringIn: true, canAgain: false });
    expect(h.state().tickets.find((t) => t.ticket === "T1")!.steps.map((s) => s.id)).toEqual(["asked", "ready", "fence", "worked", "checked"]);
    // Once more after a pass is a new ticket; when that one fails, the proof is taken away.
    end = "failed its checks";
    expect(h.project({ repo: "o/q", bringIn: true })).toEqual({ ok: true });
    await new Promise((ok) => setTimeout(ok, 20));
    expect(seen[2]).toMatchObject({ ticket: "T2", tryOnly: true });
    expect(h.state().projects.find((p) => p.repo === "o/q")).toMatchObject({ proof: null, colour: "amber" });
    // Work it again on the ticket itself stays a try.
    expect(h.again("T2")).toEqual({ ok: true });
    await new Promise((ok) => setTimeout(ok, 20));
    expect(seen[3]).toMatchObject({ ticket: "T2", tryOnly: true });
    // A project named in the Settings field for the first time is brought in too.
    expect(h.saveSettings({ repo: "o/typed" })).toMatchObject({ ok: true });
    await new Promise((ok) => setTimeout(ok, 20));
    expect(seen[4]).toMatchObject({ repo: "o/typed", tryOnly: true });
    // The call can say "only add it", and Settings can switch the first run off for every add.
    expect(h.project({ repo: "o/zzz", bringIn: false })).toEqual({ ok: true });
    expect(h.saveSettings({ bringInOnAdd: false })).toMatchObject({ ok: true });
    expect(h.project({ repo: "o/yyy" })).toEqual({ ok: true });
    await new Promise((ok) => setTimeout(ok, 20));
    expect(seen).toHaveLength(5);
    // While one waits, a second is refused.
    h.saveSettings({ hold: true });
    expect(h.project({ repo: "o/yyy", bringIn: true })).toEqual({ ok: true });
    expect(h.project({ repo: "o/yyy", bringIn: true })).toMatchObject({ ok: false, why: expect.stringMatching(/already/) });
    expect(h.state().projects.find((p) => p.repo === "o/yyy")).toMatchObject({ bringing: true });
  });

  it("the live check: a brought-in project that changed on GitHub is run here again; a failure shown twice is a finding the owner can turn into a fix ticket", async () => {
    const r = new TheRecord();
    const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
    let head = A, end = "passed", works = 0;
    const dir = mkdtempSync(join(tmpdir(), "sf-home-"));
    const h = createHome({ record: r, github: fakeGitHub().gh, settings: settingsFileIn(dir, { repo: "o/p", checks: ["npm test"], gate: false, ladder: false }), hosts: ["127.0.0.1:1"], key: "k".repeat(48),
      head: async () => head,
      work: async (st, ticket) => {
        const project = `${st.repo.owner}/${st.repo.name}`, run = `${ticket}-${works++}`;
        if (!st.tryOnly) { r.append({ kind: "run.ended", who: "SF itself", run, ticket, project, data: { end: "parked", reason: "x" } }); return {} as any; }
        r.append({ kind: "run.started", who: "SF itself", run, ticket, project, data: { model: "sonnet", tryOnly: true } });
        r.append({ kind: "run.step", who: "SF itself", run, ticket, project, data: { tried: true, baseSha: head } });
        r.append({ kind: "run.checked", who: "SF itself", run, ticket, project, data: { command: "npm test", ok: end === "passed", tail: "boom at line 3" } });
        r.append({ kind: "run.ended", who: "SF itself", run, ticket, project, data: { end, reason: end === "passed" ? "the project runs here" : "a check failed: npm test" } });
        return {} as any;
      } });
    const wait = () => new Promise((ok) => setTimeout(ok, 25));
    // A project that was never brought in is not watched.
    expect(await h.liveLook()).toEqual({ opened: [] });
    h.project({ repo: "o/p", bringIn: true }); await wait();
    expect(h.state().projects[0]).toMatchObject({ proof: { ticket: "T1" } });
    // No change on GitHub: nothing. A change: one ticket, opened by SoftwareFactory itself, counted under limit 2.
    expect(await h.liveLook()).toEqual({ opened: [] });
    head = B;
    expect(await h.liveLook()).toEqual({ opened: ["T2"] }); await wait();
    expect(r.story("T2")[0]).toMatchObject({ who: "SF itself", data: { bringIn: true, liveCheck: { from: A, to: B } } });
    expect(h.state().tickets.find((t) => t.ticket === "T2")).toMatchObject({ state: "passed", liveCheck: { from: A, to: B }, finding: false, bucket: "alone" });
    expect(await h.liveLook()).toEqual({ opened: [] });
    // The next change breaks it: the failure is run once more by itself, and only then is it a finding.
    head = C; end = "failed its checks";
    expect(await h.liveLook()).toEqual({ opened: ["T3"] }); await wait(); await wait();
    expect(r.story("T3").filter((l) => l.kind === "run.started")).toHaveLength(2);
    expect(r.story("T3").filter((l) => l.kind === "ticket.queued").map((l) => [l.who, (l.data as any).repeat])).toEqual([["SF itself", true]]);
    const t3 = h.state().tickets.find((t) => t.ticket === "T3")!;
    expect(t3).toMatchObject({ state: "failed its checks", repeated: true, finding: true, fixedBy: null, climbable: false });
    expect(h.state().projects[0]).toMatchObject({ colour: "red", stopped: true, proof: null, says: "It stopped running here after a change on GitHub." });
    expect(await h.liveLook()).toEqual({ opened: [] });
    // The owner turns the finding into an ordinary bug ticket, once; it is worked as a normal run, not a try.
    expect(h.fix("T2")).toMatchObject({ ok: false });
    const f = h.fix("T3"); await wait();
    expect(f).toEqual({ ok: true, ticket: "T4" });
    expect(r.story("T4")[0]).toMatchObject({ who: "you", data: { kind: "bug", fixes: "T3", sentence: expect.stringMatching(/stopped passing its own check[\s\S]*npm test[\s\S]*boom at line 3/) } });
    expect(h.state().tickets.find((t) => t.ticket === "T4")).toMatchObject({ bringIn: false, state: "parked" });
    expect(h.state().tickets.find((t) => t.ticket === "T3")).toMatchObject({ fixedBy: "T4" });
    expect(h.fix("T3")).toMatchObject({ ok: false, why: expect.stringMatching(/T4 is open/) });
    // A later change passes: the finding is over, the project runs here again, and its line is quiet about it.
    head = A; end = "passed";
    expect(await h.liveLook()).toEqual({ opened: ["T5"] }); await wait();
    expect(h.state().tickets.find((t) => t.ticket === "T3")).toMatchObject({ finding: false, healedBy: "T5" });
    expect(h.state().projects[0]).toMatchObject({ stopped: false, proof: { ticket: "T5" }, colour: "amber", says: "1 ticket did not finish." });
    expect(h.fix("T3")).toMatchObject({ ok: false, why: expect.stringMatching(/runs here again/) });
    // Switched off in Settings, a sleeping project: no look opens anything.
    head = B; h.saveSettings({ liveCheck: false });
    expect(await h.liveLook()).toEqual({ opened: [] });
    h.saveSettings({ liveCheck: true }); h.project({ repo: "o/p", asleep: true });
    expect(await h.liveLook()).toEqual({ opened: [] });
    expect(h.saveSettings({ liveCheckEveryMinutes: 1 })).toMatchObject({ ok: false });
  });

  it("shows what the watchdog said only while it is still the news", () => {
    const r = new TheRecord();
    const h = home(r);
    r.append({ kind: "ticket.opened", who: "you", ticket: "T1", project: "o/p", data: { sentence: "One.", kind: "request" } });
    r.append({ kind: "watchdog.spoke", who: "watchdog", ticket: "T1", data: { line: "T1 is parked: a limit of the run was reached.", why: "parked", phone: "not set" } });
    r.append({ kind: "watchdog.spoke", who: "watchdog", ticket: null, data: { line: "SoftwareFactory went away.", why: "gone", phone: "not set" } });
    expect(h.state().spoke.map((w) => w.line)).toEqual(["T1 is parked: a limit of the run was reached.", "SoftwareFactory went away."]);
    // Brought back by SoftwareFactory itself: the owner has not seen the line yet, so it stays. A new run moves it on.
    r.append({ kind: "ticket.queued", who: "SF itself", ticket: "T1", project: "o/p", data: { returned: true } });
    expect(h.state().spoke).toHaveLength(2);
    r.append({ kind: "run.started", who: "SF itself", ticket: "T1", run: "R1", project: "o/p", data: {} });
    expect(h.state().spoke.map((w) => w.line)).toEqual(["SoftwareFactory went away."]);
    // "Got it" covers only what the page had read.
    r.append({ kind: "home.seen", who: "you", data: { upTo: 1 } });
    expect(h.state().spoke).toHaveLength(1);
    r.append({ kind: "home.seen", who: "you", data: {} });
    expect(h.state().spoke).toEqual([]);
  });

  it("starts nothing while a protected setting is not what you set, and goes on when you keep it by hand", async () => {
    const r = new TheRecord();
    const dir = mkdtempSync(join(tmpdir(), "sf-home-"));
    const file = settingsFileIn(dir, { repo: "o/p", ladder: false, gate: false });
    const seen: string[] = [];
    const { url, h } = await serve(r, { settings: file, work: async (_st, ticket) => { seen.push(ticket); r.append({ kind: "run.ended", who: "SF itself", ticket, project: "o/p", data: { end: "parked", reason: "x" } }); return {} as any; } });
    const post = (path: string, body: unknown) => fetch(`${url}/api/step1/${path}`, { method: "POST", headers: json(h.key), body: JSON.stringify(body) });
    // Something that is not the screen writes a bigger limit into the settings file.
    file.write({ ...file.read(), limitAlone: 5000 });
    expect(h.state().settingsDoubt.map((c) => c.key)).toEqual(["limitAlone"]);
    expect(h.state().limits.limit.alone).toBe(50);
    await post("work", { sentence: "New." });
    await new Promise((ok) => setTimeout(ok, 20));
    expect(seen).toEqual([]);
    // Putting back what was set clears it, and the file says the owner's value again.
    expect((await post("settings", { limitAlone: h.state().settingsDoubt[0]!.set, byHand: ["limitAlone"] })).status).toBe(200);
    expect(h.state()).toMatchObject({ settingsDoubt: [], settings: { limitAlone: 50 } });
    expect((r.all().filter((l) => l.kind === "setting.changed").at(-1)!.data as any).changed.limitAlone).toEqual({ from: 50, to: 50, fileSaid: 5000 });
    await new Promise((ok) => setTimeout(ok, 20));
    expect(seen).toEqual(["T1"]);
    file.write({ ...file.read(), limitAlone: 5000 });
    await post("work", { sentence: "Newer." });
    await new Promise((ok) => setTimeout(ok, 20));
    expect(seen).toEqual(["T1"]);
    // Naming another setting by hand does not clear it; keeping it by hand does.
    expect((await post("settings", { byHand: ["limitYou"] })).status).toBe(200);
    expect(h.state().settingsDoubt).toHaveLength(1);
    // Keeping is a yes to the value the screen showed, not to whatever the file says by then.
    expect((await post("settings", { byHand: ["limitAlone"], shown: { limitAlone: 500 } })).status).toBe(400);
    expect(h.state().settingsDoubt).toHaveLength(1);
    expect((await post("settings", { byHand: ["limitAlone"], shown: { limitAlone: 5000 } })).status).toBe(200);
    expect(h.state().settingsDoubt).toEqual([]);
    expect((r.all().filter((l) => l.kind === "setting.changed").at(-1)!.data as any).changed.limitAlone).toEqual({ from: 50, to: 5000, fileSaid: 5000 });
    await new Promise((ok) => setTimeout(ok, 20));
    expect(seen).toEqual(["T1", "T2"]);
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
