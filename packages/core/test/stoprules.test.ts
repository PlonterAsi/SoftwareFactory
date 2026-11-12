import { describe, expect, it } from "vitest";
import { SAME_TESTS_REASON, stopReason, type RoundRecord } from "../src/factory/stoprules.js";

const base = { startedAt: 0, now: 60_000 };
const r = (failing: number, names?: string, files?: Record<string, string>): RoundRecord => ({ failing, names, files });

describe("stop rules", () => {
  it("does not stop while the failing count falls", () => {
    expect(stopReason({ ...base, rounds: [r(5, "a\nb\nc\nd\ne"), r(3, "a\nb\nc"), r(1, "a")] })).toBeNull();
  });

  it("does not stop on an empty history", () => {
    expect(stopReason({ ...base, rounds: [] })).toBeNull();
  });

  it("stops when the same tests fail twice in a row", () => {
    expect(stopReason({ ...base, rounds: [r(2, "a\nb"), r(2, "a\nb")] })).toBe(SAME_TESTS_REASON);
  });

  it("stops when the failing count did not fall for 2 rounds in a row", () => {
    const reason = stopReason({ ...base, rounds: [r(3, "a\nb\nc"), r(3, "a\nb\nd"), r(4, "a\nb\ne\nf")] });
    expect(reason).toMatch(/did not fall for 2 rounds/);
  });

  it("stops when a file goes back to earlier content", () => {
    const reason = stopReason({ ...base, rounds: [r(3, "a", { "src/x.ts": "h1" }), r(2, "b", { "src/x.ts": "h2" }), r(1, "c", { "src/x.ts": "h1" })] });
    expect(reason).toMatch(/src\/x\.ts went back/);
  });

  it("stops past the wall-clock limit, default 30 minutes", () => {
    const rounds = [r(2, "a")];
    expect(stopReason({ rounds, startedAt: 0, now: 29 * 60_000 })).toBeNull();
    expect(stopReason({ rounds, startedAt: 0, now: 31 * 60_000 })).toMatch(/30 minutes/);
  });

  it("uses the limit from the setting", () => {
    expect(stopReason({ rounds: [], startedAt: 0, now: 6 * 60_000, maxMinutes: 5 })).toMatch(/5 minutes/);
  });
});
