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
    const x = t.open({ project: 7, ...o });
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
    expect(factory.started[0].opts).toMatchObject({ maxUsd: 0.6, autoApprove: true });
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
    expect(autoWorkRefusal({ ...base, kind: "plan" })).toMatch(/epic waits/);
  });
});
