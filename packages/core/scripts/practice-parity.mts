// Practice-crew parity: four free runs (default, council always, no planted bug, Agent Bay crew), their
// engine and agent events normalized to what must not change. Run before and after an engine change and diff:
//   npx tsx packages/core/scripts/practice-parity.mts packages/core before.json   (then after.json; diff the two)
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const core = process.argv[2];
const out = process.argv[3];
const { EventLog, Factory, MockRuntime } = await import(join(core, "src/index.ts"));
const { AgentBay } = await import(join(core, "src/bay/bay.ts"));
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const KEEP = ["station", "state", "round", "gate", "kind", "outcome", "verdict", "agent", "attempt", "passed", "failed", "pass", "reason", "fixRounds", "agentCalls", "files"];
function norm(e: any) {
  const p = e.payload ?? {};
  const o: any = { type: e.type };
  for (const k of KEEP) if (k in p) o[k] = k === "files" ? (Array.isArray(p.files) ? p.files.length : p.files) : p[k];
  if (typeof o.reason === "string") o.reason = o.reason.replace(/\/[^\s]+/g, "<path>");
  return o;
}
const cases: [string, any, any][] = [
  ["auto, practice", {}, { autoApprove: true, maxUsd: 1.5 }],
  ["council always", {}, { autoApprove: true, maxUsd: 1.5, council: "always" }],
  ["no bug", { plantBug: false }, { autoApprove: true, maxUsd: 1.5 }],
  ["bay crew", "bay", { autoApprove: true, maxUsd: 1.5 }],
];
const res: Record<string, any[]> = {};
for (const [name, rtOpts, o] of cases) {
  const log = new EventLog(":memory:");
  const rt = new MockRuntime(rtOpts === "bay" ? {} : rtOpts);
  const f = rtOpts === "bay" ? new Factory(log, rt, tmp("sf-p-"), new AgentBay(log, rt)) : new Factory(log, rt, tmp("sf-p-"));
  const id = f.start("a word counter for my notes", o);
  await f.wait(id);
  res[name] = log.list({ limit: 1e6 }).filter((e: any) => /^(factory|agent)\./.test(e.type) && !["factory.flow"].includes(e.type)).map(norm);
  log.close();
}
writeFileSync(out, JSON.stringify(res, null, 1));
console.log(Object.entries(res).map(([k, v]) => `${k}: ${v.length} events, ${v.at(-1)?.outcome ?? v.filter((x) => x.type === "factory.run.finished").at(-1)?.outcome}`).join("\n"));
