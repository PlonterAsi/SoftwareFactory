import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { EventLog, Factory, MockRuntime, AgentBay, writeFiles, installKit, checkApp, checkAppLive, KIT_PATHS, principles, savePrinciple, resetPrinciple, DEFAULT_PRINCIPLES } from "../src/index.js";
import { KIT_FILES } from "../src/factory/kitFiles.js";
import { systemPromptFor, CONTRACTS } from "../src/bay/builtin.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const events = (log: EventLog, type: string) => log.list({ limit: 1e6 }).filter((e) => e.type === type).map((e) => e.payload as any);

describe("the app kit", () => {
  it("ships in the core exactly as it is in packages/core/kit (run `npm run kit` after editing it)", () => {
    const root = new URL("../kit/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const onDisk: Record<string, string> = {};
    (function walk(d: string) { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else onDisk[relative(root, p).split(sep).join("/")] = readFileSync(p, "utf8"); } })(root);
    expect(KIT_FILES).toEqual(onDisk);
    expect(KIT_PATHS.sort()).toEqual(["server.js", "web/kit/db.js", "web/kit/kit.css", "web/kit/shell.js", "web/kit/store.js"]);
  });
});

describe("the app check", () => {
  async function shippedApp() {
    const log = new EventLog();
    const f = new Factory(log, new MockRuntime({ plantBug: false }), tmp("sf-proj-"));
    const run = f.start("a writing desk that counts words", { autoApprove: true });
    await f.wait(run);
    return { log, dir: events(log, "factory.run.finished").at(-1).dir as string };
  }

  it("passes the practice crew's app: it starts with one press, serves its page and sample data, full CRUD on every entity", async () => {
    const { dir } = await shippedApp();
    const a = await checkAppLive(dir);
    expect(a.problems).toEqual([]);
    expect(a.entities).toEqual([{ name: "piece", seeds: 3, crud: true }]);
    // Checking never writes the app's own data.
    expect(() => statSync(join(dir, "data"))).toThrow();
  });

  it("names what makes a build a script and not a program", async () => {
    const { dir } = await shippedApp();
    writeFileSync(join(dir, "server.js"), readFileSync(join(dir, "server.js"), "utf8") + "\nconsole.log(process.argv[2]);\n");
    writeFileSync(join(dir, "web", "app.js"), 'const box = document.getElementById("cfg");\nconst cfg = JSON.parse(box.value);\n');
    writeFileSync(join(dir, "src", "schema.js"), 'export const app = { name: "X" };\nexport const entities = [{ name: "task", fields: [{ name: "title", type: "text", required: true }], seed: [] }];\n');
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    delete pkg.scripts.start;
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
    const p = checkApp(dir).problems.join("\n");
    expect(p).toMatch(/server\.js reads command-line arguments/);
    expect(p).toMatch(/"start" must be "node server\.js"/);
    expect(p).toMatch(/parses JSON the person typed/);
    expect(p).toMatch(/does not start the app with startApp/);
    expect(p).toMatch(/task has no sample records/);
    // The kit puts itself and the start script back.
    installKit(dir);
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts.start).toBe("node server.js");
    expect(readFileSync(join(dir, "server.js"), "utf8")).toBe(KIT_FILES["server.js"]);
  });

  it("catches a broken model: unknown field types, refs to nothing, samples that break their own rules", () => {
    const dir = tmp("sf-app-");
    installKit(dir);
    writeFiles(dir, [{ path: "src/schema.js", content: `export const app = { name: "Shop" };
export const entities = [
  { name: "order", fields: [{ name: "total", type: "money" }, { name: "customer", type: "ref", to: "client" }], seed: [{ total: 1 }] },
];` }], { lockTests: false });
    const p = checkApp(dir).problems.join("\n");
    expect(p).toMatch(/order\.total has unknown type "money"/);
    expect(p).toMatch(/order\.customer refers to "client", which is not an entity/);
    writeFiles(dir, [{ path: "src/schema.js", content: `export const app = { name: "Shop" };
export const entities = [{ name: "order", fields: [{ name: "total", type: "number", min: 0, required: true }], seed: [{ total: -5 }] }];` }], { lockTests: false });
    expect(checkApp(dir).problems.join("\n")).toMatch(/a sample order breaks its own rules: total must be at least 0/);
  });
});

describe("the Brain", () => {
  it("puts the principles in front of every maker station's contract, and nowhere they do not apply", () => {
    const planner = systemPromptFor({ prompt: "You are the Planner." }, "plan");
    expect(planner.indexOf("Build real programs, not scripts")).toBeGreaterThan(0);
    expect(planner.indexOf("full CRUD and full visibility")).toBeLessThan(planner.indexOf("Station contract: plan"));
    for (const s of ["council", "plan", "tests", "build", "review", "fix", "improve", "overseer", "survey"] as const) expect(systemPromptFor({ prompt: "x" }, s)).toContain("Never make the person write raw data");
    expect(systemPromptFor({ prompt: "x" }, "order")).not.toContain("SoftwareFactory principles");
    expect(CONTRACTS.build).toContain("src/schema.js");
    expect(CONTRACTS.review).toMatch(/script or CLI with no real app/);
  });

  it("an edit reaches the next agent call through the Bay; reset brings the default back", async () => {
    const log = new EventLog();
    const rt = new MockRuntime({ plantBug: false });
    const bay = new AgentBay(log, rt);
    expect(principles(log).map((p) => p.id)).toEqual(DEFAULT_PRINCIPLES.map((p) => p.id));
    savePrinciple(log, "first-use", { title: "Useful on first open", text: "Open on a dashboard with a guided tour.", stations: ["build"] });
    const mine = savePrinciple(log, null, { title: "Hebrew first", text: "Every screen reads right to left.", stations: ["build", "review"] });
    expect(mine).toBe("hebrew-first");
    expect(() => savePrinciple(log, null, { title: "x", text: "y", stations: [] })).toThrow(/at least one station/);
    expect(bay.crewFor("build")[0].role).toContain("Every screen reads right to left.");
    expect(bay.crewFor("build")[0].role).toContain("guided tour");
    expect(bay.crewFor("plan")[0].role).not.toContain("guided tour");
    const f = new Factory(log, rt, tmp("sf-proj-"), bay);
    await f.wait(f.start("a word counter", { autoApprove: true }));
    expect(rt.calls.find((c) => /Station contract: build/.test(c.systemPrompt ?? ""))!.systemPrompt).toContain("Every screen reads right to left.");
    resetPrinciple(log, "first-use");
    resetPrinciple(log, "hebrew-first");
    expect(principles(log).map((p) => [p.id, p.edited])).toEqual(DEFAULT_PRINCIPLES.map((p) => [p.id, false]));
    // The Data vault shows only changes; a reset leaves no row.
    expect(log.db.prepare("SELECT COUNT(*) AS n FROM brain_principles").get()).toMatchObject({ n: 0 });
  });
});
