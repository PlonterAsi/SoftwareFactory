import { DatabaseSync } from "node:sqlite";
import { SECRET_PATTERNS } from "../safety/secrets.js";

/**
 * The record (build step 1, slice 2): one list of what happened, and every picture is drawn only from it.
 *
 * It is started fresh, beside the old event log and never mixed with it. What the old log kept inside a
 * free payload is a real column here: who, which run, which ticket, which project. SoftwareFactory stamps
 * those; an agent only ever brings content. Nothing in it can be rewritten or removed: the database itself
 * refuses, not just this code. A wrong line is answered by a new line, never by a changed one.
 */

/** The short, fixed list of kinds. A new kind is added here, on purpose, never made up by a caller. */
export const RECORD_KINDS = [
  "ticket.opened",
  "ticket.edited",
  "ticket.queued",
  "ticket.removed",
  "ticket.restored",
  "gate.asked",
  "gate.answered",
  "gate.passed",
  "fence.tested",
  "run.started",
  "run.step",
  "run.checked",
  "run.ended",
  "result.proposed",
  "result.accepted",
  "result.undone",
  "stop.pressed",
  "watchdog.spoke",
  "setting.changed",
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

/** The five written ends of a run (leg 3). */
export const RUN_ENDS = ["passed", "failed its checks", "parked", "stopped", "crashed"] as const;
export type RunEnd = (typeof RUN_ENDS)[number];

export interface RecordLine {
  id: number;
  ts: string;
  kind: RecordKind;
  /** Who did it: "you", "SF itself", or a worker's name. Stamped by SoftwareFactory. */
  who: string;
  run: string | null;
  ticket: string | null;
  project: string | null;
  /** Money this line cost, in dollars, when it cost any. */
  costUsd: number | null;
  /** True when SoftwareFactory found something wrong with the content (for example a secret it took out). The line is kept. */
  flagged: boolean;
  data: Record<string, unknown>;
}

export interface NewLine {
  kind: RecordKind;
  who: string;
  run?: string | null;
  ticket?: string | null;
  project?: string | null;
  costUsd?: number | null;
  data?: Record<string, unknown>;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS record (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       TEXT    NOT NULL,
    kind     TEXT    NOT NULL,
    who      TEXT    NOT NULL,
    run      TEXT,
    ticket   TEXT,
    project  TEXT,
    cost_usd REAL,
    flagged  INTEGER NOT NULL DEFAULT 0,
    data     TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS record_run ON record(run);
  CREATE INDEX IF NOT EXISTS record_ticket ON record(ticket);
  CREATE INDEX IF NOT EXISTS record_project ON record(project);
  CREATE TRIGGER IF NOT EXISTS record_no_update BEFORE UPDATE ON record BEGIN SELECT RAISE(ABORT, 'the record is never rewritten'); END;
  CREATE TRIGGER IF NOT EXISTS record_no_delete BEFORE DELETE ON record BEGIN SELECT RAISE(ABORT, 'the record is never rewritten'); END;
`;

/** Take secrets out of a text before it is stored. Returns the clean text and whether anything was taken out. */
export function cleanText(text: string, extra: string[] = []): { text: string; hit: boolean } {
  let out = text, hit = false;
  for (const s of extra) if (s && s.length >= 8 && out.includes(s)) { out = out.split(s).join("[secret]"); hit = true; }
  for (const p of SECRET_PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags.includes("g") ? p.re.flags : `${p.re.flags}g`);
    if (re.test(out)) { out = out.replace(re, `[${p.name}]`); hit = true; }
  }
  return { text: out, hit };
}

function cleanData(v: unknown, extra: string[], state: { hit: boolean }): unknown {
  if (typeof v === "string") { const c = cleanText(v, extra); if (c.hit) state.hit = true; return c.text; }
  if (Array.isArray(v)) return v.map((x) => cleanData(x, extra, state));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, cleanData(x, extra, state)]));
  return v;
}

export class TheRecord {
  readonly db: DatabaseSync;
  /** Strings that must never be stored, on top of the known key shapes (for example the Claude sign-in of this run). */
  private secrets: string[] = [];
  private listeners: ((l: RecordLine) => void)[] = [];

  constructor(path = ":memory:", private now: () => Date = () => new Date()) {
    this.db = new DatabaseSync(path);
    // Without this, INSERT OR REPLACE would delete a line without waking the delete trigger.
    // The triggers stop a mistake in our own code. They cannot stop someone who opens the file with another
    // program: that is what the file's place (the person's own Windows account, outside the room) is for.
    this.db.exec("PRAGMA recursive_triggers = ON");
    this.db.exec(SCHEMA);
  }

  /** Name a secret so it is taken out of everything stored from now on. */
  hide(secret: string): void { if (secret && !this.secrets.includes(secret)) this.secrets.push(secret); }

  onLine(fn: (l: RecordLine) => void): void { this.listeners.push(fn); }

  append(l: NewLine): RecordLine {
    if (!(RECORD_KINDS as readonly string[]).includes(l.kind)) throw new Error(`the record has no kind "${l.kind}"`);
    if (!l.who.trim()) throw new Error("a line in the record always says who");
    const state = { hit: false };
    const data = cleanData(l.data ?? {}, this.secrets, state) as Record<string, unknown>;
    const ts = this.now().toISOString();
    const r = this.db.prepare("INSERT INTO record (ts, kind, who, run, ticket, project, cost_usd, flagged, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(ts, l.kind, l.who, l.run ?? null, l.ticket ?? null, l.project ?? null, l.costUsd ?? null, state.hit ? 1 : 0, JSON.stringify(data));
    const line: RecordLine = { id: Number(r.lastInsertRowid), ts, kind: l.kind, who: l.who, run: l.run ?? null, ticket: l.ticket ?? null, project: l.project ?? null, costUsd: l.costUsd ?? null, flagged: state.hit, data };
    for (const fn of this.listeners) { try { fn(line); } catch { /* a listener never breaks the record */ } }
    return line;
  }

  private rows(where: string, ...args: (string | number)[]): RecordLine[] {
    return (this.db.prepare(`SELECT * FROM record ${where} ORDER BY id`).all(...args) as any[]).map((r) => ({
      id: r.id, ts: r.ts, kind: r.kind, who: r.who, run: r.run, ticket: r.ticket, project: r.project, costUsd: r.cost_usd, flagged: !!r.flagged, data: JSON.parse(r.data),
    }));
  }

  all(): RecordLine[] { return this.rows(""); }
  /** The story of one ticket: every line that names it, in order. */
  story(ticket: string): RecordLine[] { return this.rows("WHERE ticket = ?", ticket); }
  ofRun(run: string): RecordLine[] { return this.rows("WHERE run = ?", run); }
  since(id: number): RecordLine[] { return this.rows("WHERE id > ?", id); }
  /** What a run cost so far. */
  costOf(run: string): number { return Number((this.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM record WHERE run = ?").get(run) as any).c); }
}
