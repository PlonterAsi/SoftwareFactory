import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventLog, Factory, MockRuntime, Tickets, AUTO_WORK_DEFAULT, buildFit, buildPoolUsd, featureSessionCap, FEATURE_FIT_USD,
  type AgentRequest, type AutoWork,
} from "../src/index.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const events = (log: EventLog, type: string) => log.list({ limit: 1e6 }).filter((e) => e.type === type).map((e) => e.payload as any);
const until = async (ok: () => boolean) => { for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 10)); expect(ok()).toBe(true); };

describe("SF-64: a plan is checked against the money before it starts", () => {
  it("run 5669's numbers: six features on $3 fit three, and the gate names what all six would need", () => {
    const fit = buildFit(6, 3, 0.7);
    expect(fit.ok).toBe(false);
    expect(fit.fits).toBe(3);
    expect(fit.poolUsd).toBe(1.65);
    expect(fit.needUsd).toBeGreaterThanOrEqual(6 * FEATURE_FIT_USD / 0.55 - 0.01);
    expect(buildFit(3, 3, 0.7).ok).toBe(true);
    // Never zero: one feature always goes.
    expect(buildFit(4, 0.5, 0.45).fits).toBe(1);
  });

  it("a feature session is never starved under what a feature needs; the ones in front are built whole", () => {
    // Old rule: $1.65 over 6 features left = $0.275, and down to $0.15 as money went.
    expect(featureSessionCap(0.6, 3, 1.65, 6)).toBeCloseTo(FEATURE_FIT_USD);
    expect(featureSessionCap(0.6, 3, 0.2, 4)).toBeCloseTo(FEATURE_FIT_USD);
    expect(featureSessionCap(0.6, 3, 1.65, 2)).toBeCloseTo(0.6);
    // A run picked up with a little fresh money plans with that money, not a share of a spent total.
    expect(buildPoolUsd(4, 2.5)).toBeCloseTo(1.2);
    expect(buildPoolUsd(3, 0)).toBeCloseTo(1.65);
  });
});

/** The mock crew; the Planner answers junk until `fixPlanner` is set, so a run can fail at the plan station. */
function crew(seen: AgentRequest[] = []) {
  const rt = new MockRuntime({ plantBug: false });
  const base = rt.run.bind(rt);
  const state = { badPlan: true, starve: false };
  rt.run = async (req) => {
    seen.push(req);
    if (state.starve && req.systemPrompt?.includes("Station contract: plan")) throw new Error("error_max_budget_usd");
    const r = await base(req);
    if (state.badPlan && req.systemPrompt?.includes("Station contract: plan")) r.text = "no plan here";
    return r;
  };
  return { rt, state };
}

describe("SF-65: Retry picks up where the run stopped, with fresh money", () => {
  it("a run stopped at a failed step is tried again from that step, with money for what is left, not from the start", async () => {
    const log = new EventLog();
    const { rt, state } = crew();
    const f = new Factory(log, rt, tmp("sf-retry2-"));
    const run = f.start("count words in a text", { council: "never", maxUsd: 2 });
    await until(() => f.waitingGate(run) === "escalation");
    f.decide(run, "escalation", { approve: false });
    await f.wait(run);
    expect(events(log, "factory.run.finished").at(-1).outcome).toBe("stopped");
    expect(f.retryable(run)).toMatchObject({ ok: true, from: "plan" });
    // The planner is fixed now; Retry adds money and starts at the plan, not at intake again.
    state.badPlan = false;
    const intakes = events(log, "factory.station").filter((s) => s.station === "intake" && s.state === "active").length;
    const r = f.retry(run, { addUsd: 1 });
    expect(r).toMatchObject({ run, from: "plan", addUsd: 1 });
    await until(() => f.waitingGate(run) === "gateA");
    expect(events(log, "factory.station").filter((s) => s.station === "intake" && s.state === "active").length).toBe(intakes);
    expect(events(log, "factory.run.retried").at(-1)).toMatchObject({ run, from: "plan", addUsd: 1 });
    expect(events(log, "factory.budget").at(-1).maxUsd).toBeCloseTo(r.maxUsd);
    f.decide(run, "gateA", { approve: false });
    await f.wait(run);
    // A shipped run, a running one and an unknown one cannot be retried.
    expect(f.retryable(999999).ok).toBe(false);
  });

  it("a step that ran out of money in one call is retried with a bigger cap, never the same one", async () => {
    const log = new EventLog();
    const seen: AgentRequest[] = [];
    const { rt, state } = crew(seen);
    state.badPlan = false; state.starve = true;
    const f = new Factory(log, rt, tmp("sf-retry3-"));
    const run = f.start("count words in a text", { council: "never", maxUsd: 3 });
    await until(() => f.waitingGate(run) === "escalation");
    const g = events(log, "factory.gate").filter((x) => x.state === "waiting" && x.gate === "escalation").at(-1);
    expect(g.question).toMatch(/ran out of money inside one call/);
    expect(g.action).toMatch(/^Retry with \$/);
    const was = seen.filter((r) => r.systemPrompt?.includes("Station contract: plan")).at(-1)!.budgetUsd!;
    expect(g.retryWith.capUsd).toBeGreaterThan(was);
    state.starve = false;
    f.decide(run, "escalation", { approve: true });
    await until(() => f.waitingGate(run) === "gateA");
    const next = seen.filter((r) => r.systemPrompt?.includes("Station contract: plan")).at(-1)!.budgetUsd!;
    expect(next).toBeCloseTo(g.retryWith.capUsd);
    f.decide(run, "gateA", { approve: false });
    await f.wait(run);
  });
});

/** A factory that only records starts and retries. */
function fakeFactory(log: EventLog) {
  const active = new Set<number>();
  let next = 1000;
  const f = {
    started: [] as { run: number; opts: any }[],
    retried: [] as { run: number; opts: any }[],
    start(_idea: string, opts: any) { const run = next++; active.add(run); f.started.push({ run, opts }); return run; },
    isActive(run: number) { return active.has(run); },
    duplicateOf() { return null; },
    retryable(run: number) { return active.has(run) ? { ok: false } : { ok: true, from: "build" }; },
    retryAddUsd() { return 1.4; },
    retry(run: number, opts: any) { active.add(run); f.retried.push({ run, opts }); return { run, from: "build", addUsd: opts.addUsd ?? 1.4, maxUsd: 4 }; },
    finish(run: number, outcome = "stopped") { active.delete(run); log.append("factory.run.finished", { run, outcome }); },
  };
  return f;
}

describe("the standing auto-work limit: work you asked for starts by itself", () => {
  const setup = (rule: Partial<AutoWork> = {}) => {
    const log = new EventLog();
    const factory = fakeFactory(log);
    const r: AutoWork = { ...AUTO_WORK_DEFAULT, ...rule };
    const t = new Tickets(log, { factory: factory as any, autoWork: () => r });
    const open = (title: string, o: Record<string, unknown> = {}) => t.open({ kind: "request", project: 7, title, body: "Add a page that lists every order with its date and total, newest first, so I can see what came in today.", ...o } as any);
    return { log, factory, t, rule: r, open };
  };

  it("a request you asked for starts with no press, at your per-run limit; one you did not ask for waits", () => {
    const { t, factory, open } = setup({ askedMaxUsd: 3, dailyUsd: 10 });
    const mine = open("Orders page", { asked: true });
    const other = open("Voice input");
    t.say(other.id, "", { status: "ready" });
    t.edit(other.id, "size", "M");
    expect(t.dispatch()).toEqual([mine.id]);
    expect(factory.started[0].opts).toMatchObject({ maxUsd: 3, autoApprove: true });
    expect(t.notes(mine.id).some((n) => n.by === "dispatcher" && /you asked for it, capped at \$3\.00/.test(n.text))).toBe(true);
    expect(t.queue(7).find((q) => q.ticket.id === other.id)!.why).toMatch(/Work it/);
    expect(t.detail(mine.id)!.asked).toBe(true);
  });

  it("marking a ticket asked for later starts it; an epic's mark covers its tickets; hold still holds", () => {
    const { t, factory, open } = setup({ askedMaxUsd: 2, dailyUsd: 10, wip: 5 });
    const later = open("Export to CSV");
    expect(t.dispatch()).toEqual([]);
    t.setAsked(later.id, true);
    t.dispatch();
    expect(factory.started).toHaveLength(1);
    const epic = t.open({ kind: "plan", project: 7, title: "Reports" });
    const part = open("Monthly report", { parent: epic.id });
    const held = open("Yearly report", { parent: epic.id });
    t.say(held.id, "hold this one");
    t.setAsked(epic.id, true);
    t.dispatch();
    expect(factory.started).toHaveLength(2);
    expect(t.get(part.id)!.status).toBe("in_progress");
    expect(t.queue(7).find((q) => q.ticket.id === held.id)!.why).toMatch(/hold/);
    expect(t.queue(7).find((q) => q.ticket.id === epic.id)!.why).toMatch(/starts its tickets one by one/);
  });

  it("today's limit adds up the caps of today's starts, and says when the next one waits for tomorrow", () => {
    const { t, factory, open } = setup({ askedMaxUsd: 3, dailyUsd: 4, wip: 5 });
    const a = open("A", { asked: true });
    const b = open("B", { asked: true });
    t.dispatch();
    expect(factory.started).toHaveLength(1);
    expect(t.autoUsdToday()).toBe(3);
    expect(t.queue(7).find((q) => q.ticket.id === b.id)!.why).toMatch(/Waits for tomorrow.*\$1\.00 left/);
    expect(t.get(a.id)!.status).toBe("in_progress");
  });

  it("a run you asked for that stopped is tried again from where it stopped, at most twice on the crew's own", () => {
    const { t, factory, open } = setup({ askedMaxUsd: 3, dailyUsd: 50 });
    const mine = open("Orders page", { asked: true });
    t.dispatch();
    const run = factory.started[0].run;
    t.log.append("ticket.run", { id: mine.id, run, by: "dispatcher" });
    factory.finish(run, "stopped");
    t.dispatch();
    expect(factory.retried).toHaveLength(1);
    expect(factory.retried[0]).toMatchObject({ run, opts: { addUsd: 1.4, auto: true } });
    expect(factory.started).toHaveLength(1);
    factory.finish(run, "failed");
    t.dispatch();
    expect(factory.retried).toHaveLength(1);
    expect(t.queue(7).find((q) => q.ticket.id === mine.id)!.why).toMatch(/started it 2 times on its own/);
    // You can still retry it yourself.
    expect(t.retry(mine.id).from).toBe("build");
  });

  it("a plan sliced to fit opens the next slice as a ticket, blocked by this one and asked for like it", () => {
    const { t, log, open } = setup({ askedMaxUsd: 3, dailyUsd: 50 });
    const mine = open("Scout gathering", { asked: true });
    log.append("ticket.run", { id: mine.id, run: 77, by: "you" });
    log.append("factory.plan.sliced", {
      run: 77, plan: "Scout gathering", branch: "sf/LP-1-scout", ask: "Gather tips daily", ticket: { id: mine.id, key: mine.key },
      fit: buildFit(5, 3, 0.7), kept: [{ id: "F1", title: "Feeds" }, { id: "F2", title: "Inbox" }, { id: "F3", title: "Catalog" }],
      later: [{ id: "F4", title: "Ratings", what: "Rate each find.", done: "Each find has a rating.", files: [] }, { id: "F5", title: "Digest", what: "A daily digest.", done: "It shows.", files: [] }],
    });
    const next = t.list({ view: "all", project: 7 }).find((x) => /next slice/.test(x.title))!;
    expect(next).toBeTruthy();
    expect(next.body).toMatch(/F4 Ratings/);
    expect(next.status).toBe("ready");
    expect(next.blocked).toBe(true);
    expect(t.detail(next.id)!.asked).toBe(true);
    expect(t.notes(mine.id).some((n) => /builds 3 of 5 features now/.test(n.text))).toBe(true);
    // Slice 1's pull request merges: the request stays built for a look, but slice 2 is no longer blocked and starts.
    log.append("ticket.pr", { id: mine.id, by: "github", repo: "acme/scout", number: 9, url: "https://github.com/acme/scout/pull/9", state: "merged" });
    expect(t.get(next.id)!.blocked).toBe(false);
    t.dispatch();
    expect(t.get(next.id)!.status).toBe("in_progress");
  });
});
