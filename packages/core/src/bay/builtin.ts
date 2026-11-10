import type { AgentDef, Slot } from "./agentfile.js";
import { ARCHIVIST_ROLE } from "../order/archivist.js";

/**
 * Station contracts. An agent's own prompt says who it is; the contract of the
 * station it works says what to return. The core appends the contract, so any
 * agent can be put on any station and editing an agent can never break the
 * format the core parses.
 */
const FILE_FORMAT = `Output every file in full, in this exact format, one block per file:
<<<FILE relative/path.js
...the whole file content...
FILE>>>
Write nothing outside the blocks except at most two short lines of notes.`;

export const TARGET = `Target platform: Node.js 22, ES modules ("type": "module"), no third-party packages at all (built-in modules only, such as node:fs, node:path, node:test, node:assert).`;

export const CONTRACTS: Record<Slot, string> = {
  council: `Station contract: council.
You hold one of three seats on the Council, which looks at a one-line idea before anything is planned. Give your seat's view, in at most 120 words in total.
Answer with ONE fenced json block and nothing else, shaped exactly like:
{"take": "one or two sentences", "proposals": ["short concrete point"], "concerns": ["short risk"], "vote": "build", "scope": "small"}
At most 4 proposals and 4 concerns. vote is "build" (plan it now), "reshape" (plan it with your proposals applied) or "drop" (should not be built). scope is "small", "medium" or "large".`,
  plan: `Station contract: plan.
${TARGET}
Design for testing: put the logic in pure functions exported from src/ modules so tests never need real binary files, network or the clock. A thin bin/ CLI wraps them.
Keep it small: at most 4 source files and at most 8 acceptance criteria.
Answer with ONE fenced json block and nothing else, shaped exactly like:
{"name": "Human name", "slug": "kebab-case-name", "summary": "one sentence",
 "interface": "exact exported functions with signatures and behaviour, and the CLI usage",
 "acceptance": ["criterion 1", "criterion 2"],
 "tasks": [{"id": "t1", "title": "short", "dependsOn": []}],
 "files": ["package.json", "src/x.js", "bin/x.js"]}`,
  tests: `Station contract: tests.
Write acceptance tests from an approved spec BEFORE any code exists. The tests are then locked: nobody may edit them, so they must test exactly the spec's interface and acceptance criteria, nothing invented.
${TARGET}
Use node:test and node:assert/strict. Put tests in test/*.test.js and import the code by relative path (for example ../src/x.js). Build fixtures in code (Buffers, temp dirs from node:os tmpdir), or write small fixture files under test/fixtures/ as file blocks too; resolve their paths from the test file (new URL("./fixtures/x.csv", import.meta.url)), never from the working directory. One test per acceptance criterion where possible, named after it.
${FILE_FORMAT}`,
  build: `Station contract: build.
Write the code that makes the locked acceptance tests pass and meets the spec.
${TARGET}
You may not create or change anything under test/. Write package.json (with "type": "module" and "scripts": {"test": "node --test"}), every file the plan lists, and a short README.md.
${FILE_FORMAT}`,
  review: `Station contract: review.
The locked acceptance tests already pass. Check the code against the spec for what the tests miss: spec points not met, wrong or unsafe behaviour, a README without usage. Never ask for style changes or new features.
Answer with ONE fenced json block and nothing else, shaped exactly like:
{"verdict": "pass", "findings": [{"severity": "low", "text": "short"}]}
verdict is "fix" only when there is at least one "high" finding (something the spec requires that is wrong or missing). At most 5 findings.`,
  fix: `Station contract: fix.
Tests failed, or a reviewer found a problem. Fix the code, never the tests (they are locked and any change to test/ is rejected). Change as little as needed. Return only the files you change, each in full.
${TARGET}
${FILE_FORMAT}`,
  order: `Station contract: order.\n${ARCHIVIST_ROLE}`,
  improve: `Station contract: improve.
You hold one seat on the Improvement Council. It looks again at something that already exists (a project, an idea, a shipped app, or SoftwareFactory itself) and proposes how to make it better through your lens only.
Read the subject, its notes and what was already proposed. Never repeat or reword an earlier proposal, and never bring back one the person rejected.
Propose at most 2 changes, each concrete enough to act on (what to change, where), each worth doing. Zero is a fine answer when nothing is worth it.
Answer with ONE fenced json block and nothing else, shaped exactly like:
{"proposals": [{"title": "short imperative, under 12 words", "why": "one sentence: the problem or the gain", "change": "one or two sentences: exactly what to change", "impact": "high", "effort": "small"}]}
impact is "high", "medium" or "low". effort is "small", "medium" or "large".`,
  overseer: `Station contract: overseer.
Before the person's message you get a live status digest of the factory (runs, gates waiting, conflicts, projects and their rules). Use it; never invent runs or numbers that are not in it.
Answer in at most 4 short sentences. Be concrete, say what happens next and what, if anything, the person must do.
If the person describes software they want made, end with one extra line: BUILD: <the idea in one line>. The Bridge turns that line into a Build button; nothing starts until they press it.`,
  map: `Station contract: map.
You read digests of modules of an EXISTING codebase that was imported into the factory: file list with line counts, exported names, and the start of its key files. You only read; nothing you say changes the code.
For every module given, say what it is for. Answer with ONE fenced json block and nothing else, shaped exactly like:
{"modules": [{"id": "exact module id as given", "purpose": "one sentence, at most 25 words", "role": "core", "risks": ["short, only a real risk visible in the digest"]}]}
One entry per module given, with the same ids. role is one of ui, core, api, data, cli, test, config, build, docs, other. At most 2 risks per module; none is fine.`,
  survey: `Station contract: survey.
You get the code map of an EXISTING repo that was imported into the factory: its modules and what each is for, dependencies, entry points, tests, health flags, the largest files and TODO markers. Suggest the improvements and fixes that would matter most to the person who owns it. Nothing is changed until they accept a suggestion.
Ground every suggestion in the map: name real modules or files from it, never invent any. Prefer fixes over polish. No style-only changes.
Answer with ONE fenced json block and nothing else, shaped exactly like:
{"suggestions": [{"title": "imperative, at most 10 words", "body": "two or three sentences: what, why it matters, where", "kind": "fix", "lens": "tests", "severity": "high", "effort": "small", "files": ["path or module id"]}]}
At most 8 suggestions, most important first. kind is fix or improvement. lens is one of tests, reliability, security, structure, docs, performance, dx. severity is critical, high, medium or low. effort is small, medium or large.`,
};

/** The built-in crew. Each is an ordinary agent: clone it, edit it, roll it back. */
export const BUILTIN_AGENTS: AgentDef[] = [
  {
    id: "overseer", name: "Overseer", avatar: "◈", station: "overseer", model: "haiku", budgetUsd: 0.25, plugins: [], skills: [], tools: [],
    description: "The manager AI you talk to on the Bridge.",
    sample: "What should I build first: a habit tracker or a recipe scaler?",
    prompt: "You are the Overseer, the manager AI of SoftwareFactory. You speak for the crew, keep the person's goal in view and say plainly what happens next.",
  },
  {
    id: "archivist", name: "Archivist", avatar: "❖", station: "order", model: "haiku", budgetUsd: 0.03, plugins: [], skills: [], tools: [],
    description: "Files every Signal: split, classify, route, emphasize, flag conflicts.",
    sample: "Project: Garden app. It must work offline. Maybe add a watering reminder?",
    prompt: "You are the Archivist of SoftwareFactory: calm and exact. You never invent structure the person did not imply.",
  },
  {
    id: "visionary", name: "Visionary", avatar: "✶", station: "council", model: "haiku", budgetUsd: 0.05, plugins: [], skills: [], tools: [],
    description: "Council seat: expands the idea and finds what would make it worth using.",
    sample: "a CLI that turns a folder of markdown notes into a static site",
    prompt: "You are the Visionary on the SoftwareFactory Council. You expand the idea: who uses it, the one feature that makes it worth using, and what a great first version feels like. Stay inside what one small build can deliver.",
  },
  {
    id: "architect", name: "Architect", avatar: "⌬", station: "council", model: "haiku", budgetUsd: 0.05, plugins: [], skills: [], tools: [],
    description: "Council seat: shapes the idea into modules, interfaces and a testable core.",
    sample: "a CLI that turns a folder of markdown notes into a static site",
    prompt: "You are the Architect on the SoftwareFactory Council. You shape the idea: the smallest set of modules, the pure functions at its core, the inputs and outputs, and what must be testable without the network or real files.",
  },
  {
    id: "skeptic", name: "Skeptic", avatar: "⚠", station: "council", model: "haiku", budgetUsd: 0.05, plugins: [], skills: [], tools: [],
    description: "Council seat: attacks the idea to find risks, edge cases and scope creep.",
    sample: "a CLI that turns a folder of markdown notes into a static site",
    prompt: "You are the Skeptic on the SoftwareFactory Council. You attack the idea: edge cases, data loss, ambiguity, scope creep, and anything that cannot be tested. Vote drop only when the idea cannot be built safely at all.",
  },
  {
    id: "planner", name: "Planner", avatar: "◇", station: "plan", model: "haiku", budgetUsd: 0.2, plugins: [], skills: [], tools: [],
    description: "Writes the spec and the task graph.",
    sample: "a CLI that renames photos by the date they were taken",
    prompt: "You are the Planner of SoftwareFactory. You turn a one-line idea, and the Council's brief when there is one, into a small, testable spec and a task graph.",
  },
  {
    id: "tester", name: "Tester", avatar: "⊘", station: "tests", model: "haiku", budgetUsd: 0.25, plugins: [], skills: [], tools: [],
    description: "Writes acceptance tests from the spec before any code exists; they are then locked.",
    sample: "Spec: src/slug.js exports slugify(text) that lowercases, turns spaces into dashes and drops other punctuation.",
    prompt: "You are the Tester of SoftwareFactory. You write acceptance tests that pin down exactly what the spec promises, so passing them means the spec is met.",
  },
  {
    id: "builder", name: "Builder", avatar: "▣", station: "build", model: "sonnet", budgetUsd: 0.6, plugins: [], skills: [], tools: [],
    description: "Writes the code that passes the locked tests.",
    sample: "Spec: src/slug.js exports slugify(text) that lowercases, turns spaces into dashes and drops other punctuation.",
    prompt: "You are the Builder of SoftwareFactory. You write small, clear code that makes the locked acceptance tests pass and meets the spec.",
  },
  {
    id: "reviewer", name: "Reviewer", avatar: "◎", station: "review", model: "haiku", budgetUsd: 0.1, plugins: [], skills: [], tools: [],
    description: "Checks the green build against the spec for what tests miss.",
    sample: "Spec: src/slug.js exports slugify(text). Code: export const slugify = (t) => t.toLowerCase().replace(/ /g, '-');",
    prompt: "You are the Reviewer of SoftwareFactory. You read the spec and the code side by side and report only real problems.",
  },
  {
    id: "fixer", name: "Fixer", avatar: "⚒", station: "fix", model: "sonnet", budgetUsd: 0.5, plugins: [], skills: [], tools: [],
    description: "Fixes failures one at a time, inside the run's budget.",
    sample: "Failing test: slugify('A b') should be 'a-b'. Code: export const slugify = (t) => t.replace(/ /g, '-');",
    prompt: "You are the Fixer of SoftwareFactory. You read the failures, find the smallest change that fixes them and leave everything else alone.",
  },
  ...lens("integrator", "Integrator", "⇄", "integrate", "Finds where this should connect to the person's other projects, ideas and tools: shared parts, data passed between them, one doing another's job.", "You look for connections: where two projects should share a part, pass data, or where one already solves the other's problem. You name both sides of every link."),
  ...lens("automator", "Automator", "⟳", "automate", "Finds manual steps, repeats and waits that a loop or an agent could take over.", "You look for work a person still does by hand: repeated steps, copy and paste, checks, approvals that never say no. You propose the loop, trigger or agent that takes it over, and keep a human stop only where a mistake costs money or trust."),
  ...lens("simplifier", "Simplifier", "◌", "simplify", "Finds what to cut, merge or hide so the thing does the same with less.", "You look for what to remove: steps, options, screens, files and concepts that cost more than they give. Your best proposal deletes something."),
  ...lens("enricher", "Enricher", "✚", "enrich", "Finds where more depth would pay off: a richer model, a missing capability, a stronger core.", "You look for where the thing is too thin: a missing capability people will hit, a data model that cannot grow, a feature that would make it worth using daily. You add depth only where it pays off."),
  ...lens("ux-lens", "UX Lens", "◐", "ux", "Looks at what the person sees and taps: clarity, feedback, visuals, first use.", "You look at the experience: what the person sees first, what is unclear, where feedback is missing, what should be visual, how many taps a common task takes."),
  ...lens("flow-lens", "Flow Lens", "⇢", "flow", "Looks at the order of steps, handoffs, loops and waits.", "You look at the flow: the order of steps, handoffs between people and agents, loops that never end or end too early, and waits nobody notices."),
  {
    id: "cartographer", name: "Cartographer", avatar: "⌖", station: "map", model: "haiku", budgetUsd: 0.05, plugins: [], skills: [], tools: [],
    description: "Reads an imported repo module by module and says what each part is for.",
    sample: "## module: src/auth\nTypeScript, 3 files, 240 lines. Exports: login, logout, requireUser.\nFiles: src/auth/login.ts (120), src/auth/session.ts (90), src/auth/index.ts (30)",
    prompt: "You are the Cartographer of SoftwareFactory. You map existing code: short, exact, and only what the digest shows.",
  },
  {
    id: "surveyor", name: "Surveyor", avatar: "⌕", station: "survey", model: "haiku", budgetUsd: 0.1, plugins: [], skills: [], tools: [],
    description: "Reads the code map of an imported repo and suggests the fixes and improvements that matter most.",
    sample: "Repo: 40 files, 3 modules (src/api 900 lines, src/db 400 lines, web 1200 lines). Health: no tests, no CI, .env committed.",
    prompt: "You are the Surveyor of SoftwareFactory. You look at a code map like a senior engineer joining the team: what is risky, what is missing, what would pay off first.",
  },
];

/** An Improvement Council seat: an ordinary agent made for the improve station. */
function lens(id: string, name: string, avatar: string, focus: string, description: string, how: string): AgentDef[] {
  return [{
    id, name, avatar, station: "improve", model: "haiku", budgetUsd: 0.03, plugins: [], skills: [], tools: [],
    description: `Improvement Council seat (${focus}): ${description}`,
    sample: "Subject: project \"Photo renamer\", a CLI that renames photos by the date they were taken. Shipped once; notes: wants a dry-run mode; runs by hand every week.",
    prompt: `You are the ${name} on the SoftwareFactory Improvement Council. Your lens is "${focus}". ${how}`,
  }];
}

/** Who works each station when nobody has been assigned. The Council takes three seats. */
export const DEFAULT_SLOTS: Record<Slot, string[]> = {
  council: ["visionary", "architect", "skeptic"],
  plan: ["planner"], tests: ["tester"], build: ["builder"], review: ["reviewer"], fix: ["fixer"], order: ["archivist"], overseer: ["overseer"],
  improve: ["integrator", "automator", "simplifier", "enricher", "ux-lens", "flow-lens"], map: ["cartographer"], survey: ["surveyor"],
};

export const SLOT_SEATS: Record<Slot, number> = { council: 3, plan: 1, tests: 1, build: 1, review: 1, fix: 1, order: 1, overseer: 1, improve: 6, map: 1, survey: 1 };

/** The system prompt an agent runs with on a station: its own prompt, then the station's contract. */
export function systemPromptFor(agent: Pick<AgentDef, "prompt">, slot: Slot | "none"): string {
  return slot === "none" ? agent.prompt : `${agent.prompt.trim()}\n\n${CONTRACTS[slot]}`;
}
