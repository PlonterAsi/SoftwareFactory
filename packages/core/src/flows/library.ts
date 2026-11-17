import type { EventLog } from "../events.js";
import { registerProjection, type Projection } from "../store/projections.js";
import { BUILT_IN_FLOWS, assertFlow, builtInFlowFor, flowProblems, type FlowDef } from "./flow.js";

/**
 * Where flows are kept. Every save is a `flow.saved` event with the whole definition, so each version stays
 * on the record and a run can always be read against the flow it ran. The `flows` table holds every version:
 *
 *   SELECT id, version, name, saved_by, saved_at FROM flows ORDER BY id, version;
 *
 * A flow nobody saved yet is the built-in one, straight from the code (flow.ts).
 */
export const flowsProjection: Projection = {
  name: "flows",
  version: 1,
  tables: ["flows"],
  describe: "Flows: each saved version of a flow definition (steps, loops, gates, agent per step) that runs follow and the canvas draws",
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS flows (
      id        TEXT NOT NULL,
      version   INTEGER NOT NULL,
      name      TEXT NOT NULL,
      def       TEXT NOT NULL,
      saved_by  TEXT NOT NULL,
      saved_at  TEXT NOT NULL,
      event_id  INTEGER NOT NULL,
      PRIMARY KEY (id, version)
    )`);
  },
  apply(db, e) {
    if (e.type !== "flow.saved") return;
    const f = (e.payload as { flow: FlowDef; by?: string }).flow;
    db.prepare("INSERT OR REPLACE INTO flows (id, version, name, def, saved_by, saved_at, event_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(String(f.id), Number(f.version), String(f.name), JSON.stringify(f), String((e.payload as { by?: string }).by ?? "you"), e.ts, e.id);
  },
};
registerProjection(flowsProjection);

export interface FlowSummary {
  id: string;
  name: string;
  purpose: string;
  version: number;
  builtIn: boolean;
  steps: number;
  savedBy: string | null;
  savedAt: string | null;
}

/** The flow library: the built-in flows, and every flow saved over them or beside them. */
export class FlowLibrary {
  constructor(private log: EventLog) {}

  /** The flow by id: its latest saved version, else the built-in one. Undefined when there is no such flow. */
  get(id: string): FlowDef | undefined {
    const row = this.log.db.prepare("SELECT def FROM flows WHERE id = ? ORDER BY version DESC LIMIT 1").get(id) as { def: string } | undefined;
    if (row) return JSON.parse(row.def) as FlowDef;
    const b = BUILT_IN_FLOWS.find((f) => f.id === id);
    return b ? structuredClone(b) : undefined;
  }

  /** One saved version of a flow (version 1 of a built-in that was never saved is the built-in). */
  version(id: string, version: number): FlowDef | undefined {
    const row = this.log.db.prepare("SELECT def FROM flows WHERE id = ? AND version = ?").get(id, version) as { def: string } | undefined;
    if (row) return JSON.parse(row.def) as FlowDef;
    const b = BUILT_IN_FLOWS.find((f) => f.id === id && f.version === version);
    return b ? structuredClone(b) : undefined;
  }

  /** Every version saved of a flow, oldest first. */
  history(id: string): { version: number; savedBy: string; savedAt: string }[] {
    return (this.log.db.prepare("SELECT version, saved_by, saved_at FROM flows WHERE id = ? ORDER BY version").all(id) as { version: number; saved_by: string; saved_at: string }[])
      .map((r) => ({ version: Number(r.version), savedBy: r.saved_by, savedAt: r.saved_at }));
  }

  list(): FlowSummary[] {
    const rows = this.log.db.prepare("SELECT id, def, saved_by, saved_at FROM flows f WHERE version = (SELECT max(version) FROM flows g WHERE g.id = f.id) ORDER BY id").all() as { id: string; def: string; saved_by: string; saved_at: string }[];
    const saved = new Map(rows.map((r) => [r.id, r]));
    const out: FlowSummary[] = [];
    const sum = (f: FlowDef, by: string | null, at: string | null): FlowSummary => ({ id: f.id, name: f.name, purpose: f.purpose, version: f.version, builtIn: f.builtIn, steps: f.steps.length, savedBy: by, savedAt: at });
    for (const b of BUILT_IN_FLOWS) {
      const r = saved.get(b.id);
      out.push(r ? sum(JSON.parse(r.def), r.saved_by, r.saved_at) : sum(b, null, null));
      saved.delete(b.id);
    }
    for (const r of saved.values()) out.push(sum(JSON.parse(r.def), r.saved_by, r.saved_at));
    return out;
  }

  /**
   * Save a flow as its next version. Refused, with every problem said, when the engine could not run it.
   * A built-in flow saved with changes is no longer marked built-in.
   */
  save(def: FlowDef, by = "you"): FlowDef {
    const problems = flowProblems(def);
    if (problems.length) throw new Error(`This flow cannot be saved: ${problems.join(" ")}`);
    const current = this.get(def.id);
    const builtIn = BUILT_IN_FLOWS.find((f) => f.id === def.id);
    const { version: _v, builtIn: _b, ...rest } = def;
    const bare = (f: Partial<FlowDef>) => { const { version: _a, builtIn: _c, ...x } = f; return JSON.stringify(x); };
    const same = !!builtIn && bare(rest) === bare(builtIn);
    const flow: FlowDef = { ...rest, version: (current?.version ?? 0) + 1, builtIn: same };
    this.log.append("flow.saved", { flow, by });
    return flow;
  }

  /** Put a flow back to what SoftwareFactory ships, as its next version (the edits stay in its history). */
  reset(id: string, by = "you"): FlowDef {
    const b = BUILT_IN_FLOWS.find((f) => f.id === id);
    if (!b) throw new Error(`"${id}" is not a built-in flow, so there is nothing to put it back to.`);
    return this.save(structuredClone(b), by);
  }

  /** The flow a new run of this kind follows: the chosen one by id, else the kind's own. Checked before use. */
  forRun(kind?: string, chosen?: string): FlowDef {
    const id = chosen ?? builtInFlowFor(kind).id;
    const f = this.get(id);
    if (!f) throw new Error(`There is no flow "${id}".`);
    return assertFlow(f);
  }
}

/**
 * The flow a run follows: the copy on its started event (a run keeps the flow it started with, even when the
 * flow is edited later), else, for runs started before flows existed, the built-in flow of its kind.
 */
export function flowOfRun(log: EventLog, run: number): FlowDef {
  const started = log.get(run);
  const p = (started?.type === "factory.run.started" ? started.payload : {}) as { flow?: FlowDef; kind?: string };
  return p.flow ? assertFlow(p.flow) : structuredClone(builtInFlowFor(p.kind));
}
