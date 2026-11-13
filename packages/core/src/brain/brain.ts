import type { EventLog } from "../events.js";
import { SLOTS, type Slot } from "../bay/agentfile.js";
import { registerProjection, type Projection } from "../store/projections.js";

/**
 * The Brain: SoftwareFactory's principles, written once and read by every loop.
 *
 * A principle is a rule about what the factory makes and how. Each one names the
 * stations whose agents must follow it; the core puts the principles in front of
 * the station contract in every agent's system prompt (Council, Planner, Tester,
 * Builder, Reviewer, Fixer, Improvement Council, Overseer, Surveyor...), and the
 * checks named in `enforcedBy` hold builds to them in code.
 *
 * The defaults live here. You can edit any principle, turn it off, add your own
 * or reset one to its default from the Bridge's Brain page; every change is an event:
 *   brain.principle.saved { id, title, text, stations, enabled, note?, by }
 *   brain.principle.reset { id, by }   back to the default (or removed, for one you added)
 */
export interface Principle {
  id: string;
  title: string;
  text: string;
  /** Stations whose agents get this principle in their system prompt. */
  stations: Slot[];
  enabled: boolean;
  /** Where the core checks it in code, in plain words (shown on the Brain page). */
  enforcedBy?: string[];
}

export interface PrincipleView extends Principle {
  builtin: boolean;
  /** A built-in principle someone changed. */
  edited: boolean;
  version: number;
  updatedAt: string | null;
  by: string | null;
}

const MAKERS: Slot[] = ["council", "design", "critique", "plan", "tests", "build", "review", "evaluate", "fix", "improve", "overseer", "survey"];

export const DEFAULT_PRINCIPLES: Principle[] = [
  {
    id: "real-programs",
    title: "Build real programs, not scripts",
    text: "What SoftwareFactory makes is a program a person opens and uses, not a script. Every project is an application: a screen with navigation between its parts, its own data store that keeps what the person enters, and the logic behind it. It starts with one press (the Run tab's Start) and needs no arguments, flags, config files or environment variables. A command line is only ever an extra next to the app, when the idea explicitly asks for scripting, and never the only way in.",
    stations: MAKERS, enabled: true,
    enforcedBy: ["App check at every test round: the build must have index.html, src/schema.js and the app kit, start with `npm start` and read no command-line arguments", "Reviewer: a project whose only entry is a script is a high finding"],
  },
  {
    id: "crud-and-visibility",
    title: "Visualize everything: full CRUD and full visibility",
    text: "Visualize everything means every part of a project can be seen and worked with in its own UI, not shown as a diagram. Every kind of thing the project holds (its entities) has screens to list, search, create, open, edit and delete it: full CRUD wherever it makes sense. Every flow shows its steps, every feature is reachable from the navigation, every change appears in an activity history, the place the data is kept is shown, and the code can be browsed from the app's System view. If something exists in the project, the person can see it and act on it from the app.",
    stations: MAKERS, enabled: true,
    enforcedBy: ["The app kit gives every entity in src/schema.js a list, form and delete, and a System view (entities, flows, features, activity, data, code)", "App check: every entity has fields and sample records, and create, edit and delete work on each one"],
  },
  {
    id: "no-raw-data",
    title: "Never make the person write raw data",
    text: "The person never writes JSON, CSV, YAML, config files or command arguments by hand, and never needs to know a schema or a file convention. Data is entered through forms with labels, pickers and validation. The app opens with sample records already in it. Backups and imports are files the app itself makes and reads. Files and folders are chosen with pickers, never typed as paths.",
    stations: MAKERS, enabled: true,
    enforcedBy: ["App check: the page may not ask the person to type JSON (no JSON.parse of a text box)", "Planner contract: entities with typed fields and seed records instead of input files"],
  },
  {
    id: "first-use",
    title: "Useful on first open, every control works",
    text: "On first open the app already shows realistic sample data and what it can do. Every button, link and form is wired. Errors appear on the screen, in plain words, next to what caused them; nothing fails silently. Think about the person using it: the common task takes few steps and the screen says what happened.",
    stations: ["council", "plan", "build", "review", "fix", "improve"], enabled: true,
    enforcedBy: ["Page check: every script and module the page loads exists and parses", "Reviewer: a blank page or a dead button is a high finding"],
  },
];

type Saved = { id: string; title: string; text: string; stations: Slot[]; enabled: boolean; note?: string; by?: string };

/** The principles as they stand now: the defaults with every saved change applied, in order. */
export function principles(log?: EventLog | null): PrincipleView[] {
  const views = new Map<string, PrincipleView>(DEFAULT_PRINCIPLES.map((p) => [p.id, { ...p, builtin: true, edited: false, version: 0, updatedAt: null, by: null }]));
  if (!log) return [...views.values()];
  const evs = [...log.list({ type: "brain.principle.saved", limit: 1e6 }), ...log.list({ type: "brain.principle.reset", limit: 1e6 })].sort((a, b) => a.id - b.id);
  for (const e of evs) {
    const p = e.payload as Saved;
    const def = DEFAULT_PRINCIPLES.find((d) => d.id === p.id);
    const cur = views.get(p.id);
    if (e.type === "brain.principle.reset") {
      if (def) views.set(p.id, { ...def, builtin: true, edited: false, version: (cur?.version ?? 0) + 1, updatedAt: e.ts, by: p.by ?? "you" });
      else views.delete(p.id);
      continue;
    }
    views.set(p.id, {
      id: p.id, title: p.title, text: p.text, stations: cleanStations(p.stations), enabled: p.enabled !== false,
      enforcedBy: def?.enforcedBy, builtin: !!def, edited: !!def, version: (cur?.version ?? 0) + 1, updatedAt: e.ts, by: p.by ?? "you",
    });
  }
  return [...views.values()];
}

function cleanStations(s: unknown): Slot[] {
  return Array.isArray(s) ? SLOTS.filter((x) => s.includes(x)) : [];
}

/** The principles an agent on this station must follow, as the block that opens its station instructions. */
export function brainBlock(slot: Slot, list: Principle[] = DEFAULT_PRINCIPLES): string {
  const mine = list.filter((p) => p.enabled && p.stations.includes(slot));
  if (!mine.length) return "";
  return [
    "SoftwareFactory principles (the Brain). They come before anything else you are told, and every answer you give must follow them:",
    ...mine.map((p, i) => `${i + 1}. ${p.title}. ${p.text}`),
  ].join("\n");
}

export interface PrincipleInput { title: string; text: string; stations: string[]; enabled?: boolean; note?: string }

/** Save a principle (a new one, or a new version of one). Returns its id. */
export function savePrinciple(log: EventLog, id: string | null, input: PrincipleInput, by = "you"): string {
  const title = String(input.title ?? "").trim().slice(0, 120);
  const text = String(input.text ?? "").trim().slice(0, 4000);
  if (!title) throw new Error("A principle needs a title");
  if (!text) throw new Error("A principle needs its text");
  const stations = cleanStations(input.stations);
  if (!stations.length) throw new Error("Pick at least one station that must follow it");
  let pid = id;
  if (!pid) {
    const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "principle";
    const taken = new Set(principles(log).map((p) => p.id));
    pid = base;
    for (let n = 2; taken.has(pid); n++) pid = `${base}-${n}`;
  } else if (!principles(log).some((p) => p.id === pid)) throw new Error(`No principle "${pid}"`);
  log.append("brain.principle.saved", { id: pid, title, text, stations, enabled: input.enabled !== false, note: input.note?.trim() || undefined, by });
  return pid;
}

export function resetPrinciple(log: EventLog, id: string, by = "you") {
  if (!principles(log).some((p) => p.id === id)) throw new Error(`No principle "${id}"`);
  log.append("brain.principle.reset", { id, by });
}

/** The Brain in the Data vault: one row per principle, as it stands. */
export const brainProjection: Projection = {
  name: "brain",
  version: 1,
  tables: ["brain_principles"],
  describe: "The Brain: SoftwareFactory's principles that every station's agents follow",
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS brain_principles (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      text       TEXT NOT NULL,
      stations   TEXT NOT NULL,
      enabled    INTEGER NOT NULL,
      by_who     TEXT,
      updated_at TEXT NOT NULL,
      event_id   INTEGER NOT NULL
    )`);
  },
  apply(db, e) {
    const p = e.payload as Saved;
    if (e.type === "brain.principle.saved") {
      db.prepare(`INSERT INTO brain_principles (id, title, text, stations, enabled, by_who, updated_at, event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, text = excluded.text, stations = excluded.stations, enabled = excluded.enabled, by_who = excluded.by_who, updated_at = excluded.updated_at, event_id = excluded.event_id`)
        .run(p.id, p.title, p.text, JSON.stringify(p.stations ?? []), p.enabled === false ? 0 : 1, p.by ?? null, e.ts, e.id);
    } else if (e.type === "brain.principle.reset") {
      // Only changes are stored as rows; a reset principle is back to its default in code.
      db.prepare("DELETE FROM brain_principles WHERE id = ?").run(p.id);
    }
  },
};
registerProjection(brainProjection);
