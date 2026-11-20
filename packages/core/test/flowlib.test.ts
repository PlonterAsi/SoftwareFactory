import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventLog, MockRuntime, Factory, AgentBay, Tickets, FlowLibrary, BUILT_IN_FLOWS, SMALL_CHANGE_FLOW, REFACTOR_FLOW, flowProblems, pickFlow, checkTicket, createProject, git, stepOfSession,
  type FlowDef,
} from "../src/index.js";
import type { AgentRequest, AgentResult, AgentRuntime } from "../src/runtime.js";
import { workInRepo } from "../src/tickets/repowork.js";

const tmp = (p = "sf-flowlib-") => mkdtempSync(join(tmpdir(), p));
const clone = (f: FlowDef): FlowDef => structuredClone(f);

/** A git repo with one commit, linked to a new project. */
function repoProject(log: EventLog, name = "Legacy app") {
  const src = tmp("sf-flowlib-src-");
  git(src, "init", "-q", "-b", "main");
  writeFileSync(join(src, "README.md"), "# Legacy app\n");
  git(src, "add", "-A"); git(src, "commit", "-q", "-m", "first");
  const proj = createProject(log, { name });
  log.append("project.linked", { projectId: proj, kind: "repo", ref: src });
  return { src, proj };
}

/** A fake crew: the Builder writes a file each call; the Reviewer passes. */
class Fake implements AgentRuntime {
  readonly name = "fake";
  calls: AgentRequest[] = [];
  async run(req: AgentRequest): Promise<AgentResult> {
    this.calls.push(req);
    const reviewer = /Station contract: review/.test(req.systemPrompt ?? "");
    const text = reviewer ? "```json\n{\"verdict\":\"pass\",\"findings\":[]}\n```" : `<<<FILE src/f${this.calls.length}.txt\nchange\nFILE>>>\nDid it.`;
    return { text, costUsd: 0.01, durationMs: 1, models: ["fake"], runtime: "fake", contextTokens: 0 };
  }
}

describe("the flow library: one flow per kind of work", () => {
  it("ships a flow for each door, each valid, each saying who carries it out", () => {
    for (const f of BUILT_IN_FLOWS) expect(flowProblems(f), f.id).toEqual([]);
    const lib = new FlowLibrary(new EventLog(":memory:"));
    const list = lib.list();
    expect(list.map((f) => f.id)).toEqual(["new-project", "repo-change", "bug-fix", "small-change", "refactor", "research", "import", "improve", "release"]);
    expect(Object.fromEntries(list.map((f) => [f.id, f.runner]))).toMatchObject({ "new-project": "engine", "repo-change": "engine", "bug-fix": "session", refactor: "session", research: "answer", release: "door" });
    expect(list.find((f) => f.id === "import")!.door).toMatch(/Import from git/);
  });

  it("checks each flow against what its runner can do, and keeps door flows and runners as they are", () => {
    const lib = new FlowLibrary(new EventLog(":memory:"));
    const bad = clone(SMALL_CHANGE_FLOW);
    bad.steps = bad.steps.filter((s) => s.action !== "commit");
    bad.steps.push({ ...bad.steps[0], id: "x", label: "Plan", action: "plan" });
    const p = flowProblems(bad).join("\n");
    expect(p).toMatch(/must commit on the branch/);
    expect(p).toMatch(/"plan", which one Builder session cannot do/);
    const release = clone(lib.get("release")!);
    release.steps[0].label = "Gather";
    expect(() => lib.save(release)).toThrow(/its own screen/);
    const engine = clone(lib.get("bug-fix")!);
    engine.runner = "engine";
    expect(() => lib.save(engine)).toThrow(/cannot change that/);
    expect(() => lib.forRun(undefined, "bug-fix")).toThrow(/one Builder session, not the engine/);
    // A session flow saved with fewer fix rounds is a new version like any other.
    const lean = clone(lib.get("bug-fix")!);
    lean.steps.find((s) => s.id === "checks")!.loop!.maxRounds = 1;
    expect(lib.save(lean)).toMatchObject({ version: 2, builtIn: false, runner: "session" });
  });

  it("picks the flow a ticket follows: yours, else its kind's, else by route", () => {
    const lib = new FlowLibrary(new EventLog(":memory:"));
    const id = (t: { kind: string; flow?: string }, o: Parameters<typeof pickFlow>[2]) => pickFlow(lib, t, o).flow.id;
    expect(id({ kind: "bug" }, { repo: true, route: "light" })).toBe("bug-fix");
    expect(id({ kind: "task" }, { repo: true, route: "light" })).toBe("small-change");
    expect(id({ kind: "request" }, { repo: true, route: "engine" })).toBe("repo-change");
    expect(id({ kind: "question" }, { repo: true })).toBe("research");
    expect(id({ kind: "question" }, { repo: false })).toBe("research");
    expect(id({ kind: "bug" }, { repo: false })).toBe("new-project");
    expect(pickFlow(lib, { kind: "task", flow: "refactor" }, { repo: true })).toMatchObject({ chosen: true, why: "you picked the Refactor flow" });
    // A flow you save for a kind takes over from the built-in one.
    const mine = clone(SMALL_CHANGE_FLOW);
    Object.assign(mine, { id: "careful-bug", name: "Careful bug", kinds: ["bug"] });
    lib.save(mine);
    expect(id({ kind: "bug" }, { repo: true, route: "light" })).toBe("careful-bug");
  });
});

describe("a one-session ticket follows its flow", () => {
  const setup = () => {
    const src = tmp("sf-flowlib-rw-");
    git(src, "init", "-q", "-b", "main");
    writeFileSync(join(src, "CLAUDE.md"), "Small code.");
    git(src, "add", "-A"); git(src, "commit", "-q", "-m", "init");
    return { src, workRoot: tmp(), log: new EventLog() };
  };
  const steps = (log: EventLog) => (log.db.prepare("SELECT payload FROM events WHERE type = 'ticket.step' ORDER BY id").all() as { payload: string }[]).map((r) => JSON.parse(r.payload)).map((p) => `${p.step}:${p.state}`);
  const go = (rt: Fake, s: ReturnType<typeof setup>, flow?: FlowDef) =>
    workInRepo(s.log, rt, undefined, { id: 1, key: "SF-1", title: "Do it", document: "# SF-1 Do it", repo: { source: s.src, dir: s.src, branch: null }, workRoot: s.workRoot, maxUsd: 0.6, checks: { runTests: () => ({ ok: true, output: "" }) }, flow });

  it("the Small change flow takes exactly the steps the light route always took", async () => {
    const s = setup();
    const r = await go(new Fake(), s);
    expect(r).toMatchObject({ ok: true, handover: true });
    expect(steps(s.log)).toEqual(["install:skipped", "orient:passed", "build:running", "build:passed", "gates:running", "gates:passed", "test integrity:running", "test integrity:passed", "tests:running", "tests:passed", "review:running", "review:passed", "commit:passed"]);
  });

  it("a flow's brief reaches the Builder and the Reviewer, and steps left out are not done", async () => {
    const s = setup();
    const rt = new Fake();
    await go(rt, s, REFACTOR_FLOW);
    expect(rt.calls[0].systemPrompt).toMatch(/This is a refactor/);
    expect(rt.calls.find((c) => /Station contract: review/.test(c.systemPrompt ?? ""))!.systemPrompt).toMatch(/This is a refactor/);
    const s2 = setup();
    const rt2 = new Fake();
    const noReview = clone(SMALL_CHANGE_FLOW);
    noReview.steps = noReview.steps.filter((x) => !["review", "handover"].includes(x.id));
    noReview.edges = noReview.edges.filter((e) => ![e.from, e.to].some((x) => x === "review" || x === "handover"));
    const r = await go(rt2, s2, noReview);
    expect(r).toMatchObject({ ok: true, handover: false });
    expect(rt2.calls.some((c) => /Station contract: review/.test(c.systemPrompt ?? ""))).toBe(false);
    expect(steps(s2.log)).not.toContain("review:running");
  });

  it("names each harness step's place in the flow", () => {
    expect(["install", "build", "fix 2", "tests", "secrets", "review fix", "commit"].map(stepOfSession)).toEqual(["orient", "build", "checks", "checks", "checks", "review", "commit"]);
  });
});

describe("a question is answered, nothing changes", () => {
  it("reads a copy of the repo with read-only tools, answers on the ticket, makes no branch", async () => {
    const log = new EventLog();
    const rt = new MockRuntime();
    const bay = new AgentBay(log, rt);
    const { src, proj } = repoProject(log);
    const head = git(src, "rev-parse", "HEAD");
    const t = new Tickets(log, { runtime: rt, bay, workRoot: tmp(), factory: new Factory(log, rt, tmp(), bay) });
    const q = t.open({ kind: "question", title: "Where is the login handled?", project: proj, answers: { ask: "Where is the login handled?" } });
    expect(t.detail(q.id)!.flow).toMatchObject({ id: "research", runner: "answer" });
    const r = t.work(q.id);
    expect(r).toMatchObject({ run: null, flow: { id: "research" } });
    await t.waitRepo(q.id);
    const done = t.get(q.id)!;
    expect(done.status).toBe("built");
    expect(done.branch).toBeNull();
    const reader = rt.calls.find((c) => /Station contract: research/.test(c.systemPrompt ?? ""))!;
    expect(reader.tools).toEqual(["Read", "Glob", "Grep"]);
    expect(t.notes(q.id).at(-1)!.text).toMatch(/Files read: README.md/);
    expect(git(src, "rev-parse", "HEAD")).toBe(head);
    expect(log.list({ limit: 1e6 }).some((e) => e.type === "ticket.branch" || e.type === "ticket.pr")).toBe(false);
  }, 30_000);

  it("a flow you pick on a ticket decides its route", async () => {
    const log = new EventLog();
    const rt = new MockRuntime();
    const bay = new AgentBay(log, rt);
    const { proj } = repoProject(log);
    const t = new Tickets(log, { runtime: rt, bay, workRoot: tmp(), factory: new Factory(log, rt, tmp(), bay) });
    const a = t.open({ kind: "task", title: "Tidy the date helpers into one module", project: proj, answers: { todo: "Tidy the date helpers" } });
    t.edit(a.id, "flow", "refactor");
    expect(t.get(a.id)!.flow).toBe("refactor");
    expect(() => t.edit(a.id, "flow", "release")).toThrow(/own screen/);
    expect(() => t.edit(a.id, "flow", "nope")).toThrow(/no flow "nope"/);
    const r = t.work(a.id);
    expect(r.flow).toEqual({ id: "refactor", name: "Refactor" });
    await t.waitRepo(a.id);
    expect(rt.calls.find((c) => c.cwd && /You are the Builder|Station contract: build/.test(c.systemPrompt ?? "") || /This is a refactor/.test(c.systemPrompt ?? ""))!.systemPrompt).toMatch(/This is a refactor/);
    const b = t.open({ kind: "task", title: "Something in a project with no repo at all", answers: { todo: "x" } });
    t.edit(b.id, "flow", "bug-fix");
    expect(() => t.work(b.id)).toThrow(/works in a repo/);
  }, 30_000);
});

describe("the check before money", () => {
  it("asks about clarity, open words and decisions only you make, and goes once each is answered", () => {
    const vague = checkTicket({ kind: "task", title: "Fix it", body: "", answers: {}, size: null });
    expect(vague.verdict).toBe("ask");
    expect(vague.questions.map((q) => q.kind)).toContain("clarity");
    const money = checkTicket({ kind: "request", title: "Add a checkout page", body: "People pay for the pro plan with Stripe and maybe something for teams, not sure yet.", answers: { need: "Sell the pro plan" }, size: "M" });
    expect(money.questions.map((q) => q.id)).toEqual(expect.arrayContaining(["money", "open"]));
    expect(money.questions.find((q) => q.id === "money")!.kind).toBe("decision");
    const answered = checkTicket({ kind: "request", title: "Add a checkout page", body: "People pay for the pro plan with Stripe and maybe something for teams, not sure yet.", answers: { need: "Sell the pro plan", "check.money": "Up to $10 a month, I approve", "check.open": "Teams later" }, size: "M" });
    expect(answered).toMatchObject({ verdict: "go", answered: 2 });
    const clear = checkTicket({ kind: "bug", title: "The run tab is blank after a restart", body: "Open the app, restart it, and the run tab shows nothing although runs exist.", answers: { expected: "The runs listed" }, size: "S" });
    expect(clear.verdict).toBe("go");
    const big = checkTicket({ kind: "task", title: "Rewrite the storage layer and the sync", body: "Move all reads and writes to the new store, keep the old files readable.", answers: { todo: "Rewrite storage" }, size: "L" }, { runner: "session" });
    expect(big.questions.map((q) => q.id)).toEqual(["size"]);
  });

  it("asks your call only for an ask to do the thing, not a mention of it (20 Nov false positives)", () => {
    const ids = (title: string, body: string) => checkTicket({ kind: "task", title, body, answers: {}, size: "S" }).questions.filter((q) => q.kind === "decision").map((q) => q.id);
    // An add-on's ticket: scores, token efficiency, a risk line, an MIT license, "no secrets".
    const scout = ["Scout found this skill: https://github.com/acme/advisor", "", "Pairs a cheap worker with a strong advisor.", "",
      "Verdict: Adopt. Score 4.2 of 5. Risk: low.", "Where it helps: long Builder sessions that burn tokens.", "",
      "- Token efficiency: 5/5, uses fewer tokens per task", "- Security: 4/5, no secrets or API keys needed, MIT license", "- Upkeep: 4/5, active"].join("\n");
    expect(ids("Adopt: The advisor strategy", scout)).toEqual([]);
    expect(ids("A database query is put together from text", "The search builds SQL by joining the user's text, so a quote breaks it in production. It should use parameters.")).toEqual([]);
    expect(ids("Pin 4 Python packages to exact versions", "requirements.txt uses ranges; pin them so a deploy installs what the tests ran with. The pricing page is unaffected.")).toEqual([]);
    expect(ids("Deleting a ticket crashes the board", "Press Delete on a ticket and the board goes blank. It should remove the card.")).toEqual([]);
    // Real asks still ask.
    expect(ids("Connect GitHub", "The crew needs a GitHub token to open PRs; store it in Systems.")).toEqual(["secrets"]);
    expect(ids("Sign in", "Add sign in with Google.")).toEqual(["secrets"]);
    expect(ids("Pro plan", "Take payments for the pro plan with Stripe.")).toEqual(["money"]);
    expect(ids("Clean up", "Delete all old rows from the log table, and run the database migration.")).toEqual(["data"]);
    expect(ids("Launch", "Deploy it to production and announce it.")).toEqual(["public"]);
    expect(ids("Open source it", "Choose a license and add a privacy policy.")).toEqual(["legal"]);
  });

  it("holds a run until its questions are answered, lists them all in one batch, and starts what is clear", async () => {
    const log = new EventLog();
    const rt = new MockRuntime();
    const bay = new AgentBay(log, rt);
    const { proj } = repoProject(log);
    const t = new Tickets(log, { runtime: rt, bay, workRoot: tmp(), factory: new Factory(log, rt, tmp(), bay) });
    const a = t.open({ kind: "task", title: "Delete old rows", project: proj, answers: { todo: "Delete the old rows from the log table" } });
    const b = t.open({ kind: "task", title: "Fix it", project: proj });
    const clear = t.open({ kind: "bug", title: "The run tab is blank after a restart", project: proj, body: "Open the app, restart it, and the run tab shows nothing although runs exist.", answers: { expected: "The runs listed" } });
    expect(() => t.work(a.id, { check: true })).toThrow(/Before it costs money/);
    expect(t.timeline(a.id).some((r) => r.cat === "decision" && /Checked before money: 1 question/.test(r.text))).toBe(true);
    const batch = t.checks();
    expect(batch.map((x) => x.ticket.id).sort()).toEqual([a.id, b.id].sort());
    expect(batch.find((x) => x.ticket.id === a.id)!.check.questions[0]).toMatchObject({ id: "data", kind: "decision" });
    const res = t.answerChecks([{ id: a.id, q: "data", text: "Only rows older than a year; there is a backup." }], { run: true });
    expect(res).toMatchObject({ answered: 1, held: [] });
    expect(res.started.map((s) => s.id)).toEqual([a.id]);
    expect(t.get(a.id)!.answers["check.data"]).toMatch(/older than a year/);
    expect(t.timeline(a.id).some((r) => r.cat === "decision" && /clear to run \(1 answer from you\)/.test(r.text))).toBe(true);
    await t.waitRepo(a.id);
    // The home board: the vague one needs you, the answered one ran, the clear one is not held.
    const board = t.board();
    expect(board.lanes.needs.find((c) => c.id === b.id)).toMatchObject({ need: "check", flow: { id: "small-change" } });
    expect(board.lanes.needs.some((c) => c.id === clear.id)).toBe(false);
    expect([...board.lanes.needs, ...board.lanes.running].some((c) => c.id === a.id)).toBe(true);
    expect(Object.keys(board.counts)).toEqual(["needs", "running", "review", "done"]);
    expect(existsSync(t.get(a.id)!.branchDir ?? "")).toBe(true);
  }, 30_000);
});
