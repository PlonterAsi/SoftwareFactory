/**
 * Milestone 1 runtime spike: what does one Overseer call cost under each setup?
 * Run: npm run spike   (makes real, paid model calls; each is capped by --max-budget-usd)
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ClaudeCodeRuntime } from "./runtime.js";
import { OVERSEER_ROLE } from "./server.js";

const PROMPT = "In one sentence: what is the first thing a software factory should do with a one-line idea?";
const setups = [
  { label: "Claude Code, lean, Haiku", runtime: new ClaudeCodeRuntime({ profile: "lean" }), model: "haiku" },
  { label: "Claude Code, lean, Sonnet", runtime: new ClaudeCodeRuntime({ profile: "lean" }), model: "sonnet" },
  { label: "Claude Code, full plugins, Haiku", runtime: new ClaudeCodeRuntime({ profile: "full" }), model: "haiku" },
];

const rows: string[] = [];
for (const s of setups) {
  try {
    const r = await s.runtime.run({ prompt: PROMPT, model: s.model, systemPrompt: OVERSEER_ROLE, budgetUsd: 0.5 });
    const answer = r.text.replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 120);
    rows.push(`| ${s.label} | ${r.models.join(", ")} | ${r.contextTokens.toLocaleString("en-US")} | $${r.costUsd.toFixed(4)} | ${(r.durationMs / 1000).toFixed(1)} s | ${answer} |`);
  } catch (e) {
    rows.push(`| ${s.label} | failed | | | | ${(e as Error).message.slice(0, 120)} |`);
  }
  console.log(rows[rows.length - 1]);
}

const md = [
  `# Runtime spike results (${new Date().toISOString().slice(0, 10)})`,
  "",
  `Prompt: "${PROMPT}" with the Overseer role. Costs are list prices reported by Claude Code (total_cost_usd); what you are billed depends on your plan.`,
  "",
  "| Setup | Model | Context tokens | Cost | Time | Answer |",
  "| --- | --- | ---: | ---: | ---: | --- |",
  ...rows,
  "| Claude Code, full plugins, default model (measured by hand, \"pong\" prompt) | claude-fable-5-1 | 49,353 | $0.9872 | 4.4 s | pong |",
  "",
].join("\n");
const out = resolve(import.meta.dirname, "../../../docs/spike-runtime-results.md");
mkdirSync(resolve(out, ".."), { recursive: true });
writeFileSync(out, md);
console.log(`\nwrote ${out}`);
