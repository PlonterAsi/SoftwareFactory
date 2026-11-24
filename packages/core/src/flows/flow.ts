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
 * "Feature in a repo" flow. Both carry out exactly what the fixed pipeline did before flows existed.
 *
 * Phase 2 made it a library, one flow per kind of work: a bug fix, a small change and a refactor are one
 * Builder session (runner "session"), a question is answered by a reader (runner "answer"), and import,
 * improve and release are drawn as carried out by their own screens (runner "door"). A ticket takes the
 * flow of its kind unless you pick another (tickets/flowpick.ts).
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

/**
 * What one Builder session in a repo can do for a step (tickets/repowork.ts). A bug fix, a small change and
 * a refactor are this kind of flow: cents, not dollars.
 */
export const SESSION_ACTIONS = {
  orient: { label: "Read the repo", needs: [], required: true },
  build: { label: "Builder session", needs: ["orient"], required: true },
  checks: { label: "Checks and fix loop", needs: ["build"], required: true },
  review: { label: "Reviewer on the diff", needs: ["checks"], required: false },
  commit: { label: "Commit on the branch", needs: ["checks"], required: true },
  handover: { label: "Draft pull request", needs: ["commit"], required: false },
} as const satisfies Record<string, { label: string; needs: string[]; required: boolean }>;

/** What a research flow can do: read, answer on the ticket, change nothing (tickets/research.ts). */
export const ANSWER_ACTIONS = {
  orient: { label: "Read the repo", needs: [], required: true },
  answer: { label: "Answer on the ticket", needs: ["orient"], required: true },
} as const satisfies Record<string, { label: string; needs: string[]; required: boolean }>;

/**
 * Who carries a flow out:
 *   engine   the factory engine (factory/loop.ts): design, plan, build, test, judge, ship. Dollars.
 *   session  one Builder session in a clone of the repo, the checks, a Reviewer (tickets/repowork.ts). Cents.
 *   answer   one reader who answers on the ticket and changes nothing (tickets/research.ts). Cents.
 *   door     its own screen carries it out in a fixed order (import, improve, release). Drawn here so every
 *            kind of work is on one map; its steps follow these boxes once that door reads flows.
 */
export type FlowRunner = "engine" | "session" | "answer" | "door";
export const RUNNER_ACTIONS: Record<Exclude<FlowRunner, "door">, Record<string, { label: string; needs: readonly string[]; required: boolean }>> = {
  engine: ACTIONS, session: SESSION_ACTIONS, answer: ANSWER_ACTIONS,
};
export const RUNNER_WORD: Record<FlowRunner, string> = { engine: "the whole engine", session: "one Builder session", answer: "one reader, no changes", door: "its own screen" };

/** Crew slots a step may name (the Agent Bay's stations). Each is one of SLOTS in bay/agentfile.ts. */
export const STEP_AGENTS = ["council", "design", "critique", "plan", "tests", "build", "review", "evaluate", "fix", "survey", "map", "inspect", "verdict", "improve"] as const;

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
  /** The action that carries it out (one of its runner's actions). A step carried out inside another step's loop has none. */
  action?: string;
  /** The crew slots that work it, first the main one. Empty: the core does it with no agent. */
  agents: string[];
  /**
   * The named Agent Bay agents that work this step's main slot (agents[0]), in seat order: for example the
   * "react-builder" specialist on Build. Absent or empty: whoever works that station in the Bay.
   */
  crew?: string[];
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
  /** Who carries it out (default: the engine, as every flow before the library). */
  runner?: FlowRunner;
  /** The kinds of ticket that take this flow when nobody chose one. */
  kinds?: string[];
  /** Words added to the worker's instructions on every run of this flow (what makes a refactor a refactor). */
  brief?: string;
  /** For a door flow: which screen carries it out today. */
  door?: string;
  steps: FlowStep[];
  edges: FlowEdge[];
}

export const runnerOf = (f: Pick<FlowDef, "runner">): FlowRunner => f.runner ?? "engine";

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
  runner: "engine",
  purpose: "One line becomes a designed, planned, built, tested and judged app, with your OK on the plan and on the build.",
  version: 1,
  builtIn: true,
  steps: engineSteps(false),
  edges: ENGINE_EDGES,
};

/** The engine route in an imported repository: the change is built on a branch of a clone. */
export const REPO_CHANGE_FLOW: FlowDef = {
  id: "repo-change",
  name: "Feature in a repo",
  runner: "engine",
  kinds: ["request", "idea", "plan"],
  purpose: "A feature for a project that lives in a git repository is built on its own branch in a clone, and handed over as a branch or a draft pull request.",
  version: 1,
  builtIn: true,
  steps: engineSteps(true),
  edges: ENGINE_EDGES,
};

const Y = 0;
/** One Builder session in a clone: read, build, checks with fix rounds, a Reviewer, commit, a draft PR. */
function sessionSteps(o: { build: string; review?: boolean }): FlowStep[] {
  const steps: FlowStep[] = [
    { id: "orient", label: "Read the repo", sub: "rules, code map, installs", kind: "step", action: "orient", agents: [], stop: "idea", at: { x: X[0], y: Y } },
    { id: "build", label: "Build", sub: o.build, kind: "step", action: "build", agents: ["build"], stop: "build", at: { x: X[1], y: Y } },
    {
      id: "checks", label: "Checks", sub: "secrets, gates, tests", kind: "loop", action: "checks", agents: [],
      loop: { goal: "The change passes the secret gate, the fast gates, test integrity and the tests it touches", observer: "The core runs each check; the Builder never judges itself", passes: "Every check passes", stops: "After the fix round limit, or when 90% of the budget is spent: nothing is committed", maxRounds: 2 },
      stop: "check", at: { x: X[2], y: Y },
    },
    { id: "fix", label: "Fix", sub: "Builder, the failing check only", kind: "step", within: "checks", agents: ["build"], stop: "check", at: { x: X[2], y: 130 } },
  ];
  if (o.review !== false) steps.push({
    id: "review", label: "Review", sub: "Reviewer reads the diff", kind: "loop", action: "review", agents: ["review"],
    loop: { goal: "No high finding left in the diff (bugs, missed asks, gamed tests)", observer: "The Reviewer, who did not write it", passes: "No high finding", stops: "After the fix round limit: nothing is committed", maxRounds: 1 },
    skippedWhen: "the budget is used up before it", stop: "check", at: { x: X[3], y: Y },
  });
  steps.push(
    { id: "commit", label: "Commit", sub: "on the ticket's branch", kind: "step", action: "commit", agents: [], stop: "ship", at: { x: X[3], y: 130 } },
    { id: "handover", label: "Draft PR", sub: "or the branch stays here", kind: "step", action: "handover", agents: [], skippedWhen: "no GitHub access, or a folder on this computer: the branch waits for your Send", stop: "ship", at: { x: X[4], y: 130 } },
  );
  return steps;
}
const SESSION_EDGES: FlowEdge[] = [
  { from: "orient", to: "build", kind: "next" },
  { from: "build", to: "checks", kind: "next" },
  { from: "checks", to: "fix", kind: "back", label: "a check failed", fromSide: "b1", toSide: "t1" },
  { from: "fix", to: "checks", kind: "back", fromSide: "t2", toSide: "b2" },
  { from: "checks", to: "review", kind: "next", label: "all pass" },
  { from: "review", to: "commit", kind: "next", label: "no high finding", fromSide: "b", toSide: "t" },
  { from: "commit", to: "handover", kind: "next" },
];

/** A bug: find the cause, fix it, prove it with a test. */
export const BUG_FIX_FLOW: FlowDef = {
  id: "bug-fix", name: "Bug fix", runner: "session", kinds: ["bug"], version: 1, builtIn: true,
  purpose: "A bug in a project that lives in a repo: one Builder session finds the cause and fixes it on the ticket's branch, the checks and a Reviewer pass it, and it goes out as a draft pull request.",
  brief: "This is a bug fix. Find the cause before you change anything. When the repo has tests, add one that fails without your fix and passes with it.",
  steps: sessionSteps({ build: "Builder finds the cause and fixes it" }), edges: SESSION_EDGES,
};

/** A task or a small ask: one session, as the light route always did. */
export const SMALL_CHANGE_FLOW: FlowDef = {
  id: "small-change", name: "Small change", runner: "session", kinds: ["task"], version: 1, builtIn: true,
  purpose: "A task or a small ask in a repo: one Builder session makes the change on the ticket's branch, the checks and a Reviewer pass it, and it goes out as a draft pull request.",
  steps: sessionSteps({ build: "Builder makes the change" }), edges: SESSION_EDGES,
};

/** A refactor: the code gets better and nothing it does changes. */
export const REFACTOR_FLOW: FlowDef = {
  id: "refactor", name: "Refactor", runner: "session", kinds: [], version: 1, builtIn: true,
  purpose: "Make code clearer or smaller without changing what it does: one Builder session, the repo's tests unchanged and green, a Reviewer looking for any change in behaviour.",
  brief: "This is a refactor. What the code does must not change: do not edit existing tests, and every test that passed before must still pass. If a change would alter behaviour, leave it out and say so.",
  steps: sessionSteps({ build: "Builder restructures, same behaviour" }), edges: SESSION_EDGES,
};

/** A question: read and answer, change nothing. */
export const RESEARCH_FLOW: FlowDef = {
  id: "research", name: "Research or question", runner: "answer", kinds: ["question"], version: 1, builtIn: true,
  purpose: "A question about a project, or something to find out: a reader goes through the repo (or the ticket and its project when there is none) and answers on the ticket, with the files it read. Nothing is changed and no branch is made.",
  steps: [
    { id: "orient", label: "Read the repo", sub: "a clone, read only", kind: "step", action: "orient", agents: [], stop: "idea", at: { x: X[0], y: 0 } },
    { id: "answer", label: "Answer", sub: "Surveyor, read-only tools", kind: "step", action: "answer", agents: ["survey"], stop: "ship", at: { x: X[1], y: 0 } },
  ],
  edges: [{ from: "orient", to: "answer", kind: "next" }],
};

const door = (o: { id: string; name: string; purpose: string; door: string; steps: [string, string, string, string[]?][] }): FlowDef => ({
  id: o.id, name: o.name, purpose: o.purpose, runner: "door", door: o.door, kinds: [], version: 1, builtIn: true,
  steps: o.steps.map(([id, label, sub, agents], i) => ({ id, label, sub, kind: "step" as const, action: id, agents: agents ?? [], stop: i === o.steps.length - 1 ? "ship" : "build", at: { x: X[Math.min(i, 4)] + (i > 4 ? 190 * (i - 4) : 0), y: 0 } })),
  edges: o.steps.slice(1).map(([id], i) => ({ from: o.steps[i][0], to: id, kind: "next" as const })),
});

/** Import a git repo: clone, map, review, propose. Carried out by the import screen. */
export const IMPORT_FLOW = door({
  id: "import", name: "Import a repo", door: "Projects → Import from git, then the project's Review tab",
  purpose: "A git repository becomes a project SF manages: cloned, mapped module by module, run and judged by the deep review, with next steps proposed as tickets.",
  steps: [["clone", "Clone", "a copy SF works in"], ["map", "Map the code", "Cartographer, Surveyor", ["map", "survey"]], ["review", "Deep review", "run it, judge it", ["inspect", "verdict"]], ["propose", "Next steps", "proposed as tickets"]],
});

/** The improve loop: lenses look at a project and propose changes. Carried out by Improve. */
export const IMPROVE_FLOW = door({
  id: "improve", name: "Improve loop", door: "Improve, on the whole factory or a project",
  purpose: "Lenses look at what exists (its code, its screens, how its runs went) and propose changes; what you accept becomes work.",
  steps: [["look", "Look", "each lens reads the project", ["improve"]], ["propose", "Propose", "one card per change"], ["accept", "Your OK", "accept or drop each"], ["work", "Work", "accepted ones become tickets"]],
});

/** A release: merged tickets become a version. Carried out by shipping today; the git manager takes it over. */
export const RELEASE_FLOW = door({
  id: "release", name: "Release", door: "Ship tags each version today; release notes and the version timeline come with the git manager (phase 3)",
  purpose: "Merged tickets are grouped into a version, release notes are written from their timelines, the version is tagged and shown on the project's version timeline.",
  steps: [["collect", "Collect", "tickets merged since the last version"], ["notes", "Release notes", "from each ticket's timeline"], ["accept", "Your OK", "on the notes"], ["tag", "Tag", "the version on main"]],
});

export const BUILT_IN_FLOWS: FlowDef[] = [NEW_PROJECT_FLOW, REPO_CHANGE_FLOW, BUG_FIX_FLOW, SMALL_CHANGE_FLOW, REFACTOR_FLOW, RESEARCH_FLOW, IMPORT_FLOW, IMPROVE_FLOW, RELEASE_FLOW];

/** The built-in flow a kind of run starts with when nothing else is chosen. */
export function builtInFlowFor(kind?: string): FlowDef {
  return kind === "repo" ? REPO_CHANGE_FLOW : NEW_PROJECT_FLOW;
}

/** The steps the engine carries out, in order (a step inside another's loop is carried out by that loop). */
export function stepsToRun(flow: FlowDef): FlowStep[] {
  return flow.steps.filter((s) => !s.within && s.action);
}

/** The round limit a flow sets for the loop of `action`, or `fallback` when it sets none. */
/**
 * The Bay agents a flow names for a station: the crew of the first step whose main slot it is. Undefined when
 * no step names any, so the station's own crew works it (AgentBay.crewFor).
 */
export function crewPick(flow: FlowDef | undefined, slot: string): string[] | undefined {
  const s = flow?.steps.find((x) => x.agents?.[0] === slot && Array.isArray(x.crew) && x.crew.length);
  return s?.crew?.slice();
}

/** Most agents one step may name: the Council's six seats; every other station has one. */
export const crewSeats = (slot: string | undefined) => (slot === "council" ? 6 : 1);

export function roundsOf(flow: FlowDef, action: string, fallback: number): number {
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
  const runner = f.runner ?? "engine";
  if (!["engine", "session", "answer", "door"].includes(runner)) return [...out, `"${runner}" is not a way to carry out a flow (engine, session, answer or door).`];
  if (f.brief != null && (typeof f.brief !== "string" || f.brief.length > 2000)) out.push("The flow's brief must be words, at most 2,000 characters.");
  if (f.kinds != null && (!Array.isArray(f.kinds) || f.kinds.some((k) => typeof k !== "string"))) out.push("The kinds a flow serves must be a list of ticket kinds.");
  const table = runner === "door" ? null : RUNNER_ACTIONS[runner];
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
    if (s.crew != null) {
      if (!Array.isArray(s.crew) || s.crew.some((x) => typeof x !== "string" || !/^[a-z0-9-]{1,48}$/.test(x))) out.push(`${name} must name its agents by their Bay ids.`);
      else if (s.crew.length && !s.agents?.length) out.push(`${name} names agents, but the core does this step with no agent.`);
      else if (s.crew.length > crewSeats(s.agents?.[0])) out.push(`${name} names ${s.crew.length} agents; ${s.agents?.[0]} takes ${crewSeats(s.agents?.[0])}.`);
    }
    if (s.resumeKey && !(RESUME_KEYS as readonly string[]).includes(s.resumeKey)) out.push(`${name} has an unknown resume milestone "${s.resumeKey}".`);
    if (s.loop?.maxRounds != null && (!Number.isInteger(s.loop.maxRounds) || s.loop.maxRounds < 1 || s.loop.maxRounds > MAX_ROUNDS_LIMIT)) out.push(`${name} may loop 1 to ${MAX_ROUNDS_LIMIT} rounds.`);
    if (s.loop && s.kind !== "loop") out.push(`${name} has a loop rule but is not a loop.`);
    if (s.within && s.action) out.push(`${name} is carried out inside "${s.within}", so it cannot have an action of its own.`);
    if (!s.within && !s.action) out.push(`${name} needs an action, or must sit inside a loop.`);
    if (s.action) {
      if (table && !(s.action in table)) { out.push(`${name} asks for "${s.action}", which ${RUNNER_WORD[runner]} cannot do.`); continue; }
      if (seen.has(s.action)) out.push(`${name} repeats "${table?.[s.action].label ?? s.action}", which a flow does once.`);
      seen.set(s.action, run.indexOf(s));
    }
  }
  for (const s of f.steps) if (s?.within && !f.steps.some((o) => o.id === s.within && o.kind === "loop")) out.push(`"${s.label ?? s.id}" sits inside "${s.within}", which is not a loop of this flow.`);
  if (table) for (const [a, def] of Object.entries(table)) {
    if (def.required && !seen.has(a)) out.push(`The flow must ${def.label.toLowerCase()} ("${a}").`);
    if (!seen.has(a)) continue;
    for (const need of def.needs) if (seen.has(need) && seen.get(need)! > seen.get(a)!) out.push(`"${def.label}" must come after "${table[need].label}".`);
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
