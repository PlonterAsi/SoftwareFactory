// Says where the build of SoftwareFactory stands, from build/pieces.json. See docs/build-loop.md.
import { readFileSync } from "node:fs";
const list = JSON.parse(readFileSync(new URL("../../build/pieces.json", import.meta.url), "utf8"));
const all = list.steps.flatMap((s) => s.pieces.map((p) => ({ ...p, step: s.n, stepTitle: s.title })));
const count = (st) => all.filter((p) => p.status === st).length;
console.log(`${all.length} pieces: ${count("proven")} proven, ${count("built")} built and waiting for proof, ${count("parked")} parked.`);
for (const p of all.filter((x) => x.status === "now")) console.log(`\nNOW  step ${p.step} (${p.stepTitle}): ${p.title}\n     done when: ${p.done}\n     from: ${p.from}`);
const next = all.find((p) => p.status === "next");
if (next) console.log(`\nNEXT step ${next.step}: ${next.title}`);
