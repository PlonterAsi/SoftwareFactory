import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { RunProfile } from "./detect.js";

/**
 * How to use a command-line tool without knowing its arguments: what it does,
 * ready-made example runs, and a form for its options. Read from the tool's
 * own words only (SPEC.md the factory writes, README, the usage text in its
 * source); nothing is run to find out.
 */
export type FieldType = "folder" | "file" | "number" | "text";

export interface UsageField {
  /** "pos:0" for the first positional, "--apply" for an option. */
  id: string;
  label: string;
  kind: "positional" | "flag" | "option";
  type: FieldType | "switch";
  required: boolean;
  /** The flag as typed ("--apply", "-n"). */
  flag?: string;
  /** Files from the project that fit here (test fixtures, samples). */
  suggestions?: string[];
  /** Filled in when the form opens. */
  default?: string;
  hint?: string;
}

export interface UsageExample { label: string; argv: string[]; stdin?: string; note?: string }

export interface Usage {
  /** What it does, in a sentence or two. */
  summary: string | null;
  /** The usage line it was read from, as written. */
  synopsis: string | null;
  fields: UsageField[];
  examples: UsageExample[];
  /** It reads text from its input when no file is given. */
  readsStdin: boolean;
  /** Where this came from: spec, readme, source. */
  sources: string[];
}

const read = (p: string, max = 200_000) => { try { const s = statSync(p); return s.isFile() && s.size <= max ? readFileSync(p, "utf8") : ""; } catch { return ""; } };
const list = (d: string) => { try { return readdirSync(d); } catch { return [] as string[]; } };
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** A token of a usage line: `<dir>`, `[--apply]`, `[--top <n>]`, `[file]`, `-n N`. */
export function parseSynopsis(line: string): UsageField[] {
  const fields: UsageField[] = [];
  // Group bracketed parts, keep the rest as single tokens.
  const parts = line.match(/\[[^\]]*\]|<[^>]*>|"[^"]*"|\S+/g) ?? [];
  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    let t = parts[i];
    const optional = t.startsWith("[");
    if (optional) t = t.slice(1, -1).trim();
    if (!t || t === "..." || t === "|" || /^options?$/i.test(t.replace(/[<>]/g, ""))) continue;
    const flagM = t.match(/^(--?[A-Za-z][\w-]*)(?:[ =](.+))?$/);
    if (flagM) {
      let value = flagM[2];
      // `--top <n>` written as two tokens outside brackets.
      if (!value && !optional && parts[i + 1] && /^<[^>]+>$/.test(parts[i + 1])) value = parts[++i];
      const name = flagM[1].replace(/^-+/, "");
      if (/^(h|help|v|version)$/.test(name)) continue;
      const vname = value ? value.replace(/[<>[\]]/g, "").trim() : "";
      fields.push({
        id: flagM[1], flag: flagM[1], label: name.replace(/-/g, " "),
        kind: value ? "option" : "flag", type: value ? typeOf(vname || name) : "switch",
        required: !optional && !!value, hint: vname || undefined,
      });
      continue;
    }
    const posM = t.match(/^<?([A-Za-z][\w .-]*?)>?(\.\.\.)?$/);
    if (posM && (t.startsWith("<") || optional)) {
      const name = posM[1].trim();
      fields.push({ id: `pos:${pos++}`, label: name.replace(/[-_]/g, " "), kind: "positional", type: typeOf(name), required: !optional, hint: posM[2] ? "one or more" : undefined });
    }
  }
  return fields;
}

function typeOf(name: string): FieldType {
  const n = name.toLowerCase();
  if (/\b(dir|dirs|directory|folder|root)\b|dir$|folder$/.test(n)) return "folder";
  if (/\b(file|path|csv|json|txt|input|output|image|photo|log|md)\b|file$|path$/.test(n)) return "file";
  if (/^(n|num|count|top|limit|max|min|port|size|days|lines|width|height)$|number|count$/.test(n)) return "number";
  return "text";
}

/** Split a command line the way a shell would (quotes group). */
function argvOf(s: string): string[] {
  return (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((a) => a.replace(/^["']|["']$/g, ""));
}

/**
 * Read a tool's usage. `profile` is a cli profile from detectProfiles; its
 * command (`node bin/wc.js`) tells which names count as calling it.
 */
export function readUsage(dir: string, profile: RunProfile): Usage {
  const sources: string[] = [];
  const file = profile.exec && "file" in profile.exec ? profile.exec.args[0] : null;
  const binName = profile.label;
  const fileBase = file ? basename(file).replace(/\.(c|m)?js$/, "") : binName;
  const names = [...new Set([binName, fileBase, file, file && `./${file}`, file && `node ${file}`, file && `node ./${file}`].filter(Boolean) as string[])];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const callRe = new RegExp(`^\\s*(?:\\$\\s*)?(?:npx\\s+)?(?:${names.sort((a, b) => b.length - a.length).map(esc).join("|")})(?=\\s|$)(.*)$`);

  const spec = read(join(dir, "SPEC.md"));
  const readme = read(join(dir, "README.md")) || read(join(dir, "readme.md"));
  const src = file ? read(join(dir, file)) : "";

  // ---- what it does ----
  let summary: string | null = null;
  if (spec) {
    const after = spec.split("\n## ")[0].split("\n").filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith(">"));
    if (after[0]) { summary = after[0].trim(); sources.push("spec"); }
  }
  if (!summary && readme) {
    const p = readme.split("\n").find((l) => l.trim() && !/^(#|!\[|\s{4}|```|\||<)/.test(l));
    if (p) { summary = p.trim().replace(/`/g, ""); sources.push("readme"); }
  }

  // ---- the usage line ----
  const candidates: { line: string; from: string }[] = [];
  const srcUsage = src.match(/usage:\s*([^'"`\n\\]+)/i);
  if (srcUsage) candidates.push({ line: srcUsage[1], from: "source" });
  for (const l of spec.split("\n")) {
    const m = l.match(/CLI:?\s*(.+?)(?:\.\s+[A-Z]|$)/);
    if (m && (l.includes(fileBase) || l.includes(binName))) candidates.push({ line: m[1], from: "spec" });
  }
  for (const l of readme.split("\n")) {
    const m = l.match(/usage:?\s*`?([^`]+)`?/i);
    if (m) candidates.push({ line: m[1], from: "readme" });
  }
  // Command lines in the README and spec that use placeholders are usage lines too.
  const commandLines = [...readme.split("\n"), ...spec.split("\n")].map((l) => l.replace(/^\s*[-*]\s+/, "").replace(/^`|`$/g, ""));
  for (const l of commandLines) {
    if (/CLI:/.test(l)) continue;
    const m = l.split(/\s+#/)[0].match(callRe);
    const rest = m?.[1].split(/\.\s/)[0] ?? "";
    if (m && rest.length < 160 && /<[^>]+>|\[[^\]]+\]/.test(rest)) candidates.push({ line: `${fileBase}${rest}`, from: "readme" });
  }
  let synopsis: string | null = null;
  let fields: UsageField[] = [];
  // The tool's own usage text first, then the spec, then the README: the first that names any input wins.
  for (const c of candidates) {
    const body = c.line.trim().replace(new RegExp(`^(?:node\\s+)?(?:\\./)?(?:${names.map(esc).join("|")})\\s*`), "");
    const f = parseSynopsis(body).filter((x, i, all) => all.findIndex((y) => y.id === x.id) === i);
    if (!f.length) continue;
    synopsis = c.line.trim();
    fields = f;
    if (!sources.includes(c.from)) sources.push(c.from);
    break;
  }
  // No usage written down: a tool that reads process.argv[2] takes one input, most likely a file.
  if (!fields.length && /process\.argv\[2\]/.test(src)) {
    fields = [{ id: "pos:0", label: "file", kind: "positional", type: "file", required: !/process\.argv\[2\]\s*(\?\?|\|\|)/.test(src), hint: "leave empty to type text instead" }];
    if (!sources.includes("source")) sources.push("source");
  }

  // ---- examples: the project's own run.json first (the factory writes it), then its README ----
  const examples: UsageExample[] = runJsonExamples(dir, profile);
  const own = runJson(dir);
  if (own?.summary && typeof own.summary === "string") { summary = own.summary.slice(0, 400); if (!sources.includes("run.json")) sources.unshift("run.json"); }
  if (examples.length && !sources.includes("run.json")) sources.unshift("run.json");
  const lines = readme.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/^\s*[-*]\s+/, "").replace(/^`|`$/g, "");
    const [cmd, comment] = raw.split(/\s+#\s*/);
    const m = cmd.match(callRe);
    if (!m || /<[^>]+>|\[[^\]]+\]|\.\.\./.test(m[1])) continue;
    const argv = argvOf(m[1].trim());
    if (argv.some((a) => /^(-h|--help|--version)$/.test(a))) continue;
    const prev = lines.slice(Math.max(0, i - 3), i).reverse().find((l) => l.trim() && !/^\s*(```|\s{4})/.test(l));
    const label = comment?.trim() || (prev && prev.trim().length < 90 ? prev.trim().replace(/[:#*`]/g, "").trim() : "") || (argv.join(" ") || "Run it");
    if (!examples.some((e) => e.argv.join("\0") === argv.join("\0"))) examples.push({ label: label.slice(0, 80), argv });
  }

  // ---- reads text from its input ----
  const readsStdin = /readFileSync\([^)]*(\?\?|\|\||,|\()\s*0\s*[,)]|readFileSync\(\s*["']\/dev\/stdin["']|process\.stdin/.test(src)
    || (file ? srcImportsStdin(dir, src) : false);

  // ---- files from the project that fit file and folder fields ----
  const samples = sampleFiles(dir);
  const sampleDirs = ["test/fixtures", "fixtures", "examples", "samples", "sample", "data"].filter((d) => isDir(join(dir, d)));
  for (const f of fields) {
    if (f.type === "file") {
      const ext = f.hint && /\.(\w+)$/.test(f.hint) ? f.hint.match(/\.(\w+)$/)![1] : f.label.match(/\b(csv|json|txt|md|log)\b/i)?.[1];
      const fit = ext ? samples.filter((s) => s.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) : samples;
      f.suggestions = (fit.length ? fit : samples).slice(0, 8).map((s) => join(dir, s));
    } else if (f.type === "folder") {
      f.suggestions = sampleDirs.map((d) => join(dir, d)).slice(0, 6);
    }
  }

  // A sample run when no example passes arguments: fill the fields from files the project ships.
  if (!examples.some((e) => e.argv.length) && fields.length) {
    const argv: string[] = [];
    let ok = true;
    const used: string[] = [];
    for (const f of fields.filter((x) => x.required || ((x.type === "file" || x.type === "folder") && x.suggestions?.length))) {
      const v = f.suggestions?.[0];
      if (!v) { ok = false; break; }
      used.push(basename(v));
      if (f.kind === "option") argv.push(f.flag!, v); else argv.push(v);
    }
    if (ok && argv.length) examples.push({ label: `Try it on ${used.join(", ")} from the project`, argv });
  }
  if (readsStdin && !examples.some((e) => e.stdin)) {
    const text = summary ? `${summary}\nThis is a short sample text typed into the tool from SoftwareFactory.` : "This is a short sample text typed into the tool from SoftwareFactory.";
    examples.push({ label: "Try it on a sample text", argv: [], stdin: text });
  }
  if (!fields.length && !examples.length && !readsStdin) examples.push({ label: "Run it", argv: [] });
  return { summary, synopsis, fields, examples, readsStdin, sources };
}

/** The bin file reads stdin, or the module it hands its input to does (one level). */
function srcImportsStdin(dir: string, src: string): boolean {
  for (const m of src.matchAll(/from\s+["'](\.\.?\/[^"']+)["']/g)) {
    const rel = m[1].replace(/^\.\.\//, "").replace(/^\.\//, "bin/");
    if (/readFileSync\(\s*0|process\.stdin/.test(read(join(dir, rel)))) return true;
  }
  return false;
}

/** Small data files a project ships (fixtures, samples, examples), relative paths. */
export function sampleFiles(dir: string): string[] {
  const out: string[] = [];
  for (const d of ["test/fixtures", "fixtures", "examples", "samples", "sample", "data", "test/data"]) {
    for (const n of list(join(dir, d))) {
      const rel = `${d}/${n}`;
      try { const st = statSync(join(dir, rel)); if (st.isFile() && st.size < 5_000_000) out.push(rel); } catch { /* gone */ }
    }
  }
  for (const n of list(dir)) if (/\.(csv|json|txt|md|log|tsv|xml|yaml|yml)$/i.test(n) && !/^(package(-lock)?\.json|tsconfig.*\.json)$/i.test(n)) out.push(n);
  return out.slice(0, 40);
}

/** run.json at the project root: {"summary"?, "examples": [{label, profile?, args?, argv?, input?}]}. */
function runJson(dir: string): Record<string, any> | null {
  const t = read(join(dir, "run.json"), 100_000);
  if (!t) return null;
  try { const j = JSON.parse(t); return j && typeof j === "object" ? j : null; } catch { return null; }
}

/** The examples in run.json that belong to this profile (by id or kind; none given means any cli). */
export function runJsonExamples(dir: string, profile: RunProfile): UsageExample[] {
  const j = runJson(dir);
  if (!Array.isArray(j?.examples)) return [];
  const out: UsageExample[] = [];
  for (const e of j!.examples.slice(0, 20)) {
    if (!e || typeof e !== "object") continue;
    const want = typeof e.profile === "string" ? e.profile : null;
    if (want && want !== profile.id && want !== profile.kind && want !== profile.label) continue;
    const argv = Array.isArray(e.argv) ? e.argv.map(String) : typeof e.args === "string" ? argvOf(e.args) : [];
    out.push({ label: String(e.label ?? (argv.join(" ") || "Run it")).slice(0, 80), argv, stdin: typeof e.input === "string" ? e.input : undefined, note: typeof e.note === "string" ? e.note : undefined });
  }
  return out;
}
