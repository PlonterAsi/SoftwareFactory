import { describe, expect, it } from "vitest";
import { cardOf, cleanProjects, isBringing, projectLights, projectList, provenFrom } from "../src/fence/projecthome.js";

const card = (repo: string, over = {}) => ({ repo, name: "", base: "", checks: [], prepare: [], asleep: false, ...over });

describe("projects", () => {
  it("keeps clean cards and says in a sentence what is wrong", () => {
    expect(cleanProjects([{ repo: " o/p ", name: "  Mine\n", checks: [" npm test ", ""], asleep: true }], [], 30)).toEqual([card("o/p", { name: "Mine", checks: ["npm test"], asleep: true })]);
    expect(cleanProjects(undefined, [card("o/p")], 30)).toEqual([card("o/p")]);
    expect(() => cleanProjects([{ repo: "nope" }], [], 30)).toThrow(/owner\/name/);
    expect(() => cleanProjects([{ repo: "o/p" }, { repo: "O/P" }], [], 30)).toThrow(/twice/);
    expect(() => cleanProjects([{ repo: "o/p", base: "a..b" }], [], 30)).toThrow(/branch/);
    expect(() => cleanProjects([{ repo: "o/a" }, { repo: "o/b" }], [], 1)).toThrow(/up to 1/);
  });

  it("takes the chosen project's fields from Settings, and counts it as a project even with no card", () => {
    const s = { repo: "o/p", base: "main", checks: ["npm test"], prepare: [], projects: [card("o/q", { base: "dev" })], maxProjects: 30 };
    expect(projectList(s).map((c) => [c.repo, c.base])).toEqual([["o/p", "main"], ["o/q", "dev"]]);
    expect(cardOf({ ...s, projects: [card("o/p", { base: "old", name: "P" }), card("o/q")] }, "O/P")).toMatchObject({ base: "main", name: "P", checks: ["npm test"] });
    expect(cardOf(s, "x/y")).toBeNull();
  });

  it("gives each project one colour and one sentence", () => {
    const t = (project: string, state: string, over = {}) => ({ project, state, removed: false, ...over });
    const lights = projectLights([card("o/a"), card("o/b"), card("o/c"), card("o/d"), card("o/e", { asleep: true }), card("o/f")], "o/b", [
      t("o/a", "asked"), t("o/a", "proposed"), t("o/a", "held", { canRelease: true }),
      t("o/b", "failed its checks"), t("o/b", "waiting"), t("o/b", "proposed", { removed: true }),
      t("o/c", "proposed"), t("o/c", "proposed"),
      t("o/d", "working"), t("o/d", "waiting"), t("o/d", "waiting"),
      t("o/e", "waiting"),
      t("o/f", "split"), t("o/f", "accepted"),
      t("o/g", "stopped"),
    ]);
    expect(lights.map((l) => [l.repo, l.colour, l.says])).toEqual([
      ["o/a", "red", "2 tickets wait for your word; 1 result is ready for you."],
      ["o/b", "amber", "1 ticket did not finish; 1 ticket waits its turn."],
      ["o/c", "green", "2 results are ready for you."],
      ["o/d", "blue", "1 ticket is being worked; 2 tickets wait their turn."],
      ["o/e", "grey", "Asleep: 1 ticket kept, none is worked."],
      ["o/f", "grey", "Nothing open. Nothing has shown yet that it runs here."],
      ["o/g", "grey", "Not on the list: 1 ticket kept, none is worked. Choose it to bring it back."],
    ]);
    expect(projectLights([card("o/g")], "", [t("o/g", "stopped")])[0]).toMatchObject({ colour: "amber", says: "1 ticket did not finish.", listed: true });
    expect(lights.find((l) => l.chosen)!.repo).toBe("o/b");
  });

  it("reads from the record which projects run here: only a try counts, and a later failed try takes the proof away", () => {
    let id = 0;
    const l = (kind: string, run: string, project: string, data: Record<string, unknown> = {}) => ({ kind, run, ticket: run.split("-")[0]!, project, ts: `2026-11-28T00:00:${String(++id).padStart(2, "0")}Z`, data });
    const tried = (run: string, project: string, oks: boolean[], end: string) => [l("run.started", run, project, { tryOnly: true }), ...oks.map((ok) => l("run.checked", run, project, { ok })), l("run.ended", run, project, { end })];
    // An ordinary ticket's run checked its own changed copy: no proof. A try with no check proves nothing.
    const lines = [l("run.started", "T1-a", "o/p"), l("run.checked", "T1-a", "o/p", { ok: true }), l("run.ended", "T1-a", "o/p", { end: "passed" }), ...tried("T2-a", "o/p", [], "passed")];
    expect(provenFrom(lines).size).toBe(0);
    lines.push(...tried("T3-a", "O/P", [true, true], "passed"), ...tried("T4-a", "o/other", [true, false], "failed its checks"));
    expect([...provenFrom(lines)]).toEqual([["o/p", { at: expect.any(String), checks: 2, ticket: "T3" }]]);
    // Parked or stopped says nothing either way; a failed check takes the proof away.
    lines.push(...tried("T5-a", "o/p", [], "parked"));
    expect(provenFrom(lines).has("o/p")).toBe(true);
    lines.push(...tried("T6-a", "o/p", [false], "failed its checks"));
    expect(provenFrom(lines).has("o/p")).toBe(false);
    expect(isBringing({ bringIn: true, removed: false, state: "parked", parkedFor: "limit" })).toBe(true);
    expect(isBringing({ bringIn: true, removed: false, state: "parked", parkedFor: "no checks" })).toBe(false);
    expect(isBringing({ bringIn: false, removed: false, state: "waiting" })).toBe(false);
  });
});
