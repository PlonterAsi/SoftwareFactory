import { describe, expect, it } from "vitest";
import { TheRecord } from "../src/fence/record.js";
import { protectedChanges, protectedOnRecord, settingsInDoubt } from "../src/fence/protected.js";
import { HOME_DEFAULTS } from "../src/fence/home.js";

describe("the protected settings", () => {
  it("names each change as a sentence, and only the protected ones", () => {
    const now = { ...HOME_DEFAULTS, limitAlone: 80, stopPaths: ["billing/"], model: "opus" };
    expect(protectedChanges(HOME_DEFAULTS, now)).toEqual([
      { key: "limitAlone", says: "Limit 2 (work SoftwareFactory sent by itself): from 50 to 80" },
      { key: "stopPaths", says: "More on the stop list: from nothing to billing/" },
    ]);
  });

  it("takes only the owner's lines by hand, on top of the values written down when the protection began", () => {
    const r = new TheRecord();
    // Saved before there was a second step: not taken as the owner's word.
    r.append({ kind: "setting.changed", who: "you", data: { changed: { runLimit: { from: 5, to: 1 } } } });
    r.append({ kind: "setting.changed", who: "SF itself", data: { baseline: { limitPeriod: "month", limitYou: 100, limitAlone: 50, ownSharePercent: 20, runLimit: 5, runFloor: 0.5, stopPaths: [] } } });
    expect(settingsInDoubt(r.all(), HOME_DEFAULTS, HOME_DEFAULTS)).toEqual([]);
    r.append({ kind: "setting.changed", who: "you", data: { changed: { limitAlone: { from: 50, to: 80 }, model: { from: "sonnet", to: "opus" } }, byHand: ["limitAlone"] } });
    // Not by hand, not by the owner, or naming another setting by hand: none of these count.
    r.append({ kind: "setting.changed", who: "you", data: { changed: { limitAlone: { from: 80, to: 9000 } } } });
    r.append({ kind: "setting.changed", who: "you", data: { changed: { limitAlone: { from: 80, to: 9000 } }, byHand: ["limitYou"] } });
    r.append({ kind: "setting.changed", who: "worker", data: { changed: { runLimit: { from: 5, to: 500 } }, byHand: ["runLimit"] } });
    const set = protectedOnRecord(r.all(), HOME_DEFAULTS);
    expect(set.limitAlone).toMatchObject({ value: 80, by: "hand" });
    expect(set.runLimit).toMatchObject({ value: 5, by: "start" });
    expect(settingsInDoubt(r.all(), { ...HOME_DEFAULTS, limitAlone: 80 }, HOME_DEFAULTS)).toEqual([]);
    expect(settingsInDoubt(r.all(), { ...HOME_DEFAULTS, limitAlone: 9000 }, HOME_DEFAULTS)).toMatchObject([{ key: "limitAlone", says: "Limit 2 (work SoftwareFactory sent by itself): you set 80, the settings file says 9000", set: 80, file: 9000 }]);
    expect(settingsInDoubt(r.all(), { ...HOME_DEFAULTS, limitAlone: 80, runLimit: 1 }, HOME_DEFAULTS)[0]!.says).toBe("The most one run may use: it stood at 5, the settings file says 1");
  });
});
