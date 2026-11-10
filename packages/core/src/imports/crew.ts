import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonBlock } from "../factory/workspace.js";
import type { CodeMap, CodeModule, HealthFlag } from "./scan.js";

/**
 * What the Cartographer and the Surveyor are given, what they must answer,
 * and the free heuristic stand-ins the practice crew (or a failed call) uses.
 * The agents only ever see text digests; they get no tools, so exploring can
 * never change the imported repo.
 */
export const ROLES = ["ui", "core", "api", "data", "cli", "test", "config", "build", "docs", "other"] as const;
export type ModuleRole = (typeof ROLES)[number];
export interface ModuleNote { id: string; purpose: string; role: ModuleRole; risks: string[] }

export const LENSES = ["tests", "reliability", "security", "structure", "docs", "performance", "dx"] as const;
export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];
export interface Suggestion {
  title: string;
  body: string;
  kind: "fix" | "improvement";
  lens: string;
  severity: Severity;
  effort: "small" | "medium" | "large";
  files: string[];
}

const CODE_LANGS = new Set(["TypeScript", "JavaScript", "Python", "Rust", "Go", "Java", "Kotlin", "C#", "C++", "C", "Ruby", "PHP", "Swift", "Dart", "Scala", "Lua", "Shell", "PowerShell", "SQL", "Vue", "Svelte", "HTML", "CSS"]);
/** Modules worth an agent's attention: code, and not empty. */
export const isCodeModule = (m: CodeModule) => CODE_LANGS.has(m.lang) && m.lines > 0;

/** A module digest: enough to say what it is for, small enough to stay cheap. */
export function moduleDigest(root: string, m: CodeModule, headLines = 40, maxChars = 2600): string {
  const parts = [`## module: ${m.id}`, `${m.lang}, ${m.files} files, ${m.lines} lines${m.pkg ? `, package ${m.pkg}` : ""}${m.tests ? `, ${m.tests} test files` : ""}${m.entry ? ", has an entry point" : ""}.`];
  if (m.exports.length) parts.push(`Exports: ${m.exports.join(", ")}`);
  if (m.top.length) parts.push(`Key files: ${m.top.join(", ")}`);
  for (const f of m.top.slice(0, 2)) {
    let head = "";
    try { head = readFileSync(join(root, f), "utf8").split("\n").slice(0, headLines).join("\n"); } catch { /* gone */ }
    if (head) parts.push(`--- start of ${f} ---\n${head}`);
  }
  const out = parts.join("\n");
  return out.length > maxChars ? out.slice(0, maxChars) + "\n[...]" : out;
}

/** Group digests into calls of a few modules each. */
export function batchDigests(digests: { id: string; text: string }[], maxChars = 9000, maxModules = 5): { id: string; text: string }[][] {
  const out: { id: string; text: string }[][] = [];
  let cur: { id: string; text: string }[] = [];
  let size = 0;
  for (const d of digests) {
    if (cur.length && (size + d.text.length > maxChars || cur.length >= maxModules)) { out.push(cur); cur = []; size = 0; }
    cur.push(d);
    size += d.text.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

export function mapPrompt(repo: string, batch: { id: string; text: string }[]): string {
  return `Repo: ${repo}\nModules to map (${batch.length}):\n\n${batch.map((b) => b.text).join("\n\n")}`;
}

export function parseModuleNotes(text: string): ModuleNote[] | null {
  try {
    const j = parseJsonBlock<{ modules?: unknown }>(text);
    if (!Array.isArray(j?.modules)) return null;
    const out = (j.modules as Record<string, unknown>[]).filter((m) => m && typeof m.id === "string" && typeof m.purpose === "string").map((m) => ({
      id: String(m.id),
      purpose: String(m.purpose).replace(/\s+/g, " ").trim().slice(0, 240),
      role: (ROLES as readonly string[]).includes(String(m.role)) ? (m.role as ModuleRole) : "other",
      risks: (Array.isArray(m.risks) ? m.risks : []).map((r) => String(r).slice(0, 160)).slice(0, 2),
    }));
    return out.length ? out : null;
  } catch { return null; }
}

/** The whole map in plain text: what the Surveyor (and the Council's lenses) read. */
export function mapText(map: CodeMap, notes: Map<string, { purpose: string; role: string; risks: string[] }>, maxChars = 7000): string {
  const lines: string[] = [];
  lines.push(`${map.files} files, ${map.lines} lines. Languages: ${map.languages.filter((l) => l.lines > 0).slice(0, 6).map((l) => `${l.lang} ${l.lines}`).join(", ")}.`);
  lines.push(`Health ${map.health.score}/100. Flags: ${map.health.flags.length ? map.health.flags.map((f) => `[${f.level}] ${f.text}${f.files?.length ? ` (${f.files.slice(0, 4).join(", ")})` : ""}`).join("; ") : "none"}.`);
  lines.push(`Tests: ${map.tests.files} files${map.tests.command ? `, run with ${map.tests.command}` : ", no test command"}${map.tests.frameworks.length ? `, ${map.tests.frameworks.join(", ")}` : ""}.`);
  if (map.entryPoints.length) lines.push(`Entry points: ${map.entryPoints.slice(0, 8).map((e) => `${e.path} (${e.why})`).join("; ")}.`);
  lines.push("Modules:");
  for (const m of map.modules.filter(isCodeModule).slice(0, 30)) {
    const n = notes.get(m.id);
    lines.push(`- ${m.id} [${m.lang}, ${m.lines} lines, ${m.tests ? `${m.tests} tests` : m.testedBy ? "tested from elsewhere" : "no tests"}${m.todos ? `, ${m.todos} TODOs` : ""}]${n ? ` ${n.role}: ${n.purpose}${n.risks.length ? ` Risks: ${n.risks.join("; ")}` : ""}` : ""}`);
  }
  const deps = map.edges.slice(0, 25).map((e) => `${e.from} -> ${e.to}`);
  if (deps.length) lines.push(`Depends on: ${deps.join(", ")}.`);
  if (map.largest.length) lines.push(`Largest files: ${map.largest.slice(0, 8).map((f) => `${f.path} (${f.lines})`).join(", ")}.`);
  if (map.todos.length) lines.push(`TODOs: ${map.todos.slice(0, 8).map((t) => `${t.path}:${t.line} ${t.text}`).join(" | ")}`);
  const ext = [...new Set(map.dependencies.filter((d) => !d.dev).map((d) => d.name))];
  if (ext.length) lines.push(`External packages (${ext.length}): ${ext.slice(0, 25).join(", ")}.`);
  const out = lines.join("\n");
  return out.length > maxChars ? out.slice(0, maxChars) + "\n[...]" : out;
}

export function surveyPrompt(repo: string, text: string): string {
  return `Repo: ${repo}\nCode map:\n${text}`;
}

export function parseSuggestions(text: string): Suggestion[] | null {
  try {
    const j = parseJsonBlock<{ suggestions?: unknown }>(text);
    if (!Array.isArray(j?.suggestions)) return null;
    const out = (j.suggestions as Record<string, unknown>[]).filter((s) => s && typeof s.title === "string" && String(s.title).trim()).slice(0, 8).map((s) => ({
      title: String(s.title).replace(/\s+/g, " ").trim().slice(0, 120),
      body: String(s.body ?? "").trim().slice(0, 1200),
      kind: s.kind === "fix" ? "fix" as const : "improvement" as const,
      lens: (LENSES as readonly string[]).includes(String(s.lens)) ? String(s.lens) : "structure",
      severity: (SEVERITIES as readonly string[]).includes(String(s.severity)) ? (s.severity as Severity) : "medium",
      effort: (s.effort === "small" || s.effort === "large" ? s.effort : "medium") as Suggestion["effort"],
      files: (Array.isArray(s.files) ? s.files : []).map(String).slice(0, 10),
    }));
    return out.length ? out : null;
  } catch { return null; }
}

/** The practice Cartographer: a role and a plain description from names alone. */
export function heuristicNote(m: CodeModule): ModuleNote {
  const id = m.id.toLowerCase();
  const role: ModuleRole =
    /(^|\/)(tests?|__tests__|spec|e2e)$/.test(id) ? "test"
      : /(^|\/)(docs?|examples?)$/.test(id) ? "docs"
        : /(^|\/)(\.github|scripts?|ci|tools?|build)$/.test(id) ? "build"
          : /(ui|web|frontend|client|components|pages|views|bridge|app)$/.test(id) || m.lang === "CSS" || m.lang === "HTML" ? "ui"
            : /(api|server|routes|handlers|controllers)$/.test(id) ? "api"
              : /(db|store|data|models?|migrations|schema|storage)$/.test(id) ? "data"
                : /(cli|bin|cmd)$/.test(id) ? "cli"
                  : /(config|settings)$/.test(id) ? "config" : "core";
  const what = m.exports.length ? `; exports ${m.exports.slice(0, 4).join(", ")}${m.exports.length > 4 ? " and more" : ""}` : "";
  return { id: m.id, role, purpose: `${m.lang} ${role} module, ${m.files} files and ${m.lines} lines${what}.`, risks: [] };
}

const FLAG_TO_SUGGESTION: Record<string, (f: HealthFlag, map: CodeMap) => Suggestion> = {
  "secret-files": (f) => ({ title: "Remove committed secret files and rotate them", body: `${f.text}. Anyone with the repo can read them. Delete them from the repo, add them to .gitignore, and rotate every key they held.`, kind: "fix", lens: "security", severity: "critical", effort: "small", files: f.files ?? [] }),
  "no-tests": (_f, map) => ({ title: "Add a first test suite for the core logic", body: `There are no tests, so nothing catches a regression. Start with the largest module (${map.modules.filter(isCodeModule)[0]?.id ?? "the core"}) and its main exported functions, and add a test script.`, kind: "improvement", lens: "tests", severity: "high", effort: "medium", files: map.modules.filter(isCodeModule).slice(0, 2).map((m) => m.id) }),
  "no-ci": (_f, map) => ({ title: "Run the tests in CI on every push", body: `No CI workflow checks changes before they land. Add a workflow that installs dependencies and runs ${map.tests.command ?? "the tests"} on every push and pull request.`, kind: "improvement", lens: "reliability", severity: "medium", effort: "small", files: [".github/workflows/"] }),
  "untested-modules": (f) => ({ title: "Cover the untested modules with tests", body: `${f.text}. Add tests that import them directly, starting with the largest.`, kind: "improvement", lens: "tests", severity: "medium", effort: "medium", files: f.files ?? [] }),
  "large-files": (f) => ({ title: "Split the largest source files", body: `${f.text}. Split each by responsibility so changes stay small and reviews stay readable.`, kind: "improvement", lens: "structure", severity: f.level === "medium" ? "medium" : "low", effort: "medium", files: (f.files ?? []).map((x) => x.replace(/ \(\d+\)$/, "")) }),
  "no-lockfile": () => ({ title: "Commit a lockfile for reproducible installs", body: "Without a lockfile every install can pull different versions. Run npm install once and commit package-lock.json.", kind: "fix", lens: "reliability", severity: "medium", effort: "small", files: ["package.json"] }),
  "no-readme": () => ({ title: "Write a README with setup and usage", body: "There is no README, so nobody (including agents) knows how to run or use this. Add what it does, how to install, run and test it.", kind: "improvement", lens: "docs", severity: "medium", effort: "small", files: ["README.md"] }),
  "todos": (f, map) => ({ title: "Triage the TODO and FIXME markers", body: `${f.text}. Turn the real ones into tickets and delete the stale ones.`, kind: "improvement", lens: "dx", severity: "low", effort: "small", files: [...new Set(map.todos.slice(0, 6).map((t) => t.path))] }),
  "no-test-command": () => ({ title: "Add one command that runs all tests", body: "Tests exist but no script runs them, so they are easy to forget. Add a test script to the manifest.", kind: "improvement", lens: "dx", severity: "low", effort: "small", files: [] }),
  "thin-tests": (f) => ({ title: "Grow the test suite around risky code", body: `${f.text}. Add tests where bugs would hurt most: parsing, storage and anything that talks to the outside.`, kind: "improvement", lens: "tests", severity: "low", effort: "medium", files: [] }),
  "no-license": () => ({ title: "Add a license", body: "Without a LICENSE file nobody else may legally use the code. Pick one (MIT if unsure) and add it.", kind: "improvement", lens: "docs", severity: "low", effort: "small", files: ["LICENSE"] }),
};

/** The practice Surveyor: one suggestion per health flag, most severe first. */
export function heuristicSuggestions(map: CodeMap): Suggestion[] {
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  return map.health.flags.map((f) => FLAG_TO_SUGGESTION[f.id]?.(f, map)).filter((s): s is Suggestion => !!s).sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 8);
}

/** A stable id for a suggestion, so the same advice on a later exploration is recognised and not filed twice. */
export function suggestionId(projectId: number, title: string): string {
  const norm = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return `s${projectId}-${createHash("sha1").update(norm).digest("hex").slice(0, 10)}`;
}

/**
 * What exploring will cost, before anything is spent. Claude Code headless has a
 * fixed price per call (loading its context) plus tokens; Haiku prices.
 */
export function estimateUsd(calls: number, promptChars: number, outTokensPerCall = 700): number {
  const FIXED = 0.004;
  const IN = 1 / 1e6;
  const OUT = 5 / 1e6;
  return Number((calls * FIXED + (promptChars / 4) * IN + calls * outTokensPerCall * OUT).toFixed(4));
}
