import type { EventLog } from "../events.js";
import { getEntry, listCatalog, type CatalogEntry } from "./catalog.js";

/**
 * Trials (docs/configuration.md, part 4 of the brief of 22 Nov 2026).
 *
 * A ready catalog entry with settings can go on trial. While it is on trial, every second piece of work gets it
 * (a ticket, or a factory run with no ticket, chosen by its id: even ids get it, odd ids do not). Each call records
 * which side it was on. When both sides have TRIAL_RUNS finished pieces, SoftwareFactory decides:
 *   promoted  clearly better (pass rate at least 20 points higher) and costs no more than 20% extra: it applies everywhere
 *   dropped   worse (lower pass rate, or the same pass rate for more than 20% extra)
 *   unclear   anything else: it stays on trial and asks you (Promote or Drop on the Configuration page)
 * A piece is finished when its ticket's pull request merged (pass), or it was rejected or its PR closed unmerged (fail);
 * a factory run passes when it shipped and fails when it failed. Stopped runs and open tickets do not count.
 */
export const TRIAL_RUNS = 5;
export const TRIAL_BETTER = 0.2;
export const TRIAL_COST = 1.2;

export type Arm = "with" | "without";

export function armOf(unit: { ticket: number | null; factoryRun: number | null }): { unit: string; arm: Arm } | null {
  const id = unit.ticket ?? unit.factoryRun;
  if (id == null) return null;
  return { unit: unit.ticket != null ? `ticket:${unit.ticket}` : `run:${unit.factoryRun}`, arm: id % 2 === 0 ? "with" : "without" };
}

/** The entries on trial now. */
export function onTrial(log: EventLog): CatalogEntry[] {
  return listCatalog(log).filter((e) => e.state === "trial" && (e.settings?.length ?? 0) > 0);
}

/** Entries promoted by a trial or by you: their settings apply everywhere, under any profile. */
export function promoted(log: EventLog): CatalogEntry[] {
  return listCatalog(log).filter((e) => e.state === "promoted" && (e.settings?.length ?? 0) > 0);
}

export function canTrial(e: CatalogEntry | null): string | null {
  if (!e) return "No catalog entry with that id.";
  if (!e.settings?.length) return "Only an entry that is settings (or built behind a feature switch, feature.<id>) can go on trial; build it first.";
  if (!["ready", "trial", "dropped"].includes(e.state)) return `It is ${e.state}; it must be built (ready) first.`;
  return null;
}

interface Unit { unit: string; arm: Arm; costUsd: number; ms: number; pass: boolean | null }

/** How one piece of work ended: true passed, false failed, null not finished (or not counted). */
function outcome(log: EventLog, unit: string): boolean | null {
  const [kind, raw] = unit.split(":");
  const id = Number(raw);
  try {
    if (kind === "ticket") {
      const t = log.db.prepare("SELECT status, pr_state FROM tickets WHERE id = ?").get(id) as { status: string; pr_state: string | null } | undefined;
      if (!t) return null;
      if (t.pr_state === "merged") return true;
      if (t.status === "rejected" || t.pr_state === "closed") return false;
      const dupe = log.db.prepare("SELECT 1 FROM ticket_links WHERE from_id = ? AND relation = 'duplicate_of' LIMIT 1").get(id);
      if (t.status === "closed" && !dupe) return false;
      return null;
    }
    const r = log.db.prepare("SELECT outcome FROM factory_runs WHERE id = ?").get(id) as { outcome: string | null } | undefined;
    return r?.outcome === "shipped" ? true : r?.outcome === "failed" ? false : null;
  } catch { return null; }
}

/** Every piece of work that ran while the entry was on trial, with its side, cost, time and result. */
export function trialUnits(log: EventLog, entryId: string): Unit[] {
  const rows = log.db.prepare(`SELECT s.payload AS p, a.cost_usd AS cost, a.duration_ms AS ms FROM events s LEFT JOIN agent_runs a ON a.id = s.id
    WHERE s.type = 'agent.run.started' AND json_extract(s.payload, '$.trial.entry') = ?`).all(entryId) as { p: string; cost: number | null; ms: number | null }[];
  const m = new Map<string, Unit>();
  for (const row of rows) {
    const t = (JSON.parse(row.p) as { trial: { unit: string; arm: Arm } }).trial;
    const u = m.get(t.unit) ?? { unit: t.unit, arm: t.arm, costUsd: 0, ms: 0, pass: null };
    u.costUsd += Number(row.cost ?? 0);
    u.ms += Number(row.ms ?? 0);
    m.set(t.unit, u);
  }
  for (const u of m.values()) u.pass = outcome(log, u.unit);
  return [...m.values()];
}

export interface TrialSide { finished: number; passed: number; passRate: number | null; avgUsd: number | null; avgMinutes: number | null; running: number }
export interface TrialReport {
  entry: string;
  sides: Record<Arm, TrialSide>;
  verdict: "running" | "promote" | "drop" | "unclear";
  why: string;
}

export function trialReport(log: EventLog, entryId: string): TrialReport {
  const units = trialUnits(log, entryId);
  const side = (arm: Arm): TrialSide => {
    const all = units.filter((u) => u.arm === arm);
    const done = all.filter((u) => u.pass !== null);
    const passed = done.filter((u) => u.pass).length;
    return {
      finished: done.length, passed, running: all.length - done.length,
      passRate: done.length ? passed / done.length : null,
      avgUsd: done.length ? done.reduce((a, u) => a + u.costUsd, 0) / done.length : null,
      avgMinutes: done.length ? done.reduce((a, u) => a + u.ms, 0) / done.length / 60000 : null,
    };
  };
  const sides = { with: side("with"), without: side("without") };
  const w = sides.with;
  const wo = sides.without;
  if (w.finished < TRIAL_RUNS || wo.finished < TRIAL_RUNS) {
    return { entry: entryId, sides, verdict: "running", why: `${w.finished} of ${TRIAL_RUNS} pieces finished with it, ${wo.finished} of ${TRIAL_RUNS} without.` };
  }
  const pw = w.passRate ?? 0;
  const po = wo.passRate ?? 0;
  const cw = w.avgUsd ?? 0;
  const co = wo.avgUsd ?? 0;
  const pricier = co > 0 ? cw > co * TRIAL_COST + 1e-9 : cw > 0.05;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const said = `With it ${pct(pw)} passed at $${cw.toFixed(2)} each; without it ${pct(po)} at $${co.toFixed(2)}.`;
  if (pw - po >= TRIAL_BETTER - 1e-9 && !pricier) return { entry: entryId, sides, verdict: "promote", why: `Clearly better and not more than 20% pricier. ${said}` };
  if (pw < po - 1e-9 || (Math.abs(pw - po) < 1e-9 && pricier)) return { entry: entryId, sides, verdict: "drop", why: `Worse. ${said}` };
  return { entry: entryId, sides, verdict: "unclear", why: `Not clearly better or worse; your call. ${said}` };
}

/** Decide every trial that has enough finished pieces. Unclear ones are noted once and wait for you. */
export function decideTrials(log: EventLog, setState: (id: string, state: "promoted" | "dropped", note: string) => void): TrialReport[] {
  const out: TrialReport[] = [];
  for (const e of onTrial(log)) {
    const r = trialReport(log, e.id);
    out.push(r);
    if (r.verdict === "promote") setState(e.id, "promoted", `Trial: ${r.why}`);
    else if (r.verdict === "drop") setState(e.id, "dropped", `Trial: ${r.why}`);
    else if (r.verdict === "unclear" && getEntry(log, e.id)?.note !== `Trial: ${r.why}`) log.append("catalog.entry.state", { id: e.id, state: "trial", by: "trial", note: `Trial: ${r.why}` });
  }
  return out;
}

/**
 * The first real trial, put on at start once (24 Nov 2026, Assaf: Configuration is finished by being used, not
 * shrunk). The crew has run with the advisor since 19 Nov and nobody measured whether it helps. Every second
 * ticket now runs without it; after 5 finished tickets on each side the trial decides: dropped means the advisor
 * earns its cost and stays; promoted means the crew lands as much without it, for less.
 * An entry that exists already, in any state, is left as it is: you may have dropped or decided it.
 */
export const FIRST_TRIAL_ID = "crew-without-advisor";
export function seedFirstTrial(log: EventLog, save: (e: Partial<CatalogEntry>) => void): boolean {
  if (getEntry(log, FIRST_TRIAL_ID)) return false;
  save({
    id: FIRST_TRIAL_ID,
    title: "Crew without the advisor",
    what: "The crew's Builder and Fixer work without the Opus advisor. Measures whether the advisor (on since 19 Nov) helps crew pull requests land, against what it costs.",
    kind: "setting",
    source: { kind: "you", label: "First trial, from the 24 Nov audit" },
    touches: ["advisor"],
    settings: [{ path: "advisor.model", value: "off", why: "Is the advisor worth it for the crew? Never measured." }],
    state: "trial",
  });
  return true;
}
