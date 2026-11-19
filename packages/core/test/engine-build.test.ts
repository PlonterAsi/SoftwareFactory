import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EventLog, Factory, MockRuntime, parseFileBlocks, git, type AgentRequest, type AgentRuntime } from "../src/index.js";
import { checkLinks } from "../src/factory/linkcheck.js";
import { critiquePasses, validateCritique, validateDocs } from "../src/factory/discovery.js";
import { checkScreens } from "../src/factory/screencheck.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const events = (log: EventLog, type: string) => log.list({ limit: 1e6 }).filter((e) => e.type === type).map((e) => e.payload as any);
const station = (req: AgentRequest) => req.systemPrompt?.match(/Station contract: (\w+)/)?.[1] ?? "";

describe("discovery: the idea becomes a designed product before any plan", () => {
  const good = { coverage: 5, journey: 4, screens: 4, originality: 4, buildable: 5 };
  const docs = (home: string) => ({
    brief: { who: "A Rocket League player stuck at Platinum.", problem: "Guides are scattered and not sorted by level.", promise: "Shows the three things worth practising today.", notThis: ["a wiki"] },
    research: [{ finding: "Air dribbles are taught by the community, not the game.", source: "https://liquipedia.net/rocketleague/Air_Dribble" }],
    journeys: [{ moment: "A normal day", goal: "Know what to practise", steps: ["Open Today", "Pick a drill", "Log the session"] }],
    screens: [{ id: "dashboard", name: home, purpose: "The three drills for today.", shows: ["drills"], actions: ["start a drill"] }, { id: "tree", name: "Skill tree", purpose: "Where I stand.", shows: ["skills"], actions: ["open a skill"] }],
    requirements: [{ id: "R1", text: "Rank what to practise by the player's level", from: "person", must: true }, { id: "R2", text: "A streak counter", from: "design", must: false }],
    assumptions: [],
  });
  const block = (j: unknown) => "```json\n" + JSON.stringify(j) + "\n```";
  function crewWith(critiques: Record<string, number>[]) {
    const mock = new MockRuntime({ plantBug: false });
    const seen: { station: string; req: AgentRequest }[] = [];
    let designs = 0, crits = 0;
    const rt: AgentRuntime = { name: "mock", run: async (req) => {
      const r = await mock.run(req);
      const st = station(req);
      seen.push({ station: st, req });
      if (st === "design") r.text = block(docs(`Today v${++designs}`));
      if (st === "critique" && !/you check a plan/.test(req.prompt)) {
        const scores = critiques[Math.min(crits++, critiques.length - 1)];
        r.text = block({ scores, problems: scores.screens < 4 ? [{ where: "screens/tree", problem: "The skill tree is only a list.", fix: "Draw it as a tree with locked branches." }] : [] });
      }
      return r;
    } };
    return { rt, seen };
  }

  it("the Critic sends the design back until every score reaches the bar; the Planner then plans from the documents", async () => {
    const log = new EventLog();
    const { rt, seen } = crewWith([{ ...good, screens: 2 }, good]);
    const f = new Factory(log, rt, tmp("sf-proj-"));
    const run = f.start("a coach for one game", { autoApprove: true, autoRetries: 0, maxUsd: 5 });
    await f.wait(run);
    const fin = events(log, "factory.run.finished").at(-1);
    expect(fin.outcome).toBe("shipped");
    const rounds = events(log, "factory.discovery");
    expect(rounds.map((r) => r.pass)).toEqual([false, true]);
    // Round 2: the Designer got its own documents and the Critic's problem, not a blank page.
    const designs = seen.filter((x) => x.station === "design");
    expect(designs).toHaveLength(2);
    expect(designs[1].req.prompt).toMatch(/Today v1/);
    expect(designs[1].req.prompt).toMatch(/only a list.*Draw it as a tree/s);
    // The Critic never sees the Designer's reasoning, only the person's words and the documents.
    expect(seen.find((x) => x.station === "critique")!.req.prompt).toMatch(/a coach for one game/);
    // The Planner plans from the documents that passed.
    const plan = seen.find((x) => x.station === "plan")!.req.prompt;
    expect(plan).toMatch(/Product documents/);
    expect(plan).toMatch(/Today v2/);
    expect(plan).toMatch(/R1: Rank what to practise/);
    // They live in the project for every later agent and the person.
    expect(readFileSync(join(fin.dir, "docs/product/SCREENS.md"), "utf8")).toMatch(/Today v2/);
    expect(readFileSync(join(fin.dir, "docs/product/REQUIREMENTS.md"), "utf8")).toMatch(/Rank what to practise/);
    expect(readFileSync(join(fin.dir, "docs/product/BRIEF.md"), "utf8")).toMatch(/stuck at Platinum/);
    // The station order on the floor.
    const order = events(log, "factory.station").filter((s) => s.state === "pass").map((s) => s.station);
    expect(order.indexOf("discover")).toBeLessThan(order.indexOf("plan"));
  });

  it("stops after three rounds, goes on with the best-scored documents and says why", async () => {
    const log = new EventLog();
    const { rt, seen } = crewWith([{ ...good, screens: 2 }, { ...good, screens: 3 }, { ...good, screens: 2 }]);
    const f = new Factory(log, rt, tmp("sf-proj-"));
    const run = f.start("a coach for one game", { autoApprove: true, autoRetries: 0, maxUsd: 5 });
    await f.wait(run);
    expect(seen.filter((x) => x.station === "design")).toHaveLength(3);
    // The Critic's second and third calls carry what it asked for; the Designer's last call is told to cut.
    const crits = seen.filter((x) => x.station === "critique" && !/you check a plan/.test(x.req.prompt));
    expect(crits[0].req.prompt).not.toMatch(/You judged the version before/);
    expect(crits[1].req.prompt).toMatch(/You judged the version before[\s\S]*The skill tree is only a list/);
    expect(seen.filter((x) => x.station === "design").map((x) => /last round, so nothing may stay open/.test(x.req.prompt))).toEqual([false, false, true]);
    const last = events(log, "factory.discovery").at(-1);
    expect(last).toMatchObject({ pass: false, round: 2, settled: "still under the bar after 3 rounds" });
    expect(seen.find((x) => x.station === "plan")!.req.prompt).toMatch(/Today v2/);
    expect(events(log, "factory.run.finished").at(-1).outcome).toBe("shipped");
  });

  it("the core decides from the scores: a missing score fails, and unusable documents are refused", () => {
    expect(critiquePasses(validateCritique({ scores: good }))).toBe(true);
    expect(critiquePasses(validateCritique({ scores: { ...good, originality: 3 } }))).toBe(false);
    expect(validateCritique({ scores: { coverage: 5 } }).scores.journey).toBe(1);
    expect(() => validateDocs({ ...docs("Today"), screens: [docs("Today").screens[0]] })).toThrow(/at least two screens/);
    expect(() => validateDocs({ ...docs("Today"), journeys: [] })).toThrow(/no journey/);
  });

  it("the next version of a shipped app keeps its design: no discovery", async () => {
    const log = new EventLog();
    const { rt, seen } = crewWith([good]);
    const f = new Factory(log, rt, tmp("sf-proj-"));
    const run = f.start("a coach for one game", { autoApprove: true, autoRetries: 0, maxUsd: 5 });
    await f.wait(run);
    const before = seen.filter((x) => x.station === "design").length;
    const next = f.addFeature(run, "add a weekly summary", { autoApprove: true, autoRetries: 0, maxUsd: 5 });
    await f.wait(next);
    expect(seen.filter((x) => x.station === "design").length).toBe(before);
    expect(events(log, "factory.station").some((s) => s.run === next && s.station === "discover" && s.state === "skipped")).toBe(true);
    // The design travels with the app: a small next version keeps it and adds the ask to its requirements.
    const kept = events(log, "factory.discovery").filter((d) => d.run === next);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ kept: run, pass: true });
    expect(kept[0].docs.requirements.at(-1)).toEqual({ id: "N1", text: "add a weekly summary", from: "person", must: true });
    expect(kept[0].docs.screens.map((x: any) => x.name)).toEqual(events(log, "factory.discovery").filter((d) => d.run === run).at(-1).docs.screens.map((x: any) => x.name));
    const fin = events(log, "factory.run.finished").at(-1);
    expect(readFileSync(join(fin.dir, "docs/product/REQUIREMENTS.md"), "utf8")).toMatch(/N1 \| add a weekly summary/);
  });
});

describe("the build loop: one feature per fresh session", () => {
  const write = (cwd: string, fs: { path: string; content: string }[]) => { for (const f of fs) { mkdirSync(dirname(join(cwd, f.path)), { recursive: true }); writeFileSync(join(cwd, f.path), f.content); } };
  /** A fake real crew: each build call does its one feature at the workbench (writes files in the folder). */
  function featureCrew(onFeature?: (id: string, nth: number, cwd: string, files: { path: string; content: string }[]) => boolean, finder?: (prompt: string) => string) {
    const mock = new MockRuntime({ plantBug: false });
    const builds: AgentRequest[] = [];
    const seen: Record<string, number> = {};
    const rt: AgentRuntime = { name: "claude-code:fake", run: async (req) => {
      const r = await mock.run(req);
      // The link search: an agent with web search, asked for the real page of each dead link.
      if (/This time you only find pages/.test(req.prompt)) { if (!finder) throw new Error("no web search here"); r.text = finder(req.prompt); return r; }
      if (station(req) !== "build") return r;
      builds.push(req);
      const files = parseFileBlocks(r.text);
      const id = req.prompt.match(/Your feature, (F\d+)/)?.[1] ?? "";
      seen[id] = (seen[id] ?? 0) + 1;
      if (!onFeature?.(id, seen[id], req.cwd!, files)) {
        if (id === "F1") write(req.cwd!, files.filter((f) => f.path !== "src/count.js"));
        else if (id === "F2") write(req.cwd!, files.filter((f) => f.path === "src/count.js"));
        else write(req.cwd!, [{ path: "web/style.css", content: `/* ${id} */\n` + (files.find((f) => f.path === "web/style.css")?.content ?? "") }]);
      }
      r.text = `Built ${id}.\nNext call: reuse countWords from src/count.js.`;
      return r;
    } };
    return { rt, builds };
  }

  it("opens the app in a browser after each screen feature and hands a screen that does not draw back to its builder", async () => {
    const log = new EventLog();
    const { rt, builds } = featureCrew();
    const f = new Factory(log, rt, tmp("sf-proj-"));
    let checks = 0;
    f.checkScreens = async () => (++checks === 1
      ? { pass: false, screens: [{ route: "dashboard", ok: false, problem: "Cannot read properties of undefined (reading 'game')" }, { route: "manage", ok: true }] }
      : { pass: true, screens: [{ route: "dashboard", ok: true }] });
    const run = f.start("count words", { autoApprove: true, autoRetries: 0, maxUsd: 10 });
    await f.wait(run);
    const feats = events(log, "factory.feature").filter((e) => e.id === "F3" && e.state !== "building");
    expect(feats.map((e) => e.state)).toEqual(["broken", "built"]);
    expect(feats[0].crashed[0]).toMatch(/#\/dashboard: Cannot read properties of undefined/);
    const f3 = builds.filter((b) => /Your feature, F3/.test(b.prompt));
    expect(f3).toHaveLength(2);
    expect(f3[1].prompt).toMatch(/real browser[\s\S]*reading 'game'/);
    // The model and logic features have no screen of their own to open.
    expect(checks).toBe(3);
  });

  it("hands a schema the app cannot start on, and a made-up link, back to the session that wrote them (run 3185)", async () => {
    const log = new EventLog();
    const { rt, builds } = featureCrew((id, nth, cwd, files) => {
      if (id !== "F2") return false;
      // The first try leaves a field the app kit refuses and a video link from memory; the second puts the schema right.
      write(cwd, files.filter((f) => f.path === "src/count.js" || f.path === "src/schema.js").map((f) => f.path !== "src/schema.js" || nth > 1 ? f : { path: f.path, content: f.content.replace(/name: "(\w+)"/, 'name: "band override", link: "https://www.youtube.com/watch?v=rl-wave-dash", was: "$1"') }));
      return true;
    });
    const f = new Factory(log, rt, tmp("sf-proj-"));
    const asked: string[][] = [];
    f.checkLinks = async (urls) => { asked.push(urls); const dead = urls.filter((u) => /rl-wave-dash/.test(u)).map((url) => ({ url, ok: false as const, status: 404 })); return { pass: !dead.length, checked: urls.length, dead, unknown: 0 }; };
    const old = process.env.SF_LINK_CHECK;
    process.env.SF_LINK_CHECK = "on";
    try {
      const run = f.start("count words", { autoApprove: true, autoRetries: 0, maxUsd: 10 });
      await f.wait(run);
    } finally { process.env.SF_LINK_CHECK = old; }
    const f1 = events(log, "factory.feature").filter((e) => e.id === "F2" && e.state !== "building");
    expect(f1.map((e) => e.state)).toEqual(["broken", "built"]);
    expect(f1[0].invalid.join("\n")).toMatch(/src\/schema\.js: an entity has no valid name/);
    // Nobody could search for the real page, so the Builder is told once, with the rule.
    expect(f1[0].deadLinks[0]).toMatch(/rl-wave-dash \(in src\/schema\.js\)/);
    expect(events(log, "factory.links.search")[0]).toMatchObject({ feature: "F2", asked: 1, real: 0 });
    const again = builds.filter((b) => /Your feature, F2/.test(b.prompt))[1];
    expect(again.prompt).toMatch(/app kit refuses the schema[\s\S]*Never write a link from memory/);
    expect(again.prompt).not.toMatch(/search the web/);
    expect(asked.flat().filter((u) => /rl-wave-dash/.test(u))).toHaveLength(1);
    const retro = events(log, "factory.retro").at(-1);
    expect(retro.bad.join("\n")).toMatch(/F2 .* reported done while the app could not start/);
  });

  it("empties a made-up link the Builder left after its second try (run 4004)", async () => {
    const log = new EventLog();
    const { rt } = featureCrew((id, nth, cwd, files) => {
      if (id !== "F2") return false;
      // Both tries leave the same invented video link in the seed.
      write(cwd, files.filter((f) => f.path === "src/count.js" || f.path === "src/schema.js").map((f) => f.path !== "src/schema.js" ? f : { path: f.path, content: f.content + '\nexport const demo = { video: "https://www.youtube.com/watch?v=sample-fast-aerial" };\n' }));
      return true;
    });
    const dir = tmp("sf-proj-");
    const f = new Factory(log, rt, dir);
    f.checkLinks = async (urls) => { const dead = urls.filter((u) => /sample-fast-aerial/.test(u)).map((url) => ({ url, ok: false as const, status: 404 })); return { pass: !dead.length, checked: urls.length, dead, unknown: 0 }; };
    const old = process.env.SF_LINK_CHECK;
    process.env.SF_LINK_CHECK = "on";
    try {
      const run = f.start("count words", { autoApprove: true, autoRetries: 0, maxUsd: 10 });
      await f.wait(run);
    } finally { process.env.SF_LINK_CHECK = old; }
    const f2 = events(log, "factory.feature").filter((e) => e.id === "F2" && e.state !== "building");
    expect(f2.map((e) => e.state)).toEqual(["broken", "built"]);
    expect(events(log, "factory.links.blanked")[0].links[0]).toMatch(/sample-fast-aerial \(in src\/schema\.js\)/);
    const fin = events(log, "factory.run.finished").at(-1);
    const schema = readFileSync(join(fin.dir, "src/schema.js"), "utf8");
    expect(schema).not.toMatch(/sample-fast-aerial/);
    expect(schema).toMatch(/video: ""/);
  });

  it("a search finds the real page for a made-up link; the core opens it first, and empties what no search found (run 4004)", async () => {
    const log = new EventLog();
    const asked: string[] = [];
    const { rt, builds } = featureCrew((id, _nth, cwd, files) => {
      if (id !== "F2") return false;
      write(cwd, files.filter((f) => f.path === "src/count.js" || f.path === "src/schema.js").map((f) => f.path !== "src/schema.js" ? f : { path: f.path, content: f.content + '\nexport const demo = [\n  { title: "Fast aerial tutorial",\n    video: "https://www.youtube.com/watch?v=made-up-1" },\n  { title: "Wave dash guide", video: "https://www.youtube.com/watch?v=made-up-2" },\n  { title: "Half flip", video: "https://www.youtube.com/watch?v=made-up-3" },\n];\n' }));
      return true;
    }, (prompt) => {
      asked.push(prompt);
      return "```json\n" + JSON.stringify({ links: [
        { dead: "https://www.youtube.com/watch?v=made-up-1", real: "https://www.youtube.com/watch?v=real-aerial" },
        // A second invention, and a link nobody asked about: neither is used.
        { dead: "https://www.youtube.com/watch?v=made-up-2", real: "https://www.youtube.com/watch?v=also-made-up" },
        { dead: "https://elsewhere.test/x", real: "https://www.youtube.com/watch?v=real-aerial" },
        { dead: "https://www.youtube.com/watch?v=made-up-3", real: null },
      ] }) + "\n```";
    });
    const f = new Factory(log, rt, tmp("sf-proj-"));
    f.checkLinks = async (urls) => { const dead = urls.filter((u) => /made-up/.test(u)).map((url) => ({ url, ok: false as const, status: 404 })); return { pass: !dead.length, checked: urls.length, dead, unknown: 0 }; };
    const old = process.env.SF_LINK_CHECK;
    process.env.SF_LINK_CHECK = "on";
    try {
      const run = f.start("count words", { autoApprove: true, autoRetries: 0, maxUsd: 10 });
      await f.wait(run);
    } finally { process.env.SF_LINK_CHECK = old; }
    // The finder read the line each link sits on, and the Builder was not asked a second time for links.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/made-up-1\n   in src\/schema\.js: .*Fast aerial tutorial/);
    expect(builds.filter((b) => /Your feature, F2/.test(b.prompt))).toHaveLength(1);
    expect(events(log, "factory.feature").filter((e) => e.id === "F2" && e.state !== "building").map((e) => e.state)).toEqual(["built"]);
    expect(events(log, "factory.links.search")[0]).toMatchObject({ feature: "F2", asked: 3, answered: 2, real: 1 });
    expect(events(log, "factory.links.found")[0].links).toEqual([{ dead: "https://www.youtube.com/watch?v=made-up-1", real: "https://www.youtube.com/watch?v=real-aerial", file: "src/schema.js" }]);
    expect(events(log, "factory.links.blanked")[0].links).toHaveLength(2);
    const fin = events(log, "factory.run.finished").at(-1);
    const schema = readFileSync(join(fin.dir, "src/schema.js"), "utf8");
    expect(schema).toMatch(/video: "https:\/\/www\.youtube\.com\/watch\?v=real-aerial"/);
    expect(schema).not.toMatch(/made-up/);
    expect(events(log, "factory.retro").at(-1).good.join("\n")).toMatch(/1 made-up link replaced by the real page/);
  });

  it("hands a screen that keeps data in the browser's storage back to its builder (run 4004)", async () => {
    const log = new EventLog();
    const { rt, builds } = featureCrew((id, nth, cwd, files) => {
      if (id !== "F3") return false;
      write(cwd, [{ path: "web/plan.js", content: nth === 1 ? 'export const save = (p) => localStorage.setItem("plan", JSON.stringify(p));\n' : "export const save = (store, p) => store.create(\"plan\", p);\n" }]);
      return true;
    });
    const f = new Factory(log, rt, tmp("sf-proj-"));
    const run = f.start("count words", { autoApprove: true, autoRetries: 0, maxUsd: 10 });
    await f.wait(run);
    const f3 = events(log, "factory.feature").filter((e) => e.id === "F3" && e.state !== "building");
    expect(f3.map((e) => e.state)).toEqual(["broken", "built"]);
    expect(f3[0].stored).toEqual(["web/plan.js"]);
    const again = builds.filter((b) => /Your feature, F3/.test(b.prompt))[1];
    expect(again.prompt).toMatch(/keep data in the browser's localStorage[\s\S]*a record in the app's store/);
    expect(events(log, "factory.retro").at(-1).bad.join("\n")).toMatch(/kept data in the browser's storage/);
  });

  it("puts the plan's entity and field names into the spelling the app kit accepts (run 3185)", async () => {
    const { kitName, validatePlan } = await import("../src/factory/loop.js");
    expect([kitName("band_min"), kitName("Band Override"), kitName("rankScale"), kitName("2nd-best_video"), kitName("")]).toEqual(["bandMin", "bandOverride", "rankScale", "ndBestVideo", "field"]);
    const plan = validatePlan({ name: "Game Mastery", slug: "game-mastery", summary: "s", interface: "i", acceptance: ["a"], tasks: [{ id: "T1", title: "t", dependsOn: [] }],
      entities: [{ name: "plan_block", fields: [{ name: "band_min", type: "number" }, { name: "game_ref", type: "ref", to: "Game" }] }, { name: "Game", fields: [{ name: "title", type: "text" }] }] } as never);
    expect(plan.entities!.map((e) => [e.name, ...e.fields.map((f) => f.name)])).toEqual([["planBlock", "bandMin", "gameRef"], ["game", "title"]]);
    expect(plan.entities![0].fields[1].to).toBe("game");
    const { CONTRACTS } = await import("../src/bay/builtin.js");
    expect(CONTRACTS.plan).toMatch(/lowerCamelCase.*never "band_min"/);
  });

  it("builds the plan as a list of features, each in its own call, with the list and the progress on disk", async () => {
    const log = new EventLog();
    const { rt, builds } = featureCrew();
    const f = new Factory(log, rt, tmp("sf-proj-"));
    const run = f.start("count words", { autoApprove: true, autoRetries: 0, maxUsd: 10 });
    await f.wait(run);
    const fin = events(log, "factory.run.finished").at(-1);
    expect(fin.outcome).toBe("shipped");
    // Foundation, logic, and one per view: the plan's own, plus the designed screen the Planner left out (the core adds it).
    expect(builds.map((b) => b.prompt.match(/Your feature, (F\d+)/)?.[1])).toEqual(["F1", "F2", "F3", "F4"]);
    // Each call gets its one feature and the pointers to the spine, not the whole spec and all the tests pasted in.
    expect(builds[2].prompt).toMatch(/ONE feature \(F3, number 3 of 4\)/);
    expect(builds[2].prompt).toMatch(/Screen: Progress/);
    expect(builds[2].prompt).toMatch(/features\.json.*PROGRESS\.md/s);
    expect(builds[2].prompt).not.toMatch(/Locked acceptance tests:/);
    // Each call is capped at its share of the build budget, never above the Builder's own cap.
    expect(builds.every((b) => (b.budgetUsd ?? 9) <= 0.6 && (b.budgetUsd ?? 0) >= 0.15)).toBe(true);
    // The spine: the list (all built, with the tests passing after each) and what each session left for the next.
    const list = JSON.parse(readFileSync(join(fin.dir, "features.json"), "utf8")).features;
    expect(list.map((x: any) => x.state)).toEqual(["built", "built", "built", "built"]);
    expect(readFileSync(join(fin.dir, "PROGRESS.md"), "utf8")).toMatch(/## F2 The domain logic: built[\s\S]*reuse countWords/);
    // A commit per feature.
    expect(git(fin.dir, "log", "--format=%s")).toMatch(/Feature F3: Screen: Progress[\s\S]*Feature F2: The domain logic[\s\S]*Feature F1/);
    // The logic feature is where the locked tests go green; the core saw it.
    const built = events(log, "factory.feature").filter((e) => e.state === "built");
    expect(built.map((e) => e.id)).toEqual(["F1", "F2", "F3", "F4"]);
    expect(built[0].failed).toBeGreaterThan(0);
    expect(built[1].failed).toBe(0);
  });

  it("a feature that breaks a test that passed before is sent back once with that evidence", async () => {
    const log = new EventLog();
    const { rt, builds } = featureCrew((id, nth, cwd) => {
      // The screen feature's first attempt breaks the logic the tests check.
      if (id !== "F3" || nth !== 1) return false;
      write(cwd, [{ path: "src/count.js", content: "export function countWords() { return -1; }\nexport function progress() { return -1; }\n" }]);
      return true;
    });
    const f = new Factory(log, rt, tmp("sf-proj-"));
    const run = f.start("count words", { autoApprove: true, autoRetries: 0, maxUsd: 10 });
    await f.wait(run);
    const feats = events(log, "factory.feature").filter((e) => e.id === "F3" && e.state !== "building");
    expect(feats.map((e) => e.state)).toEqual(["regressed", "regressed"]);
    expect(feats[0].broke.length).toBeGreaterThan(0);
    const f3 = builds.filter((b) => /Your feature, F3/.test(b.prompt));
    expect(f3).toHaveLength(2);
    expect(f3[1].prompt).toMatch(/passed before your call and fail after it/);
    // Still broken after the second try: it goes on, and the test and fix loop takes it from there.
    expect(events(log, "factory.station").some((s) => s.station === "fix")).toBe(true);
  });

  it("a small run still builds in one call", async () => {
    const log = new EventLog();
    const { rt, builds } = featureCrew((_id, _n, cwd, files) => { write(cwd, files); return true; });
    const f = new Factory(log, rt, tmp("sf-proj-"));
    const run = f.start("count words", { autoApprove: true, autoRetries: 0, maxUsd: 0.6 });
    await f.wait(run);
    expect(builds).toHaveLength(1);
    expect(events(log, "factory.feature")).toHaveLength(0);
  });
});
