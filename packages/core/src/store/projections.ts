import type { DatabaseSync } from "node:sqlite";
import type { SfEvent } from "../events.js";

/**
 * Projections turn the event log into organized, typed tables.
 *
 * The event log is the source of truth. Each projection owns a few tables,
 * creates them in `migrate`, and keeps them current in `apply`, which runs in
 * the same transaction as the event's insert, so a table is never behind the
 * log. A projection with a newer `version` than the one stored is dropped and
 * rebuilt from the log on open; a projection that is new to an existing
 * database is backfilled the same way. Nothing is lost: tables are derived.
 *
 * To add one (for example the Agent Bay's agents), call registerProjection at
 * module load, before the EventLog opens, or log.addProjection afterwards.
 */
export interface ProjectionContext {
  /** Read the log (used by projections that materialize a folded view). */
  view<T>(name: string, compute: (events: SfEvent[]) => T): T;
}

export interface Projection {
  name: string;
  /** Bump to rebuild the tables from the log on next open. */
  version: number;
  /** Tables this projection owns; dropped on rebuild. */
  tables: string[];
  /** Plain-language line for the Bridge's Data deck. */
  describe: string;
  migrate(db: DatabaseSync): void;
  /** Keep the tables current for one event. Runs inside the append transaction. */
  apply?(db: DatabaseSync, e: SfEvent): void;
  /**
   * Optional: after a batch of events (one append, or a whole backfill), rewrite
   * the tables from a folded view. For state too rich to update row by row.
   */
  flush?(db: DatabaseSync, ctx: ProjectionContext, types: Set<string>): void;
}

const registry = new Map<string, Projection>();

export function registerProjection(p: Projection) {
  registry.set(p.name, p);
}

export function registeredProjections(): Projection[] {
  return [...registry.values()];
}
