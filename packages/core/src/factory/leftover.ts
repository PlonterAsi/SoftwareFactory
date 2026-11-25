import type { EventLog } from "../events.js";
import type { ProductDocs } from "./discovery.js";

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

export function leftAtShip(log: EventLog, run: number, docs: ProductDocs | null, features: { id: string; title: string; state: string }[] = []): LeftAtShip {
  const mine = (type: string) => log.list({ type: type as never, sinceId: run - 1, limit: 1e6 }).map((e) => e.payload as Payload).filter((p) => p.run === run);
  const judge = mine("factory.evaluation").filter((p) => !p.skipped).at(-1) as { requirements?: { id: string; met: boolean; evidence?: string }[] } | undefined;
  const textOf = new Map((docs?.requirements ?? []).map((r) => [r.id, r.text]));
  const reqs = Array.isArray(judge?.requirements) ? judge!.requirements! : [];
  const unmet = reqs.filter((r) => r && r.met === false).slice(0, 30)
    .map((r) => ({ id: String(r.id), text: String(textOf.get(r.id) ?? "").slice(0, 400), evidence: String(r.evidence ?? "").slice(0, 500) }));
  const review = mine("factory.review").at(-1) as { verdict?: string; findings?: { severity?: string; text?: string }[] } | undefined;
  const notes = (Array.isArray(review?.findings) ? review!.findings! : []).filter((f) => f && f.text).slice(0, 12)
    .map((f) => ({ severity: f.severity === "high" ? "high" as const : "low" as const, text: String(f.text).slice(0, 500) }));
  // "broken" and "regressed" went through the fix loop, the Reviewer and the judge after the build; what they
  // still miss is in the lists above. A feature never written is only here.
  const never = features.filter((f) => f.state === "todo" || f.state === "empty" || f.state === "now")
    .map((f) => ({ id: f.id, title: f.title, why: f.state === "empty" ? "the Builder wrote nothing for it" : "the run ended before it was built" }));
  return { unmet, judged: reqs.length, notes, features: never };
}

/** Nothing worth a next version: low notes alone do not start one (they ride along when something else does). */
export const nothingLeft = (l: LeftAtShip) => !l.unmet.length && !l.features.length && !l.notes.some((n) => n.severity === "high");
