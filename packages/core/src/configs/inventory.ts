import { createHash } from "node:crypto";
import type { AdvisorRule } from "../advisor.js";
import type { AgentView } from "../bay/bay.js";
import type { FlowSummary } from "../flows/library.js";
import type { PluginView } from "../plugins/host.js";

/**
 * What SoftwareFactory runs with right now, as one list (the Configuration page, docs/configuration.md).
 *
 * Every entry sits in one of three layers, the same three a profile will hold:
 * - how: how the work is done (flows, the auto-work queue, the council, the safety gates);
 * - who: who does it (agents, their models and caps, their skills, the advisor);
 * - where: where and with what (the crew mode, isolation from the person's own Claude Code, MCP servers,
 *   add-ons, run limits, the SF_* switches).
 * Each entry says where it came from (shipped with SF, a Scout find, a PR, you, an add-on) and since when,
 * so "is it in use, and why" has one answer.
 */
export type ConfigLayer = "how" | "who" | "where";
export const CONFIG_LAYERS: { id: ConfigLayer; title: string; note: string }[] = [
  { id: "how", title: "How we work", note: "Flows, the auto-work queue, the council and the safety gates" },
  { id: "who", title: "Who works", note: "Agents, their models and caps, their skills, the advisor" },
  { id: "where", title: "Where and with what", note: "Crew mode, isolation, MCP servers, add-ons, limits and switches" },
];

export interface ConfigSource {
  kind: "built-in" | "scout" | "pr" | "you" | "add-on" | "switch";
  label: string;
  link?: string;
}

export interface ConfigEntry {
  /** Stable across snapshots: a kind and a name, like "agent:builder" or "skill:frontend-design". */
  id: string;
  layer: ConfigLayer;
  group: string;
  name: string;
  on: boolean;
  /** What it is set to, in words. Part of the snapshot: a change here is a change of setup. */
  detail: string;
  source: ConfigSource;
  since?: string | null;
}

export interface ConfigInputs {
  agents: AgentView[];
  slots: Record<string, string[]>;
  flows: FlowSummary[];
  plugins: PluginView[];
  skills: { name: string; source: "bundled" | "yours" }[];
  mcp: { name: string; source: "bundled" | "yours" }[];
  advisor: AdvisorRule;
  crewMode: string;
  autoWork: { on: boolean; maxUsd: number; askedMaxUsd: number; dailyUsd: number; wip: number };
  maxRunMinutes?: number;
  /** True when the Builder and Fixer still load the person's own Claude Code settings (SF_CREW_PERSONAL_SETTINGS=1). */
  personalSettings: boolean;
  env: Record<string, string | undefined>;
  /** When a setting was last changed, by key (settings.changed events). */
  settingSince?: Record<string, string>;
}

const REPO = "https://github.com/PlonterAsi/SoftwareFactory";
const SHIPPED: ConfigSource = { kind: "built-in", label: "Ships with SoftwareFactory" };

/**
 * Where the pieces that did not come from code alone came from. Only facts recorded in the repo's history
 * belong here; everything else says "Ships with SoftwareFactory".
 */
export const PROVENANCE: Record<string, ConfigSource> = {
  advisor: { kind: "scout", label: "Scout finds #89 and #90 (Anthropic's advisor blog post and docs), built in PRs #120 to #122 (SF-71)", link: `${REPO}/pull/120` },
  isolation: { kind: "you", label: "Your configuration brief, 22 Nov 2026: the crew uses only what SoftwareFactory gives it" },
  "auto-work": { kind: "you", label: "Your standing approval for crew work, raised to $10 a day on 19 Nov 2026 (PR #128)", link: `${REPO}/pull/128` },
  "gate:secrets": { kind: "pr", label: "SF-17: a leaked key reaches the agent as an error to fix" },
  "gate:preflight": { kind: "pr", label: "PR #136: free checks before auto-work spends", link: `${REPO}/pull/136` },
};

/** Switches that hold a secret are listed by name only. */
const SECRET = /KEY|TOKEN|SECRET|PASSWORD/i;
/** Switches that only say how this process was started, not how the crew works. */
const PLUMBING = new Set(["SF_PORT", "SF_DB", "SF_PARENT_PID", "SF_CORE_URL", "SF_APP_VERSION", "SF_PROJECTS", "SF_PROBE", "SF_DROP"]);

const usd = (n: number) => `$${n < 1 ? n.toFixed(2) : n.toFixed(n % 1 ? 2 : 0)}`;

function agentSource(a: AgentView, plugins: PluginView[]): ConfigSource {
  const first = a.versions[0];
  const addon = plugins.find((p) => a.def.id.startsWith(`${p.id}-`));
  if (addon) return { kind: "add-on", label: `From the ${addon.name} add-on` };
  if (!a.builtin) return { kind: "you", label: `Made in the Agent Bay${first?.by ? ` by ${first.by}` : ""}` };
  const edits = a.versions.length - 1;
  return edits > 0 ? { kind: "built-in", label: `Ships with SoftwareFactory, edited ${edits} time${edits === 1 ? "" : "s"} since` } : SHIPPED;
}

function pluginSource(p: PluginView): ConfigSource {
  const gh = p.source?.match(/^github:([^/]+\/[^/@#]+)/);
  if (gh) return { kind: "add-on", label: `Installed from GitHub, ${gh[1]}`, link: `https://github.com/${gh[1]}` };
  if (p.source?.startsWith("example:")) return { kind: "built-in", label: "Example add-on that ships with SoftwareFactory" };
  return { kind: "add-on", label: p.source ? `Installed from ${p.source}` : "Installed from a folder" };
}

/** Every entry of the current setup, in layer order. */
export function buildInventory(i: ConfigInputs): ConfigEntry[] {
  const out: ConfigEntry[] = [];
  const live = i.agents.filter((a) => !a.retired);

  // ── how
  for (const f of i.flows) {
    out.push({
      id: `flow:${f.id}`, layer: "how", group: "Flows", name: f.name, on: true,
      detail: `${f.steps} steps, version ${f.version}${f.kinds.length ? `, for ${f.kinds.join(", ")}` : ""}`,
      source: f.builtIn ? SHIPPED : { kind: "you", label: `Saved${f.savedBy ? ` by ${f.savedBy}` : ""}` }, since: f.savedAt,
    });
  }
  const aw = i.autoWork;
  out.push({
    id: "auto-work", layer: "how", group: "Work queue", name: "Crew picks up ready tickets on its own", on: aw.on,
    detail: `${usd(aw.dailyUsd)} a day, ${usd(aw.maxUsd)} per start (${usd(aw.askedMaxUsd)} when you asked), ${aw.wip} at a time`,
    source: PROVENANCE["auto-work"], since: i.settingSince?.ticketsAutoWork ?? i.settingSince?.ticketsAutoDailyUsd ?? null,
  });
  const council = i.slots.council ?? [];
  out.push({
    id: "council", layer: "how", group: "Council", name: "Council seats", on: council.length > 0,
    detail: council.length ? council.map((id) => live.find((a) => a.def.id === id)?.def.name ?? id).join(", ") : "No seats",
    source: SHIPPED,
  });
  out.push({ id: "gate:secrets", layer: "how", group: "Safety gates", name: "Secret check after every edit", on: true, detail: "A key written into a file fails the edit", source: PROVENANCE["gate:secrets"] });
  out.push({ id: "gate:preflight", layer: "how", group: "Safety gates", name: "Preflight before auto-work", on: true, detail: "git, Claude Code, sign-in and disk are checked; a failure holds auto-work", source: PROVENANCE["gate:preflight"] });

  // ── who
  for (const a of live) {
    const d = a.def;
    const kit = [d.skills.length ? `${d.skills.length} skill${d.skills.length === 1 ? "" : "s"}` : "", d.tools.length ? `tools: ${d.tools.join(", ")}` : "", d.mcp.length ? `MCP: ${d.mcp.join(", ")}` : ""].filter(Boolean).join("; ");
    out.push({
      id: `agent:${d.id}`, layer: "who", group: "Agents", name: d.name, on: true,
      detail: `${d.model}, up to ${usd(d.budgetUsd)} a call, works ${d.station}${kit ? `; ${kit}` : ""}`,
      source: agentSource(a, i.plugins), since: a.updatedAt,
    });
  }
  const usedBy = (pick: (a: AgentView) => string[]) => {
    const m = new Map<string, string[]>();
    for (const a of live) for (const n of pick(a)) m.set(n, [...(m.get(n) ?? []), a.def.name]);
    return m;
  };
  const skillUse = usedBy((a) => a.def.skills);
  for (const s of i.skills) {
    const by = skillUse.get(s.name) ?? [];
    out.push({
      id: `skill:${s.name}`, layer: "who", group: "Skills", name: s.name, on: by.length > 0,
      detail: by.length ? `Loaded by ${by.join(", ")}` : "In the library, no agent loads it",
      source: s.source === "bundled" ? { kind: "built-in", label: "SoftwareFactory's skill library" } : { kind: "you", label: "Your skills folder" },
    });
  }
  const r = i.advisor;
  out.push({
    id: "advisor", layer: "who", group: "Advisor", name: "Advisor for the crew", on: !!r.model,
    detail: r.model ? `${r.model} advises weaker models on every editing session and on calls of ${usd(r.minBudgetUsd)} or more` : "Off",
    source: PROVENANCE.advisor, since: i.settingSince?.crewAdvisor ?? null,
  });

  // ── where
  out.push({
    id: "crew-mode", layer: "where", group: "Crew", name: "Crew mode", on: true,
    detail: i.crewMode === "real" ? "Real crew: Claude Code on this PC, through your sign-in" : "Practice crew: nothing is spent and no PR is opened",
    source: { kind: "you", label: "Set in Systems" }, since: i.settingSince?.crewMode ?? null,
  });
  out.push({
    id: "isolation", layer: "where", group: "Crew", name: "Crew kept apart from your own Claude Code", on: !i.personalSettings,
    detail: i.personalSettings
      ? "The Builder and Fixer still load your own Claude Code skills, plugins, hooks and CLAUDE.md when they edit a repo (SF_CREW_PERSONAL_SETTINGS=1)"
      : "Every agent loads only its own kit and the repo's own settings, never your personal setup",
    source: PROVENANCE.isolation,
  });
  if (i.maxRunMinutes) out.push({ id: "run-minutes", layer: "where", group: "Limits", name: "Longest a build may run", on: true, detail: `${i.maxRunMinutes} minutes`, source: { kind: "you", label: "Set in Systems" }, since: i.settingSince?.maxRunMinutes ?? null });
  const mcpUse = usedBy((a) => a.def.mcp);
  for (const m of i.mcp) {
    const by = mcpUse.get(m.name) ?? [];
    out.push({
      id: `mcp:${m.name}`, layer: "where", group: "MCP servers", name: m.name, on: by.length > 0,
      detail: by.length ? `Given to ${by.join(", ")}` : "Offered, no agent uses it",
      source: m.source === "bundled" ? SHIPPED : { kind: "you", label: "Your mcp-servers.json" },
    });
  }
  for (const p of i.plugins) {
    out.push({
      id: `addon:${p.id}`, layer: "where", group: "Add-ons", name: p.name, on: p.status === "enabled",
      detail: `Version ${p.version}${p.status === "enabled" ? "" : `, ${p.status}`}${p.manifest.budget?.monthlyUsd ? `, up to ${usd(p.manifest.budget.monthlyUsd)} a month` : ""}`,
      source: pluginSource(p),
    });
  }
  for (const [k, v] of Object.entries(i.env).sort(([a], [b]) => a.localeCompare(b))) {
    if (!k.startsWith("SF_") || v === undefined || PLUMBING.has(k)) continue;
    out.push({ id: `switch:${k}`, layer: "where", group: "Switches", name: k, on: true, detail: SECRET.test(k) ? "Set (value hidden)" : `= ${v}`, source: { kind: "switch", label: "Set in this PC's environment" } });
  }
  return out;
}

/** A short fingerprint of what the setup does: the same entries, on/off and details give the same hash. */
export function configHash(entries: ConfigEntry[]): string {
  const key = entries.map((e) => `${e.id}|${e.on ? 1 : 0}|${e.detail}`).sort().join("\n");
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

export interface ConfigDiff {
  added: ConfigEntry[];
  removed: ConfigEntry[];
  changed: { id: string; name: string; was: string; now: string }[];
}

/** What changed from one setup to another (`from` is the older one). */
export function diffConfig(from: ConfigEntry[], to: ConfigEntry[]): ConfigDiff {
  const a = new Map(from.map((e) => [e.id, e]));
  const b = new Map(to.map((e) => [e.id, e]));
  const say = (e: ConfigEntry) => `${e.on ? "on" : "off"}: ${e.detail}`;
  return {
    added: to.filter((e) => !a.has(e.id)),
    removed: from.filter((e) => !b.has(e.id)),
    changed: to.filter((e) => a.has(e.id) && say(a.get(e.id)!) !== say(e)).map((e) => ({ id: e.id, name: e.name, was: say(a.get(e.id)!), now: say(e) })),
  };
}
