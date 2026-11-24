import { crewAdvisor, readAdvisorRule } from "./advisor.js";
import { noteLesson, rememberLines } from "./bay/memory.js";
import { callContext, resolveProfiles, trialSettings } from "./configs/profiles.js";
import { stampConfig } from "./configs/stamp.js";
import type { EventLog } from "./events.js";
import type { AgentRequest, AgentResult, AgentRuntime } from "./runtime.js";
import { explainAgentError, isSignInError } from "./setup.js";

export interface AgentRun {
  runId: number;
  agent: string;
  result?: AgentResult;
  error?: string;
  /** What a failed call still cost (a call stopped at its spend cap spent it). */
  costUsd?: number;
}

/** Run one agent call and record start, result and cost in the event log. */
export async function runAgent(log: EventLog, runtime: AgentRuntime, agent: string, reqIn: AgentRequest, meta: { factoryRun?: number; projectId?: number; ticket?: number; station?: string; agentVersion?: number; seat?: number; round?: number; bayTest?: boolean; workbench?: boolean } = {}): Promise<AgentRun> {
  // The advisor tool (advisor.ts): a stronger model the agent may consult, by the rule you set in Systems.
  // Configuration profiles (configs/profiles.ts): the global, project, ticket and run profiles this call falls under.
  const prof = profilesFor(log, agent, reqIn, meta);
  reqIn = prof.req;
  const rule = readAdvisorRule(log);
  const advisor = crewAdvisor(reqIn, prof.advisor !== undefined ? { ...rule, model: prof.advisor } : rule);
  let req: AgentRequest = { ...reqIn, advisor };
  // "Ran with" (configs/stamp.ts): the fingerprint of the setup this call runs with.
  const config = stampConfig(log);
  const start = log.append("agent.run.started", { agent, runtime: runtime.name, model: req.model ?? null, ...(advisor ? { advisor } : {}), ...(config ? { config } : {}), ...(prof.chain.length ? { profiles: prof.chain } : {}), ...(prof.trial ? { trial: prof.trial } : {}), prompt: req.prompt.slice(0, 4000), budgetUsd: req.budgetUsd ?? null, ...(req.tools?.length ? { tools: req.tools } : {}), ...(req.commands?.length ? { commands: req.commands } : {}), ...(req.cwd ? { cwd: req.cwd } : {}), ...meta });
  try {
    let result: AgentResult;
    try { result = await runtime.run(req); }
    catch (e) {
      const msg = (e as Error).message;
      const spent = Number((e as { costUsd?: number }).costUsd ?? 0);
      if (advisor && /advis/i.test(msg) && spent === 0) {
        // A CLI too old for the advisor, or a model pair it refuses: the call runs again without it rather than failing.
        log.append("agent.run.retried", { runId: start.id, agent, ...meta, reason: "advisor refused; running without it", raw: msg.slice(0, 500) });
        req = { ...req, advisor: null };
        result = await runtime.run(req);
      } else {
        // Several CLIs starting in the same second can trip over the shared sign-in file: in run 2898 three of six
        // Council seats failed at once with "not signed in" and the next round was fine. A call that failed that
        // way and cost nothing is tried once more after a short wait, before anyone is told to sign in.
        if (!isSignInError(msg) || spent > 0) throw e;
        log.append("agent.run.retried", { runId: start.id, agent, ...meta, reason: "sign-in check failed at start", raw: msg.slice(0, 500) });
        await new Promise((r) => setTimeout(r, Number(process.env.SF_SIGNIN_RETRY_MS ?? 1500) * (0.5 + Math.random())));
        result = await runtime.run(req);
      }
    }
    log.append("agent.run.completed", { runId: start.id, agent, ...meta, ...result });
    // Lessons the agent noted for itself go into its own memory (bay/memory.ts). A test run in the Bay teaches nothing.
    if (!meta.bayTest && result.text) for (const t of rememberLines(result.text)) noteLesson(log, agent, t, "self", meta.factoryRun ? `run:${meta.factoryRun}` : meta.ticket ? `ticket:${meta.ticket}` : null);
    return { runId: start.id, agent, result };
  } catch (e) {
    // Say what to do first; keep the raw message for the log.
    const raw = (e as Error).message;
    const error = explainAgentError(raw);
    const costUsd = Number((e as { costUsd?: number }).costUsd ?? 0);
    log.append("agent.run.failed", { runId: start.id, agent, ...meta, error, costUsd, raw: raw.slice(0, 2000) });
    return { runId: start.id, agent, error, costUsd };
  }
}

/**
 * Rough price of a model per call, Haiku = 1. Fable measured on 24 Nov 2026 at about 2x Opus per token
 * (same short prompt, lean profile: Opus $0.026, Fable $0.075 with 1.5x the tokens).
 */
export function modelPrice(model: string): number {
  const m = model.toLowerCase();
  return m.includes("fable") ? 10 : m.includes("opus") ? 5 : m.includes("sonnet") ? 3 : 1;
}

/** A profile's settings applied to one call: the agent's model and cap, the advisor, the person's own settings. Never throws. */
function profilesFor(log: EventLog, agent: string, req: AgentRequest, meta: { projectId?: number; ticket?: number; factoryRun?: number }): { req: AgentRequest; advisor?: string | null; chain: string[]; trial?: { entry: string; unit: string; arm: "with" | "without" } } {
  try {
    const ctx = callContext(log, meta);
    const r = resolveProfiles(log, ctx);
    // An entry on trial (configs/trials.ts) applies to every second piece of work; a profile's own setting wins over it.
    const t = trialSettings(log, ctx);
    const s: Record<string, { value: unknown }> = { ...t.settings, ...r.settings };
    if (!r.chain.length && !Object.keys(s).length && !t.trials.length) return { req, chain: [] };
    const out: AgentRequest = { ...req };
    const model = s[`agent.${agent}.model`]?.value;
    if (typeof model === "string") out.model = model;
    // A cap sized for a cheap model starves a pricier one inside its first answer (a Fable council seat on a Haiku
    // cap). Moving to a pricier model lifts the cap by the price ratio, never past what the run has left (ceilingUsd).
    if (typeof model === "string" && req.budgetUsd !== undefined && req.ceilingUsd !== undefined) {
      const ratio = modelPrice(model) / modelPrice(req.model ?? "haiku");
      if (ratio > 1) out.budgetUsd = Math.min(req.budgetUsd * ratio, Math.max(req.budgetUsd, req.ceilingUsd));
    }
    // A profile can lower a cap, never lift it past what the run has left.
    const cap = s[`agent.${agent}.budgetUsd`]?.value;
    if (typeof cap === "number") out.budgetUsd = out.budgetUsd !== undefined ? Math.min(out.budgetUsd, cap) : cap;
    const personal = s["crew.personalSettings"]?.value;
    if (typeof personal === "boolean") out.personalSettings = personal;
    const adv = s["advisor.model"];
    return { req: out, ...(adv ? { advisor: (adv.value as string | null) ?? null } : {}), chain: r.chain.map((c) => `${c.scope}:${c.profile.id}`), ...(t.trials[0] ? { trial: t.trials[0] } : {}) };
  } catch {
    return { req, chain: [] };
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
