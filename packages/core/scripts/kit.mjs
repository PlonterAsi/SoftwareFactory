// Copies the app kit (packages/core/kit/) into src/factory/kitFiles.ts, so the built core carries it
// with no files to find at runtime. Run after editing the kit: npm run kit -w @sf/core
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("..", import.meta.url));
const kit = join(here, "kit");
const out = {};
(function walk(d) {
  for (const n of readdirSync(d).sort()) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else out[relative(kit, p).split(sep).join("/")] = readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  }
})(kit);
const ts = `// Generated from packages/core/kit/ by scripts/kit.mjs. Do not edit here: edit the kit and run \`npm run kit -w @sf/core\`.\n/** The app kit every factory-built app ships with, by path inside the project. */\nexport const KIT_FILES: Record<string, string> = ${JSON.stringify(out, null, 2)};\n`;
writeFileSync(join(here, "src", "factory", "kitFiles.ts"), ts);
console.log(`kitFiles.ts: ${Object.keys(out).length} files`);
