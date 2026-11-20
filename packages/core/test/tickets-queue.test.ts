import { describe, it, expect } from "vitest";
import { EventLog, Tickets, AUTO_WORK_DEFAULT, autoWorkRefusal, type AutoWork, type AgentRuntime, type Factory } from "../src/index.js";

/** A factory that only records what it was asked to start; `finish` ends a run like the real one. */
function fakeFactory(log: EventLog) {
  const active = new Set<number>();
  let next = 1000;
  const f = {
    started: [] as { run: number; idea: string; opts: any }[],
    start(idea: string, opts: any) { const run = next++; active.add(run); f.started.push({ run, idea, opts }); return run; },
    isActive(run: number) { return active.has(run); },
    duplicateOf(_idea: string) { return null; },
    finish(run: number, outcome = "stopped") { active.delete(run); log.append("factory.run.finished", { run, outcome }); },
  };
  return f;
}

function setup(rule: Partial<AutoWork> = {}) {
  const log = new EventLog();
  const factory = fakeFactory(log);
  const r: AutoWork = { ...AUTO_WORK_DEFAULT, ...rule };
  const t = new Tickets(log, { factory: factory as unknown as Factory, autoWork: () => r });
  const ready = (o: Parameters<Tickets["open"]>[0], size: "S" | "M" | "L" | null = "S") => {
    // Written clearly enough for the check before money (tickets/precheck.ts), unless a test says otherwise.
    const x = t.open({ project: 7, body: "After a restart the screen shows nothing. It should show the list it showed before the restart.", answers: { expected: "The list it showed before" }, ...o });
    if (size) t.edit(x.id, "size", size);
    t.say(x.id, "", { status: "ready" });
    return x.id;
  };
  return { log, factory, t, rule: r, ready };
}

describe("tickets: the ready queue", () => {
  it("starts a ready bug or task of size S or M by itself, and says so on the ticket", () => {
    const { t, factory, ready } = setup();
    const id = ready({ kind: "bug", title: "Run tab blank after restart" });
    expect(t.dispatch()).toEqual([id]);
    expect(t.get(id)!.status).toBe("in_progress");
    expect(factory.started[0].opts).toMatchObject({ maxUsd: AUTO_WORK_DEFAULT.maxUsd, autoApprove: true });
    expect(t.notes(id).some((n) => n.by === "dispatcher" && /picked it up on its own/.test(n.text))).toBe(true);
  });

  it("leaves taste, big, unsized, blocked and held tickets to you, and says why", () => {
    const { t, ready } = setup();
    const req = ready({ kind: "request", title: "Voice input" });
    const big = ready({ kind: "task", title: "Rewrite storage" }, "L");
    const unsized = ready({ kind: "task", title: "Something" }, null);
    const held = ready({ kind: "task", title: "Careful one" });
    t.say(held, "hold this until Monday");
    const blocker = t.open({ kind: "task", title: "First this", project: 7 });
    const blocked = ready({ kind: "task", title: "Then this" });
    t.link(blocker.id, blocked, "blocks");
    expect(t.dispatch()).toEqual([]);
    const why = Object.fromEntries(t.queue(7).map((q) => [q.ticket.id, q.why]));
    expect(why[req]).toMatch(/waits for your Work it/);
    expect(why[big]).toMatch(/Size L/);
    expect(why[unsized]).toMatch(/Not sized/);
    expect(why[held]).toMatch(/hold/);
    expect(why[blocked]).toMatch(/Blocked/);
    expect(t.detail(req)!.queue).toEqual({ position: null, why: expect.stringMatching(/Work it/) });
  });

  it("a ticket the check before money holds is out of line and says which answers it waits for, said once on its timeline", () => {
    const { t, ready, log } = setup();
    const keys = ready({ kind: "task", title: "Rotate the API keys", body: "Move every API key to the new vault. The old file is gone after." });
    const fine = ready({ kind: "task", title: "Fine one" });
    expect(t.dispatch()).toEqual([fine]);
    const spot = t.queue(7).find((q) => q.ticket.id === keys)!;
    expect(spot.position).toBeNull();
    expect(spot.why).toMatch(/Waits for your answer before it costs money: .*secrets or accounts/);
    t.dispatch();
    expect((log.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'ticket.checked' AND json_extract(payload, '$.id') = ?").get(keys) as { n: number }).n).toBe(1);
  });

  it("works at most `wip` tickets per project, in priority order, and takes the next when one ends", async () => {
    const { t, factory, ready } = setup({ wip: 1 });
    const later = ready({ kind: "task", title: "Later" });
    const now = ready({ kind: "task", title: "Urgent", priority: "now" });
    expect(t.queue(7).map((q) => [q.ticket.id, q.position])).toEqual([[now, 1], [later, 2]]);
    expect(t.dispatch()).toEqual([now]);
    expect(t.dispatch()).toEqual([]);
    expect(t.detail(later)!.queue).toEqual({ position: 1, why: null });
    factory.finish(factory.started[0].run);
    await new Promise((r) => setTimeout(r, 120));
    expect(t.get(later)!.status).toBe("in_progress");
  });

  it("keeps a day's starts under the daily cap, and does nothing when turned off", () => {
    const capped = setup({ maxUsd: 0.6, dailyUsd: 1, wip: 5 });
    capped.ready({ kind: "task", title: "One" });
    capped.ready({ kind: "task", title: "Two" });
    expect(capped.t.dispatch()).toHaveLength(1);
    const off = setup({ on: false });
    off.ready({ kind: "task", title: "One" });
    expect(off.t.dispatch()).toEqual([]);
  });

  it("an agent's reading sizes the ticket", async () => {
    const log = new EventLog();
    const runtime: AgentRuntime = { name: "stub", run: async () => ({ text: "A one-line fix in the Run tab.\nSIZE: S\nSTATUS: ready", costUsd: 0.001, durationMs: 1, models: ["stub"], runtime: "stub", contextTokens: 0 }) as any };
    const t = new Tickets(log, { runtime });
    const x = t.open({ kind: "bug", title: "Run tab blank" });
    const r = await t.ask(x.id);
    expect(t.get(x.id)!.size).toBe("S");
    expect(t.get(x.id)!.status).toBe("ready");
    expect(r.reply).not.toMatch(/SIZE|STATUS/);
  });

  it("states the rule in plain words", () => {
    const base = { kind: "task" as const, status: "ready" as const, size: "M" as const, blocked: false, assignee: null };
    expect(autoWorkRefusal(base)).toBeNull();
    expect(autoWorkRefusal({ ...base, assignee: "you" })).toMatch(/You took it/);
    expect(autoWorkRefusal({ ...base, kind: "plan" })).toMatch(/^An epic waits/);
    expect(autoWorkRefusal({ ...base, kind: "idea" })).toMatch(/^An idea waits/);
    expect(autoWorkRefusal({ ...base, kind: "request" })).toMatch(/^A request waits/);
  });
});

describe("tickets: open bugs and tasks get read by themselves", () => {
  const stub = (calls: string[]): AgentRuntime => ({ name: "stub", run: async (req: any) => { calls.push(req.prompt); return { text: "Pin the packages.\nSIZE: S\nSTATUS: ready", costUsd: 0.01, durationMs: 1, models: ["stub"], runtime: "stub", contextTokens: 0 } as any; } });
  const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5)); return f(); };

  it("has the Overseer read open bugs and tasks once, most urgent first, then the queue takes them", async () => {
    const log = new EventLog();
    const factory = fakeFactory(log);
    const calls: string[] = [];
    const t = new Tickets(log, { runtime: stub(calls), factory: factory as unknown as Factory, autoWork: () => ({ ...AUTO_WORK_DEFAULT }) });
    const later = t.open({ project: 7, kind: "task", title: "Split a big file", priority: "someday" });
    const now = t.open({ project: 7, kind: "bug", title: "Update 8 vulnerable packages", priority: "now", body: "npm audit lists 8 packages with known vulnerabilities. Update them to fixed versions.", answers: { expected: "npm audit clean" } });
    const idea = t.open({ project: 7, kind: "idea", title: "A new door" });
    const mine = t.open({ project: 7, kind: "bug", title: "Mine" });
    t.edit(mine.id, "assignee", "you");
    expect(t.triage()).toEqual([now.id, later.id]);
    expect(await until(() => t.get(now.id)!.status !== "open" && t.get(later.id)!.status !== "open")).toBe(true);
    expect(t.get(idea.id)!.status).toBe("open");
    expect(t.notes(now.id).some((n) => n.by === "dispatcher" && /Overseer reads it on its own/.test(n.text))).toBe(true);
    // Read once: never again, and the read is not counted as a start.
    expect(t.triage()).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("stays within today's auto-work limit and does nothing when auto-work is off", () => {
    const log = new EventLog();
    const calls: string[] = [];
    const off = new Tickets(log, { runtime: stub(calls), autoWork: () => ({ ...AUTO_WORK_DEFAULT, on: false }) });
    off.open({ project: 7, kind: "bug", title: "A bug" });
    expect(off.triage()).toEqual([]);
    const log2 = new EventLog();
    const poor = new Tickets(log2, { runtime: stub(calls), autoWork: () => ({ ...AUTO_WORK_DEFAULT, dailyUsd: 0.05 }) });
    poor.open({ project: 7, kind: "bug", title: "A bug" });
    expect(poor.triage()).toEqual([]);
  });
});

describe("tickets: reads that leave money for the crew", () => {
  it("counts what a read really cost, keeps reads to a quarter of the day, and skips tickets in no project", async () => {
    const log = new EventLog();
    const runtime: AgentRuntime = { name: "stub", run: async () => ({ text: "Clear.\nSIZE: S\nSTATUS: open", costUsd: 0.02, durationMs: 1, models: ["stub"], runtime: "stub", contextTokens: 0 }) as any };
    const t = new Tickets(log, { runtime, autoWork: () => ({ ...AUTO_WORK_DEFAULT, dailyUsd: 0.4 }) });
    const nowhere = t.open({ kind: "bug", title: "Filed by an add-on in no project" });
    const a = t.open({ project: 7, kind: "bug", title: "One" });
    t.open({ project: 7, kind: "bug", title: "Two" });
    // A quarter of $0.40 is $0.10: one read at its $0.10 cap fits, the second waits.
    expect(t.triage()).toEqual([a.id]);
    for (let i = 0; i < 100 && t.notes(a.id).every((n) => !/Read by the Overseer/.test(n.text)); i++) await new Promise((r) => setTimeout(r, 5));
    expect(t.autoUsdToday()).toBeCloseTo(0.02, 5);
    expect(t.get(nowhere.id)!.status).toBe("open");
  });

  it("never starts a ready ticket in no project on its own", () => {
    expect(autoWorkRefusal({ kind: "bug", status: "ready", size: "S", blocked: false, assignee: null, project: null })).toMatch(/In no project/);
    expect(autoWorkRefusal({ kind: "bug", status: "ready", size: "S", blocked: false, assignee: null, project: 7 })).toBeNull();
  });
});

describe("tickets: the 19 Nov limits", () => {
  it("lifts limits still at the old defaults once, and keeps any you set", async () => {
    const { liftAutoWorkLimits, readSettings } = await import("../src/server.js");
    const log = new EventLog();
    log.append("settings.changed", { key: "ticketsAutoDailyUsd", value: 3 });
    log.append("settings.changed", { key: "ticketsAutoMaxUsd", value: 0.9 });
    liftAutoWorkLimits(log);
    expect(readSettings(log)).toMatchObject({ ticketsAutoDailyUsd: 10, ticketsAutoMaxUsd: 0.9 });
    log.append("settings.changed", { key: "ticketsAutoDailyUsd", value: 3 });
    liftAutoWorkLimits(log);
    expect(readSettings(log).ticketsAutoDailyUsd).toBe(3);
  });
});
