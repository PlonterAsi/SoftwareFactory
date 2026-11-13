import { registerProjection, type Projection } from "../store/projections.js";
import type { EventLog } from "../events.js";

/**
 * Full-text recall over what the person and the crew already said (SF-22): captured notes, filed
 * fragments, tickets and their notes, Council briefs, plans and improvement proposals. An SQLite
 * FTS5 index derived from the event log like every other table, so it rebuilds from the log.
 * The Planner and the Council get the top few matches for the idea in front of them, so they
 * build on past decisions instead of rediscovering them.
 */
type P = Record<string, any>;

function entry(type: string, p: P): { kind: string; ref: string; text: string } | null {
  switch (type) {
    case "signal.captured": return p.text ? { kind: "note", ref: "", text: String(p.text) } : null;
    case "order.fragment": return p.text ? { kind: "filed note", ref: p.node ? `node ${p.node}` : "", text: String(p.text) } : null;
    case "ticket.opened": return { kind: "ticket", ref: `#${p.number ?? p.id}`, text: `${p.title ?? ""}\n${p.body ?? ""}` };
    case "ticket.noted": return p.text ? { kind: "ticket note", ref: `#${p.id}`, text: String(p.text) } : null;
    case "factory.plan": return p.plan ? { kind: "plan", ref: `run ${p.run}`, text: `${p.plan.name ?? ""}: ${p.plan.summary ?? ""}` } : null;
    case "factory.council": {
      const b = p.brief ?? {};
      const t = [...(b.agreed ?? []), ...(b.concerns ?? [])].map(String).join("\n");
      return t ? { kind: "Council decision", ref: `run ${p.run}`, text: t } : null;
    }
    case "improve.proposal": return p.title ? { kind: "proposal", ref: p.target?.title ? String(p.target.title) : "", text: `${p.title}\n${p.why ?? ""}\n${p.change ?? ""}` } : null;
    default: return null;
  }
}

export const recallProjection: Projection = {
  name: "recall",
  version: 1,
  tables: ["recall_fts"],
  describe: "Full-text index over notes, tickets, plans, Council decisions and proposals, for agents' recall (FTS5)",
  migrate(db) {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS recall_fts USING fts5(kind UNINDEXED, ref UNINDEXED, ts UNINDEXED, event UNINDEXED, text, tokenize = 'porter unicode61')`);
  },
  apply(db, e) {
    const x = entry(e.type, e.payload as P);
    if (!x || !x.text.trim()) return;
    db.prepare("INSERT INTO recall_fts (kind, ref, ts, event, text) VALUES (?, ?, ?, ?, ?)").run(x.kind, x.ref, e.ts, e.id, x.text.slice(0, 4000));
  },
};
registerProjection(recallProjection);

const STOP = new Set("a an and are as at be but by can for from has have i in into is it its me my not of on or so that the this to was we what when with you your".split(" "));

/** Turn free text into a safe FTS5 query: the meaningful words, any of them. */
export function recallQuery(text: string): string {
  const words = [...new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? [])].filter((w) => !STOP.has(w)).slice(0, 24);
  return words.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");
}

export interface Recalled { kind: string; ref: string; ts: string; event: number; text: string }

/** The past notes and decisions most relevant to this text, best first. Never throws: no index, no recall. */
/** What the person wrote themselves, as opposed to what agents produced (plans, Council decisions, proposals). */
export const PERSON_KINDS = ["note", "filed note", "ticket", "ticket note"];

export function recall(log: EventLog, text: string, k = 5, skipEvent?: number, kinds?: string[]): Recalled[] {
  const q = recallQuery(text);
  if (!q) return [];
  try {
    const rows = log.db.prepare("SELECT kind, ref, ts, event, text FROM recall_fts WHERE recall_fts MATCH ? ORDER BY bm25(recall_fts) LIMIT ?").all(q, (k + 5) * (kinds ? 4 : 1)) as unknown as Recalled[];
    const seen = new Set<string>();
    return rows.filter((r) => Number(r.event) !== skipEvent && (!kinds || kinds.includes(r.kind))).filter((r) => {
      const key = r.text.slice(0, 120);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, k);
  } catch { return []; }
}

/** A prompt block with the top matches, or "" when there are none. */
export function recallBlock(log: EventLog, text: string, k = 5, kinds?: string[]): string {
  const hits = recall(log, text, k, undefined, kinds);
  if (!hits.length) return "";
  return `Past notes and decisions that may matter (from the person's history; use what fits, ignore the rest):\n${hits.map((h) => `- [${h.kind}${h.ref ? ` ${h.ref}` : ""}, ${h.ts.slice(0, 10)}] ${h.text.replace(/\s+/g, " ").slice(0, 300)}`).join("\n")}`;
}
