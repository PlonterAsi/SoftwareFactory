import { kitOf } from "./crew.js";
import { runAgent } from "../agents.js";
import type { AgentBay } from "../bay/bay.js";
import type { EventLog } from "../events.js";
import type { AgentRuntime } from "../runtime.js";
import { parseJsonBlock } from "./workspace.js";

/**
 * App agents: an app the factory built can ask one of your agents for work it cannot do
 * with plain code, such as researching a game on the web. The app's server forwards the
 * ask to this core (kit route /api/_agent, or ctx.ask in api.js); the agent comes from the
 * Agent Bay (the Researcher by default), so its prompt, model, tools and cap stay editable.
 * Every call is logged like any agent call (station "app") and counts toward a daily cap.
 */
export const APP_AGENT_DEFAULT = "researcher";
export const APP_AGENT_DAILY_USD = 2;
const MAX_TASK = 4000;
const MAX_INPUT = 20000;

export interface AppAsk { task?: unknown; input?: unknown; agent?: unknown; app?: unknown; json?: unknown }
export interface AppAnswer { status: number; body: Record<string, unknown> }

const APP_CONTRACT = `You are working for an app that SoftwareFactory built. The app sent you a task and, maybe, input data.
Do the task. Use your tools when the task needs facts from the web, and prefer well-known, current sources.
When the task asks for structured data, answer with exactly one \`\`\`json block and nothing the app cannot parse; put source links in the data where the task asks for them.`;

/** What the app agents spent today (UTC), from the agent_runs table. */
export function appSpentToday(log: EventLog, now = new Date()): number {
  const day = now.toISOString().slice(0, 10);
  const r = log.db.prepare("SELECT coalesce(sum(cost_usd), 0) AS s FROM agent_runs WHERE station = 'app' AND status = 'done' AND started_at >= ?").get(day) as { s: number };
  return Number(r.s);
}

export async function askForApp(log: EventLog, runtime: AgentRuntime, bay: AgentBay, ask: AppAsk, opts: { dailyUsd?: number; now?: Date } = {}): Promise<AppAnswer> {
  const task = typeof ask.task === "string" ? ask.task.trim() : "";
  if (!task) return { status: 400, body: { error: "task is required: say in words what the agent should do" } };
  if (task.length > MAX_TASK) return { status: 413, body: { error: `task is too long (at most ${MAX_TASK} characters)` } };
  const input = ask.input === undefined ? "" : typeof ask.input === "string" ? ask.input : JSON.stringify(ask.input);
  if (input.length > MAX_INPUT) return { status: 413, body: { error: `input is too long (at most ${MAX_INPUT} characters)` } };
  const id = typeof ask.agent === "string" && ask.agent.trim() ? ask.agent.trim() : APP_AGENT_DEFAULT;
  const a = bay.get(id);
  if (!a || a.retired) return { status: 404, body: { error: `No active agent "${id}" in the Agent Bay` } };
  const daily = opts.dailyUsd ?? APP_AGENT_DAILY_USD;
  const spent = appSpentToday(log, opts.now);
  if (spent >= daily) return { status: 429, body: { error: `App agents reached today's cap ($${daily.toFixed(2)}). It resets tomorrow.`, spentTodayUsd: spent } };
  const app = typeof ask.app === "string" ? ask.app.slice(0, 80) : "an app";
  const run = await runAgent(log, runtime, a.def.id, {
    prompt: `App: ${app}\nTask: ${task}${input ? `\n\nInput:\n${input}` : ""}`,
    model: a.def.model,
    systemPrompt: `${a.def.prompt}\n\n${APP_CONTRACT}`,
    budgetUsd: Math.min(a.def.budgetUsd, daily - spent),
    ...kitOf(a.def),
  }, { agentVersion: a.version, station: "app" });
  if (run.error || !run.result) return { status: 502, body: { error: run.error ?? "The agent gave no answer", runId: run.runId } };
  const text = run.result.text;
  let json: unknown;
  if (ask.json !== false) { try { json = parseJsonBlock<unknown>(text); } catch { json = undefined; } }
  return { status: 200, body: { agent: a.def.id, text, ...(json !== undefined ? { json } : {}), costUsd: run.result.costUsd ?? 0, runId: run.runId } };
}
