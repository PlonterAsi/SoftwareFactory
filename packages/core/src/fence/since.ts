import type { RecordLine } from "./record.js";

/**
 * Since you left (docs/fence.md, "Since you left").
 *
 * One panel at the top of the home screen: what SoftwareFactory did by itself since the owner last said
 * "Got it", in three groups. It is read from the record and from where each ticket stands now, so a ticket
 * that failed and was then fixed while the owner was away shows once, as it stands. "Got it" is a line in the
 * record by the owner (`home.seen`); nothing is hidden by it, the tickets stay on the list below.
 */
export type SinceGroup = "ready" | "yours" | "unfinished";

export interface SinceItem {
  ticket: string;
  sentence: string;
  group: SinceGroup;
  /** One plain sentence: what happened, and for what did not finish, why. */
  says: string;
  url: string | null;
  at: string;
}

export interface Since {
  /** When the owner last said "Got it". Null: never. */
  seenAt: string | null;
  items: SinceItem[];
  /** How many more there are than the panel shows. */
  more: number;
  /** What the work in this time used, in dollars. */
  costUsd: number;
  /** Tickets SoftwareFactory brought back by itself in this time. */
  cameBack: number;
}

/** What the panel needs of a ticket as it stands. */
export interface SinceTicket { ticket: string; project: string | null; sentence: string; state: string; says: string; url: string | null; removed: boolean; stops?: unknown[] }

const GROUP: Record<string, SinceGroup> = {
  proposed: "ready",
  asked: "yours", held: "yours",
  "failed its checks": "unfinished", parked: "unfinished", crashed: "unfinished", "not started": "unfinished", interrupted: "unfinished",
};
const ORDER: SinceGroup[] = ["yours", "ready", "unfinished"];

export function sinceYouLeft(lines: RecordLine[], tickets: SinceTicket[], max = 12): Since {
  const seen = [...lines].reverse().find((l) => l.kind === "home.seen" && l.who === "you");
  const after = seen?.id ?? 0;
  // The latest thing SoftwareFactory itself did on each ticket in this time. What the owner did is not news to them.
  const last = new Map<string, RecordLine>();
  let costUsd = 0, cameBack = 0;
  for (const l of lines) {
    if (l.id <= after) continue;
    costUsd += Number(l.costUsd ?? 0) || 0;
    if (!l.ticket || l.who === "you") continue;
    if (l.kind === "ticket.queued" && (l.data as any)?.returned) cameBack++;
    last.set(`${l.project ?? ""}\n${l.ticket}`, l);
  }
  const all: SinceItem[] = [];
  for (const t of tickets) {
    const l = last.get(`${t.project ?? ""}\n${t.ticket}`), group = GROUP[t.state];
    if (!l || !group || t.removed) continue;
    all.push({ ticket: t.ticket, sentence: t.sentence.split("\n")[0]!.slice(0, 140), group, says: t.says.slice(0, 300), url: t.url && /^https:\/\//.test(t.url) ? t.url : null, at: l.ts });
  }
  all.sort((a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group) || (a.at < b.at ? 1 : -1));
  return { seenAt: seen?.ts ?? null, items: all.slice(0, max), more: Math.max(0, all.length - max), costUsd: Math.round(costUsd * 10000) / 10000, cameBack };
}
