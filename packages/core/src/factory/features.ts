import type { Plan } from "./loop.js";
import type { ProductDocs } from "./discovery.js";

/**
 * The build loop's spine: the app as a list of features, built one at a time.
 *
 * Why (docs/loop-engineering.md): asking one agent call to write a whole app is the first failure of
 * every long-running harness. It runs out half way, the next call inherits something half built, and
 * the conversation it carries grows with every file (run 2623: one Builder call carried 407k tokens
 * to write 3 files). The fix that works everywhere is the same: a list on disk, one feature per fresh
 * session, checks and a commit after each, and a progress note for the next session.
 *
 * The list is worked out by the core from the approved plan, with no agent call: the foundation
 * (model and shell), the domain logic the locked tests pin down, then one feature per screen.
 * Only the core writes features.json and PROGRESS.md; an agent's edits to them are overwritten.
 */

export interface Feature {
  id: string;
  title: string;
  /** What to build, in the plan's and the product documents' own words. */
  what: string;
  /** How the agent and the core know it is done. */
  done: string;
  state: "todo" | "built" | "empty" | "regressed" | "broken";
  /** Locked tests passing after this feature, out of all. */
  passed?: number;
  total?: number;
}

/** A full product run can afford a session per feature; a small one (a ticket at $0.60) builds in one call as before. */
export const FEATURE_LOOP_MIN_USD = 3;
/** The share of the run's budget the build loop plans with when it sizes each feature's cap. */
export const BUILD_BUDGET_SHARE = 0.55;
export const FEATURE_MIN_USD = 0.15;

export function featuresOf(plan: Plan, docs: ProductDocs | null): Feature[] {
  const out: Feature[] = [];
  const add = (title: string, what: string, done: string) => out.push({ id: `F${out.length + 1}`, title, what, done, state: "todo" });
  const views = plan.views ?? [];
  add("The app's model and shell",
    [
      `src/schema.js with the app's name and every entity (${(plan.entities ?? []).map((e) => e.name).join(", ") || "none"}), its typed fields and 3 to 6 realistic sample records, plus the flows and features lists.`,
      "package.json, index.html, web/style.css, and web/app.js that starts the app and registers every view below as a placeholder (its label, and one sentence saying what it will show).",
      views.length ? `The views, in navigation order: ${views.map((v) => `${v.id} "${v.label}"`).join(", ")}.` : "",
      // Content is part of the product: in run 2898 the seed held six invented video links and two thin records.
      docs ? `The sample records are real content, not filler: write them from the research in docs/product/BRIEF.md and the examples the person named, enough of them to show each screen doing its job for every kind of thing the person named.${docs.research.some((r) => r.source) ? " A link in a sample record is one of the pages listed in that research, copied exactly; where the research has no page for it, leave the link empty." : " Leave every link field empty: no page was researched for them."} Never write a web address from memory.` : "",
    ].filter(Boolean).join("\n"),
    "`node -e \"import('./src/schema.js').then(m=>console.log(Object.keys(m)))\"` prints the exports, `node --check web/app.js` passes, and `node server.js` starts.");
  add("The domain logic",
    `The pure functions under src/ that the locked tests in test/ import and check, and that the screens will call. The plan's interface: ${plan.interface}`,
    "Every locked test passes (`node --test`).");
  for (const v of views) {
    const s = docs?.screens.find((x) => x.id === v.id) ?? (v.id === "dashboard" ? docs?.screens[0] : undefined);
    const journeys = (docs?.journeys ?? []).filter((j) => s && j.steps.some((st) => st.toLowerCase().includes(s.name.toLowerCase())));
    add(`Screen: ${v.label}`,
      [
        `The view "${v.id}" in web/app.js, replacing its placeholder: ${v.shows}`,
        s ? `Its job: ${s.purpose}` : "",
        s?.shows.length ? `It shows: ${s.shows.join("; ")}.` : "",
        s?.actions.length ? `The person can: ${s.actions.join("; ")}. Every one of these is a real control that changes the data through the store.` : "",
        journeys.length ? `It is part of: ${journeys.map((j) => `${j.moment} (${j.steps.join(" → ")})`).join(" | ")}` : "",
        v.id === "dashboard" ? "This is the home screen, the first thing the person sees: build it around the app's main job, not around counts of records." : "",
      ].filter(Boolean).join("\n"),
      "The view draws real content from the store with no error, its controls work, `node --check web/app.js` passes, and no test that passed before fails.");
  }
  return out;
}

/** features.json as it sits in the project: the list, and which one is being built now. */
export function featuresFile(features: Feature[], now?: string): string {
  return JSON.stringify({ note: "Kept by SoftwareFactory. One feature is built per session; do not edit this file.", features: features.map((f) => ({ id: f.id, title: f.title, state: f.id === now ? "now" : f.state, ...(f.total != null ? { testsPassing: `${f.passed}/${f.total}` } : {}), done: f.done })) }, null, 2) + "\n";
}

export function progressEntry(f: Feature, said: string, files: string[]): string {
  return [`## ${f.id} ${f.title}: ${f.state}${f.total != null ? ` (locked tests passing: ${f.passed}/${f.total})` : ""}`, "", files.length ? `Files: ${files.slice(0, 20).join(", ")}` : "No files changed.", "", said.trim().split("\n").slice(-8).join("\n").slice(0, 900), ""].join("\n");
}

/** What one feature session is asked: its one feature, where the spine is, and the rules of a shared build. */
export function featurePrompt(plan: Plan, features: Feature[], f: Feature, hasDocs: boolean, retry?: string): string {
  const i = features.indexOf(f);
  return [
    `You are building "${plan.name}" one feature at a time. This call builds ONE feature (${f.id}, number ${i + 1} of ${features.length}); other calls, each starting fresh like you, build the rest.`,
    `Read first, in the project folder: SPEC.md (the approved plan)${hasDocs ? ", docs/product/ (the product design: brief, journeys, screens, requirements)" : ""}, features.json (the whole list; yours is marked "now") and PROGRESS.md (what earlier calls built and what they want you to know). Then read only the code your feature touches.`,
    `Your feature, ${f.id}: ${f.title}\n${f.what}`,
    `Done means: ${f.done}`,
    [
      "Rules:",
      "- Build only this feature, completely. Do not start the others; leave their placeholders as they are.",
      "- Keep everything that already works working. Tests for features nobody built yet may fail; no test that passed before your call may fail after it.",
      "- Do not edit features.json or PROGRESS.md: the core keeps them.",
      "- End your answer with two or three lines for the next call: what you built, and anything it must know (a helper to reuse, a decision you made).",
    ].join("\n"),
    retry ? `Your last attempt at this feature was not accepted:\n${retry}\nFix that first.` : "",
  ].filter(Boolean).join("\n\n");
}
