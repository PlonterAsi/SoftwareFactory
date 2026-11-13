import type { Feature } from "./features.js";
import type { ProductDocs } from "./discovery.js";

/**
 * The product judge: a separate agent looks at the running app the way its user would and scores it
 * as a product, against the product documents.
 *
 * Why (docs/loop-engineering.md): passing tests prove the code matches the plan, not that the product does
 * its job. Run 2623 passed 58 of 58 checks and drew all 13 screens, and scored 3 of 10 on what the person
 * asked for. An agent grades its own work kindly, so the judge is not the builder, sees no code and no
 * builder notes: only what the person asked for, the design, and what each screen really shows.
 *
 * The evidence costs nothing: the core starts the app and reads every screen's text and controls from a
 * real browser. The core decides "pass" from the judge's answers (every must-have requirement seen on a
 * screen, every score at the bar). What fails goes back to the fix loop as concrete work, then it is judged
 * once more. What is still open after that is shown to the person at the build gate.
 */

export interface ScreenText { route: string; text: string; controls: string[] }

export const PRODUCT_RUBRIC = ["function", "design", "content"] as const;
export type ProductKey = (typeof PRODUCT_RUBRIC)[number];
export const PRODUCT_RUBRIC_TEXT: Record<ProductKey, string> = {
  function: "every must-have requirement can be seen working on a screen, with a real control for each action it needs",
  design: "the screens are the designed ones (same jobs, in that order), the home screen starts the main loop, and nothing is just a list of records",
  content: "what the screens show is real and specific to this product: no placeholders, no \"coming soon\", no empty states where sample content belongs",
};
export const PRODUCT_PASS_SCORE = 4;
export const MAX_EVALUATION_ROUNDS = 2;

export interface Evaluation {
  requirements: { id: string; met: boolean; evidence: string }[];
  scores: Record<ProductKey, number>;
  problems: { where: string; problem: string; fix: string }[];
}

const str = (x: unknown, max = 300) => String(x ?? "").trim().slice(0, max);

/** The judge's answer. A requirement it did not answer for counts as not met; a missing score counts as 1. */
export function validateEvaluation(j: unknown, docs: ProductDocs): Evaluation {
  const e = (j ?? {}) as Record<string, any>;
  const got = new Map<string, any>((Array.isArray(e.requirements) ? e.requirements : []).map((r: any) => [str(r?.id, 12), r]));
  const requirements = docs.requirements.filter((r) => r.must).map((r) => { const a = got.get(r.id); return { id: r.id, met: a?.met === true, evidence: str(a?.evidence) || "the judge gave no evidence" }; });
  const scores = Object.fromEntries(PRODUCT_RUBRIC.map((k) => { const n = Math.round(Number(e.scores?.[k])); return [k, Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 1]; })) as Record<ProductKey, number>;
  const problems = (Array.isArray(e.problems) ? e.problems : []).map((p: any) => ({ where: str(p?.where, 60), problem: str(typeof p === "string" ? p : p?.problem), fix: str(p?.fix) })).filter((p: { problem: string }) => p.problem).slice(0, 12);
  return { requirements, scores, problems };
}

export const evaluationPasses = (e: Evaluation) => e.requirements.every((r) => r.met) && PRODUCT_RUBRIC.every((k) => e.scores[k] >= PRODUCT_PASS_SCORE);

export function evaluationPrompt(idea: string, docs: ProductDocs, screens: ScreenText[], round: number): string {
  return [
    `What the person asked for, in their words:\n${idea}`,
    `The product as designed:\nPromise: ${docs.brief.promise}\nJourneys:\n${docs.journeys.map((j) => `- ${j.moment}: ${j.steps.join(" → ")}`).join("\n")}\nScreens:\n${docs.screens.map((s) => `- ${s.name}: ${s.purpose} Shows: ${s.shows.join("; ")}. Actions: ${s.actions.join("; ")}.`).join("\n")}`,
    `The must-have requirements:\n${docs.requirements.filter((r) => r.must).map((r) => `- ${r.id}: ${r.text}`).join("\n")}`,
    `The app as built (round ${round}). The core started it and read every screen in a real browser. This is all of it: what a screen does not show here, the person does not see.\n${screens.map((s) => `=== Screen #/${s.route} ===\n${s.text || "(nothing on this screen)"}\nControls: ${s.controls.length ? s.controls.join(" | ") : "(none)"}`).join("\n\n")}`,
    `Score from 1 (fails) to 5 (clearly true). Be hard to please.\n${PRODUCT_RUBRIC.map((k) => `- ${k}: ${PRODUCT_RUBRIC_TEXT[k]}`).join("\n")}`,
  ].join("\n\n");
}

/** What the fix loop is told: the failures as work, most important first. */
export function evaluationFeedback(e: Evaluation, docs: ProductDocs): string {
  const unmet = e.requirements.filter((r) => !r.met);
  const text = (id: string) => docs.requirements.find((r) => r.id === id)?.text ?? id;
  return [
    "A product judge used the running app and compared it with the product design in docs/product/. Fix these without breaking the tests:",
    ...unmet.map((r) => `- Requirement ${r.id} is not met: ${text(r.id)}. What the judge saw: ${r.evidence}`),
    ...e.problems.map((p) => `- ${p.where ? `[${p.where}] ` : ""}${p.problem}${p.fix ? ` Fix: ${p.fix}` : ""}`),
    ...PRODUCT_RUBRIC.filter((k) => e.scores[k] < PRODUCT_PASS_SCORE).map((k) => `- Scored ${e.scores[k]} of 5 on ${k}: ${PRODUCT_RUBRIC_TEXT[k]}.`),
  ].join("\n").slice(0, 4000);
}

/** The share of the run's budget the judge's findings may spend in the build loop, and what one such feature is sized at. */
export const REPAIR_BUDGET_SHARE = 0.25;
export const REPAIR_FEATURE_USD = 0.4;
const REPAIR_GROUP = 5;

/**
 * The judge's findings as build work: unmet requirements in groups small enough for one fresh session, the
 * person's own asks first, then one feature for what the judge noticed beyond the requirements. `max` is how
 * many features the budget allows; what does not fit stays open and is shown at the build gate.
 */
export function repairFeatures(e: Evaluation, docs: ProductDocs, max: number): Feature[] {
  const out: Feature[] = [];
  const req = (id: string) => docs.requirements.find((r) => r.id === id);
  const unmet = e.requirements.filter((r) => !r.met).map((r) => ({ ...r, req: req(r.id) }))
    .sort((a, b) => Number(b.req?.must ?? true) - Number(a.req?.must ?? true) || Number(b.req?.from === "person") - Number(a.req?.from === "person"));
  const add = (title: string, what: string, done: string) => out.push({ id: `J${out.length + 1}`, title: `Judge: ${title}`, what, done, state: "todo" });
  for (let i = 0; i < unmet.length; i += REPAIR_GROUP) {
    const g = unmet.slice(i, i + REPAIR_GROUP);
    add(`requirements ${g.map((r) => r.id).join(", ")}`,
      ["A product judge used the running app and did not see these requirements working. Make each one real on the screen where the person would look for it, using the store and the logic under src/:",
        ...g.map((r) => `- ${r.id}: ${r.req?.text ?? r.id}\n  What the judge saw: ${r.evidence || "nothing that shows it"}`)].join("\n"),
      "Each requirement above can be seen and used in the running app, with sample records that show it, and every test still passes.");
  }
  const notes = e.problems.filter((p) => p.problem);
  if (notes.length) add("what a user would notice",
    ["A product judge used the running app and noticed these problems. Fix each one:", ...notes.map((p) => `- ${p.where ? `[${p.where}] ` : ""}${p.problem}${p.fix ? ` Fix: ${p.fix}` : ""}`)].join("\n"),
    "None of the problems above can be seen in the running app, and every test still passes.");
  return out.slice(0, Math.max(0, max));
}
