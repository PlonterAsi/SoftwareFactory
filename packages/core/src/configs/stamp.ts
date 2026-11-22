import type { EventLog } from "../events.js";
import { configHash, diffConfig, type ConfigDiff, type ConfigEntry } from "./inventory.js";

/**
 * "Ran with": every paid call records the setup it ran with (docs/configuration.md).
 *
 * The core registers one source of the current setup (setConfigSource). runAgent asks for its stamp before
 * each call: the hash goes on the call's agent.run.started event, and the first time a hash is seen its
 * whole list is kept once as a config.snapshot event. A run's or ticket's setups are the hashes on its calls.
 */
type Source = () => ConfigEntry[];
const sources = new WeakMap<EventLog, Source>();
const known = new WeakMap<EventLog, Set<string>>();

export function setConfigSource(log: EventLog, source: Source): void {
  sources.set(log, source);
}

/** The current setup's entries, or null when no source is registered (tests, the CLI). */
export function currentConfig(log: EventLog): ConfigEntry[] | null {
  const s = sources.get(log);
  return s ? s() : null;
}

/** The current setup's hash, keeping its snapshot the first time it is seen. Never throws: a call must not fail over this. */
export function stampConfig(log: EventLog): string | null {
  try {
    const entries = currentConfig(log);
    if (!entries) return null;
    const hash = configHash(entries);
    let seen = known.get(log);
    if (!seen) known.set(log, (seen = new Set()));
    if (!seen.has(hash)) {
      if (!snapshotOf(log, hash)) log.append("config.snapshot", { hash, entries });
      seen.add(hash);
    }
    return hash;
  } catch {
    return null;
  }
}

export interface ConfigSnapshot { hash: string; ts: string; entries: ConfigEntry[] }

export function snapshotOf(log: EventLog, hash: string): ConfigSnapshot | null {
  const row = log.db.prepare("SELECT ts, payload FROM events WHERE type = 'config.snapshot' AND json_extract(payload, '$.hash') = ? ORDER BY id LIMIT 1").get(hash) as { ts: string; payload: string } | undefined;
  if (!row) return null;
  const p = JSON.parse(row.payload) as { entries?: ConfigEntry[] };
  return { hash, ts: row.ts, entries: p.entries ?? [] };
}

export interface RanWith {
  hash: string;
  calls: number;
  first: string;
  last: string;
  /** What is different now, null when the snapshot is missing (calls made before setups were recorded). */
  sinceThen: ConfigDiff | null;
  sameAsNow: boolean;
}

/** The setups a factory run's or a ticket's calls ran with, oldest first, each compared with the setup now. */
export function ranWith(log: EventLog, by: { factoryRun?: number; ticket?: number }): { setups: RanWith[]; unrecorded: number } {
  let where: string;
  let args: number[];
  if (by.factoryRun !== undefined) {
    where = "json_extract(payload, '$.factoryRun') = ?";
    args = [by.factoryRun];
  } else if (by.ticket !== undefined) {
    // A ticket's own calls, and the calls of every factory run worked for it.
    let runs: number[] = [];
    try { runs = (log.db.prepare("SELECT run FROM ticket_runs WHERE ticket_id = ?").all(by.ticket) as { run: number }[]).map((r) => Number(r.run)); } catch { /* no tickets table in this log */ }
    where = `(json_extract(payload, '$.ticket') = ?${runs.length ? ` OR json_extract(payload, '$.factoryRun') IN (${runs.map(() => "?").join(",")})` : ""})`;
    args = [by.ticket, ...runs];
  } else return { setups: [], unrecorded: 0 };
  const rows = log.db.prepare(`SELECT json_extract(payload, '$.config') AS hash, count(*) AS calls, min(ts) AS first, max(ts) AS last
    FROM events WHERE type = 'agent.run.started' AND ${where} GROUP BY hash ORDER BY first`).all(...args) as { hash: string | null; calls: number; first: string; last: string }[];
  const now = currentConfig(log);
  const nowHash = now ? configHash(now) : null;
  const setups: RanWith[] = [];
  let unrecorded = 0;
  for (const r of rows) {
    if (!r.hash) { unrecorded += Number(r.calls); continue; }
    const snap = snapshotOf(log, r.hash);
    setups.push({
      hash: r.hash, calls: Number(r.calls), first: r.first, last: r.last,
      sinceThen: snap && now ? diffConfig(snap.entries, now) : null,
      sameAsNow: r.hash === nowHash,
    });
  }
  return { setups, unrecorded };
}
