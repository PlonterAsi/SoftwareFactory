import type { EventLog } from "../events.js";
import { registerProjection, type Projection } from "../store/projections.js";
import { BUILT_IN_FLOWS, RUNNER_WORD, assertFlow, builtInFlowFor, flowProblems, runnerOf, type FlowDef, type FlowRunner } from "./flow.js";

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
  runner: FlowRunner;
  kinds: string[];
  door: string | null;
  steps: number;
  savedBy: string | null;
  savedAt: string | null;
}

/** The flow library: the built-in flows, and every flow saved over them or beside them. */
export class FlowLibrary {
  /** The ids of the Agent Bay's active agents, when a Bay is there: saving a flow that names any other is refused. */
  agentsKnown?: () => Set<string>;
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
    const sum = (f: FlowDef, by: string | null, at: string | null): FlowSummary => ({ id: f.id, name: f.name, purpose: f.purpose, version: f.version, builtIn: f.builtIn, runner: runnerOf(f), kinds: f.kinds ?? [], door: f.door ?? null, steps: f.steps.length, savedBy: by, savedAt: at });
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
    const current = this.get(def?.id);
    if (current && runnerOf(current) !== runnerOf(def)) throw new Error(`This flow cannot be saved: "${current.name}" is carried out by ${RUNNER_WORD[runnerOf(current)]}, and a saved version cannot change that. Save it under a new id instead.`);
    const problems = flowProblems(def);
    // A step may only name agents the Bay has (the core wires `agentsKnown` to the Agent Bay).
    const known = this.agentsKnown?.();
    if (known && Array.isArray(def?.steps)) for (const st of def.steps) for (const a of Array.isArray(st?.crew) ? st.crew : []) if (!known.has(a)) problems.push(`"${st.label ?? st.id}" names "${a}", which is not an active agent in the Agent Bay.`);
    if (problems.length) throw new Error(`This flow cannot be saved: ${problems.join(" ")}`);
    const builtIn = BUILT_IN_FLOWS.find((f) => f.id === def.id);
    const { version: _v, builtIn: _b, ...rest } = def;
    const bare = (f: Partial<FlowDef>) => { const { version: _a, builtIn: _c, ...x } = f; return JSON.stringify(x); };
    const same = !!builtIn && bare(rest) === bare(builtIn);
    if (runnerOf(def) === "door" && !same && builtIn) throw new Error(`This flow cannot be saved: "${builtIn.name}" is carried out by its own screen (${builtIn.door}), which does not read flows yet.`);
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
    const base = this.get(id);
    const f = base;
    if (!f) throw new Error(`There is no flow "${id}".`);
    if (runnerOf(f) !== "engine") throw new Error(`"${f.name}" is carried out by ${RUNNER_WORD[runnerOf(f)]}, not the engine.`);
    return assertFlow(f);
  }

  /** A flow carried out by `runner`, checked: the chosen one, else `fallback`. */
  forRunner(runner: FlowRunner, id: string): FlowDef {
    const f = this.get(id);
    if (!f) throw new Error(`There is no flow "${id}".`);
    if (runnerOf(f) !== runner) throw new Error(`"${f.name}" is carried out by ${RUNNER_WORD[runnerOf(f)]}, not ${RUNNER_WORD[runner]}.`);
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
