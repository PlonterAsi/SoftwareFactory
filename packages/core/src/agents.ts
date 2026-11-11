import type { EventLog } from "./events.js";
import type { AgentRequest, AgentResult, AgentRuntime } from "./runtime.js";
import { explainAgentError } from "./setup.js";

export interface AgentRun {
  runId: number;
  agent: string;
  result?: AgentResult;
  error?: string;
}

/** Run one agent call and record start, result and cost in the event log. */
export async function runAgent(log: EventLog, runtime: AgentRuntime, agent: string, req: AgentRequest, meta: { factoryRun?: number; projectId?: number; station?: string; agentVersion?: number; seat?: number; round?: number; bayTest?: boolean } = {}): Promise<AgentRun> {
  const start = log.append("agent.run.started", { agent, runtime: runtime.name, model: req.model ?? null, prompt: req.prompt.slice(0, 4000), budgetUsd: req.budgetUsd ?? null, ...meta });
  try {
    const result = await runtime.run(req);
    log.append("agent.run.completed", { runId: start.id, agent, ...meta, ...result });
    return { runId: start.id, agent, result };
  } catch (e) {
    // Say what to do first; keep the raw message for the log.
    const raw = (e as Error).message;
    const error = explainAgentError(raw);
    log.append("agent.run.failed", { runId: start.id, agent, ...meta, error, ...(error !== raw ? { raw: raw.slice(0, 2000) } : {}) });
    return { runId: start.id, agent, error };
  }
}

export interface CostSummary {
  runs: number;
  failed: number;
  totalUsd: number;
  lastUsd: number | null;
}

/** Spend across every agent call, from the organized `agent_runs` table. */
export function costSummary(log: EventLog): CostSummary {
  const t = log.db.prepare(`SELECT count(*) FILTER (WHERE status = 'done') AS runs, count(*) FILTER (WHERE status = 'failed') AS failed,
    coalesce(sum(cost_usd) FILTER (WHERE status = 'done'), 0) AS total FROM agent_runs`).get() as { runs: number; failed: number; total: number };
  const last = log.db.prepare("SELECT cost_usd FROM agent_runs WHERE status = 'done' ORDER BY ended_at DESC, id DESC LIMIT 1").get() as { cost_usd: number } | undefined;
  return { runs: Number(t.runs), failed: Number(t.failed), totalUsd: Number(t.total), lastUsd: last ? Number(last.cost_usd) : null };
}
