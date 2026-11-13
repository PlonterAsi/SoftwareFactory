/**
 * Agent files: an agent is a small Markdown file with a frontmatter header and
 * its prompt as the body. The format mirrors Claude Code subagent files
 * (name, description, tools, model), so plonter-kit agents import as they are,
 * and adds the factory's own fields (station, budget, plugins, sample task).
 *
 *   ---
 *   name: Planner
 *   id: planner
 *   model: haiku
 *   station: plan
 *   budget-usd: 0.2
 *   plugins: []
 *   skills: []
 *   tools: []
 *   mcp: []
 *   ---
 *   You are the Planner of SoftwareFactory. ...
 */

/** The places an agent can work. Every station has a contract the core appends to the agent's prompt. */
export const SLOTS = ["council", "design", "critique", "plan", "tests", "build", "review", "evaluate", "fix", "order", "overseer", "improve", "map", "survey"] as const;
export type Slot = (typeof SLOTS)[number];
export type HomeStation = Slot | "none";

export interface AgentDef {
  id: string;
  name: string;
  /** One glyph for the crew card. */
  avatar: string;
  description: string;
  /** The station this agent was made for; its test run uses that station's contract. */
  station: HomeStation;
  model: string;
  /** Spend cap for one call, USD. A run's remaining budget can lower it. */
  budgetUsd: number;
  /** Claude Code plugin folders this agent loads. Empty = lean: nothing extra is loaded. */
  plugins: string[];
  /** Skills (names in the skills library, bay/kits.ts) the agent loads: only these, through its own small plugin folder. */
  skills: string[];
  /** Tools the agent may use. Empty = answers in text only (the cheapest and safest). */
  tools: string[];
  /** MCP servers (names in <data>/mcp-servers.json) this agent loads. Empty = none. */
  mcp: string[];
  /** A sample task for test runs in the Bay. */
  sample: string;
  /** The agent's own instructions: who it is and how it works. The station contract is added by the core. */
  prompt: string;
}

export const MODELS = ["haiku", "sonnet", "opus"] as const;

export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";
}

const FIELDS: [keyof AgentDef, string][] = [
  ["name", "name"], ["id", "id"], ["avatar", "avatar"], ["description", "description"], ["station", "station"], ["model", "model"],
  ["budgetUsd", "budget-usd"], ["plugins", "plugins"], ["skills", "skills"], ["tools", "tools"], ["mcp", "mcp"], ["sample", "sample"],
];
const LISTS = new Set<keyof AgentDef>(["plugins", "skills", "tools", "mcp"]);

/** Check and clean an agent definition. Throws with a plain message on anything unusable. */
export function normalizeAgent(raw: Partial<AgentDef> & Record<string, unknown>): AgentDef {
  const name = String(raw.name ?? "").trim();
  if (!name) throw new Error("An agent needs a name");
  const prompt = String(raw.prompt ?? "").trim();
  if (!prompt) throw new Error("An agent needs a prompt");
  const station = String(raw.station ?? "none") as HomeStation;
  if (station !== "none" && !SLOTS.includes(station as Slot)) throw new Error(`Unknown station "${station}"`);
  const budget = Number(raw.budgetUsd ?? 0.1);
  if (!Number.isFinite(budget) || budget <= 0 || budget > 5) throw new Error("budget-usd must be above 0 and at most 5");
  const list = (v: unknown) => (Array.isArray(v) ? v : typeof v === "string" && v.trim() ? v.split(",") : []).map((x) => String(x).trim()).filter(Boolean);
  const model = String(raw.model ?? "haiku").trim().toLowerCase();
  return {
    id: slugify(String(raw.id ?? "") || name),
    name: name.slice(0, 60),
    avatar: [...String(raw.avatar ?? "").trim()][0] ?? "◆",
    description: String(raw.description ?? "").trim().slice(0, 300),
    station,
    model: model === "inherit" || !model ? "haiku" : model,
    budgetUsd: Number(budget.toFixed(4)),
    plugins: list(raw.plugins),
    skills: list(raw.skills),
    tools: list(raw.tools),
    mcp: list(raw.mcp),
    sample: String(raw.sample ?? "").trim().slice(0, 500),
    prompt,
  };
}

/** Write an agent as a Markdown file with a frontmatter header. */
export function serializeAgent(a: AgentDef): string {
  const val = (k: keyof AgentDef) => {
    const v = a[k];
    if (Array.isArray(v)) return `[${v.map((x) => (/[,\[\]"]/.test(x) ? JSON.stringify(x) : x)).join(", ")}]`;
    const s = String(v);
    return /^\s|\s$|^[\[{"'>|]|: /.test(s) || s.includes("\n") ? JSON.stringify(s) : s;
  };
  return ["---", ...FIELDS.map(([k, key]) => `${key}: ${val(k)}`), "---", a.prompt.trim(), ""].join("\n");
}

/**
 * Read an agent file: ours, or a Claude Code subagent file (name, description,
 * tools, model, then the prompt). Unknown keys are ignored. A small YAML subset:
 * `key: value`, quoted strings, `[a, b]` lists, comma lists, indented continuation lines.
 */
export function parseAgentFile(text: string): AgentDef {
  const m = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error("An agent file starts with a --- header block");
  const head: Record<string, string> = {};
  let last = "";
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (kv) { last = kv[1].toLowerCase(); head[last] = kv[2].trim(); }
    else if (last && /^\s+\S/.test(line)) head[last] = `${head[last] && !/^[|>]-?$/.test(head[last]) ? head[last] + " " : ""}${line.trim()}`;
  }
  const scalar = (v: string | undefined) => {
    if (v === undefined) return undefined;
    if (/^"(.*)"$/.test(v)) { try { return JSON.parse(v) as string; } catch { return v.slice(1, -1); } }
    if (/^'(.*)'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
    return v;
  };
  const list = (v: string | undefined) => {
    if (!v) return [];
    const inner = v.match(/^\[(.*)\]$/)?.[1] ?? v;
    return inner.split(",").map((x) => scalar(x.trim()) ?? "").filter(Boolean);
  };
  const name = scalar(head.name) ?? "";
  // Claude Code names are kebab-case ids; show them as words.
  const display = /^[a-z0-9]+(-[a-z0-9]+)+$/.test(name) ? name.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") : name;
  return normalizeAgent({
    name: display, id: scalar(head.id) ?? name, avatar: scalar(head.avatar), description: scalar(head.description),
    station: (scalar(head.station) ?? "none") as HomeStation, model: scalar(head.model),
    budgetUsd: head["budget-usd"] !== undefined ? Number(scalar(head["budget-usd"])) : undefined,
    plugins: list(head.plugins), skills: list(head.skills), tools: list(head.tools), mcp: list(head.mcp), sample: scalar(head.sample), prompt: m[2],
  });
}

/** Lines that differ between two prompts, for the version view. */
export function lineDiff(a: string, b: string): { op: "same" | "del" | "add"; text: string }[] {
  const x = a.split("\n"), y = b.split("\n");
  const n = x.length, m = y.length;
  // Longest common subsequence; prompts are short, so the O(n*m) table is fine.
  const t = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out: { op: "same" | "del" | "add"; text: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ op: "same", text: x[i] }); i++; j++; }
    else if (t[i + 1][j] >= t[i][j + 1]) out.push({ op: "del", text: x[i++] });
    else out.push({ op: "add", text: y[j++] });
  }
  while (i < n) out.push({ op: "del", text: x[i++] });
  while (j < m) out.push({ op: "add", text: y[j++] });
  return out;
}
