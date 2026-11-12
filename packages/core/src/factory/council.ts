import { similarity } from "../order/text.js";
import { parseJsonBlock } from "./workspace.js";

/**
 * The Council: three to six seats look at an idea before anything is planned.
 * Each seat answers alone in round 1. If no majority votes "build", every seat
 * sees the others' takes and answers again (round 2). Plain code then merges
 * the takes into one brief for the Planner: what two or more seats agree on,
 * every distinct proposal, and every concern to design around.
 */
export type Vote = "build" | "reshape" | "drop";
export interface SeatTake { take: string; proposals: string[]; concerns: string[]; vote: Vote; scope: "small" | "medium" | "large" }
export interface SeatResult { agent: string; name: string; version: number; round: number; take?: SeatTake; error?: string; costUsd: number }

export interface CouncilBrief {
  rounds: number;
  votes: Record<string, Vote>;
  /** What the majority says to do: build as is, build reshaped, or not build. */
  outcome: Vote;
  agreed: string[];
  proposals: string[];
  concerns: string[];
}

export const MAX_COUNCIL_ROUNDS = 2;

export function parseSeatTake(text: string): SeatTake {
  const j = parseJsonBlock<Partial<SeatTake>>(text);
  if (!j || typeof j !== "object" || typeof j.take !== "string" || !j.take.trim()) throw new Error("The seat gave no take");
  const vote: Vote = j.vote === "drop" || j.vote === "reshape" ? j.vote : "build";
  const scope = j.scope === "medium" || j.scope === "large" ? j.scope : "small";
  const list = (v: unknown) => (Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 4);
  return { take: j.take.trim().slice(0, 600), proposals: list(j.proposals), concerns: list(j.concerns), vote, scope };
}

/** A small job skips the Council: a short idea with a single ask. */
export function isSmallJob(idea: string): { small: boolean; why: string } {
  const words = idea.trim().split(/\s+/).filter(Boolean).length;
  const asks = (idea.match(/[;\n]|,\s*and\b|\band\b/gi) ?? []).length;
  if (words <= 14 && asks <= 1) return { small: true, why: `small job: ${words} words, one ask` };
  return { small: false, why: `${words} words${asks > 1 ? `, ${asks} asks` : ""}` };
}

/** The majority vote of the seats that answered; ties lean to reshape, never silently to drop. */
export function majority(votes: Vote[]): Vote | null {
  const n = (v: Vote) => votes.filter((x) => x === v).length;
  const need = Math.floor(votes.length / 2) + 1;
  for (const v of ["build", "reshape", "drop"] as Vote[]) if (votes.length && n(v) >= need) return v;
  return null;
}

/** Merge the seats' latest takes into one brief. Items said by two or more seats are "agreed". */
export function synthesize(seats: SeatResult[], rounds: number): CouncilBrief {
  const latest = new Map<string, SeatResult>();
  for (const s of seats) if (s.take) latest.set(s.agent, s);
  const takes = [...latest.values()];
  const votes = Object.fromEntries(takes.map((s) => [s.name, s.take!.vote])) as Record<string, Vote>;
  const outcome = majority(Object.values(votes)) ?? "reshape";
  const groups: { text: string; seats: Set<string>; kind: "proposal" | "concern" }[] = [];
  for (const s of takes) {
    for (const [kind, items] of [["proposal", s.take!.proposals], ["concern", s.take!.concerns]] as const) {
      for (const text of items) {
        const g = groups.find((x) => similarity(x.text, text) >= 0.4);
        if (g) { g.seats.add(s.agent); if (kind === "concern") g.kind = "concern"; }
        else groups.push({ text, seats: new Set([s.agent]), kind });
      }
    }
  }
  const agreed = groups.filter((g) => g.seats.size >= 2);
  const rest = groups.filter((g) => g.seats.size < 2);
  return {
    rounds, votes, outcome,
    agreed: agreed.map((g) => g.text).slice(0, 6),
    proposals: rest.filter((g) => g.kind === "proposal").map((g) => g.text).slice(0, 6),
    concerns: rest.filter((g) => g.kind === "concern").map((g) => g.text).slice(0, 6),
  };
}

/** The brief as the Planner reads it. */
export function briefText(b: CouncilBrief): string {
  const sec = (title: string, items: string[]) => (items.length ? `${title}:\n${items.map((x) => `- ${x}`).join("\n")}` : "");
  return [
    `Council brief (${Object.keys(b.votes).length} agents reviewed the idea first; majority: ${b.outcome}):`,
    sec("Agreed by two or more seats", b.agreed),
    sec("Proposals", b.proposals),
    sec("Concerns to design around", b.concerns),
    "The features the person named in the idea stay in the plan: use the brief to make them smaller, not to drop them.",
  ].filter(Boolean).join("\n");
}

/** What a seat reads in round 2: the others' round-1 takes. */
export function othersText(seats: SeatResult[], self: string): string {
  return seats.filter((s) => s.agent !== self && s.take).map((s) => `${s.name} (voted ${s.take!.vote}): ${s.take!.take}${s.take!.concerns.length ? ` Concerns: ${s.take!.concerns.join("; ")}.` : ""}`).join("\n");
}
