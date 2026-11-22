import type { EventLog } from "../events.js";
import { listCatalog } from "./catalog.js";
import type { ConfigLayer } from "./inventory.js";

/**
 * Configuration profiles (docs/configuration.md, part 2 of the brief of 22 Nov 2026).
 *
 * A profile is a named set of settings, each in one of the three layers. Which profiles a call runs with is
 * a chain, broadest first: the global default, the project's, the ticket's, the run's. For each setting the
 * narrowest profile in the chain that sets it wins. (A flow step naming its own agent, flows/flow.ts, stays the
 * narrowest override of all.)
 *
 * Inside one profile, two settings that touch the same thing are refused: you pick one. That is what stops
 * "keep one lead" and "add more agents" from running together.
 *
 * Everything is events: config.profile.saved, config.profile.removed, config.assigned.
 */

/** What a profile can set, today. Each path is also what the setting "touches". */
export const SETTING_KINDS: { pattern: string; layer: ConfigLayer; label: string; value: "model" | "usd" | "advisor" | "bool" | "flow" | "minutes" }[] = [
  { pattern: "flow.<kind>", layer: "how", label: "Flow for a kind of ticket (bug, task, feature, question...)", value: "flow" },
  { pattern: "agent.<id>.model", layer: "who", label: "An agent's model", value: "model" },
  { pattern: "agent.<id>.budgetUsd", layer: "who", label: "An agent's cap per call, USD", value: "usd" },
  { pattern: "advisor.model", layer: "who", label: "Advisor for the crew (off, sonnet, opus)", value: "advisor" },
  { pattern: "crew.personalSettings", layer: "where", label: "Builder and Fixer load your own Claude Code settings", value: "bool" },
];

export interface ProfileSetting {
  /** What it sets and touches, like "agent.builder.model" or "flow.bug". */
  path: string;
  value: unknown;
  /** Why it is here, in words (a Scout find, a decision). */
  why?: string;
}

export interface Profile {
  id: string;
  name: string;
  note?: string;
  settings: ProfileSetting[];
  /** Catalog entries in this profile (configs/catalog.ts); their settings apply, and what they touch may not overlap. */
  entries?: string[];
  savedAt?: string;
  savedBy?: string;
}

export type Scope = "global" | "project" | "ticket" | "run";

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const MODELS = ["haiku", "sonnet", "opus", "fable"];

/** The layer a path belongs to, or null when profiles cannot set it. */
export function layerOf(path: string): ConfigLayer | null {
  if (/^flow\.[a-z]+$/.test(path)) return "how";
  if (/^agent\.[a-z0-9-]+\.(model|budgetUsd)$/.test(path) || path === "advisor.model") return "who";
  if (path === "crew.personalSettings") return "where";
  return null;
}

/** Every problem that stops a profile being saved. Empty: it can be saved. */
export function profileProblems(p: Profile, known: { flows?: Set<string>; agents?: Set<string>; entries?: Map<string, { title: string; touches: string[]; settings?: ProfileSetting[] }> } = {}): string[] {
  const out: string[] = [];
  // Catalog entries: each must exist, and no two may touch the same thing (with each other or with the profile's own settings).
  const touched = new Map<string, string>();
  for (const s of p.settings ?? []) touched.set(s.path, "this profile's own settings");
  for (const id of p.entries ?? []) {
    const e = known.entries?.get(id);
    if (known.entries && !e) { out.push(`No catalog entry called ${id}.`); continue; }
    if (!e) continue;
    for (const t of [...e.touches, ...(e.settings ?? []).map((s) => s.path)]) {
      const prev = touched.get(t);
      if (prev && prev !== e.title) out.push(`"${e.title}" and ${prev.startsWith("this") ? prev : `"${prev}"`} both touch ${t}. Pick one.`);
      else touched.set(t, e.title);
    }
  }
  if (!ID.test(p.id)) out.push("The profile's id must be lowercase letters, digits and dashes.");
  if (!p.name?.trim()) out.push("Give the profile a name.");
  const seen = new Map<string, number>();
  for (const s of p.settings ?? []) seen.set(s.path, (seen.get(s.path) ?? 0) + 1);
  for (const [path, n] of seen) if (n > 1) out.push(`Two settings touch ${path}. Keep one of them.`);
  for (const s of p.settings ?? []) {
    if (!layerOf(s.path)) { out.push(`A profile cannot set ${s.path}.`); continue; }
    const agent = s.path.match(/^agent\.([a-z0-9-]+)\./)?.[1];
    if (agent && known.agents && !known.agents.has(agent)) out.push(`No agent called ${agent}.`);
    if (s.path.endsWith(".model") && s.path.startsWith("agent.") && !MODELS.includes(String(s.value))) out.push(`${s.path}: pick haiku, sonnet, opus or fable.`);
    if (s.path.endsWith(".budgetUsd") && !(typeof s.value === "number" && s.value > 0 && s.value <= 10)) out.push(`${s.path}: a cap between $0.01 and $10.`);
    if (s.path === "advisor.model" && !(s.value === null || s.value === "off" || s.value === "sonnet" || s.value === "opus")) out.push("advisor.model: off, sonnet or opus.");
    if (s.path === "crew.personalSettings" && typeof s.value !== "boolean") out.push("crew.personalSettings: on or off.");
    if (s.path.startsWith("flow.") && (typeof s.value !== "string" || (known.flows && !known.flows.has(s.value)))) out.push(`${s.path}: no flow called ${String(s.value)}.`);
  }
  return out;
}

interface Row { ts: string; payload: string }

/** Every saved profile, newest version of each. */
export function listProfiles(log: EventLog): Profile[] {
  const rows = log.db.prepare("SELECT ts, type, payload FROM events WHERE type IN ('config.profile.saved', 'config.profile.removed') ORDER BY id").all() as unknown as (Row & { type: string })[];
  const m = new Map<string, Profile>();
  for (const r of rows) {
    const p = JSON.parse(r.payload);
    if (r.type === "config.profile.removed") m.delete(String(p.id));
    else m.set(String(p.profile.id), { ...p.profile, savedAt: r.ts, savedBy: p.by });
  }
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getProfile(log: EventLog, id: string): Profile | null {
  return listProfiles(log).find((p) => p.id === id) ?? null;
}

export function saveProfile(log: EventLog, p: Profile, by = "you", known?: Parameters<typeof profileProblems>[1]): Profile {
  const clean: Profile = { id: String(p.id ?? "").trim(), name: String(p.name ?? "").trim(), ...(p.note ? { note: String(p.note) } : {}), ...(p.entries?.length ? { entries: [...new Set(p.entries.map(String))] } : {}), settings: (p.settings ?? []).map((s) => ({ path: String(s.path), value: s.value === "off" ? null : s.value, ...(s.why ? { why: String(s.why) } : {}) })) };
  const problems = profileProblems(clean, known);
  if (problems.length) throw Object.assign(new Error(problems.join(" ")), { problems });
  log.append("config.profile.saved", { profile: clean, by });
  return getProfile(log, clean.id)!;
}

export function removeProfile(log: EventLog, id: string, by = "you"): void {
  if (!getProfile(log, id)) throw new Error("No profile with that id.");
  log.append("config.profile.removed", { id, by });
  // Anything that used it falls back to the next broader profile.
  for (const a of assignments(log)) if (a.profile === id) log.append("config.assigned", { scope: a.scope, ref: a.ref, profile: null, by });
}

export interface Assignment { scope: Scope; ref: string | null; profile: string }

/** Which profile each scope uses now (global, each project, ticket and run that has its own). */
export function assignments(log: EventLog): Assignment[] {
  const rows = log.db.prepare("SELECT payload FROM events WHERE type = 'config.assigned' ORDER BY id").all() as { payload: string }[];
  const m = new Map<string, Assignment>();
  for (const r of rows) {
    const p = JSON.parse(r.payload) as { scope: Scope; ref?: string | number | null; profile: string | null };
    const ref = p.scope === "global" ? null : String(p.ref);
    const key = `${p.scope}:${ref ?? ""}`;
    if (p.profile) m.set(key, { scope: p.scope, ref, profile: p.profile });
    else m.delete(key);
  }
  return [...m.values()];
}

export function assign(log: EventLog, scope: Scope, ref: string | number | null, profile: string | null, by = "you"): void {
  if (!["global", "project", "ticket", "run"].includes(scope)) throw new Error("Scope is global, project, ticket or run.");
  if (scope !== "global" && (ref === null || ref === undefined || ref === "")) throw new Error(`Say which ${scope}.`);
  if (profile && !getProfile(log, profile)) throw new Error("No profile with that id.");
  log.append("config.assigned", { scope, ref: scope === "global" ? null : String(ref), profile, by });
}

export interface Resolved {
  /** The profiles in force, broadest first. */
  chain: { scope: Scope; profile: Profile }[];
  /** Each setting that applies, and which profile it came from. */
  settings: Record<string, { value: unknown; from: string; scope: Scope; why?: string }>;
}

/** The profiles and settings a call runs with, from its project, ticket and run. */
export function resolveProfiles(log: EventLog, ctx: { projectId?: number | null; ticket?: number | null; factoryRun?: number | null }): Resolved {
  const all = assignments(log);
  const profiles = new Map(listProfiles(log).map((p) => [p.id, p]));
  const pick = (scope: Scope, ref: string | null) => all.find((a) => a.scope === scope && a.ref === ref);
  const want: [Scope, string | null][] = [["global", null]];
  if (ctx.projectId != null) want.push(["project", String(ctx.projectId)]);
  if (ctx.ticket != null) want.push(["ticket", String(ctx.ticket)]);
  if (ctx.factoryRun != null) want.push(["run", String(ctx.factoryRun)]);
  const chain: Resolved["chain"] = [];
  for (const [scope, ref] of want) {
    const a = pick(scope, ref);
    const p = a && profiles.get(a.profile);
    if (p) chain.push({ scope, profile: p });
  }
  const settings: Resolved["settings"] = {};
  const entries = new Map(listCatalog(log).map((e) => [e.id, e]));
  for (const { scope, profile } of chain) {
    for (const id of profile.entries ?? []) {
      const e = entries.get(id);
      if (!e || !["ready", "trial", "promoted"].includes(e.state)) continue;
      for (const s of e.settings ?? []) settings[s.path] = { value: s.value, from: profile.id, scope, why: `catalog: ${e.title}` };
    }
    for (const s of profile.settings) settings[s.path] = { value: s.value, from: profile.id, scope, ...(s.why ? { why: s.why } : {}) };
  }
  return { chain, settings };
}

/** The project a factory run or ticket belongs to, when the call did not say. */
export function projectFor(log: EventLog, ctx: { projectId?: number; ticket?: number; factoryRun?: number }): number | null {
  if (ctx.projectId != null) return ctx.projectId;
  try {
    if (ctx.ticket != null) {
      const t = log.db.prepare("SELECT project FROM tickets WHERE id = ?").get(ctx.ticket) as { project: number | null } | undefined;
      if (t?.project != null) return Number(t.project);
    }
    if (ctx.factoryRun != null) {
      const r = log.db.prepare("SELECT project_id FROM project_links WHERE kind = 'factory_run' AND ref = ?").get(String(ctx.factoryRun)) as { project_id: number } | undefined;
      if (r) return Number(r.project_id);
      const t = log.db.prepare("SELECT ticket_id FROM ticket_runs WHERE run = ?").get(ctx.factoryRun) as { ticket_id: number } | undefined;
      if (t) return projectFor(log, { ticket: Number(t.ticket_id) });
    }
  } catch { /* a log without those tables */ }
  return null;
}

/** The ticket a factory run was worked for, if any. */
function ticketOfRun(log: EventLog, run?: number): number | null {
  if (run == null) return null;
  try { const t = log.db.prepare("SELECT ticket_id FROM ticket_runs WHERE run = ?").get(run) as { ticket_id: number } | undefined; return t ? Number(t.ticket_id) : null; } catch { return null; }
}

/** The full context of a call: its project and ticket worked out from what it said. */
export function callContext(log: EventLog, meta: { projectId?: number; ticket?: number; factoryRun?: number }): { projectId: number | null; ticket: number | null; factoryRun: number | null } {
  const ticket = meta.ticket ?? ticketOfRun(log, meta.factoryRun);
  return { projectId: projectFor(log, { ...meta, ticket: ticket ?? undefined }), ticket: ticket ?? null, factoryRun: meta.factoryRun ?? null };
}

/**
 * A profile's flow for a ticket's kind ("flow.bug"), looked up through the ticket's own chain.
 * Keyed by the flow library so each core (and each test) keeps its own.
 */
const flowSources = new WeakMap<object, (t: { id?: number; project?: number | null; kind: string }) => string | null>();

export function setProfileFlows(lib: object, log: EventLog): void {
  flowSources.set(lib, (t) => {
    const r = resolveProfiles(log, { projectId: t.project ?? null, ticket: t.id ?? null });
    const v = r.settings[`flow.${t.kind}`]?.value;
    return typeof v === "string" ? v : null;
  });
}

export function profileFlow(lib: object, t: { id?: number; project?: number | null; kind: string }): string | null {
  try { return flowSources.get(lib)?.(t) ?? null; } catch { return null; }
}
