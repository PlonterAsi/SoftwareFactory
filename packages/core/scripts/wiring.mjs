// Reads the real code and writes the wiring map: for every source file, what it imports, which events
// it writes and reads, which API areas it serves or calls, and which tables it creates or queries.
// The feature map (src/featuremap/) folds this by feature, so "what is connected to what" is never
// drawn by hand. Run after changing code: npm run wiring -w @sf/core   (a test fails when it is stale)
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("..", import.meta.url));
const root = join(here, "..", "..");
const OUT = "packages/core/src/featuremap/wiring.generated.ts";
/** Folders the map covers, with the extensions read in each. */
const AREAS = [
  { dir: "packages/core/src", ext: [".ts"] },
  { dir: "apps/bridge/src", ext: [".ts", ".tsx", ".css"] },
  { dir: "src-tauri/src", ext: [".rs"] },
];
/** Generated files: owned like any other, but their text is data, not wiring. */
const OPAQUE = new Set(["packages/core/src/factory/kitFiles.ts", OUT]);

const rel = (p) => relative(root, p).split(sep).join("/");
function walk(dir, ext, out = []) {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (ext.some((e) => n.endsWith(e))) out.push(p);
  }
  return out;
}

const paths = AREAS.flatMap((a) => walk(join(root, a.dir), a.ext));
const known = new Set(paths.map(rel));
const text = new Map(paths.map((p) => [rel(p), OPAQUE.has(rel(p)) ? "" : readFileSync(p, "utf8").replace(/\r\n/g, "\n")]));
const lineCount = new Map(paths.map((p) => [rel(p), readFileSync(p, "utf8").split("\n").length]));

// Every event type the code knows: the EventType union plus anything appended by name.
const EVENT = /["`]([a-z][a-z0-9]*(?:\.[a-z][a-z0-9_-]*){1,3})["`]/g;
const WRITE = /(?:append|emit)\(\s*["`]([a-z][a-z0-9]*(?:\.[a-z][a-z0-9_-]*){1,3})["`]/g;
const events = new Set();
const union = text.get("packages/core/src/events.ts")?.match(/export type EventType =([\s\S]*?);/)?.[1] ?? "";
for (const m of union.matchAll(EVENT)) events.add(m[1]);
for (const [f, t] of text) if (f.startsWith("packages/core/src/")) for (const m of t.matchAll(WRITE)) events.add(m[1]);

// Every table the core creates.
const CREATE = /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
const tables = new Set();
for (const t of text.values()) for (const m of t.matchAll(CREATE)) tables.add(m[1]);

function resolveImport(from, spec) {
  if (!spec.startsWith(".")) return null;
  const base = join(dirname(from), spec).split(sep).join("/").replace(/\.js$/, "");
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`, `${base}.css`]) if (known.has(c)) return c;
  return null;
}

const uniq = (xs) => [...new Set(xs)].sort();
const files = {};
for (const [f, t] of text) {
  const core = f.startsWith("packages/core/src/");
  const imports = uniq([...t.matchAll(/(?:from\s+|import\s*\(\s*|^import\s+)["']([^"']+)["']/gm)].map((m) => resolveImport(f, m[1])).filter(Boolean));
  const writes = core ? uniq([...t.matchAll(WRITE)].map((m) => m[1])) : [];
  // The union in events.ts lists every type; that is a declaration, not a reader.
  const reads = f === "packages/core/src/events.ts" ? [] : uniq([
    ...[...t.matchAll(EVENT)].map((m) => m[1]).filter((e) => events.has(e) && !writes.includes(e)),
    ...[...t.matchAll(/startsWith\(\s*["`]([a-z][a-z0-9]*(?:\.[a-z][a-z0-9_-]*)*\.)["`]/g)].map((m) => `${m[1]}*`),
  ]);
  const areas = uniq([...t.matchAll(/["`/}](\/api\/[a-z][a-z0-9-]*)/g)].map((m) => m[1]));
  const creates = uniq([...t.matchAll(CREATE)].map((m) => m[1]));
  const sql = uniq([...t.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_][a-z0-9_]*)/g)].map((m) => m[1]).filter((n) => tables.has(n) && !creates.includes(n)));
  files[f] = {
    lines: lineCount.get(f),
    ...(imports.length ? { imports } : {}),
    ...(writes.length ? { writes } : {}),
    ...(reads.length ? { reads } : {}),
    ...(areas.length ? (core ? { serves: areas } : { calls: areas }) : {}),
    ...(creates.length ? { creates } : {}),
    ...(sql.length ? { sql } : {}),
  };
}

const body = `// Generated from the code by packages/core/scripts/wiring.mjs. Do not edit: run \`npm run wiring -w @sf/core\`.
export interface FileWiring {
  lines: number;
  /** Source files this one imports. */
  imports?: string[];
  /** Event types it appends to the log. */
  writes?: string[];
  /** Event types it names without writing them (it reads or reacts to them); "x.*" is a prefix. */
  reads?: string[];
  /** API areas a core file answers. */
  serves?: string[];
  /** API areas a Bridge file calls. */
  calls?: string[];
  /** Tables it creates. */
  creates?: string[];
  /** Tables it queries but another file creates. */
  sql?: string[];
}
export const WIRING: { events: string[]; tables: string[]; files: Record<string, FileWiring> } = ${JSON.stringify({ events: [...events].sort(), tables: [...tables].sort(), files }, null, 1)};
`;
if (process.argv.includes("--print")) process.stdout.write(body);
else {
  writeFileSync(join(root, OUT), body);
  console.log(`wiring.generated.ts: ${Object.keys(files).length} files, ${events.size} events, ${tables.size} tables`);
}
