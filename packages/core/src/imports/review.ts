import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EventLog } from "../events.js";
import type { AgentRuntime } from "../runtime.js";
import { READ_TOOLS } from "../runtime.js";
import { runAgent } from "../agents.js";
import { kitArgs, type CrewSource } from "../factory/crew.js";
import { commitAll, git } from "../factory/workspace.js";
import { parseGitHubRepo, type GitHub } from "../tickets/github.js";
import { mapText } from "./crew.js";
import { gatherEvidence, type Evidence, type EvidenceTools } from "./evidence.js";
import { importOf, latestMap, listImports, moduleNotes, suggestionsOf, type ExploreMode, type ExploreResult, type RepoExplorer } from "./explorer.js";
import {
  BRIEF_PATH, briefForAgents, briefMarkdown, heuristicUnderstanding, heuristicVerdict, inspectPrompt, parseRevision, parseUnderstanding, parseVerdict,
  revisePrompt, verdictPrompt, withStepIds, type OwnerNote, type Understanding, type RepoVerdict,
} from "./reviewcrew.js";
import { scanRepo, type CodeMap } from "./scan.js";
import "./reviewTables.js";

/**
 * The deep review of an imported repo (docs/review.md; Assaf, 16 Nov 2026: "when importing a git repo I
 * want our agents to run it, analyse it and give a verdict ... then suggest what to do next").
 *
 * It starts by itself after a repo's first exploration and never asks the person anything first: they may
 * not know the repo either. The crew reverse-engineers it:
 *
 *   copy     a copy of the repo of SoftwareFactory's own, so installing and running never touch the
 *            import or the person's folder;
 *   read     routes, outside services, settings and risky lines, straight from the code (free);
 *   run      install, its own tests, its site started and its pages opened, its packages looked up (free);
 *   inspect  the Inspector reads the code and says what the app is: purpose, users, features, flow, data;
 *   verdict  the Assessor scores it (code health, fit with its purpose, cost to fix), says keep, refactor
 *            or rewrite, advises on the stack, lists where the flow falls short, and writes next steps;
 *   brief    all of it as one Markdown file for whoever works on the repo next.
 *
 * Next steps become suggestions in the Council's queue: tickets only when the person approves them.
 * After the first round the person can press Interview me (the Assessor's hard questions) or correct any
 * single point; Update the verdict then has the Assessor rewrite both with what they said. A review runs
 * again only when it is pressed. Spend is capped per review ($1.50 unless changed in the review's settings).
 */

export type ReviewTrigger = "import" | "manual" | "update";
export type ReviewStation = "copy" | "read" | "install" | "tests" | "site" | "deps" | "inspect" | "verdict" | "brief";
export const REVIEW_STATIONS: ReviewStation[] = ["copy", "read", "install", "tests", "site", "deps", "inspect", "verdict", "brief"];

export interface ReviewRow {
  id: number; projectId: number; ts: string; trigger: ReviewTrigger; mode: ExploreMode; status: "running" | "done" | "failed";
  capUsd: number; spentUsd: number; head: string | null;
  stations: { station: ReviewStation; state: "active" | "pass" | "fail" | "skipped"; note: string | null; spentUsd: number | null; ts: string }[];
  evidence: Evidence | null; understanding: Understanding | null; understoodBy: string | null; verdict: RepoVerdict | null; verdictBy: string | null;
  brief: string | null; error: string | null; endedAt: string | null;
}

export interface RepoReviewResult { projectId: number; review: number; outcome: "done" | "failed"; spentUsd: number; error?: string }

export interface ReviewerOptions {
  /** Cap for one review, USD. */
  maxUsd?: number;
  /** What gathering evidence does through the computer; tests replace it. */
  tools?: Partial<EvidenceTools>;
  /** For sending the brief to a GitHub repo as a draft pull request. */
  github?: GitHub;
  canShip?: () => string | null;
  /** Reviews install and run the app. Off: they only read it. */
  run?: boolean;
}

export const REVIEW_DEFAULT_USD = 1.5;
export const REVIEW_MIN_USD = 0.2;
export const REVIEW_MAX_USD = 10;

const parse = <T,>(x: string | null): T | null => { try { return x ? (JSON.parse(x) as T) : null; } catch { return null; } };
const toReview = (r: Record<string, any>): ReviewRow => ({
  id: Number(r.id), projectId: Number(r.project_id), ts: r.ts, trigger: r.trigger, mode: r.mode, status: r.status, capUsd: Number(r.cap_usd), spentUsd: Number(r.spent_usd), head: r.head,
  stations: parse(r.stations) ?? [], evidence: parse(r.evidence), understanding: parse(r.understanding), understoodBy: r.understood_by, verdict: parse(r.verdict), verdictBy: r.verdict_by,
  brief: r.brief, error: r.error, endedAt: r.ended_at,
});

const hasTable = (log: EventLog) => !!log.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'repo_reviews'").get();

/** The newest review of a project, or the newest that has a verdict. */
export function latestReview(log: EventLog, projectId: number, o: { withVerdict?: boolean } = {}): ReviewRow | null {
  if (!hasTable(log)) return null;
  const r = log.db.prepare(`SELECT * FROM repo_reviews WHERE project_id = ?${o.withVerdict ? " AND verdict IS NOT NULL" : ""} ORDER BY id DESC LIMIT 1`).get(projectId) as Record<string, any> | undefined;
  return r ? toReview(r) : null;
}

export function reviewNotes(log: EventLog, projectId: number): OwnerNote[] {
  if (!hasTable(log)) return [];
  return (log.db.prepare("SELECT * FROM repo_review_notes WHERE project_id = ? ORDER BY id").all(projectId) as Record<string, any>[])
    .map((r) => ({ id: Number(r.id), kind: r.kind, about: r.about, question: r.question, text: r.text, ts: r.ts, applied: r.applied == null ? null : Number(r.applied) }));
}

/**
 * What the review knows about a project, short enough for a working agent's prompt: the ticket Builder and
 * the engine's Designer and Planner start from it. Empty when the project has no verdict yet.
 */
export function reviewBrief(log: EventLog, projectId: number | null | undefined, maxChars = 2600): string {
  if (projectId == null) return "";
  let r: ReviewRow | null = null;
  try { r = latestReview(log, projectId, { withVerdict: true }); } catch { return ""; }
  if (!r?.understanding || !r.verdict) return "";
  return `\n\nWhat this app is (from SoftwareFactory's review of the repo${r.head ? ` at ${r.head.slice(0, 7)}` : ""}; the full brief is ${BRIEF_PATH} when the repo has it):\n${briefForAgents(r.understanding, r.verdict, reviewNotes(log, projectId), maxChars)}`;
}

export class RepoReviewer {
  private running = new Map<number, Promise<RepoReviewResult>>();
  /** Review a repo by itself when it is first imported. */
  auto = true;
  /** What the person said their main stack is, for the Assessor's stack advice. */
  homeStack = "";

  constructor(private log: EventLog, private runtime: AgentRuntime | null, private explorer: RepoExplorer, private crew?: CrewSource, readonly opts: ReviewerOptions = {}) {}

  get maxUsd() { return this.opts.maxUsd ?? Number(process.env.SF_REVIEW_MAX_USD ?? REVIEW_DEFAULT_USD); }
  set maxUsd(v: number) { this.opts.maxUsd = v; }
  mode(): ExploreMode { return this.explorer.mode(); }
  busy(projectId: number) { return this.running.has(projectId); }
  async idle() { while (this.running.size) await Promise.allSettled([...this.running.values()]); }

  /** The copy a project is reviewed in: SoftwareFactory's own, beside the imports. */
  copyDir(projectId: number) { return join(this.explorer.importsDir, ".reviews", String(projectId)); }

  /**
   * A fresh import reviews itself once its first exploration is done. `review: false` skips it (the person
   * can still press Review); `maxUsd` caps this one.
   */
  afterImport(r: { projectId: number; existing: boolean; done: Promise<ExploreResult> }, o: { review?: boolean; maxUsd?: number } = {}) {
    if (r.existing || o.review === false || (!this.auto && o.review !== true)) return;
    r.done.then((x) => { if (x.outcome !== "failed" && !latestReview(this.log, r.projectId)) return this.review(r.projectId, { trigger: "import", maxUsd: o.maxUsd }); }).catch((e) => console.error("the review after an import failed:", e));
  }

  /** Review the repo from the start: copy, read, run, inspect, verdict, brief. */
  review(projectId: number, o: { maxUsd?: number; trigger?: ReviewTrigger } = {}): Promise<RepoReviewResult> {
    const busy = this.running.get(projectId);
    if (busy) return busy;
    if (!importOf(this.log, projectId)) return Promise.reject(new Error(`Project #${projectId} was not imported from a repo`));
    return this.guard(projectId, o.trigger ?? "manual", o.maxUsd ?? this.maxUsd, (id, cap) => this.reviewNow(projectId, id, cap));
  }

  /**
   * Rewrite the understanding and the verdict with what the owner said since: nothing is installed, run or
   * re-read, so it costs a fraction of a review. Throws when there is no verdict to update.
   */
  update(projectId: number, o: { maxUsd?: number } = {}): Promise<RepoReviewResult> {
    const busy = this.running.get(projectId);
    if (busy) return busy;
    const last = latestReview(this.log, projectId, { withVerdict: true });
    if (!last?.understanding || !last.verdict || !last.evidence) return Promise.reject(new Error("There is no verdict to update yet: press Review this repo first."));
    const cap = o.maxUsd ?? Number(Math.max(REVIEW_MIN_USD, this.maxUsd * 0.3).toFixed(2));
    return this.guard(projectId, "update", cap, (id, c) => this.updateNow(projectId, id, c, last));
  }

  /** The owner answers the Assessor's questions. Saved at once; the verdict changes on the next update. */
  answer(projectId: number, answers: { questionId: string; answer: string }[]): OwnerNote[] {
    const last = latestReview(this.log, projectId, { withVerdict: true });
    if (!last?.verdict) throw new Error("There are no questions yet: the review has not reached a verdict.");
    for (const a of answers) {
      const text = String(a.answer ?? "").trim().slice(0, 2000);
      const q = last.verdict.questions.find((x) => x.id === a.questionId);
      if (!text || !q) continue;
      this.log.append("repo.review.answered", { projectId, review: last.id, questionId: q.id, question: q.question, answer: text });
    }
    return reviewNotes(this.log, projectId);
  }

  /** The owner corrects one point of the review ("purpose", "feature: Contact form", "recommendation"...). */
  correct(projectId: number, c: { about: string; was?: string; text: string }): OwnerNote[] {
    const text = String(c.text ?? "").trim().slice(0, 2000);
    const about = String(c.about ?? "").trim().slice(0, 120);
    if (!text) throw new Error("Say what is right.");
    if (!about) throw new Error("Say which point this corrects.");
    if (!importOf(this.log, projectId)) throw new Error(`Project #${projectId} was not imported from a repo`);
    this.log.append("repo.review.corrected", { projectId, about, was: String(c.was ?? "").trim().slice(0, 600), text });
    return reviewNotes(this.log, projectId);
  }

  removeNote(projectId: number, id: number): OwnerNote[] {
    if (!reviewNotes(this.log, projectId).some((n) => n.id === id)) throw new Error("That note is not there any more.");
    this.log.append("repo.review.note.removed", { projectId, id });
    return reviewNotes(this.log, projectId);
  }

  /** Everything the review page shows for one project. */
  detail(projectId: number) {
    const imp = importOf(this.log, projectId);
    if (!imp) return null;
    const rows = (this.log.db.prepare("SELECT * FROM repo_reviews WHERE project_id = ? ORDER BY id DESC LIMIT 20").all(projectId) as Record<string, any>[]).map(toReview);
    const current = rows[0] ?? null;
    const shown = rows.find((r) => r.verdict) ?? null;
    const notes = reviewNotes(this.log, projectId);
    const ids = new Set((shown?.verdict?.nextSteps ?? []).map((n) => n.suggestionId));
    const saved = this.log.db.prepare("SELECT payload FROM events WHERE type = 'repo.review.brief.saved' AND json_extract(payload, '$.projectId') = ? ORDER BY id DESC LIMIT 1").get(projectId) as { payload: string } | undefined;
    return {
      import: imp, current, shown,
      history: rows.map((r) => ({ id: r.id, ts: r.ts, trigger: r.trigger, mode: r.mode, status: r.status, spentUsd: r.spentUsd, capUsd: r.capUsd, call: r.verdict?.recommendation.call ?? null, head: r.head })),
      notes, pending: notes.filter((n) => n.applied == null).length,
      steps: suggestionsOf(this.log, projectId).filter((s) => ids.has(s.id)),
      briefPath: BRIEF_PATH, briefSaved: saved ? JSON.parse(saved.payload) : null,
      busy: this.busy(projectId), mode: this.mode(), settings: this.settings(),
    };
  }

  settings() { return { maxUsd: this.maxUsd, updateUsd: Number(Math.max(REVIEW_MIN_USD, this.maxUsd * 0.3).toFixed(2)), auto: this.auto, homeStack: this.homeStack, minUsd: REVIEW_MIN_USD, limitUsd: REVIEW_MAX_USD }; }

  /**
   * Put the brief in the repo, on a branch of its own: a draft pull request when the repo is on GitHub and
   * SoftwareFactory may send there, else the branch is added to the person's folder (their files and their
   * current branch do not move). Never the repo's main line.
   */
  async saveBrief(projectId: number): Promise<{ branch: string; where: string; url: string | null }> {
    const imp = importOf(this.log, projectId);
    const last = latestReview(this.log, projectId, { withVerdict: true });
    if (!imp || !last?.brief) throw new Error("There is no brief yet: the review has not reached a verdict.");
    if (!existsSync(join(imp.dir, ".git"))) throw new Error("The imported folder is not a git repo, so there is no branch to put the brief on. Copy the brief from this page instead.");
    const branch = "sf/review-brief";
    const dir = join(this.explorer.importsDir, ".reviews", `${projectId}-brief`);
    mkdirSync(dirname(dir), { recursive: true });
    if (!existsSync(join(dir, ".git"))) git(dirname(dir), "clone", "-q", "--no-hardlinks", imp.dir, dir);
    git(dir, "fetch", "-q", imp.dir, "HEAD");
    git(dir, "checkout", "-q", "-B", branch, "FETCH_HEAD");
    mkdirSync(dirname(join(dir, BRIEF_PATH)), { recursive: true });
    writeFileSync(join(dir, BRIEF_PATH), last.brief);
    const sha = commitAll(dir, `Add SoftwareFactory's review brief (${BRIEF_PATH})`);
    const done = (where: string, url: string | null) => { this.log.append("repo.review.brief.saved", { projectId, review: last.id, branch, where, url, sha }); return { branch, where, url }; };
    const github = imp.local ? null : parseGitHubRepo(imp.source);
    if (!github) {
      try { git(imp.dir, "fetch", "-q", dir, `+${branch}:${branch}`); }
      catch (e) { throw new Error(/checked out/i.test((e as Error).message) ? `Your folder has the branch ${branch} open. Switch away from it there, then press again.` : `Could not add the branch to your folder: ${(e as Error).message.slice(0, 300)}`); }
      return done(imp.dir, null);
    }
    const gh = this.opts.github;
    if (!gh) throw new Error("GitHub access is not set up in this core. Copy the brief from this page instead.");
    const why = this.opts.canShip?.();
    if (why) throw new Error(`Not sent: ${why}.`);
    let base = imp.branch ?? "main";
    try { base = git(imp.dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").replace(/^origin\//, ""); } catch { /* the import's branch */ }
    const repo = `${github.owner}/${github.name}`;
    if (gh.hasToken()) {
      const pr = await gh.openPr({ repo: github, dir, branch, base, title: "Add SoftwareFactory's review brief", body: [`Adds \`${BRIEF_PATH}\`: what this app is, how it runs, what works and what does not, and the next steps, from SoftwareFactory's review of the repo.`, "", `RepoVerdict: **${last.verdict!.recommendation.call}**. ${last.verdict!.headline}`, "", "_Opened as a draft by SoftwareFactory. It adds one file and changes no code._"].join("\n") });
      return done(repo, pr.url);
    }
    await gh.pushBranch({ repo: github, dir, branch, base });
    return done(repo, gh.compareUrl(github, base, branch));
  }

  // ---------------- one review ----------------

  private guard(projectId: number, trigger: ReviewTrigger, capIn: number, fn: (review: number, cap: number) => Promise<number>): Promise<RepoReviewResult> {
    const cap = Number(Math.max(0, capIn).toFixed(2));
    const mode = this.mode();
    const start = this.log.append("repo.review.started", { projectId, trigger, mode, capUsd: cap, head: importOf(this.log, projectId)?.head ?? null });
    let spent = 0;
    const p = fn(start.id, cap).then((usd) => {
      spent = usd;
      this.log.append("repo.review.finished", { projectId, review: start.id, outcome: "done", spentUsd: Number(usd.toFixed(6)) });
      return { projectId, review: start.id, outcome: "done", spentUsd: usd } as RepoReviewResult;
    }).catch((e) => {
      const error = (e as Error).message;
      spent = Number((e as { spentUsd?: number }).spentUsd ?? spent);
      this.log.append("repo.review.finished", { projectId, review: start.id, outcome: "failed", error, spentUsd: Number(spent.toFixed(6)) });
      return { projectId, review: start.id, outcome: "failed", spentUsd: spent, error } as RepoReviewResult;
    }).finally(() => { if (this.running.get(projectId) === p) this.running.delete(projectId); });
    this.running.set(projectId, p);
    return p;
  }

  private station(projectId: number, review: number, station: ReviewStation, state: "active" | "pass" | "fail" | "skipped", note?: string, spentUsd?: number) {
    this.log.append("repo.review.station", { projectId, review, station, state, ...(note ? { note: note.slice(0, 400) } : {}), ...(spentUsd != null ? { spentUsd: Number(spentUsd.toFixed(6)) } : {}) });
  }

  /** A copy of the repo at its newest commit, where installing and running may leave their files. Null when the import is not a git repo. */
  private prepareCopy(projectId: number, src: string): string | null {
    if (!existsSync(join(src, ".git"))) return null;
    const dir = this.copyDir(projectId);
    mkdirSync(dirname(dir), { recursive: true });
    if (!existsSync(join(dir, ".git"))) git(dirname(dir), "clone", "-q", "--no-hardlinks", src, dir);
    git(dir, "fetch", "-q", src, "HEAD");
    git(dir, "checkout", "-q", "--detach", "FETCH_HEAD");
    // What SoftwareFactory installs here never shows up as a change.
    const exclude = join(dir, ".git", "info", "exclude");
    let have = "";
    try { have = readFileSync(exclude, "utf8"); } catch { /* none yet */ }
    if (!/^\.sf\/$/m.test(have)) { mkdirSync(dirname(exclude), { recursive: true }); appendFileSync(exclude, "\n.sf/\nnode_modules/\n"); }
    return dir;
  }

  /** The stacks of the person's other imported repos, plus what they said their main stack is. */
  private home(projectId: number): string {
    const lines: string[] = [];
    if (this.homeStack.trim()) lines.push(`The owner says their main stack is: ${this.homeStack.trim()}`);
    for (const row of listImports(this.log).filter((r) => r.projectId !== projectId).slice(0, 12)) {
      const m = latestMap(this.log, row.projectId)?.map;
      if (!m) continue;
      const langs = m.languages.filter((l) => l.lines > 0 && !["JSON", "Markdown", "YAML", "TOML", "Other", "Lockfile"].includes(l.lang)).slice(0, 3).map((l) => `${l.lang} ${Math.round((l.lines / Math.max(1, m.lines)) * 100)}%`);
      const deps = [...new Set(m.dependencies.filter((d) => !d.dev).map((d) => d.name))].slice(0, 8);
      lines.push(`- ${row.name} (${row.source}): ${langs.join(", ") || "unknown"}${deps.length ? `; uses ${deps.join(", ")}` : ""}`);
    }
    return lines.join("\n");
  }

  private async reviewNow(projectId: number, review: number, cap: number): Promise<number> {
    const imp = importOf(this.log, projectId)!;
    const mode = this.mode();
    const name = listImports(this.log).find((r) => r.projectId === projectId)?.name ?? imp.source;
    let spent = 0;
    const fail = (msg: string) => Object.assign(new Error(msg), { spentUsd: spent });

    // 1. A copy of SoftwareFactory's own: the import and the person's folder stay as they are.
    this.station(projectId, review, "copy", "active");
    let dir = imp.dir;
    let canRun = this.opts.run !== false;
    try {
      const copy = this.prepareCopy(projectId, imp.dir);
      if (copy) { dir = copy; this.station(projectId, review, "copy", "pass", "a copy of the repo at its newest commit; your files are not touched"); }
      else { canRun = false; this.station(projectId, review, "copy", "skipped", "the folder is not a git repo, so it is read where it is and nothing is installed or run"); }
    } catch (e) { canRun = false; this.station(projectId, review, "copy", "fail", `could not copy it, so it is only read: ${(e as Error).message.slice(0, 200)}`); }

    // 2 and 3. Read and run: free, and the facts everything after stands on.
    const map: CodeMap = latestMap(this.log, projectId)?.map ?? scanRepo(dir);
    const ev = await gatherEvidence(dir, { head: map.head ?? imp.head, run: canRun, tools: this.opts.tools, step: (s, state, note) => this.station(projectId, review, s, state, note) });
    this.log.append("repo.review.evidence", { projectId, review, evidence: ev });

    const notes = reviewNotes(this.log, projectId);
    const mapBlock = mapText(map, moduleNotes(this.log, projectId), 6000);

    // 4. Inspect: what the app is.
    this.station(projectId, review, "inspect", "active", mode === "agent" ? "the Inspector is reading the code" : "practice crew: read from names, routes and pages");
    let u: Understanding | null = null;
    let uBy = "heuristic";
    if (mode === "agent" && this.runtime && cap > 0) {
      const a = this.crew?.crewFor("inspect")[0];
      const kit = kitArgs(a);
      const r = await runAgent(this.log, this.runtime, a?.id ?? "inspector", {
        prompt: inspectPrompt(imp.source, mapBlock, ev, notes), model: a?.model ?? "sonnet", systemPrompt: a?.role,
        budgetUsd: Number(Math.max(0.05, cap * 0.6).toFixed(4)), ...kit, tools: [...new Set([...READ_TOOLS, ...(kit.tools ?? [])])], cwd: dir, timeoutMs: 20 * 60_000,
      }, { projectId, station: "inspect", agentVersion: a?.version });
      spent += r.result?.costUsd ?? r.costUsd ?? 0;
      u = r.result ? parseUnderstanding(r.result.text) : null;
      if (u) uBy = a?.id ?? "inspector";
      else this.station(projectId, review, "inspect", "fail", `the Inspector gave no usable answer (${(r.error ?? "its answer did not parse").slice(0, 160)}); the free reading is used instead`, spent);
    }
    if (!u) {
      let readme = "";
      for (const f of ["README.md", "readme.md", "README.rst", "README.txt", "README"]) { try { readme = readFileSync(join(dir, f), "utf8"); break; } catch { /* next */ } }
      u = heuristicUnderstanding(name, readme, map, ev);
    }
    this.log.append("repo.review.understood", { projectId, review, understanding: u, by: uBy });
    if (uBy !== "heuristic" || mode !== "agent" || !this.runtime || cap <= 0) this.station(projectId, review, "inspect", "pass", `${u.features.length} feature${u.features.length === 1 ? "" : "s"}, ${u.flow.steps.length} flow step${u.flow.steps.length === 1 ? "" : "s"}${uBy === "heuristic" ? " (free reading)" : ""}`, spent);

    // 5. RepoVerdict.
    this.station(projectId, review, "verdict", "active", mode === "agent" ? "the Assessor is judging it" : "practice crew: scored from the measurements");
    let v: RepoVerdict | null = null;
    let vBy = "heuristic";
    let verdictFailed = false;
    if (mode === "agent" && this.runtime && cap - spent > 0.02) {
      const a = this.crew?.crewFor("verdict")[0];
      const r = await runAgent(this.log, this.runtime, a?.id ?? "assessor", {
        prompt: verdictPrompt(imp.source, u, ev, map, notes, this.home(projectId)), model: a?.model ?? "sonnet", systemPrompt: a?.role,
        budgetUsd: Number(Math.max(0.03, cap - spent).toFixed(4)), ...kitArgs(a), timeoutMs: 10 * 60_000,
      }, { projectId, station: "verdict", agentVersion: a?.version });
      spent += r.result?.costUsd ?? r.costUsd ?? 0;
      v = r.result ? parseVerdict(r.result.text) : null;
      if (v) vBy = a?.id ?? "assessor";
      else { verdictFailed = true; this.station(projectId, review, "verdict", "fail", `the Assessor gave no usable answer (${(r.error ?? "its answer did not parse").slice(0, 160)}); the measured verdict is used instead`, spent); }
    } else if (mode === "agent") {
      verdictFailed = true;
      this.station(projectId, review, "verdict", "fail", `the limit of $${cap.toFixed(2)} was used up by the Inspector, so the verdict comes from the measurements only; raise the limit and review again for a reasoned one`, spent);
    }
    v = withStepIds(projectId, v ?? heuristicVerdict(projectId, u, ev, map, notes));
    this.finish(projectId, review, { name, source: imp.source, head: ev.head, u, v, ev, vBy, mode, spent, failedAgent: verdictFailed });
    return spent;
  }

  private async updateNow(projectId: number, review: number, cap: number, last: ReviewRow): Promise<number> {
    const imp = importOf(this.log, projectId)!;
    const mode = this.mode();
    const name = listImports(this.log).find((r) => r.projectId === projectId)?.name ?? imp.source;
    const notes = reviewNotes(this.log, projectId);
    const fresh = notes.filter((n) => n.applied == null);
    const ev = last.evidence!;
    let u = last.understanding!;
    let v: RepoVerdict | null = null;
    let vBy = "heuristic";
    let spent = 0;
    for (const s of ["copy", "read", "install", "tests", "site", "deps", "inspect"] as ReviewStation[]) this.station(projectId, review, s, "skipped", "kept from the last review");
    this.log.append("repo.review.evidence", { projectId, review, evidence: ev });
    this.station(projectId, review, "verdict", "active", `rewriting with ${fresh.length} thing${fresh.length === 1 ? "" : "s"} you said`);
    if (mode === "agent" && this.runtime && cap > 0) {
      const a = this.crew?.crewFor("verdict")[0];
      const r = await runAgent(this.log, this.runtime, a?.id ?? "assessor", {
        prompt: revisePrompt(imp.source, u, last.verdict!, ev, notes, fresh, this.home(projectId)), model: a?.model ?? "sonnet", systemPrompt: a?.role,
        budgetUsd: Number(Math.max(0.03, cap).toFixed(4)), ...kitArgs(a), timeoutMs: 10 * 60_000,
      }, { projectId, station: "verdict", agentVersion: a?.version });
      spent += r.result?.costUsd ?? r.costUsd ?? 0;
      const rev = r.result ? parseRevision(r.result.text) : null;
      if (!rev) throw Object.assign(new Error(`The Assessor gave no usable answer, so the verdict is unchanged: ${(r.error ?? "its answer did not parse").slice(0, 200)}`), { spentUsd: spent });
      u = rev.understanding; v = rev.verdict; vBy = a?.id ?? "assessor";
    } else {
      // The practice crew takes the owner at their word where a point is plain text, and scores again.
      const said = (re: RegExp) => [...notes].reverse().find((n) => re.test(n.kind === "answer" ? n.question : n.about))?.text;
      u = { ...u, purpose: said(/purpose|what is this app for/i) ?? u.purpose, users: said(/users|who uses/i) ?? u.users, usage: said(/usage|how it is used|running anywhere/i) ?? u.usage, unsure: u.unsure.filter(() => !said(/purpose|what is this app for/i)) };
      v = heuristicVerdict(projectId, u, ev, latestMap(this.log, projectId)?.map ?? scanRepo(imp.dir), notes);
    }
    this.log.append("repo.review.understood", { projectId, review, understanding: u, by: vBy === "heuristic" ? last.understoodBy ?? "heuristic" : vBy });
    this.finish(projectId, review, { name, source: imp.source, head: ev.head, u, v: withStepIds(projectId, v), ev, vBy, mode, spent, failedAgent: false });
    return spent;
  }

  /** The verdict is recorded with its brief, and each next step enters the Council's queue once. */
  private finish(projectId: number, review: number, x: { name: string; source: string; head: string | null; u: Understanding; v: RepoVerdict; ev: Evidence; vBy: string; mode: ExploreMode; spent: number; failedAgent: boolean }) {
    const notes = reviewNotes(this.log, projectId);
    const ts = new Date().toISOString();
    const brief = briefMarkdown({ name: x.name, source: x.source, head: x.head, ts, by: x.vBy === "heuristic" ? "practice crew, measurements only" : "Inspector and Assessor", understanding: x.u, verdict: x.v, evidence: x.ev, notes });
    this.log.append("repo.review.verdict", { projectId, review, verdict: x.v, by: x.vBy, brief });
    if (!x.failedAgent) this.station(projectId, review, "verdict", "pass", `${x.v.recommendation.call}: ${x.v.headline}`.slice(0, 300), x.spent);
    const known = new Set((this.log.db.prepare("SELECT id FROM code_suggestions WHERE project_id = ?").all(projectId) as { id: string }[]).map((r) => r.id));
    let filed = 0;
    for (const n of x.v.nextSteps) {
      if (!n.suggestionId || known.has(n.suggestionId)) continue;
      known.add(n.suggestionId);
      const { suggestionId: id, ...s } = n;
      this.log.append("repo.suggestion", { projectId, review, suggestionId: id, ...s, grounded: true, by: x.vBy === "heuristic" ? "heuristic" : x.vBy });
      filed++;
    }
    // The copy carries the brief too (under .sf/, which git leaves out), for whoever opens that folder.
    try { const dir = this.copyDir(projectId); if (existsSync(dir)) { mkdirSync(join(dir, ".sf"), { recursive: true }); writeFileSync(join(dir, ".sf", "REVIEW.md"), brief); } } catch { /* the page still has it */ }
    this.station(projectId, review, "brief", "pass", `the brief is written; ${filed} next step${filed === 1 ? "" : "s"} wait for your approval${x.v.nextSteps.length - filed ? `, ${x.v.nextSteps.length - filed} already known` : ""}`);
  }
}
