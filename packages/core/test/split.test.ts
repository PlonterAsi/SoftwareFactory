import { describe, it, expect } from "vitest";
import { EventLog, Tickets, AUTO_WORK_DEFAULT, type AgentRuntime, type Factory } from "../src/index.js";
import { parseSplit, splitRefusal, splitRollUp } from "../src/tickets/split.js";

/** SF-66: auto-work has the Overseer split a ready size-L bug or task into subtasks the crew then takes. */

const SPLIT = "```json\n" + JSON.stringify({ subtasks: [
  { title: "Add the storage table", body: "Create it. A test reads a row back.", size: "S" },
  { title: "Move reads to it", body: "Reads use the table. Tests pass.", size: "M" },
  { title: "Drop the old file", body: "Nothing reads it any more.", size: "L" },
] }) + "\n```";

function setup(text = SPLIT, rule = {}) {
  const log = new EventLog();
  const active = new Set<number>();
  let next = 1000;
  const factory = { start() { const r = next++; active.add(r); return r; }, isActive: (r: number) => active.has(r), duplicateOf: () => null };
  const calls: any[] = [];
  const runtime: AgentRuntime = { name: "stub", run: async (req: any) => { calls.push(req); return { text, costUsd: 0.02, durationMs: 1, models: ["stub"], runtime: "stub", contextTokens: 0 } as any; } };
  const t = new Tickets(log, { runtime, factory: factory as unknown as Factory, autoWork: () => ({ ...AUTO_WORK_DEFAULT, ...rule }) });
  const big = t.open({ project: 7, kind: "task", title: "Rewrite storage", body: "Move all storage from the JSON file to SQLite and drop the file.", answers: { expected: "No JSON file" } });
  t.edit(big.id, "size", "L");
  t.say(big.id, "", { status: "ready" });
  return { log, t, calls, big: big.id };
}
const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5)); return f(); };

describe("parseSplit", () => {
  it("reads 2 to 5 subtasks in order, and an L part goes in as M", () => {
    expect(parseSplit(SPLIT)).toEqual([
      { title: "Add the storage table", body: "Create it. A test reads a row back.", size: "S" },
      { title: "Move reads to it", body: "Reads use the table. Tests pass.", size: "M" },
      { title: "Drop the old file", body: "Nothing reads it any more.", size: "M" },
    ]);
  });
  it("refuses fewer than two, no json, or no list", () => {
    expect(parseSplit('{"subtasks": [{"title": "only one"}]}')).toBeNull();
    expect(parseSplit("I would split it in three.")).toBeNull();
    expect(parseSplit('{"parts": []}')).toBeNull();
  });
});

describe("splitRefusal", () => {
  const base = { kind: "task" as const, status: "ready" as const, size: "L" as const, project: 7, blocked: false, assignee: null, children: { total: 0, done: 0 }, parentId: null };
  it("splits a ready top-level or epic ticket sized L, once, and nothing else", () => {
    expect(splitRefusal(base, {})).toBeNull();
    expect(splitRefusal({ ...base, parentId: 3 }, { parentKind: "plan" })).toBeNull();
    expect(splitRefusal({ ...base, parentId: 3 }, { parentKind: "task" })).toMatch(/subtask/);
    expect(splitRefusal({ ...base, size: "M" }, {})).not.toBeNull();
    expect(splitRefusal({ ...base, kind: "request" }, {})).not.toBeNull();
    expect(splitRefusal({ ...base, children: { total: 2, done: 0 } }, {})).toMatch(/already/);
    expect(splitRefusal({ ...base, project: null }, {})).toMatch(/no project/);
    expect(splitRefusal(base, { handBrake: true })).toMatch(/hold/);
    expect(splitRefusal(base, { triedBefore: true })).toMatch(/before/);
  });
});

describe("splitRollUp", () => {
  it("closes when every subtask is closed, is built when the rest wait for a look, and waits otherwise", () => {
    expect(splitRollUp({ kind: "task", status: "in_progress" }, ["closed", "rejected"])).toMatchObject({ status: "closed" });
    expect(splitRollUp({ kind: "bug", status: "ready" }, ["closed", "built"])).toMatchObject({ status: "built" });
    expect(splitRollUp({ kind: "task", status: "built" }, ["closed", "built"])).toBeNull();
    expect(splitRollUp({ kind: "task", status: "ready" }, ["closed", "ready"])).toBeNull();
    expect(splitRollUp({ kind: "request", status: "ready" }, ["closed"])).toBeNull();
  });
});

describe("auto-work splits size L (SF-66)", () => {
  it("the Overseer splits it once into ready, sized subtasks under it, in order; the queue then works them, not it", async () => {
    const { t, calls, big } = setup();
    t.dispatch();
    expect(await until(() => t.get(big)!.children.total === 3)).toBe(true);
    expect(calls[0].systemPrompt).toMatch(/Station contract: split/);
    expect(calls[0].budgetUsd).toBe(0.15);
    const kids = t.lines(big);
    expect(kids.map((k) => [k.title, k.size, k.status, k.kind])).toEqual([
      ["Add the storage table", "S", "ready", "task"], ["Move reads to it", "M", "ready", "task"], ["Drop the old file", "M", "ready", "task"],
    ]);
    expect(t.notes(big).some((n) => /^Split by the Overseer into/.test(n.text))).toBe(true);
    const why = Object.fromEntries(t.queue(7).map((q) => [q.ticket.id, q.why]));
    expect(why[big]).toMatch(/Worked through its 3 subtasks/);
    // One part at a time, in order: the second waits for the first.
    expect(why[kids[1].id]).toMatch(new RegExp(`Waits for ${kids[0].key}`));
    // Tried once: another pass does not call again.
    t.splitBig();
    expect(calls.filter((c) => /contract: split/.test(c.systemPrompt))).toHaveLength(1);
  });

  it("rolls the ticket up when its subtasks are closed", async () => {
    const { t, big } = setup();
    t.dispatch();
    await until(() => t.get(big)!.children.total === 3);
    for (const k of t.lines(big)) t.say(k.id, "merged", { status: "closed" });
    expect(t.get(big)!.status).toBe("closed");
  });

  it("an answer with no usable list adds nothing and says so; no split when auto-work is off or the day is spent", async () => {
    const bad = setup("I would split it in three.");
    bad.t.splitBig();
    expect(await until(() => bad.t.notes(bad.big).some((n) => /could not split/.test(n.text)))).toBe(true);
    expect(bad.t.get(bad.big)!.children.total).toBe(0);
    expect(setup(SPLIT, { on: false }).t.splitBig()).toEqual([]);
    expect(setup(SPLIT, { dailyUsd: 0.1 }).t.splitBig()).toEqual([]);
  });
});
