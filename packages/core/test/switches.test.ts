import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/index.js";
import { applySwitches, checkSwitch, listSwitches, noteStarted, resetSwitch, resetSwitchState, setSwitch } from "../src/configs/switches.js";
import { configRoute } from "../src/configs/routes.js";
import { buildInventory } from "../src/configs/inventory.js";

afterEach(() => resetSwitchState());

describe("switches", () => {
  it("lists every known switch with where its value came from", () => {
    const log = new EventLog();
    const env: Record<string, string | undefined> = { SF_LINK_CHECK: "off" };
    applySwitches(log, env);
    const s = listSwitches(log, env);
    expect(s.find((x) => x.name === "SF_LINK_CHECK")).toMatchObject({ value: "off", from: "pc" });
    expect(s.find((x) => x.name === "SF_SCREEN_CHECK")).toMatchObject({ value: null, from: "default" });
  });

  it("a value set on the page wins over the PC, applies at once, and Reset gives the PC's value back", () => {
    const log = new EventLog();
    const env: Record<string, string | undefined> = { SF_IMPORT_MAX_USD: "0.5" };
    applySwitches(log, env);
    expect(setSwitch(log, "SF_IMPORT_MAX_USD", 2)).toMatchObject({ value: "2", from: "page", pcValue: "0.5" });
    expect(env.SF_IMPORT_MAX_USD).toBe("2");
    expect(resetSwitch(log, "SF_IMPORT_MAX_USD")).toMatchObject({ value: "0.5", from: "pc" });
    expect(env.SF_IMPORT_MAX_USD).toBe("0.5");
  });

  it("keeps the page's values across a restart, and says when a start-time switch waits for one", () => {
    const log = new EventLog();
    let env: Record<string, string | undefined> = {};
    applySwitches(log, env); noteStarted(env);
    expect(setSwitch(log, "SF_AGENT_TIMEOUT_MS", 900000)).toMatchObject({ needsRestart: true });
    expect(setSwitch(log, "SF_LINK_CHECK", "off").needsRestart).toBeUndefined();
    // Restart: a fresh environment picks the page's values up before anything reads them.
    resetSwitchState();
    env = {};
    applySwitches(log, env); noteStarted(env);
    expect(env).toMatchObject({ SF_AGENT_TIMEOUT_MS: "900000", SF_LINK_CHECK: "off" });
    expect(listSwitches(log, env).find((x) => x.name === "SF_AGENT_TIMEOUT_MS")!.needsRestart).toBeUndefined();
  });

  it("refuses unknown switches, secrets and bad values", () => {
    expect(() => checkSwitch("SF_IG_APP_SECRET", "x")).toThrow(/not a switch/);
    expect(() => checkSwitch("SF_RUNTIME", "mock")).toThrow(/not a switch/);
    expect(() => checkSwitch("SF_ADVISOR", "gpt")).toThrow(/one of/);
    expect(() => checkSwitch("SF_AGENT_TIMEOUT_MS", "5")).toThrow(/between/);
    expect(() => checkSwitch("SF_BROWSER", "a\nb")).toThrow(/one line/);
    expect(checkSwitch("SF_SCREEN_CHECK", "")).toBeNull();
  });

  it("shows on the Configuration page and through the API", async () => {
    const log = new EventLog();
    const env: Record<string, string | undefined> = {};
    applySwitches(log, env);
    const req = (method: string) => ({ method }) as never;
    const put = await configRoute({ log, readJson: async () => ({ value: "off" }) }, req("PUT"), new URL("http://x/api/config/switches/SF_SCREEN_CHECK"));
    expect(put![0]).toBe(200);
    const bad = await configRoute({ log, readJson: async () => ({ value: "maybe" }) }, req("PUT"), new URL("http://x/api/config/switches/SF_SCREEN_CHECK"));
    expect(bad![0]).toBe(400);
    const got = await configRoute({ log }, req("GET"), new URL("http://x/api/config/switches"));
    expect((got![1] as { switches: { name: string; from: string }[] }).switches.find((s) => s.name === "SF_SCREEN_CHECK")!.from).toBe("page");
    const inv = buildInventory({
      agents: [], slots: { council: [] }, flows: [], plugins: [], skills: [], mcp: [], advisor: { model: "opus", minBudgetUsd: 0.25 }, crewMode: "real",
      autoWork: { on: true, maxUsd: 1.5, askedMaxUsd: 3, dailyUsd: 10, wip: 1 }, maxRunMinutes: undefined, personalSettings: false, env, switches: listSwitches(log, env),
    } as never);
    expect(inv.find((e) => e.id === "switch:SF_SCREEN_CHECK")).toMatchObject({ on: true, source: { kind: "you" } });
  });
});
