import type { EventLog } from "../events.js";
import { registerProjection, type Projection } from "../store/projections.js";
import { DEFAULT_FEATURES, FEATURE_GROUPS, type FeatureGroup, type FeatureRecord } from "./records.js";
import { WIRING, type FileWiring } from "./wiring.generated.js";

/**
 * The feature map: every feature's record, folded with the wiring read from the code
 * (wiring.generated.ts) and the proof of life in this base's event log.
 *
 * Records come from records.ts; the person's edits and the features they add are events:
 *   featuremap.record.saved { id, name, group, purpose, spec, flow, design, screens, docs, stations, by }
 *   featuremap.record.reset { id, by }    back to the record in code (or removed, for one the person added)
 * What a feature owns in code (files, API areas) is never edited in the app: it is checked against
 * the code by test/featuremap.test.ts.
 */
export interface FeatureLink {
  feature: string;
  name: string;
  /** How many imports cross from one feature's files to the other's. */
  code: number;
  /** Event types one writes and the other reads. */
  events: string[];
  /** API areas one screen calls and the other answers. */
  api: string[];
  /** Tables one creates and the other queries. */
  tables: string[];
}

export type FeatureState = "alive" | "never" | "untraced" | "planned";

export interface FeatureView extends FeatureRecord {
  builtin: boolean;
  edited: boolean;
  version: number;
  updatedAt: string | null;
  by: string | null;
  code: { files: { path: string; lines: number }[]; lines: number };
  /** Event types its files append. */
  writes: string[];
  /** Event types its files read. */
  reads: string[];
  /** Tables its files create. */
  tables: string[];
  /** Features it depends on, and features that depend on it. */
  uses: FeatureLink[];
  usedBy: FeatureLink[];
  /** Proof of life from this base's log. */
  alive: { events: number; lastAt: string | null; lastType: string | null; calls: number; lastCallAt: string | null; byType: { type: string; n: number; lastAt: string }[] };
  state: FeatureState;
  /** Loose ends, as plain sentences. */
  loose: string[];
}

export interface FeatureMap {
  features: FeatureView[];
  groups: FeatureGroup[];
  totals: { features: number; alive: number; never: number; untraced: number; planned: number; files: number; lines: number; events: number; tables: number; apiAreas: number };
  /** Things connected to nothing, across the whole app. */
  loose: {
    /** Source files no record owns (the check fails on these). */
    unownedFiles: string[];
    /** API areas the core answers that no record claims (the check fails on these). */
    unownedApi: string[];
    /** Event types that are declared but nothing ever writes. */
    eventsNeverWritten: string[];
    /** Event types that are written but nothing in the code reads by name. */
    eventsNeverRead: { type: string; feature: string | null }[];
    /** API areas the core answers but no screen calls. */
    apiNeverCalled: { area: string; feature: string | null }[];
  };
}

/** Evidence a feature ran when the event is written by another feature's file (the engine loop writes for its stations). */
const PROOF: Record<string, string[]> = {
  council: ["factory.council"],
  "design-loop": ["factory.discovery", "factory.research"],
  "build-loop": ["factory.feature"],
  checks: ["factory.tests", "factory.tests.locked", "factory.tests.dryrun", "factory.screens", "factory.links", "factory.fastgate", "factory.visual"],
  judge: ["factory.evaluation", "factory.screen.look"],
  "engine-review": ["factory.retro"],
  recall: ["factory.recall"],
  "needs-you": ["factory.gate"],
  money: ["project.budget", "factory.budget"],
  mission: ["factory.plan"],
  "crew-prs": ["ticket.branch"],
  "use-apps": ["launch.started"],
};

/** Features whose events are kept outside a base's log, so the log cannot prove them either way. */
const ELSEWHERE: Record<string, string> = {
  bases: "Its events are kept in the app's own registry of bases, not in this base's log, so the map cannot show when it was last used.",
};

type Saved = Omit<FeatureRecord, "files" | "api"> & { by?: string };

const clean = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
const lines = (v: unknown, max = 20) => (Array.isArray(v) ? v : String(v ?? "").split("\n")).map((x) => clean(x, 400)).filter(Boolean).slice(0, max);

/** The records as they stand now: the ones in code with every saved change applied. */
export function featureRecords(log?: EventLog | null): (FeatureRecord & Pick<FeatureView, "builtin" | "edited" | "version" | "updatedAt" | "by">)[] {
  const views = new Map(DEFAULT_FEATURES.map((r) => [r.id, { ...r, builtin: true, edited: false, version: 0, updatedAt: null as string | null, by: null as string | null }]));
  if (!log) return [...views.values()];
  const evs = [...log.list({ type: "featuremap.record.saved", limit: 1e6 }), ...log.list({ type: "featuremap.record.reset", limit: 1e6 })].sort((a, b) => a.id - b.id);
  for (const e of evs) {
    const p = e.payload as Saved;
    const def = DEFAULT_FEATURES.find((d) => d.id === p.id);
    const cur = views.get(p.id);
    const version = (cur?.version ?? 0) + 1;
    if (e.type === "featuremap.record.reset") {
      if (def) views.set(p.id, { ...def, builtin: true, edited: false, version, updatedAt: e.ts, by: p.by ?? "you" });
      else views.delete(p.id);
      continue;
    }
    views.set(p.id, {
      id: p.id, name: p.name, group: FEATURE_GROUPS.includes(p.group) ? p.group : "Library", purpose: p.purpose, spec: p.spec ?? [], flow: p.flow ?? [], design: p.design ?? "",
      screens: p.screens ?? [], docs: p.docs ?? [], stations: p.stations ?? [], files: def?.files ?? [], api: def?.api ?? [],
      builtin: !!def, edited: !!def, version, updatedAt: e.ts, by: p.by ?? "you",
    });
  }
  return [...views.values()];
}

export interface FeatureInput { name: string; group?: string; purpose: string; spec?: string[] | string; flow?: string[] | string; design?: string; screens?: string[] | string; docs?: string[] | string; stations?: string[] }

/** Save a record (a new planned feature, or a new version of one). Returns its id. */
export function saveFeature(log: EventLog, id: string | null, input: FeatureInput, by = "you"): string {
  const name = clean(input.name, 80);
  const purpose = clean(input.purpose, 1200);
  if (!name) throw new Error("A feature needs a name");
  if (!purpose) throw new Error("A feature needs its purpose: why it exists, in a sentence or two");
  const all = featureRecords(log);
  let fid = id;
  if (!fid) {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "feature";
    const taken = new Set(all.map((f) => f.id));
    fid = base;
    for (let n = 2; taken.has(fid); n++) fid = `${base}-${n}`;
  } else if (!all.some((f) => f.id === fid)) throw new Error(`No feature "${fid}"`);
  const group = FEATURE_GROUPS.includes(input.group as FeatureGroup) ? (input.group as FeatureGroup) : (all.find((f) => f.id === fid)?.group ?? "Library");
  const payload: Saved = {
    id: fid, name, group, purpose, spec: lines(input.spec), flow: lines(input.flow), design: clean(input.design, 1200),
    screens: lines(input.screens, 12), docs: lines(input.docs, 12), stations: (input.stations ?? []).map((s) => clean(s, 40)).filter(Boolean).slice(0, 20), by,
  };
  log.append("featuremap.record.saved", payload);
  return fid;
}

export function resetFeature(log: EventLog, id: string, by = "you") {
  if (!featureRecords(log).some((f) => f.id === id)) throw new Error(`No feature "${id}"`);
  log.append("featuremap.record.reset", { id, by });
}

/** Which record owns each source file: the longest matching folder or file wins. */
export function ownersOf(records: Pick<FeatureRecord, "id" | "files">[], files: string[] = Object.keys(WIRING.files)): Map<string, string> {
  const owner = new Map<string, string>();
  for (const f of files) {
    let best = "", bestLen = -1;
    for (const r of records) for (const p of r.files) {
      const hit = p.endsWith("/") ? f.startsWith(p) : f === p;
      if (hit && p.length > bestLen) { best = r.id; bestLen = p.length; }
    }
    if (best) owner.set(f, best);
  }
  return owner;
}

const matches = (read: string, type: string) => (read.endsWith("*") ? type.startsWith(read.slice(0, -1)) : read === type);

/** The whole map. `log` adds the person's edits and the proof of life; without it the map is the code alone. */
export function featureMap(log?: EventLog | null, wiring: { events: string[]; tables: string[]; files: Record<string, FileWiring> } = WIRING): FeatureMap {
  const records = featureRecords(log);
  const paths = Object.keys(wiring.files);
  const owner = ownersOf(records, paths);
  const name = new Map(records.map((r) => [r.id, r.name]));
  const filesOf = new Map<string, string[]>(records.map((r) => [r.id, []]));
  for (const [f, id] of owner) filesOf.get(id)!.push(f);

  const writerOf = new Map<string, string>();   // event type -> feature that writes it
  const tableOf = new Map<string, string>();    // table -> feature that creates it
  const apiOf = new Map<string, string>();      // API area -> feature that claims it
  for (const r of records) for (const a of r.api) apiOf.set(a, r.id);
  for (const [f, w] of Object.entries(wiring.files)) {
    const id = owner.get(f);
    if (!id) continue;
    for (const t of w.writes ?? []) if (!writerOf.has(t)) writerOf.set(t, id);
    for (const t of w.creates ?? []) tableOf.set(t, id);
  }

  // Proof of life, from the log.
  const byType = new Map<string, { n: number; lastAt: string }>();
  const byStation = new Map<string, { n: number; lastAt: string }>();
  if (log) {
    try {
      for (const r of log.db.prepare("SELECT type, count(*) AS n, max(ts) AS last FROM events GROUP BY type").all() as { type: string; n: number; last: string }[]) byType.set(r.type, { n: Number(r.n), lastAt: r.last });
      for (const r of log.db.prepare("SELECT station, count(*) AS n, max(started_at) AS last FROM agent_runs WHERE station IS NOT NULL GROUP BY station").all() as { station: string; n: number; last: string }[]) byStation.set(r.station, { n: Number(r.n), lastAt: r.last });
    } catch { /* no tables yet: nothing has run */ }
  }

  const total = { n: [...byType.values()].reduce((x, y) => x + y.n, 0), lastAt: [...byType.values()].map((x) => x.lastAt).sort().at(-1) ?? null };
  const links = new Map<string, Map<string, FeatureLink>>(); // from -> to -> link
  const link = (from: string, to: string) => {
    if (!links.has(from)) links.set(from, new Map());
    const m = links.get(from)!;
    if (!m.has(to)) m.set(to, { feature: to, name: name.get(to) ?? to, code: 0, events: [], api: [], tables: [] });
    return m.get(to)!;
  };
  const add = (xs: string[], x: string) => { if (!xs.includes(x)) xs.push(x); };
  const readAll = new Set<string>();
  const calledApi = new Set<string>();
  for (const [f, w] of Object.entries(wiring.files)) {
    const from = owner.get(f);
    for (const r of w.reads ?? []) readAll.add(r);
    for (const a of w.calls ?? []) calledApi.add(a);
    if (!from) continue;
    for (const i of w.imports ?? []) { const to = owner.get(i); if (to && to !== from) link(from, to).code++; }
    for (const r of w.reads ?? []) for (const [t, to] of writerOf) if (to !== from && matches(r, t)) add(link(from, to).events, t);
    for (const a of w.calls ?? []) { const to = apiOf.get(a); if (to && to !== from) add(link(from, to).api, a); }
    for (const t of w.sql ?? []) { const to = tableOf.get(t); if (to && to !== from) add(link(from, to).tables, t); }
  }
  const weight = (l: FeatureLink) => l.code + l.events.length + l.api.length + l.tables.length;
  const sorted = (xs: FeatureLink[]) => xs.sort((a, b) => weight(b) - weight(a) || a.name.localeCompare(b.name));

  const servedApi = new Set(Object.values(wiring.files).flatMap((w) => w.serves ?? []));
  const neverRead = wiring.events.filter((t) => writerOf.has(t) && ![...readAll].some((r) => matches(r, t)));

  const features: FeatureView[] = records.map((r) => {
    const mine = (filesOf.get(r.id) ?? []).sort();
    const ws = mine.map((f) => wiring.files[f]);
    const uniq = (xs: string[]) => [...new Set(xs)].sort();
    const writes = uniq(ws.flatMap((w) => w.writes ?? []));
    const reads = uniq(ws.flatMap((w) => w.reads ?? []));
    const tables = uniq(ws.flatMap((w) => w.creates ?? []));
    const uses = sorted([...(links.get(r.id)?.values() ?? [])]);
    const usedBy = sorted([...links].filter(([from]) => from !== r.id).flatMap(([from, m]) => { const l = m.get(r.id); return l ? [{ ...l, feature: from, name: name.get(from) ?? from }] : []; }));

    const evidence = ELSEWHERE[r.id] ? [] : uniq([...writes, ...(PROOF[r.id] ?? [])]);
    const seen = evidence.map((t) => ({ type: t, ...(byType.get(t) ?? { n: 0, lastAt: "" }) })).filter((x) => x.n > 0).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
    const calls = r.stations.map((s) => byStation.get(s)).filter((x): x is { n: number; lastAt: string } => !!x);
    const alive = {
      events: seen.reduce((s, x) => s + x.n, 0), lastAt: seen[0]?.lastAt ?? null, lastType: seen[0]?.type ?? null,
      calls: calls.reduce((s, x) => s + x.n, 0), lastCallAt: calls.map((c) => c.lastAt).sort().at(-1) ?? null, byType: seen.slice(0, 12),
    };
    // The log itself is the storage feature's proof: any event at all means it works.
    if (r.id === "storage" && total.n > 0) Object.assign(alive, { events: total.n, lastAt: total.lastAt, lastType: null });
    // Agent calls prove a feature only when being read on a call is its use (the Brain), or it leaves no events of its own.
    const callsProve = r.id === "brain" || !evidence.length;
    const state: FeatureState = !mine.length ? "planned" : alive.events > 0 || (callsProve && alive.calls > 0) ? "alive" : evidence.length || r.stations.length ? "never" : "untraced";

    const loose: string[] = [];
    if (state === "never") loose.push(log ? "It has never run in this base: none of its events are in the log." : "No log was read, so nothing says it ran.");
    if (state === "untraced") loose.push(ELSEWHERE[r.id] ?? "It writes no events, so the app cannot show when it was last used.");
    if (state === "planned") loose.push("No code belongs to it yet: it is a plan.");
    if (mine.length && !usedBy.length && !r.screens.length) loose.push("Nothing else depends on it and it has no screen.");
    const quiet = writes.filter((t) => neverRead.includes(t));
    if (quiet.length) loose.push(`It writes ${quiet.length === 1 ? "an event" : `${quiet.length} events`} that nothing reads by name: ${quiet.join(", ")}.`);
    const uncalled = r.api.filter((a) => servedApi.has(a) && !calledApi.has(a));
    if (uncalled.length) loose.push(`No screen calls ${uncalled.join(", ")}.`);
    const dead = r.api.filter((a) => !servedApi.has(a));
    if (dead.length && mine.length) loose.push(`Its record names ${dead.join(", ")}, which the core does not answer.`);
    if (!r.docs.length) loose.push("No document describes it.");
    if (!r.spec.length || r.flow.length < 2 || !r.design) loose.push("Its record is incomplete: it needs a spec, a flow of at least two steps and a design.");

    return { ...r, code: { files: mine.map((f) => ({ path: f, lines: wiring.files[f].lines })), lines: mine.reduce((s, f) => s + wiring.files[f].lines, 0) }, writes, reads, tables, uses, usedBy, alive, state, loose };
  });

  const count = (s: FeatureState) => features.filter((f) => f.state === s).length;
  return {
    features, groups: FEATURE_GROUPS,
    totals: {
      features: features.length, alive: count("alive"), never: count("never"), untraced: count("untraced"), planned: count("planned"),
      files: paths.length, lines: paths.reduce((s, f) => s + wiring.files[f].lines, 0), events: wiring.events.length, tables: wiring.tables.length, apiAreas: servedApi.size,
    },
    loose: {
      unownedFiles: paths.filter((f) => !owner.has(f)),
      unownedApi: [...servedApi].filter((a) => !apiOf.has(a)).sort(),
      eventsNeverWritten: wiring.events.filter((t) => !writerOf.has(t)),
      eventsNeverRead: neverRead.map((t) => ({ type: t, feature: writerOf.get(t) ?? null })),
      apiNeverCalled: [...servedApi].filter((a) => !calledApi.has(a)).sort().map((a) => ({ area: a, feature: apiOf.get(a) ?? null })),
    },
  };
}

/** What the check says is wrong with the records, as sentences. Empty means every feature has its record. */
export function recordProblems(records: FeatureRecord[] = DEFAULT_FEATURES, wiring = WIRING, docExists: (path: string) => boolean = () => true): string[] {
  const out: string[] = [];
  const paths = Object.keys(wiring.files);
  const owner = ownersOf(records, paths);
  const where = "packages/core/src/featuremap/records.ts";
  for (const f of paths) if (!owner.has(f)) out.push(`${f} belongs to no feature. Add it to the files of a record in ${where}, or write a record for the new feature.`);
  const served = new Set(Object.values(wiring.files).flatMap((w) => w.serves ?? []));
  const claimed = new Map<string, string>();
  const ids = new Set<string>();
  for (const r of records) {
    if (ids.has(r.id)) out.push(`Two records share the id "${r.id}".`);
    ids.add(r.id);
    if (r.purpose.trim().length < 40) out.push(`"${r.name}" needs a purpose of at least a full sentence.`);
    if (!r.spec.length) out.push(`"${r.name}" has no spec: say what it must do, one requirement per line.`);
    if (r.flow.length < 2) out.push(`"${r.name}" needs a flow of at least two steps.`);
    if (!r.design.trim()) out.push(`"${r.name}" has no design: say where it lives in the app.`);
    if (!r.docs.length) out.push(`"${r.name}" names no document.`);
    for (const d of r.docs) if (!docExists(d)) out.push(`"${r.name}" names ${d}, which does not exist.`);
    for (const p of r.files) if (!paths.some((f) => (p.endsWith("/") ? f.startsWith(p) : f === p))) out.push(`"${r.name}" claims ${p}, which matches no source file.`);
    if (!r.files.length) out.push(`"${r.name}" owns no source. A record in code is for a built feature; add planned ones in the app.`);
    for (const a of r.api) {
      if (!served.has(a)) out.push(`"${r.name}" claims ${a}, which the core does not answer.`);
      if (claimed.has(a)) out.push(`${a} is claimed by both "${claimed.get(a)}" and "${r.name}".`);
      claimed.set(a, r.name);
    }
  }
  for (const a of served) if (!claimed.has(a)) out.push(`The API area ${a} belongs to no feature. Add it to the api of a record in ${where}.`);
  return out;
}

/** Edited and added records in the Data vault: one row per record the person changed. */
export const featureMapProjection: Projection = {
  name: "featuremap",
  version: 1,
  tables: ["feature_records"],
  describe: "The Feature map: records the person edited or added (the rest live in code)",
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS feature_records (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      grp        TEXT NOT NULL,
      purpose    TEXT NOT NULL,
      by_who     TEXT,
      updated_at TEXT NOT NULL,
      event_id   INTEGER NOT NULL
    )`);
  },
  apply(db, e) {
    const p = e.payload as Saved;
    if (e.type === "featuremap.record.saved") {
      db.prepare(`INSERT INTO feature_records (id, name, grp, purpose, by_who, updated_at, event_id) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, grp = excluded.grp, purpose = excluded.purpose, by_who = excluded.by_who, updated_at = excluded.updated_at, event_id = excluded.event_id`)
        .run(p.id, p.name, p.group, p.purpose, p.by ?? null, e.ts, e.id);
    } else if (e.type === "featuremap.record.reset") {
      db.prepare("DELETE FROM feature_records WHERE id = ?").run(p.id);
    }
  },
};
registerProjection(featureMapProjection);
