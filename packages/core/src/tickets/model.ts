/**
 * Tickets: one record for every unit of work on a project, opened by you,
 * by the Order Engine, by the Improvement Council or by an agent, and worked
 * by Agent Bay agents through the factory loop.
 *
 * The idea comes from the ticket system Assaf runs inside another app of his:
 * a ticket of a kind asks that kind's questions; its status is offered as the
 * next move; "built" means it waits for your look; the thread is append-only;
 * an agent's reply lands on the ticket; bugs and tasks close themselves when
 * their tests are green, while requests, ideas and plans are taste and close
 * only by your hand. This module holds the catalogue (kinds, questions,
 * words) and the pure rules (next moves, who may close, the work document).
 */

export const KINDS = ["bug", "request", "task", "idea", "plan", "question"] as const;
export type TicketKind = (typeof KINDS)[number];

export const KIND_LABEL: Record<TicketKind, string> = {
  bug: "Bug", request: "Request", task: "Task", idea: "Idea", plan: "Plan", question: "Question",
};

export interface Question {
  key: string;
  label: string;
  /** Asked in the quick form; the rest wait on the ticket page. */
  short?: boolean;
  /** The ticket cannot be opened without it (the first short question of a kind). */
  required?: boolean;
  choices?: string[];
}

/** What each kind asks. Adding a question is a line here; answers are stored as JSON, so no migration. */
export const FORMS: Record<TicketKind, Question[]> = {
  bug: [
    { key: "expected", label: "What you expected", short: true },
    { key: "steps", label: "How to make it happen" },
    { key: "since", label: "Since when", choices: ["always", "after an update", "today", "not sure"] },
    { key: "frequency", label: "How often", choices: ["always", "sometimes", "once"] },
  ],
  request: [
    { key: "need", label: "The need, and why", short: true, required: true },
    { key: "today", label: "How it is done today" },
    { key: "done", label: "What \"built\" means" },
  ],
  task: [
    { key: "todo", label: "What to do", short: true, required: true },
    { key: "done", label: "What \"built\" means" },
  ],
  idea: [
    { key: "core", label: "The core in one sentence", short: true, required: true },
    { key: "problem", label: "The problem it solves" },
    { key: "why_now", label: "Why now" },
    { key: "not", label: "What it is not" },
  ],
  plan: [
    { key: "goal", label: "The goal", short: true, required: true },
    { key: "success", label: "How we will know it worked" },
  ],
  question: [
    { key: "ask", label: "The question", short: true, required: true },
    { key: "options", label: "The options" },
    { key: "recommend", label: "What we recommend, and why" },
    { key: "answer", label: "The answer" },
  ],
};

export interface StatusWord {
  code: TicketStatus;
  label: string;
  /** Ends the ticket's life. */
  closed?: boolean;
  /** Built, waiting for your look. */
  wantsLook?: boolean;
}

export const STATUSES = ["open", "ready", "in_progress", "built", "closed", "rejected"] as const;
export type TicketStatus = (typeof STATUSES)[number];

export const STATUS_WORDS: StatusWord[] = [
  { code: "open", label: "Open" },
  { code: "ready", label: "Ready" },
  { code: "in_progress", label: "In progress" },
  { code: "built", label: "Built, for your look", wantsLook: true },
  { code: "closed", label: "Closed", closed: true },
  { code: "rejected", label: "Rejected", closed: true },
];

export const PRIORITIES = ["now", "this_week", "next", "someday"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABEL: Record<Priority, string> = { now: "Now", this_week: "This week", next: "Next", someday: "Someday" };

export const TICKET_SEVERITIES = ["blocking", "annoying", "cosmetic"] as const;
export type TicketSeverity = (typeof TICKET_SEVERITIES)[number];

export const RELATIONS = ["related", "duplicate_of", "derived_from", "blocks"] as const;
export type Relation = (typeof RELATIONS)[number];

export const SOURCES = ["you", "order", "council", "agent", "factory", "improve"] as const;

/** Kinds that are taste: only you close them, never an agent or a rule. */
export const TASTE_KINDS: TicketKind[] = ["request", "idea", "plan", "question"];

/** Words in the thread that stop any automatic close (the hand brake, in words). */
export const HAND_BRAKE = /\b(needs? (a |my )?look|don'?t close|do not close|keep open|hold)\b/i;

export const isClosed = (s: TicketStatus) => !!STATUS_WORDS.find((w) => w.code === s)?.closed;

export interface Move { to: TicketStatus; label: string }

/**
 * The status is offered as the next move, never as a full list: from built,
 * "close, I saw it, good" or "reopen, not good yet"; from a closed word, reopen;
 * from an open word, the next open word, and close.
 */
export function nextMoves(status: TicketStatus, kind: TicketKind): Move[] {
  if (status === "built") return [{ to: "closed", label: "Close, I saw it, good" }, { to: "open", label: "Reopen, not good yet" }];
  if (isClosed(status)) return [{ to: "open", label: "Reopen" }];
  const order: TicketStatus[] = ["open", "ready", "in_progress", "built"];
  const next = order[order.indexOf(status) + 1];
  const moves: Move[] = [];
  if (next) moves.push({ to: next, label: STATUS_WORDS.find((w) => w.code === next)!.label });
  moves.push({ to: "closed", label: kind === "question" ? "Answered, close" : "Close" });
  moves.push({ to: "rejected", label: "Reject" });
  return moves;
}

/** Who may move a ticket where. Returns the reason it is refused, or null. */
export function refuseMove(kind: TicketKind, from: TicketStatus, to: TicketStatus, by: string): string | null {
  if (from === to) return `It is already ${to.replace("_", " ")}.`;
  if (by !== "you" && to === "closed" && TASTE_KINDS.includes(kind)) return `A ${kind} is closed only by you; agents and rules leave it built for your look.`;
  if (by !== "you" && isClosed(from)) return "A closed ticket never moves by itself: a late agent reply must not reopen what you closed.";
  return null;
}

export interface TicketView {
  id: number;
  kind: TicketKind;
  title: string;
  body: string;
  answers: Record<string, string>;
  project: number | null;
  status: TicketStatus;
  priority: Priority | null;
  severity: TicketSeverity | null;
  assignee: string | null;
  parentId: number | null;
  lineOrder: number | null;
  tags: string[];
  source: string;
  openedBy: string;
  fingerprint: string | null;
  run: number | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  lastNote: string | null;
}

export interface NoteView {
  eventId: number;
  ts: string;
  by: string;
  kind: "note" | "reply" | "status" | "event";
  text: string;
  status: TicketStatus | null;
  costUsd: number | null;
}

export interface LinkView { from: number; to: number; relation: Relation; title?: string; status?: TicketStatus }

/**
 * The work document: the same text you read on the ticket page, an agent gets
 * as its brief, and a factory run starts from.
 */
export function workDocument(t: TicketView, notes: NoteView[] = [], links: LinkView[] = [], lines: TicketView[] = []): string {
  const out = [`# #${t.id} ${t.title}`, "", `${KIND_LABEL[t.kind]} · ${t.status.replace("_", " ")}${t.priority ? ` · priority ${PRIORITY_LABEL[t.priority]}` : ""}${t.severity ? ` · ${t.severity}` : ""}${t.tags.length ? ` · ${t.tags.join(", ")}` : ""}`];
  if (t.body.trim()) out.push("", t.body.trim());
  for (const q of FORMS[t.kind]) {
    const a = t.answers[q.key];
    if (a && a.trim()) out.push("", `## ${q.label}`, "", a.trim());
  }
  if (lines.length) out.push("", "## Lines of this plan", "", ...lines.map((l, i) => `${i + 1}. #${l.id} ${l.title} (${l.status.replace("_", " ")})`));
  if (links.length) out.push("", "## Links", "", ...links.map((l) => `- ${l.relation.replace("_", " ")} #${l.to}${l.title ? ` ${l.title}` : ""}`));
  const said = notes.filter((n) => n.kind === "note" || n.kind === "reply").slice(-6);
  if (said.length) out.push("", "## Recent thread", "", ...said.map((n) => `- ${n.by}: ${n.text.replace(/\s+/g, " ").slice(0, 400)}`));
  return out.join("\n");
}

/** What a factory run is asked to build from a ticket: the work document, said as an idea. */
export function ideaFromTicket(t: TicketView, doc: string): string {
  const first = t.answers.need || t.answers.todo || t.answers.core || t.answers.goal || t.answers.expected || "";
  const head = `${t.title}${first && !t.title.toLowerCase().includes(first.toLowerCase()) ? `: ${first}` : ""}`;
  // The document without its title and status lines: the head already says what it is.
  const rest = doc.split("\n").slice(2).join("\n").trim();
  return `${head} (ticket #${t.id})${rest ? `\n\n${rest}` : ""}`.slice(0, 6000);
}

/** A title from free text: its first line, trimmed to a readable length. */
export function titleFrom(text: string): string {
  const line = text.trim().split(/\r?\n/)[0].replace(/^(bug|idea|task|request|plan|question)\s*[:\-]\s*/i, "").trim();
  return line.length > 90 ? `${line.slice(0, 87).replace(/\s+\S*$/, "")}…` : line;
}
