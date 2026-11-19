import { describe, expect, it } from "vitest";
import { ADVISOR_DEFAULT, crewAdvisor, modelRank, readAdvisorRule, setAdvisorRule } from "../src/advisor.js";
import { runAgent } from "../src/agents.js";
import { EventLog } from "../src/events.js";
import { ClaudeCodeRuntime, type AgentRequest, type AgentResult, type AgentRuntime } from "../src/runtime.js";

const opus = { model: "opus", minBudgetUsd: 0.25 };

describe("advisor rule", () => {
  it("ranks models by alias or full id", () => {
    expect(modelRank("haiku")).toBeLessThan(modelRank("claude-sonnet-5-5"));
    expect(modelRank("sonnet")).toBeLessThan(modelRank("opus"));
    expect(modelRank("claude-opus-5-5")).toBeLessThan(modelRank("claude-fable-5-2"));
    expect(modelRank("mystery")).toBe(0);
  });

  it("gives a stronger advisor to bigger calls only", () => {
    expect(crewAdvisor({ prompt: "x", model: "sonnet", budgetUsd: 0.3 }, opus)).toBe("opus");
    expect(crewAdvisor({ prompt: "x", model: "haiku" }, opus)).toBe("opus");
    expect(crewAdvisor({ prompt: "x" }, opus)).toBe("opus"); // the runtime's default model is haiku
    expect(crewAdvisor({ prompt: "x", model: "haiku", budgetUsd: 0.05 }, opus)).toBeNull();
    expect(crewAdvisor({ prompt: "x", model: "opus", budgetUsd: 1 }, opus)).toBeNull();
    expect(crewAdvisor({ prompt: "x", model: "sonnet", budgetUsd: 1 }, { model: "sonnet", minBudgetUsd: 0 })).toBeNull();
    expect(crewAdvisor({ prompt: "x", model: "sonnet", budgetUsd: 1 }, { model: null, minBudgetUsd: 0 })).toBeNull();
    expect(crewAdvisor({ prompt: "x", model: "unknown-model", budgetUsd: 1 }, opus)).toBeNull();
    // A working session (edits in a folder) gets one whatever its cap.
    expect(crewAdvisor({ prompt: "x", model: "haiku", budgetUsd: 0.05, cwd: "/w", tools: ["Edit"] }, opus)).toBe("opus");
  });

  it("lets a call pick or refuse its own advisor", () => {
    expect(crewAdvisor({ prompt: "x", model: "sonnet", budgetUsd: 1, advisor: "off" }, opus)).toBeNull();
    expect(crewAdvisor({ prompt: "x", model: "sonnet", budgetUsd: 1, advisor: null }, opus)).toBeNull();
    expect(crewAdvisor({ prompt: "x", model: "haiku", budgetUsd: 0.05, advisor: "sonnet" }, { model: null, minBudgetUsd: 0.25 })).toBe("sonnet");
  });

  it("is stored as settings, opus by default", () => {
    const log = new EventLog();
    expect(readAdvisorRule(log)).toEqual(ADVISOR_DEFAULT);
    expect(setAdvisorRule(log, { model: "off" })).toEqual({ model: null, minBudgetUsd: 0.25 });
    expect(setAdvisorRule(log, { model: "sonnet", minBudgetUsd: 0.5 })).toEqual({ model: "sonnet", minBudgetUsd: 0.5 });
    expect(() => setAdvisorRule(log, { model: "gpt" })).toThrow(/advisor model/);
    expect(() => setAdvisorRule(log, { minBudgetUsd: 9 })).toThrow(/minBudgetUsd/);
  });
});

describe("advisor in the Claude Code runtime", () => {
  it("passes the advisor runAgent picked, and none when it picked none", () => {
    const rt = new ClaudeCodeRuntime({ profile: "lean", advisorSupported: true });
    const on = rt.buildArgs({ prompt: "hi", model: "sonnet", advisor: "opus" });
    expect(on[on.indexOf("--advisor") + 1]).toBe("opus");
    expect(rt.buildArgs({ prompt: "hi", model: "sonnet", advisor: null })).not.toContain("--advisor");
  });
});

class Recorder implements AgentRuntime {
  readonly name = "recorder";
  calls: AgentRequest[] = [];
  constructor(private failFirst?: string) {}
  async run(req: AgentRequest): Promise<AgentResult> {
    this.calls.push(req);
    if (this.failFirst && this.calls.length === 1) throw Object.assign(new Error(this.failFirst), { costUsd: 0 });
    return { text: "ok", costUsd: 0.01, durationMs: 1, models: [req.model ?? "haiku"], runtime: this.name, contextTokens: 0 };
  }
}

describe("runAgent applies the advisor rule", () => {
  it("adds the advisor to big calls and records it", async () => {
    const log = new EventLog();
    const rt = new Recorder();
    await runAgent(log, rt, "builder", { prompt: "build", model: "sonnet", budgetUsd: 0.5 });
    await runAgent(log, rt, "drafter", { prompt: "draft", model: "haiku", budgetUsd: 0.05 });
    expect(rt.calls.map((c) => c.advisor)).toEqual(["opus", null]);
    const started = log.db.prepare("SELECT payload FROM events WHERE type = 'agent.run.started' ORDER BY id").all() as { payload: string }[];
    expect(JSON.parse(started[0].payload).advisor).toBe("opus");
    expect(JSON.parse(started[1].payload).advisor).toBeUndefined();
  });

  it("runs again without the advisor when the CLI refuses it", async () => {
    const log = new EventLog();
    const rt = new Recorder('Error: The model "x" does not support the advisor tool.');
    const r = await runAgent(log, rt, "builder", { prompt: "build", model: "sonnet", budgetUsd: 0.5 });
    expect(r.result?.text).toBe("ok");
    expect(rt.calls.map((c) => c.advisor)).toEqual(["opus", null]);
  });

  it("does nothing when the setting is off", async () => {
    const log = new EventLog();
    setAdvisorRule(log, { model: "off" });
    const rt = new Recorder();
    await runAgent(log, rt, "builder", { prompt: "build", model: "sonnet", budgetUsd: 0.5 });
    expect(rt.calls[0].advisor).toBeNull();
  });
});
