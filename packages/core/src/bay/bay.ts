import "./tables.js";
import type { EventLog, SfEvent } from "../events.js";
import type { AgentRuntime } from "../runtime.js";
import { runAgent } from "../agents.js";
import { bind, kitOf, type CrewMember, type CrewSource } from "../factory/crew.js";
import { parseSeatTake } from "../factory/council.js";
import { parseFileBlocks, parseJsonBlock, isLockedTest } from "../factory/workspace.js";
import { validatePlan, parseReview, type Plan } from "../factory/loop.js";
import { archivistPrompt, parseArchivistPlan } from "../order/archivist.js";
import { foldOrder } from "../order/model.js";
import { parseModuleNotes, parseSuggestions } from "../imports/crew.js";
import { parseLensAnswer } from "../improve/lenses.js";
import { MODELS, SLOTS, normalizeAgent, parseAgentFile, serializeAgent, slugify, type AgentDef, type HomeStation, type Slot } from "./agentfile.js";
import { BUILTIN_AGENTS, DEFAULT_SLOTS, SLOT_SEATS, systemPromptFor } from "./builtin.js";
import { principles } from "../brain/brain.js";
import { library } from "./kits.js";

/**
 * The Agent Bay: where workers are created, edited, tested and assigned.
 *
 * Everything is an event: every save is a new version (nothing is overwritten,
 * so any version can be restored), every assignment, retirement and test run.
 * The factory asks the Bay who works each station at the moment it needs them,
 * so an edit applies to the next call, and each call records the version used.
 */
export interface AgentVersion { version: number; ts: string; def: AgentDef; note: string; by: string }
export interface AgentView {
  def: AgentDef;
  version: number;
  builtin: boolean;
  retired: boolean;
  createdAt: string;
  updatedAt: string;
  versions: { version: number; ts: string; note: string; by: string }[];
}
export interface BayTest {
  id: number; ts: string; agent: string; version: number; station: HomeStation; task: string;
  state: "running" | "done"; pass?: boolean; checks?: { label: string; pass: boolean }[]; output?: string; error?: string; costUsd?: number; runId?: number;
}
export interface AgentStats {
  calls: number; failed: number; costUsd: number; avgUsd: number;
  /** Verdicts of the verifier at the stations this agent worked (tests green, plan approved, take usable...). */
  verdicts: { pass: number; total: number };
  passRate: number | null;
  /** Factory runs it worked in, and its calls per run (rounds). */
  runs: number;
  avgRounds: number | null;
  lastAt: string | null;
  state: "idle" | "thinking" | "blocked";
  current?: string;
  byVersion: Record<number, { calls: number; costUsd: number; pass: number; total: number }>;
  /** Prompt-cache use (SF-18): input tokens read from cache, written to it, and all input tokens. hitRate = read / input. */
  cache: { read: number; write: number; input: number; hitRate: number | null };
}
export interface BayState {
  agents: AgentView[];
  slots: Record<Slot, string[]>;
  seats: Record<Slot, number>;
  tests: BayTest[];
  stats: Record<string, AgentStats>;
  visuals: { id: number; ts: string; scope: string; pass: boolean; items: string[]; missing: string[] }[];
  models: readonly string[];
  /** What an agent's settings can choose from: skills, built-in tools, MCP servers. */
  library: ReturnType<typeof library>;
}

const DRAFT_CONTRACT = `Station contract: draft.
Turn the person's one-line description into a new SoftwareFactory agent.
Answer with ONE fenced json block and nothing else, shaped exactly like:
{"name": "Short Name", "avatar": "one symbol", "description": "one sentence", "station": "none", "model": "haiku", "budgetUsd": 0.05, "sample": "a sample task to test it on", "prompt": "You are ... (3 to 6 sentences: who it is, how it works, what it never does)"}
station is one of: ${SLOTS.join(", ")}, none. model is haiku unless the description asks for depth (sonnet) or the very best (opus). budgetUsd is at most 0.6.`;

export class AgentBay implements CrewSource {
  constructor(private log: EventLog, private runtime: AgentRuntime | null = null) {
    // Seed the built-in crew once; after that they are ordinary, editable agents.
    const have = new Set(this.events("bay.agent.saved").map((e) => (e.payload as { id: string }).id));
    for (const a of BUILTIN_AGENTS) if (!have.has(a.id)) this.log.append("bay.agent.saved", { id: a.id, version: 1, def: a, note: "built-in crew", by: "builtin", builtin: true });
    // A built-in agent nobody has edited follows the shipped one (new skills, a better prompt). One the person edited stays theirs.
    for (const a of BUILTIN_AGENTS) {
      const cur = have.has(a.id) ? this.get(a.id) : undefined;
      if (!cur || cur.versions.at(-1)?.by !== "builtin") continue;
      let was: AgentDef | null = null;
      try { was = normalizeAgent({ ...cur.def }); } catch { /* an unusable old copy is simply replaced */ }
      if (was && JSON.stringify(was) === JSON.stringify(normalizeAgent({ ...a }))) continue;
      this.log.append("bay.agent.saved", { id: a.id, version: cur.version + 1, def: a, note: `built-in update: ${was ? changeNote(was, a) : "replaced"}`, by: "builtin", builtin: true });
    }
    // A test cut off by a restart would show as running forever.
    for (const t of this.tests()) if (t.state === "running") this.log.append("bay.test", { id: t.id, agent: t.agent, version: t.version, state: "done", pass: false, error: "The core restarted during this test." });
  }

  // ---------- reading ----------

  private events(type: SfEvent["type"]) { return this.log.list({ type, limit: 1e6 }); }

  agents(): AgentView[] {
    const by = new Map<string, AgentView>();
    for (const e of this.log.list({ limit: 1e6 }).filter((x) => x.type === "bay.agent.saved" || x.type === "bay.agent.retired")) {
      const p = e.payload as any;
      if (e.type === "bay.agent.saved") {
        const cur = by.get(p.id);
        const v = { version: p.version, ts: e.ts, note: p.note ?? "", by: p.by ?? "you" };
        if (cur) Object.assign(cur, { def: p.def, version: p.version, updatedAt: e.ts, versions: [...cur.versions, v] });
        else by.set(p.id, { def: p.def, version: p.version, builtin: !!p.builtin, retired: false, createdAt: e.ts, updatedAt: e.ts, versions: [v] });
      } else if (by.has(p.id)) by.get(p.id)!.retired = p.retired !== false;
    }
    return [...by.values()];
  }

  get(id: string): AgentView | undefined { return this.agents().find((a) => a.def.id === id); }

  version(id: string, version: number): AgentVersion | undefined {
    const e = this.events("bay.agent.saved").find((x) => (x.payload as any).id === id && (x.payload as any).version === version);
    if (!e) return undefined;
    const p = e.payload as any;
    return { version, ts: e.ts, def: p.def, note: p.note ?? "", by: p.by ?? "you" };
  }

  slots(): Record<Slot, string[]> {
    const live = new Set(this.agents().filter((a) => !a.retired).map((a) => a.def.id));
    const out = { ...DEFAULT_SLOTS } as Record<Slot, string[]>;
    for (const e of this.events("bay.assign")) { const p = e.payload as { slot: Slot; agents: string[] }; out[p.slot] = p.agents; }
    for (const s of SLOTS) {
      const ok = out[s].filter((id) => live.has(id));
      // A station is never left without a worker: an emptied slot falls back to its built-in crew.
      out[s] = ok.length ? ok : DEFAULT_SLOTS[s];
    }
    return out;
  }

  /** The agents working a station right now, bound to its contract (used by the factory and the Order Engine). */
  crewFor(slot: Slot): CrewMember[] {
    const all = new Map(this.agents().map((a) => [a.def.id, a]));
    const brain = principles(this.log);
    return this.slots()[slot].map((id) => all.get(id)).filter((a): a is AgentView => !!a).map((a) => bind(a.def, a.version, slot, brain));
  }

  tests(): BayTest[] {
    const by = new Map<number, BayTest>();
    for (const e of this.events("bay.test")) {
      const p = e.payload as any;
      if (p.state === "running") by.set(e.id, { id: e.id, ts: e.ts, agent: p.agent, version: p.version, station: p.station, task: p.task, state: "running" });
      else if (by.has(p.id)) Object.assign(by.get(p.id)!, { ...p, id: p.id, ts: by.get(p.id)!.ts });
    }
    return [...by.values()];
  }

  state(): BayState {
    return {
      agents: this.agents(), slots: this.slots(), seats: SLOT_SEATS, tests: this.tests().slice(-60), stats: this.stats(),
      visuals: this.events("bay.visual").slice(-40).map((e) => ({ id: e.id, ts: e.ts, ...(e.payload as any) })), models: MODELS, library: library(),
    };
  }

  /** Per-agent numbers, all derived from the event log: calls, cost, verifier pass rate, rounds, live state. */
  stats(): Record<string, AgentStats> {
    const out: Record<string, AgentStats> = {};
    const s = (id: string) => (out[id] ??= { calls: 0, failed: 0, costUsd: 0, avgUsd: 0, verdicts: { pass: 0, total: 0 }, passRate: null, runs: 0, avgRounds: null, lastAt: null, state: "idle", byVersion: {}, cache: { read: 0, write: 0, input: 0, hitRate: null } });
    const ver = (st: AgentStats, v: number) => (st.byVersion[v] ??= { calls: 0, costUsd: 0, pass: 0, total: 0 });
    for (const a of this.agents()) s(a.def.id);
    const started = new Map<number, { agent: string; version: number; station?: string; ts: string; factoryRun?: number; test?: boolean }>();
    const runsOf = new Map<string, Set<number>>();
    const callsInRuns = new Map<string, number>();
    const lastOutcome = new Map<string, "ok" | "failed">();
    for (const e of this.log.list({ limit: 1e6 })) {
      const p = e.payload as any;
      if (e.type === "agent.run.started") {
        started.set(e.id, { agent: p.agent, version: p.agentVersion ?? 0, station: p.station, ts: e.ts, factoryRun: p.factoryRun, test: !!p.bayTest });
      } else if (e.type === "agent.run.completed" || e.type === "agent.run.failed") {
        const st0 = started.get(p.runId);
        if (!st0) continue;
        started.delete(p.runId);
        const st = s(st0.agent);
        st.calls++;
        st.lastAt = e.ts;
        const cost = e.type === "agent.run.completed" ? Number(p.costUsd ?? 0) : 0;
        st.costUsd += cost;
        const bv = ver(st, st0.version);
        bv.calls++; bv.costUsd += cost;
        if (e.type === "agent.run.completed") {
          st.cache.read += Number(p.cacheReadTokens ?? 0);
          st.cache.write += Number(p.cacheWriteTokens ?? 0);
          st.cache.input += Number(p.contextTokens ?? 0);
        }
        if (e.type === "agent.run.failed") st.failed++;
        lastOutcome.set(st0.agent, e.type === "agent.run.failed" ? "failed" : "ok");
        if (st0.factoryRun != null) {
          (runsOf.get(st0.agent) ?? runsOf.set(st0.agent, new Set()).get(st0.agent)!).add(st0.factoryRun);
          callsInRuns.set(st0.agent, (callsInRuns.get(st0.agent) ?? 0) + 1);
        }
      } else if (e.type === "agent.verdict") {
        const st = s(p.agent);
        st.verdicts.total++;
        if (p.pass) st.verdicts.pass++;
        const bv = ver(st, p.version ?? 0);
        bv.total++; if (p.pass) bv.pass++;
      }
    }
    for (const [, st0] of started) { const st = s(st0.agent); st.state = "thinking"; st.current = st0.test ? "test run" : st0.station ? `${st0.station}${st0.factoryRun ? ` · run #${st0.factoryRun}` : ""}` : "answering"; }
    for (const [id, st] of Object.entries(out)) {
      st.costUsd = Number(st.costUsd.toFixed(6));
      st.avgUsd = st.calls ? Number((st.costUsd / st.calls).toFixed(6)) : 0;
      st.cache.hitRate = st.cache.input ? Number((st.cache.read / st.cache.input).toFixed(3)) : null;
      st.passRate = st.verdicts.total ? st.verdicts.pass / st.verdicts.total : null;
      st.runs = runsOf.get(id)?.size ?? 0;
      st.avgRounds = st.runs ? Number(((callsInRuns.get(id) ?? 0) / st.runs).toFixed(2)) : null;
      if (st.state === "idle" && lastOutcome.get(id) === "failed") st.state = "blocked";
    }
    return out;
  }

  /** The agent as a shareable file. */
  file(id: string, version?: number): string {
    const def = version ? this.version(id, version)?.def : this.get(id)?.def;
    if (!def) throw new Error(`No agent "${id}"${version ? ` version ${version}` : ""}`);
    return serializeAgent(def);
  }

  // ---------- writing ----------

  /** Create a new agent. Its id is made unique, so a clone or import never overwrites anyone. */
  create(raw: Partial<AgentDef>, note = "created", by = "you"): AgentView {
    const def = normalizeAgent(raw as any);
    const taken = new Set(this.agents().map((a) => a.def.id));
    let id = def.id, n = 2;
    while (taken.has(id)) id = `${def.id.slice(0, 36)}-${n++}`;
    def.id = id;
    this.log.append("bay.agent.saved", { id, version: 1, def, note, by });
    this.visual(`agent ${id}`);
    return this.get(id)!;
  }

  /** Save an edit as a new version. `expectVersion` refuses the save if someone saved in between. */
  save(id: string, raw: Partial<AgentDef>, opts: { note?: string; by?: string; expectVersion?: number } = {}): AgentView {
    const cur = this.get(id);
    if (!cur) throw new Error(`No agent "${id}"`);
    if (opts.expectVersion !== undefined && opts.expectVersion !== cur.version) throw new Error(`${cur.def.name} changed since you opened it (now version ${cur.version}). Reload and try again.`);
    const def = normalizeAgent({ ...cur.def, ...raw, id });
    if (JSON.stringify(def) === JSON.stringify(cur.def)) return cur;
    this.log.append("bay.agent.saved", { id, version: cur.version + 1, def, note: opts.note?.trim() || changeNote(cur.def, def), by: opts.by ?? "you", builtin: cur.builtin });
    this.visual(`agent ${id}`);
    return this.get(id)!;
  }

  clone(id: string, name?: string): AgentView {
    const cur = this.get(id);
    if (!cur) throw new Error(`No agent "${id}"`);
    const nm = name?.trim() || `${cur.def.name} copy`;
    return this.create({ ...cur.def, id: slugify(nm), name: nm }, `cloned from ${cur.def.name} v${cur.version}`);
  }

  /** Restore an old version. It becomes the newest version; nothing in between is lost. */
  rollback(id: string, version: number): AgentView {
    const old = this.version(id, version);
    if (!old) throw new Error(`No version ${version} of "${id}"`);
    return this.save(id, old.def, { note: `rolled back to v${version}` });
  }

  retire(id: string, retired = true): void {
    const cur = this.get(id);
    if (!cur) throw new Error(`No agent "${id}"`);
    if (cur.builtin && retired) throw new Error("Built-in agents cannot be retired; take them off their station instead.");
    this.log.append("bay.agent.retired", { id, retired });
    this.visual(`agent ${id}`);
  }

  /** Put agents on a station. The Council takes up to six seats; every other station takes one. */
  assign(slot: Slot, ids: string[], by = "you"): Record<Slot, string[]> {
    if (!SLOTS.includes(slot)) throw new Error(`Unknown station "${slot}"`);
    const live = new Set(this.agents().filter((a) => !a.retired).map((a) => a.def.id));
    const list = [...new Set(ids)];
    for (const id of list) if (!live.has(id)) throw new Error(`No active agent "${id}"`);
    if (!list.length) throw new Error("A station needs at least one agent");
    if (list.length > SLOT_SEATS[slot]) throw new Error(`${slot} takes at most ${SLOT_SEATS[slot]} agent${SLOT_SEATS[slot] > 1 ? "s" : ""}`);
    this.log.append("bay.assign", { slot, agents: list, by });
    this.visual(`station ${slot}`);
    return this.slots();
  }

  importFile(text: string): AgentView {
    const def = parseAgentFile(text);
    return this.create(def, "imported from a file");
  }

  /** Describe an agent in one line; the Overseer drafts it (free heuristics on the mock or if the draft is unusable). */
  async draft(description: string): Promise<AgentView> {
    const text = description.trim();
    if (!text) throw new Error("Describe the agent in a line");
    let def: Partial<AgentDef> = heuristicDraft(text);
    let note = "drafted from a description";
    if (this.runtime && this.runtime.name !== "mock") {
      const overseer = this.get("overseer")!;
      const r = await runAgent(this.log, this.runtime, "overseer", {
        prompt: `Description: ${text}`, model: overseer.def.model, systemPrompt: `${overseer.def.prompt}\n\n${DRAFT_CONTRACT}`, budgetUsd: 0.05,
      }, { agentVersion: overseer.version, station: "draft" });
      try {
        const j = parseJsonBlock<Partial<AgentDef>>(r.result?.text ?? "");
        // The id always comes from the name, never from a word the draft picked ("council-seat").
        def = normalizeAgent({ ...def, ...j, id: undefined, budgetUsd: Math.min(0.6, Number(j.budgetUsd ?? def.budgetUsd)) } as any);
        note = "drafted by the Overseer";
      } catch { note = "drafted from a description (the Overseer's draft was unusable)"; }
    }
    return this.create(def, note);
  }

  /** Run an agent once on its sample task and check the answer the way its station's verifier would. */
  async test(id: string, task?: string): Promise<BayTest> {
    const a = this.get(id);
    if (!a) throw new Error(`No agent "${id}"`);
    if (!this.runtime) throw new Error("No agent runtime");
    const station = a.def.station;
    const sample = (task ?? a.def.sample).trim() || BUILTIN_AGENTS.find((b) => b.station === station)?.sample || "Say what you do, in one sentence.";
    const start = this.log.append("bay.test", { agent: id, version: a.version, station, task: sample, state: "running" });
    const prompt = samplePrompt(station, sample);
    const r = await runAgent(this.log, this.runtime, id, {
      prompt, model: a.def.model, systemPrompt: systemPromptFor(a.def, station, principles(this.log)), budgetUsd: Math.min(a.def.budgetUsd, 0.25),
      ...kitOf(a.def),
    }, { agentVersion: a.version, station: station === "none" ? undefined : station, bayTest: true });
    const checks: { label: string; pass: boolean }[] = [{ label: "answered within its cap", pass: !r.error }];
    if (r.result) checks.push(...verify(station, r.result.text), { label: "did the task (no \"I could not\")", pass: !COULD_NOT.test(r.result.text) });
    const pass = checks.every((c) => c.pass);
    this.log.append("bay.test", { id: start.id, agent: id, version: a.version, state: "done", pass, checks, output: (r.result?.text ?? "").slice(0, 4000), error: r.error, costUsd: r.result?.costUsd ?? 0, runId: r.runId });
    this.visual(`test of ${id}`);
    return this.tests().find((t) => t.id === start.id)!;
  }

  /** visualizeEverything for the Bay: every agent has a crew card, every station its seats, every test a result card. */
  private visual(scope: string) {
    const items: string[] = [];
    const missing: string[] = [];
    const agents = this.agents();
    for (const a of agents) {
      const ok = !!a.def.avatar && !!a.def.name && !!a.def.model;
      (ok ? items : missing).push(`${a.def.name}: crew card (avatar, model, state, cost)`);
    }
    const slots = this.slots();
    const ids = new Set(agents.filter((a) => !a.retired).map((a) => a.def.id));
    for (const s of SLOTS) (slots[s].every((x) => ids.has(x)) ? items : missing).push(`${s}: ${slots[s].length} seat${slots[s].length > 1 ? "s" : ""} on the station board`);
    for (const t of this.tests().filter((x) => x.state === "done").slice(-1)) (t.checks?.length || t.error ? items : missing).push(`test of ${t.agent}: result card`);
    this.log.append("bay.visual", { scope, pass: missing.length === 0, items: items.length > 14 ? [...items.slice(0, 13), `and ${items.length - 13} more`] : items, missing });
  }
}

function changeNote(a: AgentDef, b: AgentDef): string {
  const changed = (Object.keys(b) as (keyof AgentDef)[]).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  return changed.length ? `changed ${changed.join(", ")}` : "saved";
}

function samplePrompt(station: HomeStation, sample: string): string {
  switch (station) {
    case "council": case "plan": return `Idea: ${sample}`;
    case "tests": return `Approved spec:\n${sample}`;
    case "build": return `Spec:\n${sample}`;
    case "order": return archivistPrompt(sample, foldOrder([]));
    case "improve": return `${sample}\n\nAlready proposed for this subject: nothing yet.`;
    default: return sample;
  }
}

/** The station verifier, applied to one sample answer. */
export function verify(station: HomeStation, text: string): { label: string; pass: boolean }[] {
  const check = (label: string, fn: () => boolean) => { try { return { label, pass: fn() }; } catch { return { label, pass: false }; } };
  switch (station) {
    case "council": return [check("a seat take with a vote (council format)", () => !!parseSeatTake(text))];
    case "plan": return [check("a spec with acceptance criteria and a task graph", () => !!validatePlan(parseJsonBlock<Plan>(text)))];
    case "tests": return [check("test/*.js files in file blocks", () => parseFileBlocks(text).some((f) => isLockedTest(f.path) && f.path.endsWith(".js")))];
    case "build": case "fix": return [check("source files in file blocks, none under test/", () => { const f = parseFileBlocks(text); return f.length > 0 && f.every((x) => !isLockedTest(x.path)); })];
    case "review": return [check("a verdict with findings (review format)", () => !!parseReview(text))];
    case "order": return [check("fragments filed under nodes (Archivist format)", () => !!parseArchivistPlan(text, foldOrder([])))];
    case "map": return [check("a purpose for each module (map format)", () => !!parseModuleNotes(text)?.length)];
    case "survey": return [check("suggestions with severity and files (survey format)", () => !!parseSuggestions(text)?.length)];
    case "improve": return [check("proposals with impact and effort (improve format)", () => Array.isArray(parseLensAnswer(text)))];
    default: return [check("a non-empty answer", () => text.trim().length > 0)];
  }
}

/** An answer that says the agent could not do the task (a tool refused, no access) fails its test, however well it is shaped. */
export const COULD_NOT = /\bI (?:could ?n[o']t|can ?n[o']t|cannot|was unable to|am unable to)\b[^.\n]{0,60}\b(?:run|use|access|reach|complete|perform|do|search|fetch|research)\b|\bblocked by a permission|\bpermission (?:prompt|was denied|denied)/i;

/** A free first draft from the words of the description. */
export function heuristicDraft(text: string): AgentDef {
  const t = text.toLowerCase();
  const named = text.match(/\b(?:called|named)\s+["“]?([A-Za-z][\w -]{1,30}?)["”]?(?:[,.;]|\s+(?:that|who|which|to)\b|$)/i)?.[1];
  const station: HomeStation =
    /\b(test|tests|qa)\b/.test(t) ? "tests" : /\breview|audit|check\b/.test(t) ? "review" : /\b(spec|plan|planner)\b/.test(t) ? "plan"
      : /\b(fix|debug|repair)\b/.test(t) ? "fix" : /\b(council|critic|critique|brainstorm|devil)\b/.test(t) ? "council"
        : /\b(improve|improvement|improvements|lens)\b/.test(t) ? "improve" : /\b(file|sort|archive|organi[sz]e)\b/.test(t) ? "order" : /\b(build|code|write|implement)\b/.test(t) ? "build" : "none";
  const model = /\b(opus|best|deepest)\b/.test(t) ? "opus" : /\b(sonnet|strong|smart|careful|senior|deep)\b/.test(t) ? "sonnet" : "haiku";
  const words = text.replace(/[^A-Za-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !/^(the|and|for|that|who|which|with|agent|an|a|my|our|this)$/i.test(w));
  const name = (named ?? words.slice(0, 2).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ")) || "New Agent";
  const avatar = ({ council: "✶", plan: "◇", tests: "⊘", build: "▣", review: "◎", fix: "⚒", order: "❖", overseer: "◈", improve: "✧", map: "⌖", survey: "⌕", none: "◆" } as const)[station];
  return normalizeAgent({
    name, avatar, station, model, budgetUsd: model === "haiku" ? 0.05 : model === "sonnet" ? 0.3 : 0.6,
    description: text.slice(0, 300), sample: BUILTIN_AGENTS.find((b) => b.station === station)?.sample ?? "",
    prompt: `You are ${name}, an agent of SoftwareFactory. ${text.trim().replace(/([^.!?])$/, "$1.")} Be concise and concrete.`,
  } as any);
}
