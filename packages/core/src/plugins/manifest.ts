import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, isAbsolute, sep } from "node:path";

/**
 * A plugin is a folder with a `plugin.json`:
 *
 *   {
 *     "id": "run-stats",                       kebab-case, unique
 *     "name": "Run stats",
 *     "version": "1.0.0",
 *     "description": "Shipped and failed runs and spend, per project",
 *     "permissions": ["events:read"],          what it may do; shown once when you turn it on
 *     "main": "main.mjs",                      optional backend, runs in its own locked-down Node process
 *     "subscribe": ["factory.run.*"],          events the backend receives (needs events:read)
 *     "panels": [                              optional UI, each a web page shown in a sandboxed frame
 *       { "id": "stats", "title": "Run stats", "entry": "ui/index.html", "where": "project", "order": 85 }
 *     ],
 *     "agents": ["agents/reviewer.md"]         optional agent files that join the Agent Bay (needs agents)
 *   }
 *
 * Every plugin may keep its own small data (key → JSON value) and log lines; nothing else is
 * open to it unless its permissions say so.
 */
export const PLUGIN_PERMISSIONS = ["events:read", "events:write", "agents", "records:read", "actions"] as const;
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

export const PERMISSION_TEXT: Record<PluginPermission, string> = {
  "events:read": "See what happens in the factory (runs, ideas, agents) and read project timelines",
  "events:write": "Post its own entries to the timeline",
  agents: "Add its agents to the Agent Bay, where the loops can pick them as workers",
  "records:read": "Read your projects, tickets and agents (names, states, counts and spend; no file contents)",
  actions: "Do the things its manifest lists for you (each one is named when you turn it on, and logged)",
};

/**
 * What a plugin may do with the `actions` permission. Each is the same core command the app's own
 * screens call, so a plugin cannot do anything the screens cannot. None of these spends money.
 */
export const PLUGIN_ACTIONS = {
  "project.create": "Create a project",
  "ticket.open": "Open a ticket",
  "ticket.note": "Add a note to a ticket",
} as const;
export type PluginAction = keyof typeof PLUGIN_ACTIONS;

/** Everything a manifest asks for, as it is granted: its permissions, plus one `act:<verb>` per action, so a new verb is a new ask. */
export const asksOf = (m: { permissions?: string[]; actions?: string[] }): string[] => [...(m.permissions ?? []), ...(m.actions ?? []).map((a) => `act:${a}`)];

/** What a plugin may read with `records:read`. */
export const PLUGIN_RECORDS = ["projects", "tickets", "agents"] as const;
export type PluginRecordKind = (typeof PLUGIN_RECORDS)[number];

export interface PluginPanel {
  id: string;
  title: string;
  /** The page, relative to the plugin folder. */
  entry: string;
  /** "project": a tab in every project. "page": a page of its own on the Plugins screen. */
  where: "project" | "page";
  order: number;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  permissions: PluginPermission[];
  main: string | null;
  subscribe: string[];
  panels: PluginPanel[];
  agents: string[];
  /** The actions it may take (needs the actions permission); see PLUGIN_ACTIONS. */
  actions: PluginAction[];
}

export class ManifestError extends Error {}

const ID = /^[a-z0-9][a-z0-9-]{1,39}$/;

/** A path inside the plugin folder (no absolute paths, no `..`). */
function inside(dir: string, rel: unknown, what: string): string {
  if (typeof rel !== "string" || !rel.trim()) throw new ManifestError(`${what} must be a path inside the plugin folder`);
  const clean = normalize(rel.replace(/\\/g, "/")).replace(/\\/g, "/").replace(/^\.\//, "");
  if (isAbsolute(clean) || clean === ".." || clean.startsWith("../") || clean.split("/").includes("..")) throw new ManifestError(`${what} (${rel}) leaves the plugin folder`);
  const full = join(dir, clean);
  let ok = false;
  try { ok = statSync(full).isFile(); } catch { /* missing */ }
  if (!ok) throw new ManifestError(`${what} (${rel}) is not in the plugin folder`);
  return clean.split(sep).join("/");
}

/** Read and check a plugin folder's plugin.json. Throws ManifestError with a plain-language reason. */
export function readManifest(dir: string): PluginManifest {
  const file = join(dir, "plugin.json");
  if (!existsSync(file)) throw new ManifestError("No plugin.json in that folder");
  let raw: Record<string, any>;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new ManifestError(`plugin.json is not valid JSON: ${(e as Error).message}`); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ManifestError("plugin.json must hold an object");
  const id = String(raw.id ?? "");
  if (!ID.test(id)) throw new ManifestError(`"id" must be 2 to 40 lowercase letters, digits or dashes (got "${id}")`);
  const name = String(raw.name ?? id).trim().slice(0, 60) || id;
  const permissions = Array.isArray(raw.permissions) ? raw.permissions.map(String) : [];
  const unknown = permissions.filter((p: string) => !(PLUGIN_PERMISSIONS as readonly string[]).includes(p));
  if (unknown.length) throw new ManifestError(`Unknown permission ${unknown.join(", ")}; known: ${PLUGIN_PERMISSIONS.join(", ")}`);
  const main = raw.main == null ? null : inside(dir, raw.main, '"main"');
  if (main && !/\.(m?js|cjs)$/.test(main)) throw new ManifestError('"main" must be a .js or .mjs file');
  const subscribe = Array.isArray(raw.subscribe) ? raw.subscribe.map(String).filter((s: string) => /^[a-z0-9.*_-]+$/i.test(s)).slice(0, 50) : [];
  if (subscribe.length && !permissions.includes("events:read")) throw new ManifestError('"subscribe" needs the events:read permission');
  if (subscribe.length && !main) throw new ManifestError('"subscribe" needs a backend ("main")');
  const panelIds = new Set<string>();
  const panels: PluginPanel[] = (Array.isArray(raw.panels) ? raw.panels : []).slice(0, 10).map((p: any, i: number) => {
    const pid = String(p?.id ?? `panel${i + 1}`);
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(pid)) throw new ManifestError(`Panel id "${pid}" must be lowercase letters, digits or dashes`);
    if (panelIds.has(pid)) throw new ManifestError(`Two panels are called "${pid}"`);
    panelIds.add(pid);
    const entry = inside(dir, p?.entry, `Panel "${pid}" entry`);
    if (!/\.html?$/.test(entry)) throw new ManifestError(`Panel "${pid}" entry must be an .html page`);
    return {
      id: pid, title: String(p?.title ?? name).slice(0, 40), entry,
      where: p?.where === "page" ? "page" : "project",
      order: Number.isFinite(Number(p?.order)) ? Number(p.order) : 85,
    };
  });
  const agents = (Array.isArray(raw.agents) ? raw.agents : []).slice(0, 20).map((a: unknown, i: number) => inside(dir, a, `Agent file ${i + 1}`));
  if (agents.length && !permissions.includes("agents")) throw new ManifestError('"agents" needs the agents permission');
  const actions = [...new Set((Array.isArray(raw.actions) ? raw.actions : []).map(String))] as string[];
  const unknownActions = actions.filter((a) => !(a in PLUGIN_ACTIONS));
  if (unknownActions.length) throw new ManifestError(`Unknown action ${unknownActions.join(", ")}; known: ${Object.keys(PLUGIN_ACTIONS).join(", ")}`);
  if (actions.length && !permissions.includes("actions")) throw new ManifestError('"actions" needs the actions permission');
  if (permissions.includes("actions") && !actions.length) throw new ManifestError(`The actions permission needs an "actions" list (any of ${Object.keys(PLUGIN_ACTIONS).join(", ")})`);
  if (!main && !panels.length && !agents.length) throw new ManifestError("The plugin adds nothing: give it a main, panels or agents");
  return {
    id, name, version: String(raw.version ?? "0.0.0").slice(0, 20), description: String(raw.description ?? "").slice(0, 300),
    permissions: permissions as PluginPermission[], main, subscribe, panels, agents, actions: actions as PluginAction[],
  };
}

/** Does an event type match a subscription pattern? `factory.run.*` matches `factory.run.finished`; `*` matches all. */
export function matchesType(pattern: string, type: string): boolean {
  if (pattern === "*" || pattern === type) return true;
  if (pattern.endsWith(".*")) return type.startsWith(pattern.slice(0, -1));
  return false;
}
