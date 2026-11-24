import type { EventLog } from "../events.js";
import { registerProjection, type Projection } from "../store/projections.js";

/**
 * Each agent's own memory (docs/agents.md, phase 4 of the brief): short lessons from its past work, kept
 * with the agent and reused in every project it works on. The lessons go into its prompt, between its
 * own instructions and the station contract, so the next call already knows them.
 *
 * Where lessons come from, all free:
 *   person   you teach it, in the Agent Bay
 *   self     the agent ends an answer with "Remember: ..." (agents.ts picks those lines up)
 *   review   a Reviewer sent its build back: the serious findings become lessons of the agent that built it
 *   dream    a cleaned memory accepted before 24 Nov 2026 (the paid cleaning was removed then: it never ran)
 *
 * Tidy, free and exact: drops repeats and near repeats, and the oldest lessons past the limit
 * (never one you taught). It runs by itself when a memory grows past the limit.
 *
 * Everything is an event, so the history of a memory is never lost:
 *   agent.memory.noted    { agent, text, source, ref? }
 *   agent.memory.removed  { agent, ids, why, by }
 */
export type LessonSource = "person" | "self" | "review" | "dream";
export interface Lesson { id: number; agent: string; text: string; source: LessonSource; ref: string | null; at: string }
/** Most lessons an agent keeps; past this a free tidy runs by itself. */
export const MEMORY_LIMIT = 40;
/** Most lessons, and characters, that go into one prompt (newest first; yours always first). */
export const PROMPT_LESSONS = 12;
export const PROMPT_CHARS = 1600;
const TEXT_MAX = 300;

export const SOURCE_WORD: Record<LessonSource, string> = { person: "you taught it", self: "it noted it", review: "a review found it", dream: "a cleaned memory" };

const P = (v: unknown) => v as Record<string, any>;

export const memoryProjection: Projection = {
  name: "memory",
  version: 1,
  tables: ["agent_memory"],
  describe: "Each agent's own memory: every lesson, where it came from and when it was removed",
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_memory (
      id          INTEGER PRIMARY KEY,
      agent       TEXT NOT NULL,
      text        TEXT NOT NULL,
      source      TEXT NOT NULL,
      ref         TEXT,
      at          TEXT NOT NULL,
      removed_at  TEXT,
      removed_why TEXT
    );
    CREATE INDEX IF NOT EXISTS agent_memory_agent ON agent_memory(agent, removed_at)`);
  },
  apply(db, e) {
    const p = P(e.payload);
    if (e.type === "agent.memory.noted") {
      db.prepare("INSERT OR REPLACE INTO agent_memory (id, agent, text, source, ref, at) VALUES (?, ?, ?, ?, ?, ?)").run(e.id, String(p.agent), String(p.text), String(p.source), p.ref == null ? null : String(p.ref), e.ts);
    } else if (e.type === "agent.memory.removed") {
      for (const id of (p.ids ?? []) as number[]) db.prepare("UPDATE agent_memory SET removed_at = ?, removed_why = ? WHERE id = ? AND agent = ? AND removed_at IS NULL").run(e.ts, String(p.why ?? ""), Number(id), String(p.agent));
    }
  },
};
registerProjection(memoryProjection);

// ---------- reading ----------

type Row = { id: number; agent: string; text: string; source: string; ref: string | null; at: string };
const toLesson = (r: Row): Lesson => ({ id: Number(r.id), agent: r.agent, text: r.text, source: r.source as LessonSource, ref: r.ref, at: r.at });

/** An agent's lessons as they stand, oldest first. */
export function memoryOf(log: EventLog, agent: string): Lesson[] {
  return (log.db.prepare("SELECT id, agent, text, source, ref, at FROM agent_memory WHERE agent = ? AND removed_at IS NULL ORDER BY id").all(agent) as Row[]).map(toLesson);
}

/** Every agent's lessons, by agent. */
export function allMemory(log: EventLog): Record<string, Lesson[]> {
  const out: Record<string, Lesson[]> = {};
  for (const r of log.db.prepare("SELECT id, agent, text, source, ref, at FROM agent_memory WHERE removed_at IS NULL ORDER BY id").all() as Row[]) (out[r.agent] ??= []).push(toLesson(r));
  return out;
}


/** The block that goes into the agent's prompt: yours first, then the newest, within the limits. Empty when it has none. */
export function memoryBlock(lessons: Lesson[]): string {
  const invite = "When you learn something that will help you on later work, you may end your answer with one line: Remember: <the lesson, in one sentence>.";
  if (!lessons.length) return `Your memory: nothing yet. ${invite}`;
  const ordered = [...lessons.filter((l) => l.source === "person").reverse(), ...lessons.filter((l) => l.source !== "person").reverse()];
  const lines: string[] = [];
  let size = 0;
  for (const l of ordered) {
    if (lines.length >= PROMPT_LESSONS || size + l.text.length > PROMPT_CHARS) break;
    lines.push(`- ${l.text}`);
    size += l.text.length + 3;
  }
  const more = lessons.length - lines.length;
  return `Your memory: lessons from your own past work in SoftwareFactory, across projects. Use the ones that apply here; ignore the rest.\n${lines.join("\n")}${more > 0 ? `\n(${more} older lesson${more > 1 ? "s" : ""} not shown.)` : ""}\n${invite}`;
}

/** "Remember: ..." lines at the start of a line in an agent's answer: at most two, each one sentence. */
export function rememberLines(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^[ \t>*_-]*Remember:\**\s*(.+)$/gim)) {
    const t = clean(m[1].replace(/[*_`]+$/g, ""));
    if (t.length >= 8 && !out.includes(t)) out.push(t);
    if (out.length >= 2) break;
  }
  return out;
}

// ---------- writing ----------

const clean = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, TEXT_MAX);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const words = (s: string) => new Set(norm(s).split(" ").filter((w) => w.length > 2));
/** How alike two lessons are: shared words over all words (Jaccard). */
export function likeness(a: string, b: string): number {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return norm(a) === norm(b) ? 1 : 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}
/** At or above this, two lessons say the same thing. */
export const SAME = 0.8;

/** Note a lesson. A repeat of one it already has is not noted again (null). Past the limit, a free tidy runs. */
export function noteLesson(log: EventLog, agent: string, text: string, source: LessonSource, ref?: string | null): Lesson | null {
  const t = clean(text);
  if (!agent || t.length < 3) return null;
  const have = memoryOf(log, agent);
  if (have.some((l) => norm(l.text) === norm(t) || likeness(l.text, t) >= SAME)) return null;
  const e = log.append("agent.memory.noted", { agent, text: t, source, ...(ref ? { ref: String(ref).slice(0, 120) } : {}) });
  if (have.length + 1 > MEMORY_LIMIT) tidyMemory(log, agent, "auto");
  return { id: e.id, agent, text: t, source, ref: ref ?? null, at: e.ts };
}

/** Remove lessons by id (only this agent's, only ones it still has). Returns how many went. */
export function forget(log: EventLog, agent: string, ids: number[], why: string, by = "you"): number {
  const have = new Set(memoryOf(log, agent).map((l) => l.id));
  const gone = [...new Set(ids.map(Number))].filter((id) => have.has(id));
  if (gone.length) log.append("agent.memory.removed", { agent, ids: gone, why: why.slice(0, 200), by });
  return gone.length;
}

/** The free tidy, worked out: repeats and near repeats go (the newest copy stays), then the oldest past the limit (never yours). */
export function tidyPlan(lessons: Lesson[], limit = MEMORY_LIMIT): { keep: Lesson[]; drop: { id: number; why: string }[] } {
  const keep: Lesson[] = [];
  const drop: { id: number; why: string }[] = [];
  // Newest first, so the copy that stays is the newest (a lesson you taught wins over any other copy).
  const order = [...lessons].sort((a, b) => (a.source === "person" ? 0 : 1) - (b.source === "person" ? 0 : 1) || b.id - a.id);
  for (const l of order) {
    const twin = keep.find((k) => norm(k.text) === norm(l.text) || likeness(k.text, l.text) >= SAME);
    if (twin) drop.push({ id: l.id, why: `says the same as "${twin.text.slice(0, 60)}"` });
    else keep.push(l);
  }
  const extra = keep.length - limit;
  if (extra > 0) {
    const old = keep.filter((l) => l.source !== "person").sort((a, b) => a.id - b.id).slice(0, extra);
    for (const l of old) drop.push({ id: l.id, why: `oldest past the limit of ${limit}` });
    const gone = new Set(old.map((l) => l.id));
    keep.splice(0, keep.length, ...keep.filter((l) => !gone.has(l.id)));
  }
  return { keep: keep.sort((a, b) => a.id - b.id), drop };
}

/** Apply the free tidy. Returns what it removed. */
export function tidyMemory(log: EventLog, agent: string, by = "you"): { id: number; why: string }[] {
  const { drop } = tidyPlan(memoryOf(log, agent));
  if (drop.length) log.append("agent.memory.removed", { agent, ids: drop.map((d) => d.id), why: by === "auto" ? "tidied by itself past the limit" : "tidied", by, details: drop.slice(0, 50) });
  return drop;
}
