import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { resolveInside } from "./static.js";

/**
 * The data files a project reads and writes (tables, JSON, text), so you can
 * see and edit them in the app instead of writing raw files by hand, and so a
 * tool that needs an input file gets a sample one made for it.
 */
export type DataKind = "table" | "json" | "text";
export interface DataFile { path: string; kind: DataKind; bytes: number; modified: string; role: "sample" | "data" | "fixture" | "doc" | "file"; note?: string }

const DATA_EXT: Record<string, DataKind> = { ".csv": "table", ".tsv": "table", ".json": "json", ".txt": "text", ".md": "text", ".log": "text", ".yaml": "text", ".yml": "text", ".xml": "text", ".ini": "text", ".env.example": "text" };
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", "out", "web", "src", "bin", "lib"]);
const SKIP_FILES = /^(package(-lock)?\.json|tsconfig.*\.json|jsconfig\.json|run\.json|\.eslintrc.*|\.prettierrc.*|LICENSE.*|CHANGELOG\.md)$/i;
export const MAX_DATA_BYTES = 2_000_000;

export const kindOf = (p: string): DataKind | null => DATA_EXT[extname(p).toLowerCase()] ?? null;
const posix = (root: string, abs: string) => relative(root, abs).split(sep).join("/");

/** Every data file in the project (two folders deep), samples and data first. */
export function listDataFiles(dir: string): DataFile[] {
  const out: DataFile[] = [];
  const walk = (d: string, depth: number) => {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const abs = join(d, n);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        if (depth < 2 && !SKIP_DIRS.has(n) && !n.startsWith(".")) walk(abs, depth + 1);
        continue;
      }
      const kind = kindOf(n);
      if (!kind || SKIP_FILES.test(n) || st.size > MAX_DATA_BYTES) continue;
      const rel = posix(dir, abs);
      const top = rel.split("/")[0];
      const role: DataFile["role"] = top === "samples" ? "sample" : top === "data" ? "data" : rel.startsWith("test/") || top === "fixtures" ? "fixture" : /\.(md|txt)$/i.test(n) && rel.split("/").length === 1 ? "doc" : "file";
      out.push({ path: rel, kind, bytes: st.size, modified: st.mtime.toISOString(), role, note: rel === "data/db.json" ? "The app's own data store" : undefined });
    }
  };
  walk(dir, 0);
  const order = { sample: 0, data: 1, file: 2, fixture: 3, doc: 4 };
  return out.sort((a, b) => order[a.role] - order[b.role] || a.path.localeCompare(b.path)).slice(0, 300);
}

function inside(dir: string, rel: string): string {
  const abs = resolveInside(dir, "/" + String(rel ?? "").replace(/\\/g, "/"));
  if (!abs || abs === dir) throw new Error(`Refused path "${rel}"`);
  if (/(^|\/)(node_modules|\.git)(\/|$)/.test(rel)) throw new Error(`Refused path "${rel}"`);
  return abs;
}

export function readDataFile(dir: string, rel: string): { path: string; kind: DataKind; content: string; bytes: number } {
  const abs = inside(dir, rel);
  const st = statSync(abs);
  if (!st.isFile()) throw new Error(`${rel} is not a file`);
  if (st.size > MAX_DATA_BYTES) throw new Error(`${rel} is too big to edit here (${Math.round(st.size / 1024)} KB)`);
  return { path: rel, kind: kindOf(rel) ?? "text", content: readFileSync(abs, "utf8"), bytes: st.size };
}

/** Save a data file. JSON must parse, so a slip in the editor can never break the app's data. */
export function writeDataFile(dir: string, rel: string, content: string, opts: { create?: boolean } = {}) {
  const kind = kindOf(rel);
  if (!kind) throw new Error("Only data files (.csv, .tsv, .json, .txt, .md, .yaml, ...) can be edited here");
  const abs = inside(dir, rel);
  if (opts.create && existsSync(abs)) throw new Error(`${rel} already exists`);
  if (Buffer.byteLength(content) > MAX_DATA_BYTES) throw new Error("That is too big to save here");
  if (kind === "json") { try { JSON.parse(content); } catch (e) { throw new Error(`Not valid JSON: ${(e as Error).message}`); } }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return { path: rel, bytes: Buffer.byteLength(content) };
}

export function deleteDataFile(dir: string, rel: string) {
  if (!kindOf(rel)) throw new Error("Only data files can be deleted here");
  unlinkSync(inside(dir, rel));
}

export function renameDataFile(dir: string, from: string, to: string) {
  if (!kindOf(from) || !kindOf(to)) throw new Error("Only data files can be renamed here");
  const a = inside(dir, from), b = inside(dir, to);
  if (existsSync(b)) throw new Error(`${to} already exists`);
  mkdirSync(dirname(b), { recursive: true });
  renameSync(a, b);
}

// ---------------------------------------------------------------- samples

export interface SampleGuess { path: string; kind: DataKind; content: string; from: string }

/** CSV-looking text: at least a header and one row, the same number of commas (or tabs) on each line. */
export function looksLikeTable(text: string): boolean {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return false;
  const sepCh = lines[0].includes("\t") ? "\t" : ",";
  const n = lines[0].split(sepCh).length;
  if (n < 2 || !/[A-Za-z]/.test(lines[0])) return false;
  return lines.every((l) => Math.abs(l.split(sepCh).length - n) <= 0 || /"/.test(l));
}

/**
 * Sample inputs a project's own tests already use: CSV or JSON written inline in test/*.js
 * (string and template literals). The tests passed against this data, so it is known good.
 */
export function samplesFromTests(dir: string): SampleGuess[] {
  const out: SampleGuess[] = [];
  const files: string[] = [];
  for (const d of ["test", "tests", "__tests__"]) {
    try { for (const n of readdirSync(join(dir, d))) if (/\.(c|m)?[jt]s$/.test(n)) files.push(join(d, n)); } catch { /* none */ }
  }
  for (const f of files) {
    let src = "";
    try { src = readFileSync(join(dir, f), "utf8"); } catch { continue; }
    // Template literals without ${...}, and "a,b\n1,2" strings, and [..].join("\n") of quoted lines.
    const lits: string[] = [];
    for (const m of src.matchAll(/`([^`$]{8,4000})`/g)) lits.push(m[1]);
    for (const m of src.matchAll(/(["'])((?:(?!\1)[^\\\n]|\\.){8,4000}?)\1/g)) if (m[2].includes("\\n")) lits.push(m[2].replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\(["'\\])/g, "$1"));
    for (const m of src.matchAll(/\[((?:\s*(["'])[^"'\n]*\2\s*,?)+)\]\s*\.join\(\s*(["'])\\n\3\s*\)/g)) lits.push([...m[1].matchAll(/(["'])([^"'\n]*)\1/g)].map((x) => x[2]).join("\n"));
    for (const lit of lits) {
      const t = lit.replace(/^\n+/, "");
      if (looksLikeTable(t)) {
        const header = t.split(/\r?\n/)[0];
        const name = header.split(/[,\t]/).slice(0, 2).map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")).filter(Boolean).join("-") || "table";
        const ext = header.includes("\t") ? "tsv" : "csv";
        if (!out.some((o) => o.content.trim() === t.trim())) out.push({ path: `samples/${name}.${ext}`, kind: "table", content: t.trim() + "\n", from: f });
        continue;
      }
      const j = t.trim();
      if ((j.startsWith("{") || j.startsWith("[")) && j.length > 10) {
        try {
          const v = JSON.parse(j);
          if (v && typeof v === "object" && !out.some((o) => o.content === JSON.stringify(v, null, 2) + "\n")) out.push({ path: `samples/sample-${out.filter((o) => o.kind === "json").length + 1}.json`, kind: "json", content: JSON.stringify(v, null, 2) + "\n", from: f });
        } catch { /* not JSON */ }
      }
    }
  }
  // Longest first: the richest example makes the best sample.
  return out.sort((a, b) => b.content.length - a.content.length).slice(0, 6);
}

/** CSV and JSON written out in the project's SPEC.md or README.md (```csv / ```json blocks). */
export function samplesFromDocs(dir: string): SampleGuess[] {
  const out: SampleGuess[] = [];
  for (const doc of ["SPEC.md", "README.md", "docs/README.md"]) {
    let text = "";
    try { text = readFileSync(join(dir, doc), "utf8"); } catch { continue; }
    for (const m of text.matchAll(/```(\w*)[^\n]*\n([\s\S]*?)```/g)) {
      const lang = m[1].toLowerCase(), body = m[2].trim();
      if (!body || body.length > 200_000) continue;
      if ((lang === "csv" || lang === "tsv" || (!lang && looksLikeTable(body))) && looksLikeTable(body)) {
        const header = body.split(/\r?\n/)[0];
        const name = header.split(/[,\t]/).slice(0, 2).map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")).filter(Boolean).join("-") || "table";
        if (!out.some((o) => o.content.trim() === body)) out.push({ path: `samples/${name}.${header.includes("\t") ? "tsv" : "csv"}`, kind: "table", content: body + "\n", from: doc });
      } else if (lang === "json" || ((body.startsWith("{") || body.startsWith("[")) && !lang)) {
        try {
          const v = JSON.parse(body);
          if (v && typeof v === "object") { const c = JSON.stringify(v, null, 2) + "\n"; if (!out.some((o) => o.content === c)) out.push({ path: `samples/example-${out.filter((o) => o.kind === "json").length + 1}.json`, kind: "json", content: c, from: doc }); }
        } catch { /* a sketch, not real JSON */ }
      }
    }
  }
  return out.slice(0, 6);
}

/** Columns the spec names for a CSV ("columns date, category, amount" or a header in backticks). */
export function columnsFromSpec(text: string): string[] | null {
  const tick = [...text.matchAll(/`([A-Za-z_][\w ]*(?:,\s*[A-Za-z_][\w ]*){1,15})`/g)].map((m) => m[1]);
  if (tick.length) return tick.sort((a, b) => b.length - a.length)[0].split(",").map((s) => s.trim());
  const m = text.match(/(?:columns?|headers?|fields?)\s*(?:are|:|named|called)?\s*\(?((?:[A-Za-z_]\w*\s*(?:,|and)\s*){1,15}[A-Za-z_]\w*)/i);
  return m ? m[1].split(/\s*(?:,|and)\s*/).map((s) => s.trim()).filter(Boolean) : null;
}

const WORDS = { category: ["food", "transport", "rent", "fun", "health", "books"], name: ["Dana", "Yoni", "Maya", "Eli", "Noa", "Avi"], city: ["Tel Aviv", "Haifa", "Eilat", "Jerusalem"], status: ["open", "done", "waiting"] };
/** A value that fits a column name. */
function valueFor(col: string, i: number): string {
  const c = col.toLowerCase();
  if (/date|day|when|time/.test(c)) { const d = new Date(Date.UTC(2024, 2, 1 + i * 3)); return /time/.test(c) && !/date/.test(c) ? `${String(8 + i).padStart(2, "0")}:30` : d.toISOString().slice(0, 10); }
  if (/month/.test(c)) return `2024-0${1 + (i % 3)}`;
  if (/amount|price|cost|total|sum|value|usd|eur|ils|salary/.test(c)) return (12.5 + ((i * 37) % 180)).toFixed(2);
  if (/qty|quantity|count|number|num|age|score|hours|minutes|n$/.test(c)) return String(1 + ((i * 7) % 20));
  if (/email/.test(c)) return `${WORDS.name[i % 6].toLowerCase()}@example.com`;
  if (/^id$|_id$|id$/.test(c)) return String(i + 1);
  if (/categor|type|kind|group|tag/.test(c)) return WORDS.category[i % 6];
  if (/name|who|person|owner|author/.test(c)) return WORDS.name[i % 6];
  if (/city|place|location/.test(c)) return WORDS.city[i % 4];
  if (/status|state/.test(c)) return WORDS.status[i % 3];
  if (/done|active|enabled|paid|is_/.test(c)) return i % 2 ? "true" : "false";
  if (/desc|note|title|text|comment|memo/.test(c)) return ["Coffee and a bagel", "Bus to work", "Monthly rent", "Cinema", "Pharmacy", "A good book"][i % 6];
  return `${col} ${i + 1}`;
}

export function makeTable(columns: string[], rows = 8): string {
  return [columns.join(","), ...Array.from({ length: rows }, (_, i) => columns.map((c) => { const v = valueFor(c, i); return /[,"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }).join(","))].join("\n") + "\n";
}

/**
 * Make sample input files for a project that has none: first what its tests use,
 * then a table with the columns its spec names. Writes them under samples/ and
 * returns what was written (nothing is overwritten).
 */
export function makeSamples(dir: string, opts: { want?: "table" | "json" | "text" } = {}): SampleGuess[] {
  const made: SampleGuess[] = [];
  const write = (g: SampleGuess) => {
    let p = g.path;
    for (let n = 2; existsSync(join(dir, p)); n++) p = g.path.replace(/(\.\w+)$/, `-${n}$1`);
    writeDataFile(dir, p, g.content, { create: true });
    made.push({ ...g, path: p });
  };
  const known = [...samplesFromTests(dir), ...samplesFromDocs(dir)].filter((g) => !opts.want || g.kind === opts.want);
  const seen = new Set<string>();
  for (const g of known) { if (made.length >= 3 || seen.has(g.content.trim())) continue; seen.add(g.content.trim()); write(g); }
  if (!made.some((m) => m.kind === "table") && opts.want !== "json" && opts.want !== "text") {
    let spec = "";
    try { spec = readFileSync(join(dir, "SPEC.md"), "utf8"); } catch { /* none */ }
    try { spec += "\n" + readFileSync(join(dir, "README.md"), "utf8"); } catch { /* none */ }
    const cols = /csv|table|spreadsheet|columns?/i.test(spec) ? columnsFromSpec(spec) : null;
    if (cols && cols.length >= 2) write({ path: `samples/${cols.slice(0, 2).join("-").toLowerCase().replace(/[^a-z0-9-]+/g, "-")}.csv`, kind: "table", content: makeTable(cols), from: "SPEC.md" });
  }
  if (!made.length && opts.want === "text") write({ path: "samples/sample.txt", kind: "text", content: "The quick brown fox jumps over the lazy dog.\nA second line, for tools that count lines.\n", from: "SoftwareFactory" });
  return made;
}
