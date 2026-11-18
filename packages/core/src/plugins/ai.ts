import type { EventLog } from "../events.js";
import type { AgentRuntime } from "../runtime.js";
import { runAgent } from "../agents.js";
import type { PluginView } from "./host.js";
import { DEFAULT_AI_MONTHLY_USD } from "./manifest.js";

/**
 * Claude for add-ons (the `ai` permission, docs/plugins.md "Asking Claude").
 *
 * An add-on's backend cannot start programs, so it asks the core, which runs the call with the same crew runtime as
 * every other agent (Claude Code with your sign-in, or the free practice crew). Every call is an ordinary agent run
 * in the log (agent `plugin:<id>`), so it shows in the spend totals like any other, and is charged to the add-on's
 * own monthly budget:
 *
 *   - the budget is what the manifest asks for (budget.monthlyUsd), until you set your own on the Add-ons page;
 *   - each call has its own cap (at most $2), cut to what is left of the month;
 *   - with less than two cents left the call is refused, with the reason, and nothing is spent.
 *
 * The only tools a call may use are WebSearch and WebFetch: it reads the web, it never touches this computer.
 * On the practice crew nothing is paid: the call answers with the add-on's own practice answer (or empty text).
 */
export const AI_TOOLS = ["WebSearch", "WebFetch"] as const;
export const AI_MODELS = ["haiku", "sonnet", "opus"] as const;
export const AI_LIMITS = { perCallUsd: 2, defaultCallUsd: 0.25, minLeftUsd: 0.02, concurrent: 2, timeoutMs: 15 * 60_000, promptChars: 200_000 };

export interface AiRequest {
  prompt: string;
  system?: string;
  model?: string;
  tools?: string[];
  budgetUsd?: number;
  timeoutMs?: number;
  /** What the practice crew answers (it costs nothing and reads nothing), so an add-on can be tried for free. */
  practice?: string;
}
export interface AiAnswer { text: string; costUsd: number; models: string[]; durationMs: number; practice: boolean }
export interface AiBudget { monthlyUsd: number; spentUsd: number; leftUsd: number; calls: number; setBy: "manifest" | "you" }

const monthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

export class PluginAi {
  private busy = new Map<string, number>();
  constructor(private log: EventLog, private runtime: () => AgentRuntime | null) {}

  /** Your own monthly budget for this add-on, if you set one. */
  private setting(id: string): number | null {
    const r = this.log.db.prepare("SELECT payload FROM events WHERE type = 'plugin.budget' AND json_extract(payload, '$.id') = ? ORDER BY id DESC LIMIT 1").get(id) as { payload: string } | undefined;
    if (!r) return null;
    const n = Number(JSON.parse(r.payload).monthlyUsd);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  budget(v: Pick<PluginView, "id" | "manifest">, now = new Date()): AiBudget {
    const mine = this.setting(v.id);
    const monthlyUsd = mine ?? v.manifest.budget?.monthlyUsd ?? DEFAULT_AI_MONTHLY_USD;
    const r = this.log.db.prepare(`SELECT count(*) AS n, coalesce(sum(json_extract(payload, '$.costUsd')), 0) AS usd FROM events
      WHERE type IN ('agent.run.completed', 'agent.run.failed') AND json_extract(payload, '$.agent') = ? AND ts >= ?`).get(`plugin:${v.id}`, monthStart(now)) as { n: number; usd: number };
    const spentUsd = Math.round(Number(r.usd) * 10_000) / 10_000;
    return { monthlyUsd, spentUsd, leftUsd: Math.max(0, Math.round((monthlyUsd - spentUsd) * 10_000) / 10_000), calls: Number(r.n), setBy: mine == null ? "manifest" : "you" };
  }

  setBudget(id: string, monthlyUsd: number, by = "you"): void {
    const n = Number(monthlyUsd);
    if (!Number.isFinite(n) || n < 0 || n > 10_000) throw new Error("A monthly budget is between $0 and $10,000");
    this.log.append("plugin.budget", { id, monthlyUsd: Math.round(n * 100) / 100, by });
  }

  async run(v: PluginView, req: AiRequest): Promise<AiAnswer> {
    if (!v.granted.includes("ai")) throw new Error(`Add-on ${v.id} may not ask Claude (it did not ask for the ai permission)`);
    const prompt = String(req.prompt ?? "");
    if (!prompt.trim()) throw new Error("Ask Claude something: the prompt is empty");
    if (prompt.length > AI_LIMITS.promptChars) throw new Error(`The prompt is ${prompt.length} characters, over the ${AI_LIMITS.promptChars} limit`);
    const tools = [...new Set((req.tools ?? []).map(String))];
    const bad = tools.filter((t) => !(AI_TOOLS as readonly string[]).includes(t));
    if (bad.length) throw new Error(`Add-ons may only give Claude ${AI_TOOLS.join(" and ")} (not ${bad.join(", ")})`);
    const model = String(req.model ?? "haiku");
    if (!(AI_MODELS as readonly string[]).includes(model)) throw new Error(`Model "${model}" is not one of ${AI_MODELS.join(", ")}`);
    const runtime = this.runtime();
    if (!runtime) throw new Error("No crew is set up to answer");
    if (runtime.name === "mock") return { text: String(req.practice ?? ""), costUsd: 0, models: ["practice"], durationMs: 0, practice: true };
    const b = this.budget(v);
    if (b.leftUsd < AI_LIMITS.minLeftUsd) throw new Error(`${v.name}'s budget for this month is used up ($${b.spentUsd.toFixed(2)} of $${b.monthlyUsd.toFixed(2)}). Raise it on the Add-ons page, or wait for next month.`);
    const cap = Math.min(Number(req.budgetUsd) > 0 ? Number(req.budgetUsd) : AI_LIMITS.defaultCallUsd, AI_LIMITS.perCallUsd, b.leftUsd);
    const now = this.busy.get(v.id) ?? 0;
    if (now >= AI_LIMITS.concurrent) throw new Error(`${v.name} already has ${now} Claude calls running; wait for one to finish`);
    this.busy.set(v.id, now + 1);
    try {
      const run = await runAgent(this.log, runtime, `plugin:${v.id}`, {
        prompt, systemPrompt: req.system ? String(req.system).slice(0, 40_000) : undefined, model, tools,
        budgetUsd: Math.round(cap * 100) / 100, timeoutMs: Math.min(Number(req.timeoutMs) || 5 * 60_000, AI_LIMITS.timeoutMs),
      }, { station: "plugin" });
      if (run.error || !run.result) throw Object.assign(new Error(run.error ?? "Claude did not answer"), { costUsd: run.costUsd ?? 0 });
      return { text: run.result.text, costUsd: run.result.costUsd, models: run.result.models, durationMs: run.result.durationMs, practice: false };
    } finally {
      this.busy.set(v.id, (this.busy.get(v.id) ?? 1) - 1);
    }
  }
}
