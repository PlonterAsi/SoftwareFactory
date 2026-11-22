import { describe, expect, it } from "vitest";
import { EventLog } from "../src/index.js";
import { runAgent } from "../src/agents.js";
import { Tickets } from "../src/tickets/tickets.js";
import { createProject } from "../src/projects/service.js";
import { listCatalog, saveEntry, setEntryState } from "../src/configs/catalog.js";
import { featureOn, resolveProfiles } from "../src/configs/profiles.js";
import { canTrial, decideTrials, trialReport } from "../src/configs/trials.js";
import type { AgentRequest, AgentResult, AgentRuntime } from "../src/runtime.js";

class Spy implements AgentRuntime {
  name = "spy";
  seen: AgentRequest[] = [];
  constructor(private cost: (req: AgentRequest) => number = () => 0.1) {}
  async run(req: AgentRequest): Promise<AgentResult> { this.seen.push(req); return { text: "ok", costUsd: this.cost(req), durationMs: 1000 } as AgentResult; }
}

function world() {
  const log = new EventLog();
  const project = createProject(log, { name: "P" });
  const tickets = new Tickets(log);
  const ids = Array.from({ length: 10 }, (_, i) => tickets.open({ kind: "task", title: `T${i + 1}`, project, by: "you" }).id);
  return { log, tickets, ids };
}

const decide = (log: EventLog, tickets: Tickets) => decideTrials(log, (id, state, note) => setEntryState(log, tickets, id, state, "trial", note));

describe("trials", () => {
  it("only a ready entry with settings can go on trial", () => {
    const log = new EventLog();
    expect(canTrial(saveEntry(log, { title: "Idea only" }))).toMatch(/build it first/);
    expect(canTrial(saveEntry(log, { title: "Cheap fixer", settings: [{ path: "agent.fixer.model", value: "haiku" }] }))).toMatch(/must be built/);
    expect(canTrial(saveEntry(log, { title: "Ready", settings: [{ path: "feature.x", value: true }], state: "ready" }))).toBeNull();
  });

  it("a built entry with no settings becomes its own feature switch, so it can go on trial", () => {
    const log = new EventLog();
    const e = saveEntry(log, { title: "Peer review", state: "building" });
    const after = setEntryState(log, null, e.id, "ready");
    expect(after.settings).toEqual([{ path: `feature.${e.id}`, value: true }]);
    expect(canTrial(after)).toBeNull();
  });

  it("gives every second piece of work the entry, records the side, and promotes a clear winner", async () => {
    const { log, tickets, ids } = world();
    const e = saveEntry(log, { title: "Opus fixer", settings: [{ path: "agent.fixer.model", value: "opus" }, { path: "feature.peer-review", value: true }], state: "ready" });
    setEntryState(log, tickets, e.id, "trial");
    const rt = new Spy();
    for (const id of ids) await runAgent(log, rt, "fixer", { prompt: "x", model: "sonnet" }, { ticket: id });
    expect(rt.seen.map((r) => r.model)).toEqual(ids.map((id) => (id % 2 === 0 ? "opus" : "sonnet")));
    expect(featureOn(log, "peer-review", { ticket: ids[1] })).toBe(ids[1] % 2 === 0);
    expect(trialReport(log, e.id).verdict).toBe("running");
    // Every piece with it merges; without it, only two of five do.
    let without = 0;
    for (const id of ids) {
      const merged = id % 2 === 0 || without++ < 2;
      log.append("ticket.pr", { id, repo: "a/b", number: id, url: "u", state: merged ? "merged" : "closed" });
    }
    const r = trialReport(log, e.id);
    expect(r.sides.with).toMatchObject({ finished: 5, passed: 5 });
    expect(r.sides.without).toMatchObject({ finished: 5, passed: 2 });
    expect(r.verdict).toBe("promote");
    decide(log, tickets);
    const after = listCatalog(log).find((x) => x.id === e.id)!;
    expect(after.state).toBe("promoted");
    expect(after.note).toMatch(/Clearly better/);
    // Promoted: it applies everywhere now.
    expect(resolveProfiles(log, {}).settings["agent.fixer.model"].value).toBe("opus");
  });

  it("drops a worse entry, and leaves an unclear one on trial with a note for you", async () => {
    for (const [withPass, withoutPass, verdict] of [[2, 4, "drop"], [3, 3, "unclear"]] as const) {
      const { log, tickets, ids } = world();
      const e = saveEntry(log, { title: `E ${verdict}`, settings: [{ path: "advisor.model", value: null }], state: "ready" });
      setEntryState(log, tickets, e.id, "trial");
      for (const id of ids) await runAgent(log, new Spy(), "builder", { prompt: "x" }, { ticket: id });
      let w = 0, wo = 0;
      for (const id of ids) {
        const merged = id % 2 === 0 ? w++ < withPass : wo++ < withoutPass;
        log.append("ticket.pr", { id, repo: "a/b", number: id, url: "u", state: merged ? "merged" : "closed" });
      }
      decide(log, tickets);
      const after = listCatalog(log).find((x) => x.id === e.id)!;
      expect(after.state).toBe(verdict === "drop" ? "dropped" : "trial");
      expect(after.note).toMatch(verdict === "drop" ? /Worse/ : /your call/);
    }
  });
});
