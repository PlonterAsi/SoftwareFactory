#!/usr/bin/env node
// Write the updater manifest (latest.json) the installed app reads to find a newer version.
//
//   node scripts/updates/manifest.mjs --version 0.2.41 --sig out/SoftwareFactory-setup.exe.sig \
//     --url https://github.com/PlonterAsi/SoftwareFactory/releases/download/latest/SoftwareFactory-setup.exe \
//     --notes "..." --out out/latest.json
import { readFileSync, writeFileSync } from "node:fs";

const a = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, all) => (x.startsWith("--") ? [...acc, [x.slice(2), all[i + 1]]] : acc), []));
for (const k of ["version", "sig", "url", "out"]) if (!a[k]) { console.error(`missing --${k}`); process.exit(2); }
const entry = { signature: readFileSync(a.sig, "utf8").trim(), url: a.url };
const manifest = {
  version: a.version,
  notes: a.notes ?? "",
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  // The updater looks for "<os>-<arch>-<installer>" first, then "<os>-<arch>".
  platforms: { "windows-x86_64-nsis": entry, "windows-x86_64": entry },
};
writeFileSync(a.out, JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote ${a.out}: v${a.version}`);
