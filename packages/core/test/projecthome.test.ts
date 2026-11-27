import { describe, expect, it } from "vitest";
import { cardOf, cleanProjects, projectLights, projectList } from "../src/fence/projecthome.js";

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
    ]);
    expect(lights.map((l) => [l.repo, l.colour, l.says])).toEqual([
      ["o/a", "red", "2 tickets wait for your word; 1 result is ready for you."],
      ["o/b", "amber", "1 ticket did not finish; 1 ticket waits its turn."],
      ["o/c", "green", "2 results are ready for you."],
      ["o/d", "blue", "1 ticket is being worked; 2 tickets wait their turn."],
      ["o/e", "grey", "Asleep: 1 ticket kept, none is worked."],
      ["o/f", "grey", "Nothing open."],
    ]);
    expect(lights.find((l) => l.chosen)!.repo).toBe("o/b");
  });
});
