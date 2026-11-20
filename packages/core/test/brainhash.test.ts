import { describe, it, expect } from "vitest";
import { DEFAULT_PRINCIPLES, EventLog, Factory, MockRuntime, savePrinciple } from "../src/index.js";
import { brainHash, principles } from "../src/brain/brain.js";

describe("the Brain's fingerprint on every run (SF-19)", () => {
  it("is the same for the same rules, whatever their order, and changes with an edit or a switched-off rule", () => {
    const h = brainHash(DEFAULT_PRINCIPLES);
    expect(h).toMatch(/^[0-9a-f]{12}$/);
    expect(brainHash([...DEFAULT_PRINCIPLES].reverse())).toBe(h);
    const edited = DEFAULT_PRINCIPLES.map((p, i) => (i === 0 ? { ...p, text: `${p.text} Also this.` } : p));
    expect(brainHash(edited)).not.toBe(h);
    const off = DEFAULT_PRINCIPLES.map((p, i) => (i === 0 ? { ...p, enabled: false } : p));
    expect(brainHash(off)).not.toBe(h);
  });

  it("is written on the run's started event, and two runs under the same Brain show the same one", () => {
    const log = new EventLog(":memory:");
    const f = new Factory(log, new MockRuntime());
    const started = () => log.list({ type: "factory.run.started", limit: 100 }).map((e) => (e.payload as { brain?: string }).brain);
    // The started event is written before start() returns; the runs themselves go on at their plan gate.
    f.start("a tiny note app", { maxUsd: 0.5 });
    f.start("a tiny todo list", { maxUsd: 0.5 });
    const [ha, hb] = started();
    expect(ha).toBe(brainHash(principles(log)));
    expect(hb).toBe(ha);
    const first = DEFAULT_PRINCIPLES[0];
    savePrinciple(log, first.id, { title: first.title, text: `${first.text} Say it twice.`, stations: first.stations });
    f.start("a tiny timer", { maxUsd: 0.5 });
    expect(started()[2]).not.toBe(ha);
  });
});
