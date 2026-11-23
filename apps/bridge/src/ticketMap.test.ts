import { describe, expect, it } from "vitest";
import { buildTicketMap, mapCi, PARKED_STATES, STATION_ORDER } from "./ticketMap";

const st = (d: Parameters<typeof buildTicketMap>[0]) => buildTicketMap(d).nodes.map((n) => n.status);
const run = (station: string | null, outcome: string | null = null, state: string | null = "running") => ({ id: 1, station, outcome, state });

describe("ticketMap", () => {
  it("marks done, current and not started around the station", () => {
    const s = st({ run: run("build") });
    expect(s.slice(0, 6)).toEqual(Array(6).fill("done"));
    expect(s[6]).toBe("current");
    expect(s.slice(7)).toEqual(Array(6).fill("notstarted"));
  });
  it("shipped makes all done", () => expect(st({ run: run("ship", "shipped") })).toEqual(Array(13).fill("done")));
  it("stopped and failed at the station", () => {
    expect(st({ run: run("test", "stopped") })[7]).toBe("stopped");
    expect(st({ run: run("test", "failed") })[7]).toBe("failed");
  });
  it("parks gates only on waiting", () => {
    expect(PARKED_STATES).toEqual(["waiting"]);
    expect(st({ run: run("gateA", null, "waiting") })[4]).toBe("waiting");
    expect(st({ run: run("gateB", null, "waiting") })[11]).toBe("waiting");
    expect(st({ run: run("gateA", null, "running") })[4]).toBe("current");
    expect(st({ run: run("build", null, "waiting") })[6]).toBe("current");
  });
  it("no run or unknown station is all not started, without throwing", () => {
    expect(buildTicketMap({ run: null }).nodes).toEqual([]);
    expect(st({ run: run("nowhere") })).toEqual(Array(13).fill("notstarted"));
    expect(() => buildTicketMap(undefined)).not.toThrow();
    expect(() => buildTicketMap({ run: run("test"), steps: null, check: { reasons: [null as never] }, pr: { state: "weird" } })).not.toThrow();
  });
  it("counts rounds from steps", () => {
    const n = buildTicketMap({ run: run("fix"), steps: [{ step: "test" }, { step: "test" }, { step: "fix" }] }).nodes;
    expect(n[STATION_ORDER.indexOf("test")].round).toBe(2);
    expect(n[STATION_ORDER.indexOf("fix")].round).toBeNull();
  });
  it("maps CI words", () => {
    expect([mapCi("green"), mapCi("red"), mapCi("running"), mapCi("x"), mapCi(undefined)]).toEqual(["passed", "failed", "running", "none", "none"]);
  });
  it("maps the PR node", () => {
    const pr = (state: string, check?: { ci?: string; reasons?: { ok: boolean }[] } | null) => buildTicketMap({ run: run("build"), pr: { state }, check }).nodes[13];
    expect(pr("merged").status).toBe("done");
    expect(pr("closed").status).toBe("failed");
    expect(pr("open", { ci: "green", reasons: [{ ok: false }] }).status).toBe("failed");
    expect(pr("open", { ci: "red", reasons: [] }).status).toBe("failed");
    expect(pr("open", { ci: "running", reasons: [] }).status).toBe("current");
    expect(pr("open", null).status).toBe("current");
    expect(pr("open", { ci: "green", reasons: [{ ok: true }] }).status).toBe("waiting");
    expect(pr("open", { ci: "none", reasons: [] }).status).toBe("waiting");
    expect(pr("open").target).toBe("merge");
  });
  it("reads the header", () => {
    expect(buildTicketMap({ run: { id: 7, station: "plan", spentUsd: 1.5 } }).header).toEqual({ runId: 7, spentUsd: 1.5 });
  });
});
