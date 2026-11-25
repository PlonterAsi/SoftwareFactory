import type { EventLog } from "../events.js";
import type { ProductDocs } from "./discovery.js";
import { restoreState, shippedDesign } from "./runkit.js";

/**
 * What a shipped version of an app left to do. Run 4004 shipped Game Mastery with "5 of 40 requirements not
 * seen working" and eight Reviewer notes, and all of it was forgotten the moment the build was accepted: the
 * project stopped at version 1. The list is now written down when the version ships (event factory.left), and
 * the project's own ticket for it lets the crew build the next version on top (tickets/grow.ts).
 */
export interface LeftAtShip {
  /** Requirements the product judge did not see working in the running app, with what it saw. */
  unmet: { id: string; text: string; evidence: string }[];
  /** How many requirements the judge looked at. */
  judged: number;
  /** What the Reviewer still noted on the code that shipped. */
  notes: { severity: "high" | "low"; text: string }[];
  /** Features of the plan that were never built. */
  features: { id: string; title: string; why: string }[];
}

type Payload = Record<string, unknown> & { run?: number };

/** One requirement across versions. Screen items (SC1, SC2) are numbered again in every run, so their text names them. */
const keyOf = (r: { id: string; text?: string }) => (/^SC\d+$/.test(String(r.id)) && r.text ? String(r.text) : String(r.id));

/**
 * `before` is what the version underneath left. Run 11986 (Idea Bank v0.2.0) was judged on its 2 new screen
 * items only, so the project read "0 of 2 working" and the 7 requirements v0.1.0 left dropped off the list
 * unchecked. What the version before left stays owed until a judge sees it working.
 */
export function leftAtShip(log: EventLog, run: number, docs: ProductDocs | null, features: { id: string; title: string; state: string }[] = [], before: LeftAtShip | null = null): LeftAtShip {
  const mine = (type: string) => log.list({ type: type as never, sinceId: run - 1, limit: 1e6 }).map((e) => e.payload as Payload).filter((p) => p.run === run);
  const judge = mine("factory.evaluation").filter((p) => !p.skipped).at(-1) as { requirements?: { id: string; met: boolean; evidence?: string; text?: string }[] } | undefined;
  const textOf = new Map((docs?.requirements ?? []).map((r) => [r.id, r.text]));
  const reqs = Array.isArray(judge?.requirements) ? judge!.requirements! : [];
  const textFor = (r: { id: string; text?: string }) => String(textOf.get(r.id) ?? r.text ?? "").slice(0, 400);
  const seen = new Set(reqs.filter(Boolean).map((r) => keyOf({ id: r.id, text: textFor(r) })));
  const owed = (before?.unmet ?? []).filter((r) => !seen.has(keyOf(r)));
  const owedKeys = new Set((before?.unmet ?? []).map(keyOf));
  const unmet = [
    ...reqs.filter((r) => r && r.met === false).map((r) => ({ id: String(r.id), text: textFor(r), evidence: String(r.evidence ?? "").slice(0, 500) })),
    ...owed.map((r) => ({ ...r, evidence: r.evidence.startsWith(NOT_AGAIN) ? r.evidence : `${NOT_AGAIN} ${r.evidence}`.slice(0, 500) })),
  ].slice(0, 30);
  const judged = before ? before.judged + reqs.filter((r) => r && !owedKeys.has(keyOf({ id: r.id, text: textFor(r) }))).length : reqs.length;
  const review = mine("factory.review").at(-1) as { verdict?: string; findings?: { severity?: string; text?: string }[] } | undefined;
  const notes = (Array.isArray(review?.findings) ? review!.findings! : []).filter((f) => f && f.text).slice(0, 12)
    .map((f) => ({ severity: f.severity === "high" ? "high" as const : "low" as const, text: String(f.text).slice(0, 500) }));
  // "broken" and "regressed" went through the fix loop, the Reviewer and the judge after the build; what they
  // still miss is in the lists above. A feature never written is only here.
  const never = features.filter((f) => f.state === "todo" || f.state === "empty" || f.state === "now")
    .map((f) => ({ id: f.id, title: f.title, why: f.state === "empty" ? "the Builder wrote nothing for it" : "the run ended before it was built" }));
  return { unmet, judged, notes, features: never };
}

const NOT_AGAIN = "Not checked again in this version. Before:";

/** What a shipped run left, with what the versions under it left and nobody has seen working since. */
export function leftOfRun(log: EventLog, run: number, depth = 0): LeftAtShip {
  const st = restoreState(log, run);
  const feats = log.list({ type: "factory.feature", sinceId: run - 1, limit: 1e6 }).map((e) => e.payload as { run?: number; id: string; title: string; state: string }).filter((p) => p.run === run);
  const last = new Map<string, { id: string; title: string; state: string }>();
  for (const f of feats) last.set(f.id, { id: f.id, title: f.title, state: f.state === "building" ? "todo" : f.state });
  const screen = (log.get(run)?.payload as { screen?: { kind?: string; baseRun?: number } } | undefined)?.screen;
  const before = screen?.kind === "feature" && screen.baseRun != null && depth < 30 ? leftOfRun(log, screen.baseRun, depth + 1) : null;
  return leftAtShip(log, run, st.docs ?? shippedDesign(log, run).docs, [...last.values()], before);
}

/** Nothing worth a next version: low notes alone do not start one (they ride along when something else does). */
export const nothingLeft = (l: LeftAtShip) => !l.unmet.length && !l.features.length && !l.notes.some((n) => n.severity === "high");
