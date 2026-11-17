/**
 * Flows: the engine's work as data (phase 1 of the SF behavior brief).
 *
 * A flow is a stored definition of how one kind of work travels: its steps in order, which steps are loops
 * and what ends them, where it stops for you, and which crew slot works each step. The engine reads the
 * flow a run started with and carries out its steps in that order (Run.go in factory/loop.ts); the canvas
 * (the factory floor and the project's track) draws the same definition. Nothing about a step's inside is
 * code-free yet: each step names an engine action, and the action is the code that does the work.
 *
 * Today's engine is the built-in "New project" flow, and imported repositories run the built-in
 * "Change in a repo" flow. Both carry out exactly what the fixed pipeline did before flows existed.
 */

/** A step does one thing; a loop repeats until its goal is met or its limit is reached; a gate waits for you. */
export type FlowStepKind = "step" | "loop" | "gate";

/**
 * What the engine can do for a step. Each action is code in the engine (Run in factory/loop.ts, and RepoRun
 * for a repo), and appears at most once in a flow.
 */
export const ACTIONS = {
  intake: { label: "Take in the ask", needs: [], required: true },
  council: { label: "Council of seats", needs: ["intake"], required: false },
  discover: { label: "Design loop", needs: ["intake"], required: false },
  plan: { label: "Plan, with your OK", needs: ["intake"], required: true },
  tests: { label: "Tests", needs: ["plan"], required: true },
  build: { label: "Build", needs: ["tests"], required: true },
  testFix: { label: "Test and fix loop", needs: ["build"], required: true },
  review: { label: "Review", needs: ["testFix"], required: false },
  evaluate: { label: "Product judge loop", needs: ["testFix"], required: false },
  accept: { label: "Your OK on the build", needs: ["testFix"], required: true },
  ship: { label: "Ship", needs: ["accept"], required: true },
} as const satisfies Record<string, { label: string; needs: string[]; required: boolean }>;
export type ActionId = keyof typeof ACTIONS;

/** Crew slots a step may name (the Agent Bay's stations). Kept in step with SLOTS in bay/agentfile.ts. */
export const STEP_AGENTS = ["council", "design", "critique", "plan", "tests", "build", "review", "evaluate", "fix"] as const;

/** Milestones a resume reads from the log (restoreState): a step whose milestone is reached is not done again. */
export const RESUME_KEYS = ["intake", "council", "discover", "plan", "tests", "build", "reviewed", "accepted"] as const;

export interface FlowLoop {
  /** What the loop is for, measurably. */
  goal: string;
  /** Who judges each round: never the agent that did the work. */
  observer: string;
  /** When it passes. */
  passes: string;
  /** When it stops anyway. */
  stops: string;
  /** The most rounds it may take. The engine reads it for the council, design and judge loops. */
  maxRounds?: number;
}

export interface FlowStep {
  /** Unique in the flow. For the built-in flows it is also the engine station it lights. */
  id: string;
  label: string;
  /** What it does, in a few words (the canvas's second line). */
  sub: string;
  kind: FlowStepKind;
  /** The engine action that carries it out. A step carried out inside another step's loop has none. */
  action?: ActionId;
  /** The crew slots that work it, first the main one. Empty: the core does it with no agent. */
  agents: string[];
  /** The engine stations whose state lights this step on the canvas (default: its id). */
  stations?: string[];
  /** The milestone that, once reached, skips this step when a stopped run is picked up again. */
  resumeKey?: string;
  /** Carried out inside this other step's loop (a gate or a worker inside a loop): drawn, not run on its own. */
  within?: string;
  loop?: FlowLoop;
  /** For a gate: what it asks you, and when it answers itself. */
  gate?: { asks: string; auto: string };
  /** When the step is skipped although it is in the flow. */
  skippedWhen?: string;
  /** The stop on the project's track this step belongs to (several steps can share one stop). */
  stop: string;
  /** Where the canvas draws it. */
  at: { x: number; y: number };
}

export interface FlowEdge {
  from: string;
  to: string;
  /** next: the usual way on. back: a loop going round again. branch: a way taken only sometimes. */
  kind: "next" | "back" | "branch";
  label?: string;
  /** Which side of each box the line leaves and enters (canvas handles). */
  fromSide?: string;
  toSide?: string;
}

export interface FlowDef {
  /** Stable id: "new-project", "repo-change", or one of yours. */
  id: string;
  name: string;
  /** What kind of work it is for, in one sentence. */
  purpose: string;
  /** Raised by one on every save; a run keeps the version it started with. */
  version: number;
  /** Still exactly as SoftwareFactory ships it. */
  builtIn: boolean;
  steps: FlowStep[];
  edges: FlowEdge[];
}

const X = [0, 190, 380, 570, 760];

/** The steps both built-in flows share, in the order the engine works them. */
function engineSteps(repo: boolean): FlowStep[] {
  return [
    {
      id: "intake", label: repo ? "The ask" : "One-line idea", sub: repo ? "clone and read the repo" : "saved as a note", kind: "step", action: "intake", agents: [],
      resumeKey: "intake", stop: "idea", at: { x: X[0], y: 0 },
    },
    {
      id: "council", label: "Council", sub: "up to 6 seats · big ideas", kind: "loop", action: "council", agents: ["council"], resumeKey: "council",
      skippedWhen: "a small job, or the council is turned off for the run",
      loop: { goal: "Decide to build, reshape or drop before money goes into design", observer: "Each seat reads the others' takes; plain code merges them", passes: "A majority votes build or reshape", stops: "After the round limit. A majority drop asks you once", maxRounds: 2 },
      stop: "council", at: { x: X[1], y: -95 },
    },
    {
      id: "discover", label: "Product design", sub: "Designer ⇄ Critic loop", kind: "loop", action: "discover", agents: ["design", "critique"], resumeKey: "discover",
      skippedWhen: repo ? "never in a repo: the change is designed against the product as it is" : "the next version of a shipped app keeps its design",
      loop: { goal: "Product documents a person would recognise as what they asked for", observer: "The Critic, who sees only your words and the documents", passes: "All five scores reach the bar", stops: "After the round limit, or when design used 35% of the budget: the best documents go on", maxRounds: 3 },
      stop: "design", at: { x: X[1], y: 0 },
    },
    {
      id: "plan", label: "Spec and plan", sub: "Planner", kind: "loop", action: "plan", agents: ["plan"], resumeKey: "plan",
      loop: { goal: "A plan that covers everything asked for", observer: "A second agent lists what the plan leaves out; then you", passes: "You approve it at your OK", stops: "You stop it" },
      stop: "plan", at: { x: X[2], y: 0 },
    },
    {
      id: "gateA", label: "Your OK: plan", sub: "one tap", kind: "gate", within: "plan", agents: [],
      gate: { asks: "Approve the spec and plan, or send it back with what to change", auto: "Approves itself on runs started with auto-approve (headless runs, tickets the crew starts)" },
      stop: "ok1", at: { x: X[3], y: 0 },
    },
    {
      id: "tests", label: repo ? "The repo's tests" : "Acceptance tests", sub: repo ? "run before any change" : "Tester, then locked", kind: "step", action: "tests", agents: repo ? [] : ["tests"], resumeKey: "tests",
      stop: "build", at: { x: X[0], y: 130 },
    },
    {
      id: "build", label: "Build", sub: "Builder", kind: "loop", action: "build", agents: ["build"], resumeKey: "build",
      loop: { goal: "Every planned feature built without breaking a passing test", observer: "The core: the tests, schema, links and the screen in a real browser", passes: "Each feature is built and nothing regressed", stops: "One retry per feature; 55% of the budget" },
      stop: "build", at: { x: X[1], y: 130 },
    },
    {
      id: "test", label: "Test", sub: repo ? "the repo's own tests" : "node --test", kind: "loop", action: "testFix", agents: [], stations: ["test"], resumeKey: "accepted",
      loop: { goal: repo ? "The repo's tests that passed before still pass, and the new ones too" : "Every locked test green", observer: "The core runs the suite and the fast checks", passes: "Every test is green", stops: "The fix round limit, or a stall: then the ladder (question the test, a stronger model, you)" },
      stop: "check", at: { x: X[2], y: 130 },
    },
    {
      id: "fix", label: "Fix", sub: "Fixer loop", kind: "step", within: "test", agents: ["fix"],
      stop: "check", at: { x: X[2], y: 260 },
    },
    {
      id: "review", label: "Review", sub: "Reviewer vs spec", kind: "step", action: "review", agents: ["review"], resumeKey: "reviewed",
      skippedWhen: "the review is turned off for the run",
      stop: "check", at: { x: X[3], y: 130 },
    },
    {
      id: "evaluate", label: "Product judge", sub: repo ? "reads the running site" : "reads the running app", kind: "loop", action: "evaluate", agents: ["evaluate"], resumeKey: "reviewed",
      skippedWhen: "there is no browser on this computer, or the screen check is off",
      loop: { goal: "Every must-have requirement seen working on screen", observer: "The Product Judge, who sees no code; the core decides against the thresholds", passes: "Every must-have met and function, design and content at the bar", stops: "After the look limit; repairs get 25% of the budget", maxRounds: 2 },
      stop: "judge", at: { x: X[3], y: 260 },
    },
    {
      id: "gateB", label: "Your OK: build", sub: "one tap", kind: "gate", action: "accept", agents: [], resumeKey: "accepted",
      gate: { asks: "Accept the build, or send it back with what to fix", auto: "Approves itself on runs started with auto-approve" },
      stop: "ok2", at: { x: X[4], y: 130 },
    },
    {
      id: "ship", label: repo ? "Hand over" : "Ship to disk", sub: repo ? "branch, or a draft pull request" : "git repo, tagged", kind: "step", action: "ship", agents: [],
      stop: "ship", at: { x: X[4], y: 260 },
    },
  ];
}

const ENGINE_EDGES: FlowEdge[] = [
  { from: "intake", to: "discover", kind: "next" },
  { from: "intake", to: "council", kind: "branch", label: "big idea", fromSide: "tb" },
  { from: "council", to: "discover", kind: "next", toSide: "t" },
  { from: "discover", to: "plan", kind: "next" },
  { from: "plan", to: "gateA", kind: "next" },
  { from: "gateA", to: "tests", kind: "next", label: "approved", fromSide: "b", toSide: "t" },
  { from: "tests", to: "build", kind: "next" },
  { from: "build", to: "test", kind: "next" },
  { from: "test", to: "fix", kind: "back", label: "red", fromSide: "b1", toSide: "t1" },
  { from: "fix", to: "test", kind: "back", fromSide: "t2", toSide: "b2" },
  { from: "test", to: "review", kind: "next", label: "green" },
  { from: "review", to: "fix", kind: "back", label: "serious findings", fromSide: "b", toSide: "r" },
  { from: "review", to: "evaluate", kind: "next", fromSide: "b", toSide: "t" },
  { from: "evaluate", to: "gateB", kind: "next", toSide: "b2" },
  { from: "gateB", to: "ship", kind: "next", label: "accepted", fromSide: "b", toSide: "t" },
];

/** Today's engine, as a flow: one line becomes a tested, shipped app. */
export const NEW_PROJECT_FLOW: FlowDef = {
  id: "new-project",
  name: "New project",
  purpose: "One line becomes a designed, planned, built, tested and judged app, with your OK on the plan and on the build.",
  version: 1,
  builtIn: true,
  steps: engineSteps(false),
  edges: ENGINE_EDGES,
};

/** The engine route in an imported repository: the change is built on a branch of a clone. */
export const REPO_CHANGE_FLOW: FlowDef = {
  id: "repo-change",
  name: "Change in a repo",
  purpose: "A feature for a project that lives in a git repository is built on its own branch in a clone, and handed over as a branch or a draft pull request.",
  version: 1,
  builtIn: true,
  steps: engineSteps(true),
  edges: ENGINE_EDGES,
};

export const BUILT_IN_FLOWS: FlowDef[] = [NEW_PROJECT_FLOW, REPO_CHANGE_FLOW];

/** The built-in flow a kind of run starts with when nothing else is chosen. */
export function builtInFlowFor(kind?: string): FlowDef {
  return kind === "repo" ? REPO_CHANGE_FLOW : NEW_PROJECT_FLOW;
}

/** The steps the engine carries out, in order (a step inside another's loop is carried out by that loop). */
export function stepsToRun(flow: FlowDef): FlowStep[] {
  return flow.steps.filter((s) => !s.within && s.action);
}

/** The round limit a flow sets for the loop of `action`, or `fallback` when it sets none. */
export function roundsOf(flow: FlowDef, action: ActionId, fallback: number): number {
  const n = flow.steps.find((s) => s.action === action)?.loop?.maxRounds;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : fallback;
}

/** The highest round limit a flow may set on a loop: more rounds than this is a typo, not a choice. */
export const MAX_ROUNDS_LIMIT = 6;

/**
 * Check a flow before it is saved or run. Returns every problem in plain words; an empty list means it
 * may run. The engine refuses a flow with problems, so a broken edit can never start a paid run.
 */
export function flowProblems(f: FlowDef): string[] {
  const out: string[] = [];
  if (!f || typeof f !== "object") return ["A flow must be an object."];
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(String(f.id ?? ""))) out.push("The flow's id must be 2 to 41 lowercase letters, digits or dashes.");
  if (!String(f.name ?? "").trim()) out.push("The flow needs a name.");
  if (!Array.isArray(f.steps) || !f.steps.length) return [...out, "The flow has no steps."];
  if (!Array.isArray(f.edges)) out.push("The flow's lines (edges) must be a list.");
  const ids = new Set<string>();
  const seen = new Map<string, number>();
  const run = f.steps.filter((s) => !s.within && s.action);
  for (const [i, s] of f.steps.entries()) {
    const name = s?.label ? `"${s.label}"` : `step ${i + 1}`;
    if (!s || typeof s.id !== "string" || !s.id) { out.push(`${name} has no id.`); continue; }
    if (ids.has(s.id)) out.push(`Two steps share the id "${s.id}".`);
    ids.add(s.id);
    if (!["step", "loop", "gate"].includes(s.kind)) out.push(`${name} must be a step, a loop or a gate.`);
    if (!String(s.label ?? "").trim()) out.push(`Step "${s.id}" needs a label.`);
    if (!s.stop) out.push(`${name} must say which stop of the track it belongs to.`);
    if (!s.at || typeof s.at.x !== "number" || typeof s.at.y !== "number") out.push(`${name} needs a place on the canvas.`);
    if (!Array.isArray(s.agents)) out.push(`${name} must list its agents (an empty list when the core does it).`);
    else for (const a of s.agents) if (!(STEP_AGENTS as readonly string[]).includes(a)) out.push(`${name} names "${a}", which is not a crew slot (${STEP_AGENTS.join(", ")}).`);
    if (s.resumeKey && !(RESUME_KEYS as readonly string[]).includes(s.resumeKey)) out.push(`${name} has an unknown resume milestone "${s.resumeKey}".`);
    if (s.loop?.maxRounds != null && (!Number.isInteger(s.loop.maxRounds) || s.loop.maxRounds < 1 || s.loop.maxRounds > MAX_ROUNDS_LIMIT)) out.push(`${name} may loop 1 to ${MAX_ROUNDS_LIMIT} rounds.`);
    if (s.loop && s.kind !== "loop") out.push(`${name} has a loop rule but is not a loop.`);
    if (s.within && s.action) out.push(`${name} is carried out inside "${s.within}", so it cannot have an action of its own.`);
    if (!s.within && !s.action) out.push(`${name} needs an action, or must sit inside a loop.`);
    if (s.action) {
      if (!(s.action in ACTIONS)) { out.push(`${name} asks for "${s.action}", which the engine cannot do.`); continue; }
      if (seen.has(s.action)) out.push(`${name} repeats "${ACTIONS[s.action].label}", which a flow does once.`);
      seen.set(s.action, run.indexOf(s));
    }
  }
  for (const s of f.steps) if (s?.within && !f.steps.some((o) => o.id === s.within && o.kind === "loop")) out.push(`"${s.label ?? s.id}" sits inside "${s.within}", which is not a loop of this flow.`);
  for (const [a, def] of Object.entries(ACTIONS) as [ActionId, (typeof ACTIONS)[ActionId]][]) {
    if (def.required && !seen.has(a)) out.push(`The flow must ${def.label.toLowerCase()} ("${a}").`);
    if (!seen.has(a)) continue;
    for (const need of def.needs) if (seen.has(need) && seen.get(need)! > seen.get(a)!) out.push(`"${ACTIONS[a].label}" must come after "${ACTIONS[need as ActionId].label}".`);
  }
  if (Array.isArray(f.edges)) for (const e of f.edges) {
    if (!ids.has(e?.from) || !ids.has(e?.to)) out.push(`A line goes from "${e?.from}" to "${e?.to}", and one of them is not a step.`);
    else if (!["next", "back", "branch"].includes(e.kind)) out.push(`The line from "${e.from}" to "${e.to}" must be next, back or branch.`);
  }
  return out;
}

/** Throw with every problem when the flow cannot run. */
export function assertFlow(f: FlowDef): FlowDef {
  const p = flowProblems(f);
  if (p.length) throw new Error(`The flow "${f?.name ?? f?.id ?? "?"}" cannot run: ${p.join(" ")}`);
  return f;
}
