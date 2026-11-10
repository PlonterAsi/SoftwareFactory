import type { EventLog } from "./events.js";
import type { AgentRequest, AgentResult, AgentRuntime } from "./runtime.js";

export interface AgentRun {
  runId: number;
  agent: string;
  result?: AgentResult;
  error?: string;
}

/** Run one agent call and record start, result and cost in the event log. */
export async function runAgent(log: EventLog, runtime: AgentRuntime, agent: string, req: AgentRequest, meta: { factoryRun?: number; station?: string; agentVersion?: number; seat?: number; round?: number; bayTest?: boolean } = {}): Promise<AgentRun> {
  const start = log.append("agent.run.started", { agent, runtime: runtime.name, model: req.model ?? null, prompt: req.prompt.slice(0, 4000), budgetUsd: req.budgetUsd ?? null, ...meta });
  try {
    const result = await runtime.run(req);
    log.append("agent.run.completed", { runId: start.id, agent, ...meta, ...result });
    return { runId: start.id, agent, result };
  } catch (e) {
    const error = (e as Error).message;
    log.append("agent.run.failed", { runId: start.id, agent, ...meta, error });
    return { runId: start.id, agent, error };
  }
}

export interface CostSummary {
  runs: number;
  failed: number;
  totalUsd: number;
  lastUsd: number | null;
}

export function costSummary(log: EventLog): CostSummary {
  const done = log.list({ type: "agent.run.completed", limit: 1e6 }).map((e) => e.payload as AgentResult);
  const failed = log.list({ type: "agent.run.failed", limit: 1e6 }).length;
  const totalUsd = done.reduce((s, r) => s + (r.costUsd || 0), 0);
  return { runs: done.length, failed, totalUsd, lastUsd: done.length ? done[done.length - 1].costUsd : null };
}
