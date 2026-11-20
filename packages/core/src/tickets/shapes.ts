/** The shapes, constants and pure helpers of tickets (tickets.ts re-exports all of it). */
import type { AgentRuntime } from "../runtime.js";
import type { Factory } from "../factory/loop.js";
import type { AgentBay } from "../bay/bay.js";
import { type TimelineCat } from "./tables.js";
import { type RepoRef } from "./repowork.js";
import { type GitHub } from "./github.js";
import { type Routed } from "../factory/route.js";
import { type RepoRuns } from "../factory/reporun.js";
import type { Verification } from "./verify.js";
import type { TicketCheck } from "./precheck.js";
import { type LinkView, type NoteView, type Priority, type Size, type Relation, type TicketSeverity, type TicketKind, type TicketStatus, type TicketView } from "./model.js";

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
  /** How its latest pass was tested, layer by layer, how to test it again and how to see it works (tickets/verify.ts). */
  verification: (Verification & { at: string; by: string }) | null;
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

export const AUTO_WORK_DEFAULT: AutoWork = { on: true, maxUsd: 1.5, askedMaxUsd: 3, dailyUsd: 10, wip: 2 };
/** How often the crew starts or retries one ticket on its own before it leaves the rest to you. */
export const AUTO_TRIES = 2;

export interface QueueSpot {
  ticket: TicketView;
  /** 1 = next in line in its project. Null when the crew will not take it on its own. */
  position: number | null;
  /** The check before money holds it: the questions that wait for your answer. */
  held?: TicketCheck;
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
  const re = new RegExp(`(?<![A-Za-z0-9])${key}-(\\d+)((?:\\s*(?:,|\/|and|&)\\s*(?:${key}-)?\\d+(?![\\d.]))*)`, "gi");
  for (const m of String(text ?? "").matchAll(re)) {
    out.add(Number(m[1]));
    for (const n of m[2].matchAll(/\d+/g)) out.add(Number(n[0]));
  }
  return [...out];
}

/**
 * Tickets a merged PR title closes as duplicates: when the title says "dupe" or "duplicate", each "#N" in it is
 * the ticket numbered N (tickets in no project have no key, so "#89" is how they are named), a duplicate of the
 * keyed ticket the same title names: "SF-71: close #89, #90 as dupes".
 */
export function dupesIn(text: string): number[] {
  const s = String(text ?? "");
  if (!/\bdup(?:e|es|licate|licates|licated)\b/i.test(s)) return [];
  return [...new Set([...s.matchAll(/(?<![A-Za-z0-9&])#(\d+)\b/g)].map((m) => Number(m[1])))];
}

/** What the tickets service is given: the agent runtime, the engine, GitHub, and the rules it works under. */
export interface TicketsOptions { runtime?: AgentRuntime; factory?: Factory; bay?: AgentBay; budgetUsd?: number; workRoot?: string; autoWork?: () => AutoWork; canWork?: () => string | null;
  /** GitHub write access: push a ticket's branch and open a draft PR. */
  github?: GitHub;
  /** Why the crew may not open PRs right now (the practice crew never does), or null. */
  canShip?: () => string | null;
  /** The engine in an existing codebase: feature-sized tickets of a repo project go there. */
  repoRuns?: RepoRuns;
  /** What the monthly budgets leave for work on a project (watch/spend.ts); leftUsd null: no monthly limit. */
  monthLeft?: (project: number | null) => { leftUsd: number | null; why: string | null };
}
