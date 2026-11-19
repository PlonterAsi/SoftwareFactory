// The settings table the rule is kept in (registered on import, so every EventLog has it).
import "./bridge/tables.js";
import type { EventLog } from "./events.js";
import { edits, type AgentRequest } from "./runtime.js";

/**
 * Anthropic's advisor tool for the crew (docs/advisor.md).
 *
 * The agent's own model (usually haiku or sonnet) does the work, and may stop mid-task to ask a stronger
 * model (the advisor, opus by default) for a plan or a second look. Claude Code runs it with `--advisor`.
 * The advisor's tokens are billed at its own model's price, and they count inside the call's own spend cap.
 *
 * Policy, applied to every paid call in one place (runAgent), on top of the runtime's own check that the
 * CLI knows `--advisor` (runtime.ts, cliHasAdvisor):
 * - a call that names its advisor (a model, or null for none) keeps it;
 * - off when the setting is off, or when the advisor is not stronger than the agent's own model (an opus agent
 *   gets no opus advisor);
 * - on for working sessions (an agent editing a folder: Builder, Fixer, a ticket's repo work), and for other
 *   calls only when their cap is at least `minBudgetUsd`: below it a consultation could use up the cap and fail
 *   the call, and short one-shot answers gain little from a plan.
 */
export interface AdvisorRule {
  /** Advisor model alias, or null for off. */
  model: string | null;
  /** Calls with a spend cap below this get no advisor. */
  minBudgetUsd: number;
}

export const ADVISOR_MODELS = ["sonnet", "opus"] as const;
export const ADVISOR_DEFAULT: AdvisorRule = { model: "opus", minBudgetUsd: 0.25 };

/** How capable a model is, from its alias or id. Unknown models rank 0 and never get an advisor. */
export function modelRank(model: string | undefined): number {
  const m = (model ?? "").toLowerCase();
  if (/fable|mythos/.test(m)) return 4;
  if (m.includes("opus")) return 3;
  if (m.includes("sonnet")) return 2;
  if (m.includes("haiku")) return 1;
  return 0;
}

/** The advisor this call runs with, or null for none. `defaultModel` is the runtime's model when the call names none. */
export function crewAdvisor(req: AgentRequest, rule: AdvisorRule, defaultModel = "haiku"): string | null {
  if (req.advisor !== undefined) return req.advisor && req.advisor !== "off" ? req.advisor : null;
  if (!rule.model) return null;
  const own = modelRank(req.model ?? defaultModel);
  if (own === 0 || modelRank(rule.model) <= own) return null;
  if (!edits(req) && req.budgetUsd !== undefined && req.budgetUsd < rule.minBudgetUsd) return null;
  return rule.model;
}

/** The advisor rule you set in Systems, newest value per key from the settings table. */
export function readAdvisorRule(log: EventLog): AdvisorRule {
  const get = (key: string): unknown => {
    try {
      const row = log.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
      return row ? JSON.parse(row.value) : undefined;
    } catch { return undefined; } // a log made before the settings table was registered: the default rule
  };
  // Before you pick one in Systems, SF_ADVISOR (off, sonnet or opus) can set the default.
  const model = get("advisorModel") ?? process.env.SF_ADVISOR;
  const min = get("advisorMinBudgetUsd");
  return {
    model: model === null || model === "off" ? null : typeof model === "string" && (ADVISOR_MODELS as readonly string[]).includes(model) ? model : ADVISOR_DEFAULT.model,
    minBudgetUsd: typeof min === "number" && min >= 0 ? min : ADVISOR_DEFAULT.minBudgetUsd,
  };
}

/** Change the rule (null model = off). Returns the rule now in force. Throws on a value it cannot use. */
export function setAdvisorRule(log: EventLog, b: { model?: unknown; minBudgetUsd?: unknown }): AdvisorRule {
  if (b.model !== undefined) {
    const off = b.model === null || b.model === "off";
    if (!off && !(typeof b.model === "string" && (ADVISOR_MODELS as readonly string[]).includes(b.model))) throw new Error(`advisor model must be off or one of ${ADVISOR_MODELS.join(", ")}`);
    log.append("settings.changed", { key: "advisorModel", value: off ? "off" : b.model });
  }
  if (b.minBudgetUsd !== undefined) {
    if (typeof b.minBudgetUsd !== "number" || !(b.minBudgetUsd >= 0 && b.minBudgetUsd <= 5)) throw new Error("minBudgetUsd must be between 0 and 5");
    log.append("settings.changed", { key: "advisorMinBudgetUsd", value: b.minBudgetUsd });
  }
  return readAdvisorRule(log);
}
