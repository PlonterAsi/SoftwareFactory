import "./tables.js";
import type { EventLog, SfEvent } from "../events.js";
import type { AgentRuntime } from "../runtime.js";
import { runAgent } from "../agents.js";
import { captureSignal } from "../signals.js";
import type { CrewSource } from "../factory/crew.js";
import { canonFor, type OrderState } from "../order/model.js";
import { listProjects, projectDetail, registerProjectFacet } from "../projects/service.js";
import { mergeLenses, memoryText, parseLensAnswer, type Draft, type Effort, type Impact, type LensProposal, type ProposalStatus, type Remembered, type Target } from "./lenses.js";

/**
 * The Improvement Council: a standing loop that looks again at what already
 * exists (projects, ideas, shipped apps, and SoftwareFactory itself) and
 * proposes how to make it better, through six lenses: integrate, automate,
 * simplify, enrich, UX and flow.
 *
 *   pick a subject (changed since its last review, or not looked at for 14 days)
 *     → read it from the database (rules, notes, runs, reviews, what was already proposed)
 *     → every lens seat proposes at most 2 changes, in parallel (Haiku, capped per call)
 *     → plain code merges alike proposals, drops anything already said or rejected, ranks
 *     → the proposals queue on the Bridge: accept, park or reject with one tap
 *     → accepted: a ticket when the ticket system is loaded, otherwise a task Signal
 *       filed under its project; a build only starts when you press Build.
 *
 * It never starts a build and never spends past its daily cap. On its own it runs
 * only on the real crew, at most every few hours, and pauses while the inbox is full.
 */

export interface ImproveOptions {
  /** Daily cap for the whole council, USD (all sessions in the last 24 h). */
  maxUsd: number;
  /** Cap for one lens call, USD. */
  perCallUsd: number;
  /** Hours between automatic sessions. */
  everyHours: number;
  /** Automatic sessions pause while this many proposals wait in the inbox. */
  maxInbox: number;
  /** Look again at an unchanged subject after this many days. */
  revisitDays: number;
  /** Why automatic sessions may not run at all right now (the practice crew), or null. */
  autoGate?: () => string | null;
}

export const IMPROVE_DEFAULTS: ImproveOptions = { maxUsd: 0.2, perCallUsd: 0.03, everyHours: 6, maxInbox: 12, revisitDays: 14 };

export interface Proposal {
  id: number; ts: string; session: number | null; target: Target; title: string; why: string; change: string;
  impact: Impact; effort: Effort; lenses: string[]; agents: string[]; score: number;
  status: ProposalStatus; decidedAt?: string; note?: string; ticketId?: number; signalId?: number;
  /** Where it came from when not a council session, and the files it is about. */
  source?: ProposalSource; files?: string[];
}

/** Where a proposal came from when not a council session, e.g. { kind: "repo.suggestion", eventId, suggestionId }. */
export interface ProposalSource { kind: string; eventId?: number; suggestionId?: string | number }

export interface SeatRecord { agent: string; name: string; version: number; state: "thinking" | "done" | "failed"; count?: number; costUsd?: number; error?: string }

export interface Session {
  id: number; ts: string; trigger: "auto" | "manual"; target: Target; why: string;
  seats: SeatRecord[]; state: "running" | "done" | "failed"; costUsd: number;
  proposals: number[]; suppressed: { title: string; because: string }[]; note?: string; endedAt?: string;
}

export interface Candidate { target: Target; lastChange: string | null; lastReviewed: string | null; due: boolean; why: string }

export interface ImproveState {
  sessions: Session[];
  proposals: Proposal[];
  candidates: Candidate[];
  budget: { spentTodayUsd: number; maxUsd: number; perCallUsd: number; totalUsd: number };
  auto: { on: boolean; everyHours: number; maxInbox: number; nextAt: string | null; blocked: string | null };
  busy: boolean;
}

export type { Target } from "./lenses.js";
type P = Record<string, any>;

export class ImproveCouncil {
  opts: ImproveOptions;
  /** Automatic sessions: on by default, off on the practice crew (its answers are canned). Set by the server. */
  auto = true;
  private running: Promise<Session> | null = null;

  constructor(private log: EventLog, private runtime: AgentRuntime, private crew: CrewSource, private order: () => OrderState, opts: Partial<ImproveOptions> = {}) {
    // An option left undefined keeps its default.
    this.opts = { ...IMPROVE_DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
    // A session cut off by a restart would show as running forever.
    for (const s of this.sessions()) if (s.state === "running") this.log.append("improve.session", { state: "failed", session: s.id, costUsd: s.costUsd, proposals: [], suppressed: [], note: "The app closed during this session." });
  }

  // ---------- reading ----------

  private events(type: SfEvent["type"]) { return this.log.list({ type, limit: 1e6 }); }

  sessions(): Session[] {
    const by = new Map<number, Session>();
    for (const e of this.log.list({ limit: 1e6 }).filter((x) => x.type === "improve.session" || x.type === "improve.seat")) {
      const p = e.payload as P;
      if (e.type === "improve.session" && p.state === "started") {
        by.set(e.id, { id: e.id, ts: e.ts, trigger: p.trigger, target: p.target, why: p.why ?? "", seats: (p.seats ?? []).map((s: P) => ({ ...s, state: "thinking" })), state: "running", costUsd: 0, proposals: [], suppressed: [] });
      } else if (e.type === "improve.seat") {
        const s = by.get(Number(p.session));
        const seat = s?.seats.find((x) => x.agent === p.agent);
        if (s && seat) { Object.assign(seat, { state: p.state, count: p.count, costUsd: p.costUsd, error: p.error }); s.costUsd += Number(p.costUsd ?? 0); }
      } else {
        const s = by.get(Number(p.session));
        if (s) Object.assign(s, { state: p.state, costUsd: Number(p.costUsd ?? s.costUsd), proposals: p.proposals ?? [], suppressed: p.suppressed ?? [], note: p.note, endedAt: e.ts });
      }
    }
    return [...by.values()];
  }

  proposals(): Proposal[] {
    const by = new Map<number, Proposal>();
    for (const e of this.log.list({ limit: 1e6 }).filter((x) => x.type.startsWith("improve.proposal"))) {
      const p = e.payload as P;
      if (e.type === "improve.proposal") {
        by.set(e.id, { id: e.id, ts: e.ts, session: p.session ?? null, target: p.target, title: p.title, why: p.why ?? "", change: p.change, impact: p.impact, effort: p.effort, lenses: p.lenses ?? [], agents: p.agents ?? [], score: Number(p.score ?? 0), status: "inbox", source: p.source, files: p.files });
      } else if (e.type === "improve.proposal.decided") {
        const x = by.get(Number(p.id));
        if (x) Object.assign(x, { status: p.decision, decidedAt: e.ts, note: p.note ?? undefined });
      } else if (e.type === "improve.proposal.linked") {
        const x = by.get(Number(p.id));
        if (x) { if (p.ticketId != null) x.ticketId = Number(p.ticketId); if (p.signalId != null) x.signalId = Number(p.signalId); }
      }
    }
    return [...by.values()];
  }

  /** Spend of the lens seats in the last 24 hours, from the organized agent_runs table. */
  spentTodayUsd(now = Date.now()): number {
    const since = new Date(now - 86_400_000).toISOString();
    return Number((this.log.db.prepare("SELECT coalesce(sum(cost_usd), 0) AS s FROM agent_runs WHERE station = 'improve' AND started_at >= ?").get(since) as { s: number } | undefined)?.s ?? 0);
  }

  private totalUsd(): number {
    return Number((this.log.db.prepare("SELECT coalesce(sum(cost_usd), 0) AS s FROM improve_sessions").get() as { s: number }).s);
  }

  /** Everything the council could look at, with whether it is due and why. */
  candidates(now = Date.now()): Candidate[] {
    const st = this.order();
    const reviewed = new Map<string, string>();
    for (const s of this.sessions()) if (s.state !== "failed") reviewed.set(key(s.target), s.ts);
    const out: Candidate[] = [];
    const add = (target: Target, lastChange: string | null) => {
      const lastReviewed = reviewed.get(key(target)) ?? null;
      let due = false; let why = "";
      if (!lastChange) why = "nothing in it yet";
      else if (!lastReviewed) { due = true; why = "never reviewed"; }
      else if (lastChange > lastReviewed) { due = true; why = "changed since its last review"; }
      else if (now - Date.parse(lastReviewed) >= this.opts.revisitDays * 86_400_000) { due = true; why = `not looked at for ${this.opts.revisitDays} days`; }
      else why = "reviewed, unchanged since";
      out.push({ target, lastChange, lastReviewed, due, why });
    };
    // Notes the council itself filed (accepted proposals) do not count as a change, or it would review its own answers.
    const ownSignal = (id: number) => st.signals[id]?.source === "improve";
    const notesIn = (nodes: Set<number>) => st.fragments.filter((f) => f.nodeId != null && nodes.has(f.nodeId) && f.state === "live" && f.kind !== "noise" && !ownSignal(f.signalId));
    const newest = (ts: (string | null | undefined)[]) => ts.filter((x): x is string => !!x).sort().at(-1) ?? null;
    const finished = new Map((this.log.db.prepare("SELECT id, finished_at FROM factory_runs WHERE finished_at IS NOT NULL").all() as { id: number; finished_at: string }[]).map((r) => [Number(r.id), r.finished_at]));
    // Projects (packages/core/src/projects): their Order Engine trees and their factory runs.
    const held = new Set<number>();
    for (const p of listProjects(this.log)) {
      if (p.status === "archived") continue;
      const d = projectDetail(this.log, p.id);
      if (!d) continue;
      d.runIds.forEach((r) => held.add(r));
      add({ kind: "project", id: p.id, title: p.name }, newest([...notesIn(new Set(d.nodeIds)).map((f) => f.ts), ...d.runIds.map((r) => finished.get(r)), p.summary ? p.createdAt : null]));
    }
    // An idea inside a project with enough notes gets its own look.
    for (const n of st.nodes.filter((x) => x.mergedInto == null && x.kind === "idea" && x.parentId != null)) {
      const frags = notesIn(subtree(st, n.id));
      if (frags.length >= 2) add({ kind: "idea", id: n.id, title: n.title }, newest(frags.map((f) => f.ts)));
    }
    // A shipped run that no project holds is looked at on its own.
    const runs = this.log.db.prepare("SELECT id, idea, plan_name, finished_at FROM factory_runs WHERE outcome = 'shipped' ORDER BY id").all() as { id: number; idea: string; plan_name: string | null; finished_at: string }[];
    for (const r of runs) if (!held.has(Number(r.id))) add({ kind: "run", id: Number(r.id), title: r.plan_name ?? r.idea.slice(0, 60) }, r.finished_at);
    const lastRun = this.log.db.prepare("SELECT max(finished_at) AS t FROM factory_runs WHERE finished_at IS NOT NULL").get() as { t: string | null };
    add({ kind: "factory", id: null, title: "SoftwareFactory itself" }, lastRun.t ?? null);
    return out;
  }

  /** The next subject: the due one looked at longest ago (never first), newest change breaking ties. */
  pick(now = Date.now()): Candidate | null {
    const due = this.candidates(now).filter((c) => c.due);
    due.sort((a, b) => (a.lastReviewed ?? "").localeCompare(b.lastReviewed ?? "") || (b.lastChange ?? "").localeCompare(a.lastChange ?? ""));
    return due[0] ?? null;
  }

  /** Why an automatic session would not run now, or null when it may. */
  autoBlocked(now = Date.now()): string | null {
    if (!this.auto) return "automatic sessions are off";
    const gate = this.opts.autoGate?.();
    if (gate) return gate;
    if (this.running) return "a session is running";
    const inbox = this.proposals().filter((p) => p.status === "inbox").length;
    if (inbox >= this.opts.maxInbox) return `${inbox} proposals wait for you; the council pauses until you go through them`;
    if (this.spentTodayUsd(now) + this.opts.perCallUsd > this.opts.maxUsd) return `today's $${this.opts.maxUsd.toFixed(2)} is spent`;
    const last = this.sessions().filter((s) => s.trigger === "auto").at(-1);
    if (last && now - Date.parse(last.ts) < this.opts.everyHours * 3_600_000) return `next look after ${new Date(Date.parse(last.ts) + this.opts.everyHours * 3_600_000).toISOString()}`;
    if (!this.pick(now)) return "nothing changed since the last reviews";
    return null;
  }

  state(now = Date.now()): ImproveState {
    const last = this.sessions().filter((s) => s.trigger === "auto").at(-1);
    return {
      sessions: this.sessions().slice(-30),
      proposals: this.proposals().slice(-300),
      candidates: this.candidates(now),
      budget: { spentTodayUsd: this.spentTodayUsd(now), maxUsd: this.opts.maxUsd, perCallUsd: this.opts.perCallUsd, totalUsd: this.totalUsd() },
      auto: { on: this.auto, everyHours: this.opts.everyHours, maxInbox: this.opts.maxInbox, nextAt: last ? new Date(Date.parse(last.ts) + this.opts.everyHours * 3_600_000).toISOString() : null, blocked: this.autoBlocked(now) },
      busy: !!this.running,
    };
  }

  // ---------- the loop ----------

  /** The scheduler's tick: run one automatic session when nothing blocks it. */
  async tick(now = Date.now()): Promise<Session | null> {
    if (this.autoBlocked(now)) return null;
    const c = this.pick(now);
    return c ? this.run({ target: c.target, trigger: "auto", why: c.why }) : null;
  }

  /** One session on one subject (the next due one when none is given). */
  run(opts: { target?: Target; trigger?: "auto" | "manual"; why?: string } = {}): Promise<Session> {
    if (this.running) throw new Error("The Improvement Council is already in session.");
    let target = opts.target;
    let why = opts.why ?? "you asked";
    if (!target) {
      const c = this.pick() ?? this.candidates().find((x) => x.lastChange) ?? null;
      if (!c) throw new Error("There is nothing to look at yet: capture an idea or ship a run first.");
      target = c.target; why = c.due ? c.why : "you asked";
    } else target = this.resolve(target);
    if (this.spentTodayUsd() + this.opts.perCallUsd > this.opts.maxUsd) throw new Error(`Today's Improvement Council budget of $${this.opts.maxUsd.toFixed(2)} is spent. It refills over the next 24 hours.`);
    const p = this.session(target, opts.trigger ?? "manual", why).finally(() => { this.running = null; });
    this.running = p;
    return p;
  }

  private async session(target: Target, trigger: "auto" | "manual", why: string): Promise<Session> {
    const crew = this.crew.crewFor("improve");
    const start = this.log.append("improve.session", { state: "started", trigger, target, why, seats: crew.map((m) => ({ agent: m.id, name: m.name, version: m.version })) });
    const id = start.id;
    let cost = 0;
    // Seats run in parallel, so each reserves its cap before it calls; the daily cap holds even if every seat spends its whole cap.
    let inflight = 0;
    try {
      const memory = this.memory();
      const prompt = `${this.context(target)}\n\n${memoryText(memory, target)}`;
      const answers: { lens: string; agent: string; proposals: LensProposal[] }[] = [];
      await Promise.all(crew.map(async (m, seat) => {
        // The daily cap is checked per call, so a session can stop part way and keep what it has.
        const cap = Math.min(m.budgetUsd, this.opts.perCallUsd);
        if (this.spentTodayUsd() + inflight + cap > this.opts.maxUsd + 1e-9) {
          this.log.append("improve.seat", { session: id, agent: m.id, state: "failed", count: 0, costUsd: 0, error: "Skipped: today's budget is spent." });
          return;
        }
        inflight += cap;
        const r = await runAgent(this.log, this.runtime, m.id, {
          prompt, model: m.model, systemPrompt: m.role, budgetUsd: cap, pluginDirs: m.pluginDirs.length ? m.pluginDirs : undefined, tools: m.tools, mcpConfig: m.mcpConfig,
        }, { station: "improve", agentVersion: m.version, seat }).finally(() => { inflight -= cap; });
        const c = r.result?.costUsd ?? 0;
        cost += c;
        let proposals: LensProposal[] = [];
        let error = r.error;
        if (r.result) { try { proposals = parseLensAnswer(r.result.text); } catch (e) { error = (e as Error).message; } }
        this.log.append("agent.verdict", { agent: m.id, version: m.version, station: "improve", pass: !error, note: error ?? `${proposals.length} proposals` });
        this.log.append("improve.seat", { session: id, agent: m.id, state: error ? "failed" : "done", count: proposals.length, costUsd: c, error });
        if (!error) answers.push({ lens: m.name, agent: m.id, proposals });
      }));
      // Seats answer in parallel; merge in seat order so the result does not depend on who was fastest.
      const order = crew.map((m) => m.id);
      answers.sort((a, b) => order.indexOf(a.agent) - order.indexOf(b.agent));
      const { drafts, suppressed } = mergeLenses(answers, memory, target);
      const ids = drafts.map((d) => this.log.append("improve.proposal", { session: id, target, ...d }).id);
      const failed = crew.length > 0 && answers.length === 0;
      const note = failed ? "No lens answered; see the agent calls for why." : `${drafts.length} new proposal${drafts.length === 1 ? "" : "s"}${suppressed.length ? `, ${suppressed.length} dropped as already said` : ""}.`;
      this.log.append("improve.session", { state: failed ? "failed" : "done", session: id, costUsd: cost, proposals: ids, suppressed, note });
      this.visual(id, drafts);
    } catch (e) {
      this.log.append("improve.session", { state: "failed", session: id, costUsd: cost, proposals: [], suppressed: [], note: (e as Error).message });
    }
    return this.sessions().find((s) => s.id === id)!;
  }

  /** Accept, park or reject. Accepting files it as work: a ticket when the ticket system answers, otherwise a task Signal under its project. */
  decide(id: number, decision: "accepted" | "rejected" | "parked" | "inbox", note?: string, by = "you"): Proposal {
    const p = this.proposals().find((x) => x.id === id);
    if (!p) throw new Error(`No proposal #${id}`);
    if (p.status === decision) return p;
    this.log.append("improve.proposal.decided", { id, decision, note: note?.slice(0, 500) ?? null, by });
    if (decision === "accepted" && p.ticketId == null && p.signalId == null) {
      const body = `${p.change}${p.why ? `\nWhy: ${p.why}` : ""}`;
      this.log.append("improve.proposal.accepted", { id, title: p.title, body, lens: p.lenses[0] ?? "", lenses: p.lenses, target: p.target, impact: p.impact, effort: p.effort, ...(p.source ? { source: p.source } : {}) });
      // The ticket system listens for the event above and links its ticket in the same tick.
      if (this.proposals().find((x) => x.id === id)?.ticketId == null) {
        const where = p.target.kind === "factory" ? "SoftwareFactory" : p.target.title;
        const s = captureSignal(this.log, `Task for ${where}: ${p.title}. ${p.change}`, "improve");
        this.log.append("improve.proposal.linked", { id, signalId: s.id });
      }
    }
    return this.proposals().find((x) => x.id === id)!;
  }

  /** The idea a Build button starts for an accepted proposal. */
  buildIdea(id: number): string {
    const p = this.proposals().find((x) => x.id === id);
    if (!p) throw new Error(`No proposal #${id}`);
    if (p.target.kind === "run") {
      const r = this.log.db.prepare("SELECT idea FROM factory_runs WHERE id = ?").get(p.target.id) as { idea: string } | undefined;
      return `${r?.idea ?? p.target.title}. Improved: ${p.title}. ${p.change}`.slice(0, 1000);
    }
    return `${p.title}: ${p.change}${p.target.kind !== "factory" ? ` (for ${p.target.title})` : ""}`.slice(0, 1000);
  }

  /**
   * File a proposal that came from somewhere else (for example a code map of an imported repo),
   * through the same memory: anything already said for that subject, or rejected anywhere, is dropped.
   */
  fileExternal(target: Target, p: LensProposal & { lens: string; source: ProposalSource; files?: string[] }): number | null {
    const { drafts } = mergeLenses([{ lens: p.lens, agent: p.source.kind, proposals: [p] }], this.memory(), target, 1);
    if (!drafts.length) return null;
    return this.log.append("improve.proposal", { session: null, target, ...drafts[0], source: p.source, files: p.files?.slice(0, 20) }).id;
  }

  /** Listen for suggestions other parts of the factory publish as events. */
  listen() {
    this.log.on("event", (e: SfEvent) => {
      if ((e.type as string) !== "repo.suggestion") return;
      const p = e.payload as P;
      if (p.projectId == null || !p.title) return;
      const sev = String(p.severity ?? "medium").toLowerCase();
      const impact: Impact = sev === "critical" || sev === "high" ? "high" : sev === "low" || sev === "info" ? "low" : "medium";
      const effort: Effort = p.effort === "small" || p.effort === "large" ? p.effort : "medium";
      try {
        this.fileExternal({ kind: "project", id: Number(p.projectId), title: String(p.projectTitle ?? p.project ?? `project #${p.projectId}`) },
          { title: String(p.title).slice(0, 120), why: "", change: String(p.body ?? p.title).slice(0, 400), impact, effort, lens: String(p.lens ?? "Code health"), source: { kind: "repo.suggestion", eventId: e.id, suggestionId: p.suggestionId ?? undefined }, files: Array.isArray(p.files) ? p.files.map(String) : undefined });
      } catch (err) { console.error("improve: could not file a repo suggestion:", err); }
    });
    return this;
  }

  // ---------- what a lens reads ----------

  private memory(): Remembered[] {
    return this.proposals().map((p) => ({ id: p.id, title: p.title, change: p.change, status: p.status, target: p.target }));
  }

  private resolve(t: Target): Target {
    const c = this.candidates().find((x) => x.target.kind === t.kind && x.target.id === (t.id ?? null));
    if (!c) throw new Error(`Nothing to review as ${t.kind} #${t.id}`);
    return c.target;
  }

  /** The subject as plain text, from the database: no model reads anything else. */
  context(t: Target): string {
    const st = this.order();
    const lines: string[] = [];
    const runRows = this.log.db.prepare("SELECT id, idea, plan_name, outcome, reason, total_usd, fix_rounds FROM factory_runs ORDER BY id DESC LIMIT 200").all() as unknown as RunRow[];
    const rules = (ids: number[]) => {
      const canon = [...new Map(ids.flatMap((id) => canonFor(st, id)).map((c) => [c.fragment.id, c])).values()].slice(0, 10).map((c) => `- ${c.fragment.text}`);
      if (canon.length) lines.push(`Its rules and decisions (the person's; respect them):\n${canon.join("\n")}`);
    };
    const notes = (nodes: Set<number>, parents: number[]) => {
      const ns = st.fragments.filter((f) => f.nodeId != null && nodes.has(f.nodeId) && f.state === "live" && f.kind !== "noise" && f.kind !== "rule" && f.kind !== "decision")
        .sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 20).map((f) => `- [${f.kind}${f.important ? ", important" : ""}] ${f.text.slice(0, 240)}`);
      if (ns.length) lines.push(`Notes filed here, newest first:\n${ns.join("\n")}`);
      const kids = st.nodes.filter((x) => x.parentId != null && parents.includes(x.parentId) && x.mergedInto == null).map((x) => `- ${x.kind}: ${x.title}`);
      if (kids.length) lines.push(`Under it:\n${kids.slice(0, 12).join("\n")}`);
    };
    if (t.kind === "project") {
      const d = t.id != null ? projectDetail(this.log, t.id) : null;
      lines.push(`Subject: project "${t.title}"${d?.summary ? `: ${d.summary}` : ""}.`);
      if (d) {
        rules(d.rootNodeIds);
        notes(new Set(d.nodeIds), d.rootNodeIds);
        for (const r of d.runIds.slice(-3)) lines.push(this.runContext(r));
      }
    } else if (t.kind === "idea") {
      lines.push(`Subject: idea "${t.title}".`);
      const n = st.nodes.find((x) => x.id === t.id);
      if (n) { rules([n.id]); notes(subtree(st, n.id), [n.id]); }
    } else if (t.kind === "run") {
      lines.push(`Subject: an app the factory shipped, "${t.title}" (run #${t.id}).`);
      if (t.id != null) lines.push(this.runContext(t.id));
    } else {
      lines.push("Subject: SoftwareFactory itself, the person's loop-engineered software factory: Order Engine (files every note), Council, plan, locked tests, build, test and fix, review, gates, Agent Bay, Bridge (everything visualized). Propose improvements to its own flows, stations, agents and screens.");
      const s = this.log.db.prepare(`SELECT count(*) AS runs, count(*) FILTER (WHERE outcome = 'shipped') AS shipped, count(*) FILTER (WHERE outcome = 'failed') AS failed,
        avg(total_usd) FILTER (WHERE outcome = 'shipped') AS usd, avg(fix_rounds) AS fixes, sum(resumes) AS resumes FROM factory_runs`).get() as Record<string, number | null>;
      lines.push(`Runs: ${s.runs ?? 0}, shipped ${s.shipped ?? 0}, failed ${s.failed ?? 0}; average cost of a shipped run $${Number(s.usd ?? 0).toFixed(3)}; average fix rounds ${Number(s.fixes ?? 0).toFixed(1)}; resumed after a crash ${s.resumes ?? 0} times.`);
      const recent = runRows.filter((r) => r.outcome).slice(0, 6).map((r) => `- ${runLine(r)}`);
      if (recent.length) lines.push(`Recent runs:\n${recent.join("\n")}`);
      const agents = this.log.db.prepare(`SELECT agent, count(*) AS calls, sum(status = 'failed') AS failed, round(sum(cost_usd), 4) AS usd FROM agent_runs GROUP BY agent ORDER BY usd DESC LIMIT 8`).all() as { agent: string; calls: number; failed: number; usd: number }[];
      if (agents.length) lines.push(`Agents by spend:\n${agents.map((a) => `- ${a.agent}: ${a.calls} calls, ${a.failed} failed, $${a.usd}`).join("\n")}`);
      const open = st.conflicts.filter((c) => c.status === "open").length;
      const tray = st.fragments.filter((f) => f.nodeId == null && f.state === "live" && f.kind !== "noise").length;
      lines.push(`Order Engine: ${st.fragments.length} notes filed, ${tray} still unsorted, ${open} open conflicts.`);
      const gates = this.log.db.prepare("SELECT count(*) AS n FROM events WHERE type = 'factory.gate' AND json_extract(payload, '$.state') = 'waiting'").get() as { n: number };
      lines.push(`Times a run waited for the person at a gate: ${gates.n}.`);
    }
    for (const [name, fn] of contextSources) {
      try { const extra = fn(this.log, t)?.trim(); if (extra) lines.push(extra.slice(0, 3000)); } catch (e) { console.error(`improve context ${name} failed:`, e); }
    }
    // Other things the person has: what an integrate lens connects to.
    const projects = listProjects(this.log).filter((p) => p.status !== "archived" && !(t.kind === "project" && p.id === t.id));
    const others = projects.slice(0, 12).map((p) => `- project: ${p.name}${p.summary ? ` (${p.summary.slice(0, 100)})` : ""}${p.rollup.shipped ? `, ${p.rollup.shipped} shipped` : ""}`);
    const shipped = projects.length ? [] : runRows.filter((r) => r.outcome === "shipped" && !(t.kind === "run" && r.id === t.id)).slice(0, 8).map((r) => `- shipped app: ${r.plan_name ?? r.idea.slice(0, 60)}`);
    if (others.length || shipped.length) lines.push(`The person's other projects and apps:\n${[...others, ...shipped].join("\n")}`);
    return lines.join("\n\n");
  }

  /** One factory run as a lens reads it: the idea, the spec, how it went, what review and the build Council raised. */
  private runContext(id: number): string {
    const r = this.log.db.prepare("SELECT id, idea, plan_name, outcome, reason, total_usd, fix_rounds FROM factory_runs WHERE id = ?").get(id) as RunRow | undefined;
    if (!r) return "";
    const lines = [`Factory run #${id}, built from the idea: ${r.idea}`];
    const plan = this.log.db.prepare("SELECT payload FROM events WHERE type = 'factory.plan' AND json_extract(payload, '$.run') = ? ORDER BY id DESC LIMIT 1").get(id) as { payload: string } | undefined;
    const spec = plan ? (JSON.parse(plan.payload).plan ?? {}) : {};
    if (spec.summary) lines.push(`Summary: ${spec.summary}`);
    if (spec.interface) lines.push(`Interface: ${String(spec.interface).slice(0, 600)}`);
    if (Array.isArray(spec.acceptance)) lines.push(`Acceptance criteria:\n${spec.acceptance.slice(0, 8).map((a: string) => `- ${a}`).join("\n")}`);
    lines.push(`How the run went: ${runLine(r)}`);
    const reviews = this.log.db.prepare("SELECT payload FROM events WHERE type = 'factory.review' AND json_extract(payload, '$.run') = ? ORDER BY id").all(id) as { payload: string }[];
    const findings = reviews.flatMap((x) => (JSON.parse(x.payload).findings ?? []) as { severity: string; text: string }[]).slice(0, 6).map((f) => `- [${f.severity}] ${f.text}`);
    if (findings.length) lines.push(`Reviewer findings:\n${findings.join("\n")}`);
    const council = this.log.db.prepare("SELECT concerns, proposals FROM council_sessions WHERE factory_run = ? ORDER BY round DESC LIMIT 1").get(id) as { concerns: string; proposals: string } | undefined;
    if (council) {
      const left = [...JSON.parse(council.proposals ?? "[]"), ...JSON.parse(council.concerns ?? "[]")].slice(0, 6).map((x: string) => `- ${x}`);
      if (left.length) lines.push(`What the build Council raised before it was planned:\n${left.join("\n")}`);
    }
    return lines.join("\n");
  }

  /** visualizeEverything: every seat is a spoke on the lens wheel, every proposal a card, the spend a meter. */
  private visual(session: number, drafts: Draft[]) {
    const s = this.sessions().find((x) => x.id === session);
    const items = [
      ...(s?.seats ?? []).map((x) => `${x.name}: spoke on the lens wheel (${x.state}, ${x.count ?? 0} proposals)`),
      ...drafts.map((d) => `proposal card: ${d.title.slice(0, 60)}`),
      `cost meter: $${this.spentTodayUsd().toFixed(4)} of $${this.opts.maxUsd.toFixed(2)} today`,
    ];
    this.log.append("improve.visual", { session, pass: true, items, missing: [] });
  }
}

/**
 * Other parts of the factory can add what they know about a subject to what the lenses read
 * (for example a code map of an imported repo), without this module importing them.
 */
export type ContextSource = (log: EventLog, target: Target) => string | null | undefined;
const contextSources = new Map<string, ContextSource>();
export function registerImproveContext(name: string, fn: ContextSource) { contextSources.set(name, fn); }

interface RunRow { id: number; idea: string; plan_name: string | null; outcome: string | null; reason: string | null; total_usd: number | null; fix_rounds: number | null }
const runLine = (r: RunRow) => `run #${r.id} ${r.plan_name ?? r.idea.slice(0, 80)}: ${r.outcome ?? "in flight"}${r.total_usd != null ? `, $${r.total_usd.toFixed(3)}` : ""}${r.fix_rounds ? `, ${r.fix_rounds} fix rounds` : ""}${r.outcome && r.outcome !== "shipped" && r.reason ? ` (${r.reason.slice(0, 100)})` : ""}`;

const key = (t: Target) => `${t.kind}:${t.id ?? ""}`;

function subtree(st: OrderState, id: number): Set<number> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of st.nodes) if (n.parentId != null && out.has(n.parentId) && !out.has(n.id)) { out.add(n.id); grew = true; }
  }
  return out;
}

/** Each project's detail shows its improvement proposals by status (packages/core/src/projects). */
registerProjectFacet({
  id: "improvements",
  compute(log, project) {
    const rows = log.db.prepare("SELECT status, count(*) AS n FROM improve_proposals WHERE target_kind = 'project' AND target_id = ? GROUP BY status").all(project.id) as { status: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  },
});
