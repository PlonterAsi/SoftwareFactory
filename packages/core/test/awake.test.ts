import { describe, expect, it } from "vitest";
import { awakeAge, awakeTimer, noSleeps, noteLook } from "../src/fence/awake.js";

describe("awake time", () => {
  it("does not count a sleep as run time", async () => {
    let clock = 0, fired = 0;
    const cancel = awakeTimer(1000, () => { fired++; }, { now: () => clock, stepMs: 100 });
    const steps = async (n: number, by: number) => { for (let i = 0; i < n; i++) { clock += by; await new Promise((ok) => setTimeout(ok, 110)); } };
    await steps(3, 100);
    clock += 4 * 3_600_000; // four hours asleep
    await steps(2, 100);
    expect(fired).toBe(0);
    await steps(6, 100);
    expect(fired).toBe(1);
    cancel();
  });
  it("takes sleeps out of an age, but only those that came after", () => {
    const s = noSleeps();
    noteLook(s, 1000, 5000); noteLook(s, 6000, 5000);
    expect(s.list).toEqual([]);
    noteLook(s, 3_606_000, 5000); // an hour later: a sleep
    expect(s.list).toEqual([{ wokeAt: 3_606_000, ms: 3_595_000 }]);
    expect(awakeAge(s, 5000, 3_607_000)).toBe(7000);
    expect(awakeAge(s, 3_606_500, 3_607_000)).toBe(500);
  });
});
