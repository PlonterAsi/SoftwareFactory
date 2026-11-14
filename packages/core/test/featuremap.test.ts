import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EventLog, Factory, MockRuntime, AgentBay, OrderEngine, captureSignal, principles, savePrinciple,
  featureMap, featureRecords, saveFeature, resetFeature, recordProblems, DEFAULT_FEATURES,
  brainUse, brainSuggestions, acceptSuggestion, dismissSuggestion,
} from "../src/index.js";
import { WIRING } from "../src/featuremap/wiring.generated.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe("the feature check: no feature ships without its record", () => {
  it("the wiring map is the one the code gives now (run `npm run wiring -w @sf/core` after changing code)", () => {
    const fresh = execFileSync(process.execPath, [join(root, "packages/core/scripts/wiring.mjs"), "--print"], { encoding: "utf8", maxBuffer: 64e6 });
    const onDisk = readFileSync(join(root, "packages/core/src/featuremap/wiring.generated.ts"), "utf8").replace(/\r\n/g, "\n");
    // The generated file describes itself too, so compare everything but its own line count.
    const strip = (s: string) => s.replace(/("packages\/core\/src\/featuremap\/wiring\.generated\.ts": \{\s*"lines": )\d+/, "$1 0");
    expect(strip(onDisk)).toBe(strip(fresh));
  });

  it("every source file and every API area belongs to a feature, and every record is complete", () => {
    expect(recordProblems(DEFAULT_FEATURES, WIRING, (p) => existsSync(join(root, p)))).toEqual([]);
  });

  it("says in plain words what is missing when a feature has no record", () => {
    const wiring = { ...WIRING, files: { ...WIRING.files, "packages/core/src/teleport/beam.ts": { lines: 10, serves: ["/api/teleport"] } } };
    const problems = recordProblems(DEFAULT_FEATURES, wiring);
    expect(problems.some((p) => /teleport\/beam\.ts belongs to no feature/.test(p))).toBe(true);
    expect(problems.some((p) => /\/api\/teleport belongs to no feature/.test(p))).toBe(true);
    const thin = [{ ...DEFAULT_FEATURES[0], purpose: "Does things.", spec: [], flow: ["one"], design: "", docs: [] }, ...DEFAULT_FEATURES.slice(1)];
    expect(recordProblems(thin).filter((p) => p.includes(DEFAULT_FEATURES[0].name))).toHaveLength(5);
  });
});

describe("the feature map", () => {
  it("folds the code into who uses whom", () => {
    const map = featureMap(null);
    expect(map.loose.unownedFiles).toEqual([]);
    expect(map.loose.unownedApi).toEqual([]);
    const brain = map.features.find((f) => f.id === "brain")!;
    expect(brain.writes).toEqual(expect.arrayContaining(["brain.principle.saved", "brain.principle.reset"]));
    expect(brain.tables).toContain("brain_principles");
    // The Bay binds the principles into every agent's instructions: that is the Brain's wire into the loops.
    expect(brain.usedBy.map((l) => l.feature)).toEqual(expect.arrayContaining(["agent-bay", "engine-loop"]));
    expect(brain.uses.map((l) => l.feature)).toContain("order-engine");
    const engine = map.features.find((f) => f.id === "engine-loop")!;
    expect(engine.uses.map((l) => l.feature)).toEqual(expect.arrayContaining(["council", "design-loop", "judge", "checks"]));
    expect(map.totals.features).toBe(DEFAULT_FEATURES.length);
  });

  it("shows proof of life from the log, and flags what never ran", async () => {
    const log = new EventLog();
    const before = featureMap(log);
    expect(before.features.find((f) => f.id === "engine-loop")!.state).toBe("never");
    expect(before.features.find((f) => f.id === "shell")!.state).toBe("untraced");
    const rt = new MockRuntime({ plantBug: false });
    const f = new Factory(log, rt, tmp("sf-proj-"), new AgentBay(log, rt));
    await f.wait(f.start("a word counter", { autoApprove: true }));
    const after = featureMap(log);
    const engine = after.features.find((x) => x.id === "engine-loop")!;
    expect(engine.state).toBe("alive");
    expect(engine.alive.events).toBeGreaterThan(5);
    expect(engine.alive.lastAt).toBeTruthy();
    expect(after.features.find((x) => x.id === "brain")!.alive.calls).toBeGreaterThan(0);
    expect(after.features.find((x) => x.id === "plugins")!.state).toBe("never");
  });

  it("a record is edited, a planned feature is added and removed, all as events", () => {
    const log = new EventLog();
    saveFeature(log, "brain", { name: "Brain", purpose: "Principles every agent reads, said once.", spec: "One\nTwo", flow: ["a", "b"], design: "The Brain page" });
    const brain = featureRecords(log).find((f) => f.id === "brain")!;
    expect(brain).toMatchObject({ edited: true, version: 1, spec: ["One", "Two"] });
    expect(brain.files).toEqual(DEFAULT_FEATURES.find((f) => f.id === "brain")!.files);
    const id = saveFeature(log, null, { name: "Sector game view", group: "App", purpose: "The factory as a real-time strategy base." });
    expect(featureMap(log).features.find((f) => f.id === id)).toMatchObject({ state: "planned", builtin: false });
    expect(log.db.prepare("SELECT COUNT(*) AS n FROM feature_records").get()).toMatchObject({ n: 2 });
    expect(() => saveFeature(log, null, { name: "", purpose: "x" })).toThrow(/needs a name/);
    resetFeature(log, id);
    resetFeature(log, "brain");
    expect(featureRecords(log).map((f) => [f.id, f.edited])).toEqual(DEFAULT_FEATURES.map((f) => [f.id, false]));
    expect(log.db.prepare("SELECT COUNT(*) AS n FROM feature_records").get()).toMatchObject({ n: 0 });
  });
});

describe("the Brain shows its use and learns from the person's rules", () => {
  it("counts the agent calls that read each principle", async () => {
    const log = new EventLog();
    expect(brainUse(log)).toMatchObject({ reads: 0, changes: 0 });
    const rt = new MockRuntime({ plantBug: false });
    const f = new Factory(log, rt, tmp("sf-proj-"), new AgentBay(log, rt));
    await f.wait(f.start("a word counter", { autoApprove: true }));
    const use = brainUse(log);
    expect(use.reads).toBeGreaterThan(0);
    expect(use.lastReadAt).toBeTruthy();
    expect(use.byPrinciple["real-programs"].reads).toBeGreaterThan(0);
    // A principle saved now has no reads yet: reads count from its current version.
    savePrinciple(log, null, { title: "Hebrew first", text: "Every screen reads right to left.", stations: ["build"] });
    const later = brainUse(log);
    expect(later.byPrinciple["hebrew-first"].reads).toBe(0);
    expect(later.changes).toBe(1);
    expect(later.history[0]).toMatchObject({ what: "saved", title: "Hebrew first" });
  });

  it("a rule the person wrote is offered once, and becomes a principle agents read", async () => {
    const log = new EventLog();
    const order = new OrderEngine(log, null, { mode: "heuristic" });
    const say = async (text: string) => { const s = captureSignal(log, text, "bridge"); await order.ingest({ id: s.id, text: s.text, source: "bridge" }); };
    await say("Project: Recipes\nRule: every screen must work with the keyboard alone, never the mouse only.");
    await say("Rule: always show prices in shekels.");
    const offered = brainSuggestions(log, order.state());
    expect(offered.length).toBeGreaterThanOrEqual(2);
    const keys = offered.find((s) => /keyboard/.test(s.text))!;
    const id = acceptSuggestion(log, order.state(), keys.fragment);
    const p = principles(log).find((x) => x.id === id)!;
    expect(p.source).toMatchObject({ kind: "rule", fragment: keys.fragment });
    expect(p.text).toMatch(/keyboard alone/);
    const bay = new AgentBay(log, new MockRuntime());
    expect(bay.crewFor("build")[0].role).toMatch(/keyboard alone/);
    const other = offered.find((s) => s.fragment !== keys.fragment)!;
    dismissSuggestion(log, order.state(), other.fragment);
    const left = brainSuggestions(log, order.state()).map((s) => s.fragment);
    expect(left).not.toContain(keys.fragment);
    expect(left).not.toContain(other.fragment);
    expect(() => acceptSuggestion(log, order.state(), keys.fragment)).toThrow(/not waiting/);
    expect(brainUse(log).history.map((h) => h.what)).toEqual(["dismissed", "saved"]);
  });
});
