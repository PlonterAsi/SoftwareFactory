import { describe, expect, it } from "vitest";
import { LIMIT_DEFAULTS, checkLimits, periodEnd, periodStart, roomLeft, runBudget, spendOf } from "../src/fence/limits.js";
import type { RecordLine } from "../src/fence/record.js";

let id = 0;
const line = (o: Partial<RecordLine>): RecordLine => ({ id: ++id, ts: "2026-11-27T10:00:00.000Z", kind: "run.step", who: "worker", run: null, ticket: "T1", project: "o/p", costUsd: null, flagged: false, data: {}, ...o });

describe("the two limits", () => {
  it("knows where a day, a week and a month begin and end", () => {
    const now = new Date(2026, 10, 27, 15, 30);
    expect(periodStart("day", now)).toEqual(new Date(2026, 10, 27));
    expect(periodStart("week", now)).toEqual(new Date(2026, 10, 22));
    expect(periodStart("month", now)).toEqual(new Date(2026, 10, 1));
    expect(periodEnd("month", now)).toEqual(new Date(2026, 11, 1));
    expect(periodEnd("week", now)).toEqual(new Date(2026, 10, 29));
  });
  it("counts each cost under whoever sent that go, and only inside the period", () => {
    const lines = [
      line({ kind: "ticket.opened", who: "you" }),
      line({ kind: "gate.passed", who: "SF itself", costUsd: 0.01 }),
      line({ costUsd: 0.2 }),
      line({ kind: "ticket.queued", who: "SF itself", data: { returned: true } }),
      line({ costUsd: 0.3 }),
      line({ kind: "ticket.queued", who: "you" }),
      line({ costUsd: 0.4 }),
      line({ ticket: "T2", kind: "ticket.opened", who: "you", ts: "2026-10-01T10:00:00.000Z" }),
      line({ ticket: "T2", costUsd: 9, ts: "2026-10-01T10:00:00.000Z" }),
      line({ ticket: "T3", kind: "ticket.opened", who: "SF itself", data: { own: true } }),
      line({ ticket: "T3", costUsd: 0.05 }),
    ];
    expect(spendOf(lines, new Date("2026-11-01T00:00:00Z"))).toEqual({ you: 0.61, alone: 0.3, own: 0.05 });
  });
  it("leaves room by limit, keeps SoftwareFactory's own work to its share, and never gives a run more than is left", () => {
    const s = { ...LIMIT_DEFAULTS, limitYou: 10, limitAlone: 10, ownSharePercent: 20, runLimit: 5 };
    const room = roomLeft(s, { you: 8, alone: 1, own: 1.5 });
    expect(room).toEqual({ you: 2, alone: 7.5, own: 0.5 });
    expect(runBudget(s, room, "you")).toBe(2);
    expect(runBudget(s, room, "alone")).toBe(5);
    expect(runBudget(s, roomLeft(s, { you: 10.2, alone: 0, own: 0 }), "you")).toBe(0);
    // Too little left to be worth a run: it does not start, and waits for the new period.
    expect(runBudget(s, roomLeft(s, { you: 9.93, alone: 0, own: 0 }), "you")).toBe(0);
    expect(() => checkLimits({ ...s, runLimit: 0 })).toThrow(/hold the queue/);
    expect(() => checkLimits({ ...s, limitYou: -1 })).toThrow(/Limit 1/);
    expect(() => checkLimits({ ...s, limitPeriod: "year" as any })).toThrow();
  });
});
