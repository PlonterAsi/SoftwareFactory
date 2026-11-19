import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, Factory, MockRuntime, git, type AgentRequest, type AgentRuntime } from "../src/index.js";
import { validateDocs } from "../src/factory/discovery.js";
import { screenProblem } from "../src/factory/screencheck.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const events = (log: EventLog, type: string) => log.list({ limit: 1e6 }).filter((e) => e.type === type).map((e) => e.payload as any);
const station = (req: AgentRequest) => req.systemPrompt?.match(/Station contract: (\w+)/)?.[1] ?? "";

describe("what run 2898 taught the engine", () => {
  it("keeps a long requirement whole, so the Critic never judges text the engine cut", async () => {
    const { validateDocs, DOC_LIMITS } = await import("../src/factory/discovery.js");
    const long = `${"The knowledge list ranks every item by its fit to the player's level. ".repeat(7)}End.`;
    expect(long.length).toBeGreaterThan(300);
    expect(long.length).toBeLessThanOrEqual(DOC_LIMITS.requirementChars);
    const docs = validateDocs({
      brief: { who: "a player", promise: "the few best things to learn next" },
      journeys: [{ moment: "A normal day", goal: "practise", steps: ["open", "pick"] }],
      screens: [{ id: "today", name: "Today" }, { id: "tree", name: "Skill tree" }],
      requirements: Array.from({ length: 34 }, (_, i) => ({ id: `R${i + 1}`, text: long })),
      rules: [{ name: "Today's three", rule: "Pick the three highest ranked items the player has not marked as got it; ties go to the newest." }, "A plain string rule also counts."],
    });
    expect(docs.requirements).toHaveLength(34);
    expect(docs.requirements[33]!.text.endsWith("End.")).toBe(true);
    expect(docs.rules).toHaveLength(2);
  });

  it("keeps a rule with a table whole, and text over the limit ends at a whole sentence (run 3185)", async () => {
    const { validateDocs, keepWhole, DOC_LIMITS } = await import("../src/factory/discovery.js");
    const table = `Level bands. ${"Rocket League: Bronze to Gold is beginner, Platinum to Champion is intermediate. ".repeat(14)}If an item has no band, add the item to Needs a look.`;
    expect(table.length).toBeGreaterThan(800);
    const base = { brief: { who: "a player", promise: "p" }, journeys: [{ moment: "m", steps: ["s"] }], screens: [{ id: "a", name: "A" }, { id: "b", name: "B" }], requirements: ["r"] };
    expect(validateDocs({ ...base, rules: [{ name: "Level bands", rule: table }] }).rules[0]!.rule).toBe(table);
    const over = validateDocs({ ...base, rules: [{ name: "Ranking", rule: "Rank by fit to level, then by freshness. ".repeat(100) }] }).rules[0]!.rule;
    expect(over.length).toBeLessThanOrEqual(DOC_LIMITS.ruleChars);
    expect(over.endsWith("freshness.")).toBe(true);
    expect(keepWhole("one two three four five six", 20)).toBe("one two three four");
    const { CONTRACTS } = await import("../src/bay/builtin.js");
    expect(CONTRACTS.design).toContain("2,400 characters");
  });

  it("gives the Planner and the project the product's rules", async () => {
    const { validateDocs, docsForPlanner, docsFiles } = await import("../src/factory/discovery.js");
    const docs = validateDocs({
      brief: { who: "a player", promise: "p" }, journeys: [{ moment: "m", steps: ["s"] }],
      screens: [{ id: "a", name: "A" }, { id: "b", name: "B" }], requirements: ["r"],
      rules: [{ name: "Ranking", rule: "Score is relevance times freshness." }],
    });
    expect(docsForPlanner(docs)).toContain("Ranking: Score is relevance times freshness.");
    expect(docsFiles("idea", docs, null).find((f) => f.path.endsWith("REQUIREMENTS.md"))!.content).toContain("## Rules");
    // Documents saved before rules existed still load.
    expect(() => docsForPlanner({ ...docs, rules: undefined as never })).not.toThrow();
  });

  it("tries a call once more when the CLI's sign-in check fails at start, and only then", async () => {
    const { EventLog } = await import("../src/events.js");
    const { runAgent } = await import("../src/agents.js");
    process.env.SF_SIGNIN_RETRY_MS = "1";
    const log = new EventLog(":memory:");
    let calls = 0;
    const flaky = { name: "flaky", run: async () => { if (++calls === 1) throw new Error("Not logged in · Please run /login"); return { text: "ok", costUsd: 0.01, durationMs: 1 }; } };
    const r = await runAgent(log, flaky as never, "visionary", { prompt: "x" });
    expect(r.result?.text).toBe("ok");
    expect(log.list({ type: "agent.run.retried" })).toHaveLength(1);
    calls = 0;
    const down = { name: "down", run: async () => { calls++; throw new Error("Not logged in · Please run /login"); } };
    const r2 = await runAgent(log, down as never, "visionary", { prompt: "x" });
    expect(calls).toBe(2);
    expect(r2.error).toContain("not signed in");
    calls = 0;
    const other = { name: "other", run: async () => { calls++; throw new Error("Agent timed out after 5 ms"); } };
    await runAgent(log, other as never, "visionary", { prompt: "x" });
    expect(calls).toBe(1);
    delete process.env.SF_SIGNIN_RETRY_MS;
  });
  it("keeps all six designed screens in the plan, and adds the ones the Planner left out", async () => {
    const { validatePlan, withDesignedScreens } = await import("../src/factory/loop.js");
    const { validateDocs } = await import("../src/factory/discovery.js");
    const names = ["Library", "Game Today", "Skill Tree", "Knowledge", "Practice", "Progress"];
    const docs = validateDocs({
      brief: { who: "a player", promise: "p" }, journeys: [{ moment: "m", steps: ["s"] }], requirements: ["r"],
      screens: names.map((n) => ({ id: n.toLowerCase().replace(/ /g, "-"), name: n, purpose: `The ${n} job.`, shows: ["a"], actions: ["b"] })),
    });
    const base = { name: "GM", slug: "gm", summary: "s", interface: "i", acceptance: ["a"], tasks: [{ id: "t1", title: "t" }] };
    const six = validatePlan({ ...base, views: names.map((n, i) => ({ id: i ? n.toLowerCase().replace(/ /g, "-") : "dashboard", label: n, shows: "x" })) } as never);
    expect(six.views).toHaveLength(6);
    expect(withDesignedScreens(six, docs).added).toEqual([]);
    const four = validatePlan({ ...base, views: six.views!.slice(0, 4) } as never);
    const fixed = withDesignedScreens(four, docs);
    expect(fixed.added).toEqual(["Practice", "Progress"]);
    expect(fixed.plan.views!.map((v) => v.label)).toEqual(names);
    expect(fixed.plan.views![4]!.shows).toContain("The Practice job.");
    // Run 4004: a full plan with one view the Planner made up had no room for the designed Skill Tree.
    const full = validatePlan({ ...base, views: six.views!.map((v, i) => (i === 2 ? { id: "manage", label: "Manage", shows: "every record" } : v)) } as never);
    const swapped = withDesignedScreens(full, docs);
    expect(swapped.added).toEqual(["Skill Tree"]);
    expect(swapped.replaced).toEqual(["Manage"]);
    expect(swapped.plan.views!.map((v) => v.label)).toEqual(names);
    // A full plan of designed screens only is left alone: nothing is removed to make room.
    const five = validateDocs({ brief: { who: "a player", promise: "p" }, journeys: [{ moment: "m", steps: ["s"] }], requirements: ["r"], screens: [...docs.screens.slice(0, 5)] });
    expect(withDesignedScreens(six, five)).toMatchObject({ added: [], replaced: [] });
  });
  it("a larger run buys larger build sessions: the feature cap grows with the budget, up to twice the Builder's own", async () => {
    const { featureCapUsd } = await import("../src/factory/features.js");
    expect([3, 10, 15, 20, 50].map((run) => featureCapUsd(0.6, run))).toEqual([0.6, 0.6, 0.9, 1.2, 1.2]);
  });
  it("the Critic checks what it asked for before it scores again, and the last round cuts what cannot be fixed (buildable stuck at 3 for four runs)", async () => {
    const { critiquePrompt, revisePrompt, validateDocs } = await import("../src/factory/discovery.js");
    const d = validateDocs({ brief: { who: "a player", promise: "p" }, journeys: [{ moment: "m", steps: ["s"] }], requirements: ["r"], screens: [{ id: "a", name: "A", purpose: "x", shows: [], actions: [] }, { id: "b", name: "B", purpose: "y", shows: [], actions: [] }] });
    const before = { scores: { coverage: 4, journey: 4, screens: 4, originality: 4, buildable: 3 }, problems: [{ where: "screens/a", problem: "Agreement counts have no origin.", fix: "Name the rule that computes them." }] };
    expect(critiquePrompt("an idea", d, 1)).not.toMatch(/You judged the version before/);
    const second = critiquePrompt("an idea", d, 2, before);
    expect(second).toMatch(/Your scores then: coverage 4, journey 4, screens 4, originality 4, buildable 3/);
    expect(second).toMatch(/1\. \[screens\/a\] Agreement counts have no origin\. Fix asked: Name the rule/);
    expect(second).toMatch(/A score goes up when the problems that held it down are fixed/);
    expect(revisePrompt("an idea", d, before, 2)).not.toMatch(/last round/);
    expect(revisePrompt("an idea", d, before, 3, true)).toMatch(/last round, so nothing may stay open[\s\S]*never removed/);
  });
  it("makes a real crew's Designer research before it designs, and asks again when nothing has a source", async () => {
    const mock = new MockRuntime({ plantBug: false });
    const asked: string[] = [];
    let n = 0;
    const rt: AgentRuntime = { name: "claude-code:fake", run: async (req) => {
      if (/This time you only research/.test(req.prompt)) {
        asked.push(req.prompt);
        const r = await mock.run({ ...req, prompt: "x" });
        r.text = ++n === 1
          ? '```json\n{"research": [{"finding": "From memory, no page."}]}\n```'
          : '```json\n{"research": [{"finding": "Players learn the air dribble from community videos.", "source": "https://example.com/air-dribble"}, {"finding": "A made-up source is dropped.", "source": "a forum"}]}\n```';
        return r;
      }
      if (/Station contract: design\./.test(req.systemPrompt ?? "")) asked.push(req.prompt);
      return mock.run(req);
    } };
    const log = new EventLog();
    const f = new Factory(log, rt, tmp("sf-proj-"));
    const run = f.start("count words", { autoApprove: true, autoRetries: 0, maxUsd: 2.5 });
    await f.wait(run);
    const res = events(log, "factory.research");
    expect(res).toHaveLength(1);
    expect(res[0].sourced).toBe(1);
    expect(res[0].findings[1].source).toBeUndefined();
    // Two research calls (the first had no source), then the design call that carries the findings and may not search.
    expect(asked[1]).toMatch(/an answer from memory is not research/);
    expect(asked[2]).toMatch(/Research done for this design[\s\S]*https:\/\/example\.com\/air-dribble[\s\S]*Do not search the web on this call/);
  });
  it("checks the links in the app's code, not in its seeded data store, and says which file each is in", async () => {
    const { linkFiles, linkCase } = await import("../src/factory/linkcheck.js");
    const dir = tmp("sf-links-");
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "src/schema.js"), 'export const seed = [{ video: "https://www.youtube.com/watch?v=real123" }];');
    writeFileSync(join(dir, "data/db.json"), '{"items":[{"video":"https://www.youtube.com/watch?v=example1"}]}');
    // Run 4004: the research notes' own sources (metafy.gg, weteachleague.com) failed the product's link check.
    mkdirSync(join(dir, "docs/product"), { recursive: true });
    writeFileSync(join(dir, "docs/product/BRIEF.md"), "- Coaching sessions exist (https://metafy.gg/rocket-league)");
    writeFileSync(join(dir, "PROGRESS.md"), "Used https://example-notes.org/page for reference");
    const where = linkFiles(dir, () => false);
    expect(where).toEqual({ "https://www.youtube.com/watch?v=real123": "src/schema.js" });
    const c = linkCase({ pass: false, checked: 1, unknown: 0, dead: [{ url: "https://www.youtube.com/watch?v=real123", ok: false, note: "no such YouTube video", file: "src/schema.js" }] });
    expect(c.error).toContain("(in src/schema.js)");
  });
  it("gives a product run time in proportion to its budget, and leaves a small run's limit alone", async () => {
    const { runMinutes } = await import("../src/factory/stoprules.js");
    expect(runMinutes(1.5)).toBe(30);
    expect(runMinutes(0.6, 20)).toBe(20);
    expect(runMinutes(10)).toBe(150);
    expect(runMinutes(10, 0.01)).toBeLessThan(1);
    expect(runMinutes(100)).toBe(240);
  });

  it("turns what the product judge found into build features, the person's own asks first, within what the budget allows", async () => {
    const { repairFeatures } = await import("../src/factory/evaluate.js");
    const { validateDocs } = await import("../src/factory/discovery.js");
    const docs = validateDocs({
      brief: { who: "a player", promise: "p" }, journeys: [{ moment: "m", steps: ["s"] }], screens: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
      requirements: [...Array.from({ length: 7 }, (_, i) => ({ id: `R${i + 1}`, text: `Thing ${i + 1}`, from: i === 6 ? "person" : "design" })), { id: "R8", text: "Extra", from: "design", must: false }],
    });
    const e = { requirements: docs.requirements.map((r) => ({ id: r.id, met: r.id === "R1", evidence: r.id === "R1" ? "seen" : "not on any screen" })), scores: { function: 2, design: 2, content: 2 }, problems: [{ where: "today", problem: "Lists 2 things, not 3", fix: "Show three" }] };
    const all = repairFeatures(e, docs, 9);
    expect(all.map((f) => f.id)).toEqual(["J1", "J2", "J3"]);
    // The person's own ask leads; the nice-to-have comes last.
    expect(all[0].title).toMatch(/^Judge: requirements R7, R2, R3, R4, R5$/);
    expect(all[1].title).toMatch(/R6, R8$/);
    expect(all[0].what).toMatch(/R7: Thing 7\n  What the judge saw: not on any screen/);
    expect(all[2].what).toMatch(/\[today\] Lists 2 things, not 3 Fix: Show three/);
    expect(repairFeatures(e, docs, 1)).toHaveLength(1);
    expect(repairFeatures(e, docs, 0)).toEqual([]);
  });
  it("fails a screen that prints a missing value as text, and passes ordinary words", async () => {
    const { screenProblem } = await import("../src/factory/screencheck.js");
    const page = (main: string) => `<div class="kit-app"><main class="kit-main">${main}</main></div>`;
    expect(screenProblem(page("<h1>Library</h1><p>Rocket League</p><span>nullnullnull</span>"), [])).toMatch(/raw "nullnullnull" where a value should be \(near: ".*Rocket League/);
    expect(screenProblem(page("<p>Win rate: NaN%</p>"), [])).toMatch(/raw "NaN"/);
    expect(screenProblem(page("<p>Last session: undefined</p>"), [])).toMatch(/raw "undefined"/);
    expect(screenProblem(page("<p>[object Object]</p>"), [])).toMatch(/object Object/);
    expect(screenProblem(page("<p>Nullify the opponent's pressure. Annulled. Banana.</p>"), [])).toBeNull();
  });

  it("tells the first build session to write real sample content from the research, with only researched links", async () => {
    const { featuresOf } = await import("../src/factory/features.js");
    const { validateDocs } = await import("../src/factory/discovery.js");
    const base = { brief: { who: "a player", promise: "p" }, journeys: [{ moment: "m", steps: ["s"] }], screens: [{ id: "a", name: "A" }, { id: "b", name: "B" }], requirements: ["r"] };
    const plan = { name: "GM", slug: "gm", summary: "s", interface: "i", acceptance: ["a"], tasks: [], entities: [], views: [] } as never;
    const sourced = featuresOf(plan, validateDocs({ ...base, research: [{ finding: "f", source: "https://example.com/guide" }] }))[0].what;
    expect(sourced).toMatch(/real content, not filler[\s\S]*one of the pages listed in that research, copied exactly[\s\S]*Never write a web address from memory/);
    expect(featuresOf(plan, validateDocs(base))[0].what).toMatch(/Leave every link field empty/);
    expect(featuresOf(plan, null)[0].what).not.toMatch(/sample records are real content/);
  });
});

describe("what run 3609 taught the engine", () => {
  it("tells the Designer and the Critic what an app's values can come from, so buildable is judged on real origins", async () => {
    const { CONTRACTS } = await import("../src/bay/builtin.js");
    const { critiquePrompt } = await import("../src/factory/discovery.js");
    expect(CONTRACTS.design).toMatch(/never vote or view counts, video timestamps[\s\S]*Every value a screen shows needs an origin/);
    const docs = { brief: { who: "w", problem: "p", promise: "x", notThis: [] }, research: [], assumptions: [], journeys: [], screens: [], requirements: [] };
    expect(critiquePrompt("idea", docs as never, 1)).toMatch(/buildable: .*every value a screen shows has an origin that can really supply it/);
  });

  it("has the Tester write the person's journeys through the kit's data layer, which is in the folder before the tests", async () => {
    const log = new EventLog();
    const mock = new MockRuntime({ plantBug: false });
    let prompt = "";
    const dir = tmp("sf-proj-");
    const rt: AgentRuntime = { name: "mock", run: async (req) => { if (station(req) === "tests") prompt = req.prompt; return mock.run(req); } };
    const f = new Factory(log, rt, dir);
    const run = f.start("count words", { autoApprove: true, autoRetries: 0 });
    await f.wait(run);
    expect(prompt).toMatch(/test\/journeys\.test\.js[\s\S]*seedDb\(schema\)[\s\S]*createRecord[\s\S]*assert exactly those values[\s\S]*every sample record/);
    const fin = events(log, "factory.run.finished").at(-1);
    expect(git(fin.dir, "log", "--format=%s").split("\n").slice(-3)).toEqual(["Acceptance tests (locked)", "App kit", "Spec and plan: Word Counter"]);
  });
});
