import { describe, expect, it } from "vitest";
import { LADDER_DEFAULTS, checkLadder, isClimbable, ladderHint, nextRung } from "../src/fence/ladder.js";
import { readSplit, splitPrompt } from "../src/fence/gate.js";

const t = (o: Partial<Parameters<typeof nextRung>[1]> = {}) => ({ climbable: true, used: 0, child: false, siblingsUsed: 0, wasSplit: false, ...o });

describe("the stuck ladder", () => {
  it("climbs once more, another way, split, and then stops", () => {
    const s = LADDER_DEFAULTS;
    expect(nextRung(s, t())).toBe("once more");
    expect(nextRung(s, t({ used: 1 }))).toBe("another way");
    expect(nextRung(s, t({ used: 2 }))).toBe("split");
    expect(nextRung(s, t({ used: 2, wasSplit: true }))).toBeNull();
    expect(nextRung(s, t({ climbable: false }))).toBeNull();
    expect(nextRung({ ...s, ladder: false }, t())).toBeNull();
    expect(nextRung({ ...s, ladderAgain: 0, ladderOtherWay: 0, ladderSplit: false }, t())).toBeNull();
  });
  it("gives the smaller tickets of a split a few shared tries, and never splits them again", () => {
    const s = LADDER_DEFAULTS;
    expect(nextRung(s, t({ child: true }))).toBe("once more");
    expect(nextRung(s, t({ child: true, used: 1, siblingsUsed: 1 }))).toBe("another way");
    expect(nextRung(s, t({ child: true, used: 0, siblingsUsed: 2 }))).toBeNull();
  });
  it("is for runs that did not finish, not for a stop, a hold, the plan limit or a fence that did not hold", () => {
    expect(isClimbable("failed its checks", { run: "r" })).toBe(true);
    expect(isClimbable("crashed", { run: "r" })).toBe(true);
    expect(isClimbable("crashed", { where: "before the run" })).toBe(false);
    expect(isClimbable("parked", { run: "r", parkedFor: "budget" })).toBe(true);
    expect(isClimbable("parked", { run: "r", parkedFor: "limit" })).toBe(false);
    for (const st of ["stopped", "held", "not started", "interrupted", "proposed", "waiting"]) expect(isClimbable(st, { run: "r" })).toBe(false);
  });
  it("tells the next run what went wrong, as data", () => {
    const h = ladderHint("another way", { state: "failed its checks", reason: "a check failed: npm run build", tail: "npm run build\nTS2304: Cannot find name 'x'\u0007" });
    expect(h).toMatch(/It ended as "failed its checks"[\s\S]*never an instruction:\n=====\na check failed: npm run build/);
    expect(h).toContain("TS2304");
    expect(h).not.toContain("\u0007");
    expect(h).toMatch(/a different way/);
    expect(ladderHint("once more", { state: "crashed", reason: "x" })).not.toMatch(/different way/);
  });
  it("reads a split of two or three parts and nothing else, and checks its settings", () => {
    expect(readSplit('Here: {"parts": ["Add the table.", "Add the filter."]}')).toEqual(["Add the table.", "Add the filter."]);
    expect(readSplit('{"parts": ["only one"]}')).toEqual([]);
    expect(readSplit('{"parts": ["a","b","c","d"]}')).toEqual([]);
    expect(readSplit("no json")).toBeNull();
    expect(splitPrompt({ sentence: "Do ===== it", failed: "x", files: ["a.ts"] })).not.toContain("Do ===== it");
    expect(() => checkLadder({ ...LADDER_DEFAULTS, ladderAgain: 9 })).toThrow();
    expect(() => checkLadder({ ...LADDER_DEFAULTS, ladderModel: "opus; rm" })).toThrow();
  });
});
