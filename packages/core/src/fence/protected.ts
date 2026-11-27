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

export interface HandChange { key: ProtectedKey; says: string; /** For a value in doubt: what the owner set, and what the settings file says. */ set?: unknown; file?: unknown; setAt?: string | null }

const show = (v: unknown): string => (Array.isArray(v) ? (v.length ? v.map(String).join(", ") : "nothing") : String(v)).slice(0, 200);
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The protected settings a save would change, each as a sentence the owner says yes to. */
export function protectedChanges<S extends Record<ProtectedKey, unknown>>(was: S, now: S): HandChange[] {
  return PROTECTED_KEYS.filter((k) => !eq(was[k], now[k])).map((k) => ({ key: k, says: `${PROTECTED[k]}: from ${show(was[k])} to ${show(now[k])}` }));
}

export interface Standing { value: unknown; /** When it was set, and whether by the owner's hand or as it stood when this protection began. */ at: string | null; by: "hand" | "start" | "default" }

/**
 * The protected settings as they stand in the record. The first time this protection runs, SoftwareFactory writes
 * down the values as they stand (`baseline`): what was saved before that had no second step, so it is not taken as
 * the owner's word. After that only a line by the owner that names the setting by hand counts.
 */
export function protectedOnRecord<S extends Record<ProtectedKey, unknown>>(lines: RecordLine[], defaults: S): Record<ProtectedKey, Standing> {
  const out = Object.fromEntries(PROTECTED_KEYS.map((k) => [k, { value: defaults[k], at: null, by: "default" }])) as Record<ProtectedKey, Standing>;
  for (const l of lines) {
    if (l.kind !== "setting.changed") continue;
    const d = (l.data ?? {}) as { changed?: Record<string, { to?: unknown }>; byHand?: unknown; baseline?: Record<string, unknown> };
    if (l.who === "SF itself" && d.baseline && typeof d.baseline === "object") { for (const k of PROTECTED_KEYS) if (k in d.baseline) out[k] = { value: d.baseline[k], at: l.ts, by: "start" }; continue; }
    if (l.who !== "you" || !Array.isArray(d.byHand)) continue;
    for (const k of PROTECTED_KEYS) if (d.byHand.includes(k) && d.changed?.[k] && "to" in d.changed[k]!) out[k] = { value: d.changed[k]!.to, at: l.ts, by: "hand" };
  }
  return out;
}
export const hasBaseline = (lines: RecordLine[]): boolean => lines.some((l) => l.kind === "setting.changed" && l.who === "SF itself" && !!(l.data as any)?.baseline);
export const baselineOf = <S extends Record<ProtectedKey, unknown>>(file: S): Record<ProtectedKey, unknown> => Object.fromEntries(PROTECTED_KEYS.map((k) => [k, file[k]])) as Record<ProtectedKey, unknown>;

/** Protected settings whose value in the settings file is not the one that stands in the record. Empty: all is as the owner left it. */
export function settingsInDoubt<S extends Record<ProtectedKey, unknown>>(lines: RecordLine[], file: S, defaults: S): HandChange[] {
  const set = protectedOnRecord(lines, defaults);
  return PROTECTED_KEYS.filter((k) => !eq(set[k].value, file[k])).map((k) => ({ key: k, says: `${PROTECTED[k]}: ${set[k].by === "hand" ? "you set" : set[k].by === "start" ? "it stood at" : "it stands at"} ${show(set[k].value)}, the settings file says ${show(file[k])}`, set: set[k].value, file: file[k], setAt: set[k].at }));
}
