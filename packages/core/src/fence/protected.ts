/**
 * The protected settings (docs/fence.md, "Settings only by your hand").
 *
 * The two limits and the stop list are what keeps work that runs by itself inside what the owner allowed. They are
 * changed like any other setting, on the screen, but only with a second word from the owner that names each change,
 * and they count only when the record holds the owner's line for them. A settings file that says otherwise was
 * changed by something else: the queue rests, and the screen says which values are in doubt.
 */
import type { RecordLine } from "./record.js";

export const PROTECTED = {
  limitPeriod: "The period of the two limits",
  limitYou: "Limit 1 (work you sent)",
  limitAlone: "Limit 2 (work SoftwareFactory sent by itself)",
  ownSharePercent: "The share of limit 2 for SoftwareFactory's own work",
  runLimit: "The most one run may use",
  runFloor: "The least worth starting a run with",
  stopPaths: "More on the stop list",
} as const;
export type ProtectedKey = keyof typeof PROTECTED;
export const PROTECTED_KEYS = Object.keys(PROTECTED) as ProtectedKey[];
export const isProtected = (k: string): k is ProtectedKey => Object.prototype.hasOwnProperty.call(PROTECTED, k);

export interface HandChange { key: ProtectedKey; says: string; /** For a value in doubt: what the owner set. */ set?: unknown }

const show = (v: unknown): string => (Array.isArray(v) ? (v.length ? v.map(String).join(", ") : "nothing") : String(v)).slice(0, 200);
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The protected settings a save would change, each as a sentence the owner says yes to. */
export function protectedChanges<S extends Record<ProtectedKey, unknown>>(was: S, now: S): HandChange[] {
  return PROTECTED_KEYS.filter((k) => !eq(was[k], now[k])).map((k) => ({ key: k, says: `${PROTECTED[k]}: from ${show(was[k])} to ${show(now[k])}` }));
}

/** The protected settings as the owner last set them, read from the record. What was never set stands at its default. */
export function protectedOnRecord<S extends Record<ProtectedKey, unknown>>(lines: RecordLine[], defaults: S): Record<ProtectedKey, unknown> {
  const out = Object.fromEntries(PROTECTED_KEYS.map((k) => [k, defaults[k]])) as Record<ProtectedKey, unknown>;
  for (const l of lines) {
    if (l.kind !== "setting.changed" || l.who !== "you") continue;
    const changed = ((l.data as any)?.changed ?? {}) as Record<string, { to?: unknown }>;
    for (const k of PROTECTED_KEYS) if (changed[k] && "to" in changed[k]!) out[k] = changed[k]!.to;
  }
  return out;
}

/** Protected settings whose value in the settings file is not the one the owner set. Empty: all is as they left it. */
export function settingsInDoubt<S extends Record<ProtectedKey, unknown>>(lines: RecordLine[], file: S, defaults: S): HandChange[] {
  const set = protectedOnRecord(lines, defaults);
  return PROTECTED_KEYS.filter((k) => !eq(set[k], file[k])).map((k) => ({ key: k, says: `${PROTECTED[k]}: you set ${show(set[k])}, the settings file says ${show(file[k])}`, set: set[k] }));
}
