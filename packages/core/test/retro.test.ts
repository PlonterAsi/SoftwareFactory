import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, type SfEvent } from "../src/events.js";
import { MockRuntime } from "../src/runtime.js";
import { Factory } from "../src/factory/loop.js";
import { engineReview, engineReviewText } from "../src/factory/retro.js";

let n = 0;
const ev = (type: string, payload: Record<string, unknown>, at = n): SfEvent => ({ id: ++n, ts: new Date(Date.UTC(2026, 10, 13, 16, 4) + at * 60_000).toISOString(), type: type as never, payload });

describe("the engine review: what a run says about the factory itself", () => {
  it("turns a run like 2898 into a work list for the engine, with the evidence in each line", () => {
    n = 0;
    const events = [
      ev("factory.run.started", { idea: "Game Mastery", maxUsd: 10 }, 0),
      ev("agent.run.retried", { factoryRun: 1, agent: "skeptic" }, 0),
      ev("agent.run.completed", { factoryRun: 1, agent: "designer", station: "design", costUsd: 0.4, durationMs: 90_000 }, 2),
      ev("agent.run.completed", { factoryRun: 1, agent: "critic", station: "critique", costUsd: 0.15, durationMs: 30_000 }, 3),
      ev("factory.discovery", { run: 1, round: 3, pass: false, settled: "still under the bar after 3 rounds", docs: { screens: [1, 2, 3, 4, 5, 6], requirements: new Array(30).fill(0) }, critique: { scores: { coverage: 4, journey: 4, screens: 4, originality: 4, buildable: 3 }, problems: [{ problem: "The ranking rule is not defined" }] } }, 4),
      ev("factory.research", { run: 1, searches: 6, sourced: 0, findings: [] }, 4),
      ev("factory.plan.gaps", { run: 1, missing: ["screen: Practice", "screen: Progress"], addedByCore: true }, 5),
      ev("factory.plan", { run: 1 }, 5),
      ev("factory.feature", { run: 1, id: "F1", title: "The app's model and shell", state: "built", attempt: 1 }, 8),
      ev("factory.feature", { run: 1, id: "F3", title: "Screen: Library", state: "broken", attempt: 1, crashed: ["#/dashboard: Cannot read properties of undefined (reading 'game')"] }, 12),
      ev("factory.feature", { run: 1, id: "F3", title: "Screen: Library", state: "built", attempt: 2 }, 14),
      ev("agent.run.completed", { factoryRun: 1, agent: "builder", station: "build", costUsd: 2.77, durationMs: 700_000 }, 14),
      ev("factory.links", { run: 1, round: 0, pass: false, checked: 18, unknown: 9, dead: new Array(6).fill({ url: "https://www.youtube.com/watch?v=example1" }) }, 15),
      ev("factory.attempt", { run: 1, round: 1, agent: "fixer", before: 2, after: 1, files: ["src/schema.js"] }, 17),
      ev("factory.attempt", { run: 1, round: 2, agent: "fixer", before: 1, after: 1, files: [] }, 19),
      ev("factory.ladder", { run: 1, from: "normal", to: "deeper", reason: "The same tests failed twice in a row after a fix." }, 19),
      ev("agent.verdict", { run: 1, agent: "fixer", station: "fix", pass: false, note: "1 failing" }, 19),
      ev("agent.run.failed", { factoryRun: 1, agent: "fixer", station: "fix", costUsd: 0.12 }, 19),
      ev("factory.evaluation", { run: 1, round: 1, pass: false, scores: { function: 2, design: 2, content: 2 }, requirements: [...new Array(5).fill({ met: true }), ...new Array(25).fill({ met: false })] }, 33),
      ev("factory.station", { run: 1, station: "evaluate", state: "pass", round: 1 }, 33),
    ];
    const r = engineReview(events, { outcome: "stopped", reason: "The run took longer than 30 minutes.\nWhat was already tried: ...", spentUsd: 4.67, maxUsd: 10 });
    expect(r.minutes).toBe(33);
    const bad = r.bad.join("\n");
    expect(bad).toMatch(/Design loop: the design never passed the Critic \(still under the bar after 3 rounds; .*buildable 3\).*ranking rule/);
    expect(bad).toMatch(/Research: the Designer was allowed 6 searches and came back with no sourced finding/);
    expect(bad).toMatch(/Plan: the Planner dropped 2 designed screens and the core had to add them/);
    expect(bad).toMatch(/Build loop: 1 of 2 features built on the first try/);
    expect(bad).toMatch(/F3 \(Screen: Library\) reported done while a screen did not draw: #\/dashboard/);
    expect(bad).toMatch(/Builder: wrote 6 made-up links/);
    expect(bad).toMatch(/Fix loop: 1 round changed nothing \(round 2\)/);
    expect(bad).toMatch(/the ladder climbed 1 time \(normal to deeper\)/);
    expect(bad).toMatch(/Product judge: did not pass the product after 1 look \(function 2, design 2, content 2; 5 of 30 requirements seen working\)/);
    expect(bad).toMatch(/1 agent call failed the sign-in check/);
    expect(bad).toMatch(/ended "stopped" after 33 minutes with \$5\.33 of \$10\.00 unspent: The run took longer than 30 minutes\.$/m);
    const good = r.good.join("\n");
    expect(good).toMatch(/it designed 6 screens and 30 requirements/);
    expect(good).toMatch(/the link check caught 6 links/);
    expect(good).toMatch(/Fix loop: 1 round of 2 lowered/);
    // Where the money went, by station and by agent, the costliest agent first.
    expect(r.stages.find((s) => s.station === "build")).toMatchObject({ calls: 1, costUsd: 2.77, seconds: 700 });
    expect(r.agents[0]).toMatchObject({ agent: "builder", costUsd: 2.77 });
    expect(r.agents.find((a) => a.agent === "fixer")).toMatchObject({ failedCalls: 1, fails: 1, lastNote: "1 failing" });
    expect(engineReviewText(r)).toMatch(/What the engine did badly:\n- /);
  });

  it("every run ends with its engine review in the log, before it is marked finished", async () => {
    const log = new EventLog();
    const f = new Factory(log, new MockRuntime({ delayMs: 0 }), mkdtempSync(join(tmpdir(), "sf-retro-")));
    const run = f.start("a CLI that counts words", { autoApprove: true });
    await f.wait(run);
    const retro = log.list({ type: "factory.retro" });
    expect(retro).toHaveLength(1);
    const p = retro[0].payload as any;
    expect(p).toMatchObject({ run, outcome: "shipped" });
    expect(p.stages.map((s: any) => s.station)).toEqual(expect.arrayContaining(["plan", "build", "fix"]));
    expect(p.agents.length).toBeGreaterThan(3);
    expect(p.good.join("\n")).toMatch(/The run shipped for/);
    expect(retro[0].id).toBeLessThan(log.list({ type: "factory.run.finished" })[0].id);
  });
});
