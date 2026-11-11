import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, Factory, MockRuntime, type AgentRequest } from "../src/index.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const events = (log: EventLog, type: string) => log.list({ limit: 1e6 }).filter((e) => e.type === type).map((e) => e.payload as any);
const until = async (ok: () => boolean) => { for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 10)); expect(ok()).toBe(true); };

/** The mock crew, but the Planner answers with junk the first `bad` times. */
function badPlanner(bad: number, seen: AgentRequest[] = []) {
  const rt = new MockRuntime({ plantBug: false });
  const base = rt.run.bind(rt);
  let n = 0;
  rt.run = async (req) => {
    const r = await base(req);
    if (req.systemPrompt?.includes("Station contract: plan")) { seen.push(req); if (++n <= bad) r.text = "no plan here"; }
    return r;
  };
  return rt;
}

describe("Retry on a failed step", () => {
  it("re-runs the step, counts the attempt, flags a repeated error, and passes your hint on", async () => {
    const log = new EventLog();
    const seen: AgentRequest[] = [];
    const f = new Factory(log, badPlanner(2, seen), tmp("sf-retry-"));
    const run = f.start("count words", { council: "never" });
    const waits = () => events(log, "factory.gate").filter((g) => g.state === "waiting" && g.gate === "escalation");

    await until(() => waits().length === 1 && f.waitingGate(run) === "escalation");
    expect(waits()[0]).toMatchObject({ kind: "retry", action: "Retry", station: "plan", attempt: 1, same: false });
    expect(f.decide(run, "escalation", { approve: true, note: "answer with the JSON plan" })).toBe(true);

    // The step ran again (marked as a retry) and failed the same way: the notice says so.
    await until(() => waits().length === 2 && f.waitingGate(run) === "escalation");
    expect(events(log, "factory.station").some((s) => s.station === "plan" && s.state === "active" && s.note === "retry 1")).toBe(true);
    expect(waits()[1]).toMatchObject({ station: "plan", attempt: 2, same: true });
    expect(waits()[1].question).toContain("failed again the same way");
    expect(seen[1].prompt).toContain("answer with the JSON plan");
    expect(events(log, "factory.gate").find((g) => g.state === "approved" && g.kind === "retry")).toMatchObject({ station: "plan", attempt: 1 });

    // Third try works; the run goes on to the plan gate.
    f.decide(run, "escalation", { approve: true });
    await until(() => f.waitingGate(run) === "gateA");
    expect(seen[2].prompt).not.toContain("answer with the JSON plan");
    f.decide(run, "gateA", { approve: false });
    await f.wait(run);
  });

  it("asks once when parallel work runs out of budget together", async () => {
    const log = new EventLog();
    const rt = new MockRuntime({ plantBug: false });
    const f = new Factory(log, rt, tmp("sf-retry-"));
    // A budget too small for even one call: every Council seat hits the budget gate at once.
    const run = f.start("a todo app with tags, due dates, reminders, sync, and export to calendar files", { council: "always", maxUsd: 0.005 });
    await until(() => f.waitingGate(run) === "escalation");
    await new Promise((r) => setTimeout(r, 50));
    expect(events(log, "factory.gate").filter((g) => g.state === "waiting" && g.kind === "budget")).toHaveLength(1);
    f.decide(run, "escalation", { approve: false });
    await f.wait(run);
    expect(events(log, "factory.run.finished")[0].outcome).toBe("stopped");
  });
});
