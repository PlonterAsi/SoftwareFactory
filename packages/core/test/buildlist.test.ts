import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The build list (build/pieces.json) is what every session picks up from, so its shape is a rule. */
const list = JSON.parse(readFileSync(new URL("../../../build/pieces.json", import.meta.url), "utf8")) as { steps: { n: number; title: string; pieces: { id: string; title: string; status: string; from: string; done: string }[] }[] };
const all = list.steps.flatMap((s) => s.pieces);
const ORDER = ["proven", "built", "parked", "now", "next", "later"];

describe("the build list", () => {
  it("names every piece once, with what proves it", () => {
    expect(new Set(all.map((p) => p.id)).size).toBe(all.length);
    for (const p of all) { expect(ORDER).toContain(p.status); expect(p.title.trim() && p.done.trim() && p.from.trim()).toBeTruthy(); }
  });
  it("has exactly one piece in work", () => { expect(all.filter((p) => p.status === "now").length).toBe(1); });
  it("starts nothing later before what comes first is at least built", () => {
    const firstOpen = all.findIndex((p) => ["now", "next", "later"].includes(p.status));
    expect(all.slice(firstOpen).every((p) => !["proven", "built"].includes(p.status))).toBe(true);
  });
  it("keeps the steps in order", () => { expect(list.steps.map((s) => s.n)).toEqual(list.steps.map((_, i) => i + 1)); });
});
