import type { RecordLine } from "./record.js";

/**
 * The two limits (docs/fence.md, "Two limits").
 *
 * Limit 1 is for work the owner sent: a ticket they opened, answered or sent again. Limit 2 is for what
 * SoftwareFactory does by itself: a ticket it brought back after the plan limit or after being cut off, and its
 * own work. Of limit 2 a set share is the most SoftwareFactory's own work may use. Both are counted over one
 * period, in the dollars Claude Code reports for each run, read from the record and from nothing else.
 *
 * At a limit nothing is asked for: work of that kind does not start, a run in the middle is parked with its work
 * kept, and the other kind goes on.
 */
export type LimitPeriod = "day" | "week" | "month";
export type Bucket = "you" | "alone" | "own";

export interface LimitSettings {
  limitPeriod: LimitPeriod;
  /** Limit 1, in dollars per period: work you sent. */
  limitYou: number;
  /** Limit 2, in dollars per period: what SoftwareFactory does by itself. */
  limitAlone: number;
  /** How much of limit 2 SoftwareFactory's own work may use, in percent. */
  ownSharePercent: number;
  /** The most one run may use, in dollars. */
  runLimit: number;
}

export const LIMIT_DEFAULTS: LimitSettings = { limitPeriod: "month", limitYou: 100, limitAlone: 50, ownSharePercent: 20, runLimit: 5 };

/** When the running period began, by this computer's own clock and calendar. A week begins on Sunday. */
export function periodStart(period: LimitPeriod, now: Date): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === "week") d.setDate(d.getDate() - d.getDay());
  if (period === "month") d.setDate(1);
  return d;
}

export function periodEnd(period: LimitPeriod, now: Date): Date {
  const d = periodStart(period, now);
  if (period === "day") d.setDate(d.getDate() + 1);
  else if (period === "week") d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

/** Whose work a go is, from the line that sent it: the owner's own press, or SoftwareFactory by itself. */
export function bucketOfSend(sent: RecordLine | undefined): Bucket {
  const d = (sent?.data ?? {}) as Record<string, unknown>;
  if (d.own === true) return "own";
  return sent?.who === "you" ? "you" : "alone";
}

export interface Spend { you: number; alone: number; own: number }

/**
 * What was used since `since`. Every line with a cost counts under the go it belongs to: the latest line that
 * sent its ticket (opened, or sent again) before it. A line with no ticket counts as SoftwareFactory's own.
 */
export function spendOf(lines: RecordLine[], since: Date): Spend {
  const out: Spend = { you: 0, alone: 0, own: 0 };
  const sentBy = new Map<string, RecordLine>();
  const from = since.getTime();
  for (const l of lines) {
    const key = `${l.project ?? ""}\n${l.ticket ?? ""}`;
    if (l.ticket && (l.kind === "ticket.opened" || l.kind === "ticket.queued")) sentBy.set(key, l);
    const cost = Number(l.costUsd ?? 0);
    if (!(cost > 0) || Date.parse(l.ts) < from) continue;
    out[l.ticket ? bucketOfSend(sentBy.get(key)) : "own"] += cost;
  }
  const r = (n: number) => Math.round(n * 10000) / 10000;
  return { you: r(out.you), alone: r(out.alone), own: r(out.own) };
}

export interface Room { you: number; alone: number; own: number }

/** What is left of each limit. SoftwareFactory's own work counts inside limit 2, and has its own smaller ceiling there. */
export function roomLeft(s: LimitSettings, spend: Spend): Room {
  const alone = Math.max(0, s.limitAlone - spend.alone - spend.own);
  return { you: Math.max(0, s.limitYou - spend.you), alone, own: Math.min(alone, Math.max(0, (s.limitAlone * s.ownSharePercent) / 100 - spend.own)) };
}

/** The most one run of that kind may use now: the run limit, or what is left if that is less. 0: it may not start. */
export function runBudget(s: LimitSettings, room: Room, bucket: Bucket): number {
  return Math.max(0, Math.round(Math.min(s.runLimit, room[bucket]) * 100) / 100);
}

export function checkLimits(s: LimitSettings): void {
  if (!["day", "week", "month"].includes(s.limitPeriod)) throw new Error("The limits are counted per day, week or month.");
  for (const [k, name] of [["limitYou", "Limit 1"], ["limitAlone", "Limit 2"], ["runLimit", "The limit of one run"]] as const) if (!Number.isFinite(s[k]) || s[k] < 0 || s[k] > 100000) throw new Error(`${name} must be from 0 to 100000 dollars.`);
  if (!Number.isFinite(s.ownSharePercent) || s.ownSharePercent < 0 || s.ownSharePercent > 100) throw new Error("SoftwareFactory's own share must be from 0 to 100 percent.");
}
