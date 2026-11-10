import { parseJsonBlock } from "../factory/workspace.js";
import { similarity } from "../order/text.js";

/**
 * The Improvement Council's plain-code parts: what a lens seat answers, how
 * answers from several lenses are merged and ranked, and how the council
 * remembers what it already proposed so it never says the same thing twice.
 * No model calls here, so all of it is free and gives the same answer every time.
 */
export type Impact = "high" | "medium" | "low";
export type Effort = "small" | "medium" | "large";
export type TargetKind = "project" | "idea" | "run" | "factory";
export type ProposalStatus = "inbox" | "accepted" | "rejected" | "parked";

/** What a proposal is about. project and idea ids are Order Engine node ids (a project's id is its root node id); run ids are factory runs. */
export interface Target { kind: TargetKind; id: number | null; title: string }

export interface LensProposal { title: string; why: string; change: string; impact: Impact; effort: Effort }

/** One merged proposal before it is stored: the lenses that said it and its rank score. */
export interface Draft extends LensProposal { lenses: string[]; agents: string[]; score: number }

/** What the council already said about something, with how the person answered. */
export interface Remembered { id: number; title: string; change: string; status: ProposalStatus; target: Target }

export const MAX_PER_LENS = 2;
export const MAX_PER_SESSION = 5;

/** Parse a lens seat's answer. Throws when there is no usable JSON; an empty list is a valid answer. */
export function parseLensAnswer(text: string): LensProposal[] {
  let j: { proposals?: unknown } | null = null;
  try { j = parseJsonBlock<{ proposals?: unknown }>(text); } catch { /* not JSON at all */ }
  if (!j || typeof j !== "object" || !Array.isArray(j.proposals)) throw new Error("The lens gave no proposals list");
  const s = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const out: LensProposal[] = [];
  for (const raw of j.proposals as Record<string, unknown>[]) {
    if (!raw || typeof raw !== "object") continue;
    const title = s(raw.title, 120);
    const change = s(raw.change, 400);
    if (!title || !change) continue;
    const impact: Impact = raw.impact === "high" || raw.impact === "low" ? raw.impact : "medium";
    const effort: Effort = raw.effort === "small" || raw.effort === "large" ? raw.effort : "medium";
    out.push({ title, why: s(raw.why, 300), change, impact, effort });
  }
  return out.slice(0, MAX_PER_LENS);
}

const IMPACT: Record<Impact, number> = { high: 3, medium: 2, low: 1 };
const EFFORT: Record<Effort, number> = { small: 0, medium: 1, large: 2 };

/** Rank: impact counts double, every extra lens that said the same thing adds 2, effort costs. */
export function score(p: Pick<Draft, "impact" | "effort" | "lenses">): number {
  return IMPACT[p.impact] * 2 + (p.lenses.length - 1) * 2 - EFFORT[p.effort];
}

const textOf = (p: { title: string; change: string }) => `${p.title}. ${p.change}`;

/** How alike two proposals are, 0..1: the larger of title and title+change similarity. */
export function alike(a: { title: string; change: string }, b: { title: string; change: string }): number {
  return Math.max(similarity(a.title, b.title), similarity(textOf(a), textOf(b)));
}

const sameTarget = (a: Target, b: Target) => a.kind === b.kind && a.id === b.id;

/**
 * Merge every lens's proposals into ranked drafts, dropping anything already said.
 * - Proposals two lenses made alike (>= 0.45) become one draft carrying both lenses.
 * - A draft alike (>= 0.5) to anything already proposed for the same subject is dropped:
 *   it was accepted, rejected, parked or still waits in the inbox.
 * - A draft alike (>= 0.6) to anything the person rejected anywhere is dropped too.
 */
export function mergeLenses(
  answers: { lens: string; agent: string; proposals: LensProposal[] }[],
  memory: Remembered[],
  target: Target,
  max = MAX_PER_SESSION,
): { drafts: Draft[]; suppressed: { title: string; because: string }[] } {
  const groups: Draft[] = [];
  for (const a of answers) {
    for (const p of a.proposals) {
      const g = groups.find((x) => alike(x, p) >= 0.45);
      if (g) {
        if (!g.lenses.includes(a.lens)) { g.lenses.push(a.lens); g.agents.push(a.agent); }
        // Keep the stronger statement of the same idea.
        if (IMPACT[p.impact] > IMPACT[g.impact]) Object.assign(g, { title: p.title, why: p.why, change: p.change, impact: p.impact, effort: p.effort });
      } else groups.push({ ...p, lenses: [a.lens], agents: [a.agent], score: 0 });
    }
  }
  const suppressed: { title: string; because: string }[] = [];
  const kept: Draft[] = [];
  for (const g of groups) {
    const seen = memory.find((m) => (sameTarget(m.target, target) && alike(m, g) >= 0.5) || (m.status === "rejected" && alike(m, g) >= 0.6));
    if (seen) { suppressed.push({ title: g.title, because: `alike #${seen.id} (${seen.status})` }); continue; }
    g.score = score(g);
    kept.push(g);
  }
  kept.sort((a, b) => b.score - a.score || b.lenses.length - a.lenses.length);
  for (const g of kept.slice(max)) suppressed.push({ title: g.title, because: "below the top of this session" });
  return { drafts: kept.slice(0, max), suppressed };
}

/** What a lens reads about the past: so it neither repeats itself nor brings back a rejected idea. */
export function memoryText(memory: Remembered[], target: Target): string {
  const here = memory.filter((m) => sameTarget(m.target, target)).slice(-20);
  const rejected = memory.filter((m) => m.status === "rejected" && !sameTarget(m.target, target)).slice(-15);
  const line = (m: Remembered) => `- [${m.status}] ${m.title}`;
  return [
    here.length ? `Already proposed for this subject (never repeat these):\n${here.map(line).join("\n")}` : "Already proposed for this subject: nothing yet.",
    rejected.length ? `Rejected by the person elsewhere (do not bring these back):\n${rejected.map(line).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}
