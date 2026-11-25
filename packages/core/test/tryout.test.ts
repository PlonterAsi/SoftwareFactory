import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installKit, probeStart } from "../src/factory/appkit.js";
import { afterTry, findBrowser, readScreens, tryOuts } from "../src/factory/screencheck.js";
import { evaluationPrompt } from "../src/factory/evaluate.js";

const SCHEMA = `export const app = { name: "Desk", slug: "desk", tagline: "t", summary: "s" };
export const entities = [{ name: "piece", label: "Pieces", singular: "Piece", description: "d", title: "title",
  fields: [{ name: "title", type: "text", required: true }], seed: [{ title: "Morning pages" }, { title: "Haiku" }] }];
export const flows = []; export const features = [];`;

const APP = `import * as schema from "../src/schema.js";
import { startApp } from "./kit/shell.js";
const desk = { id: "desk", label: "Desk", description: "d", render(el, { store, h }) {
  const ask = h("div", {});
  const count = h("p", {}, "No changes yet.");
  el.append(h("h1", {}, "Desk"), h("p", {}, store.list("piece").length + " pieces"),
    h("button", { onclick: () => { ask.replaceChildren(h("p", {}, "Deleting Morning pages also removes 3 notes."), h("button", {}, "Yes, delete it")); } }, "Delete this piece"),
    h("button", { onclick: () => { if (confirm("Really wipe all 2 pieces?")) store.reset(); } }, "Wipe"),
    h("input", { type: "number", value: 20, oninput: (e) => { count.textContent = "Fee " + e.target.value + "% recalculates 4 entries."; } }),
    ask, count);
} };
startApp({ schema, views: [desk] });`;

function app(): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-tryout-"));
  mkdirSync(join(dir, "src")); mkdirSync(join(dir, "web"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "desk", type: "module", scripts: { start: "node server.js" } }));
  writeFileSync(join(dir, "src/schema.js"), SCHEMA);
  writeFileSync(join(dir, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><title>Desk</title><link rel="stylesheet" href="web/kit/kit.css"></head><body><div id="app"></div><script type="module" src="web/app.js"></script></body></html>`);
  writeFileSync(join(dir, "web/app.js"), APP);
  installKit(dir);
  return dir;
}

describe("the judge sees what a press or an edit leads to", () => {
  it("picks what to try: presses that end something first, one number per screen, each label once", () => {
    const main = (inner: string) => `<main class="kit-main">${inner}</main>`;
    const t = tryOuts([
      { route: "home", dom: main(`<button>New idea</button><button class="x">Delete this idea</button><button disabled>Archive</button>`) },
      { route: "v/money", dom: main(`<button>New idea</button><input type="number" value="20"><button>Confirm</button>`) },
      { route: "e/idea", dom: main(`<button>Delete</button>`) },
    ]);
    expect(t.map((x) => x.act)).toEqual(["press:Delete this idea", "press:Confirm", "nudge:0", "press:New idea"]);
    expect(t[2].route).toBe("v/money");
  });

  it("reads nothing from a try that did not run", () => {
    expect(afterTry("a", `<main class="kit-main">a<div data-sf-did="1">SF_DID nothing: no control with that label</div></main>`)).toBe("");
    expect(afterTry("a", `<main class="kit-main">a</main>`)).toBe("");
    expect(afterTry("a b", `<main class="kit-main">a b<div data-sf-did="1">SF_DID done</div></main>`)).toBe("nothing changed on the screen");
  });

  it.skipIf(!findBrowser())("in a real browser: a confirm step, a confirm box and a count after an edit all reach the judge", async () => {
    const dir = app();
    let screens: Awaited<ReturnType<typeof readScreens>> = null;
    const problems = await probeStart(dir, 15_000, async (url) => { screens = await readScreens(url, { tryOut: true }); return []; });
    expect(problems).toEqual([]);
    const desk = screens!.find((s) => s.route === "v/desk")!;
    expect(desk.text).not.toMatch(/also removes/);
    const tried = Object.fromEntries((desk.tried ?? []).map((t) => [t.did, t.shows]));
    expect(tried[`pressing "Delete this piece"`]).toMatch(/Deleting Morning pages also removes 3 notes\. Yes, delete it/);
    expect(tried[`pressing "Wipe"`]).toMatch(/Confirm box: Really wipe all 2 pieces\? \[OK\] \[Cancel\]/);
    expect(tried["raising the first number field by 1"]).toMatch(/Fee 21% recalculates 4 entries/);
    // The confirm box was answered Cancel: the pieces are still there on a later read.
    expect(desk.text).toMatch(/2 pieces/);
    const prompt = evaluationPrompt("a desk", { brief: { promise: "p" }, journeys: [], screens: [], requirements: [] } as never, screens!, 1);
    expect(prompt).toMatch(/After pressing "Delete this piece", the screen newly showed: .*also removes 3 notes/);
    expect(prompt).toMatch(/That counts as seen/);
  }, 120_000);
});
