import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../factory/workspace.js";
import type { EventLog, SfEvent } from "../events.js";
import { kitArgs, kitOf } from "../factory/crew.js";
import { runAgent } from "../agents.js";
import type { AgentRuntime } from "../runtime.js";
import type { Factory } from "../factory/loop.js";
import type { AgentBay } from "../bay/bay.js";
import "./tables.js";
import { projectOf, registerProjectFacet } from "../projects/service.js";
import { EDITABLE, type TimelineCat } from "./tables.js";
import { branchFor, harnessChecks, repoOfProject, workInRepo, type RepoRef } from "./repowork.js";
import { hideTokens, parseGitHubRepo, type GitHub, type MergedPr } from "./github.js";
import { intakeDoor, routeWork, type Routed, type WorkRoute } from "../factory/route.js";
import { REPO_ENGINE_MIN_USD, type RepoRuns } from "../factory/reporun.js";
import { DEFAULT_NEXT_USD, buildAllowance } from "../projects/budget.js";
import { selfProject } from "./intake.js";
import { FlowLibrary } from "../flows/library.js";
import { RESEARCH_FLOW, runnerOf, type FlowDef } from "../flows/flow.js";
import { pickFlow, routeOfFlow, type FlowPick } from "./flowpick.js";
import { answerTicket } from "./research.js";
import { checkTicket, type TicketCheck } from "./precheck.js";
import {
  FORMS, HAND_BRAKE, KINDS, PRIORITIES, RELATIONS, TICKET_SEVERITIES, STATUSES, TASTE_KINDS,
  SIZES, autoWorkRefusal, ideaFromTicket, isClosed, keyFromName, keyText, nextMoves, refuseMove, refuseParent, titleFrom, workDocument,
  type LinkView, type NoteView, type Priority, type Size, type Relation, type TicketSeverity, type TicketKind, type TicketStatus, type TicketView,
  aKind, AUTO_KINDS,
} from "./model.js";

export interface OpenTicket {
  kind?: TicketKind;
  title?: string;
  body?: string;
  answers?: Record<string, string>;
  project?: number | null;
  priority?: Priority | null;
  severity?: TicketSeverity | null;
  assignee?: string | null;
  parent?: number | null;
  tags?: string[];
  /** Who opened it: "you", or an agent id. */
  by?: string;
  /** Where it came from: you, order, council, agent, factory, improve. */
  source?: string;
  /** The same fingerprint twice adds a note to the open ticket instead of a second ticket. */
  fingerprint?: string;
  links?: { relation: Relation; to: number }[];
  /** The `ticket.requested` event this ticket answers, and the requester's own reference. */
  request?: number;
  ref?: unknown;
  /** You asked for this work: the crew starts it by itself within your standing auto-work limit. */
  asked?: boolean;
}

export interface TicketFilter {
  project?: number | null;
  /** open (default), look (built, for your look), agents (an agent works it), plans, closed, all. */
  view?: "open" | "look" | "you" | "agents" | "plans" | "closed" | "all";
  /** Only the children of this epic or ticket. */
  parent?: number;
  kind?: TicketKind;
  status?: TicketStatus;
  q?: string;
  limit?: number;
}

/**
 * Waiting on you: built (take a look), a question (answer it), or an idea or
 * request an agent opened (build it or not). Taste stays yours.
 */
export const WAITING_ON_YOU = `t.status NOT IN ('closed', 'rejected') AND (
  t.status = 'built'
  OR (t.kind = 'question')
  OR (t.kind IN ('idea', 'request') AND t.status = 'open' AND t.opened_by != 'you'))`;

export type BoardLane = "needs" | "running" | "review" | "done";
export interface BoardCard {
  id: number; key: string; title: string; kind: string; status: TicketStatus; project: number | null; projectName: string | null;
  flow: { id: string; name: string; runner: string } | null; run: number | null; pr: { number: number; url: string; state: string } | null; updatedAt: string;
  /** In Needs you: what it needs (check: questions before money; gate: a run waits for your OK; look, answer, decide). */
  need?: "check" | "gate" | "look" | "answer" | "decide" | "merge"; say?: string; questions?: number;
  /** A PR whose CI passed: SF's merge review (git/confidence.ts), when it waits for your merge. */
  merge?: { confident: boolean; score: number; number: number } | null;
  /** While it runs: the flow step it is on (an engine station, or a session flow's step id), and whether the crew is on it now. */
  step?: string | null; stepName?: string | null; live?: boolean;
}

/** The session flow step a light-route harness step belongs to (tickets/repowork.ts names them). */
export function stepOfSession(name: string): string {
  if (name === "install" || name === "orient") return "orient";
  if (name === "build") return "build";
  if (/^fix\b/.test(name) || ["secrets", "gates", "test integrity", "tests"].includes(name)) return "checks";
  if (name === "review" || name === "review fix") return "review";
  return name;
}

export interface WaitingItem {
  ticket: TicketView;
  projectName: string | null;
  /** look: it is built; answer: a question; decide: an agent's idea or request, build it or not. */
  need: "look" | "answer" | "decide";
  /** One line for the row. */
  say: string;
  /** The moves that answer it from the row itself. */
  moves: { to: TicketStatus; label: string }[];
}

export interface TicketStep { step: string; state: "running" | "passed" | "failed" | "skipped"; note: string; at: string }
/** One row of a ticket's timeline (Tickets.timeline). */
export interface TimelineEntry { eventId: number; ts: string; by: string; cat: TimelineCat; text: string; costUsd: number | null; status: string | null; run: number | null }

export interface TicketDetail {
  ticket: TicketView;
  notes: NoteView[];
  /** The one timeline: the thread and what the crew did, in order. */
  timeline: TimelineEntry[];
  links: LinkView[];
  lines: TicketView[];
  parent: TicketView | null;
  moves: { to: TicketStatus; label: string }[];
  document: string;
  run: { id: number; outcome: string | null; station: string | null; state: string | null; spentUsd: number | null } | null;
  /** The imported repo this ticket's project came from: "Work it" works there, on a branch of a clone. */
  repo: RepoRef | null;
  /** The flow it follows if worked now (flows/flow.ts), and why. */
  flow: { id: string; name: string; runner: string; why: string; chosen: boolean } | null;
  /** In a repo project: the route "Work it" takes when you do not choose (one session, or the whole engine), with why. */
  route: Routed | null;
  /** The Builder is working it in the repo right now. */
  working: boolean;
  /** The harness steps of its latest pass in the repo (preflight, build, checks, review), each with its state. */
  steps: TicketStep[];
  /** Where it stands in the ready queue, or why the crew leaves it to you. */
  queue: { position: number | null; why: string | null } | null;
  /** You asked for it: the crew starts it within your standing auto-work limit. */
  asked: boolean;
  /** Its run stopped or failed and can be tried again from that step (SF-65), with what that adds. */
  retry: { from: string; addUsd: number } | null;
  /** Files on the ticket: screenshots, logs, reports (gap 4), newest last. */
  files: TicketFile[];
}

/** A file on a ticket. `file` is its name in the ticket's folder; `path` where it lies on this PC. */
export interface TicketFile { file: string; name: string; size: number; mime: string; by: string; at: string; path: string; image: boolean }
export const TICKET_FILE_MAX = 15 * 1024 * 1024;
const MIME_BY_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", txt: "text/plain", log: "text/plain", md: "text/markdown", json: "application/json", csv: "text/csv", html: "text/html", pdf: "application/pdf", zip: "application/zip", mp4: "video/mp4", webm: "video/webm" };
export function fileMime(name: string, given?: string): string {
  const ext = name.toLowerCase().match(/\.([a-z0-9]{1,5})$/)?.[1] ?? "";
  return MIME_BY_EXT[ext] ?? (given && /^[a-z]+\/[a-z0-9.+-]+$/i.test(given) ? given : "application/octet-stream");
}

type Row = Record<string, any>;
const pri = (p: string | null) => ({ now: 0, this_week: 1, next: 2, someday: 3 } as Record<string, number>)[p ?? ""] ?? 4;

/**
 * Every read of a ticket goes through this select: the row, its project's key,
 * its parent's kind (for its level), whether an open ticket blocks it (one whose pull request merged no
 * longer does: its work is on the main line, though a request stays built for your look), and how
 * many of its children are done. Columns of the ticket itself are `t.`.
 */
const SELECT = `SELECT t.*, k.key AS project_key, p.kind AS parent_kind,
  EXISTS (SELECT 1 FROM ticket_links l JOIN tickets b ON b.id = l.from_id
          WHERE l.to_id = t.id AND l.relation = 'blocks' AND b.status NOT IN ('closed', 'rejected') AND coalesce(b.pr_state, '') != 'merged') AS is_blocked,
  (SELECT count(*) FROM tickets c WHERE c.parent_id = t.id) AS n_children,
  (SELECT count(*) FROM tickets c WHERE c.parent_id = t.id AND c.status IN ('built', 'closed', 'rejected')) AS n_done
  FROM tickets t LEFT JOIN ticket_keys k ON k.project = t.project LEFT JOIN tickets p ON p.id = t.parent_id`;

const toView = (r: Row): TicketView => ({
  id: Number(r.id), key: keyText(r.project_key ?? null, r.number == null ? null : Number(r.number), Number(r.id)), number: r.number == null ? null : Number(r.number),
  level: r.kind === "plan" ? "epic" : r.parent_id == null || r.parent_kind === "plan" ? "ticket" : "subtask",
  blocked: !!r.is_blocked, children: { total: Number(r.n_children ?? 0), done: Number(r.n_done ?? 0) }, kind: r.kind, title: r.title, body: r.body ?? "", answers: JSON.parse(r.answers ?? "{}"), project: r.project == null ? null : Number(r.project),
  status: r.status, priority: r.priority ?? null, severity: r.severity ?? null, size: r.size ?? null, flow: r.flow ?? null, assignee: r.assignee ?? null, parentId: r.parent_id == null ? null : Number(r.parent_id),
  lineOrder: r.line_order == null ? null : Number(r.line_order), tags: JSON.parse(r.tags ?? "[]"), source: r.source, openedBy: r.opened_by, fingerprint: r.fingerprint ?? null,
  run: r.run == null ? null : Number(r.run), branch: r.branch ?? null, branchDir: r.branch_dir ?? null, pushedUrl: r.pushed_url ?? null,
  pr: r.pr_number != null ? { repo: r.pr_repo, number: Number(r.pr_number), url: r.pr_url, state: r.pr_state } : null, createdAt: r.created_at, updatedAt: r.updated_at, closedAt: r.closed_at ?? null, lastNote: r.last_note ?? null,
});

/** The contract appended to any agent asked about a ticket. The practice crew answers it too. */
export const TICKET_CONTRACT = "Station contract: ticket. You are reading one ticket of SoftwareFactory. Reply in at most 6 short lines: what you understand, the smallest next step, and anything missing. Then one line `SIZE: S`, `SIZE: M` or `SIZE: L` (S: one small change; M: a few files, one run; L: should be split). End with one line `STATUS: ready` if it can be built as written, or `STATUS: open` if it needs an answer first.";

/**
 * How the crew picks up tickets by itself (Systems can turn it off). Set once, it is your standing approval:
 * the crew starts what the rule allows without a press, a card or a typed phrase (Assaf, 18 Nov 2026: "when I
 * ask for work, that IS the approval").
 */
export interface AutoWork {
  on: boolean;
  /** Cap for one ready bug or task the crew starts on its own. */
  maxUsd: number;
  /**
   * Cap for one start of work you asked for (a ticket marked "asked for"): any kind and size, on the engine
   * when it is feature-sized. A plan that does not fit it is sliced (SF-64), never started doomed.
   */
  askedMaxUsd: number;
  /** All starts of a day together stay under this: the caps of today's starts added up, never more. */
  dailyUsd: number;
  /** Tickets worked at once per project. */
  wip: number;
}
/** How many open tickets the Overseer reads at the same time on its own. */
const TRIAGE_AT_ONCE = 2;
/** The part of the daily auto-work limit the Overseer's reads may use. */
const TRIAGE_SHARE = 0.25;

export const AUTO_WORK_DEFAULT: AutoWork = { on: true, maxUsd: 0.6, askedMaxUsd: 3, dailyUsd: 3, wip: 2 };
/** How often the crew starts or retries one ticket on its own before it leaves the rest to you. */
export const AUTO_TRIES = 2;

export interface QueueSpot {
  ticket: TicketView;
  /** 1 = next in line in its project. Null when the crew will not take it on its own. */
  position: number | null;
  /** Why it is not in line, in a sentence. */
  why: string | null;
}

/**
 * In a repo an epic that holds tickets is worked through them: each ticket gets its own branch and pull
 * request, and one run over the whole epic would build what its done tickets already built. Says so, or null.
 */
export const epicOfTickets = (t: Pick<TicketView, "kind" | "children">): string | null =>
  t.kind === "plan" && t.children.total > 0
    ? `This epic is worked through its tickets (${t.children.done} of ${t.children.total} done): open one and press Work it. Each gets its own branch.`
    : null;

/**
 * Tickets: open, edit one field at a time, talk, move, link, plan, and hand a
 * ticket to the crew. Every write is one event; the `tickets` projection keeps
 * the tables. Agents and the factory write back onto the ticket by themselves.
 */
/** What the reader of a re-loop is asked for: findings in a shape the core files as tickets. */
export const RELOOP_BRIEF = [
  "This is another round on the project as it stands. Read the code that matters and list the improvements most worth making now: bugs you can see, rough edges a user meets, missing tests for code that matters, risky code.",
  "Answer with 3 to 6 findings, most valuable first, each on one line exactly like this:",
  "- [S] bug: Short title: what to change and where (files)",
  "S is one small change, M a few files, L more than one session. The kind is bug or task. Only what you saw in the code, never a guess.",
].join("\n");

/** The findings of a re-loop reader, as tickets to open. At most 6. */
export function reloopFindings(text: string): { size: Size; kind: "bug" | "task"; title: string; what: string }[] {
  const out: { size: Size; kind: "bug" | "task"; title: string; what: string }[] = [];
  for (const m of String(text ?? "").matchAll(/^\s*[-*]\s*\[(S|M|L)\]\s*(?:(bug|task)\s*:\s*)?([^:\n]{3,120})(?::\s*(.+))?$/gim)) {
    const title = m[3].trim();
    if (!title) continue;
    out.push({ size: m[1].toUpperCase() as Size, kind: (m[2]?.toLowerCase() === "bug" ? "bug" : "task"), title, what: (m[4] ?? title).trim().slice(0, 2000) });
    if (out.length === 6) break;
  }
  return out;
}

/** Ticket numbers a line of text names for one key: "SF-13", "SF-16, 17, 18", "sf/SF-24-h3-guard". */
export function ticketNumbersIn(text: string, key: string): number[] {
  const out = new Set<number>();
  const re = new RegExp(`(?<![A-Za-z0-9])${key}-(\\d+)((?:\\s*(?:,|and|&)\\s*(?:${key}-)?\\d+(?![\\d.]))*)`, "gi");
  for (const m of String(text ?? "").matchAll(re)) {
    out.add(Number(m[1]));
    for (const n of m[2].matchAll(/\d+/g)) out.add(Number(n[0]));
  }
  return [...out];
}

export class Tickets {
  /** Ticket ids being asked of an agent right now (one call at a time per ticket). */
  private asking = new Set<number>();
  /** Tickets the Builder is working in a repo clone right now. */
  private inRepo = new Map<number, Promise<void>>();

  /** Tickets the dispatcher could not start, with why, until something about them changes. */
  private stuck = new Map<number, string>();
  private dispatchSoon: ReturnType<typeof setTimeout> | null = null;

  constructor(private log: EventLog, private opts: { runtime?: AgentRuntime; factory?: Factory; bay?: AgentBay; budgetUsd?: number; workRoot?: string; autoWork?: () => AutoWork; canWork?: () => string | null;
    /** GitHub write access: push a ticket's branch and open a draft PR. */
    github?: GitHub;
    /** Why the crew may not open PRs right now (the practice crew never does), or null. */
    canShip?: () => string | null;
    /** The engine in an existing codebase: feature-sized tickets of a repo project go there. */
    repoRuns?: RepoRuns;
    /** What the monthly budgets leave for work on a project (watch/spend.ts); leftUsd null: no monthly limit. */
    monthLeft?: (project: number | null) => { leftUsd: number | null; why: string | null };
  } = {}) {
    log.on("event", (e: SfEvent) => {
      try { this.react(e); } catch (err) { console.error("tickets: reacting to", e.type, "failed:", err); }
      if (e.type.startsWith("ticket.") || e.type === "factory.run.finished") {
        const pid = (e.payload as { id?: number; by?: string }).id;
        if (e.type.startsWith("ticket.") && pid != null && (e.payload as { by?: string }).by !== "dispatcher") this.stuck.delete(Number(pid));
        this.scheduleDispatch();
      }
    });
  }

  /** The auto-work rule in force: off unless the core was given one. */
  autoWork(): AutoWork { return this.opts.autoWork?.() ?? { ...AUTO_WORK_DEFAULT, on: false }; }

  private scheduleDispatch() {
    if (!this.opts.autoWork || this.dispatchSoon) return;
    // After the event that triggered it has landed everywhere, and once per burst of events.
    this.dispatchSoon = setTimeout(() => { this.dispatchSoon = null; try { this.dispatch(); } catch (err) { console.error("tickets: dispatch failed:", err); } }, 50);
    this.dispatchSoon.unref?.();
  }

  /** A ticket the crew is working right now: a factory run still going, or the Builder in its repo clone. */
  private isWorking(t: TicketView): boolean {
    return this.inRepo.has(t.id) || (t.run != null && !!this.opts.factory?.isActive(t.run));
  }

  /** What today's auto starts (by the dispatcher) may spend together: their caps added up, for the daily limit. */
  autoUsdToday(): number {
    const day = new Date().toISOString().slice(0, 10);
    const rows = this.log.db.prepare("SELECT json_extract(payload, '$.capUsd') AS cap FROM events WHERE type = 'ticket.noted' AND json_extract(payload, '$.by') = 'dispatcher' AND json_extract(payload, '$.auto') = 1 AND ts >= ?").all(day) as { cap: number | null }[];
    // Starts written before caps were recorded count at the bug-and-task cap.
    return rows.reduce((a, r) => a + (typeof r.cap === "number" ? r.cap : this.autoWork().maxUsd), 0);
  }

  /** What the Overseer's own reads of open tickets cost today. */
  private triageUsdToday(): number {
    const day = new Date().toISOString().slice(0, 10);
    const r = this.log.db.prepare("SELECT sum(json_extract(payload, '$.capUsd')) AS usd FROM events WHERE type = 'ticket.noted' AND json_extract(payload, '$.by') = 'dispatcher' AND json_extract(payload, '$.triage') = 1 AND ts >= ?").get(day) as { usd: number | null };
    return Number(r?.usd ?? 0);
  }

  /** How often the crew started or retried this ticket on its own. */
  private autoTries(id: number): number {
    return Number((this.log.db.prepare("SELECT count(*) AS n FROM events WHERE type = 'ticket.noted' AND json_extract(payload, '$.by') = 'dispatcher' AND json_extract(payload, '$.auto') = 1 AND json_extract(payload, '$.triage') IS NULL AND json_extract(payload, '$.id') = ?").get(id) as { n: number }).n);
  }

  /** Tickets you asked for (the last word on each, its own or its epic's), by id. */
  private askedIds(): Set<number> {
    const rows = this.log.db.prepare("SELECT json_extract(payload, '$.id') AS id, json_extract(payload, '$.on') AS on_ FROM events WHERE type = 'ticket.asked' ORDER BY id").all() as { id: number; on_: number }[];
    const out = new Set<number>();
    for (const r of rows) { if (r.on_) out.add(Number(r.id)); else out.delete(Number(r.id)); }
    return out;
  }

  /** Did you ask for this work? Its own mark, or the mark on the epic it sits under. */
  isAsked(t: Pick<TicketView, "id" | "parentId">, ids = this.askedIds()): boolean {
    return ids.has(t.id) || (t.parentId != null && ids.has(t.parentId));
  }

  /**
   * Mark a ticket as work you asked for (or take the mark off). The crew then starts it by itself within the
   * standing auto-work limit: no Work it press, no card, no phrase. An epic's mark covers its tickets.
   */
  setAsked(id: number, on: boolean, by = "you"): TicketView {
    const t = this.must(id);
    if (on && isClosed(t.status)) throw new Error("This ticket is closed; reopen it first.");
    const rule = this.autoWork();
    this.log.append("ticket.asked", { id, on, by });
    this.log.append("ticket.noted", { id, by, kind: "event", text: on
      ? `Asked for: the crew starts it by itself, up to $${rule.askedMaxUsd.toFixed(2)} a run and $${rule.dailyUsd.toFixed(2)} a day for all its own starts${rule.on ? "" : " (once crew pick-up is on)"}. Write "hold" on the thread to keep it off.`
      : "No longer asked for: it waits for your Work it press." });
    return this.get(id)!;
  }

  /**
   * The ready queue, per project: each ready ticket with its place in line,
   * or the sentence that says why the crew leaves it to you. Order: priority,
   * then the oldest first.
   */
  queue(project?: number | null): QueueSpot[] {
    const asked = this.askedIds();
    // Work you asked for is in line once it is open, and goes first; other work once it is ready.
    const ready = [
      ...this.list({ view: "all", status: "ready", project: project ?? undefined, limit: 500 }),
      ...(asked.size ? this.list({ view: "all", status: "open", project: project ?? undefined, limit: 500 }).filter((t) => this.isAsked(t, asked)) : []),
    ].sort((a, b) => Number(this.isAsked(b, asked)) - Number(this.isAsked(a, asked)) || pri(a.priority) - pri(b.priority) || a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
    const place = new Map<string, number>();
    const rule = this.autoWork();
    const capOf = (t: TicketView) => (this.isAsked(t, asked) ? rule.askedMaxUsd : rule.maxUsd);
    const money = new Map<string, { leftUsd: number | null; why: string | null } | undefined>();
    // The queue fits the monthly budgets: a ticket waits while its month has less left than one start may spend.
    const short = (t: TicketView): string | null => {
      const k = String(t.project);
      if (!money.has(k)) money.set(k, this.opts.monthLeft?.(t.project));
      const m = money.get(k);
      const cap = capOf(t);
      return m && m.leftUsd != null && m.leftUsd + 1e-9 < cap ? `Waits for money: ${m.why}, less than the $${cap.toFixed(2)} one start may spend.` : null;
    };
    // And today's limit: what is left of it after the caps of today's own starts.
    const dayLeft = rule.dailyUsd - this.autoUsdToday();
    const today = (t: TicketView): string | null => (dayLeft + 1e-9 < capOf(t) ? `Waits for tomorrow: today's auto-work limit of $${rule.dailyUsd.toFixed(2)} has $${Math.max(0, dayLeft).toFixed(2)} left, less than the $${capOf(t).toFixed(2)} this start may spend. Raise it in Tickets, or press Work it.` : null);
    return ready.map((t) => {
      const why = this.stuck.get(t.id) ?? (this.isAsked(t, asked) ? this.askedRefusal(t) : autoWorkRefusal(t, this.handBrake(t.id))) ?? short(t) ?? today(t);
      if (why) return { ticket: t, position: null, why };
      const k = String(t.project);
      const n = (place.get(k) ?? 0) + 1;
      place.set(k, n);
      return { ticket: t, position: n, why: null };
    });
  }

  /** Why the crew does not start this ticket you asked for, or null: only what makes a start wrong, not taste or size. */
  private askedRefusal(t: TicketView): string | null {
    if (t.blocked) return "Blocked: it starts when what blocks it is closed or its pull request is merged.";
    if (t.assignee === "you") return "You took it, so the crew leaves it to you.";
    if (this.handBrake(t.id)) return "The thread says to hold it.";
    const epic = epicOfTickets(t);
    if (epic) return "An epic you asked for: the crew starts its tickets one by one.";
    if (this.autoTries(t.id) >= AUTO_TRIES) return `The crew already started it ${AUTO_TRIES} times on its own; the next try is yours (Retry or Work it).`;
    if (t.run != null && this.opts.factory?.isActive(t.run)) return `Run #${t.run} is working it.`;
    return null;
  }

  /** You wrote "hold", "don't close", "needs a look" on the thread: the crew keeps its hands off. */
  private handBrake(id: number): boolean {
    return this.notes(id).some((n) => n.kind === "note" && n.by === "you" && HAND_BRAKE.test(n.text));
  }

  /**
   * Start what the rule allows: in each project, the next tickets in line
   * while fewer than `wip` are being worked, and only while today's starts
   * stay under the daily cap. Each start says so on its ticket.
   */
  dispatch(): number[] {
    const rule = this.autoWork();
    if (!rule.on || this.opts.canWork?.()) return [];
    const started: number[] = [];
    const busy = new Map<string, number>();
    for (const t of this.list({ view: "all", status: "in_progress", limit: 500 })) if (this.isWorking(t)) busy.set(String(t.project), (busy.get(String(t.project)) ?? 0) + 1);
    let spent = this.autoUsdToday();
    const asked = this.askedIds();
    for (const spot of this.queue()) {
      if (spot.position == null) continue;
      const k = String(spot.ticket.project);
      if ((busy.get(k) ?? 0) >= rule.wip) continue;
      const t = spot.ticket;
      const mine = this.isAsked(t, asked);
      const cap = mine ? rule.askedMaxUsd : rule.maxUsd;
      if (spent + cap > rule.dailyUsd + 1e-9) continue;
      // The check before money holds a ticket with open questions: they wait in Needs you, said once on its timeline.
      const held = this.check(t.id);
      if (held.verdict === "ask") { this.recordCheck(t.id, held, "dispatcher"); continue; }
      try {
        // SF-65: work you asked for whose run stopped or failed picks up from that step, with fresh money for what is left.
        const again = mine && t.run != null && this.opts.factory?.retryable(t.run).ok;
        if (again) {
          const add = Math.min(cap, this.opts.factory!.retryAddUsd(t.run!));
          this.log.append("ticket.noted", { id: t.id, by: "dispatcher", auto: 1, capUsd: add, kind: "event", text: `The crew tries run #${t.run} again on its own, from the step it stopped at, with $${add.toFixed(2)} more (work you asked for). Write "hold" on the thread to keep the crew off it.` });
          this.retry(t.id, { addUsd: add, by: "dispatcher", auto: true });
          spent += add;
        } else {
          this.log.append("ticket.noted", { id: t.id, by: "dispatcher", auto: 1, capUsd: cap, kind: "event", text: mine
            ? `The crew picked it up on its own: you asked for it, capped at $${cap.toFixed(2)} by your standing limit. Write "hold" on the thread to keep the crew off it.`
            : `The crew picked it up on its own: a ready ${t.kind}, size ${t.size}, capped at $${cap.toFixed(2)}. Write "hold" on the thread to keep the crew off it.` });
          this.work(t.id, { maxUsd: cap, autoApprove: true, by: "dispatcher" });
          spent += cap;
        }
        started.push(t.id);
        busy.set(k, (busy.get(k) ?? 0) + 1);
      } catch (err) {
        const why = `The crew could not start it: ${(err as Error).message}`;
        this.log.append("ticket.noted", { id: t.id, by: "dispatcher", kind: "event", text: why });
        this.stuck.set(t.id, why);
      }
    }
    this.triage(spent);
    return started;
  }

  // ---- reading -------------------------------------------------------------

  get(id: number): TicketView | undefined {
    const r = this.log.db.prepare(`${SELECT} WHERE t.id = ?`).get(id) as Row | undefined;
    return r ? toView(r) : undefined;
  }

  /** A ticket by what people say: "SF-42", "#7" or "7". */
  byKey(text: string): TicketView | undefined {
    const s = String(text ?? "").trim().toUpperCase();
    const k = s.match(/^([A-Z][A-Z0-9]{1,5})-(\d+)$/);
    if (k) {
      const r = this.log.db.prepare(`${SELECT} WHERE k.key = ? AND t.number = ?`).get(k[1], Number(k[2])) as Row | undefined;
      return r ? toView(r) : undefined;
    }
    const n = s.match(/^#?(\d+)$/);
    return n ? this.get(Number(n[1])) : undefined;
  }

  /**
   * A project's ticket key, given the first time a ticket lands there and kept
   * when the project is renamed: SoftwareFactory's own project is SF; others
   * take letters from their name.
   */
  keyFor(project: number | null): string | null {
    if (project == null) return null;
    const have = this.log.db.prepare("SELECT key FROM ticket_keys WHERE project = ?").get(project) as { key: string } | undefined;
    if (have) return have.key;
    const taken = new Set((this.log.db.prepare("SELECT key FROM ticket_keys").all() as { key: string }[]).map((r) => r.key));
    let key: string;
    if (project === selfProject(this.log) && !taken.has("SF")) key = "SF";
    else {
      const row = this.log.db.prepare("SELECT name FROM projects WHERE id = ?").get(project) as { name: string } | undefined;
      // SF stays free for SoftwareFactory's own project, even before it exists.
      key = keyFromName(row?.name ?? `P${project}`, new Set([...taken, "SF"]));
    }
    this.log.append("ticket.keyed", { project, key });
    return key;
  }

  /** Give a key to every project that has tickets but none yet (tickets opened before keys existed). */
  backfillKeys(): number {
    const rows = this.log.db.prepare("SELECT DISTINCT t.project FROM tickets t LEFT JOIN ticket_keys k ON k.project = t.project WHERE t.project IS NOT NULL AND k.key IS NULL ORDER BY t.project").all() as { project: number }[];
    for (const r of rows) this.keyFor(Number(r.project));
    return rows.length;
  }

  list(f: TicketFilter = {}): TicketView[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    const view = f.view ?? "open";
    if (f.project != null) { where.push("t.project = ?"); args.push(f.project); }
    if (view === "open") where.push("t.status NOT IN ('closed', 'rejected')");
    else if (view === "look") where.push("t.status = 'built'");
    else if (view === "you") where.push(WAITING_ON_YOU);
    else if (view === "agents") where.push("t.status NOT IN ('closed', 'rejected') AND (t.run IS NOT NULL OR (t.assignee IS NOT NULL AND t.assignee != 'you'))");
    else if (view === "plans") where.push("(t.kind = 'plan' OR t.parent_id IS NOT NULL)");
    else if (view === "closed") where.push("t.status IN ('closed', 'rejected')");
    if (f.kind) { where.push("t.kind = ?"); args.push(f.kind); }
    if (f.status) { where.push("t.status = ?"); args.push(f.status); }
    if (f.parent != null) { where.push("t.parent_id = ?"); args.push(f.parent); }
    if (f.q && f.q.trim()) {
      // Reads the title, the description, the answers, the tags and the thread; "#12" finds ticket 12, "SF-4" ticket 4 of SF.
      const q = f.q.trim();
      const n = q.match(/^#?(\d+)$/);
      const k = q.toUpperCase().match(/^([A-Z][A-Z0-9]{1,5})-(\d+)$/);
      const like = `%${q.replace(/[%_]/g, "")}%`;
      where.push(`(${n ? "t.id = ? OR " : ""}${k ? "(k.key = ? AND t.number = ?) OR " : ""}t.title LIKE ? OR t.body LIKE ? OR t.answers LIKE ? OR t.tags LIKE ? OR t.id IN (SELECT ticket_id FROM ticket_notes WHERE text LIKE ?))`);
      if (n) args.push(Number(n[1]));
      if (k) args.push(k[1], Number(k[2]));
      args.push(like, like, like, like, like);
    }
    const order = "CASE t.priority WHEN 'now' THEN 0 WHEN 'this_week' THEN 1 WHEN 'next' THEN 2 WHEN 'someday' THEN 3 ELSE 4 END, t.updated_at DESC";
    // Plans view: each epic, then its tickets in their order, then each ticket's subtasks.
    const tree = "coalesce(p.parent_id, t.parent_id, t.id), CASE WHEN t.parent_id IS NULL THEN 0 ELSE 1 END, coalesce(p.line_order, t.line_order), CASE WHEN p.parent_id IS NULL THEN 0 ELSE 1 END, t.line_order";
    const sql = `${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${view === "plans" ? tree : order} LIMIT ?`;
    args.push(f.limit ?? 200);
    return (this.log.db.prepare(sql).all(...args) as Row[]).map(toView);
  }

  /**
   * Waiting on you, across every project: each ticket with the one thing it
   * needs from you and the moves that answer it, so most take a single tap.
   */
  waiting(project?: number | null): WaitingItem[] {
    const rows = this.list({ view: "you", project: project ?? undefined, limit: 300 });
    const names = new Map((this.log.db.prepare("SELECT id, name FROM projects").all() as { id: number; name: string }[]).map((r) => [Number(r.id), r.name]));
    const why = (t: TicketView): WaitingItem["need"] =>
      t.status === "built" ? "look" : t.kind === "question" ? "answer" : "decide";
    const rank = { look: 0, answer: 1, decide: 2 } as const;
    return rows
      .map((t) => {
        const need = why(t);
        const moves: WaitingItem["moves"] = need === "look" ? nextMoves(t.status, t.kind)
          : need === "decide" ? [{ to: "ready", label: "Yes, build it" }, { to: "rejected", label: "No" }]
          : [];
        return { ticket: t, projectName: t.project != null ? names.get(t.project) ?? null : null, need, moves,
          say: need === "look" ? "Built: take a look" : need === "answer" ? (t.answers.ask && t.answers.ask !== t.title ? t.answers.ask : "Needs your answer") : `${t.kind === "idea" ? "An idea" : "A request"} from ${t.openedBy}: build it?` };
      })
      .sort((a, b) => rank[a.need] - rank[b.need] || b.ticket.updatedAt.localeCompare(a.ticket.updatedAt));
  }

  /** Counts for the chips and the summary line: by status, by kind, waiting for your look. */
  counts(project?: number | null) {
    const scope = project != null ? "WHERE project = ?" : "";
    const args = project != null ? [project] : [];
    const byStatus = Object.fromEntries((this.log.db.prepare(`SELECT status, count(*) AS n FROM tickets ${scope} GROUP BY status`).all(...args) as { status: string; n: number }[]).map((r) => [r.status, Number(r.n)]));
    const byKind = Object.fromEntries((this.log.db.prepare(`SELECT kind, count(*) AS n FROM tickets ${scope ? `${scope} AND` : "WHERE"} status NOT IN ('closed', 'rejected') GROUP BY kind`).all(...args) as { kind: string; n: number }[]).map((r) => [r.kind, Number(r.n)]));
    const open = STATUSES.filter((s) => !isClosed(s)).reduce((n, s) => n + (byStatus[s] ?? 0), 0);
    const oldest = this.log.db.prepare(`SELECT id, title, created_at FROM tickets ${scope ? `${scope} AND` : "WHERE"} status NOT IN ('closed', 'rejected') ORDER BY created_at LIMIT 1`).get(...args) as Row | undefined;
    const you = Number((this.log.db.prepare(`SELECT count(*) AS n FROM tickets t WHERE ${WAITING_ON_YOU}${project != null ? " AND t.project = ?" : ""}`).get(...args) as { n: number }).n);
    return { byStatus, byKind, open, look: byStatus.built ?? 0, you, total: Object.values(byStatus).reduce((a, b) => a + b, 0), oldest: oldest ? { id: Number(oldest.id), title: oldest.title, createdAt: oldest.created_at } : null };
  }

  notes(id: number): NoteView[] {
    return (this.log.db.prepare("SELECT * FROM ticket_notes WHERE ticket_id = ? ORDER BY event_id").all(id) as Row[]).map((r) => ({
      eventId: Number(r.event_id), ts: r.ts, by: r.by_name, kind: r.kind, text: r.text, status: r.status ?? null, costUsd: r.cost_usd ?? null,
    }));
  }

  /**
   * The ticket's one timeline, oldest first and append-only: its thread (what people said, status moves,
   * branch, push and PR) and what the crew did for it (each step of its runs, agent calls, decisions at the
   * gates, retries, the run starting and ending), merged in the order it happened.
   */
  timeline(id: number): TimelineEntry[] {
    const rows = this.log.db.prepare(`SELECT event_id, ts, by_name, cat, text, cost_usd, status, NULL AS run FROM ticket_notes WHERE ticket_id = ?
      UNION ALL SELECT event_id, ts, by_name, cat, text, cost_usd, NULL AS status, run FROM ticket_trace WHERE ticket_id = ? ORDER BY event_id`).all(id, id) as Row[];
    return rows.map((r) => ({ eventId: Number(r.event_id), ts: r.ts, by: r.by_name, cat: r.cat as TimelineCat, text: r.text, costUsd: r.cost_usd ?? null, status: r.status ?? null, run: r.run == null ? null : Number(r.run) }));
  }

  /** Links seen from this ticket, both ways (a link made on one side shows on the other). */
  links(id: number): LinkView[] {
    const rows = this.log.db.prepare(`SELECT l.from_id, l.to_id, l.relation, t.title, t.status, t.number, k.key FROM ticket_links l JOIN tickets t ON t.id = CASE WHEN l.from_id = ? THEN l.to_id ELSE l.from_id END
      LEFT JOIN ticket_keys k ON k.project = t.project WHERE l.from_id = ? OR l.to_id = ? ORDER BY l.ts`).all(id, id, id) as Row[];
    return rows.map((r) => {
      const out = Number(r.from_id) === id;
      const rel = r.relation as Relation;
      // Seen from the other side, "duplicate of" and "blocks" read backwards.
      const back: Partial<Record<Relation, string>> = { duplicate_of: "duplicated_by", blocks: "blocked_by", derived_from: "spawned" };
      return { from: id, to: out ? Number(r.to_id) : Number(r.from_id), relation: (out ? rel : (back[rel] ?? rel)) as Relation, title: r.title, status: r.status,
        key: keyText(r.key ?? null, r.number == null ? null : Number(r.number), out ? Number(r.to_id) : Number(r.from_id)) };
    });
  }

  lines(planId: number): TicketView[] {
    return (this.log.db.prepare(`${SELECT} WHERE t.parent_id = ? ORDER BY t.line_order`).all(planId) as Row[]).map(toView);
  }

  detail(id: number): TicketDetail | undefined {
    const t = this.get(id);
    if (!t) return undefined;
    const notes = this.notes(id), links = this.links(id), lines = this.lines(id), files = this.files(id);
    let run: TicketDetail["run"] = null;
    if (t.run != null) {
      const r = this.log.db.prepare("SELECT outcome, total_usd FROM factory_runs WHERE id = ?").get(t.run) as Row | undefined;
      const st = this.log.db.prepare("SELECT payload FROM events WHERE type = 'factory.station' AND json_extract(payload, '$.run') = ? ORDER BY id DESC LIMIT 1").get(t.run) as { payload: string } | undefined;
      const sp = st ? JSON.parse(st.payload) : null;
      run = { id: t.run, outcome: r?.outcome ?? null, station: sp?.station ?? null, state: sp?.state ?? null, spentUsd: r?.total_usd ?? sp?.spentUsd ?? null };
    }
    const repo = repoOfProject(this.log, t.project);
    return {
      ticket: t, notes, timeline: this.timeline(id), links, lines, parent: t.parentId != null ? this.get(t.parentId) ?? null : null,
      moves: nextMoves(t.status, t.kind), run,
      // The files go in the work document by where they lie, so an agent that works the ticket can open them.
      document: files.length ? `${workDocument(t, notes, links, lines)}\n\n## Files on this ticket\n\n${files.map((f) => `- ${f.name} (${f.mime}, ${f.size} bytes): ${f.path}`).join("\n")}` : workDocument(t, notes, links, lines),
      repo, route: repo && this.opts.repoRuns && !epicOfTickets(t) ? this.routeOf(t, {}) : null, working: this.inRepo.has(id), steps: this.steps(id),
      flow: this.flowOf(t, !!repo),
      queue: t.status === "ready" || (t.status === "open" && this.isAsked(t)) ? this.spot(t) : null,
      asked: this.isAsked(t),
      retry: this.retryInfo(t),
      files,
    };
  }

  /** The harness steps of the ticket's latest pass in its repo, in order, each with where it stands. */
  steps(id: number): TicketStep[] {
    const rows = this.log.db.prepare("SELECT ts, payload FROM events WHERE type = 'ticket.step' AND json_extract(payload, '$.id') = ? ORDER BY id").all(id) as { ts: string; payload: string }[];
    let out: TicketStep[] = [];
    let first: string | null = null;
    for (const r of rows) {
      const p = JSON.parse(r.payload) as { step: string; state: TicketStep["state"]; note?: string };
      first ??= p.step;
      // The first step running again is a new pass: show that one.
      if (p.step === first && p.state === "running") out = [];
      const at = out.find((x) => x.step === p.step);
      if (at) Object.assign(at, { state: p.state, note: p.note ?? "", at: r.ts });
      else out.push({ step: p.step, state: p.state, note: p.note ?? "", at: r.ts });
    }
    return out;
  }

  private spot(t: TicketView): { position: number | null; why: string | null } {
    const q = this.queue(t.project).find((x) => x.ticket.id === t.id);
    return q ? { position: q.position, why: q.why } : { position: null, why: null };
  }

  /** Where a ticket's files live: next to the work folder, one folder per ticket. Null without a work folder. */
  private filesDir(id: number): string | null {
    return this.opts.workRoot ? join(this.opts.workRoot, "..", "ticket-files", String(id)) : null;
  }

  /** The files on a ticket, from the log (a file whose bytes were removed by hand is left out). */
  files(id: number): TicketFile[] {
    const dir = this.filesDir(id);
    if (!dir) return [];
    const rows = this.log.db.prepare("SELECT ts, payload FROM events WHERE type = 'ticket.file' AND json_extract(payload, '$.id') = ? ORDER BY id").all(id) as { ts: string; payload: string }[];
    const out: TicketFile[] = [];
    for (const r of rows) {
      const p = JSON.parse(r.payload);
      const path = join(dir, String(p.file));
      if (p.removed) { const i = out.findIndex((f) => f.file === p.file); if (i >= 0) out.splice(i, 1); continue; }
      if (!existsSync(path)) continue;
      out.push({ file: String(p.file), name: String(p.name), size: Number(p.size), mime: String(p.mime), by: String(p.by), at: r.ts, path, image: String(p.mime).startsWith("image/") });
    }
    return out;
  }

  /**
   * Put a file on a ticket (gap 4): a screenshot, a log, a report. The bytes go to the ticket's folder on this PC,
   * never into the log; the thread says it was added, and the work document lists it so an agent can read it.
   */
  attach(id: number, name: string, bytes: Buffer, o: { mime?: string; by?: string } = {}): TicketFile {
    const t = this.must(id);
    const dir = this.filesDir(id);
    if (!dir) throw new Error("This core has no folder for ticket files.");
    if (!bytes.length) throw new Error("The file is empty.");
    if (bytes.length > TICKET_FILE_MAX) throw new Error(`The file is ${(bytes.length / 1048576).toFixed(1)} MB; a ticket takes files up to 15 MB.`);
    const clean = String(name ?? "").split(/[\\/]/).pop()!.replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").trim().slice(0, 100) || "file";
    const n = this.log.db.prepare("SELECT count(*) AS n FROM events WHERE type = 'ticket.file' AND json_extract(payload, '$.id') = ?").get(id) as { n: number };
    const file = `${Number(n.n) + 1}-${clean}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), bytes);
    const by = o.by ?? "you";
    const mime = fileMime(clean, o.mime);
    this.log.append("ticket.file", { id, file, name: clean, size: bytes.length, mime, by });
    this.log.append("ticket.noted", { id, by, kind: "event", text: `Added the file ${clean} (${bytes.length < 1024 ? `${bytes.length} bytes` : bytes.length < 1048576 ? `${Math.round(bytes.length / 1024)} KB` : `${(bytes.length / 1048576).toFixed(1)} MB`}).` });
    void t;
    return this.files(id).find((f) => f.file === file)!;
  }

  /** Take a file off a ticket. The bytes stay in the folder; the ticket no longer shows it. */
  detach(id: number, file: string, by = "you"): TicketFile[] {
    const f = this.files(id).find((x) => x.file === file);
    if (!f) throw new Error(`There is no file ${file} on this ticket.`);
    this.log.append("ticket.file", { id, file, removed: true, by });
    this.log.append("ticket.noted", { id, by, kind: "event", text: `Took the file ${f.name} off.` });
    return this.files(id);
  }

  /**
   * One change to many tickets at once (gap 6, list parity): a status move, the asked mark, a size, a priority,
   * a parent or an assignee. Each ticket moves by the same rules as alone; one that refuses says why and the
   * rest still move.
   */
  bulk(ids: number[], action: string, value: unknown, by = "you"): { done: number[]; failed: { id: number; key: string | null; error: string }[] } {
    const done: number[] = [], failed: { id: number; key: string | null; error: string }[] = [];
    const uniq = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 500);
    if (!uniq.length) throw new Error("Pick at least one ticket.");
    if (!["status", "asked", "size", "priority", "parent", "assignee"].includes(action)) throw new Error(`"${action}" cannot be done to many tickets at once.`);
    for (const id of uniq) {
      try {
        if (action === "status") this.say(id, "", { status: String(value) as TicketStatus, by });
        else if (action === "asked") this.setAsked(id, value !== false && value !== "off", by);
        else this.edit(id, action, value === "" ? null : value, by);
        done.push(id);
      } catch (e) { failed.push({ id, key: this.get(id)?.key ?? null, error: (e as Error).message }); }
    }
    return { done, failed };
  }

  /** Tickets as Markdown (a list to paste anywhere) or JSON (each ticket's detail without its long work document). */
  exportTickets(ids: number[], format: "md" | "json" = "md"): string {
    const rows = [...new Set(ids.map(Number))].map((id) => this.detail(id)).filter((d): d is TicketDetail => !!d);
    if (format === "json") return JSON.stringify(rows.map(({ document: _d, timeline: _t, ...d }) => d), null, 2);
    return rows.map(({ ticket: t, notes, links }) => [
      `## ${t.key} ${t.title}`,
      `${t.kind}, ${t.status}${t.size ? `, size ${t.size}` : ""}${t.priority ? `, ${t.priority.replace("_", " ")}` : ""}${t.pr ? `, PR #${t.pr.number} (${t.pr.state}) ${t.pr.url}` : ""}`,
      ...(t.body ? ["", t.body] : []),
      ...(links.length ? ["", ...links.map((l) => `- ${l.relation.replace("_", " ")} ${l.key ?? `#${l.to}`} ${l.title ?? ""}`.trimEnd())] : []),
      ...(notes.filter((n) => n.text).length ? ["", "Thread:", ...notes.filter((n) => n.text).slice(-10).map((n) => `- ${n.ts.slice(0, 16).replace("T", " ")} ${n.by}${n.status ? ` (${n.status})` : ""}: ${n.text.split("\n")[0].slice(0, 300)}`)] : []),
    ].join("\n")).join("\n\n");
  }

  document(id: number): string {
    const d = this.detail(id);
    if (!d) throw new Error(`No ticket #${id}`);
    return d.document;
  }

  // ---- writing -------------------------------------------------------------

  open(o: OpenTicket): TicketView {
    const kind: TicketKind = o.kind && KINDS.includes(o.kind) ? o.kind : "task";
    const answers = Object.fromEntries(Object.entries(o.answers ?? {}).filter(([k, v]) => FORMS[kind].some((q) => q.key === k) && String(v ?? "").trim()).map(([k, v]) => [k, String(v).trim().slice(0, 4000)]));
    const body = String(o.body ?? "").trim().slice(0, 20_000);
    // The kind's required question can be answered by the description: nothing is lost for want of a field.
    const req = FORMS[kind].find((q) => q.required);
    if (req && !answers[req.key] && body) answers[req.key] = body.split(/\n\s*\n/)[0].slice(0, 2000);
    const title = titleFrom(String(o.title ?? "").trim() || answers[req?.key ?? ""] || body);
    if (!title) throw new Error("A ticket needs a title or a few words about it.");
    if (req && !answers[req.key]) answers[req.key] = title;
    const by = String(o.by ?? "you");
    if (o.fingerprint) {
      const same = this.log.db.prepare("SELECT id, status FROM tickets WHERE fingerprint = ?").get(o.fingerprint) as { id: number; status: TicketStatus } | undefined;
      if (same) {
        this.log.append("ticket.noted", { id: Number(same.id), kind: "event", text: `Seen again${by !== "you" ? ` by ${by}` : ""}: ${title}`, by });
        return this.get(Number(same.id))!;
      }
    }
    const parent = o.parent != null ? this.get(o.parent) : undefined;
    if (o.parent != null && !parent) throw new Error(`No ticket #${o.parent} to sit under.`);
    const project = o.project ?? parent?.project ?? null;
    if (parent) {
      const why = refuseParent({ kind, project }, { id: parent.id, kind: parent.kind, parentId: parent.parentId, project: parent.project, parentKind: parent.parentId != null ? this.get(parent.parentId)?.kind ?? null : null });
      if (why) throw new Error(why);
    }
    const id = Number((this.log.db.prepare("SELECT coalesce(max(id), 0) + 1 AS n FROM tickets").get() as { n: number }).n);
    this.keyFor(project);
    this.log.append("ticket.opened", {
      id, number: this.nextNumber(project), kind, title, body, answers, project, by, source: o.source ?? (by === "you" ? "you" : "agent"),
      priority: o.priority && PRIORITIES.includes(o.priority) ? o.priority : null,
      severity: kind === "bug" && o.severity && TICKET_SEVERITIES.includes(o.severity) ? o.severity : null,
      assignee: o.assignee ?? null, parent: o.parent ?? null, tags: (o.tags ?? []).map(String).filter(Boolean).slice(0, 12), fingerprint: o.fingerprint ?? null,
      ...(o.request != null ? { request: o.request } : {}), ...(o.ref !== undefined ? { ref: o.ref } : {}),
    });
    this.linkProject(id, project);
    for (const l of o.links ?? []) this.link(id, l.to, l.relation, by);
    if (o.asked) this.log.append("ticket.asked", { id, on: true, by });
    return this.get(id)!;
  }

  /**
   * SF-65: the ticket's run stopped or failed: try it again from the step it stopped at, with fresh money for
   * what is left (Factory.retry), on the same branch, keeping what was built. Not a new run from the start.
   */
  retry(id: number, o: { addUsd?: number; by?: string; auto?: boolean } = {}): { ticket: TicketView; run: number; from: string; addUsd: number } {
    const t = this.must(id);
    const factory = this.opts.factory;
    if (!factory || t.run == null) throw new Error("This ticket has no run to try again; press Work it.");
    if (isClosed(t.status)) throw new Error("This ticket is closed; reopen it first.");
    const r = factory.retry(t.run, { addUsd: o.addUsd, by: o.by ?? "you", auto: o.auto });
    this.log.append("ticket.noted", { id, by: o.by ?? "you", status: t.status === "in_progress" ? undefined : "in_progress", kind: "event",
      text: `Run #${r.run} tried again from ${r.from}, with $${r.addUsd.toFixed(2)} more (up to $${r.maxUsd.toFixed(2)} in all). What it built stays.` });
    return { ticket: this.get(id)!, run: r.run, from: r.from, addUsd: r.addUsd };
  }

  /** Whether the ticket's run can be tried again from where it stopped, and with how much. */
  retryInfo(t: TicketView): { from: string; addUsd: number } | null {
    const f = this.opts.factory;
    if (!f || t.run == null) return null;
    const ok = f.retryable(t.run);
    return ok.ok ? { from: ok.from!, addUsd: f.retryAddUsd(t.run) } : null;
  }

  /** The next ticket number inside a project. */
  private nextNumber(project: number | null): number {
    return Number((this.log.db.prepare("SELECT coalesce(max(number), 0) + 1 AS n FROM tickets WHERE project IS ?").get(project) as { n: number }).n);
  }

  /** Change one field; nothing else is touched. */
  edit(id: number, field: string, value: unknown, by = "you", key?: string): TicketView {
    const t = this.must(id);
    if (field === "answer") {
      if (!key || !(FORMS[t.kind].some((q) => q.key === key) || /^check\.[a-z-]{2,40}$/.test(key))) throw new Error(`${aKind(t.kind).replace(/^a/, "A")} has no question "${key}"`);
      this.log.append("ticket.edited", { id, field, key, value: String(value ?? "").slice(0, 4000), by });
      return this.get(id)!;
    }
    if (field === "status") throw new Error("Move a ticket with a status move, so the thread says why.");
    if (!(field in EDITABLE)) throw new Error(`"${field}" cannot be edited`);
    if (field === "kind" && !KINDS.includes(value as TicketKind)) throw new Error(`Unknown kind "${value}"`);
    if (field === "priority" && value != null && value !== "" && !PRIORITIES.includes(value as Priority)) throw new Error(`Unknown priority "${value}"`);
    if (field === "severity" && value != null && value !== "" && !TICKET_SEVERITIES.includes(value as TicketSeverity)) throw new Error(`Unknown severity "${value}"`);
    if (field === "size" && value != null && value !== "" && !SIZES.includes(value as Size)) throw new Error(`Size is S, M or L, not "${value}"`);
    if (field === "parent" && value != null && value !== "") {
      const p = this.get(Number(value));
      if (!p) throw new Error(`No ticket #${value} to sit under.`);
      const why = refuseParent({ id, kind: t.kind, project: t.project, hasChildren: t.children.total > 0 },
        { id: p.id, kind: p.kind, parentId: p.parentId, project: p.project, parentKind: p.parentId != null ? this.get(p.parentId)?.kind ?? null : null });
      if (why) throw new Error(why);
    }
    if (field === "kind" && value === "plan" && t.parentId != null) throw new Error("An epic sits at the top: take it out of its parent first.");
    if (field === "kind" && t.kind === "plan" && value !== "plan" && t.children.total > 0) throw new Error("This epic still holds tickets; move them out first.");
    if (field === "title" && !String(value ?? "").trim()) throw new Error("A ticket needs a title.");
    if (field === "flow" && value != null && value !== "") {
      const f = this.flows.get(String(value));
      if (!f) throw new Error(`There is no flow "${value}".`);
      if (runnerOf(f) === "door") throw new Error(`"${f.name}" is carried out by its own screen (${f.door}), not on a ticket.`);
    }
    const v = field === "tags" ? (Array.isArray(value) ? value.map(String).filter(Boolean) : String(value ?? "").split(",").map((s) => s.trim()).filter(Boolean))
      : field === "project" || field === "parent" ? (value == null || value === "" ? null : Number(value))
      : field === "flow" ? (value == null || value === "" ? null : String(value)) : value;
    if (field === "project") {
      const to = v as number | null;
      if (to === t.project) return t;
      if (t.parentId != null || t.children.total > 0) throw new Error("Move the whole epic, not one of its parts: a ticket and its parent stay in one project.");
      this.keyFor(to);
      this.log.append("ticket.edited", { id, field, value: to, number: this.nextNumber(to), was: t.key, by });
      this.log.append("ticket.noted", { id, by, kind: "event", text: `Was ${t.key}; now ${this.get(id)!.key}` });
      this.linkProject(id, to);
      return this.get(id)!;
    }
    this.log.append("ticket.edited", { id, field, value: v, by });
    // Converting keeps the answers that still fit; the rest stay in the record, unseen.
    return this.get(id)!;
  }

  /** Say something on the thread, and optionally move the status in the same step. */
  say(id: number, text: string, opts: { status?: TicketStatus; by?: string; kind?: "note" | "reply" | "event"; costUsd?: number } = {}): TicketView {
    const t = this.must(id);
    const by = opts.by ?? "you";
    const said = String(text ?? "").trim().slice(0, 8000);
    if (opts.status) {
      if (!STATUSES.includes(opts.status)) throw new Error(`Unknown status "${opts.status}"`);
      const why = refuseMove(t.kind, t.status, opts.status, by);
      if (why) throw new Error(why);
      this.log.append("ticket.noted", { id, by, status: opts.status, text: said || `Moved to ${opts.status.replace("_", " ")}`, kind: opts.kind ?? "note", costUsd: opts.costUsd });
    } else {
      if (!said) throw new Error("Nothing to say.");
      this.log.append("ticket.noted", { id, by, text: said, kind: opts.kind ?? "note", costUsd: opts.costUsd });
    }
    return this.get(id)!;
  }

  link(id: number, to: number, relation: Relation, by = "you", removed = false): TicketView {
    this.must(id); this.must(to);
    if (id === to) throw new Error("A ticket cannot link to itself.");
    if (!RELATIONS.includes(relation)) throw new Error(`Unknown link "${relation}"`);
    this.log.append("ticket.linked", { id, to, relation, by, removed });
    // A duplicate closes with the link that says so.
    const t = this.get(id)!;
    if (!removed && relation === "duplicate_of" && !isClosed(t.status)) this.log.append("ticket.noted", { id, by, status: "closed", text: `Closed as a duplicate of #${to}` });
    return this.get(id)!;
  }

  moveLine(id: number, dir: "up" | "down"): TicketView[] {
    const t = this.must(id);
    if (t.parentId == null) throw new Error("This ticket is not a line of a plan.");
    this.log.append("ticket.line.moved", { id, dir, by: "you" });
    return this.lines(t.parentId);
  }

  /** A new ticket from this one, linked "derived from". */
  spawn(id: number, o: OpenTicket): TicketView {
    const t = this.must(id);
    return this.open({ project: t.project, ...o, links: [...(o.links ?? []), { relation: "derived_from", to: id }] });
  }

  // ---- the crew ------------------------------------------------------------

  /**
   * "Work it": the ticket goes into the factory loop. The run starts from the
   * work document, the ticket moves to in progress, and the run writes back
   * onto the ticket when it ends (see react()).
   */
  work(id: number, o: { maxUsd?: number; autoApprove?: boolean; where?: "auto" | "repo" | "new"; by?: string; again?: boolean; /** In a repo project: one session ("light") or the whole engine. Not given, the ticket's flow, kind and size decide. */ route?: WorkRoute; /** Run the check before money first, and refuse (with its questions) when it asks. */ check?: boolean } = {}): { ticket: TicketView; run: number | null; branch?: string; route?: Routed; flow?: { id: string; name: string } } {
    const t = this.must(id);
    if (isClosed(t.status)) throw new Error("This ticket is closed; reopen it first.");
    // A monthly budget that is used up holds every paid start, yours too (watch/spend.ts). A start never gets more than is left.
    const month = this.opts.monthLeft?.(t.project);
    if (month && month.leftUsd != null) {
      if (month.leftUsd < 0.05) throw new Error(`No money left this month: ${month.why}. Raise the monthly budget on the project's Money tab, or wait for the new month.`);
      // Not given, the start takes its route's own cap (at most DEFAULT_NEXT_USD): only less, when less is left.
      const want = o.maxUsd ?? (month.leftUsd < DEFAULT_NEXT_USD ? month.leftUsd : undefined);
      if (want != null && want > month.leftUsd - 1e-9) o = { ...o, maxUsd: Number(month.leftUsd.toFixed(2)) };
    }
    if (o.check) {
      const c = this.check(id);
      this.recordCheck(id, c, o.by ?? "you");
      if (c.verdict === "ask") throw Object.assign(new Error(`Before it costs money, ${c.questions.length === 1 ? "one question needs" : `${c.questions.length} questions need`} your answer: ${c.questions.map((q) => q.ask).join(" ")}`), { check: c });
    }
    const repo = o.where === "new" ? null : repoOfProject(this.log, t.project);
    if (o.where === "repo" && !repo) throw new Error("This ticket's project has no imported repo to work in.");
    // The flow it follows (tickets/flowpick.ts): the one you picked, else its kind's.
    const first = pickFlow(this.flows, t, { repo: !!repo, routeChosen: !!o.route });
    const named = (f: FlowDef) => ({ id: f.id, name: f.name });
    // A proposed flow change you chose to try once is what this ticket follows (flows/improver.ts).
    const tried = (f: FlowDef) => this.flows.trial?.(f.id, t.id) ?? f;
    if (routeOfFlow(first.flow) === "answer" && !o.route) { const f = tried(first.flow); return { ...this.workAnswer(t, repo, o, f), flow: named(f) }; }
    if (repo) {
      const held = epicOfTickets(t);
      if (held) throw new Error(held);
      // Intake: a bug, a task or a small ask is one session in the clone; a feature gets the whole engine there.
      // A flow you picked decides the route; a route you pressed decides it over the ticket's kind.
      const routed: Routed = first.chosen && !o.route ? { route: routeOfFlow(first.flow) === "engine" ? "engine" : "light", why: first.why, chosen: true } : this.routeOf(t, o);
      const pick = first.chosen && !o.route ? first : pickFlow(this.flows, { kind: t.kind }, { repo: true, route: routed.route, routeChosen: true });
      if (routed.route === "engine") {
        const started = this.workEngine(t, o, routed, pick.flow.id);
        if (started) return { ...started, flow: named(pick.flow) };
      }
      const session = tried(runnerOf(pick.flow) === "session" ? pick.flow : pickFlow(this.flows, { kind: t.kind }, { repo: true, route: "light", routeChosen: true }).flow);
      return { ...this.workRepo(t, repo, o.maxUsd, session), route: routed.route === "light" ? routed : { route: "light", why: "the engine could not take it (see the ticket's thread)" }, flow: named(session) };
    }
    if (first.chosen && runnerOf(first.flow) !== "engine") throw new Error(`"${first.flow.name}" works in a repo, and this ticket's project has none. Pick New project, or import the repo first.`);
    const factory = this.opts.factory;
    if (!factory) throw new Error("The factory is not running in this core.");
    if (t.run != null && factory.isActive(t.run)) throw new Error(`Run #${t.run} is already working this ticket.`);
    const idea = ideaFromTicket(t, this.document(id));
    // The factory's duplicate check (one idea, one build a day): reworking this ticket's own shipped run is fine, anything else needs "again".
    const d = o.again ? null : factory.duplicateOf(idea);
    if (d && (d.run !== t.run || d.state === "stopped")) {
      const what = d.state === "running" ? "is already building it" : d.state === "stopped" ? "already started it and can resume" : "already built it today";
      throw Object.assign(new Error(`Run #${d.run} ${what}. Open that run, or work it again anyway.`), { duplicate: { duplicateOf: d.run, state: d.state, projectId: d.projectId } });
    }
    const run = factory.start(idea, { maxUsd: o.maxUsd, autoApprove: o.autoApprove, ...(t.project != null ? { projectId: t.project } : {}), ...(first.chosen ? { flow: first.flow.id } : {}) });
    this.log.append("ticket.run", { id, run, by: o.by ?? "you" });
    if (t.status !== "in_progress") this.log.append("ticket.noted", { id, by: "factory", status: "in_progress", text: `The crew took it: factory run #${run}` });
    return { ticket: this.get(id)!, run, flow: named(first.flow) };
  }

  /**
   * The branch goes to GitHub as a draft PR, when the crew may ship: the real
   * crew, a token that can write, and never main. The ticket waits for your
   * look; CI runs on the PR, and its merge moves the ticket on (followPrs).
   * Returns false when it stays a local branch, after saying why.
   */
  private async openPr(id: number, repo: RepoRef, r: { dir: string; branch: string; base: string; files: string[]; summary: string; costUsd: number; checks?: string[] }): Promise<boolean> {
    const gh = this.opts.github;
    const t = this.get(id)!;
    const why = !gh ? "GitHub access is not set up in this core." : this.opts.canShip?.() ?? (gh.hasToken() ? null : "No GitHub access yet: add a token in Systems, GitHub access, and the crew opens a PR next time.");
    if (why) { this.log.append("ticket.noted", { id, by: "factory", kind: "event", text: `The branch stays on this computer: ${why}` }); return false; }
    let baseBranch = "main";
    try { baseBranch = gh!.git(r.dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").replace(/^origin\//, ""); } catch { /* main */ }
    const pr = await gh!.openPr({
      repo: repo.github!, dir: r.dir, branch: r.branch, base: baseBranch, title: `${t.key}: ${t.title}`.slice(0, 200),
      body: [`Ticket **${t.key}** (${t.kind}) from SoftwareFactory, worked by the crew.`, "", r.summary || "", "", `Changed ${r.files.length} file(s).`, "", r.checks?.length ? `Checks passed: ${r.checks.join(", ")}.` : "", "", "_Opened as a draft by SoftwareFactory's crew. It never pushes to main; merging is a person's call or the auto-merge rule._"].join("\n").slice(0, 6000),
    });
    this.log.append("ticket.pr", { id, by: "factory", repo: `${repo.github!.owner}/${repo.github!.name}`, number: pr.number, url: pr.url, branch: r.branch, state: "open" });
    const now = this.get(id)!;
    this.log.append("ticket.noted", {
      id, by: "factory", kind: "reply", costUsd: r.costUsd, status: now.status !== "built" && !isClosed(now.status) ? "built" : undefined,
      text: `${r.summary || "Done."}\n\nOpened draft PR #${pr.number}: ${pr.url}. Windows CI runs on it; when it merges, this ticket moves on by itself.`,
    });
    return true;
  }

  /**
   * Your press on a built ticket whose branch stayed on this computer: send that
   * branch to GitHub. With a token it becomes a draft PR like the crew's own.
   * Without one, this PC's own Git sign-in pushes it and the ticket carries the
   * address that starts the pull request. Only the ticket's branch, never main.
   */
  async send(id: number, by = "you"): Promise<TicketView> {
    const t = this.must(id);
    const gh = this.opts.github;
    const repo = repoOfProject(this.log, t.project);
    if (!repo) throw new Error("This ticket's project has no repo to send a branch to.");
    if (t.pr) throw new Error(`This ticket already has pull request #${t.pr.number}.`);
    if (!t.branch || !t.branchDir) throw new Error("There is no branch yet: press Work it first.");
    if (this.inRepo.has(id)) throw new Error("The Builder is still working this ticket.");
    if (this.sending.has(id)) throw new Error("This branch is already on its way to GitHub.");
    if (!existsSync(join(t.branchDir, ".git"))) throw new Error("The folder with this branch is gone. Press Work it to build it again.");
    if (!repo.github) {
      // A folder on this computer: the branch is added to it and nothing else moves (not its files, not its current branch).
      if (!existsSync(join(repo.source, ".git"))) throw new Error(`The original folder (${repo.source}) is not on this computer any more.`);
      try { git(repo.source, "fetch", "-q", t.branchDir, `${t.branch}:${t.branch}`); }
      catch (e) { throw new Error(/checked out|non-fast-forward|rejected/i.test((e as Error).message) ? `Your folder already has a branch ${t.branch} that differs or is open in it. Switch away from it there, then press again.` : `Could not add the branch to your folder: ${(e as Error).message.slice(0, 300)}`); }
      this.log.append("ticket.pushed", { id, by, repo: repo.source, branch: t.branch, url: null });
      this.log.append("ticket.noted", { id, by: "factory", kind: "event", text: `Branch ${t.branch} is now in ${repo.source}. Your files there did not change; merge the branch when you want it.` });
      return this.get(id)!;
    }
    if (!gh) throw new Error("GitHub access is not set up in this core.");
    const why = this.opts.canShip?.();
    if (why) throw new Error(`Not sent: ${why}.`);
    this.sending.add(id);
    try {
      let base = "main";
      try { base = gh.git(t.branchDir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").replace(/^origin\//, ""); } catch { /* main */ }
      if (gh.hasToken()) {
        let files: string[] = [];
        try { files = gh.git(t.branchDir, "diff", "--name-only", `origin/${base}...${t.branch}`).split("\n").filter(Boolean); } catch { /* unknown */ }
        gh.git(t.branchDir, "checkout", "-q", t.branch);
        await this.openPr(id, repo, { dir: t.branchDir, branch: t.branch, base, files, summary: "", costUsd: 0 });
      } else {
        await gh.pushBranch({ repo: repo.github, dir: t.branchDir, branch: t.branch, base });
        const url = gh.compareUrl(repo.github, base, t.branch);
        this.log.append("ticket.pushed", { id, by, repo: `${repo.github.owner}/${repo.github.name}`, branch: t.branch, base, url });
        this.log.append("ticket.noted", { id, by: "factory", kind: "event", text: `The branch is on GitHub. Open the pull request there (${url}), name it ${t.key}, and its merge moves this ticket on by itself.` });
      }
    } finally { this.sending.delete(id); }
    return this.get(id)!;
  }
  private sending = new Set<number>();

  /** Follow every open PR of a ticket: merged moves it on, closed without a merge sends it back. */
  async followPrs(): Promise<number> {
    const gh = this.opts.github;
    if (!gh?.hasToken()) return 0;
    const rows = this.log.db.prepare("SELECT id, pr_repo, pr_number FROM tickets WHERE pr_state = 'open' AND pr_number IS NOT NULL").all() as Row[];
    let moved = 0;
    for (const row of rows) {
      const [owner, name] = String(row.pr_repo).split("/");
      try {
        const pr = await gh.pr({ owner, name }, Number(row.pr_number));
        if (pr.state === "open") continue;
        const id = Number(row.id);
        this.log.append("ticket.pr", { id, by: "github", repo: row.pr_repo, number: pr.number, url: pr.url, state: pr.merged ? "merged" : "closed", sha: pr.mergeSha });
        const t = this.get(id)!;
        moved++;
        if (isClosed(t.status)) continue;
        if (pr.merged) {
          // Merged after CI: work kinds are done; taste kinds wait for your look on the next version.
          const done = !TASTE_KINDS.includes(t.kind);
          this.log.append("ticket.noted", { id, by: "github", status: done ? "closed" : t.status === "built" ? undefined : "built", text: `PR #${pr.number} was merged.${done ? " Closed: it ships with the next version." : " It ships with the next version; take a look then."}` });
        } else {
          this.log.append("ticket.noted", { id, by: "github", status: "open", text: `PR #${pr.number} was closed without merging, so this ticket is open again.` });
        }
      } catch (e) { console.error("tickets: following PR", row.pr_number, "failed:", hideTokens((e as Error).message)); }
    }
    return moved;
  }

  /**
   * Work merged outside the ticket's own PR still moves its ticket: a merged pull
   * request whose title or branch names a ticket ("SF-13", "SF-16, 17, 18",
   * "sf/SF-24-...") is linked to it, and the ticket moves on as if the crew's PR
   * had merged. Each PR counts once per ticket, so a ticket you reopen stays open.
   */
  async followMerges(): Promise<number> {
    const gh = this.opts.github;
    if (!gh) return 0;
    const has = (t: string) => !!this.log.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    if (!has("project_links")) return 0;
    const projects = this.log.db.prepare("SELECT k.project, k.key, l.ref FROM ticket_keys k JOIN project_links l ON l.project_id = k.project AND l.kind = 'github' GROUP BY k.project").all() as { project: number; key: string; ref: string }[];
    const seen = this.log.db.prepare("SELECT 1 FROM events WHERE type = 'ticket.pr' AND json_extract(payload, '$.id') = ? AND json_extract(payload, '$.number') = ? AND json_extract(payload, '$.state') = 'merged' LIMIT 1");
    let moved = 0;
    for (const p of projects) {
      const repo = parseGitHubRepo(p.ref);
      if (!repo) continue;
      let prs: MergedPr[];
      try { prs = await gh.mergedPrs(repo); } catch (e) { console.error("tickets: reading merged PRs of", p.ref, "failed:", hideTokens((e as Error).message)); continue; }
      // Oldest first, so a ticket named by several PRs ends on the newest.
      for (const pr of prs.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt))) {
        for (const number of ticketNumbersIn(`${pr.title}\n${pr.branch}`, p.key)) {
          const t = this.byKey(`${p.key}-${number}`);
          if (!t || seen.get(t.id, pr.number)) continue;
          // A ticket opened after the merge only mentions old work; it is not done by it.
          if (t.createdAt > pr.mergedAt) continue;
          this.log.append("ticket.pr", { id: t.id, by: "github", repo: `${repo.owner}/${repo.name}`, number: pr.number, url: pr.url, state: "merged", sha: pr.mergeSha });
          moved++;
          if (isClosed(t.status)) continue;
          const done = !TASTE_KINDS.includes(t.kind);
          this.log.append("ticket.noted", { id: t.id, by: "github", status: done ? "closed" : t.status === "built" ? undefined : "built", text: `PR #${pr.number} "${pr.title.slice(0, 120)}" names this ticket and was merged.${done ? " Closed: it is in the app." : " It is in the app; take a look and close it."}` });
        }
      }
    }
    return moved;
  }

  /**
   * Link a ticket to a pull request that was opened outside SoftwareFactory (a thread's PR, your own).
   * From then on it is followed like the crew's own: already merged moves the ticket now, open waits for the merge.
   */
  async linkPr(id: number, ref: string | number, by = "you"): Promise<TicketView> {
    const t = this.must(id);
    const gh = this.opts.github;
    const repo = repoOfProject(this.log, t.project)?.github;
    if (!gh || !repo) throw new Error("This ticket's project has no GitHub repo, so there is no pull request to link.");
    const m = String(ref ?? "").trim().match(/(?:^#?|\/pull\/)(\d+)\/?$/);
    if (!m) throw new Error("Give the pull request's number (84) or its GitHub address.");
    const pr = await gh.pr(repo, Number(m[1]));
    const state = pr.merged ? "merged" : pr.state;
    this.log.append("ticket.pr", { id, by, repo: `${repo.owner}/${repo.name}`, number: pr.number, url: pr.url, state, sha: pr.mergeSha });
    if (pr.merged && !isClosed(t.status)) {
      const done = !TASTE_KINDS.includes(t.kind);
      this.log.append("ticket.noted", { id, by: "github", status: done ? "closed" : t.status === "built" ? undefined : "built", text: `PR #${pr.number} "${pr.title.slice(0, 120)}" was linked and is already merged.${done ? " Closed: it is in the app." : " It is in the app; take a look and close it."}` });
    }
    return this.get(id)!;
  }

  /** Wait for a ticket's repo work to finish (tests, the CLI). */
  waitRepo(id: number): Promise<void> { return this.inRepo.get(id) ?? Promise.resolve(); }

  /** Which way this ticket goes in its repo: what was chosen, else its kind, size and words (factory/route.ts). */
  private routeOf(t: TicketView, o: { route?: WorkRoute; maxUsd?: number }): Routed {
    if (!this.opts.repoRuns || !this.opts.factory) return { route: "light", why: "this core has no engine for repos" };
    // The fullest telling of the ask (the body often repeats the title and the first answer; counting them twice would make every ask look large).
    const text = [t.title, t.body, Object.values(t.answers ?? {}).join("\n")].sort((a, b) => b.length - a.length)[0];
    return routeWork({ kind: t.kind, size: t.size, text, asked: o.route ?? null, maxUsd: o.maxUsd, engineMinUsd: REPO_ENGINE_MIN_USD });
  }

  // ---- the check before money (tickets/precheck.ts) -------------------------

  /** Read the ticket for clarity, confidence and decisions only you make. Free and instant. */
  check(id: number): TicketCheck {
    const t = this.must(id);
    return checkTicket(t, { runner: this.flowOf(t)?.runner });
  }

  /** Put the check on the ticket's timeline, unless it says the same as the last one. */
  private recordCheck(id: number, c: TicketCheck, by: string): void {
    const last = this.log.db.prepare("SELECT payload FROM events WHERE type = 'ticket.checked' AND json_extract(payload, '$.id') = ? ORDER BY id DESC LIMIT 1").get(id) as { payload: string } | undefined;
    const sig = (x: { verdict: string; questions: { id: string }[] }) => `${x.verdict}:${x.questions.map((q) => q.id).join(",")}`;
    if (last && sig(JSON.parse(last.payload)) === sig(c) && c.verdict === "ask") return;
    this.log.append("ticket.checked", { id, by, verdict: c.verdict, answered: c.answered, questions: c.questions });
  }

  /**
   * Every ticket the check would hold, across projects (or one): the questions to answer in one sitting
   * before any of them costs money. Only tickets that could be worked now (open or ready, not being worked).
   */
  checks(project?: number | null): { ticket: TicketView; projectName: string | null; flow: { id: string; name: string } | null; check: TicketCheck }[] {
    const names = new Map((this.log.db.prepare("SELECT id, name FROM projects").all() as { id: number; name: string }[]).map((r) => [Number(r.id), r.name]));
    const out: { ticket: TicketView; projectName: string | null; flow: { id: string; name: string } | null; check: TicketCheck }[] = [];
    for (const status of ["ready", "open"] as const) {
      for (const t of this.list({ view: "all", status, project: project ?? undefined, limit: 300 })) {
        if (t.kind === "plan" || this.isWorking(t) || this.inRepo.has(t.id)) continue;
        const f = this.flowOf(t);
        const c = checkTicket(t, { runner: f?.runner });
        if (c.verdict === "ask") out.push({ ticket: t, projectName: t.project != null ? names.get(t.project) ?? null : null, flow: f ? { id: f.id, name: f.name } : null, check: c });
      }
    }
    return out;
  }

  /**
   * Your answers to the check, in one batch: each goes on its ticket (its record and its thread). With
   * `run`, every ticket that is then clear starts, through the same Work it as your press.
   */
  answerChecks(answers: { id: number; q: string; text: string }[], o: { run?: boolean; by?: string } = {}): { answered: number; started: { id: number; run: number | null; flow?: string }[]; held: { id: number; error: string }[] } {
    const by = o.by ?? "you";
    const touched = new Set<number>();
    let answered = 0;
    for (const a of answers) {
      const text = String(a.text ?? "").trim();
      if (!text) continue;
      const t = this.must(Number(a.id));
      const q = checkTicket(t, { runner: this.flowOf(t)?.runner }).questions.find((x) => x.id === a.q);
      this.edit(t.id, "answer", text, by, `check.${a.q}`);
      this.log.append("ticket.noted", { id: t.id, by, kind: "note", text: `${q ? `${q.ask}\n` : ""}${text}` });
      touched.add(t.id);
      answered++;
    }
    const started: { id: number; run: number | null; flow?: string }[] = [];
    const held: { id: number; error: string }[] = [];
    if (o.run) for (const id of touched) {
      try { const r = this.work(id, { by, check: true }); started.push({ id, run: r.run, flow: r.flow?.name }); }
      catch (e) { held.push({ id, error: (e as Error).message }); }
    }
    return { answered, started, held };
  }

  // ---- the home board (SF behavior brief 4.1) ---------------------------------

  /**
   * Every ticket across projects in four lanes: Needs you (first), Running, In review, Done. Each card says
   * the flow it follows and, while it runs, the step it is on, so the board can draw the live flow beside it.
   */
  board(o: { project?: number | null; doneDays?: number } = {}): { lanes: Record<BoardLane, BoardCard[]>; counts: Record<BoardLane, number> } {
    const names = new Map((this.log.db.prepare("SELECT id, name FROM projects").all() as { id: number; name: string }[]).map((r) => [Number(r.id), r.name]));
    const lanes: Record<BoardLane, BoardCard[]> = { needs: [], running: [], review: [], done: [] };
    const placed = new Set<number>();
    const card = (t: TicketView, extra: Partial<BoardCard> = {}): BoardCard => {
      const f = this.flowOf(t);
      return { id: t.id, key: t.key, title: t.title, kind: t.kind, status: t.status, project: t.project, projectName: t.project != null ? names.get(t.project) ?? null : null,
        flow: f ? { id: f.id, name: f.name, runner: f.runner } : null, run: t.run, pr: t.pr ? { number: t.pr.number, url: t.pr.url, state: t.pr.state } : null, updatedAt: t.updatedAt, ...extra };
    };
    const put = (lane: BoardLane, c: BoardCard) => { if (placed.has(c.id)) return; placed.add(c.id); lanes[lane].push(c); };
    const station = this.log.db.prepare("SELECT payload FROM events WHERE type = 'factory.station' AND json_extract(payload, '$.run') = ? ORDER BY id DESC LIMIT 1");
    const lastStep = this.log.db.prepare("SELECT payload FROM events WHERE type = 'ticket.step' AND json_extract(payload, '$.id') = ? ORDER BY id DESC LIMIT 1");
    const scope = o.project ?? undefined;
    // Running first, so a run waiting at your OK moves to Needs you with the step it waits on.
    for (const t of this.list({ view: "all", status: "in_progress", project: scope, limit: 300 })) {
      if (t.run != null) {
        const sp = station.get(t.run) as { payload: string } | undefined;
        const st = sp ? JSON.parse(sp.payload) as { station?: string; state?: string } : null;
        const live = this.isWorking(t);
        if (st?.state === "waiting") { put("needs", card(t, { need: "gate", say: `Waiting for your OK at ${st.station === "gateA" ? "the plan" : st.station === "gateB" ? "the build" : st.station}`, step: st.station ?? null, live: true })); continue; }
        put("running", card(t, { step: st?.station ?? null, live }));
      } else {
        const sp = lastStep.get(t.id) as { payload: string } | undefined;
        const name = sp ? String(JSON.parse(sp.payload).step) : null;
        put("running", card(t, { step: name ? stepOfSession(name) : null, stepName: name, live: this.inRepo.has(t.id) }));
      }
    }
    for (const c of this.checks(scope)) put("needs", card(c.ticket, { need: "check", say: c.check.questions[0]?.ask ?? "Questions before it costs money", questions: c.check.questions.length }));
    for (const w of this.waiting(scope)) {
      if (w.ticket.status === "built" && w.ticket.pr?.state === "open") continue; // its PR is in review
      put("needs", card(w.ticket, { need: w.need, say: w.say }));
    }
    // A crew PR whose CI passed waits for a merge: on Needs you with SF's merge review (docs/git.md). The rest are in review.
    const hasChecks = !!this.log.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'merge_checks'").get();
    const mergeRow = hasChecks ? this.log.db.prepare("SELECT number, ci, confident, score, reasons, merged_by FROM merge_checks WHERE ticket_id = ?") : null;
    for (const t of this.list({ view: "all", project: scope, limit: 500 })) {
      if (t.pr?.state !== "open" || isClosed(t.status)) continue;
      const m = mergeRow?.get(t.id) as { number: number; ci: string; confident: number; score: number; reasons: string; merged_by: string | null } | undefined;
      if (m && m.number === t.pr.number && m.ci === "green" && !m.merged_by && t.source !== "outside") {
        const miss = (JSON.parse(m.reasons) as { ok: boolean; text: string }[]).filter((r) => !r.ok);
        put("needs", card(t, { need: "merge", say: m.confident ? `PR #${t.pr.number} is ready to merge: every check of SF's review passed` : `PR #${t.pr.number} passed CI. ${miss[0]?.text ?? ""}`.trim(), merge: { confident: !!m.confident, score: m.score, number: m.number } }));
      } else put("review", card(t, { say: m?.ci === "red" ? `PR #${t.pr.number}: CI failed` : t.source === "outside" ? `PR #${t.pr.number}, made outside SF` : `Draft PR #${t.pr.number}: checks run, its merge moves it on` }));
    }
    const since = new Date(Date.now() - (o.doneDays ?? 14) * 86_400_000).toISOString();
    for (const t of this.list({ view: "closed", project: scope, limit: 200 })) if (t.status === "closed" && (t.closedAt ?? t.updatedAt) >= since) put("done", card(t));
    lanes.done.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    lanes.done.splice(40);
    return { lanes, counts: { needs: lanes.needs.length, running: lanes.running.length, review: lanes.review.length, done: lanes.done.length } };
  }

  /** The flow library (the factory's when it has one, so both read the same saved flows). */
  get flows(): FlowLibrary { return (this.flowLib ??= this.opts.factory?.flows ?? new FlowLibrary(this.log)); }
  private flowLib?: FlowLibrary;

  /** The flow this ticket follows if it is worked now, and why. */
  flowOf(t: TicketView, repo = !!repoOfProject(this.log, t.project)): { id: string; name: string; runner: string; why: string; chosen: boolean } | null {
    try {
      let p: FlowPick = pickFlow(this.flows, t, { repo });
      if (repo && !p.chosen && routeOfFlow(p.flow) !== "answer") p = pickFlow(this.flows, t, { repo, route: this.routeOf(t, {}).route });
      return { id: p.flow.id, name: p.flow.name, runner: runnerOf(p.flow), why: p.why, chosen: p.chosen };
    } catch { return null; }
  }

  /**
   * The Research or question flow: a reader answers on the ticket and changes nothing (tickets/research.ts).
   * Cents: capped at the ticket's limit, $0.30 when none was given.
   */
  private workAnswer(t: TicketView, repo: RepoRef | null, o: { maxUsd?: number; by?: string }, flow: FlowDef): { ticket: TicketView; run: null } {
    const { runtime, bay, workRoot } = this.opts;
    if (!runtime || !workRoot) throw new Error("No crew or work folder in this core.");
    if (this.inRepo.has(t.id)) throw new Error("A reader is already working this ticket.");
    const by = bay?.crewFor("survey")[0]?.id ?? "surveyor";
    this.log.append("ticket.noted", { id: t.id, by, status: t.status === "in_progress" ? undefined : "in_progress", text: `${flow.name}: reading ${repo ? `a copy of ${repo.source}` : "the ticket and its project"} to answer it. Nothing is changed.` });
    const gh = this.opts.github;
    if (repo?.github && gh && !existsSync(join(repo.dir, ".git"))) repo = { ...repo, dir: gh.remote(repo.github) };
    const job = answerTicket(this.log, runtime, bay, { id: t.id, key: t.key, title: t.title, document: this.document(t.id), repo, workRoot, maxUsd: Math.min(o.maxUsd ?? 0.3, 0.6), projectId: t.project, flow, git: gh ? (d, ...a) => gh.git(d, ...a) : undefined })
      .then((r) => {
        if (!r.ok) { this.log.append("ticket.noted", { id: t.id, by, status: "open", costUsd: r.costUsd, text: `The reader could not answer it: ${r.error}` }); return; }
        const now = this.get(t.id)!;
        this.log.append("ticket.noted", { id: t.id, by, kind: "reply", costUsd: r.costUsd, status: isClosed(now.status) || now.status === "built" ? undefined : "built", text: r.text });
      })
      .catch((e) => { this.log.append("ticket.noted", { id: t.id, by, status: "open", text: `Answering it failed: ${(e as Error).message}` }); })
      .finally(() => this.inRepo.delete(t.id));
    this.inRepo.set(t.id, job);
    return { ticket: this.get(t.id)!, run: null };
  }

  /**
   * An ask said in a project that lives in a repo (its page's idea box, the Assistant's "Build it"): it becomes
   * a request ticket there, and the ticket takes its route. So every piece of work in a repo has a thread, a
   * branch and a pull request to follow, whichever door it came through. Null when the project has no repo.
   */
  askInRepo(project: number, text: string, o: { maxUsd?: number; route?: WorkRoute; autoApprove?: boolean; by?: string } = {}): { ticket: TicketView; run: number | null; branch?: string; route?: Routed; door?: string } | null {
    const repo = repoOfProject(this.log, project);
    const asked = (o.by ?? "you") === "you";
    // The doors before the route (factory/route.ts intakeDoor): a question is answered, "another round" is a review
    // that files tickets. A route you chose means work. A question needs no repo; the other doors do.
    const door = o.route ? { door: "work" as const, why: "you chose a route" } : intakeDoor(text);
    if (door.door === "question" && this.opts.runtime && this.opts.workRoot) {
      const t = this.open({ kind: "question", body: text, project, by: o.by ?? "you", source: "project", asked });
      this.workAnswer(t, repo, { by: o.by }, RESEARCH_FLOW);
      return { ticket: this.get(t.id)!, run: null, route: { route: "light", why: door.why }, door: "question" };
    }
    if (!repo) return null;
    if (door.door === "reloop" && this.opts.runtime && this.opts.workRoot) {
      const name = (this.log.db.prepare("SELECT name FROM projects WHERE id = ?").get(project) as { name: string } | undefined)?.name ?? "";
      const t = this.open({ kind: "plan", title: `Another round${name ? ` on ${name}` : ""}: ${titleFrom(text)}`.slice(0, 200), body: text, project, by: o.by ?? "you", source: "project", asked });
      this.workReloop(t, repo, { by: o.by });
      return { ticket: this.get(t.id)!, run: null, route: { route: "light", why: door.why }, door: "reloop" };
    }
    const t = this.open({ kind: "request", body: text, project, by: o.by ?? "you", source: "project", asked });
    return { ...this.work(t.id, { maxUsd: o.maxUsd, route: o.route, autoApprove: o.autoApprove, where: "repo", by: o.by }), door: "work" };
  }

  /**
   * The re-loop door: another round on a project as it stands. A reader goes through a read-only copy (the
   * answer runner, cents, nothing changed) and lists the improvements worth making now; each becomes a small
   * ticket under this round's epic, ready for the crew. Work you asked for starts by itself within your limit;
   * the epic moves on by itself when its tickets are done.
   */
  private workReloop(t: TicketView, repo: RepoRef, o: { by?: string } = {}) {
    const { runtime, bay, workRoot } = this.opts;
    if (!runtime || !workRoot) throw new Error("No crew or work folder in this core.");
    const by = bay?.crewFor("survey")[0]?.id ?? "surveyor";
    this.log.append("ticket.noted", { id: t.id, by, status: "in_progress", text: `Another round: reading a copy of ${repo.source} to find what is worth improving now. Nothing is changed; what it finds becomes tickets here.` });
    const gh = this.opts.github;
    if (repo.github && gh && !existsSync(join(repo.dir, ".git"))) repo = { ...repo, dir: gh.remote(repo.github) };
    const document = [this.document(t.id), RELOOP_BRIEF].join("\n\n");
    const job = answerTicket(this.log, runtime, bay, { id: t.id, key: t.key, title: t.title, document, repo, workRoot, maxUsd: 0.4, projectId: t.project, git: gh ? (d, ...a) => gh.git(d, ...a) : undefined })
      .then((r) => {
        if (!r.ok) { this.log.append("ticket.noted", { id: t.id, by, status: "open", costUsd: r.costUsd, text: `The round could not read the project: ${r.error}` }); return; }
        const found = reloopFindings(r.text);
        const made: string[] = [];
        for (const f of found) {
          try {
            const c = this.open({ kind: f.kind, title: f.title, body: f.what, project: t.project, parent: t.id, by, source: "reloop", fingerprint: `reloop:${t.id}:${f.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}` });
            this.edit(c.id, "size", f.size, by);
            this.say(c.id, "Found in another round on the project: ready for the crew.", { status: "ready", by, kind: "event" });
            made.push(c.key);
          } catch { /* one finding that cannot be filed does not stop the others */ }
        }
        this.log.append("ticket.noted", { id: t.id, by, kind: "reply", costUsd: r.costUsd, ...(made.length ? {} : { status: "built" }),
          text: made.length ? `${r.text}\n\nFiled as ${made.join(", ")}: the crew works them like any ticket, and this round moves on when they are done.` : `${r.text}\n\nNothing worth another round right now.` });
      })
      .catch((e) => { this.log.append("ticket.noted", { id: t.id, by, status: "open", text: `The round failed: ${(e as Error).message}` }); })
      .finally(() => this.inRepo.delete(t.id));
    this.inRepo.set(t.id, job);
  }

  /**
   * The engine route: the whole engine runs in a clone of the ticket's repo (design, a plan you approve, a
   * build feature by feature, a review, a judge on the running site), on a branch of its own. Returns null,
   * after saying why on the thread, when the engine cannot take it and nobody chose it: the light route does.
   */
  private workEngine(t: TicketView, o: { maxUsd?: number; autoApprove?: boolean; by?: string }, routed: Routed, flow?: string): { ticket: TicketView; run: number; branch: string; route: Routed } | null {
    const { factory, repoRuns } = this.opts;
    const no = (why: string): null => {
      if (routed.chosen) throw new Error(why);
      this.log.append("ticket.noted", { id: t.id, by: "factory", kind: "event", text: `Not on the engine (${why}), so one Builder session takes it in the repo.` });
      return null;
    };
    if (!factory || !repoRuns || t.project == null) return no("this core has no engine for repos");
    if (t.run != null && factory.isActive(t.run)) throw new Error(`Run #${t.run} is already working this ticket.`);
    if (this.inRepo.has(t.id)) throw new Error("The Builder is already working this ticket in the repo.");
    const allow = buildAllowance(this.log, t.project, "next", o.maxUsd);
    if ("error" in allow) return no(allow.error);
    const maxUsd = allow.maxUsd ?? DEFAULT_NEXT_USD;
    if (maxUsd < REPO_ENGINE_MIN_USD) return no(`an engine run needs at least $${REPO_ENGINE_MIN_USD.toFixed(2)} and this one may spend $${maxUsd.toFixed(2)}`);
    const { run, branch } = repoRuns.start(t.project, ideaFromTicket(t, this.document(t.id)), { maxUsd, autoApprove: o.autoApprove, ticket: { id: t.id, key: t.key, title: t.title }, ...(flow && flow !== "repo-change" ? { flow } : {}) });
    this.log.append("ticket.run", { id: t.id, run, by: o.by ?? "you" });
    this.log.append("ticket.noted", {
      id: t.id, by: "factory", status: t.status === "in_progress" ? undefined : "in_progress",
      text: `The crew took it on the engine (${routed.why}): run #${run} designs the change, plans it for your approval, builds it on branch ${branch} of a clone, reviews it and judges it on the running site. Up to $${maxUsd.toFixed(2)}.${allow.note ? ` ${allow.note}` : ""}`,
    });
    return { ticket: this.get(t.id)!, run, branch, route: routed };
  }

  /**
   * The ticket's project is an imported repo: the Builder works it on a new
   * branch of a clone (never main, never the original, never pushed) and the
   * ticket says where the branch is. It stays built for your look.
   */
  private workRepo(t: TicketView, repo: RepoRef, maxUsd?: number, flow?: FlowDef): { ticket: TicketView; run: null; branch: string } {
    const { runtime, bay, workRoot } = this.opts;
    if (!runtime || !workRoot) throw new Error("No crew or work folder in this core.");
    if (this.inRepo.has(t.id)) throw new Error("The Builder is already working this ticket in the repo.");
    const doc = this.document(t.id);
    const branch = branchFor(t.key, t.title);
    const by = bay?.crewFor("build")[0]?.id ?? "builder";
    this.log.append("ticket.noted", { id: t.id, by, status: t.status === "in_progress" ? undefined : "in_progress", text: `Working it in a clone of ${repo.source}, on branch ${branch}. ${repo.github ? "Only that branch is ever pushed, never main." : "The original repo is not touched and nothing is pushed."}` });
    const gh = this.opts.github;
    // A GitHub repo with no copy on this computer is cloned from where this core's GitHub access points
    // (github.com; a local stand-in in tests). One imported from GitHub is cloned from its copy here.
    if (repo.github && gh && !existsSync(join(repo.dir, ".git"))) repo = { ...repo, dir: gh.remote(repo.github) };
    const job = workInRepo(this.log, runtime, bay, { id: t.id, key: t.key, title: t.title, document: doc, repo, workRoot, maxUsd: Math.min(maxUsd ?? 0.6, 1.5), git: gh ? (d, ...a) => gh.git(d, ...a) : undefined, projectId: t.project, checks: harnessChecks({ maxMinutes: this.opts.factory?.maxRunMinutes }), flow })
      .then(async (r) => {
        if (!r.ok) {
          this.log.append("ticket.noted", { id: t.id, by, status: "open", text: `The Builder could not work it: ${r.error}` });
          return;
        }
        this.log.append("ticket.branch", { id: t.id, by, source: repo.source, dir: r.dir, branch: r.branch, base: r.base, sha: r.sha, files: r.files.slice(0, 200), costUsd: r.costUsd });
        const now = this.get(t.id)!;
        if (isClosed(now.status)) return;
        if (r.sha && repo.github && r.handover !== false) {
          const shipped = await this.openPr(t.id, repo, r).catch((e) => { this.log.append("ticket.noted", { id: t.id, by, kind: "event", text: hideTokens(`Could not open a PR: ${(e as Error).message}`) }); return false; });
          if (shipped) return;
        }
        const take = repo.github ? "It is on this computer only. Press Send to GitHub on this ticket when you want it there." : "Your own folder is untouched. Press Add to my folder on this ticket to get the branch there.";
        this.log.append("ticket.noted", {
          id: t.id, by, kind: "reply", costUsd: r.costUsd, status: r.sha && now.status !== "built" ? "built" : r.sha ? undefined : "open",
          text: r.sha ? `${r.summary || "Done."}\n\nChanged ${r.files.length} file(s) on ${r.branch} (from ${r.base}). ${take}` : `${r.summary || "No change was made."}\n\nNothing changed on ${r.branch}.`,
        });
      })
      .catch((e) => { this.log.append("ticket.noted", { id: t.id, by, status: "open", text: `Working it in the repo failed: ${(e as Error).message}` }); })
      .finally(() => this.inRepo.delete(t.id));
    this.inRepo.set(t.id, job);
    return { ticket: this.get(t.id)!, run: null, branch };
  }

  /**
   * Open bugs and tasks that nobody has read stay "open" forever, and the crew only takes "ready" work, so a pile of
   * them left the crew idle (19 Nov 2026: all 27 SoftwareFactory tickets open, the vulnerable-packages bug marked now
   * and blocking among them). The dispatcher has the Overseer read each one once, most urgent first: one short call
   * that sizes it and moves it to ready when it is clear, after which the queue takes it like any other. Each read
   * counts against today's auto-work limit; a ticket you took, one that is blocked or held, and taste kinds are left
   * alone. Returns the tickets sent for reading.
   */
  triage(spentToday = this.autoUsdToday()): number[] {
    const rule = this.autoWork();
    if (!rule.on || !this.opts.runtime || this.opts.canWork?.()) return [];
    const cap = Math.min(this.opts.budgetUsd ?? 0.1, 0.1);
    // Reading may use at most a quarter of the day, so it never eats the money the crew's starts need (19 Nov:
    // twenty reads counted at their $0.10 cap took the whole $3 and left five ready tickets for tomorrow).
    const share = rule.dailyUsd * TRIAGE_SHARE;
    const readToday = this.triageUsdToday();
    const read = new Set((this.log.db.prepare("SELECT json_extract(payload, '$.id') AS id FROM events WHERE type = 'ticket.noted' AND json_extract(payload, '$.by') = 'dispatcher' AND json_extract(payload, '$.triage') = 1").all() as { id: number }[]).map((r) => Number(r.id)));
    const rank = (p: Priority | null) => (p ? PRIORITIES.indexOf(p) : PRIORITIES.length);
    const open = this.list({ view: "all", status: "open", limit: 500 })
      .filter((t) => t.project != null && AUTO_KINDS.includes(t.kind) && !read.has(t.id) && !this.asking.has(t.id) && t.assignee !== "you" && !t.blocked && !this.handBrake(t.id))
      .sort((a, b) => rank(a.priority) - rank(b.priority) || a.id - b.id);
    const sent: number[] = [];
    let spent = spentToday;
    let reading = readToday + this.asking.size * cap;
    for (const t of open) {
      if (this.asking.size >= TRIAGE_AT_ONCE || spent + cap > rule.dailyUsd + 1e-9 || reading + cap > share + 1e-9) break;
      // Noted at no cost; what the read really cost is counted when it ends (a read is cents, its cap is $0.10).
      this.log.append("ticket.noted", { id: t.id, by: "dispatcher", auto: 1, triage: 1, capUsd: 0, kind: "event", text: `The Overseer reads it on its own to size it and say whether it is ready for the crew (up to $${cap.toFixed(2)}, from today's auto-work limit). Write "hold" on the thread to keep the crew off it.` });
      spent += cap;
      reading += cap;
      sent.push(t.id);
      this.ask(t.id)
        .then((r) => this.log.append("ticket.noted", { id: t.id, by: "dispatcher", auto: 1, triage: 1, capUsd: Number((r.costUsd ?? 0).toFixed(4)), kind: "event", text: `Read by the Overseer for $${(r.costUsd ?? 0).toFixed(2)}.` }))
        .catch((e) => this.log.append("ticket.noted", { id: t.id, by: "dispatcher", kind: "event", text: `Reading it failed: ${(e as Error).message}` }));
    }
    return sent;
  }

  /**
   * Ask an agent: the assignee (or the Overseer) reads the work document and
   * replies on the thread. One short call, capped; it may move an open ticket to ready.
   */
  async ask(id: number, agentId?: string): Promise<{ ticket: TicketView; reply?: string; error?: string; costUsd?: number }> {
    const { runtime, bay } = this.opts;
    if (!runtime) throw new Error("No crew in this core.");
    const t = this.must(id);
    if (this.asking.has(id)) throw new Error("An agent is already reading this ticket.");
    const want = agentId ?? (t.assignee && t.assignee !== "you" ? t.assignee : "overseer");
    const a = bay?.get(want) ?? bay?.get("overseer");
    const name = a?.def.name ?? want;
    const cap = Math.min(this.opts.budgetUsd ?? 0.1, a?.def.budgetUsd ?? 0.1);
    this.asking.add(id);
    try {
      const run = await runAgent(this.log, runtime, a?.def.id ?? want, {
        prompt: this.document(id),
        model: a?.def.model ?? "haiku",
        systemPrompt: `${a?.def.prompt ?? "You are a careful engineer."}\n\n${TICKET_CONTRACT}`,
        budgetUsd: cap,
        ...(a ? kitArgs(kitOf(a.def)) : {}),
      }, { agentVersion: a?.version, station: "ticket", ticket: id });
      if (run.error || !run.result) {
        this.say(id, `${name} could not answer: ${run.error ?? "no reply"}`, { by: a?.def.id ?? want, kind: "event" });
        return { ticket: this.get(id)!, error: run.error ?? "no reply" };
      }
      const text = run.result.text.trim();
      const ready = /STATUS:\s*ready/i.test(text);
      const now = this.get(id)!;
      const size = text.match(/^\s*SIZE:\s*([SML])\b/im)?.[1]?.toUpperCase() as Size | undefined;
      if (size && now.size == null) this.edit(id, "size", size, a?.def.id ?? want);
      const reply = text.replace(/\n?STATUS:\s*\w+\s*$/i, "").replace(/^\s*SIZE:\s*[SML]\b.*$/im, "").trim() || text;
      if (ready && now.status === "open") this.say(id, reply, { by: a?.def.id ?? want, kind: "reply", status: "ready", costUsd: run.result.costUsd });
      else this.say(id, reply, { by: a?.def.id ?? want, kind: "reply", costUsd: run.result.costUsd });
      return { ticket: this.get(id)!, reply, costUsd: run.result.costUsd };
    } finally {
      this.asking.delete(id);
    }
  }

  // ---- agents and rules write back -----------------------------------------

  /**
   * When the last ticket of an epic is done, the epic is built and waits for
   * your look (an epic is taste: it never closes by itself). A reopened ticket
   * says so on its epic.
   */
  private rollUp(id: number) {
    const t = this.get(id);
    if (!t || t.parentId == null) return;
    const epic = this.get(t.parentId);
    if (!epic || epic.kind !== "plan") return;
    const { total, done } = epic.children;
    if (total > 0 && done === total && ["open", "ready", "in_progress"].includes(epic.status)) {
      this.log.append("ticket.noted", { id: epic.id, by: "factory", status: "built", text: `All ${total} ticket${total === 1 ? "" : "s"} of this epic are done. Take a look.` });
    } else if (!isClosed(t.status) && t.status !== "built" && epic.status === "built") {
      this.log.append("ticket.noted", { id: epic.id, by: "factory", kind: "event", text: `${t.key} was reopened, so this epic is not all done any more.` });
    }
  }

  /** Keep tickets in step with the rest of the factory. Runs synchronously for every event. */
  private react(e: SfEvent) {
    const p = e.payload as Record<string, any>;
    if (e.type === "ticket.noted" && p.status) this.rollUp(Number(p.id));
    if (e.type === "factory.run.finished") {
      const run = Number(p.run);
      const t = this.byRun(run);
      if (t) return this.runEnded(t, run, p);
      // A run that failed on its own (not from a ticket) becomes a bug, so it is not forgotten.
      if (p.outcome === "failed") {
        const started = this.log.get(run)?.payload as { idea?: string } | undefined;
        this.open({
          kind: "bug", title: `Factory run #${run} failed: ${String(started?.idea ?? "").split("\n")[0].slice(0, 60)}`, by: "factory", source: "factory", fingerprint: `run-failed:${run}`,
          answers: { expected: "The run ships a tested repo." }, body: `The run stopped with: ${p.reason ?? "no reason given"}.`,
          project: this.projectOfRun(run),
        });
      }
    } else if (e.type === "factory.plan.sliced") {
      this.sliced(Number(p.run), p);
    } else if (e.type === "factory.features.left") {
      this.sliced(Number(p.run), { ...p, later: p.left, kept: p.built }, "left");
    } else if (e.type === "factory.gate" && p.state === "waiting" && !p.auto) {
      const t = this.byRun(Number(p.run));
      if (t) this.log.append("ticket.noted", { id: t.id, by: "factory", kind: "event", text: `Run #${p.run} waits for you at the ${String(p.gate).replace("gateA", "plan gate").replace("gateB", "build gate")}: ${p.question ?? ""}`.trim() });
    } else if (e.type === "order.fragment") {
      // The Order Engine files what you say; a task or a question it files becomes a ticket under its project.
      const kind = p.kind === "task" ? "task" : p.kind === "question" ? "question" : null;
      if (!kind || p.nodeId == null || !String(p.text ?? "").trim()) return;
      // A factory run's own idea is already a run (and maybe a ticket); only what you said becomes a ticket.
      const src = this.log.db.prepare("SELECT json_extract(payload, '$.source') AS s FROM events WHERE id = ?").get(Number(p.signalId)) as { s: string | null } | undefined;
      if (src?.s === "factory") return;
      const fid = Number(p.id ?? e.id);
      this.open({
        kind, title: String(p.text), by: "archivist", source: "order", fingerprint: `fragment:${fid}`,
        answers: kind === "task" ? { todo: String(p.text) } : { ask: String(p.text) }, project: this.rootOf(Number(p.nodeId)),
      });
    } else if (e.type === "ticket.requested") {
      // Any module asks for a ticket without owning ticket numbers: an import's suggestion, a tool, a script.
      this.open({
        kind: p.kind, title: p.title, body: p.body, answers: p.answers, project: p.project ?? null, priority: p.priority, severity: p.severity,
        by: p.by ?? String(p.source ?? "agent"), source: String(p.source ?? "agent"), fingerprint: p.fingerprint ?? `request:${e.id}`, tags: p.tags,
        request: e.id, ref: p.ref,
      });
    } else if (e.type === ("improve.proposal.accepted" as SfEvent["type"])) {
      // A code suggestion from an imported repo is a task on that repo; anything else is an idea, which is taste.
      const fromRepo = p.source?.kind === "repo.suggestion" && p.source.suggestionId != null;
      const t = this.open({
        kind: fromRepo ? "task" : "idea", title: String(p.title ?? "An improvement"), body: String(p.body ?? ""), by: "council", source: "improve",
        fingerprint: fromRepo ? `suggestion:${p.source.suggestionId}` : `improve:${p.id}`,
        answers: fromRepo ? { todo: String(p.body || p.title || "") } : { core: String(p.title ?? ""), problem: String(p.body ?? ""), why_now: p.lens ? `Seen through the ${p.lens} lens${p.impact ? `, impact ${p.impact}` : ""}${p.effort ? `, effort ${p.effort}` : ""}` : "" },
        project: p.target?.kind === "project" && p.target.id != null ? Number(p.target.id) : null,
        tags: ["improvement"],
      });
      this.log.append("improve.proposal.linked" as SfEvent["type"], { id: p.id, ticketId: t.id });
    }
  }

  private runEnded(t: TicketView, run: number, p: Record<string, any>) {
    if (isClosed(t.status)) {
      // A late run never reopens what you closed; it only says what happened.
      this.log.append("ticket.noted", { id: t.id, by: "factory", kind: "event", text: `Run #${run} ended ${p.outcome} after the ticket was closed.` });
      return;
    }
    if (p.outcome !== "shipped") {
      this.log.append("ticket.noted", { id: t.id, by: "factory", status: p.resumable ? "in_progress" : "open", text: `Run #${run} ${p.outcome}: ${p.reason ?? ""}`.trim() });
      if (t.status === "in_progress" && p.resumable) return;
      return;
    }
    const tests = this.log.db.prepare("SELECT payload FROM events WHERE type = 'factory.tests' AND json_extract(payload, '$.run') = ? ORDER BY id DESC LIMIT 1").get(run) as { payload: string } | undefined;
    const tp = tests ? JSON.parse(tests.payload) as { passed: number; failed: number } : null;
    if (p.repo?.branch) {
      // An engine run in the ticket's repo: its branch (and its draft PR) go onto the ticket, which waits for your look.
      // It never closes by the QA rule: the change is not in the repo until its branch is merged.
      const r = p.repo as { source: string; branch: string; base?: string; sha?: string; files?: string[]; pr?: { number: number; url: string; repo: string }; kept?: string };
      this.log.append("ticket.branch", { id: t.id, by: "factory", source: r.source, dir: p.dir, branch: r.branch, base: r.base, sha: r.sha, files: r.files ?? [], costUsd: Number(p.totalUsd ?? 0) });
      if (r.pr) this.log.append("ticket.pr", { id: t.id, by: "factory", repo: r.pr.repo, number: r.pr.number, url: r.pr.url, branch: r.branch, state: "open" });
      const checked = tp ? `${tp.passed} checks green${tp.failed ? `, ${tp.failed} red` : ""} (the repo's own tests, no secrets, no test removed)` : "no test report";
      // No pull request: the branch waits in the clone, and the ticket's own button takes it from there (send()).
      const onGitHub = !!repoOfProject(this.log, t.project)?.github;
      const where = r.pr ? `Opened draft PR #${r.pr.number}: ${r.pr.url}. When it merges, this ticket moves on by itself.`
        : `${r.kept ?? "The branch stays on this computer."} ${onGitHub ? "Press Send to GitHub on this ticket when you want it there." : "Your own folder is untouched. Press Add to my folder on this ticket to get the branch there."}`;
      this.log.append("ticket.noted", { id: t.id, by: "factory", kind: "reply", costUsd: Number(p.totalUsd ?? 0), status: t.status === "built" ? undefined : "built", text: `Run #${run} built it on branch ${r.branch}: ${r.files?.length ?? 0} file(s) changed, ${checked}, $${Number(p.totalUsd ?? 0).toFixed(4)}.\n\n${where}` });
      return;
    }
    const green = !!tp && tp.passed > 0 && tp.failed === 0;
    const where = p.dir ? ` in ${p.dir}` : "";
    const say = `Run #${run} shipped${where}${p.sha ? ` at ${String(p.sha).slice(0, 7)}` : ""}: ${tp ? `${tp.passed} tests green${tp.failed ? `, ${tp.failed} red` : ""}` : "no test report"}, $${Number(p.totalUsd ?? 0).toFixed(4)}.`;
    this.log.append("ticket.noted", { id: t.id, by: "factory", status: t.status === "built" ? undefined : "built", text: say });
    // The one who checks is not the one who builds: a bug or task with green tests closes by the rule,
    // unless it is taste, or someone pulled the hand brake in words on the thread.
    const brake = this.notes(t.id).some((n) => (n.kind === "note") && HAND_BRAKE.test(n.text));
    if (green && !TASTE_KINDS.includes(t.kind) && !brake) {
      this.log.append("ticket.noted", { id: t.id, by: "qa-rule", status: "closed", text: `Closed by the QA rule: built by run #${run}, all ${tp!.passed} locked tests green, no hand brake on the thread. Reopen it if it is not good.` });
    } else if (brake) {
      this.log.append("ticket.noted", { id: t.id, by: "qa-rule", kind: "event", text: "Left built for your look: the thread asks for it." });
    }
  }

  /**
   * SF-64: the run's plan was more than its money builds, so the rest became the next slice: a ticket of its
   * own under the same epic, blocked by this one until it is done (its branch merged), and asked for when this
   * one was. The crew then starts it by itself within your limit, on the main line that has slice 1 in it.
   */
  private sliced(run: number, p: Record<string, any>, why: "slice" | "left" = "slice") {
    const t = (p.ticket?.id != null ? this.get(Number(p.ticket.id)) : undefined) ?? this.byRun(run);
    const later = (Array.isArray(p.later) ? p.later : []) as { id: string; title: string; what: string; done: string; files?: string[]; why?: string }[];
    if (!later.length) return;
    const project = t?.project ?? this.projectOfRun(run);
    const kept = (Array.isArray(p.kept) ? p.kept : []) as { id: string; title: string }[];
    const body = [
      `The next slice of ${t ? `${t.key} ` : ""}"${p.plan ?? "the change"}". Run #${run}'s money built ${kept.map((f) => `${f.id} ${f.title}`).join(", ") || "the first features"} (on branch ${p.branch ?? "its branch"}); these were left for a run of their own:`,
      "", ...later.map((f) => `- ${f.id} ${f.title}: ${f.what}\n  Done when: ${f.done}${f.why ? `\n  Left because ${f.why}.` : ""}`), "",
      "Build on what slice 1 added once its branch is merged. The original ask:", "", String(p.ask ?? "").slice(0, 3000),
    ].join("\n");
    const next = this.open({
      kind: t?.kind === "plan" ? "request" : t?.kind ?? "request", title: `${t?.title ?? p.plan ?? "The change"}: next slice (${later.map((f) => f.id).join(", ")})`.slice(0, 200),
      body, project, parent: t?.kind === "plan" ? t.id : t?.parentId ?? null, by: "factory", source: "factory", fingerprint: `${why}:${run}`,
      priority: t?.priority ?? null, asked: t ? this.isAsked(t) : false,
    });
    if (t) {
      try { this.link(t.id, next.id, "blocks", "factory"); this.link(next.id, t.id, "derived_from", "factory"); } catch { /* the slice stands without its links */ }
      this.log.append("ticket.noted", { id: t.id, by: "factory", kind: "event", text: why === "left"
        ? `Run #${run} built ${kept.length} of ${kept.length + later.length} features and keeps the branch working; ${next.key} holds the rest (${later.map((f) => `${f.id}: ${f.why ?? "not built"}`).join("; ")}).`
        : `The plan was more than run #${run}'s $${Number(p.fit?.poolUsd ?? 0).toFixed(2)} for building buys: it builds ${kept.length} of ${kept.length + later.length} features now, and ${next.key} holds the rest. All in one run would need about $${Number(p.fit?.needUsd ?? 0).toFixed(2)}.` });
    }
    try { this.edit(next.id, "size", later.length > 1 ? "M" : "S", "factory"); } catch { /* sized later */ }
    try { this.say(next.id, "Sliced from an approved plan: ready to build once what blocks it is done.", { status: "ready", by: "factory", kind: "event" }); } catch { /* stays open */ }
  }

  private byRun(run: number): TicketView | undefined {
    const r = this.log.db.prepare("SELECT * FROM tickets WHERE run = ?").get(run) as Row | undefined;
    return r ? toView(r) : undefined;
  }

  /** The project a run belongs to (the projects model knows; a run started from a ticket joins the ticket's). */
  private projectOfRun(run: number): number | null {
    return projectOf(this.log, { kind: "factory_run", ref: run });
  }

  /** The project an Order Engine node belongs to. */
  private rootOf(nodeId: number): number | null {
    return projectOf(this.log, { kind: "order_node", ref: nodeId });
  }

  /** Tell the projects model this ticket belongs to a project, so the project's rollup counts it. */
  private linkProject(id: number, project: number | null) {
    if (project == null || !this.log.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(project)) return;
    this.log.append("project.linked", { projectId: project, kind: "ticket", ref: String(id) });
  }

  private must(id: number): TicketView {
    const t = this.get(Number(id));
    if (!t) throw new Error(`No ticket #${id}`);
    return t;
  }
}

/** Every project's page shows its tickets: open, for your look, and the newest few. */
registerProjectFacet({
  id: "tickets",
  compute(log, project) {
    const rows = log.db.prepare("SELECT id, kind, title, status FROM tickets WHERE project = ? ORDER BY updated_at DESC LIMIT 5").all(project.id) as Row[];
    const c = log.db.prepare("SELECT count(*) FILTER (WHERE status NOT IN ('closed', 'rejected')) AS open, count(*) FILTER (WHERE status = 'built') AS look, count(*) AS total FROM tickets WHERE project = ?").get(project.id) as Row;
    const you = log.db.prepare(`SELECT count(*) AS n FROM tickets t WHERE t.project = ? AND ${WAITING_ON_YOU}`).get(project.id) as Row;
    return { open: Number(c.open), look: Number(c.look), you: Number(you.n), total: Number(c.total), recent: rows.map((r) => ({ id: Number(r.id), kind: r.kind, title: r.title, status: r.status })) };
  },
});
