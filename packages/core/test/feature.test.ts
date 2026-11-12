import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, Factory, MockRuntime, git, type AgentRequest } from "../src/index.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const events = (log: EventLog, type: string) => log.list({ limit: 1e6 }).filter((e) => e.type === type).map((e) => e.payload as any);

describe("adding a feature to a shipped app", () => {
  it("builds the next version in the same folder: shipped plan in the Planner's prompt, old tests kept, new tests added, data kept", async () => {
    const log = new EventLog();
    const rt = new MockRuntime({ plantBug: false });
    const prompts: AgentRequest[] = [];
    const run0 = rt.run.bind(rt);
    rt.run = async (req) => { prompts.push(req); return run0(req); };
    const f = new Factory(log, rt, tmp("sf-feat-"));
    const first = f.start("a writing desk that counts words", { autoApprove: true });
    await f.wait(first);
    const shipped = events(log, "factory.run.finished").at(-1);
    expect(shipped.outcome).toBe("shipped");
    const dir = shipped.dir as string;
    const oldTests = readdirSync(join(dir, "test")).sort();
    // The person's own data in the app's folder.
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", "db.json"), '{"mine":true}');

    prompts.length = 0;
    const next = f.addFeature(first, "add a reading-time estimate", { autoApprove: true });
    await f.wait(next);
    const fin = events(log, "factory.run.finished").at(-1);
    expect(fin).toMatchObject({ run: next, outcome: "shipped", dir });
    const plan = events(log, "factory.plan").filter((p) => p.run === next).at(-1);
    expect(plan.dir).toBe(dir);
    const planner = prompts.find((p) => p.systemPrompt?.includes("Station contract: plan"))!;
    expect(planner.prompt).toContain("This app already shipped");
    expect(planner.prompt).toContain("add a reading-time estimate");
    // Old locked tests are all still there, unchanged in name; anything new sits beside them.
    const nowTests = readdirSync(join(dir, "test")).sort();
    for (const t of oldTests) expect(nowTests).toContain(t);
    expect(git(dir, "tag", "--list", "v*").split("\n").sort()).toEqual(["v0.1.0", "v0.2.0"]);
    expect(readFileSync(join(dir, "data", "db.json"), "utf8")).toBe('{"mine":true}');
    expect(existsSync(join(dir, ".git"))).toBe(true);
  }, 60000);

  it("refuses a run that never shipped and an empty ask", async () => {
    const log = new EventLog();
    const f = new Factory(log, new MockRuntime({ plantBug: false }), tmp("sf-feat-"));
    expect(() => f.addFeature(999, "more")).toThrow(/has not shipped/);
    const first = f.start("a writing desk that counts words", { autoApprove: true });
    await f.wait(first);
    expect(() => f.addFeature(first, "  ")).toThrow(/Say what to add/);
  }, 60000);
});
