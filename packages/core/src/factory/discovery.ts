/**
 * Discovery: the loop that turns one line into a designed product before anything is planned.
 *
 * Why (Assaf, 2026-11-13; docs/engine.md "Discovery"): the engine went from one line straight to a code
 * plan in a single call, so nothing ever designed the product and nothing judged the design. Game Mastery
 * came out as lists of records every time. The harnesses that build a product from one prompt all expand
 * the prompt into product documents first, and have a separate, sceptical agent judge them
 * (Anthropic's planner and evaluator, BMAD's brief and PRD, Ralph's specs).
 *
 * The loop: the Designer writes the product documents; the Critic scores them against a fixed rubric;
 * the Designer revises with the Critic's problems in hand; until every score reaches the bar or the
 * rounds or the budget run out. The core decides "pass" from the scores, never the Critic's own word.
 * The documents are the run's spine: the Planner plans from them, they are written into the project
 * (docs/product/), and the person sees them at the plan gate.
 */

export interface ProductDocs {
  /** Who it is for, what hurts today, what the product promises, and what it is not. */
  brief: { who: string; problem: string; promise: string; notThis: string[] };
  /** What the Designer learned before designing (similar products, how people really do this). */
  research: { finding: string; source?: string }[];
  /** The moments the person opens the app, each walked step by step. */
  journeys: { moment: string; goal: string; steps: string[] }[];
  /** The app's own screens, in navigation order; the first is the home. */
  screens: { id: string; name: string; purpose: string; shows: string[]; actions: string[] }[];
  /** Everything the product must do: the person's own asks first, then what the design adds. */
  requirements: { id: string; text: string; from: "person" | "design"; must: boolean }[];
  /** The product's own rules, stated exactly enough to build and test: how it ranks, picks, counts, removes. */
  rules: { name: string; rule: string }[];
  /** What the Designer assumed because the idea did not say. */
  assumptions: string[];
}

export const RUBRIC = ["coverage", "journey", "screens", "originality", "buildable"] as const;
export type RubricKey = (typeof RUBRIC)[number];
export const RUBRIC_TEXT: Record<RubricKey, string> = {
  coverage: "every feature, kind of data, behaviour and example the person named is a requirement, and none is watered down",
  journey: "there is one clear main loop the person comes back for, and each journey can be walked step by step with no gap",
  screens: "each screen serves a moment in a journey and is built for that job; the home screen is where the main loop starts; it is not a set of record lists",
  originality: "the design fits this idea and this kind of user; it would not fit any other idea with the nouns swapped",
  buildable: "one small team could build it as a local app: no step depends on something that cannot exist or be tested, and every rule the product decides by (how it ranks, picks, counts or removes) is stated in \"rules\"; data shapes and code structure are the Planner's job, not a gap here",
};
/** Every score must reach this (1 to 5) for the documents to pass. */
export const PASS_SCORE = 4;
export const MAX_DISCOVERY_ROUNDS = 3;
/** The share of the run's budget discovery may use before it stops looping and goes on with its best documents. */
export const DISCOVERY_BUDGET_SHARE = 0.35;

export interface Critique {
  scores: Record<RubricKey, number>;
  problems: { where: string; problem: string; fix: string }[];
}

/**
 * How much of each part is kept. The limits are generous on purpose and the Designer is told them (the design
 * contract): in run 2898 requirements were cut at 300 characters, and the Critic failed the design two rounds
 * running for requirements that were "cut off mid-sentence". The engine must never damage what the Critic judges.
 */
export const DOC_LIMITS = { requirements: 40, requirementChars: 600, steps: 14, lineChars: 500, perScreen: 12, research: 12, rules: 12, ruleChars: 800 } as const;

const str = (x: unknown, max = 600) => String(x ?? "").trim().slice(0, max);
const list = (x: unknown, max: number, each = 300) => (Array.isArray(x) ? x : []).map((v) => str(v, each)).filter(Boolean).slice(0, max);
const slug = (x: unknown) => str(x, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** The Designer's answer, checked and trimmed. Throws when it is not a usable set of documents. */
export function validateDocs(j: unknown): ProductDocs {
  const d = (j ?? {}) as Record<string, any>;
  const b = d.brief ?? {};
  const docs: ProductDocs = {
    brief: { who: str(b.who), problem: str(b.problem), promise: str(b.promise), notThis: list(b.notThis, 6) },
    research: (Array.isArray(d.research) ? d.research : []).map((r: any) => ({ finding: str(typeof r === "string" ? r : r?.finding, DOC_LIMITS.ruleChars), ...(r?.source ? { source: str(r.source, 300) } : {}) })).filter((r: { finding: string }) => r.finding).slice(0, DOC_LIMITS.research),
    journeys: (Array.isArray(d.journeys) ? d.journeys : []).map((x: any) => ({ moment: str(x?.moment, 120), goal: str(x?.goal, DOC_LIMITS.lineChars), steps: list(x?.steps, DOC_LIMITS.steps, DOC_LIMITS.lineChars) })).filter((x: { moment: string; steps: string[] }) => x.moment && x.steps.length).slice(0, 8),
    screens: (Array.isArray(d.screens) ? d.screens : []).map((x: any) => ({ id: slug(x?.id || x?.name), name: str(x?.name, 60), purpose: str(x?.purpose, DOC_LIMITS.lineChars), shows: list(x?.shows, DOC_LIMITS.perScreen, DOC_LIMITS.lineChars), actions: list(x?.actions, DOC_LIMITS.perScreen, DOC_LIMITS.lineChars) })).filter((x: { id: string; name: string }) => x.id && x.name).slice(0, 6),
    requirements: (Array.isArray(d.requirements) ? d.requirements : []).map((x: any, i: number) => ({ id: str(x?.id, 12) || `R${i + 1}`, text: str(typeof x === "string" ? x : x?.text, DOC_LIMITS.requirementChars), from: x?.from === "design" ? "design" as const : "person" as const, must: x?.must !== false })).filter((x: { text: string }) => x.text).slice(0, DOC_LIMITS.requirements),
    rules: (Array.isArray(d.rules) ? d.rules : []).map((x: any) => ({ name: str(typeof x === "string" ? "" : x?.name, 80), rule: str(typeof x === "string" ? x : x?.rule, DOC_LIMITS.ruleChars) })).filter((x: { rule: string }) => x.rule).slice(0, DOC_LIMITS.rules),
    assumptions: list(d.assumptions, 8),
  };
  if (!docs.brief.who || !docs.brief.promise) throw new Error("the product brief does not say who it is for and what it promises");
  if (!docs.journeys.length) throw new Error("the product documents have no journey");
  if (docs.screens.length < 2) throw new Error("the product documents need at least two screens of their own");
  if (!docs.requirements.length) throw new Error("the product documents list no requirements");
  if (new Set(docs.screens.map((s) => s.id)).size !== docs.screens.length) throw new Error("two screens share an id");
  return docs;
}

/** The Critic's answer. A missing or unreadable score counts as 1: an unjudged design has not passed. */
export function validateCritique(j: unknown): Critique {
  const c = (j ?? {}) as Record<string, any>;
  const scores = Object.fromEntries(RUBRIC.map((k) => { const n = Math.round(Number(c.scores?.[k])); return [k, Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 1]; })) as Record<RubricKey, number>;
  const problems = (Array.isArray(c.problems) ? c.problems : []).map((p: any) => ({ where: str(p?.where, 60), problem: str(typeof p === "string" ? p : p?.problem, 300), fix: str(p?.fix, 300) })).filter((p: { problem: string }) => p.problem).slice(0, 10);
  return { scores, problems };
}

export const critiquePasses = (c: Critique) => RUBRIC.every((k) => c.scores[k] >= PASS_SCORE);
export const critiqueTotal = (c: Critique) => RUBRIC.reduce((a, k) => a + c.scores[k], 0);

/** What the Critic is asked. It sees the person's words and the documents, never the Designer's reasoning. */
export function critiquePrompt(idea: string, docs: ProductDocs, round: number): string {
  return [
    `What the person asked for, in their words:\n${idea}`,
    `The product documents (round ${round}):\n${JSON.stringify(docs, null, 2)}`,
    `Score each of these from 1 (fails) to 5 (clearly true). Be hard to please: a 4 means a real user would not notice a problem.\n${RUBRIC.map((k) => `- ${k}: ${RUBRIC_TEXT[k]}`).join("\n")}`,
    "For every score under 5, list the concrete problem and the change that would fix it.",
  ].join("\n\n");
}

/** What the Designer gets on a later round: its own documents and what the Critic found. */
export function revisePrompt(idea: string, docs: ProductDocs, c: Critique, round: number): string {
  return [
    `Idea: ${idea}`,
    `Round ${round}. Your product documents so far:\n${JSON.stringify(docs, null, 2)}`,
    `A critic scored them (1 to 5, ${PASS_SCORE} passes): ${RUBRIC.map((k) => `${k} ${c.scores[k]}`).join(", ")}.`,
    `Problems to fix:\n${c.problems.map((p) => `- ${p.where ? `[${p.where}] ` : ""}${p.problem}${p.fix ? ` Fix: ${p.fix}` : ""}`).join("\n") || "- (none listed; raise every score under the bar)"}`,
    "Return the whole set of documents again in the same JSON shape, with every problem fixed. Keep what already works. Do not drop anything the person asked for.",
  ].join("\n\n");
}

/** The documents as the Planner reads them. */
export function docsForPlanner(d: ProductDocs): string {
  return [
    "Product documents (the design this plan implements; they were written and reviewed before you):",
    `Who it is for: ${d.brief.who}`,
    `Problem: ${d.brief.problem}`,
    `Promise: ${d.brief.promise}`,
    d.brief.notThis.length ? `It is not: ${d.brief.notThis.join("; ")}` : "",
    `Journeys:\n${d.journeys.map((j) => `- ${j.moment} (${j.goal}): ${j.steps.join(" → ")}`).join("\n")}`,
    `Screens, in navigation order (the first is the home):\n${d.screens.map((s) => `- ${s.id} "${s.name}": ${s.purpose} Shows: ${s.shows.join("; ")}. Actions: ${s.actions.join("; ")}.`).join("\n")}`,
    `Requirements:\n${d.requirements.map((r) => `- ${r.id}${r.must ? "" : " (nice to have)"}: ${r.text}`).join("\n")}`,
    d.rules?.length ? `The product's rules (implement them exactly; each needs a test):\n${d.rules.map((r) => `- ${r.name ? `${r.name}: ` : ""}${r.rule}`).join("\n")}` : "",
    d.research.length ? `What the research found:\n${d.research.map((r) => `- ${r.finding}${r.source ? ` (${r.source})` : ""}`).join("\n")}` : "",
    "Implement this design: one view per screen with the same id (the home screen's view has id \"dashboard\"), one flow per journey, and acceptance criteria that cover every requirement not marked nice to have.",
  ].filter(Boolean).join("\n\n");
}

/** The must-have requirements, as the plan coverage check reads them. */
export const mustRequirements = (d: ProductDocs) => d.requirements.filter((r) => r.must).map((r) => `${r.id}: ${r.text}`);

/** The documents as files in the project (docs/product/), so every later agent and the person can read them. */
export function docsFiles(idea: string, d: ProductDocs, c: Critique | null): { path: string; content: string }[] {
  const brief = [
    "# Product brief", "", `> ${idea.replace(/\n+/g, "\n> ")}`, "",
    `**Who it is for:** ${d.brief.who}`, "", `**The problem:** ${d.brief.problem}`, "", `**The promise:** ${d.brief.promise}`, "",
    ...(d.brief.notThis.length ? ["## What it is not", "", ...d.brief.notThis.map((x) => `- ${x}`), ""] : []),
    ...(d.research.length ? ["## What the research found", "", ...d.research.map((r) => `- ${r.finding}${r.source ? ` (${r.source})` : ""}`), ""] : []),
    ...(d.assumptions.length ? ["## Assumptions", "", ...d.assumptions.map((x) => `- ${x}`), ""] : []),
    ...(c ? ["## Design review", "", ...RUBRIC.map((k) => `- ${k}: ${c.scores[k]} of 5`), ...(c.problems.length ? ["", "Still open:", ...c.problems.map((p) => `- ${p.problem}`)] : []), ""] : []),
  ].join("\n");
  const journeys = ["# Journeys", "", ...d.journeys.flatMap((j) => [`## ${j.moment}`, "", `Goal: ${j.goal}`, "", ...j.steps.map((s, i) => `${i + 1}. ${s}`), ""])].join("\n");
  const screens = ["# Screens", "", "In navigation order. The first is the home.", "", ...d.screens.flatMap((s) => [`## ${s.name} (\`${s.id}\`)`, "", s.purpose, "", "Shows:", ...s.shows.map((x) => `- ${x}`), "", "Actions:", ...s.actions.map((x) => `- ${x}`), ""])].join("\n");
  const reqs = ["# Requirements", "", "| Id | Requirement | From | Must |", "|---|---|---|---|", ...d.requirements.map((r) => `| ${r.id} | ${r.text.replace(/\|/g, "/")} | ${r.from === "person" ? "the person" : "the design"} | ${r.must ? "yes" : "nice to have"} |`), "",
    ...(d.rules?.length ? ["## Rules", "", "How the product decides things. Each is exact enough to test.", "", ...d.rules.map((r) => `- ${r.name ? `**${r.name}:** ` : ""}${r.rule}`), ""] : [])].join("\n");
  return [
    { path: "docs/product/BRIEF.md", content: brief },
    { path: "docs/product/JOURNEYS.md", content: journeys },
    { path: "docs/product/SCREENS.md", content: screens },
    { path: "docs/product/REQUIREMENTS.md", content: reqs },
  ];
}
