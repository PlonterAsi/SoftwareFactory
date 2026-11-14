import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { EventLog } from "../events.js";
import type { Slot } from "../bay/agentfile.js";
import { captureSignal } from "../signals.js";
import { codeMapSummary } from "../imports/explorer.js";
import { mapText } from "../imports/crew.js";
import { scanRepo } from "../imports/scan.js";
import { describeSecrets, scanFiles } from "../safety/secrets.js";
import { describeIntegrity, testIntegrity } from "../safety/testguard.js";
import { hideTokens, parseGitHubRepo, type GitHub } from "../tickets/github.js";
import { harnessChecks, prepareClone, repoGuidance, repoOfProject, type RepoRef } from "../tickets/repowork.js";
import type { CrewMember } from "./crew.js";
import { critiquePrompt, docsFiles, mustRequirements, validateDocs, type Critique, type Finding, type ProductDocs } from "./discovery.js";
import { MAX_EVALUATION_ROUNDS, PRODUCT_PASS_SCORE, evaluationFeedback, evaluationPasses, evaluationPrompt, validateEvaluation, type Evaluation } from "./evaluate.js";
import { BUILD_BUDGET_SHARE, FEATURE_LOOP_MIN_USD, FEATURE_MIN_USD, featureCapUsd, featuresFile, progressEntry, type Feature } from "./features.js";
import { Run, StopRun, type Factory, type Plan, type RestoredState, type RunMaker, type RunOptions } from "./loop.js";
import { SF_DIR, prepareEnv, readSite, runRepoTests, siteProfile, type RepoEnv } from "./repoenv.js";
import { WORKBENCH_COMMANDS, changedFiles, workbenchContract, writtenOnDisk } from "./workbench.js";
import { commitAll, git, parseFileBlocks, parseJsonBlock, writeFiles, type TestCase, type TestRun } from "./workspace.js";

/**
 * The engine in a codebase it did not write (docs/engine.md, "Imported repos run on the same engine").
 *
 * Until now SoftwareFactory had two ways to work, and which one you got depended on where the code came
 * from, not on what you asked for. An app the factory built went through the whole engine: Council, product
 * documents written and criticised in a loop, a plan you approve, a build one feature per session, tests,
 * a Reviewer who runs the acceptance criteria, a product judge, the build gate. A repo you imported got one
 * Builder call per ticket (tickets/repowork.ts): right for a small fix, and all there was for a feature.
 *
 * A RepoRun is the same engine, with what an existing codebase changes:
 *
 *   - it works in a clone of the repo, on a branch of its own; the repo's main line and your working copy
 *     are never written to, and SoftwareFactory's own notes live under `.sf/`, which git leaves out;
 *   - the Designer designs the change, not a product: it reads the code map (and the code) and writes what
 *     the change adds for the person, on which pages, by which rules; the Critic judges that;
 *   - the Planner plans in the repo's own stack and structure and splits the change into features;
 *   - there are no locked tests to write first: the repo's own tests, run before anything changes, are the
 *     baseline. A test that passed then must pass after every feature; one that already failed is not held
 *     against the run. Each feature brings tests for what it adds, and existing tests may not be weakened;
 *   - the Reviewer reads the diff and runs the acceptance criteria; the product judge reads the pages of
 *     the running site when SoftwareFactory can start it, and says so plainly when it cannot;
 *   - shipping is not a version tag: the branch is pushed and a draft pull request opened when GitHub
 *     access allows, else it waits in the clone with the one command that takes it.
 *
 * Small work keeps the light route (one Builder call); `routeWork` (factory/route.ts) decides which.
 */

/** What a repo run's started event says about where it works. All a resume needs. */
export interface RepoRunInfo { projectId: number | null; source: string; name: string; branch: string; ticket?: { id: number; key: string; title?: string } }

/** A finished branch in a clone, for whoever takes it to its repo. */
export interface BranchToShip { run: number; ref: RepoRef; dir: string; branch: string; base: string; title: string; body: string }
/** Where the branch went: a pull request, or why it stayed in the clone. */
export type ShippedBranch = { pr: { number: number; url: string; repo: string } } | { kept: string };

/** What a repo run does through the computer; tests replace any of them. */
export interface RepoTools {
  prepareEnv: (dir: string) => RepoEnv | Promise<RepoEnv>;
  runTests: (dir: string, env: RepoEnv) => Promise<TestRun>;
  readSite: typeof readSite;
  ship: (b: BranchToShip) => Promise<ShippedBranch>;
  /** GitHub access, for cloning a private repo. */
  github?: Pick<GitHub, "remote" | "git">;
}

/** Below this an engine run cannot pay for a design, a plan, a build and a review: the light route does the work. */
export const REPO_ENGINE_MIN_USD = 1.5;

const BRAIN_NOTE = "Any SoftwareFactory principle above about the app kit, new apps or sample records was written for apps the factory builds from nothing. Here you work in a codebase that already exists: keep its stack, its structure and its look, and follow those principles only where they fit it.";
const DOCS_SHAPE = `Answer with ONE fenced json block and nothing else, shaped exactly like:
{"brief": {"who": "who uses this product, in one sentence", "problem": "what they cannot do today", "promise": "what this change gives them, in one sentence", "notThis": ["what the change deliberately leaves alone"]},
 "research": [{"finding": "what you learned", "source": "https://the-page"}],
 "journeys": [{"moment": "when it matters", "goal": "what they want", "steps": ["what they do and what the product shows, one step each"]}],
 "screens": [{"id": "kebab-id", "name": "the page or place, as the product names it", "purpose": "what the change does there", "shows": ["what is on it after the change"], "actions": ["what the person can do there"]}],
 "requirements": [{"id": "R1", "text": "one thing the change must do", "from": "person", "must": true}],
 "rules": [{"name": "Validation", "rule": "a decision the change makes, exact enough to test"}],
 "assumptions": ["what you assumed because the ask did not say"]}`;

/** What each station is told in a codebase that already exists. The agent keeps its own prompt; only the contract changes. */
export const REPO_CONTRACTS: Partial<Record<Slot, string>> = {
  design: `Station contract: design.
You design a change to a product that already exists, before anyone plans or builds it. You get what the person asks for and a map of the codebase: its modules and what each is for, how it starts, its tests. You return the product documents of the change, not of the whole product.
1. Understand first. Read the map. You can read files: open the pages, routes or modules the ask touches (the current folder is the repo) before you decide anything.
2. Design from the person who uses the product. Name the moments this change matters to them and walk each one step by step ("journeys"), using the real pages, routes or commands of the product.
3. "screens" are the places of the existing product this change adds or changes (a page, a section of a page, a command, an API route), each named the way the product names it, with what it shows and what the person can do there once the change is in. A change with nothing to see (a fix under the hood, a refactor) has none.
4. Write the requirements: first every thing the person named, each as its own line with from "person" (never merged, never weakened); then what your design adds, with from "design". Each one can be checked on the running product or by a test. "must" is false only for extras of your own.
5. "rules" hold every decision the change makes, exact enough to test: what is valid, limits, order, what happens on an error.
Design the smallest change that fully does what the person asked. Say in "assumptions" what you assumed and what you left alone on purpose. Never invent a source.
${BRAIN_NOTE}
${DOCS_SHAPE}
Size limits, so nothing is cut: at most 20 requirements of one or two sentences each, 6 screens with up to 12 lines each, 14 steps a journey, 12 rules.`,
  plan: `Station contract: plan.
You plan a change to a codebase that already exists. You get what the person asks for, a map of the codebase and, when there are any, the product documents of the change (written and reviewed before you). You can read files: the current folder is the repo. You write no code.
Plan in the codebase's own stack and structure. Name real files and modules, follow how the code is already organised, and add no framework or package the ask does not need.
Split the work into features: each is something a person or a test can see working when it is done, small enough for one working session, in the order they must be built. 1 to 6 features; a small ask is one. Each says which files it touches or adds, what to build, and how one knows it is done.
Acceptance criteria: at most 10, each checkable by running the product or its tests, between them covering every requirement that is not nice to have. One of them is that what worked before still works.
"tests" says how the change is tested in this repo's own test setup (which test files to add or extend). When the repo has no tests, say which small test the change brings with it.
${BRAIN_NOTE}
Answer with ONE fenced json block and nothing else, shaped exactly like:
{"name": "the change, as a short title", "summary": "one or two sentences: what changes for the person",
 "approach": "how it is built in this codebase: the modules and files it touches, and why there",
 "features": [{"id": "F1", "title": "short", "what": "what to build, concretely", "files": ["a/path/that/exists.py", "a/new/file.html"], "done": "how one knows it works"}],
 "acceptance": ["criterion 1", "criterion 2"],
 "tests": "how it is tested",
 "risks": ["what could break, and how the plan guards it"]}`,
  build: `Station contract: repo. You are building one part of an approved change inside an existing code repository: the current folder is a clone on its own branch.
Make the smallest change that does what you are asked, in the style of the code around it. Read before you edit.
Add or extend tests for the behaviour you add, in the repo's own test setup. Never delete, skip or weaken a test that is there.
Do not touch files outside this folder, anything under .sf/ (SoftwareFactory's notes: read them, never write them) or .git. If you cannot edit files, answer with <<<FILE path ... FILE>>> blocks holding whole files.
${BRAIN_NOTE}`,
  fix: `Station contract: repo. You are fixing a change that is being built inside an existing code repository: the current folder is a clone on its own branch.
A check failed, a reviewer found a problem, or the person sent the change back. Fix the cause in the code, never the check: do not delete, skip or weaken a test to make it pass. Change as little as needed, in the style of the code around it.
Do not touch files outside this folder, anything under .sf/ or .git. If you cannot edit files, answer with <<<FILE path ... FILE>>> blocks holding whole files.
${BRAIN_NOTE}`,
  review: `Station contract: review.
You review a change made to an existing codebase: you get the approved plan and the diff against the commit the work started from. The repo's own tests pass.
Check the diff against the plan for what the tests miss: an acceptance criterion not met, wrong or unsafe behaviour, something that worked before and no longer does, code that does not fit the codebase it sits in.
"high" is also any gaming of the tests: a test deleted, skipped or weakened, a test changed to match wrong output, an expected value hard-coded in the source.
Never ask for style changes or for features the plan does not have.
Answer with ONE fenced json block and nothing else, shaped exactly like:
{"verdict": "pass", "findings": [{"severity": "low", "text": "short"}]}
verdict is "fix" only when there is at least one "high" finding. At most 5 findings.`,
  evaluate: `Station contract: evaluate.
You judge a change to an existing product the way the person who asked for it would. You see no code: only what they asked for, the design of the change, and what the pages of the running site really show (their text and their controls).
For EACH must-have requirement, find the page where the person would see it working. It is met only when a page shows it and has the controls it needs; a heading or a label that only names it does not count. Quote what you saw as evidence, or say what is missing. A requirement that cannot show on a page at all (it is about what happens after a form is sent, or under the hood) is not yours to fail: mark it met with the evidence "not visible on a page: left to the tests and the Reviewer".
Then walk each journey through the pages, and score the change.
Answer with ONE fenced json block and nothing else, shaped exactly like:
{"requirements": [{"id": "R1", "met": false, "evidence": "The home page has no Contact link"}],
 "scores": {"function": 2, "design": 3, "content": 2},
 "problems": [{"where": "the page", "problem": "what a user would hit, concretely", "fix": "what to change"}]}
One entry per requirement, in order. Scores are whole numbers from 1 to 5. At most 12 problems, the worst first. Never ask for things the design of the change does not have.`,
};

const REPO_CRITIC_NOTE = [
  "These are the documents of a CHANGE to a product that already exists, not of a new product. Read the rubric that way:",
  "- screens: each one is a real place of the existing product, named the way the code map or the product names it, and the change sits where a user of the product would look for it. A change with nothing to see may have no screens; do not mark that down.",
  "- originality: the change fits this product as it is (its stack, its pages, its words) and is not a generic bolt-on.",
  "- buildable: one person could build it in this codebase on its own stack, without replacing what is there.",
].join("\n");

const str = (x: unknown, max = 600) => String(x ?? "").trim().slice(0, max);

/** The Planner's answer for a change to a codebase, checked. A plan in the app shape (the practice crew's) is read too: its tasks become the features. */
export function validateRepoPlan(j: unknown): Plan {
  const p = (j ?? {}) as Record<string, any>;
  const name = str(p.name, 120);
  const summary = str(p.summary, 600);
  if (!name) throw new Error('The plan is missing "name"');
  if (!summary) throw new Error('The plan is missing "summary"');
  const raw = Array.isArray(p.features) && p.features.length ? p.features : Array.isArray(p.tasks) ? p.tasks : [];
  const features = raw.filter((f: any) => f && (f.title || f.what)).slice(0, 8).map((f: any, i: number) => ({
    id: `F${i + 1}`, title: str(f.title ?? f.what, 120), what: str(f.what ?? f.title, 2400),
    files: (Array.isArray(f.files) ? f.files : []).map((x: unknown) => str(x, 200)).filter(Boolean).slice(0, 20),
    done: str(f.done, 600) || "It works when you run it, and every test that passed before still passes.",
  }));
  if (!features.length) throw new Error("The plan has no features");
  const acceptance = (Array.isArray(p.acceptance) ? p.acceptance : []).map((x: unknown) => str(x, 400)).filter(Boolean).slice(0, 12);
  if (!acceptance.length) throw new Error("The plan has no acceptance criteria");
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "change";
  return {
    name, slug, summary, interface: str(p.approach ?? p.interface, 2400) || summary, ui: "", cli: "", examples: [], app: false, repo: true,
    acceptance, features,
    tasks: features.map((f: { id: string; title: string }, i: number) => ({ id: f.id, title: f.title, dependsOn: i ? [features[i - 1].id] : [] })),
    files: [...new Set(features.flatMap((f: { files: string[] }) => f.files))] as string[],
    testing: str(p.tests ?? p.testing, 1200),
    risks: (Array.isArray(p.risks) ? p.risks : []).map((x: unknown) => str(x, 300)).filter(Boolean).slice(0, 8),
  };
}

/** The plan as the file every later session reads (.sf/SPEC.md). */
export function repoSpecMarkdown(ask: string, p: Plan, info: RepoRunInfo): string {
  return [
    `# ${p.name}`, "", `> ${ask.replace(/\n+/g, "\n> ")}`, "", `A change to ${info.name} (${info.source}), on branch \`${info.branch}\`.`, "", p.summary, "",
    "## Approach", "", p.interface, "",
    "## Features", "", ...(p.features ?? []).flatMap((f) => [`### ${f.id} ${f.title}`, "", f.what, "", f.files.length ? `Files: ${f.files.join(", ")}` : "", "", `Done when: ${f.done}`, ""]),
    "## Acceptance criteria", "", ...p.acceptance.map((a, i) => `${i + 1}. ${a}`), "",
    ...(p.testing ? ["## Tests", "", p.testing, ""] : []),
    ...(p.risks?.length ? ["## Risks", "", ...p.risks.map((r) => `- ${r}`), ""] : []),
    "Kept by SoftwareFactory under .sf/, which git leaves out: this file is not part of the repo.", "",
  ].join("\n");
}

/** The branch a run works on: the ticket's own when it came from one, else named by the run and the ask. */
export function repoBranch(run: string | number, ask: string, ticket?: { key: string }): string {
  const words = ask.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "") || "work";
  return ticket ? `sf/${ticket.key.startsWith("#") ? `ticket-${ticket.key.slice(1)}` : ticket.key}-${words}` : `sf/run-${run}-${words}`;
}

const key = (c: Pick<TestCase, "file" | "name">) => `${c.file}::${c.name}`;

export class RepoRun extends Run {
  private env: RepoEnv = { stack: [], tests: [], pathFirst: [], commands: [], notes: [], testHint: "" };
  private ref!: RepoRef;
  /** The commit the branch started from: every diff, and the test integrity guard, compare with it. */
  private base = "";
  private context = "";
  /** Tests that already failed before anything changed: they are not this run's work. */
  private failingBefore = new Set<string>();
  /** The fast checks (types, lint) already failed before the change, so they cannot judge it. */
  private gatesOff = "";
  private handed: Record<string, unknown> = {};

  constructor(x: Parameters<RunMaker>[0], private info: RepoRunInfo, private tools: RepoTools) {
    super(x.factory, x.log, x.runtime, x.id, x.idea, x.o, null);
    // The repo's tests belong to the repo: no Tester of ours may be asked to rewrite one that a Fixer disputes.
    this.disputed = true;
  }

  protected get asked(): string { return `In the existing product "${this.info.name}" (${this.info.source}) the person asks for this change: ${this.idea}`; }

  async go(from?: RestoredState) {
    try {
      if (from) this.restore(from);
      const done = from?.done ?? new Set<string>();
      if (!done.has("intake")) await this.station("intake", async () => { captureSignal(this.log, this.idea, "factory"); await this.prepare(); });
      else await this.prepare();
      if (!done.has("council")) await this.councilLoop();
      if (!done.has("discover")) await this.discoverLoop();
      if (!done.has("plan")) await this.planLoop(done.has("planWritten"));
      if (!done.has("tests")) await this.baselineTests();
      else this.failingBefore = new Set(((this.lastOf("factory.tests.locked")?.failingBefore ?? []) as string[]).map(String));
      if (!done.has("build")) await this.station("build", () => this.build());
      if (!done.has("reviewed")) {
        await this.testFixLoop("", !!from && from.done.has("build"));
        await this.reviewLoop();
        await this.evaluateLoop();
      } else if (!done.has("accepted")) await this.testFixLoop("", true);
      if (!done.has("accepted")) await this.acceptLoop();
      const sha = await this.station("ship", () => this.ship());
      const pr = this.handed.pr as { number: number; url: string } | undefined;
      // Kept on this computer: the ticket has the button that takes it (Tickets.send). A run with no ticket gets the one git line.
      const take = this.info.ticket ? `Press ${this.ref.github ? "Send to GitHub" : "Add to my folder"} on ticket ${this.info.ticket.key} when you want it there.` : `To take it into your repo: git fetch "${this.dir}" ${this.info.branch}`;
      this.finish("shipped", pr ? `The change is on branch ${this.info.branch}, as draft pull request #${pr.number}: ${pr.url}` : `The change is on branch ${this.info.branch} in ${this.dir}. ${this.handed.kept ?? ""} ${take}`.replace(/\s+/g, " "), sha);
    } catch (e) {
      this.finish(e instanceof StopRun ? "stopped" : "failed", (e as Error).message);
    }
  }

  private lastOf(type: string): Record<string, any> | undefined {
    return this.log.list({ type, sinceId: this.id - 1, limit: 1e6 }).map((e) => e.payload as Record<string, any>).filter((p) => p.run === this.id).at(-1);
  }

  /** The clone on its branch, SoftwareFactory's folder kept out of git, and the codebase's own tools ready. Safe to call again on a resume. */
  private async prepare() {
    const ref = repoOfProject(this.log, this.info.projectId);
    if (!ref) throw new Error(`The repo of this project (${this.info.source}) cannot be found any more.`);
    const gh = this.tools.github;
    // A repo with a working copy on this computer is cloned from there (it needs no sign-in); one that only
    // lives on GitHub is cloned from GitHub. Either way the pull request, if there is one, goes to GitHub.
    const local = existsSync(join(ref.dir, ".git"));
    const github = ref.github ?? parseGitHubRepo(ref.source) ?? undefined;
    this.ref = { ...(!local && ref.github && gh ? { ...ref, dir: gh.remote(ref.github) } : ref), ...(github ? { github } : {}) };
    const { dir, base } = prepareClone(local ? { ...this.ref, github: undefined } : this.ref, this.f.repoWorkDir, this.id, this.info.branch, !local && gh ? (d, ...a) => gh.git(d, ...a) : undefined, `run-${this.id}`);
    this.dir = dir;
    this.base = base;
    // The clone's own exclude file (never .gitignore, which is the repo's): our notes and anything a run or an install leaves behind.
    const exclude = join(dir, ".git", "info", "exclude");
    let cur = "";
    try { cur = readFileSync(exclude, "utf8"); } catch { /* none yet */ }
    const want = [`${SF_DIR}/`, ".venv/", "node_modules/", "__pycache__/"].filter((l) => !cur.split(/\r?\n/).some((x) => x.trim() === l));
    if (want.length) { mkdirSync(join(dir, ".git", "info"), { recursive: true }); writeFileSync(exclude, `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}${want.join("\n")}\n`); }
    mkdirSync(join(dir, SF_DIR), { recursive: true });
    this.env = await this.tools.prepareEnv(dir);
    this.context = this.describe();
    this.log.append("factory.repo", { run: this.id, source: this.info.source, name: this.info.name, branch: this.info.branch, base, dir, stack: this.env.stack, tests: this.env.testHint || null, starts: siteProfile(dir)?.command ?? null, notes: this.env.notes.slice(0, 8) });
  }

  /** What every agent that designs or plans is told about the codebase. */
  private describe(): string {
    let map: string | null = null;
    try { map = this.info.projectId != null ? codeMapSummary(this.log, this.info.projectId, 3500) : null; } catch { /* not an import with a map */ }
    if (!map) { try { map = mapText(scanRepo(this.dir), new Map(), 3000); } catch { map = null; } }
    const site = siteProfile(this.dir);
    return [
      `This is a change to a codebase that already exists, not a new app: "${this.info.name}" (${this.info.source}). The work happens on branch ${this.info.branch} of a clone; the folder you can read is that clone.`,
      `Its stack: ${this.env.stack.join(", ") || "not recognised"}. ${site ? `It starts with: ${site.command}.` : "SoftwareFactory found no way to start it as a site."} ${this.env.testHint ? `Its own tests run with: ${this.env.testHint}.` : "It has no tests SoftwareFactory can run."}${this.env.notes.length ? ` Not set up here: ${this.env.notes.join("; ")}.` : ""}`,
      map ? `The code map:\n${map}` : "",
      repoGuidance(this.dir, 3000).trim(),
    ].filter(Boolean).join("\n\n");
  }

  // ---------- what the engine is told differently here ----------

  protected background(): string { return this.context; }
  protected roleOf(m: CrewMember, bench: boolean): string {
    const contract = REPO_CONTRACTS[m.station];
    if (!contract) return m.role;
    return [m.role.split("Station contract:")[0].trim(), contract, bench ? this.benchContract() : ""].filter(Boolean).join("\n\n");
  }
  protected benchContract(): string {
    return workbenchContract({
      test: this.env.testHint || "the repo has no tests of its own yet: run the code you changed",
      protect: ["a test that is already there to make it pass (fix the code instead; add tests for new behaviour)", "anything under .sf/ or .git"],
      extra: [`Beyond those commands you may run here: ${this.env.commands.join(", ") || "nothing more"}. Dependencies are already installed; do not install any.`, this.env.notes.length ? `Not set up on this computer: ${this.env.notes.join("; ")}.` : ""].filter(Boolean).join("\n"),
    });
  }
  protected benchCommands(): string[] { return [...WORKBENCH_COMMANDS, ...this.env.commands]; }
  protected benchEnv(): { pathFirst?: string[] } { return this.env.pathFirst.length ? { pathFirst: this.env.pathFirst } : {}; }
  protected readsFolder(m: CrewMember): boolean { return m.station === "design" || m.station === "plan"; }
  protected isProtected(p: string): boolean { return p === SF_DIR || p.startsWith(`${SF_DIR}/`) || p === ".git" || p.startsWith(".git/"); }
  protected designPrompt(): string { return [`What the person asks for:\n${this.idea}`, this.context, this.recalled(), this.brief ? briefLine(this.brief) : ""].filter(Boolean).join("\n\n"); }
  protected readDocs(j: unknown): ProductDocs { return validateDocs(j, { change: true }); }
  protected critiqueFor(docs: ProductDocs, round: number, before?: Critique): string { return `${critiquePrompt(this.asked, docs, round, before)}\n\n${REPO_CRITIC_NOTE}\n\nThe codebase, as its map describes it:\n${this.context.slice(0, 4000)}`; }
  /** A change is designed from the code, not from the web: no research call. */
  protected async research(): Promise<Finding[]> { return []; }
  protected codeText(): string { return ""; }
  protected fileHashes(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of git(this.dir, "ls-files", "-co", "--exclude-standard").split("\n").filter(Boolean)) {
      try { const abs = join(this.dir, p); if (statSync(abs).size < 400_000) out[p] = createHash("sha256").update(readFileSync(abs)).digest("hex"); } catch { /* gone */ }
    }
    return out;
  }
  protected fixBrief(): { spec: string; where: string } {
    return {
      spec: `The change being built, as approved:\n${JSON.stringify({ name: this.plan.name, summary: this.plan.summary, approach: this.plan.interface, acceptance: this.plan.acceptance }, null, 2)}`,
      where: `You are in a clone of ${this.info.source} on branch ${this.info.branch}. The plan and the design of the change are under .sf/ (read only, not part of the repo).${this.env.testHint ? ` Its tests run with: ${this.env.testHint}.` : ""} See what changed so far with: git diff ${this.base}`,
    };
  }
  protected reviewBrief(): { prompt: string; verify: string } {
    let diff = "";
    try { diff = git(this.dir, "diff", "--no-color", this.base, "--", ".").slice(0, 40000); } catch { /* the Reviewer reads the folder */ }
    const site = siteProfile(this.dir);
    return {
      prompt: `The approved plan:\n${JSON.stringify({ name: this.plan.name, summary: this.plan.summary, approach: this.plan.interface, features: (this.plan.features ?? []).map((f) => `${f.id} ${f.title}`), acceptance: this.plan.acceptance }, null, 2)}\n\nThe diff against ${this.base}, where the work started (${this.info.source}, branch ${this.info.branch}):\n${diff || "(empty)"}`,
      verify: [
        "You also verify the change, not only read it. You have a shell in the clone (read and run only: do not change files).",
        `For EACH acceptance criterion below, check it by running something: ${this.env.testHint ? `the repo's tests (${this.env.testHint}), ` : ""}the code itself${site ? `, or the running site (start it in the background with \`${site.command}\`, read the address it prints, fetch its pages, then stop it)` : ""}.`,
        "Stop every process you start before you answer, and make the JSON your very last message: only the last message is read.",
        "Add to your JSON a \"criteria\" list, one entry per criterion in order: {\"text\": \"the criterion\", \"pass\": true|false, \"evidence\": \"what you ran and what you saw, short\"}. pass is true only when you saw it work.",
      ].join("\n"),
    };
  }
  protected acceptWord(): string { return `Accept the change (it is then handed over on branch ${this.info.branch}${this.ref?.github ? ", as a draft pull request when GitHub access allows" : ""}; never on the main line)`; }
  protected finishExtra(): Record<string, unknown> { return { repo: { source: this.info.source, branch: this.info.branch, ...(this.base ? { base: this.base } : {}), ...this.handed } }; }

  // ---------- stations ----------

  protected async planLoop(written = false) {
    let feedback = "";
    for (;;) {
      if (written) written = false;
      else await this.station("plan", async () => {
        const planner = this.one("plan");
        const ask = [
          `What the person asks for:\n${this.idea}`, this.context, this.recalled(),
          this.docs ? repoDocsForPlanner(this.docs) : "",
          feedback ? `The person reviewed your last plan and said: ${feedback}\nRevise the plan accordingly.` : "",
        ].filter(Boolean).join("\n\n");
        let plan = validateRepoPlan(parseJsonBlock(await this.ask(planner, ask)));
        // Nothing the person asked for may fall out of the plan: a second agent lists what it misses, the Planner adds it once.
        if (!feedback) {
          const missing = await this.planGaps(plan);
          if (missing.length) {
            let added = false;
            try {
              plan = validateRepoPlan(parseJsonBlock(await this.ask(planner, `What the person asks for:\n${this.idea}\n\nYour plan:\n${JSON.stringify(plan, null, 2)}\n\nIt leaves out these things the person asked for:\n${missing.map((x) => `- ${x}`).join("\n")}\n\nReturn the whole plan again in the same JSON shape with each of them added: as acceptance criteria, and in the features that build them. Keep everything else.`)));
              added = true;
            } catch (e) { if (e instanceof StopRun) throw e; /* the first plan stands; the gaps are on the record */ }
            finally { this.log.append("factory.plan.gaps", { run: this.id, missing, added }); }
          }
        }
        // The practice crew answers every plan with the same sample: name it after the ask, so a free walk of the route reads right.
        if (this.runtime.name === "mock") {
          const name = (this.info.ticket?.title || this.idea.split("\n")[0]).slice(0, 80);
          plan = {
            ...plan, name, summary: "Practice crew: this plan stands in for a real one. Switch to the real crew in Systems to have the change planned from the code.", interface: "Practice crew: nothing was read from the code.", files: [], testing: "", risks: [],
            features: [{ id: "F1", title: name, what: this.idea.split("\n")[0].slice(0, 600), files: [], done: "The practice crew leaves a note file for the change on the branch." }],
            tasks: [{ id: "F1", title: name, dependsOn: [] }],
            acceptance: ["Practice crew: a note file for the change is on the branch.", "What worked before still works."],
          };
        }
        this.plan = plan;
        // The plan and the design live in the clone for every later session, under .sf/: never on the branch.
        writeFiles(this.dir, [
          { path: `${SF_DIR}/SPEC.md`, content: repoSpecMarkdown(this.idea, plan, this.info) },
          ...(this.docs ? docsFiles(this.asked, this.docs, this.docsCritique).map((f) => ({ ...f, path: f.path.replace(/^docs\/product\//, `${SF_DIR}/product/`) })) : []),
        ], { lockTests: false });
        this.log.append("factory.plan", { run: this.id, plan, dir: this.dir, sha: this.base, written: [], repo: { source: this.info.source, branch: this.info.branch } });
      });
      const d = await this.gate("gateA", "Approve the plan for this change");
      this.verdict(this.one("plan"), "plan", d.approve, undefined, d.note);
      if (d.approve) return;
      if (!d.note) throw new StopRun("You rejected the plan.");
      feedback = d.note;
    }
  }

  /**
   * Where a first build has the Tester write locked tests, a codebase has tests of its own. They are run once
   * before anything changes: what passes now must pass after every feature, and what already fails is noted
   * so it is never blamed on this run. The types and lint checks get the same first look.
   */
  private async baselineTests() {
    this.mark("tests", "active", undefined, this.env.testHint ? `running the repo's own tests (${this.env.testHint}) before anything changes` : undefined);
    // The same checks every later round runs, on the files the plan means to touch, before any of them changed.
    const gates = await harnessChecks().gates!(this.dir, [...new Set([...this.plan.files, "package.json"])]);
    if (!gates.ok) this.gatesOff = "the types or lint checks already failed before the change";
    if (!this.env.tests.length) {
      this.log.append("factory.tests.locked", { run: this.id, hash: "", files: [], sha: this.base, kept: "repo", baseline: null, failingBefore: [], ...(this.gatesOff ? { gatesOff: this.gatesOff } : {}) });
      this.mark("tests", "skipped", undefined, `This repo has no tests SoftwareFactory can run here${this.env.notes.length ? ` (${this.env.notes[0]})` : ""}. Each feature brings tests for what it adds.`);
      return;
    }
    const t = await this.tools.runTests(this.dir, this.env);
    this.failingBefore = new Set(t.cases.filter((c) => !c.pass).map(key));
    this.log.append("factory.tests.locked", { run: this.id, hash: "", files: [...new Set(t.cases.map((c) => c.file).filter(Boolean))].slice(0, 200), sha: this.base, kept: "repo", baseline: { passed: t.passed, failed: t.failed, command: this.env.testHint }, failingBefore: [...this.failingBefore].slice(0, 500), ...(this.gatesOff ? { gatesOff: this.gatesOff } : {}) });
    this.mark("tests", "pass", undefined, `The repo's own tests before the change: ${t.passed} pass${t.failed ? `, ${t.failed} already fail (not held against this run)` : ""}.`);
  }

  /** The plan's features as build work. A small run, or a crew without a workbench, builds them in one session. */
  private featureList(): Feature[] {
    const all = (this.plan.features ?? []).map((f) => ({ id: f.id, title: f.title, what: `${f.what}${f.files.length ? `\nFiles it touches or adds: ${f.files.join(", ")}` : ""}`, done: f.done, state: "todo" as const }));
    if (this.bench && this.o.maxUsd >= FEATURE_LOOP_MIN_USD && all.length > 1) return all;
    return [{ id: "F1", title: all.length > 1 ? "The whole change" : all[0]?.title ?? "The change", what: all.map((f) => (all.length > 1 ? `${f.id} ${f.title}: ${f.what}` : f.what)).join("\n\n"), done: all.length > 1 ? "Every part above works, and every test that passed before still passes." : all[0]?.done ?? "It works.", state: "todo" }];
  }

  private featurePrompt(features: Feature[], f: Feature, retry: string): string {
    const i = features.indexOf(f);
    return [
      `You are building "${this.plan.name}" in an existing codebase (${this.info.source}), on branch ${this.info.branch}. ${features.length > 1 ? `This call builds ONE feature (${f.id}, number ${i + 1} of ${features.length}); other calls, each starting fresh like you, build the rest.` : "This call builds the whole change."}`,
      `Read first, under .sf/ (SoftwareFactory's notes, not part of the repo): SPEC.md (the approved plan)${this.docs ? ", product/ (the design of the change: brief, journeys, screens, requirements and rules)" : ""}, features.json and PROGRESS.md (what earlier calls built and want you to know). Then read only the code your work touches.`,
      `Your work, ${f.id}: ${f.title}\n${f.what}`,
      `Done means: ${f.done}`,
      [
        "Rules:",
        "- Build only this, completely, in the style of the code around it. The smallest change that does it.",
        `- Keep everything that works working: no test that passed before your call may fail after it. Add or extend tests for the behaviour you add${this.env.testHint ? ` (the repo's tests run with ${this.env.testHint})` : ""}; never delete, skip or weaken a test that is there.`,
        "- Do not write under .sf/: the core keeps those files.",
        "- Work in few steps, because every step re-sends everything you have read so far: read the files you need in one command, write each file in one go, and run the tests once at the end (once more after a fix). Keep command output short (tail it).",
        "- End your answer with two or three lines for the next call: what you built, and anything it must know.",
      ].join("\n"),
      retry ? `Your last attempt at this was not accepted:\n${retry}\nFix that first.` : "",
    ].filter(Boolean).join("\n\n");
  }

  /**
   * The build loop of features.ts in a clone: one fresh session per feature, the repo's own tests after each
   * (a test that passed before and fails now sends the feature back once, with that evidence), a commit on the
   * branch, and a progress note for the next session. A retried build picks up at the first feature not built.
   */
  protected async build() {
    const builder = this.builder = this.one("build");
    const features = this.featureList();
    const path = join(this.dir, SF_DIR, "features.json");
    try {
      const kept = (JSON.parse(readFileSync(path, "utf8")).features ?? []) as { id: string; state: string }[];
      for (const f of features) if (kept.find((k) => k.id === f.id)?.state === "built") f.state = "built";
    } catch { /* first time */ }
    const progress = join(this.dir, SF_DIR, "PROGRESS.md");
    if (!existsSync(progress)) writeFileSync(progress, "# Progress\n\nOne entry per feature, written by SoftwareFactory after each build session.\n\n");
    const buildStart = this.spent;
    const suite = async () => (this.env.tests.length ? this.tools.runTests(this.dir, this.env) : null);
    let passing = new Set(((await suite())?.cases ?? []).filter((c) => c.pass).map(key));
    let wroteAny = features.some((f) => f.state === "built");
    for (let i = 0; i < features.length; i++) {
      const f = features[i];
      if (f.state === "built") continue;
      let retry = "";
      for (let attempt = 1; attempt <= 2; attempt++) {
        writeFileSync(path, featuresFile(features, f.id));
        const left = features.filter((x) => x.state !== "built").length;
        const cap = Math.min(featureCapUsd(builder.budgetUsd, this.o.maxUsd), Math.max(FEATURE_MIN_USD, (this.o.maxUsd * BUILD_BUDGET_SHARE - (this.spent - buildStart)) / left));
        this.log.append("factory.feature", { run: this.id, id: f.id, title: f.title, index: i + 1, of: features.length, state: "building", attempt, capUsd: Number(cap.toFixed(3)) });
        const text = await this.askBench(builder, this.featurePrompt(features, f, retry), { round: i + 1 }, { capUsd: cap, raiseCap: cap > builder.budgetUsd });
        const res = this.takeWork(text);
        const files = res.written.map((w) => w.path);
        const t = await suite();
        const now = new Set((t?.cases ?? []).filter((c) => c.pass).map(key));
        const broke = [...passing].filter((k) => !now.has(k));
        if (t) { f.passed = t.passed; f.total = t.passed + t.failed; }
        f.state = !files.length ? "empty" : broke.length ? "regressed" : "built";
        if (files.length) { wroteAny = true; this.log.append("factory.files", { run: this.id, station: "build", round: i + 1, ...res, ...(this.bench ? { workbench: true } : {}) }); }
        this.log.append("factory.feature", { run: this.id, id: f.id, title: f.title, index: i + 1, of: features.length, state: f.state, attempt, files: files.slice(0, 40), passed: t?.passed ?? 0, failed: t?.failed ?? 0, ...(broke.length ? { broke: broke.slice(0, 10) } : {}) });
        if (f.state === "regressed" && attempt === 1) {
          retry = `These tests of the repo passed before your call and fail after it:\n${broke.slice(0, 10).map((k) => `- ${k.replace(/^::/, "").replace("::", ": ")}`).join("\n")}\n\n${(t?.output ?? "").slice(-1500)}`;
          continue;
        }
        passing = now;
        writeFileSync(progress, readFileSync(progress, "utf8") + progressEntry(f, text, files));
        writeFileSync(path, featuresFile(features));
        commitAll(this.dir, `${this.plan.name}: ${f.title}${f.state === "built" ? "" : ` (${f.state})`}\n\nBuilt by SoftwareFactory's crew, run #${this.id}, feature ${f.id}.`);
        break;
      }
    }
    if (!wroteAny) throw new Error("The Builder changed no file");
  }

  /** What an agent left in the clone: the files it changed there, and any whole files it answered as text blocks. Nothing under .sf/ or .git is taken. */
  protected takeWork(text: string): ReturnType<typeof writeFiles> {
    const blocks = parseFileBlocks(text);
    const res = writeFiles(this.dir, blocks.filter((b) => !this.isProtected(b.path)), { lockTests: false });
    res.refused.push(...blocks.filter((b) => this.isProtected(b.path)).map((b) => ({ path: b.path, reason: "SoftwareFactory's own folder: not part of the repo" })));
    const fromBlocks = new Set(res.written.map((w) => w.path));
    res.written.push(...writtenOnDisk(this.dir, changedFiles(this.dir).filter((p) => !fromBlocks.has(p) && !this.isProtected(p))));
    return res;
  }

  /** Files that differ from where the branch started, committed or not. */
  private changedSinceBase(): string[] {
    const tracked = git(this.dir, "diff", "--name-only", this.base).split("\n").filter(Boolean);
    const fresh = git(this.dir, "ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean);
    return [...new Set([...tracked, ...fresh])];
  }

  /**
   * The verdict on the branch as it stands: the fast checks over what changed, the repo's own tests (minus
   * what already failed before the change), no secret in a changed file, and the tests left intact.
   */
  protected async runSuite(round: number): Promise<TestRun> {
    const changed = this.changedSinceBase();
    if (!this.gatesOff) {
      const g = await harnessChecks().gates!(this.dir, changed);
      this.log.append("factory.fastgate", { run: this.id, round, gate: "types and lint", state: g.ok ? "pass" : "fail", messages: g.ok ? [] : g.output.split("\n").slice(0, 20) });
      if (!g.ok) {
        const failed: TestRun = { cases: [{ name: "fast check: types and lint", file: changed[0] ?? "", pass: false, error: g.output, durationMs: 0 }], passed: 0, failed: 1, exitCode: 1, timedOut: false, output: g.output };
        this.log.append("factory.tests", { run: this.id, round, cases: failed.cases, passed: 0, failed: 1, timedOut: false });
        return failed;
      }
    }
    const r: TestRun = this.env.tests.length ? await this.tools.runTests(this.dir, this.env) : { cases: [], passed: 0, failed: 0, exitCode: 0, timedOut: false, output: "" };
    const old = r.cases.filter((c) => !c.pass && this.failingBefore.has(key(c)));
    r.cases = r.cases.filter((c) => !old.includes(c));
    if (old.length) r.cases.push({ name: `${old.length} test${old.length === 1 ? "" : "s"} that already failed before this change (not held against it)`, file: "", pass: true, durationMs: 0 });
    if (!this.env.tests.length) r.cases.push({ name: "the repo has no tests SoftwareFactory can run here", file: "", pass: true, durationMs: 0 });
    const texts: Record<string, string> = {};
    for (const p of changed) { try { const abs = join(this.dir, p); if (statSync(abs).isFile() && statSync(abs).size < 400_000) texts[p] = readFileSync(abs, "utf8"); } catch { /* deleted */ } }
    const secrets = scanFiles(texts);
    r.cases.push({ name: "no secrets in the change (API keys, tokens, private keys)", file: secrets[0]?.file ?? "", pass: !secrets.length, durationMs: 0, ...(secrets.length ? { error: describeSecrets(secrets) } : {}) });
    if (secrets.length) r.output = `Secret check:\n${describeSecrets(secrets)}\nRead keys from an environment variable instead.\n\n${r.output}`.slice(0, 6000);
    const gamed = testIntegrity(this.dir, this.base);
    r.cases.push({ name: "the repo's tests left intact (none deleted, moved or skipped)", file: "", pass: !gamed.length, durationMs: 0, ...(gamed.length ? { error: describeIntegrity(gamed) } : {}) });
    if (gamed.length) r.output = `Test integrity:\n${describeIntegrity(gamed)}\nFix the code, not the tests.\n\n${r.output}`.slice(0, 6000);
    r.passed = r.cases.filter((c) => c.pass).length;
    r.failed = r.cases.length - r.passed;
    this.log.append("factory.tests", { run: this.id, round, cases: r.cases.slice(0, 400), passed: r.passed, failed: r.failed, timedOut: r.timedOut });
    return r;
  }

  /**
   * The product judge on a codebase's site: the core starts it the way the Run tab would, reads its pages,
   * and the judge checks the change's requirements against what they show. A site that cannot be started
   * here is said plainly and skips the station: the Reviewer's run of the criteria is then what stands.
   */
  protected async evaluateLoop() {
    const skip = (why: string) => { this.mark("evaluate", "skipped", undefined, why); };
    const docs = this.docs;
    if (!docs || !mustRequirements(docs).length) return skip("No design of the change to judge it against");
    for (let round = 1; round <= MAX_EVALUATION_ROUNDS; round++) {
      if (this.o.maxUsd - this.spent < 0.1) return round === 1 ? skip("Not enough of the budget left for the product judge") : undefined;
      const site = await this.tools.readSite(this.dir, { pathFirst: this.env.pathFirst }).catch((e) => ({ skipped: String((e as Error).message) }));
      if ("skipped" in site) {
        this.log.append("factory.evaluation", { run: this.id, round, pass: false, skipped: site.skipped });
        return round === 1 ? skip(`The product judge could not look: ${site.skipped}. The Reviewer's check of the acceptance criteria stands.`) : undefined;
      }
      const ev = await this.station("evaluate", async () => {
        const judge = this.one("evaluate");
        let e: Evaluation;
        try { e = validateEvaluation(parseJsonBlock(await this.ask(judge, evaluationPrompt(this.asked, docs, site.screens, round), { round }, { capUsd: Math.max(0.1, this.o.maxUsd * 0.08) })), docs); }
        catch (err) { if (!(err instanceof StopRun)) this.verdict(judge, "evaluate", false, round, (err as Error).message); throw err; }
        const pass = evaluationPasses(e);
        this.verdict(judge, "evaluate", true, round);
        if (this.builder) this.verdict(this.builder, "product", pass, round, pass ? undefined : e.requirements.find((r) => !r.met)?.evidence ?? e.problems[0]?.problem);
        this.log.append("factory.evaluation", { run: this.id, round, pass, bar: PRODUCT_PASS_SCORE, screens: site.screens.length, ...e });
        return { e, pass };
      }, round);
      this.evaluation = ev.e;
      if (ev.pass || round === MAX_EVALUATION_ROUNDS) return;
      // Not worth starting a fix it cannot finish: the person sees what is open at the build gate.
      if (this.o.maxUsd - this.spent < 0.3) return;
      await this.testFixLoop(evaluationFeedback(ev.e, docs).replace("docs/product/", `${SF_DIR}/product/`), true);
    }
  }

  /** Hand the branch over: a draft pull request when GitHub access allows, else it waits in the clone. Never the main line. */
  protected async ship(): Promise<string> {
    commitAll(this.dir, `${this.plan.name}: last changes\n\nBuilt by SoftwareFactory's crew, run #${this.id}.`);
    const files = git(this.dir, "diff", "--name-only", `${this.base}..HEAD`).split("\n").filter(Boolean);
    if (!files.length) throw new Error("Nothing changed on the branch, so there is nothing to hand over.");
    const sha = git(this.dir, "rev-parse", "--short", "HEAD");
    const unmet = this.reviewNotes?.criteria?.filter((c) => !c.pass) ?? [];
    const body = [
      `${this.plan.summary}`, "",
      `Asked for in SoftwareFactory${this.info.ticket ? ` (ticket ${this.info.ticket.key})` : ""}: ${this.idea.split("\n")[0].slice(0, 300)}`, "",
      "## What was built", "", ...(this.plan.features ?? []).map((f) => `- ${f.title}`), "",
      "## Acceptance criteria", "", ...this.plan.acceptance.map((a) => `- ${unmet.some((c) => c.text === a) ? "[ ]" : "[x]"} ${a}`), "",
      `Changed ${files.length} file${files.length === 1 ? "" : "s"}. ${this.env.testHint ? `The repo's own tests (${this.env.testHint}) pass.` : "The repo has no tests SoftwareFactory could run."}`, "",
      "_Opened as a draft by SoftwareFactory's crew after a design, a plan you approved, a review and your acceptance of the build. It never pushes to the main line; merging is your call._",
    ].join("\n");
    let out: ShippedBranch;
    try { out = await this.tools.ship({ run: this.id, ref: this.ref, dir: this.dir, branch: this.info.branch, base: this.base, title: `${this.info.ticket ? `${this.info.ticket.key}: ` : ""}${this.plan.name}`, body }); }
    catch (e) { out = { kept: hideTokens(`A pull request could not be opened: ${(e as Error).message}`) }; }
    this.handed = { sha, files: files.slice(0, 200), ...("pr" in out ? { pr: out.pr } : { kept: out.kept }) };
    this.log.append("factory.branch", { run: this.id, source: this.info.source, dir: this.dir, branch: this.info.branch, base: this.base, ...this.handed });
    return sha;
  }
}

const briefLine = (b: { agreed: string[]; proposals: string[]; concerns: string[] }) =>
  ["The Council looked at the ask first.", b.agreed.length ? `Agreed: ${b.agreed.join("; ")}.` : "", b.proposals.length ? `Proposed: ${b.proposals.join("; ")}.` : "", b.concerns.length ? `Concerns: ${b.concerns.join("; ")}.` : ""].filter(Boolean).join(" ");

/** The design of the change as the Planner reads it. */
export function repoDocsForPlanner(d: ProductDocs): string {
  return [
    "The design of the change (written and reviewed before you; the plan implements it):",
    `Who it is for: ${d.brief.who}`, `What they cannot do today: ${d.brief.problem}`, `What the change gives them: ${d.brief.promise}`,
    d.brief.notThis.length ? `Left alone on purpose: ${d.brief.notThis.join("; ")}` : "",
    d.journeys.length ? `Journeys:\n${d.journeys.map((j) => `- ${j.moment} (${j.goal}): ${j.steps.join(" → ")}`).join("\n")}` : "",
    d.screens.length ? `The places it adds or changes:\n${d.screens.map((s) => `- ${s.id} "${s.name}": ${s.purpose} Shows: ${s.shows.join("; ")}. Actions: ${s.actions.join("; ")}.`).join("\n")}` : "",
    `Requirements:\n${d.requirements.map((r) => `- ${r.id}${r.must ? "" : " (nice to have)"}: ${r.text}`).join("\n")}`,
    d.rules.length ? `Rules (implement them exactly; each needs a test):\n${d.rules.map((r) => `- ${r.name ? `${r.name}: ` : ""}${r.rule}`).join("\n")}` : "",
    d.assumptions.length ? `Assumed: ${d.assumptions.join("; ")}` : "",
  ].filter(Boolean).join("\n\n");
}

/** Push the branch and open a draft pull request, when the crew may: the real crew, a token that can write, a repo on GitHub. */
export function githubShipper(gh: GitHub | undefined, canShip?: () => string | null): RepoTools["ship"] {
  return async (b) => {
    if (!b.ref.github) return { kept: "The repo is not on GitHub, so nothing is pushed." };
    const why = !gh ? "GitHub access is not set up in this core." : canShip?.() ?? (gh.hasToken() ? null : "No GitHub access yet: add a token in Systems, GitHub access, and the next run opens a pull request.");
    if (why) return { kept: why };
    let baseBranch = "main";
    try { baseBranch = gh!.git(b.dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").replace(/^origin\//, ""); } catch { /* main */ }
    const pr = await gh!.openPr({ repo: b.ref.github, dir: b.dir, branch: b.branch, base: baseBranch, title: b.title.slice(0, 200), body: b.body.slice(0, 6000) });
    return { pr: { number: pr.number, url: pr.url, repo: `${b.ref.github.owner}/${b.ref.github.name}` } };
  };
}

export interface RepoRuns {
  /** Start an engine run for `ask` in the project's repo. Throws when the project has none. Returns the run id at once. */
  start(projectId: number, ask: string, opts?: Pick<RunOptions, "maxUsd" | "autoApprove" | "autoRetries" | "models" | "council"> & { ticket?: { id: number; key: string; title?: string } }): { run: number; branch: string };
}

/**
 * Teach a factory to run its engine in existing codebases: registers the "repo" kind (so a resume builds the
 * right run again) and returns the one way to start such a run.
 */
export function enableRepoRuns(factory: Factory, log: EventLog, tools: Partial<RepoTools> = {}): RepoRuns {
  const all: RepoTools = {
    prepareEnv: tools.prepareEnv ?? ((dir) => prepareEnv(dir)),
    runTests: tools.runTests ?? ((dir, env) => runRepoTests(dir, env)),
    readSite: tools.readSite ?? readSite,
    ship: tools.ship ?? (async () => ({ kept: "This core has no GitHub access set up, so the branch stays on this computer." })),
    github: tools.github,
  };
  factory.kinds.set("repo", (x) => new RepoRun(x, x.started.repo as RepoRunInfo, all));
  return {
    start(projectId, ask, opts = {}) {
      const ref = repoOfProject(log, projectId);
      if (!ref) throw new Error("This project has no repo to work in. Import one, or link a GitHub repo to it.");
      const name = (log.db.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name?: string } | undefined)?.name ?? ref.source;
      // The branch carries the run's number, which is only known once the run exists: a short stamp stands in for it.
      const stamp = Date.now().toString(36).slice(-5);
      const branch = repoBranch(stamp, opts.ticket?.title || ask, opts.ticket);
      const info: RepoRunInfo = { projectId, source: ref.source, name, branch, ...(opts.ticket ? { ticket: opts.ticket } : {}) };
      const { ticket: _t, ...runOpts } = opts;
      return { run: factory.launch("repo", ask, { repo: info }, { ...runOpts, projectId }), branch };
    },
  };
}
