import { readAdvisorRule } from "../advisor.js";
import type { AgentBay } from "../bay/bay.js";
import { listMcp, listSkills } from "../bay/kits.js";
import type { EventLog } from "../events.js";
import type { FlowLibrary } from "../flows/library.js";
import type { PluginHost } from "../plugins/host.js";
import { crewUsesPersonalSettings } from "../runtime.js";
import { assignments, listProfiles } from "./profiles.js";
import { buildInventory, type ConfigEntry, type ConfigInputs } from "./inventory.js";

/** When each setting was last changed, from the settings.changed events. */
export function settingSince(log: EventLog): Record<string, string> {
  const rows = log.db.prepare("SELECT json_extract(payload, '$.key') AS key, max(ts) AS ts FROM events WHERE type = 'settings.changed' GROUP BY key").all() as { key: string | null; ts: string }[];
  return Object.fromEntries(rows.filter((r) => r.key).map((r) => [r.key!, r.ts]));
}

/** The live setup, read from the parts of the core that hold it. */
export function liveConfig(d: {
  log: EventLog; bay: AgentBay; flows: FlowLibrary; plugins: PluginHost; crewMode: () => string;
  autoWork: () => ConfigInputs["autoWork"]; maxRunMinutes: () => number | undefined; env?: Record<string, string | undefined>;
}): () => ConfigEntry[] {
  // A whole inventory is a few small queries; one per second is plenty even when a council starts six calls at once.
  let cached: { at: number; entries: ConfigEntry[] } | null = null;
  return () => {
    if (cached && Date.now() - cached.at < 1000) return cached.entries;
    const env = d.env ?? process.env;
    const entries = buildInventory({
      agents: d.bay.agents(), slots: d.bay.slots(), flows: d.flows.list(), plugins: d.plugins.list(),
      skills: listSkills().map((s) => ({ name: s.name, source: s.source })), mcp: listMcp().map((m) => ({ name: m.name, source: m.source })),
      advisor: readAdvisorRule(d.log), crewMode: d.crewMode(), autoWork: d.autoWork(), maxRunMinutes: d.maxRunMinutes(),
      personalSettings: crewUsesPersonalSettings(env), env, settingSince: settingSince(d.log), profiles: profileCounts(d.log),
    });
    cached = { at: Date.now(), entries };
    return entries;
  };
}

function profileCounts(log: EventLog): NonNullable<ConfigInputs["profiles"]> {
  const as = assignments(log);
  const g = as.find((a) => a.scope === "global");
  const p = g ? listProfiles(log).find((x) => x.id === g.profile) : undefined;
  const n = (scope: string) => as.filter((a) => a.scope === scope).length;
  return { global: p ? { id: p.id, name: p.name, settings: p.settings.length } : null, project: n("project"), ticket: n("ticket"), run: n("run") };
}
