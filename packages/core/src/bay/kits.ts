import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Per-agent kits: each agent loads only the skills and MCP servers it lists, nothing else.
 *
 * Skills come from the bundled library (packages/core/agent-skills) and the person's own
 * (<data>/skills). For an agent with skills the core builds a small plugin folder holding
 * just those, and turns on the Skill tool: with every tool off (the lean default) Claude Code
 * never loads a plugin's skills at all.
 *
 * MCP servers come from <data>/mcp-servers.json (Claude Code's own `mcpServers` shape). An
 * agent's servers go into a per-agent --mcp-config; lean runs stay --strict-mcp-config, so
 * no other server loads, and only that agent's servers' tools are allowed.
 */

const BUNDLED = fileURLToPath(new URL("../../agent-skills/", import.meta.url));

let cfg: { dataDir?: string; kitsDir: string; bundledDir: string } = { kitsDir: join(tmpdir(), "sf-agent-kits"), bundledDir: BUNDLED };

/** Point the kits at the app's data folder (the person's skills, MCP servers, and where kits are built). */
export function configureKits(o: { dataDir?: string; kitsDir?: string; bundledDir?: string }) {
  cfg = {
    dataDir: o.dataDir,
    kitsDir: o.kitsDir ?? (o.dataDir ? join(o.dataDir, "agent-kits") : cfg.kitsDir),
    bundledDir: o.bundledDir ?? BUNDLED,
  };
}

export interface SkillInfo { name: string; description: string; source: "bundled" | "yours"; dir: string }
export interface McpInfo { name: string; command: string; config: Record<string, unknown> }
export interface Kit { pluginDirs: string[]; tools: string[]; mcpConfig?: string }

/** Built-in Claude Code tools an agent can be given, with what each one lets it do. */
export const TOOL_CHOICES: { name: string; note: string }[] = [
  { name: "Read", note: "read files" },
  { name: "Glob", note: "find files by name" },
  { name: "Grep", note: "search inside files" },
  { name: "Edit", note: "change files (only in a working copy)" },
  { name: "Write", note: "write files (only in a working copy)" },
  { name: "WebSearch", note: "search the web" },
  { name: "WebFetch", note: "read a web page" },
];

function frontmatter(text: string): Record<string, string> {
  const m = text.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---/);
  const out: Record<string, string> = {};
  for (const line of m?.[1].split("\n") ?? []) {
    const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (kv) out[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function skillsIn(dir: string | undefined, source: SkillInfo["source"]): SkillInfo[] {
  if (!dir || !existsSync(dir)) return [];
  const out: SkillInfo[] = [];
  for (const name of readdirSync(dir)) {
    const file = join(dir, name, "SKILL.md");
    if (!existsSync(file)) continue;
    const fm = frontmatter(readFileSync(file, "utf8"));
    out.push({ name, description: (fm.description ?? "").slice(0, 300), source, dir: join(dir, name) });
  }
  return out;
}

/** Every skill an agent can be given. The person's own win over a bundled one of the same name. */
export function listSkills(): SkillInfo[] {
  const by = new Map<string, SkillInfo>();
  for (const s of [...skillsIn(cfg.bundledDir, "bundled"), ...skillsIn(cfg.dataDir && join(cfg.dataDir, "skills"), "yours")]) by.set(s.name, s);
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The MCP servers set up for agents (<data>/mcp-servers.json). An unreadable file is an empty list. */
export function listMcp(): McpInfo[] {
  if (!cfg.dataDir) return [];
  const file = join(cfg.dataDir, "mcp-servers.json");
  if (!existsSync(file)) return [];
  try {
    const servers = (JSON.parse(readFileSync(file, "utf8")).mcpServers ?? {}) as Record<string, Record<string, unknown>>;
    return Object.entries(servers).map(([name, config]) => ({ name, config, command: [config.command ?? config.url ?? "?", ...((config.args as string[]) ?? [])].join(" ") }));
  } catch { return []; }
}

/** What an agent's settings can choose from, for the Agent Bay's pickers. */
export function library() {
  return {
    skills: listSkills().map(({ name, description, source }) => ({ name, description, source })),
    tools: TOOL_CHOICES,
    mcp: listMcp().map(({ name, command }) => ({ name, command })),
    mcpFile: cfg.dataDir ? join(cfg.dataDir, "mcp-servers.json") : null,
  };
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

/** Write a folder once, atomically: concurrent seats asking for the same kit never see half of one. */
function once(dir: string, fill: (tmp: string) => void) {
  if (existsSync(dir)) return;
  const tmp = `${dir}.${process.pid}.${Date.now()}.tmp`;
  mkdirSync(tmp, { recursive: true });
  fill(tmp);
  try { renameSync(tmp, dir); } catch { rmSync(tmp, { recursive: true, force: true }); }
}

/** A plugin folder with exactly these skills. Content-addressed, so editing a skill builds a new one. */
function skillsKit(skills: SkillInfo[]): string {
  const sig = hash(skills.map((s) => `${s.name}\n${readFileSync(join(s.dir, "SKILL.md"), "utf8")}`).join("\n\0"));
  const dir = join(cfg.kitsDir, `skills-${sig}`);
  once(dir, (tmp) => {
    mkdirSync(join(tmp, ".claude-plugin"), { recursive: true });
    writeFileSync(join(tmp, ".claude-plugin", "plugin.json"), JSON.stringify({ name: `sf-skills-${sig}`, version: "1.0.0", description: "Skills chosen for one SoftwareFactory agent" }, null, 2));
    for (const s of skills) cpSync(s.dir, join(tmp, "skills", s.name), { recursive: true });
  });
  return dir;
}

/** What one agent loads: its plugin folders (plus its skills kit), its tools, its MCP servers. Unknown names are left out. */
export function kitFor(def: { plugins: string[]; skills: string[]; tools: string[]; mcp?: string[] }, pluginDirs: string[]): Kit & { missing: string[] } {
  const missing: string[] = [];
  const tools = [...def.tools];
  const dirs = [...pluginDirs];
  if (def.skills.length) {
    const all = new Map(listSkills().map((s) => [s.name, s]));
    const chosen = def.skills.map((n) => all.get(n) ?? (missing.push(`skill ${n}`), undefined)).filter((s): s is SkillInfo => !!s);
    if (chosen.length) {
      dirs.push(skillsKit(chosen));
      if (!tools.includes("Skill")) tools.push("Skill");
    }
  }
  let mcpConfig: string | undefined;
  if (def.mcp?.length) {
    const all = new Map(listMcp().map((m) => [m.name, m]));
    const chosen = def.mcp.map((n) => all.get(n) ?? (missing.push(`MCP server ${n}`), undefined)).filter((m): m is McpInfo => !!m);
    if (chosen.length) {
      const body = JSON.stringify({ mcpServers: Object.fromEntries(chosen.map((m) => [m.name, m.config])) }, null, 2);
      mcpConfig = join(cfg.kitsDir, `mcp-${hash(body)}.json`);
      if (!existsSync(mcpConfig)) { mkdirSync(cfg.kitsDir, { recursive: true }); writeFileSync(mcpConfig, body); }
      for (const m of chosen) tools.push(`mcp__${m.name}`);
    }
  }
  return { pluginDirs: dirs, tools, mcpConfig, missing };
}
