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
 *   dream    a cleaned memory you accepted
 *
 * Cleaning, in the spirit of Claude Code's Auto Dream (merge, dedupe, prune):
 *   tidy     free and exact: drops repeats and near repeats, and the oldest lessons past the limit
 *            (never one you taught). It runs by itself when a memory grows past the limit.
 *   dream    one capped agent call reads the whole memory and proposes a shorter one. Nothing changes
 *            until you accept it; until then the agent keeps working with the memory it has.
 *
 * Everything is an event, so the history of a memory is never lost:
 *   agent.memory.noted    { agent, text, source, ref? }
 *   agent.memory.removed  { agent, ids, why, by }
 *   agent.memory.dream    { agent, state: "proposed", saw, lessons, dropped, costUsd, by }  then  { id, agent, state: "accepted" | "rejected" }
 */
export type LessonSource = "person" | "self" | "review" | "dream";
export interface Lesson { id: number; agent: string; text: string; source: LessonSource; ref: string | null; at: string }
export interface DreamLesson { text: string; from: number[] }
export interface DreamView {
  id: number; agent: string; at: string; state: "proposed" | "accepted" | "rejected"; by: "free" | "agent";
  /** The lessons it read (their ids): accepting replaces only these; lessons noted since are kept. */
  saw: number[];
  lessons: DreamLesson[];
  dropped: { id: number; why: string }[];
  costUsd: number; decidedAt: string | null; error?: string;
}

/** Most lessons an agent keeps; past this a free tidy runs by itself. */
export const MEMORY_LIMIT = 40;
/** Most lessons, and characters, that go into one prompt (newest first; yours always first). */
export const PROMPT_LESSONS = 12;
export const PROMPT_CHARS = 1600;
/** The cap a dream may spend when the person does not say, and the most it may ever spend. */
export const DREAM_USD = 0.1;
export const DREAM_MAX_USD = 0.6;
const TEXT_MAX = 300;

export const SOURCE_WORD: Record<LessonSource, string> = { person: "you taught it", self: "it noted it", review: "a review found it", dream: "a cleaned memory" };

const P = (v: unknown) => v as Record<string, any>;

export const memoryProjection: Projection = {
  name: "memory",
  version: 1,
  tables: ["agent_memory", "agent_dreams"],
  describe: "Each agent's own memory: every lesson, where it came from and when it was removed, and each proposed cleaning (dream) with your decision",
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
    CREATE INDEX IF NOT EXISTS agent_memory_agent ON agent_memory(agent, removed_at);
    CREATE TABLE IF NOT EXISTS agent_dreams (
      id          INTEGER PRIMARY KEY,
      agent       TEXT NOT NULL,
      at          TEXT NOT NULL,
      state       TEXT NOT NULL CHECK (state IN ('proposed', 'accepted', 'rejected')),
      by          TEXT NOT NULL,
      saw         TEXT NOT NULL,
      lessons     TEXT NOT NULL,
      dropped     TEXT NOT NULL,
      cost_usd    REAL NOT NULL DEFAULT 0,
      error       TEXT,
      decided_at  TEXT
    )`);
  },
  apply(db, e) {
    const p = P(e.payload);
    if (e.type === "agent.memory.noted") {
      db.prepare("INSERT OR REPLACE INTO agent_memory (id, agent, text, source, ref, at) VALUES (?, ?, ?, ?, ?, ?)").run(e.id, String(p.agent), String(p.text), String(p.source), p.ref == null ? null : String(p.ref), e.ts);
    } else if (e.type === "agent.memory.removed") {
      for (const id of (p.ids ?? []) as number[]) db.prepare("UPDATE agent_memory SET removed_at = ?, removed_why = ? WHERE id = ? AND agent = ? AND removed_at IS NULL").run(e.ts, String(p.why ?? ""), Number(id), String(p.agent));
    } else if (e.type === "agent.memory.dream") {
      if (p.state === "proposed") {
        db.prepare("INSERT OR REPLACE INTO agent_dreams (id, agent, at, state, by, saw, lessons, dropped, cost_usd, error) VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?)")
          .run(e.id, String(p.agent), e.ts, String(p.by ?? "free"), JSON.stringify(p.saw ?? []), JSON.stringify(p.lessons ?? []), JSON.stringify(p.dropped ?? []), Number(p.costUsd ?? 0), p.error == null ? null : String(p.error));
      } else db.prepare("UPDATE agent_dreams SET state = ?, decided_at = ? WHERE id = ? AND state = 'proposed'").run(String(p.state), e.ts, Number(p.id));
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

type DreamRow = { id: number; agent: string; at: string; state: string; by: string; saw: string; lessons: string; dropped: string; cost_usd: number; error: string | null; decided_at: string | null };
const toDream = (r: DreamRow): DreamView => ({
  id: Number(r.id), agent: r.agent, at: r.at, state: r.state as DreamView["state"], by: r.by as DreamView["by"], saw: JSON.parse(r.saw), lessons: JSON.parse(r.lessons),
  dropped: JSON.parse(r.dropped), costUsd: Number(r.cost_usd), decidedAt: r.decided_at, ...(r.error ? { error: r.error } : {}),
});

/** Cleanings: every one still waiting on you, then the newest decided ones. */
export function dreams(log: EventLog, agent?: string, limit = 20): DreamView[] {
  const where = agent ? "WHERE agent = ?" : "";
  const args = agent ? [agent] : [];
  const open = log.db.prepare(`SELECT * FROM agent_dreams ${where ? `${where} AND` : "WHERE"} state = 'proposed' ORDER BY id DESC`).all(...args) as DreamRow[];
  const done = log.db.prepare(`SELECT * FROM agent_dreams ${where ? `${where} AND` : "WHERE"} state != 'proposed' ORDER BY id DESC LIMIT ?`).all(...args, limit) as DreamRow[];
  return [...open, ...done].map(toDream);
}

export function dream(log: EventLog, id: number): DreamView | undefined {
  const r = log.db.prepare("SELECT * FROM agent_dreams WHERE id = ?").get(id) as DreamRow | undefined;
  return r ? toDream(r) : undefined;
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

// ---------- dreams ----------

export const DREAM_CONTRACT = `Station contract: dream.
You are cleaning an agent's memory, the way Claude Code's Auto Dream cleans its own: merge lessons that say the same thing,
drop lessons that are stale, wrong for later work, or only about one finished job, and keep every lesson that will still help.
Write each kept lesson as one short sentence an agent can act on. Never invent a lesson that is not in the memory.
Lessons marked (taught) were taught by the person: keep them, word for word.
Answer with ONE fenced json block and nothing else:
{"lessons": [{"text": "one sentence", "from": [ids it comes from]}], "dropped": [{"id": 12, "why": "a few words"}]}
Every id must appear once: in the "from" of a kept lesson, or in "dropped".`;

export function dreamPrompt(agentName: string, lessons: Lesson[]): string {
  return `The memory of ${agentName}, ${lessons.length} lessons, oldest first:\n${lessons.map((l) => `${l.id}. ${l.source === "person" ? "(taught) " : ""}${l.text}`).join("\n")}`;
}

/**
 * Read a dream answer against the memory it was given. Ids it forgot stay as they were; a lesson you taught that
 * it dropped or reworded stays word for word; text it made up for no id is left out. Throws when unusable.
 */
export function parseDream(text: string, lessons: Lesson[]): { lessons: DreamLesson[]; dropped: { id: number; why: string }[] } {
  const raw = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const j = JSON.parse(raw) as { lessons?: { text?: unknown; from?: unknown }[]; dropped?: { id?: unknown; why?: unknown }[] };
  if (!j || !Array.isArray(j.lessons)) throw new Error("The cleaned memory has no lessons list");
  const byId = new Map(lessons.map((l) => [l.id, l]));
  const taught = new Set(lessons.filter((l) => l.source === "person").map((l) => l.id));
  const used = new Set<number>();
  const out: DreamLesson[] = [];
  for (const k of j.lessons) {
    const from = (Array.isArray(k?.from) ? k.from : []).map(Number).filter((id) => byId.has(id) && !used.has(id) && !taught.has(id));
    const t = clean(String(k?.text ?? ""));
    if (!from.length || t.length < 3) continue;
    from.forEach((id) => used.add(id));
    out.push({ text: t, from });
  }
  const dropped: { id: number; why: string }[] = [];
  for (const d of Array.isArray(j.dropped) ? j.dropped : []) {
    const id = Number(d?.id);
    if (!byId.has(id) || used.has(id) || taught.has(id)) continue;
    used.add(id);
    dropped.push({ id, why: clean(String(d?.why ?? "dropped")).slice(0, 120) });
  }
  // Yours stay word for word; anything it did not account for stays as it was.
  for (const l of lessons) if (!used.has(l.id)) out.push({ text: l.text, from: [l.id] });
  return { lessons: out.sort((a, b) => Math.min(...a.from) - Math.min(...b.from)), dropped };
}

/** The free dream: the tidy, written as a proposal (used on the practice crew, and when the agent's answer was unusable). */
export function freeDream(lessons: Lesson[]): { lessons: DreamLesson[]; dropped: { id: number; why: string }[] } {
  const { keep, drop } = tidyPlan(lessons);
  return { lessons: keep.map((l) => ({ text: l.text, from: [l.id] })), dropped: drop };
}

/** Accept a proposed cleaning: the lessons it read are replaced by its lessons; ones noted since stay. */
export function acceptDream(log: EventLog, id: number): DreamView {
  const d = dream(log, id);
  if (!d) throw new Error(`No cleaning #${id}`);
  if (d.state !== "proposed") throw new Error(`Cleaning #${id} was already ${d.state}.`);
  const have = memoryOf(log, d.agent);
  const still = new Set(have.map((l) => l.id));
  const unchanged = new Set(d.lessons.filter((k) => k.from.length === 1 && have.find((l) => l.id === k.from[0])?.text === k.text).map((k) => k.from[0]));
  const replace = d.saw.filter((x) => still.has(x) && !unchanged.has(x));
  if (replace.length) log.append("agent.memory.removed", { agent: d.agent, ids: replace, why: `replaced by cleaning #${id}`, by: "you" });
  for (const k of d.lessons) {
    if (k.from.length === 1 && unchanged.has(k.from[0])) continue;
    // A lesson you taught keeps its source, so it stays first and protected.
    const taught = k.from.every((f) => have.find((l) => l.id === f)?.source === "person");
    log.append("agent.memory.noted", { agent: d.agent, text: k.text, source: taught ? "person" : "dream", ref: `dream:${id}` });
  }
  log.append("agent.memory.dream", { id, agent: d.agent, state: "accepted" });
  return dream(log, id)!;
}

export function rejectDream(log: EventLog, id: number): DreamView {
  const d = dream(log, id);
  if (!d) throw new Error(`No cleaning #${id}`);
  if (d.state !== "proposed") throw new Error(`Cleaning #${id} was already ${d.state}.`);
  log.append("agent.memory.dream", { id, agent: d.agent, state: "rejected" });
  return dream(log, id)!;
}
