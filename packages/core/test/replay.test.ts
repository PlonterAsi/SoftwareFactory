import { describe, expect, it } from "vitest";
import { recordBehavior, replayBehavior } from "../src/factory/replay.js";

const inputs = [{ name: "two", input: [2] }, { name: "neg", input: [-1] }];
const orig = (n: number) => { if (n < 0) throw new Error("negative"); return n * 2; };

describe("record-then-replay gate", () => {
  it("passes when a rewrite behaves the same, including errors", async () => {
    const rec = await recordBehavior("double", orig, inputs);
    const r = await replayBehavior(rec, (n: number) => { if (n < 0) throw new Error("negative"); return n + n; });
    expect(r).toMatchObject({ ok: true, total: 2, diffs: [] });
  });

  it("fails and says which case changed", async () => {
    const rec = await recordBehavior("double", orig, inputs);
    const r = await replayBehavior(rec, (n: number) => n * 2);
    expect(r.ok).toBe(false);
    expect(r.diffs).toEqual([{ name: "neg", expected: "throws negative", actual: "returns -2" }]);
    expect(r.summary).toContain("1 of 2");
  });

  it("replays from a stored (JSON) recording", async () => {
    const rec = JSON.parse(JSON.stringify(await recordBehavior("double", orig, inputs)));
    expect((await replayBehavior(rec, orig)).ok).toBe(true);
  });
});
