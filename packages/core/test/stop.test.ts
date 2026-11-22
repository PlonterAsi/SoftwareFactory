import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, Factory, MockRuntime, type AgentRuntime } from "../src/index.js";
import { stopRunsOnClose } from "../src/tickets/stopruns.js";

const tmp = () => mkdtempSync(join(tmpdir(), "sf-stop-"));
const events = (log: EventLog, type: string) => log.list({ limit: 1e6 }).filter((e) => e.type === type).map((e) => e.payload as any);
const until = async (ok: () => boolean) => { for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 10)); expect(ok()).toBe(true); };

/**
 * SF-115: on 2026-11-22 a duplicate build (run 8917) sat at its plan gate, and the only way to end it was to reject
 * the plan by hand. Stop ends a run whatever it is doing, and closing its ticket does the same.
 */
describe("stopping a run (SF-115)", () => {
  it("ends a run parked at a gate at once, for good", async () => {
    const log = new EventLog();
    const f = new Factory(log, new MockRuntime({ plantBug: false }), tmp());
    const run = f.start("count words");
    await until(() => f.waitingGate(run) === "gateA");
    expect(f.stop(run)).toMatchObject({ ok: true, state: "stopping" });
    await f.wait(run);
    expect(f.isActive(run)).toBe(false);
    expect(events(log, "factory.run.stop").at(-1)).toMatchObject({ run, by: "you", gate: "gateA", working: false });
    expect(events(log, "factory.run.finished").at(-1)).toMatchObject({ run, outcome: "stopped", reason: "You stopped this run." });
    expect(f.resumable(run).ok).toBe(false);
    expect(f.stop(run)).toMatchObject({ ok: false, state: "ended" });
  });

  it("cuts the agent call in flight and starts no other", async () => {
    const log = new EventLog();
    let calls = 0;
    let started: () => void = () => {};
    const going = new Promise<void>((r) => { started = r; });
    // A call that only ends when the run's signal aborts it, like the real CLI being killed.
    const slow: AgentRuntime = { name: "slow", run: (req) => { calls++; started(); return new Promise((_res, rej) => req.signal?.addEventListener("abort", () => rej(new Error("cut")))); } };
    const f = new Factory(log, slow, tmp());
    const run = f.start("count words", { autoApprove: true });
    await going;
    expect(f.stop(run, { by: "dispatcher", reason: "Not needed." })).toMatchObject({ ok: true, state: "stopping" });
    await f.wait(run);
    expect(calls).toBe(1);
    expect(events(log, "factory.run.stop").at(-1)).toMatchObject({ run, by: "dispatcher", working: true });
    expect(events(log, "factory.run.finished").at(-1)).toMatchObject({ run, outcome: "stopped", reason: "Not needed." });
  });

  it("closes a run the restart left stopped at a gate, so nothing resumes it", async () => {
    const log = new EventLog();
    const dir = tmp();
    const f = new Factory(log, new MockRuntime({ plantBug: false }), dir);
    const run = f.start("count words");
    await until(() => f.waitingGate(run) === "gateA");
    // The app restarts: a new core finds the run in flight and marks it stopped, resumable, at its plan gate.
    const g = new Factory(log, new MockRuntime({ plantBug: false }), dir);
    expect(g.interrupted).toContain(run);
    expect(g.resumable(run)).toMatchObject({ ok: true, from: "gateA" });
    expect(g.stop(run)).toMatchObject({ ok: true, state: "stopped" });
    expect(g.resumable(run).ok).toBe(false);
    expect(g.resumeInterrupted()).toEqual([]);
    f.stop(run);
    await f.wait(run);
  });

  it("resumes a run parked at a gate at that same gate after a restart, however many updates come", async () => {
    const log = new EventLog();
    const dir = tmp();
    const rt = new MockRuntime({ plantBug: false });
    const first = new Factory(log, rt, dir);
    const run = first.start("count words");
    await until(() => first.waitingGate(run) === "gateA");
    const planners = () => rt.calls.filter((c) => c.systemPrompt?.includes("Planner")).length;
    const planned = planners();
    let f = first;
    for (let i = 0; i < 5; i++) {
      const next = new Factory(log, rt, dir);
      expect(next.resumeInterrupted()).toEqual([run]);
      await until(() => next.waitingGate(run) === "gateA");
      f = next;
    }
    expect(planners()).toBe(planned);
    f.stop(run);
    await f.wait(run);
    first.stop(run);
  });

  it("stops a ticket's runs when the ticket is closed", async () => {
    const log = new EventLog();
    const f = new Factory(log, new MockRuntime({ plantBug: false }), tmp());
    stopRunsOnClose(log, f);
    const run = f.start("count words");
    await until(() => f.waitingGate(run) === "gateA");
    log.append("ticket.run", { id: 7, run, by: "you" });
    log.append("ticket.noted", { id: 7, by: "you", status: "in_progress", text: "working" });
    expect(f.isActive(run)).toBe(true);
    log.append("ticket.noted", { id: 7, by: "you", status: "closed", text: "Not needed" });
    await f.wait(run);
    expect(events(log, "factory.run.finished").at(-1)).toMatchObject({ run, outcome: "stopped", reason: "Its ticket was closed, so the run stopped." });
    expect(events(log, "ticket.noted").at(-1)).toMatchObject({ id: 7, text: `The ticket is closed, so run #${run} was stopped.` });
  });
});
