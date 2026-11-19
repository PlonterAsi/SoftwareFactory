import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EventLog, Factory, MockRuntime, parseFileBlocks, type AgentRequest, type AgentRuntime } from "../src/index.js";
import { evaluationPasses, validateEvaluation } from "../src/factory/evaluate.js";
import { readScreens } from "../src/factory/screencheck.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const events = (log: EventLog, type: string) => log.list({ limit: 1e6 }).filter((e) => e.type === type).map((e) => e.payload as any);
const station = (req: AgentRequest) => req.systemPrompt?.match(/Station contract: (\w+)/)?.[1] ?? "";

describe("the product judge: the running app is judged as a product", () => {
  const block = (j: unknown) => "```json\n" + JSON.stringify(j) + "\n```";
  const docs = {
    brief: { who: "A writer.", problem: "No idea how far along each piece is.", promise: "Shows each piece against its goal.", notThis: [] },
    research: [], assumptions: [],
    journeys: [{ moment: "A normal day", goal: "See progress", steps: ["Open Progress", "Add words"] }],
    screens: [{ id: "dashboard", name: "Progress", purpose: "Each piece against its goal.", shows: ["a bar per piece"], actions: ["add a piece"] }, { id: "log", name: "Session log", purpose: "What I wrote when.", shows: ["sessions"], actions: ["log a session"] }],
    requirements: [{ id: "R1", text: "A bar per piece against its goal", from: "person", must: true }, { id: "R2", text: "A session log with date and minutes", from: "person", must: true }, { id: "R3", text: "Confetti", from: "design", must: false }],
  };
  /** The judge's look at one screen just built: every S/A item of it met, unless `missing` names it. */
  const lookAnswer = (prompt: string, missing: string[] = []) => block({ requirements: [...prompt.matchAll(/^- ([SA]\d+): /gm)].map((m) => ({ id: m[1], met: !missing.includes(m[1]), evidence: missing.includes(m[1]) ? "The screen shows only a heading" : "Shown with sample pieces" })), scores: { function: 4, design: 4, content: 4 }, problems: [] });
  function crewWith(verdicts: { r2: boolean }[], look?: (prompt: string, nth: number) => string) {
    const mock = new MockRuntime({ plantBug: false });
    const seen: { station: string; req: AgentRequest }[] = [];
    let n = 0;
    let looks = 0;
    const rt: AgentRuntime = { name: "mock", run: async (req) => {
      const r = await mock.run(req);
      const st = station(req);
      seen.push({ station: st, req });
      if (st === "design") r.text = block(docs);
      if (st === "evaluate" && /This is a look at ONE screen/.test(req.prompt)) { r.text = look ? look(req.prompt, ++looks) : lookAnswer(req.prompt); return r; }
      if (st === "evaluate") {
        const v = verdicts[Math.min(n++, verdicts.length - 1)];
        // Screen items carried from the build are seen from the judge's second look on.
        const carried = [...req.prompt.matchAll(/^- (SC\d+): /gm)].map((m) => ({ id: m[1], met: n > 1, evidence: n > 1 ? "Now shown with sample pieces" : "Still only a heading" }));
        r.text = block({ requirements: [{ id: "R1", met: true, evidence: "Progress shows 3 bars" }, { id: "R2", met: v.r2, evidence: v.r2 ? "Session log lists 2 sessions" : "There is no session log screen" }, ...carried], scores: { function: v.r2 ? 4 : 2, design: 4, content: 4 }, problems: v.r2 ? [] : [{ where: "navigation", problem: "The Session log screen is missing.", fix: "Add the log view." }] });
      }
      return r;
    } };
    return { rt, seen };
  }
  const screens = [{ route: "home", text: "Progress Morning pages 12 / 50", controls: ["New piece"] }];

  it("with a real crew and a product budget, what the judge found is built as features in fresh sessions, then judged again", async () => {
    const log = new EventLog();
    const { rt: inner, seen } = crewWith([{ r2: false }, { r2: true }]);
    const rt: AgentRuntime = { name: "claude-code:fake", run: async (req) => {
      const r = await inner.run(req);
      if (station(req) === "build" && req.cwd) {
        const id = req.prompt.match(/Your feature, ([FJ]\d+)/)?.[1] ?? "";
        const files = parseFileBlocks(r.text);
        for (const f of id === "F1" || id === "F2" ? files : [{ path: "web/style.css", content: `/* ${id} */\n` + (files.find((x) => x.path === "web/style.css")?.content ?? "") }]) { mkdirSync(dirname(join(req.cwd, f.path)), { recursive: true }); writeFileSync(join(req.cwd, f.path), f.content); }
        r.text = `Built ${id}.`;
      }
      return r;
    } };
    const f = new Factory(log, rt, tmp("sf-proj-"));
    f.readScreens = async () => screens;
    const run = f.start("a writing desk", { autoApprove: true, autoRetries: 0, maxUsd: 10 });
    await f.wait(run);
    expect(events(log, "factory.run.finished").at(-1).outcome).toBe("shipped");
    expect(events(log, "factory.evaluation").map((e) => e.pass)).toEqual([false, true]);
    const repair = events(log, "factory.repair");
    expect(repair).toHaveLength(1);
    expect(repair[0].features[0].title).toMatch(/^Judge: requirements R2/);
    const j1 = seen.filter((x) => x.station === "build" && /Your feature, J1/.test(x.req.prompt));
    expect(j1).toHaveLength(1);
    expect(j1[0].req.prompt).toMatch(/R2: A session log with date and minutes[\s\S]*There is no session log screen/);
    expect(events(log, "factory.feature").filter((e) => e.id === "J1" && e.state === "built")).toHaveLength(1);
  });

  it("looks at each screen just after it is built and hands what is missing back to the same builder (cycle 4)", async () => {
    const log = new EventLog();
    // The first look at a screen finds its first shown item missing; every later look finds it all.
    const { rt: inner, seen } = crewWith([{ r2: true }], (prompt, nth) => lookAnswer(prompt, nth === 1 ? ["S1"] : []));
    const rt: AgentRuntime = { name: "claude-code:fake", run: async (req) => {
      const r = await inner.run(req);
      if (station(req) === "build" && req.cwd) {
        const id = req.prompt.match(/Your feature, ([FJ]\d+)/)?.[1] ?? "";
        const files = parseFileBlocks(r.text);
        for (const f of id === "F1" || id === "F2" ? files : [{ path: "web/style.css", content: `/* ${id} */\n` + (files.find((x) => x.path === "web/style.css")?.content ?? "") }]) { mkdirSync(dirname(join(req.cwd, f.path)), { recursive: true }); writeFileSync(join(req.cwd, f.path), f.content); }
        r.text = `Built ${id}.`;
      }
      return r;
    } };
    const f = new Factory(log, rt, tmp("sf-proj-"));
    f.readScreens = async () => [{ route: "dashboard", text: "Progress", controls: [] }, ...screens];
    const run = f.start("a writing desk", { autoApprove: true, autoRetries: 0, maxUsd: 10 });
    await f.wait(run);
    const looks = events(log, "factory.screen.look");
    expect(looks.length).toBeGreaterThanOrEqual(1);
    expect(looks[0]).toMatchObject({ screen: "dashboard", seen: 1, of: 2 });
    expect(looks[0].missing[0]).toMatch(/Progress screen shows a bar per piece[\s\S]*only a heading/);
    const feats = events(log, "factory.feature").filter((e) => e.id === looks[0].feature && e.state !== "building");
    expect(feats.map((e) => e.state)).toEqual(["broken", "built"]);
    expect(feats[0].hollow[0]).toMatch(/bar per piece/);
    const again = seen.filter((x) => x.station === "build" && x.req.prompt.includes(`Your feature, ${looks[0].feature}`))[1];
    expect(again.req.prompt).toMatch(/product judge opened the running app[\s\S]*bar per piece/);
    // The judge reads only that screen, at a small cap.
    const ask = seen.find((x) => x.station === "evaluate" && /look at ONE screen/.test(x.req.prompt))!;
    expect(ask.req.prompt).toMatch(/=== Screen #\/dashboard ===/);
    expect(ask.req.prompt).not.toMatch(/=== Screen #\/home ===/);
    expect(events(log, "factory.retro").at(-1).bad.join("\n")).toMatch(/judge did not find on its screen/);
    // After the retry the judge looks again, and this time it all shows.
    const mine = looks.filter((l) => l.feature === looks[0].feature);
    expect(mine.map((l) => [l.attempt, l.seen, l.of])).toEqual([[1, 1, 2], [2, 2, 2]]);
    expect(events(log, "factory.retro").at(-1).good.join("\n")).toMatch(/every screen sent back had what was missing on the second look/);
  });

  it("a screen still hollow after its retry is not taken on the Builder's word (run 3609)", async () => {
    const log = new EventLog();
    const { rt: inner, seen } = crewWith([{ r2: true }], (prompt) => lookAnswer(prompt, ["S1"]));
    const rt: AgentRuntime = { name: "claude-code:fake", run: async (req) => {
      const r = await inner.run(req);
      if (station(req) === "build" && req.cwd) {
        const id = req.prompt.match(/Your feature, ([FJ]\d+)/)?.[1] ?? "";
        const files = parseFileBlocks(r.text);
        for (const f of id === "F1" || id === "F2" ? files : [{ path: "web/style.css", content: `/* ${id} */\n` + (files.find((x) => x.path === "web/style.css")?.content ?? "") }]) { mkdirSync(dirname(join(req.cwd, f.path)), { recursive: true }); writeFileSync(join(req.cwd, f.path), f.content); }
        r.text = `Built ${id}.`;
      }
      return r;
    } };
    const f = new Factory(log, rt, tmp("sf-proj-"));
    f.readScreens = async () => [{ route: "dashboard", text: "Progress", controls: [] }, ...screens];
    const run = f.start("a writing desk", { autoApprove: true, autoRetries: 0, maxUsd: 10 });
    await f.wait(run);
    const first = events(log, "factory.screen.look").find((l) => !l.skipped)!;
    const feats = events(log, "factory.feature").filter((e) => e.id === first.feature && e.state !== "building");
    expect(feats.map((e) => [e.attempt, e.state])).toEqual([[1, "broken"], [2, "broken"]]);
    const retro = events(log, "factory.retro").at(-1);
    expect(retro.bad.join("\n")).toMatch(/still missed designed items on the second look \(dashboard: 1 of 2/);
    // Run 4004: the build moved on and nothing held the list. The open item is now one of the judge's
    // requirements for the whole app, goes to the repair work, and is looked for again.
    expect(first.open).toEqual(["The Progress screen shows a bar per piece, with real sample content"]);
    const judged = seen.filter((x) => x.station === "evaluate" && !/This is a look at ONE screen/.test(x.req.prompt));
    expect(judged[0].req.prompt).toMatch(/- SC1: The Progress screen shows a bar per piece, with real sample content/);
    const evals = events(log, "factory.evaluation");
    expect(evals.map((e) => e.pass)).toEqual([false, true]);
    expect(evals[0].requirements.find((r: any) => r.id === "SC1")).toMatchObject({ met: false, text: "The Progress screen shows a bar per piece, with real sample content" });
    expect(events(log, "factory.repair")[0].features.map((x: any) => x.title)).toEqual(["Judge: requirements SC1, SC2"]);
    const j1 = seen.find((x) => x.station === "build" && /Your feature, J1/.test(x.req.prompt))!;
    expect(j1.req.prompt).toMatch(/SC1: The Progress screen shows a bar per piece[\s\S]*Still only a heading/);
    expect(retro.bad.join("\n")).toMatch(/2 designed screen items still missing after the Builder's second try went to the judge's list/);
  });

  it("screen items carried to the judge survive a restart, and a later look that finds them all clears them", async () => {
    const { restoreState } = await import("../src/factory/loop.js");
    const { withScreenItems } = await import("../src/factory/evaluate.js");
    const log = new EventLog();
    const run = log.append("factory.run.started", { idea: "x" }).id;
    log.append("factory.screen.look", { run, feature: "F3", screen: "dashboard", attempt: 2, seen: 1, of: 2, open: ["The Progress screen shows a bar per piece, with real sample content"] });
    log.append("factory.screen.look", { run, feature: "F4", screen: "log", attempt: 1, seen: 0, of: 2, open: ["The Session log screen shows sessions, with real sample content"] });
    log.append("factory.screen.look", { run, feature: "F4", screen: "log", attempt: 2, seen: 2, of: 2, open: [] });
    expect(restoreState(log, run).screenOpen).toEqual({ F3: ["The Progress screen shows a bar per piece, with real sample content"] });
    const d = withScreenItems(docs as never, ["The Progress screen shows a bar per piece, with real sample content", "The Progress screen shows a bar per piece, with real sample content", "A bar per piece against its goal"]);
    // Said once, never a copy of a requirement the design already has, and the design's own list is untouched.
    expect(d.requirements.map((r) => r.id)).toEqual(["R1", "R2", "R3", "SC1"]);
    expect(withScreenItems(docs as never, [])).toBe(docs);
  });

  it("finds the designed screen for a view by its name when the Planner renamed its id (run 3609)", async () => {
    const { designScreenFor } = await import("../src/factory/features.js");
    const d = { ...docs, screens: [{ ...docs.screens[0], id: "progress", name: "My Games" }, docs.screens[1]] } as never;
    expect(designScreenFor(d, "my-games", "My Games")?.id).toBe("progress");
    expect(designScreenFor(d, "session_log", "Session Log")?.id).toBe("log");
    expect(designScreenFor(d, "Log")?.id).toBe("log");
    expect(designScreenFor(d, "practice", "Practice")).toBeUndefined();
    expect(designScreenFor(d, "dashboard")?.id).toBe("progress");
  });

  it("a repair that cannot finish never fails the run: the build gate gets what is built (run 3609)", async () => {
    const log = new EventLog();
    const { rt: inner } = crewWith([{ r2: false }, { r2: false }]);
    const rt: AgentRuntime = { name: "claude-code:fake", run: async (req) => {
      if (station(req) === "build" && /Your feature, J\d+/.test(req.prompt)) {
        // The repair writes half a file and dies at its cap, every time.
        if (req.cwd) writeFileSync(join(req.cwd, "web/half.js"), "export const half = ");
        throw new Error("claude exited 1: error_max_budget_usd");
      }
      const r = await inner.run(req);
      if (station(req) === "build" && req.cwd) {
        const id = req.prompt.match(/Your feature, ([FJ]\d+)/)?.[1] ?? "";
        const files = parseFileBlocks(r.text);
        for (const f of id === "F1" || id === "F2" ? files : [{ path: "web/style.css", content: `/* ${id} */\n` + (files.find((x) => x.path === "web/style.css")?.content ?? "") }]) { mkdirSync(dirname(join(req.cwd, f.path)), { recursive: true }); writeFileSync(join(req.cwd, f.path), f.content); }
        r.text = `Built ${id}.`;
      }
      return r;
    } };
    const f = new Factory(log, rt, tmp("sf-proj-"));
    f.readScreens = async () => screens;
    const run = f.start("a writing desk", { autoApprove: true, autoRetries: 0, maxUsd: 10 });
    await f.wait(run).catch(() => {});
    expect(events(log, "factory.run.finished").at(-1).outcome).toBe("shipped");
    const stopped = events(log, "factory.repair.stopped");
    expect(stopped[0].reason).toMatch(/a repair call failed: .*error_max_budget_usd/);
    const fin = events(log, "factory.run.finished").at(-1);
    expect(existsSync(join(fin.dir, "web/half.js"))).toBe(false);
    expect(events(log, "factory.retro").at(-1).bad.join("\n")).toMatch(/Repair: stopped/);
  });

  it("a repair the money left cannot fund does not start (run 3609)", async () => {
    const log = new EventLog();
    const { rt: inner, seen } = crewWith([{ r2: false }, { r2: false }]);
    const rt: AgentRuntime = { name: "claude-code:fake", run: async (req) => {
      const r = await inner.run(req);
      if (station(req) === "build" && req.cwd) {
        const id = req.prompt.match(/Your feature, ([FJ]\d+)/)?.[1] ?? "";
        const files = parseFileBlocks(r.text);
        for (const f of id === "F1" || id === "F2" ? files : [{ path: "web/style.css", content: `/* ${id} */\n` + (files.find((x) => x.path === "web/style.css")?.content ?? "") }]) { mkdirSync(dirname(join(req.cwd, f.path)), { recursive: true }); writeFileSync(join(req.cwd, f.path), f.content); }
        r.text = `Built ${id}.`;
        // The first repair eats the whole repair pool.
        if (/^J/.test(id)) r.costUsd = 5;
      }
      return r;
    } };
    const f = new Factory(log, rt, tmp("sf-proj-"));
    f.readScreens = async () => screens;
    const run = f.start("a writing desk", { autoApprove: true, autoRetries: 0, maxUsd: 10 });
    await f.wait(run).catch(() => {});
    expect(events(log, "factory.run.finished").at(-1).outcome).toBe("shipped");
    const repairs = seen.filter((x) => x.station === "build" && /Your feature, J\d+/.test(x.req.prompt));
    expect(repairs).toHaveLength(1);
    expect(events(log, "factory.repair.stopped")[0]).toMatchObject({ reason: expect.stringMatching(/left for repairs, under the \$0\.30 one needs/) });
  });

  it("a review that still says fix after its last round is recorded and goes first into the repair features (run 3185)", async () => {
    const log = new EventLog();
    const { rt: inner, seen } = crewWith([{ r2: false }, { r2: true }]);
    const rt: AgentRuntime = { name: "claude-code:fake", run: async (req) => {
      const r = await inner.run(req);
      if (station(req) === "review") r.text = /run ONLY these criteria again/.test(req.prompt)
        ? block({ verdict: "pass", findings: [], criteria: [{ text: "Research merges keep every item", pass: true, evidence: "merge kept 5 of 5 items" }] })
        : block({ verdict: "fix", findings: [{ severity: "high", text: "Needs a look matches are never saved" }], criteria: [{ text: "Every piece has a goal", pass: true, evidence: "3 of 3" }, { text: "Research merges keep every item", pass: false, evidence: "merge dropped 3 of 5 items" }] });
      if (station(req) === "build" && req.cwd) {
        const id = req.prompt.match(/Your feature, ([FJ]\d+)/)?.[1] ?? "";
        const files = parseFileBlocks(r.text);
        for (const f of id === "F1" || id === "F2" ? files : [{ path: "web/style.css", content: `/* ${id} */\n` + (files.find((x) => x.path === "web/style.css")?.content ?? "") }]) { mkdirSync(dirname(join(req.cwd, f.path)), { recursive: true }); writeFileSync(join(req.cwd, f.path), f.content); }
        r.text = `Built ${id}.`;
      }
      return r;
    } };
    const f = new Factory(log, rt, tmp("sf-proj-"));
    f.readScreens = async () => screens;
    const run = f.start("a writing desk", { autoApprove: true, autoRetries: 0, maxUsd: 10 });
    await f.wait(run);
    expect(events(log, "factory.review.open")).toMatchObject([{ round: 2, failing: ["Research merges keep every item"], findings: ["Needs a look matches are never saved"] }]);
    expect(events(log, "factory.station").filter((s) => s.station === "review").at(-1).note).toMatch(/still "fix" after 2 reviews: 1 criteria failing/);
    const repair = events(log, "factory.repair")[0];
    expect(repair.features.map((x: any) => x.title)).toEqual(["Judge: what the Reviewer proved still broken", expect.stringMatching(/^Judge: requirements R2/), "Judge: what a user would notice"]);
    const j0 = seen.find((x) => x.station === "build" && /Your feature, J0/.test(x.req.prompt))!;
    expect(j0.req.prompt).toMatch(/Research merges keep every item[\s\S]*merge dropped 3 of 5[\s\S]*Needs a look matches are never saved/);
    // After the repair the Reviewer runs only what failed, so the build gate says what is true now.
    const reviews = events(log, "factory.review");
    expect(reviews.map((r) => r.verdict)).toEqual(["fix", "fix", "pass"]);
    expect(reviews[2]).toMatchObject({ recheck: true, round: 3, criteria: [{ text: "Every piece has a goal", pass: true }, { text: "Research merges keep every item", pass: true, evidence: "merge kept 5 of 5 items" }] });
    const recheck = seen.filter((x) => x.station === "review").at(-1)!;
    expect(recheck.req.prompt).toMatch(/1\. Research merges keep every item/);
    expect(recheck.req.prompt).not.toMatch(/Every piece has a goal/);
    const gateB = events(log, "factory.gate").filter((g) => g.gate === "gateB")[0];
    expect(gateB.question).not.toMatch(/acceptance criteri/);
  });

  it("what the Reviewer saw fail is repaired even when the judge passes the screens (run 4004)", async () => {
    const log = new EventLog();
    const { rt: inner } = crewWith([{ r2: true }]);
    const rt: AgentRuntime = { name: "claude-code:fake", run: async (req) => {
      const r = await inner.run(req);
      // The second run of the criterion still fails: the gate keeps saying so.
      if (station(req) === "review") r.text = block({ verdict: "fix", findings: [], criteria: [{ text: "Stale items are marked after 30 days", pass: false, evidence: "nothing is marked" }] });
      if (station(req) === "build" && req.cwd) {
        const id = req.prompt.match(/Your feature, ([FJ]\d+)/)?.[1] ?? "";
        const files = parseFileBlocks(r.text);
        for (const f of id === "F1" || id === "F2" ? files : [{ path: "web/style.css", content: `/* ${id} */\n` + (files.find((x) => x.path === "web/style.css")?.content ?? "") }]) { mkdirSync(dirname(join(req.cwd, f.path)), { recursive: true }); writeFileSync(join(req.cwd, f.path), f.content); }
        r.text = `Built ${id}.`;
      }
      return r;
    } };
    const f = new Factory(log, rt, tmp("sf-proj-"));
    f.readScreens = async () => screens;
    const run = f.start("a writing desk", { autoApprove: true, autoRetries: 0, maxUsd: 10 });
    await f.wait(run);
    expect(events(log, "factory.run.finished").at(-1).outcome).toBe("shipped");
    expect(events(log, "factory.evaluation").map((e) => e.pass)).toEqual([true, true]);
    expect(events(log, "factory.repair")[0].features.map((x: any) => x.title)).toEqual(["Judge: what the Reviewer proved still broken"]);
    expect(events(log, "factory.review").at(-1)).toMatchObject({ recheck: true, verdict: "fix" });
    expect(events(log, "factory.gate").filter((g) => g.gate === "gateB")[0].question).toMatch(/1 acceptance criterion not seen working/);
  });

  it("merges a second run of the failing criteria into the review", async () => {
    const { mergeRecheck } = await import("../src/factory/loop.js");
    const before = { verdict: "fix" as const, findings: [{ severity: "low" as const, text: "Long function" }, { severity: "high" as const, text: "Acceptance criterion not met: B (old)" }, { severity: "high" as const, text: "Acceptance criterion not met: C (old)" }],
      criteria: [{ text: "A", pass: true, evidence: "ok" }, { text: "B", pass: false, evidence: "old" }, { text: "C", pass: false, evidence: "old" }] };
    const m = mergeRecheck(before, { verdict: "fix", findings: [], criteria: [{ text: "b", pass: true, evidence: "now fine" }, { text: "c", pass: false, evidence: "still wrong" }] });
    expect(m.verdict).toBe("fix");
    expect(m.criteria).toEqual([{ text: "A", pass: true, evidence: "ok" }, { text: "B", pass: true, evidence: "now fine" }, { text: "C", pass: false, evidence: "still wrong" }]);
    expect(m.findings.map((x) => x.text)).toEqual(["Long function", "Acceptance criterion not met: C (still wrong)"]);
    // An answer for only one of them is matched by its text; the other keeps its old result.
    const one = mergeRecheck(before, { verdict: "pass", findings: [], criteria: [{ text: "C", pass: true, evidence: "fixed" }] });
    expect(one.criteria!.map((c) => c.pass)).toEqual([true, false, true]);
    expect(mergeRecheck(before, { verdict: "pass", findings: [], criteria: [{ text: "x", pass: true, evidence: "" }, { text: "y", pass: true, evidence: "" }] }).verdict).toBe("pass");
  });

  it("a run resumed after its build still turns the judge's findings into repair features (run 3185)", async () => {
    const log = new EventLog();
    const dir = tmp("sf-proj-");
    const { rt: inner } = crewWith([{ r2: false }, { r2: true }]);
    let hang = true;
    const rt: AgentRuntime = { name: "claude-code:fake", run: async (req) => {
      if (hang && station(req) === "review") return new Promise(() => {});
      const r = await inner.run(req);
      if (station(req) === "build" && req.cwd) {
        const id = req.prompt.match(/Your feature, ([FJ]\d+)/)?.[1] ?? "";
        const files = parseFileBlocks(r.text);
        for (const f of id === "F1" || id === "F2" ? files : [{ path: "web/style.css", content: `/* ${id} */\n` + (files.find((x) => x.path === "web/style.css")?.content ?? "") }]) { mkdirSync(dirname(join(req.cwd, f.path)), { recursive: true }); writeFileSync(join(req.cwd, f.path), f.content); }
        r.text = `Built ${id}.`;
      }
      return r;
    } };
    const first = new Factory(log, rt, dir);
    const run = first.start("a writing desk", { autoApprove: true, autoRetries: 0, maxUsd: 10 });
    for (let i = 0; i < 1000 && !events(log, "agent.run.started").some((a) => a.station === "review"); i++) await new Promise((r) => setTimeout(r, 10));
    // The app restarts during the review: a new core on the same database picks the run up.
    hang = false;
    const second = new Factory(log, rt, dir);
    second.readScreens = async () => screens;
    expect(second.resumeInterrupted()).toEqual([run]);
    await second.wait(run);
    expect(events(log, "factory.evaluation").map((e) => e.pass)).toEqual([false, true]);
    expect(events(log, "factory.repair")).toHaveLength(1);
  });

  it("an unmet requirement goes back to the fix loop as work, and the app is judged again", async () => {
    const log = new EventLog();
    const { rt, seen } = crewWith([{ r2: false }, { r2: true }]);
    const f = new Factory(log, rt, tmp("sf-proj-"));
    f.readScreens = async () => screens;
    const run = f.start("a writing desk", { autoApprove: true, autoRetries: 0, maxUsd: 5 });
    await f.wait(run);
    expect(events(log, "factory.run.finished").at(-1).outcome).toBe("shipped");
    const evs = events(log, "factory.evaluation");
    expect(evs.map((e) => e.pass)).toEqual([false, true]);
    // The judge sees the person's words, the design and the screens; never the code.
    const judge = seen.find((x) => x.station === "evaluate")!.req.prompt;
    expect(judge).toMatch(/a writing desk/);
    expect(judge).toMatch(/R2: A session log/);
    expect(judge).not.toMatch(/R3/);
    expect(judge).toMatch(/=== Screen #\/home ===\nProgress Morning pages 12 \/ 50\nControls: New piece/);
    expect(judge).not.toMatch(/<<<FILE/);
    // The Fixer got the failure as concrete work.
    const fix = seen.filter((x) => x.station === "fix").at(-1)!.req.prompt;
    expect(fix).toMatch(/Requirement R2 is not met: A session log with date and minutes/);
    expect(fix).toMatch(/There is no session log screen/);
    // Order: review, then the judge, then the build gate.
    const order = events(log, "factory.station").filter((s) => s.state === "pass").map((s) => s.station);
    expect(order.lastIndexOf("review")).toBeLessThan(order.indexOf("evaluate"));
  });

  it("what is still open after the second look is put in front of the person at the build gate", async () => {
    const log = new EventLog();
    const { rt } = crewWith([{ r2: false }]);
    const f = new Factory(log, rt, tmp("sf-proj-"));
    f.readScreens = async () => screens;
    const run = f.start("a writing desk", { autoRetries: 0, maxUsd: 5 });
    for (let i = 0; i < 400; i++) {
      const g = events(log, "factory.gate").at(-1);
      if (g?.state === "waiting" && g.gate === "gateB") break;
      if (g?.state === "waiting") f.decide(run, g.gate, { approve: true });
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(events(log, "factory.evaluation")).toHaveLength(2);
    expect(events(log, "factory.gate").at(-1).question).toMatch(/product judge: 1 of 2 requirements not seen working/);
    f.decide(run, "gateB", { approve: true });
    await f.wait(run);
  });

  it("a send-back at the build gate builds the note and what the judge found as features, then judges again (run 4004)", async () => {
    const log = new EventLog();
    const { rt: inner, seen } = crewWith([{ r2: false }, { r2: false }, { r2: true }]);
    const rt: AgentRuntime = { name: "claude-code:fake", run: async (req) => {
      const r = await inner.run(req);
      if (station(req) === "build" && req.cwd) {
        const id = req.prompt.match(/Your feature, ([A-Z0-9]+)/)?.[1] ?? "";
        const files = parseFileBlocks(r.text);
        for (const f of id === "F1" || id === "F2" ? files : [{ path: "web/style.css", content: `/* ${id} */\n` + (files.find((x) => x.path === "web/style.css")?.content ?? "") }]) { mkdirSync(dirname(join(req.cwd, f.path)), { recursive: true }); writeFileSync(join(req.cwd, f.path), f.content); }
        r.text = `Built ${id}.`;
      }
      return r;
    } };
    const f = new Factory(log, rt, tmp("sf-proj-"));
    f.readScreens = async () => screens;
    const run = f.start("a writing desk", { autoRetries: 0, maxUsd: 20 });
    const atGateB = async (n: number) => { for (let i = 0; i < 800; i++) { const w = events(log, "factory.gate").filter((g) => g.gate === "gateB" && g.state === "waiting").length; const g = events(log, "factory.gate").at(-1); if (w >= n && g?.state === "waiting") return; if (g?.state === "waiting" && g.gate !== "gateB") f.decide(run, g.gate, { approve: true }); await new Promise((r) => setTimeout(r, 25)); } };
    await atGateB(1);
    const judged = events(log, "factory.evaluation").length;
    f.decide(run, "gateB", { approve: false, note: "Need to address the issues found on this loop" });
    await atGateB(2);
    const rep = events(log, "factory.repair").find((r) => r.from === "gateB");
    expect(rep.features[0]).toMatchObject({ id: "G2P", title: "Person: what you asked for at the build gate" });
    expect(rep.features.map((x: any) => x.id).slice(1).every((id: string) => id.startsWith("G2"))).toBe(true);
    const asked = seen.find((x) => x.station === "build" && /Your feature, G2P/.test(x.req.prompt))!;
    expect(asked.req.prompt).toMatch(/Need to address the issues found on this loop/);
    expect(events(log, "factory.evaluation").length).toBe(judged + 1);
    f.decide(run, "gateB", { approve: true });
    await f.wait(run);
    expect(events(log, "factory.run.finished").at(-1).outcome).toBe("shipped");
  });

  it("the next version of a shipped app runs on the same engine: the ask is designed in, built as features, and judged on what it adds", async () => {
    const log = new EventLog();
    const { rt: inner, seen } = crewWith([{ r2: true }]);
    const builds: string[] = [];
    const rt: AgentRuntime = { name: "claude-code:fake", run: async (req) => {
      const r = await inner.run(req);
      // The Designer's next-version answer adds a requirement and a screen, and forgets R2, R3 and the Session log.
      if (station(req) === "design" && /This product already shipped/.test(req.prompt)) r.text = block({ ...docs,
        screens: [docs.screens[0], { id: "summary", name: "Weekly summary", purpose: "The week at a glance.", shows: ["words per day"], actions: ["pick a week"] }],
        requirements: [docs.requirements[0], { id: "R4", text: "A weekly summary of the words written each day", from: "person", must: true }] });
      if (station(req) === "build" && req.cwd) {
        const id = req.prompt.match(/Your feature, ([\w.-]+):/)?.[1] ?? "";
        builds.push(id);
        const files = parseFileBlocks(r.text);
        for (const f of id === "F1" || id === "F2" ? files : [{ path: "web/style.css", content: `/* ${id} */\n` + (files.find((x) => x.path === "web/style.css")?.content ?? "") }]) { mkdirSync(dirname(join(req.cwd, f.path)), { recursive: true }); writeFileSync(join(req.cwd, f.path), f.content); }
        r.text = `Built ${id}.`;
      }
      return r;
    } };
    const f = new Factory(log, rt, tmp("sf-proj-"));
    f.readScreens = async () => screens;
    const first = f.start("a writing desk", { autoApprove: true, autoRetries: 0, maxUsd: 10 });
    await f.wait(first);
    expect(events(log, "factory.run.finished").at(-1).outcome).toBe("shipped");
    builds.length = 0;
    const before = seen.length;
    const next = f.addFeature(first, "show me a weekly summary", { autoApprove: true, autoRetries: 0, maxUsd: 5 });
    await f.wait(next);
    const fin = events(log, "factory.run.finished").at(-1);
    expect(fin).toMatchObject({ run: next, outcome: "shipped" });
    const mine = seen.slice(before);
    // Design: the shipped documents and the ask, no research, and nothing that shipped falls out.
    const design = mine.find((x) => x.station === "design")!;
    expect(design.req.prompt).toMatch(/This product already shipped[\s\S]*A session log with date and minutes[\s\S]*show me a weekly summary/);
    expect(mine.some((x) => /This time you only research/.test(x.req.prompt))).toBe(false);
    const d = events(log, "factory.discovery").filter((x) => x.run === next).at(-1).docs;
    expect(d.requirements.map((r: any) => r.id)).toEqual(["R1", "R2", "R3", "R4"]);
    expect(d.screens.map((x: any) => x.id)).toEqual(["dashboard", "summary", "log"]);
    // The Critic judges it knowing both the first idea and the ask.
    expect(mine.find((x) => x.station === "critique" && !/you check a plan/.test(x.req.prompt))!.req.prompt).toMatch(/a writing desk\n\nThe app shipped\. For its next version the person now asks: show me a weekly summary/);
    // Plan: told what is new, not to plan the whole design again.
    const plan = mine.find((x) => x.station === "plan")!.req.prompt;
    expect(plan).toMatch(/This app already shipped/);
    expect(plan).toMatch(/Product documents of the next version[\s\S]*New in this version:\n- R4: A weekly summary/);
    expect(plan).not.toMatch(/Implement this design: one view per screen/);
    // Build: features of this version only, each in its own session, with ids the shipped list does not hold.
    expect(builds.slice(0, 2)).toEqual(["v0.2.0-1", "v0.2.0-2"]);
    const b1 = mine.find((x) => x.station === "build")!.req.prompt;
    expect(b1).toMatch(/This app already shipped and the person uses it\. They now ask: show me a weekly summary/);
    expect(b1).not.toMatch(/Current code:/);
    expect(JSON.parse(readFileSync(join(fin.dir, "features.json"), "utf8")).features[0]).toMatchObject({ id: "v0.2.0-1", state: "built" });
    // Judge: only what this version adds; the repair work is this version's too.
    const evals = events(log, "factory.evaluation").filter((e) => e.run === next);
    expect(evals[0].requirements.map((r: any) => r.id)).toEqual(["R4"]);
    const judge = mine.find((x) => x.station === "evaluate")!.req.prompt;
    expect(judge).toMatch(/The must-have requirements:\n- R4: A weekly summary/);
    expect(judge).not.toMatch(/- R1: /);
    expect(events(log, "factory.repair").filter((e) => e.run === next)[0].features[0].title).toBe("Judge: requirements R4");
    expect(readFileSync(join(fin.dir, "docs/product/SCREENS.md"), "utf8")).toMatch(/Weekly summary/);
    // A third version finds the design of the second.
    const { shippedDesign } = await import("../src/factory/loop.js");
    expect(shippedDesign(log, next)).toMatchObject({ idea: "a writing desk" });
    expect(shippedDesign(log, next).docs!.requirements.map((r) => r.id)).toEqual(["R1", "R2", "R3", "R4"]);
  }, 60000);

  it("next-version helpers: the ask as a requirement, what is new, and the features a version adds", async () => {
    const { withAsk, mergeNextDocs, newRequirements } = await import("../src/factory/discovery.js");
    const { nextFeaturesOf } = await import("../src/factory/features.js");
    const base = docs as never as import("../src/factory/discovery.js").ProductDocs;
    const full = { ...base, rules: [{ name: "Goal", rule: "A piece is done at its goal." }] };
    const asked = withAsk(full, "export my pieces as a file");
    expect(asked.requirements.at(-1)).toEqual({ id: "N1", text: "export my pieces as a file", from: "person", must: true });
    expect(withAsk(asked, "export my pieces as a file")).toBe(asked);
    expect(withAsk(asked, "and print them").requirements.at(-1)!.id).toBe("N2");
    expect(newRequirements(full, asked).map((r) => r.id)).toEqual(["N1"]);
    // An answer that reuses a shipped id for something new gets an id of its own; shipped rules come back.
    const merged = mergeNextDocs(full, { ...full, rules: [], requirements: [{ id: "R1", text: "Export as a file", from: "person", must: true }] });
    expect(merged.requirements.map((r) => r.id)).toEqual(["R1", "R2", "R3", "N4"]);
    expect(merged.requirements[0].text).toBe("A bar per piece against its goal");
    expect(merged.rules).toHaveLength(1);
    const plan0 = { name: "Desk", slug: "desk", summary: "s", interface: "countWords(text)", acceptance: ["a"], tasks: [], app: true,
      entities: [{ name: "piece", label: "Piece", fields: [{ name: "title", type: "text" }] }],
      views: [{ id: "dashboard", label: "Progress", shows: "a bar per piece" }, { id: "log", label: "Session log", shows: "sessions" }] } as never as import("../src/factory/loop.js").Plan;
    const plan1 = { ...plan0, entities: [{ name: "piece", label: "Piece", fields: [{ name: "title", type: "text" }, { name: "exportedAt", type: "date" }] }, { name: "export", label: "Export", fields: [{ name: "file", type: "text" }] }],
      views: [plan0.views![0], { id: "log", label: "Session log", shows: "sessions, with an Export button" }, { id: "exports", label: "Exports", shows: "every export made" }] } as never as import("../src/factory/loop.js").Plan;
    const feats = nextFeaturesOf(plan0, plan1, full, "export my pieces as a file", "v0.3.0");
    expect(feats.map((x) => [x.id, x.title])).toEqual([["v0.3.0-1", "The next version's model and logic"], ["v0.3.0-2", "Screen: Session log"], ["v0.3.0-3", "Screen: Exports"]]);
    expect(feats[0].what).toMatch(/piece gains: exportedAt \(optional[\s\S]*New entity export: file/);
    expect(feats[1].what).toMatch(/^The view "log" in web\/app\.js already exists[\s\S]*Keep everything it does today/);
    expect(feats[2].what).toMatch(/^The view "exports" in web\/app\.js, new in this version/);
    // A plan that changed no view still puts the ask on a screen.
    expect(nextFeaturesOf(plan0, plan0, full, "faster counting", "v0.3.0").map((x) => x.title)).toEqual(["The next version's model and logic", "Screen: where the ask shows"]);
  });

  it("no browser, no verdict: the judge is skipped and says so, it never guesses", async () => {
    const log = new EventLog();
    const { rt, seen } = crewWith([{ r2: true }]);
    const f = new Factory(log, rt, tmp("sf-proj-"));
    const run = f.start("a writing desk", { autoApprove: true, autoRetries: 0, maxUsd: 5 });
    await f.wait(run);
    expect(seen.some((x) => x.station === "evaluate")).toBe(false);
    expect(events(log, "factory.evaluation")[0]).toMatchObject({ pass: false, skipped: expect.stringMatching(/could not be read/) });
    expect(events(log, "factory.station").some((s) => s.station === "evaluate" && s.state === "skipped")).toBe(true);
  });

  it("the core decides: a requirement the judge skipped is not met, and a missing score fails", () => {
    const e = validateEvaluation({ requirements: [{ id: "R1", met: true, evidence: "x" }], scores: { function: 5, design: 5, content: 5 } }, docs as any);
    expect(e.requirements.map((r) => [r.id, r.met])).toEqual([["R1", true], ["R2", false]]);
    expect(evaluationPasses(e)).toBe(false);
    const ok = validateEvaluation({ requirements: [{ id: "R1", met: true, evidence: "x" }, { id: "R2", met: true, evidence: "y" }], scores: { function: 4, design: 4 } }, docs as any);
    expect(ok.scores.content).toBe(1);
    expect(evaluationPasses(ok)).toBe(false);
  });

  it("with no browser there are no screens to read", async () => {
    expect(await readScreens("http://127.0.0.1:1", { browser: null })).toBeNull();
  });
});
