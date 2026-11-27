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

  it("reads what the owner set from the record, and nobody else's lines", () => {
    const r = new TheRecord();
    r.append({ kind: "setting.changed", who: "you", data: { changed: { limitAlone: { from: 50, to: 80 }, model: { from: "sonnet", to: "opus" } } } });
    r.append({ kind: "setting.changed", who: "SF itself", data: { changed: { limitAlone: { from: 80, to: 9000 } } } });
    r.append({ kind: "setting.changed", who: "worker", data: { changed: { runLimit: { from: 5, to: 500 } } } });
    expect(protectedOnRecord(r.all(), HOME_DEFAULTS)).toMatchObject({ limitAlone: 80, runLimit: 5, limitYou: 100 });
    expect(settingsInDoubt(r.all(), { ...HOME_DEFAULTS, limitAlone: 80 }, HOME_DEFAULTS)).toEqual([]);
    expect(settingsInDoubt(r.all(), { ...HOME_DEFAULTS, limitAlone: 9000 }, HOME_DEFAULTS)).toEqual([{ key: "limitAlone", says: "Limit 2 (work SoftwareFactory sent by itself): you set 80, the settings file says 9000", set: 80 }]);
  });
});
