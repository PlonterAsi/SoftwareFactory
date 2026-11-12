import { kitFor } from "../bay/kits.js";
import { isAbsolute, join } from "node:path";
import type { AgentDef, Slot } from "../bay/agentfile.js";
import { BUILTIN_AGENTS, DEFAULT_SLOTS, systemPromptFor } from "../bay/builtin.js";
import type { Principle } from "../brain/brain.js";

/**
 * A crew member is an agent bound to a station: the agent's own prompt plus
 * the station's contract, its model, cap and plugins, and the agent version
 * that did the work (so stats and history stay exact after edits).
 *
 * Agents answer in plain text with a small, strict format the core can parse,
 * so by default they run with no tools at all (lean profile): the core writes
 * files and runs tests itself. That keeps each call cheap and keeps agents
 * from touching anything outside the project folder.
 */
export interface CrewMember {
  id: string;
  version: number;
  name: string;
  station: Slot;
  model: string;
  /** Spend cap for one call, USD. The run's remaining budget can lower it. */
  budgetUsd: number;
  /** The full system prompt: the agent's prompt, then the station contract. */
  role: string;
  pluginDirs: string[];
  /** Built-in tools, plus Skill when it has skills and mcp__<server> for each of its MCP servers. */
  tools: string[];
  /** Its own --mcp-config (only its MCP servers), when it has any. */
  mcpConfig?: string;
}

/** Where the factory gets its workers. The Agent Bay is one; the built-in crew is the fallback. */
export interface CrewSource {
  /** The agents working a station, in seat order (the Council has up to six). */
  crewFor(slot: Slot): CrewMember[];
}

/** Plugin names resolve under SF_PLUGINS_DIR; absolute paths are used as they are. */
export function pluginDirsFor(plugins: string[], env = process.env): string[] {
  return plugins.map((p) => (isAbsolute(p) || !env.SF_PLUGINS_DIR ? p : join(env.SF_PLUGINS_DIR, p)));
}

/** Bind an agent to a station. Its role is its prompt, the Brain's principles for the station, then the contract. */
export function bind(agent: AgentDef, version: number, slot: Slot, principles?: Principle[]): CrewMember {
  return {
    id: agent.id, version, name: agent.name, station: slot, model: agent.model, budgetUsd: agent.budgetUsd,
    role: systemPromptFor(agent, slot, principles), ...kitOf(agent),
  };
}

/** What an agent loads on a call: its plugins, its own skills kit and MCP servers (bay/kits.ts). */
export function kitOf(agent: AgentDef): { pluginDirs: string[]; tools: string[]; mcpConfig?: string } {
  const k = kitFor({ ...agent, mcp: agent.mcp ?? [] }, pluginDirsFor(agent.plugins));
  return { pluginDirs: k.pluginDirs, tools: k.tools, ...(k.mcpConfig ? { mcpConfig: k.mcpConfig } : {}) };
}

/** The built-in crew with no Bay behind it (tests, and a factory made without one). */
export const builtinCrew: CrewSource = {
  crewFor(slot) {
    return DEFAULT_SLOTS[slot].map((id) => bind(BUILTIN_AGENTS.find((a) => a.id === id)!, 0, slot));
  },
};
