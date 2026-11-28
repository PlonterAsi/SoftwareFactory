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
  project: string | null;
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
  /** The last line of the record this was read from. "Got it" names it, so news that came after is not waved off unseen. */
  upTo: number;
  items: SinceItem[];
  /** How many there are in each group, shown or not. */
  counts: Record<SinceGroup, number>;
  /** What all work in this time used, in dollars. */
  costUsd: number;
  /** How many tickets SoftwareFactory brought back to the queue by itself in this time. */
  cameBack: number;
  /** Every ticket that stands cut off now. "Got it" writes them down, so one that is cut off later with no new line is still news. */
  cutOff: string[];
}

/** What the panel needs of a ticket as it stands. */
export interface SinceTicket { ticket: string; project: string | null; sentence: string; state: string; says: string; url: string | null; removed: boolean; canRelease?: boolean; /** The live check found the project stopped running here: it waits for the owner's word. */ finding?: boolean }

const GROUP: Record<string, SinceGroup> = {
  proposed: "ready",
  asked: "yours", held: "yours",
  split: "unfinished",
  "failed its checks": "unfinished", parked: "unfinished", crashed: "unfinished", "not started": "unfinished", interrupted: "unfinished",
};
const ORDER: SinceGroup[] = ["yours", "ready", "unfinished"];
/** Lines that change where a ticket stands. A link to an issue or a word from the watchdog is not news about the ticket. */
const NEWS = new Set(["gate.asked", "fence.tested", "run.started", "run.step", "run.checked", "run.ended", "result.proposed", "ticket.removed", "ticket.split"]);

/** `show`: how many of each group the panel names. No group is ever left out whole. */
export function sinceYouLeft(lines: RecordLine[], tickets: SinceTicket[], show = 10): Since {
  const seen = [...lines].reverse().find((l) => l.kind === "home.seen" && l.who === "you");
  const sd = (seen?.data ?? {}) as Record<string, unknown>;
  // "Got it" covers the lines the owner's page had read, not the ones that came while the press was on its way.
  const after = seen ? (Number.isInteger(sd.upTo) && (sd.upTo as number) <= seen.id ? (sd.upTo as number) : seen.id) : 0;
  const knownCut = new Set(Array.isArray(sd.cutOff) ? (sd.cutOff as unknown[]).map(String) : []);
  // The latest thing SoftwareFactory itself did on each ticket in this time. What the owner did is not news to them.
  const last = new Map<string, RecordLine>(), back = new Set<string>();
  let costUsd = 0;
  for (const l of lines) {
    if (l.id <= after) continue;
    costUsd += Number(l.costUsd ?? 0) || 0;
    if (!l.ticket || l.who === "you") continue;
    if (l.kind === "ticket.queued" && ((l.data as any)?.returned || (l.data as any)?.ladder)) back.add(l.ticket);
    if (NEWS.has(l.kind)) last.set(l.ticket, l);
  }
  const all: SinceItem[] = [];
  const cutOff: string[] = [];
  for (const t of tickets) {
    if (t.state === "interrupted" && !t.removed) cutOff.push(t.ticket);
    const l = last.get(t.ticket);
    const item = (group: SinceGroup, says: string, at: string) => all.push({ ticket: t.ticket, project: t.project, sentence: t.sentence.split("\n")[0]!.slice(0, 140), group, says: says.slice(0, 300), url: t.url && /^https:\/\//.test(t.url) ? t.url : null, at });
    // Taken off the list by SoftwareFactory itself (its issue was closed on GitHub): said once.
    if (t.removed) { if (l?.kind === "ticket.removed") item("unfinished", "SoftwareFactory took it off the list: its issue was closed on GitHub. Show removed brings it back.", l.ts); continue; }
    // Cut off (SoftwareFactory closed, the computer restarted): there is no line for that, so it is news until it was named once.
    if (t.state === "interrupted" && !l) { if (!knownCut.has(t.ticket) && seen) item("unfinished", t.says, seen.ts); continue; }
    const group = GROUP[t.state];
    if (!l || !group) continue;
    // A hold only "Work it again" can clear did not finish; a hold the owner can let go waits for their word.
    item(t.finding ? "yours" : t.state === "held" && !t.canRelease ? "unfinished" : group, t.finding ? `The live check: it stopped running here after a change on GitHub (${t.says}).` : t.says, l.ts);
  }
  all.sort((a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group) || (a.at < b.at ? 1 : -1));
  const counts = { yours: 0, ready: 0, unfinished: 0 } as Record<SinceGroup, number>;
  const items = all.filter((x) => ++counts[x.group] <= Math.max(1, show));
  return { seenAt: seen?.ts ?? null, upTo: lines.at(-1)?.id ?? 0, items, counts, costUsd: Math.round(costUsd * 10000) / 10000, cameBack: back.size, cutOff };
}
