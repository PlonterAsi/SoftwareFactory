import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { EventLog } from "./events.js";
import { captureSignal } from "./signals.js";
import { runtimeFromEnv, ClaudeCodeRuntime } from "./runtime.js";
import { OrderEngine } from "./order/engine.js";
import { canonFor, type OrderState } from "./order/model.js";

/**
 * File a whole conversation through the Order Engine and print what it made.
 *
 *   npm run order -- messages.json [--mode agent|heuristic] [--max-usd 0.3] [--project Name] [--db out.db] [--out report.md]
 *
 * messages.json is a list of {"text": "...", "source"?: "..."} in the order they were said.
 * With --db the result is kept, so `SF_DB=out.db npm run dev -w @sf/core` shows it on the Bridge.
 */
const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const file = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!file) { console.error("usage: npm run order -- messages.json [--mode agent|heuristic] [--max-usd 0.3] [--db out.db] [--out report.md]"); process.exit(2); }

const mode = (flag("mode") ?? "heuristic") as "agent" | "heuristic";
const maxUsd = Number(flag("max-usd") ?? 0.3);
const dbPath = flag("db") ?? ":memory:";
if (dbPath !== ":memory:") mkdirSync(dirname(resolve(dbPath)), { recursive: true });
const log = new EventLog(dbPath);
const runtime = mode === "agent" ? (process.env.SF_RUNTIME ? runtimeFromEnv() : new ClaudeCodeRuntime({ profile: "lean" })) : null;
const order = new OrderEngine(log, runtime, { mode, maxUsd });
// --project "Name": the conversation happens inside this project, as it does on the Bridge.
if (flag("project")) order.createNode("project", flag("project")!);

const messages = JSON.parse(readFileSync(file, "utf8")) as { text: string; source?: string }[];
const started = Date.now();
for (const [i, m] of messages.entries()) {
  const s = captureSignal(log, m.text, m.source ?? "chat");
  const r = await order.ingest({ id: s.id, text: s.text, source: s.source });
  console.error(`[${i + 1}/${messages.length}] ${r.mode} · ${r.fragments.length} fragments · ${r.conflicts.length} conflicts · $${r.costUsd.toFixed(4)}${r.note ? ` · ${r.note}` : ""}`);
}
const { briefing } = order.sweep();
const report = render(order.state(), briefing.lines, (Date.now() - started) / 1000);
const out = flag("out");
if (out) { writeFileSync(out, report); console.error(`report: ${out}`); } else console.log(report);
log.close();

function render(st: OrderState, lines: { kind: string; text: string }[], secs: number): string {
  const live = st.nodes.filter((n) => n.mergedInto == null);
  const cost = st.ingests.reduce((s, r) => s + r.costUsd, 0);
  const sig = (id: number) => `#${id}`;
  const kids = (id: number | null) => live.filter((n) => n.parentId === id);
  const out: string[] = [];
  out.push(`# Order Engine run`, ``, `${Object.keys(st.signals).length} signals → ${st.fragments.length} fragments, ${live.length} nodes, ${st.conflicts.length} conflicts. Mode: ${mode}. Archivist cost: $${cost.toFixed(4)}. Time: ${secs.toFixed(0)} s.`, ``);
  out.push(`## Tree, with every fragment where it was filed`, ``);
  const walk = (id: number | null, depth: number) => {
    for (const n of kids(id)) {
      out.push(`${"  ".repeat(depth)}- **${n.kind}: ${n.title}**`);
      for (const f of st.fragments.filter((x) => x.nodeId === n.id))
        out.push(`${"  ".repeat(depth + 1)}- ${f.state !== "live" ? `~~${f.kind}~~` : f.kind}${f.important ? " ★" : ""} (${Math.round(f.confidence * 100)}%, signal ${sig(f.signalId)}): ${f.text}`);
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  const tray = st.fragments.filter((f) => f.nodeId == null && f.kind !== "noise");
  out.push(``, `## Unsorted tray (${tray.length})`, ``, ...tray.map((f) => `- ${f.kind} (${Math.round(f.confidence * 100)}%, signal ${sig(f.signalId)}): ${f.text}`));
  const noise = st.fragments.filter((f) => f.kind === "noise");
  out.push(``, `## Hidden as noise (${noise.length})`, ``, ...noise.map((f) => `- ${f.text}`));
  out.push(``, `## Canon per node`, ``);
  for (const n of live) {
    const c = canonFor(st, n.id).filter((e) => e.inheritedFrom == null);
    if (!c.length) continue;
    out.push(`**${n.title}**`, ...c.map((e) => `- ${e.fragment.text} _(signal ${sig(e.fragment.signalId)}: "${st.signals[e.fragment.signalId]?.text.slice(0, 60).replace(/\n/g, " ")}…")_`), ``);
  }
  out.push(`## Conflicts`, ``);
  const t = (id?: number) => st.fragments.find((f) => f.id === id)?.text ?? "?";
  for (const c of st.conflicts) out.push(`- **${c.status}${c.rule ? ` by ${c.rule}` : ""}**: "${t(c.a)}" vs "${t(c.b)}". ${c.reason}${c.winner ? ` Kept: "${t(c.winner)}".` : c.proposal ? ` Proposed: keep "${t(c.proposal.winner)}".` : ""}`);
  if (!st.conflicts.length) out.push(`- none`);
  out.push(``, `## Briefing`, ``, ...lines.map((l) => `- ${l.text}`), ``);
  out.push(`## visualizeEverything`, ``, `${st.visuals.filter((v) => v.pass).length} of ${st.visuals.length} checks pass.`, ...st.visuals.filter((v) => !v.pass).map((v) => `- missing for signal ${v.signalId}: ${v.missing.join("; ")}`));
  return out.join("\n") + "\n";
}
