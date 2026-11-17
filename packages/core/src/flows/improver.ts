import type { EventLog } from "../events.js";
import type { AgentRuntime } from "../runtime.js";
import { runAgent } from "../agents.js";
import { flowProblems, runnerOf, type FlowDef } from "./flow.js";
import type { FlowLibrary } from "./library.js";
import {
  WORDS_CONTRACT, applyOps, opsFromWords, parseOps, proposals, proposalsFrom, replay, traceRuns, wordsPrompt,
  type AgentRecord, type FlowOp, type FlowProposal,
} from "./improve.js";

/** The most a change in words may spend on the one call that reads the words (the practice crew reads them for free). */
export const WORDS_USD = 0.05;

/**
 * Proposals for a flow, their replay on past runs, one live trial, and your decision (flows/improve.ts).
 * Every write is an event; nothing changes a flow until you accept, and accepting saves its next version.
 */
export class FlowImprover {
  constructor(private log: EventLog, private lib: FlowLibrary, private o: { runtime?: AgentRuntime | null; agents?: () => { id: string; name: string; station: string }[]; record?: AgentRecord } = {}) {}

  list(flowId?: string): FlowProposal[] { this.settle(); return proposals(this.log, flowId); }

  get(id: number): FlowProposal {
    const p = proposals(this.log).find((x) => x.id === id);
    if (!p) throw new Error(`No flow proposal #${id}`);
    return p;
  }

  private flow(id: string): FlowDef {
    const f = this.lib.get(id);
    if (!f) throw new Error(`There is no flow "${id}".`);
    if (runnerOf(f) === "door") throw new Error(`"${f.name}" is carried out by its own screen, which does not read flows yet.`);
    return f;
  }

  /** Replay a candidate on the current flow's past runs, without saving anything. */
  replay(flowId: string, candidate: FlowDef) { return replay(this.log, this.flow(flowId), candidate, { agents: this.o.record }); }

  /** Make a proposal from operations: applied, checked, replayed, recorded. */
  propose(flowId: string, ops: FlowOp[], why: string, by: FlowProposal["by"], extra: { words?: string; costUsd?: number } = {}): FlowProposal {
    const cur = this.flow(flowId);
    if (!ops.length) throw new Error("Nothing to change: say what to leave out, bring back, how many rounds, who works a step, or what to tell the crew.");
    const cand = applyOps(cur, ops);
    const problems = flowProblems(cand);
    const known = this.o.agents ? new Set(this.o.agents().map((a) => a.id)) : null;
    if (known) for (const s of cand.steps) for (const a of s.crew ?? []) if (!known.has(a)) problems.push(`"${s.label}" names "${a}", which is not an active agent in the Agent Bay.`);
    if (problems.length) throw new Error(`That change would leave a flow that cannot run: ${problems.join(" ")}`);
    const r = replay(this.log, cur, cand, { agents: this.o.record });
    if (!r.changes.length) throw new Error(`${cur.name} already works that way.`);
    const e = this.log.append("flow.proposed", { flowId, baseVersion: cur.version, flow: cand, ops, why: why.slice(0, 600), by, ...(extra.words ? { words: extra.words.slice(0, 1000) } : {}), replay: r, costUsd: extra.costUsd ?? 0 });
    return this.get(e.id);
  }

  /** A change in your words. The practice crew reads them with plain rules; the real crew with one capped call. */
  async fromWords(flowId: string, words: string): Promise<FlowProposal> {
    const cur = this.flow(flowId);
    const said = words.trim();
    if (!said) throw new Error("Say how the flow should change.");
    const agents = this.o.agents?.() ?? [];
    let ops = opsFromWords(cur, said, agents);
    let costUsd = 0;
    if (this.o.runtime && this.o.runtime.name !== "mock") {
      const r = await runAgent(this.log, this.o.runtime, "overseer", { prompt: wordsPrompt(cur, said, agents), model: "haiku", systemPrompt: `You are the Overseer of SoftwareFactory.\n\n${WORDS_CONTRACT}`, budgetUsd: WORDS_USD }, { station: "flow-edit" });
      costUsd = r.result?.costUsd ?? r.costUsd ?? 0;
      try { const read = r.result ? parseOps(r.result.text) : []; if (read.length) ops = read; } catch { /* the plain rules' reading stands */ }
    }
    return this.propose(flowId, ops, `You asked: ${said}`, "words", { words: said, costUsd });
  }

  /** What SF proposes from the flow's past runs (free). Ones already open are not proposed again. */
  suggest(flowId: string): FlowProposal[] {
    const cur = this.flow(flowId);
    const open = proposals(this.log, flowId).filter((p) => ["proposed", "armed", "taken", "tried"].includes(p.state) && p.baseVersion === cur.version);
    const made: FlowProposal[] = [];
    for (const s of proposalsFrom(cur, traceRuns(this.log, cur))) {
      if (open.some((p) => JSON.stringify(p.ops) === JSON.stringify(s.ops))) continue;
      try { made.push(this.propose(flowId, s.ops, s.why, "sf")); } catch { /* a proposal that cannot apply is not made */ }
    }
    return made;
  }

  /** SF reads every flow's past runs and proposes what they show (free; run with the core's 5-minute follow). */
  suggestAll(): FlowProposal[] {
    this.settle();
    return this.lib.list().filter((s) => s.runner !== "door").flatMap((s) => { try { return this.suggest(s.id); } catch { return []; } });
  }

  /** Try it once: the next run of this flow follows the proposal, within that run's own limit. One trial at a time per flow. */
  arm(id: number): FlowProposal {
    const p = this.fresh(id);
    if (p.state !== "proposed") throw new Error(`Proposal #${id} is ${p.state}; only a new proposal can be tried.`);
    if (proposals(this.log, p.flowId).some((x) => x.state === "armed" || x.state === "taken")) throw new Error("This flow already has a trial waiting or running: one at a time.");
    this.log.append("flow.proposal", { id, state: "armed" });
    return this.get(id);
  }

  /** Accept: the proposal becomes the flow's next version. Refused when the flow changed since it was proposed. */
  accept(id: number, by = "you"): FlowProposal {
    const p = this.fresh(id);
    if (!["proposed", "armed", "tried"].includes(p.state)) throw new Error(`Proposal #${id} is ${p.state}.`);
    const { trialOf: _t, ...flow } = p.flow;
    this.lib.save({ ...flow, version: p.baseVersion } as FlowDef, by);
    this.log.append("flow.proposal", { id, state: "accepted" });
    return this.get(id);
  }

  reject(id: number, note?: string): FlowProposal {
    const p = this.get(id);
    if (p.state === "accepted" || p.state === "rejected") throw new Error(`Proposal #${id} was already ${p.state}.`);
    if (p.state === "taken") throw new Error(`Proposal #${id} is being tried right now; decide once the trial ends.`);
    this.log.append("flow.proposal", { id, state: "rejected", ...(note ? { note: note.slice(0, 300) } : {}) });
    return this.get(id);
  }

  /** The proposal, refused when its flow was saved since (replay it again as a new proposal). */
  private fresh(id: number): FlowProposal {
    const p = this.get(id);
    const cur = this.lib.get(p.flowId);
    if (!cur || cur.version !== p.baseVersion) throw new Error(`${cur?.name ?? p.flowId} changed since this was proposed (now version ${cur?.version ?? "?"}). Propose it again so it is replayed on what the flow is now.`);
    return p;
  }

  /**
   * Hand out an armed trial: the flow a run of `flowId` follows this once. Recorded as taken, so it is handed out
   * only once. Null when there is none, or when the flow changed since (the trial then waits for a new proposal).
   */
  takeTrial(flowId: string, ticket?: number): FlowDef | null {
    const p = proposals(this.log, flowId).find((x) => x.state === "armed");
    if (!p) return null;
    const cur = this.lib.get(flowId);
    if (!cur || cur.version !== p.baseVersion || flowProblems(p.flow).length) return null;
    this.log.append("flow.proposal", { id: p.id, state: "taken", ...(ticket != null ? { ticket } : {}) });
    return { ...structuredClone(p.flow), trialOf: p.id };
  }

  /** Record how trials went: an engine run's outcome and cost, or a ticket's commit. Called whenever proposals are read. */
  settle(): void {
    for (const p of proposals(this.log).filter((x) => x.state === "taken")) {
      if (p.trial?.ticket == null) {
        const started = this.log.list({ type: "factory.run.started", limit: 1e6 }).find((e) => (e.payload as { flow?: FlowDef }).flow?.trialOf === p.id);
        if (!started) continue;
        const fin = this.log.list({ type: "factory.run.finished", sinceId: started.id - 1, limit: 1e6 }).map((e) => e.payload as { run: number; outcome: string; totalUsd?: number | null }).find((x) => x.run === started.id);
        if (!fin) continue;
        this.log.append("flow.proposal", { id: p.id, state: "tried", run: started.id, outcome: fin.outcome, totalUsd: fin.totalUsd ?? null });
      } else {
        const takenAt = this.log.list({ type: "flow.proposal", limit: 1e6 }).find((e) => (e.payload as { id: number; state: string }).id === p.id && (e.payload as { state: string }).state === "taken")?.id ?? 0;
        const steps = this.log.list({ type: "ticket.step", sinceId: takenAt, limit: 1e6 }).map((e) => e.payload as { id: number; step: string; state: string }).filter((x) => x.id === p.trial!.ticket);
        const commit = steps.find((x) => x.step === "commit" && (x.state === "passed" || x.state === "failed"));
        if (!commit) continue;
        const runIds = new Set(this.log.list({ type: "agent.run.started", sinceId: takenAt, limit: 1e6 }).filter((e) => (e.payload as { ticket?: number }).ticket === p.trial!.ticket).map((e) => e.id));
        const usd = this.log.list({ type: "agent.run.completed", sinceId: takenAt, limit: 1e6 }).filter((e) => runIds.has((e.payload as { runId: number }).runId)).reduce((a, e) => a + Number((e.payload as { costUsd?: number }).costUsd ?? 0), 0);
        this.log.append("flow.proposal", { id: p.id, state: "tried", ticket: p.trial!.ticket, outcome: commit.state === "passed" ? "shipped" : "failed", totalUsd: Number(usd.toFixed(4)) });
      }
    }
  }
}
