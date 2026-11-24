/** The engine's shapes and the pure helpers around a run (loop.ts re-exports what was public). */
import type { EventLog } from "../events.js";
import { type AgentRuntime } from "../runtime.js";
import { type Critique, type ProductDocs } from "./discovery.js";
import { type Feature } from "./features.js";
import { type Evaluation } from "./evaluate.js";
import { type CouncilBrief } from "./council.js";
import { parseJsonBlock } from "./workspace.js";
import type { Factory } from "./loop.js";
import type { Run } from "./run.js";

/**
 * The factory loop: one idea becomes a tested git repo.
 *
 *   intake → council (3 to 6 seats, skipped for small jobs) → plan → [gate A: approve plan]
 *     → tests (locked) → build → test ⇄ fix → review (⇄ fix once) → [gate B: accept build] → ship
 *
 * Workers come from a CrewSource (the Agent Bay), asked at the moment each
 * station needs them, so an edit in the Bay applies to the next call.
 *
 * Each station is a loop with a goal, a worker, a verifier, exit criteria and
 * a budget; its sixth field, its visual, is enforced by visualCheck before the
 * station may pass. All state is written to the event log; the Bridge draws
 * from it.
 */
export type StationId = "intake" | "council" | "discover" | "plan" | "gateA" | "tests" | "build" | "test" | "fix" | "review" | "evaluate" | "gateB" | "ship";
export type GateId = "gateA" | "gateB" | "escalation";

export interface Plan {
  name: string;
  slug: string;
  summary: string;
  interface: string;
  /** The screen (visualizeEverything): what the page shows and does. Plans from before the GUI default have none. */
  ui?: string;
  /** The CLI usage line, or "" when there is no command line. */
  cli?: string;
  /** Ready-to-run inputs for the CLI; written to run.json for the Run tab. */
  examples?: { label: string; args: string; input?: string }[];
  /**
   * A real program on the app kit (the Brain's "real-programs"): every plan written since has it.
   * Plans from before have none and are held only to the page check.
   */
  app?: boolean;
  /** What the app manages: each entity gets full CRUD screens from the kit. */
  entities?: { name: string; label?: string; fields: { name: string; type?: string; required?: boolean; options?: string[]; to?: string }[]; seed?: string }[];
  flows?: { name: string; steps: string[] }[];
  /** The app's own views (a dashboard, a board...), beside the kit's screens. */
  views?: { id: string; label: string; shows: string }[];
  acceptance: string[];
  tasks: { id: string; title: string; dependsOn: string[] }[];
  files: string[];
  /**
   * A change to an existing codebase (factory/reporun.ts), not an app on the kit: its features, each built in a
   * session of its own on a branch, how the change is tested in the repo's own setup, and what could break.
   */
  repo?: boolean;
  features?: { id: string; title: string; what: string; files: string[]; done: string }[];
  testing?: string;
  risks?: string[];
  /**
   * SF-64: the plan was more than the run's money builds, so this run builds the features in front and the
   * rest (`later`) wait for the next slice, a ticket of their own.
   */
  slice?: { n: number; of: number; fit: import("./features.js").BuildFit; later: { id: string; title: string; what: string; files: string[]; done: string }[] };
}

export interface RunOptions {
  /** Hard cap for the whole run across every loop, USD. */
  maxUsd?: number;
  maxFixRounds?: number;
  /** Approve both gates automatically (tests and headless runs). Escalations still stop the run. */
  autoApprove?: boolean;
  /** With autoApprove: how many failed-station or fix escalations to retry automatically. Budget escalations are never automatic. */
  autoRetries?: number;
  /** Override a model by agent id or station, for example { builder: "haiku" } or { build: "haiku" }. */
  models?: Record<string, string>;
  /** The Council: "auto" skips it for small jobs (the default), "always" or "never". */
  council?: "auto" | "always" | "never";
  /** The Review station after the tests pass (default on). */
  review?: boolean;
  /** The project this run belongs to. Without one, the run becomes a project of its own. */
  projectId?: number;
  /** The flow to follow, by id (flows/library.ts). Default: the built-in flow of the run's kind. */
  flow?: string;
}

/**
 * A run on top of a project the factory already shipped: same folder, same data, same locked tests.
 * "screen" turns a script into an app; "feature" adds what the person asks to the shipped app.
 */
export interface ScreenRun { kind: "screen" | "feature"; baseRun: number; baseSha: string; tag: string }

export interface ReviewResult { verdict: "pass" | "fix"; findings: { severity: "high" | "low"; text: string }[]; criteria?: { text: string; pass: boolean; evidence: string }[] }

export function parseReview(text: string): ReviewResult {
  const j = parseJsonBlock<Partial<ReviewResult>>(text);
  if (!j || typeof j !== "object" || !Array.isArray(j.findings)) throw new Error("The review has no findings list");
  const findings = j.findings.map((f: any) => ({ severity: f?.severity === "high" ? "high" as const : "low" as const, text: String(f?.text ?? "").trim().slice(0, 300) })).filter((f) => f.text).slice(0, 5);
  // The done-claim check (H8): each acceptance criterion checked by running the product, with its evidence.
  const criteria = (Array.isArray((j as any).criteria) ? (j as any).criteria : []).filter((c: any) => c && c.text).slice(0, 20)
    .map((c: any) => ({ text: String(c.text).slice(0, 300), pass: c.pass === true, evidence: String(c.evidence ?? "").slice(0, 400) }));
  // A criterion the product does not meet is a high finding: it goes back to the Fixer with its evidence.
  for (const c of criteria.filter((x: { pass: boolean }) => !x.pass)) findings.push({ severity: "high", text: `Acceptance criterion not met: ${c.text}${c.evidence ? ` (${c.evidence})` : ""}`.slice(0, 500) });
  // "fix" needs a high finding to act on; a bare "fix" is read as pass with notes.
  return { verdict: findings.some((f) => f.severity === "high") && (j.verdict === "fix" || criteria.some((c: { pass: boolean }) => !c.pass)) ? "fix" : "pass", findings, ...(criteria.length ? { criteria } : {}) };
}

export interface GateDecision { approve: boolean; note?: string; by?: string }

/** What a waiting gate tells the Bridge besides its question: the button's word, and for a failed step, which one and how often. */
export interface GateOpts { neverAuto?: boolean; action?: string; kind?: "retry" | "council" | "rounds" | "budget"; station?: StationId; attempt?: number; error?: string; same?: boolean; /** SF-64: the plan gate of a plan sliced to fit the money. */ fit?: Record<string, unknown>; /** SF-65: what a Retry changes so it does not fail the same way. */ retryWith?: Record<string, unknown> }

export class StopRun extends Error {}

/** The options a run works with, once the defaults are filled in. */
export type RunSettings = Required<Omit<RunOptions, "models" | "projectId" | "flow">> & { models: Record<string, string> };
/** How a run of another kind is made: from its started event's payload, for a start and for a resume. */
export type RunMaker = (x: { factory: Factory; log: EventLog; runtime: AgentRuntime; id: number; idea: string; o: RunSettings; started: Record<string, unknown> }) => Run;


export interface Pending { gate: GateId; resolve: (d: GateDecision) => void; /** SF-115: ends the wait with StopRun. */ stop?: (e: Error) => void }


/**
 * The API's answer when a Build would repeat a run: 409 with the run it repeats, so the Bridge can
 * offer "Show run #N" or "Build again anyway" (the same request with { again: true }).
 */
export function duplicateReply(factory: Pick<Factory, "duplicateOf">, idea: string, again: unknown): [number, Record<string, unknown>] | null {
  if (again === true) return null;
  const d = factory.duplicateOf(idea);
  if (!d) return null;
  const what = d.state === "running" ? "is already building it" : d.state === "stopped" ? "already started it and can resume" : "already built it today";
  return [409, { error: `Run #${d.run} ${what}. Open that run, or build again anyway.`, duplicateOf: d.run, state: d.state, projectId: d.projectId }];
}

/** An idea as the duplicate check compares it: case, spacing and closing punctuation do not matter. */
export function normIdea(idea: string): string {
  return idea.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!?\s]+$/, "");
}

/**
 * The done-claim check (H8), added to the Reviewer's job when it has the workbench: "the tests pass" is not
 * "it works". Each acceptance criterion is checked against the running product, with what was seen.
 */
export const VERIFY_CONTRACT = [
  "You also verify the product, not only read it. You have a shell in the project folder (read and run only: do not change files).",
  "For EACH acceptance criterion below, check it by running code: call the functions with node (node --input-type=module -e \"import('./src/x.js').then(...)\"), and for the app start it with `node server.js` in the background on PORT=0, read the port from its \"Ready on\" line and fetch its pages and /api/_db with node, then stop it.",
  "Stop every process you start (a server you ran in the background) before you answer, and make the JSON your very last message: only the last message is read.",
  "Add to your JSON a \"criteria\" list, one entry per criterion in order: {\"text\": \"the criterion\", \"pass\": true|false, \"evidence\": \"what you ran and what you saw, short\"}. pass is true only when you saw it work.",
].join("\n");

/** One step up the model ladder, for a fix round that has to think harder (H6). */
/** The least a model needs left in the run's budget to do a real fix round. */
export function modelFloorUsd(model: string): number {
  return /fable/i.test(model) ? 0.8 : /opus/i.test(model) ? 0.4 : /sonnet/i.test(model) ? 0.15 : 0.02;
}

export function strongerModel(model: string): string {
  if (/haiku/i.test(model)) return "sonnet";
  if (/sonnet/i.test(model)) return "opus";
  // Fable is the top step, for hard debugging only: a fix already deepened to Opus that still fails (Assaf, 24 Nov 2026).
  if (/opus/i.test(model)) return "fable";
  return model;
}

export function stationName(id: StationId) {
  return ({ intake: "Intake", council: "Council", discover: "Discovery", plan: "Plan", gateA: "Plan gate", tests: "Acceptance tests", build: "Build", test: "Test", fix: "Fix", review: "Review", evaluate: "Product judge", gateB: "Build gate", ship: "Ship" } as const)[id];
}

/** A plan may have as many views as a design may have screens (it was 4: run 2898's plan lost two of six designed screens to the cut). */
export const MAX_VIEWS = 6;

/**
 * Every designed screen is a view of the plan. The core checks this itself and adds what the Planner left
 * out: a screen the person saw in the design must not depend on an agent remembering it.
 */
export function withDesignedScreens(plan: Plan, docs: ProductDocs): { plan: Plan; added: string[]; replaced: string[] } {
  const key = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const views = [...(plan.views ?? [])];
  const added: string[] = [];
  const replaced: string[] = [];
  const builds = (v: { id: string; label: string }, s: ProductDocs["screens"][number], i: number) => key(v.id) === key(s.id) || key(v.label) === key(s.name) || (i === 0 && v.id === "dashboard");
  docs.screens.forEach((s, i) => {
    if (views.some((v) => builds(v, s, i))) return;
    if (views.length >= MAX_VIEWS) {
      // Run 4004: the plan was full (6 views), one of them the Planner's own, and the designed Skill tree
      // had no room. A designed screen comes before a view nobody designed: the last such view makes way.
      const own = views.map((v, at) => ({ v, at })).filter(({ v }) => v.id !== "dashboard" && !docs.screens.some((x, k) => builds(v, x, k))).at(-1);
      if (!own) return;
      views.splice(own.at, 1);
      replaced.push(own.v.label);
    }
    views.splice(Math.min(i, views.length), 0, { id: i === 0 ? "dashboard" : s.id, label: s.name, shows: [s.purpose, s.shows.length ? `Shows: ${s.shows.join("; ")}.` : "", s.actions.length ? `Actions: ${s.actions.join("; ")}.` : ""].filter(Boolean).join(" ") });
    added.push(s.name);
  });
  return { plan: added.length ? { ...plan, views } : plan, added, replaced };
}

/**
 * A name the app kit accepts: lowerCamelCase, letters and digits. Run 3185: the Planner named fields in
 * snake_case (band_min), the kit refuses those, the app could not start, and every feature still "built". The
 * plan is put right once, here, so the Tester and the Builder never see a name the kit will refuse.
 */
/** What the Tester is told for an app: journeys through the kit's data layer, one per action criterion. */
export function journeyTestRule(plan: Plan): string {
  const ents = (plan.entities ?? []).map((e) => e.name);
  return [
    "This is an app, so besides the logic tests write test/journeys.test.js: what a person does, through the app's own data layer, exactly as the running app does it.",
    "- Import the app's model with `import * as schema from \"../src/schema.js\"` and the kit's data layer with `import { seedDb, createRecord, updateRecord, deleteRecord, query } from \"../web/kit/db.js\"` (it exists already; the server runs these same functions, and a record they refuse is refused in the app too).",
    "- Start each journey from `seedDb(schema)`, the sample records the person sees on first open, and do the person's action with createRecord / updateRecord and the src/ functions the screens will call. Then assert what the person would see in the data afterwards.",
    `- One journey per acceptance criterion that is about something the person does (adds, edits, refreshes, plans, picks, logs), named after the criterion. Where the criterion or the spec gives numbers, examples or limits (a cap, a ladder, a score, "never twice in a day"), assert exactly those values: a journey that only checks that something happened lets a wrong rule pass.${ents.length ? ` The entities are ${ents.join(", ")}.` : ""}`,
    "- Also one test that every sample record in seedDb(schema) passes the kit's validation (createRecord of a copy of it does not throw), and that every kind of thing the person named has sample records.",
  ].join("\n");
}

export function kitName(x: unknown): string {
  const parts = String(x ?? "").trim().split(/[^A-Za-z0-9]+/).filter(Boolean);
  const s = parts.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w[0].toLowerCase() + w.slice(1))).join("").replace(/^[0-9]+/, "");
  return s || "field";
}

/** What one Reviewer call may spend: its own budget on a small run, up to five times that on a product run. */
export function reviewCapUsd(agentUsd: number, runUsd: number): number {
  return Number((agentUsd * Math.min(5, Math.max(1, runUsd / 2))).toFixed(3));
}

export function validatePlan(p: Plan): Plan {
  if (!p || typeof p !== "object") throw new Error("The plan is not an object");
  for (const k of ["name", "slug", "summary", "interface"] as const) if (typeof p[k] !== "string" || !p[k].trim()) throw new Error(`The plan is missing "${k}"`);
  if (!Array.isArray(p.acceptance) || !p.acceptance.length) throw new Error("The plan has no acceptance criteria");
  if (!Array.isArray(p.tasks) || !p.tasks.length) throw new Error("The plan has no tasks");
  const slug = p.slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
  const ids = new Set(p.tasks.map((t) => String(t.id)));
  const examples = (Array.isArray(p.examples) ? p.examples : []).filter((x: any) => x && typeof x === "object" && (typeof x.args === "string" || Array.isArray(x.args)))
    .map((x: any) => ({ label: String(x.label ?? x.args).slice(0, 80), args: Array.isArray(x.args) ? x.args.map(String).join(" ") : String(x.args), ...(x.input ? { input: String(x.input) } : {}) })).slice(0, 5);
  return {
    ...p, slug, files: Array.isArray(p.files) ? p.files.map(String) : [],
    // A plan always has a screen (visualizeEverything); a planner that forgot gets the default one.
    ui: typeof p.ui === "string" && p.ui.trim() ? p.ui.trim() : defaultUi(p),
    cli: typeof p.cli === "string" ? p.cli.trim() : "",
    examples,
    // Every new plan is a real program on the app kit (the Brain's "real-programs").
    app: true,
    entities: (Array.isArray(p.entities) ? p.entities : []).filter((e: any) => e && typeof e.name === "string").slice(0, 8).map((e: any) => ({
      name: kitName(e.name), ...(e.label ? { label: String(e.label) } : {}),
      fields: (Array.isArray(e.fields) ? e.fields : []).filter((f: any) => f && typeof f.name === "string").map((f: any) => ({ name: kitName(f.name), type: String(f.type ?? "text"), ...(f.required ? { required: true } : {}), ...(Array.isArray(f.options) ? { options: f.options.map(String) } : {}), ...(f.to ? { to: kitName(f.to) } : {}) })),
      ...(e.seed ? { seed: String(e.seed).slice(0, 300) } : {}),
    })),
    flows: (Array.isArray(p.flows) ? p.flows : []).filter((x: any) => x && x.name).slice(0, 6).map((x: any) => ({ name: String(x.name), steps: (Array.isArray(x.steps) ? x.steps : []).map(String).slice(0, 10) })),
    views: (Array.isArray(p.views) ? p.views : []).filter((x: any) => x && (x.id || x.label)).slice(0, MAX_VIEWS).map((x: any) => ({ id: String(x.id ?? x.label).toLowerCase().replace(/[^a-z0-9-]+/g, "-"), label: String(x.label ?? x.id), shows: String(x.shows ?? "") })),
    tasks: p.tasks.map((t) => ({ id: String(t.id), title: String(t.title ?? t.id), dependsOn: (Array.isArray(t.dependsOn) ? t.dependsOn : []).map(String).filter((d) => ids.has(d)) })),
  };
}

/** The screen a plan gets when nobody described one. */
export function defaultUi(p: Pick<Plan, "summary" | "interface">): string {
  return `An app for: ${p.summary.trim()} It opens with sample records already in it, lets the person create, edit and delete everything it keeps through forms, runs the core (${p.interface.trim().slice(0, 300)}) from a view of its own and draws the results visually (a table, bars or a preview), with any error shown on the screen.`;
}

export function specMarkdown(idea: string, p: Plan): string {
  return [
    `# ${p.name}`, "", `> ${idea}`, "", p.summary, "",
    "## Interface", "", p.interface, "",
    ...(p.ui ? [p.app ? "## The app" : "## Screen", "", p.ui, "", p.app ? "Open it from the project's Run tab in SoftwareFactory and press Start: no arguments, no files to write. Data is kept in `data/db.json`." : "Open it from the project's Run tab in SoftwareFactory (it serves the folder and shows `index.html`).", ""] : []),
    ...(p.entities?.length ? ["## What it manages", "", ...p.entities.map((e) => `- **${e.label ?? e.name}**: ${e.fields.map((f) => `${f.name} (${f.type ?? "text"}${f.to ? ` → ${f.to}` : ""}${f.required ? ", required" : ""})`).join(", ")}. Create, edit, delete and search them in the app.`), ""] : []),
    ...(p.flows?.length ? ["## Flows", "", ...p.flows.map((f) => `- **${f.name}**: ${f.steps.join(" → ")}`), ""] : []),
    ...(p.views?.length ? ["## Views", "", ...p.views.map((v) => `- **${v.label}**: ${v.shows}`), ""] : []),
    ...(p.cli ? ["## Command line", "", "```", p.cli, "```", ""] : []),
    "## Acceptance criteria", "", ...p.acceptance.map((a, i) => `${i + 1}. ${a}`), "",
    "## Tasks", "", ...p.tasks.map((t) => `- **${t.id}** ${t.title}${t.dependsOn.length ? ` (after ${t.dependsOn.join(", ")})` : ""}`), "",
    "Built by SoftwareFactory. The tests in `test/` were written from this spec before the code and were locked.", "",
  ].join("\n");
}

/** A next version's design is a change to documents that already passed: one revision is enough. */
export const NEXT_VERSION_ROUNDS = 2;

/**
 * The design a shipped app carries: the product documents of the run that shipped it, or of the nearest
 * version before it that has any (a version built before designs travelled has none of its own), and the
 * idea its first version was built from.
 */
export function shippedDesign(log: EventLog, run: number): { docs: ProductDocs | null; idea: string } {
  let docs: ProductDocs | null = null;
  let idea = "";
  for (let id: number | undefined = run, n = 0; id != null && n < 50; n++) {
    const started = log.get(id);
    if (started?.type !== "factory.run.started") break;
    const p = started.payload as { idea?: string; screen?: { baseRun?: number } };
    docs ??= restoreState(log, id).docs;
    idea = String(p.idea ?? "");
    id = p.screen?.baseRun;
  }
  return { docs, idea };
}

/** How many times one run is resumed on its own before it waits for the Resume button. */
export const MAX_AUTO_RESUMES = 3;

/** Runs whose newest lifecycle event is a start or a resume, not a finish. */
export function unfinishedRuns(log: EventLog): number[] {
  const open = new Set<number>();
  const life = [...log.list({ type: "factory.run.started", limit: 1e7 }), ...log.list({ type: "factory.run.resumed", limit: 1e7 }), ...log.list({ type: "factory.run.finished", limit: 1e7 })].sort((a, b) => a.id - b.id);
  for (const e of life) {
    if (e.type === "factory.run.started") open.add(e.id);
    else if (e.type === "factory.run.resumed") open.add((e.payload as { run: number }).run);
    else if (e.type === "factory.run.finished") open.delete((e.payload as { run: number }).run);
  }
  return [...open];
}

export interface RestoredState {
  /** Milestones already reached: intake, council, planWritten, plan, tests, build, reviewed, accepted. */
  done: Set<string>;
  /** The station a resume starts at. */
  from: StationId;
  spent: number;
  calls: number;
  maxUsd?: number;
  fixRounds: number;
  plan?: Plan;
  dir?: string;
  lockedHash?: string;
  brief: CouncilBrief | null;
  docs: ProductDocs | null;
  docsCritique: Critique | null;
  review: ReviewResult | null;
  /** The product judge's last verdict, so the build gate still says what is open after a restart. */
  evaluation: Evaluation | null;
  /** The note of a build-gate send-back the run had not acted on yet when the app closed (run 4004). */
  sentBack: string | null;
  /** Per screen feature, the designed items its last look did not find. */
  screenOpen: Record<string, string[]>;
}

/**
 * Where a run stands, from the event log alone (the source of truth): which
 * stations it completed, what it spent, its plan, repo and locked tests.
 */
/** What the Reviewer left failing, as one repair feature: the criteria it ran and saw fail, and its serious findings. */
export function reviewRepair(r: ReviewResult): Feature | null {
  const failing = (r.criteria ?? []).filter((c) => !c.pass);
  // A failing criterion is also listed as a finding (parseReview); it is said once.
  const high = r.findings.filter((f) => f.severity === "high" && !/^Acceptance criterion not met/.test(f.text));
  if (!failing.length && !high.length) return null;
  return {
    id: "J0", title: "Judge: what the Reviewer proved still broken", state: "todo",
    what: ["The Reviewer ran the code and these still fail. Fix each one in src/ and on the screen that shows it:",
      ...failing.map((c) => `- Criterion: ${c.text}${c.evidence ? `\n  What it saw: ${c.evidence}` : ""}`),
      ...high.map((f) => `- ${f.text}`)].join("\n"),
    done: "Each criterion above passes when run, each finding is gone, and every test still passes.",
  };
}

/**
 * A review after its failing criteria were run again: the criteria that passed before stay, each one that
 * failed takes its new result (by position when the Reviewer answered for each, else by its text), and the
 * verdict is "fix" only while something is still failing.
 */
export function mergeRecheck(before: ReviewResult, again: ReviewResult): ReviewResult {
  const failing = (before.criteria ?? []).filter((c) => !c.pass);
  const got = again.criteria ?? [];
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
  const now = new Map(failing.map((c, i) => [c, got.length === failing.length ? got[i] : got.find((g) => norm(g.text) === norm(c.text))] as const));
  const criteria = (before.criteria ?? []).map((c) => { const n = now.get(c); return n ? { text: c.text, pass: n.pass, evidence: n.evidence } : c; });
  const findings = [
    ...before.findings.filter((f) => !/^Acceptance criterion not met/.test(f.text)),
    ...criteria.filter((c) => !c.pass).map((c) => ({ severity: "high" as const, text: `Acceptance criterion not met: ${c.text}${c.evidence ? ` (${c.evidence})` : ""}`.slice(0, 500) })),
  ];
  return { verdict: criteria.some((c) => !c.pass) ? "fix" : "pass", findings, ...(criteria.length ? { criteria } : {}) };
}

/** The question of an escalation (a Retry, more budget) a run was still waiting on, or null. */
export function waitingEscalation(log: EventLog, run: number): string | null {
  const g = log.list({ type: "factory.gate", sinceId: run - 1, limit: 1e6 }).map((e) => e.payload as { run: number; gate: string; state: string; question?: string }).filter((p) => p.run === run).at(-1);
  return g && g.gate === "escalation" && g.state === "waiting" ? String(g.question ?? "a question") : null;
}

export function restoreState(log: EventLog, run: number): RestoredState {
  const evs = log.list({ sinceId: run - 1, limit: 1e7 }).filter((e) => { const p = e.payload as { run?: number; factoryRun?: number }; return p?.run === run || p?.factoryRun === run; });
  const of = (type: string) => evs.filter((e) => e.type === type).map((e) => e.payload as any);
  const stations = of("factory.station");
  const passed = (st: StationId) => stations.some((p) => p.station === st && (p.state === "pass" || p.state === "skipped"));
  const done = new Set<string>();
  const plan = of("factory.plan").at(-1);
  const gates = of("factory.gate");
  const lastPlanAt = evs.map((e) => e.type).lastIndexOf("factory.plan");
  if (passed("intake")) done.add("intake");
  const council = stations.filter((p) => p.station === "council").at(-1);
  const brief = (of("factory.council").at(-1)?.brief ?? null) as CouncilBrief | null;
  if (council?.state === "skipped" || plan || (council?.state === "pass" && brief && brief.outcome !== "drop")) done.add("council");
  // Discovery is done when it was skipped, or when it settled on documents (it passed, or said why it stopped), or a plan exists.
  const disc = of("factory.discovery");
  const settled = disc.filter((d) => d.pass || d.settled).at(-1);
  if (plan || settled || stations.some((p) => p.station === "discover" && p.state === "skipped")) done.add("discover");
  if (plan) done.add("planWritten");
  if (lastPlanAt >= 0 && evs.slice(lastPlanAt).some((e) => e.type === "factory.gate" && (e.payload as any).gate === "gateA" && (e.payload as any).state === "approved")) done.add("plan");
  const locked = of("factory.tests.locked").at(-1);
  if (locked && done.has("plan")) done.add("tests");
  if (done.has("tests") && stations.some((p) => p.station === "build" && p.state !== "active" && p.state !== "fail" && p.state !== "incomplete") && of("factory.files").some((p) => p.station === "build")) done.add("build");
  const gateB = gates.filter((g) => g.gate === "gateB");
  if (done.has("build") && gateB.length) done.add("reviewed");
  if (done.has("reviewed") && gateB.at(-1)?.state === "approved") done.add("accepted");
  const order: [string, StationId][] = [["intake", "intake"], ["council", "council"], ["discover", "discover"], ["planWritten", "plan"], ["plan", "gateA"], ["tests", "tests"], ["build", "build"], ["reviewed", "test"], ["accepted", "gateB"]];
  const from = order.find(([k]) => !done.has(k))?.[1] ?? "ship";
  const completed = [...of("agent.run.completed"), ...of("agent.run.failed")];
  const reviews = of("factory.review");
  const budget = of("factory.budget").at(-1);
  return {
    done, from,
    spent: completed.reduce((a, p) => a + (Number(p.costUsd) || 0), 0),
    calls: of("agent.run.started").length,
    maxUsd: budget?.maxUsd,
    fixRounds: Math.max(0, ...stations.filter((p) => p.station === "fix" && p.round).map((p) => Number(p.round))),
    plan: plan?.plan, dir: plan?.dir, lockedHash: done.has("tests") ? locked?.hash : undefined,
    brief, docs: (settled ?? disc.at(-1))?.docs ?? null, docsCritique: (settled ?? disc.at(-1))?.critique ?? null,
    review: reviews.length ? { verdict: reviews.at(-1).verdict, findings: reviews.at(-1).findings ?? [], ...(Array.isArray(reviews.at(-1).criteria) ? { criteria: reviews.at(-1).criteria } : {}) } : null,
    evaluation: (() => { const e = of("factory.evaluation").filter((x) => !x.skipped).at(-1); return e ? { requirements: e.requirements ?? [], scores: e.scores ?? {}, problems: e.problems ?? [] } as Evaluation : null; })(),
    // Run 4004: the person sent the build back with a note, the app updated 30 seconds later, and the
    // resume asked the build gate again as if nothing had been said. An unanswered send-back is carried out.
    sentBack: (() => { const g = gateB.at(-1); return g && g.state === "rejected" && g.note ? String(g.note) : null; })(),
    screenOpen: (() => { const m: Record<string, string[]> = {}; for (const x of of("factory.screen.look")) { if (!x.feature || !Array.isArray(x.open)) continue; if (x.open.length) m[String(x.feature)] = x.open.map(String); else delete m[String(x.feature)]; } return m; })(),
  };
}
