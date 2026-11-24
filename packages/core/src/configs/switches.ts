import type { EventLog } from "../events.js";

/**
 * Switches (docs/configuration.md, part 5 of the brief of 22 Nov 2026).
 *
 * SoftwareFactory reads a few dozen SF_* environment variables. The ones that change how the crew works are listed
 * here with what they do, so the Configuration page can show every one (set or not) and let you change it. A value
 * you set on the page is kept as a `config.switch.set` event and wins over this PC's environment; Reset brings the
 * environment's value (or the default) back. Some are read on every use and apply at once; the rest apply after
 * SoftwareFactory restarts, and the page says which.
 *
 * Not editable here: secrets (keys, tokens), how this process was started (port, database), and what picks the
 * Claude Code binary or the crew mode, which the Systems page owns.
 */
export type SwitchKind = "onoff" | "number" | "choice" | "text";

export interface SwitchDef {
  name: string;
  what: string;
  kind: SwitchKind;
  /** For choice: the allowed values. For onoff: [value when on, value when off]; undefined in that pair means unset. */
  choices?: (string | undefined)[];
  /** What happens when it is unset, in words. */
  unset: string;
  /** Read on every use (true), or once when SoftwareFactory starts (false). */
  live: boolean;
  min?: number;
  max?: number;
}

export const SWITCHES: SwitchDef[] = [
  { name: "SF_CREW_PERSONAL_SETTINGS", what: "Builder and Fixer load your own Claude Code skills, plugins, hooks and CLAUDE.md when they edit a repo", kind: "onoff", choices: ["1", undefined], unset: "Off: the crew runs only on what SoftwareFactory gives it", live: true },
  { name: "SF_ADVISOR", what: "Default advisor model for working sessions, before you pick one in Systems", kind: "choice", choices: ["off", "sonnet", "opus", "fable"], unset: "opus", live: false },
  { name: "SF_AGENT_TIMEOUT_MS", what: "Longest one agent call may run, in milliseconds", kind: "number", unset: "600000 (10 minutes)", live: false, min: 60_000, max: 7_200_000 },
  { name: "SF_SCREEN_CHECK", what: "Open the built app in a browser and check its screens after a build", kind: "onoff", choices: [undefined, "off"], unset: "On", live: true },
  { name: "SF_LINK_CHECK", what: "Check the built app's links after a build", kind: "onoff", choices: [undefined, "off"], unset: "On", live: true },
  { name: "SF_AUTO_RESUME", what: "Runs the app closed on pick up again from their last finished station when it starts", kind: "onoff", choices: [undefined, "0"], unset: "On", live: false },
  { name: "SF_IMPORT_MAX_USD", what: "Spend cap for reading an imported repo, in dollars", kind: "number", unset: "$0.50", live: true, min: 0, max: 20 },
  { name: "SF_REVIEW_MAX_USD", what: "Spend cap for reviewing an imported repo, in dollars", kind: "number", unset: "the built-in review cap", live: true, min: 0, max: 20 },
  { name: "SF_ORDER_MODE", what: "How the Archivist sorts your ideas: an agent, or free rules", kind: "choice", choices: ["agent", "heuristic"], unset: "Follows the crew mode", live: false },
  { name: "SF_ORDER_MAX_USD", what: "Spend cap for one Archivist pass, in dollars", kind: "number", unset: "the built-in cap", live: false, min: 0, max: 10 },
  { name: "SF_SIGNIN_RETRY_MS", what: "Wait before one more try when a call fails its sign-in check at start, in milliseconds", kind: "number", unset: "1500", live: true, min: 0, max: 60_000 },
  { name: "SF_BROWSER", what: "The browser the screen check uses (a path)", kind: "text", unset: "The first headless browser found on this PC", live: true },
];

const byName = new Map(SWITCHES.map((s) => [s.name, s]));

/** The environment's own values, as they were before any value from the page was applied. */
const original = new Map<string, string | undefined>();
let appliedTo: Record<string, string | undefined> | null = null;

/** The values you set on the page: name → value (null = you cleared it so it is unset, even if the PC sets it). */
export function switchOverrides(log: EventLog): Map<string, { value: string | null; at: string; by: string }> {
  const rows = log.db.prepare("SELECT ts, payload FROM events WHERE type = 'config.switch.set' ORDER BY id").all() as unknown as { ts: string; payload: string }[];
  const m = new Map<string, { value: string | null; at: string; by: string }>();
  for (const r of rows) {
    const p = JSON.parse(r.payload) as { name: string; value?: string | null; reset?: boolean; by?: string };
    if (p.reset) m.delete(p.name);
    else m.set(p.name, { value: p.value ?? null, at: r.ts, by: p.by ?? "you" });
  }
  return m;
}

function put(env: Record<string, string | undefined>, name: string, value: string | null | undefined) {
  if (value == null) delete env[name];
  else env[name] = value;
}

/** At start: put the page's values into the environment, remembering what the PC had. Call once, before anything reads them. */
export function applySwitches(log: EventLog, env: Record<string, string | undefined> = process.env): void {
  appliedTo = env;
  for (const [name, o] of switchOverrides(log)) {
    if (!byName.has(name)) continue;
    if (!original.has(name)) original.set(name, env[name]);
    put(env, name, o.value);
  }
}

/** Check a value against its switch. Returns the value to store (null = unset) or throws with what is wrong. */
export function checkSwitch(name: string, raw: unknown): string | null {
  const d = byName.get(name);
  if (!d) throw new Error(`${name} is not a switch you can change here.`);
  if (raw === null || raw === undefined || raw === "") return null;
  const v = String(raw).trim();
  if (d.kind === "onoff" || d.kind === "choice") {
    if (!d.choices!.includes(v)) throw new Error(`${name} is one of ${d.choices!.filter(Boolean).join(", ")} (or unset).`);
    return v;
  }
  if (d.kind === "number") {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${name} must be a number.`);
    if ((d.min !== undefined && n < d.min) || (d.max !== undefined && n > d.max)) throw new Error(`${name} must be between ${d.min} and ${d.max}.`);
    return String(n);
  }
  if (v.length > 500 || /[\r\n]/.test(v)) throw new Error(`${name} must be one line.`);
  return v;
}

/** Set a switch from the page (value null = unset). Applies to this process at once; start-time ones also after a restart. */
export function setSwitch(log: EventLog, name: string, raw: unknown, by = "you"): SwitchView {
  const value = checkSwitch(name, raw);
  const env = appliedTo ?? process.env;
  if (!original.has(name)) original.set(name, env[name]);
  log.append("config.switch.set", { name, value, by });
  put(env, name, value);
  return listSwitches(log, env).find((s) => s.name === name)!;
}

/** Drop the page's value: the PC's environment (or the default) decides again. */
export function resetSwitch(log: EventLog, name: string, by = "you"): SwitchView {
  if (!byName.has(name)) throw new Error(`${name} is not a switch you can change here.`);
  const env = appliedTo ?? process.env;
  log.append("config.switch.set", { name, reset: true, by });
  if (original.has(name)) { put(env, name, original.get(name)); original.delete(name); }
  return listSwitches(log, env).find((s) => s.name === name)!;
}

export interface SwitchView extends SwitchDef {
  value: string | null;
  from: "page" | "pc" | "default";
  /** When the page's value was set. */
  at?: string;
  /** The PC's own value, when the page overrides it. */
  pcValue?: string | null;
  /** Start-time switch changed since SoftwareFactory started: applies after a restart. */
  needsRestart?: boolean;
}

/** Every switch with its value now and where that value came from. */
export function listSwitches(log: EventLog, env: Record<string, string | undefined> = appliedTo ?? process.env): SwitchView[] {
  const over = switchOverrides(log);
  return SWITCHES.map((d) => {
    const o = over.get(d.name);
    const pc = original.has(d.name) ? original.get(d.name) : env[d.name];
    if (o) return { ...d, value: o.value, from: "page" as const, at: o.at, pcValue: pc ?? null, ...(!d.live && startedWith.has(d.name) && startedWith.get(d.name) !== (o.value ?? undefined) ? { needsRestart: true } : {}) };
    const v = env[d.name];
    return { ...d, value: v ?? null, from: v !== undefined ? ("pc" as const) : ("default" as const), ...(!d.live && startedWith.has(d.name) && startedWith.get(d.name) !== v ? { needsRestart: true } : {}) };
  });
}

/** What each start-time switch was when SoftwareFactory started, after the page's values were applied. */
const startedWith = new Map<string, string | undefined>();
export function noteStarted(env: Record<string, string | undefined> = process.env): void {
  for (const d of SWITCHES) if (!d.live) startedWith.set(d.name, env[d.name]);
}

/** Forget remembered state (tests). */
export function resetSwitchState(): void { original.clear(); startedWith.clear(); appliedTo = null; }
