/**
 * Run the factory loop headless, with both gates approved for you.
 *   npm run factory -- "a CLI that renames photos by the date they were taken" [--max-usd 1.5] [--model haiku]
 * Uses SF_RUNTIME (default here: claude-code, lean profile) and writes to the same
 * event log as the Bridge (SF_DB), so the run shows on the factory floor afterwards.
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { EventLog } from "./events.js";
import { Factory } from "./factory/loop.js";
import { runtimeFromEnv } from "./runtime.js";
import { AgentBay } from "./bay/bay.js";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const council = flag("--council") as "auto" | "always" | "never" | undefined;
const maxUsd = Number(flag("--max-usd") ?? 1.5);
const model = flag("--model");
const idea = args.join(" ").trim();
if (!idea) { console.error('Usage: npm run factory -- "<one-line idea>" [--max-usd 1.5] [--model haiku] [--council auto|always|never]'); process.exit(2); }

const dbPath = process.env.SF_DB ?? resolve(process.cwd(), ".sf-data/factory.db");
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
const log = new EventLog(dbPath);
const runtime = runtimeFromEnv({ ...process.env, SF_RUNTIME: process.env.SF_RUNTIME ?? "claude-code" });
// The crew comes from the Agent Bay in the same event log, so agents edited on the Bridge work here too.
const factory = new Factory(log, runtime, process.env.SF_PROJECTS ?? resolve(dbPath === ":memory:" ? process.cwd() : dirname(dbPath), "projects"), new AgentBay(log, runtime));

log.on("event", (e) => {
  const p = e.payload as any;
  if (e.type === "factory.station") console.log(`  ${p.station.padEnd(7)} ${p.state}${p.round ? ` round ${p.round}` : ""}${p.note ? ` · ${String(p.note).slice(0, 140)}` : ""}  ($${p.spentUsd.toFixed(4)})`);
  if (e.type === "agent.run.completed") console.log(`    ${p.agent} · ${p.models?.join(",")} · ${(p.durationMs / 1000).toFixed(1)}s · $${p.costUsd.toFixed(4)}`);
  if (e.type === "agent.run.failed") console.log(`    ${p.agent} FAILED · ${p.error}`);
  if (e.type === "factory.council") console.log(`    council round ${p.round}: ${p.seats.map((s: any) => `${s.name} ${s.take?.vote ?? "no answer"}`).join(", ")} → ${p.brief.outcome}`);
  if (e.type === "factory.review") console.log(`    review: ${p.verdict}${p.findings.length ? ` · ${p.findings.map((f: any) => `[${f.severity}] ${f.text}`).join(" · ")}` : ""}`);
  if (e.type === "factory.tests") console.log(`    tests: ${p.passed} pass, ${p.failed} fail`);
  if (e.type === "factory.gate" && p.state !== "waiting") console.log(`  ${p.gate} ${p.state} by ${p.by}`);
});

const models = model ? { council: model, plan: model, tests: model, build: model, review: model, fix: model } : undefined;
console.log(`Factory run: "${idea}" (runtime ${runtime.name}, cap $${maxUsd})`);
const run = factory.start(idea, { autoApprove: true, maxUsd, models, council });
await factory.wait(run);
const fin = log.list({ type: "factory.run.finished", limit: 1e6 }).map((e) => e.payload as any).find((p) => p.run === run);
console.log(`\n${fin.outcome.toUpperCase()}: ${fin.reason}\n  total $${fin.totalUsd.toFixed(4)} · ${fin.agentCalls} agent calls · ${fin.fixRounds} fix rounds${fin.dir ? `\n  repo: ${fin.dir}` : ""}`);
log.close();
process.exit(fin.outcome === "shipped" ? 0 : 1);
