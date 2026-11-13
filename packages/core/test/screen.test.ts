import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, Factory, MockRuntime, writeFiles, git, checkUi, pageImportsOf as importsOf, type AgentRequest, type AgentResult } from "../src/index.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const events = (log: EventLog, type: string) => log.list({ limit: 1e6 }).filter((e) => e.type === type).map((e) => e.payload as any);
const page = (root: string, files: Record<string, string>) => writeFiles(root, Object.entries(files).map(([path, content]) => ({ path, content })), { lockTests: false });

describe("the page check", () => {
  it("passes a page whose scripts and imports all load in a browser", () => {
    const root = tmp("sf-ui-");
    page(root, {
      "index.html": '<!doctype html><link rel="stylesheet" href="web/style.css"><body><div id="out"></div><script type="module" src="web/app.js"></script></body>',
      "web/style.css": "body{}",
      "web/app.js": 'import { f } from "../src/core.js";\ndocument.getElementById("out").textContent = f();',
      "src/core.js": 'import { g } from "./util.js";\nexport const f = () => g();',
      "src/util.js": "export const g = () => 'hi';",
    });
    const r = checkUi(root);
    expect(r).toMatchObject({ pass: true, problems: [], notes: [] });
    expect(r.files.sort()).toEqual(["index.html", "src/core.js", "src/util.js", "web/app.js", "web/style.css"]);
  });

  it("names what would break the page: no index.html, node: imports, missing files, the internet, bad syntax", () => {
    expect(checkUi(tmp("sf-ui-")).problems[0]).toMatch(/index.html is missing/);
    const root = tmp("sf-ui-");
    page(root, {
      "index.html": '<body><script src="https://cdn.example.com/x.js"></script><script type="module" src="web/app.js"></script><script src="web/gone.js"></script></body>',
      "web/app.js": 'import { f } from "../src/core.js";\nimport "../src/noext";\nimport x from "lodash";\ndocument.querySelector("#nope");',
      "src/core.js": 'import { readFileSync } from "node:fs";\nexport const f = () => (;',
    });
    const r = checkUi(root);
    expect(r.pass).toBe(false);
    const all = r.problems.join("\n");
    expect(all).toMatch(/from the internet/);
    expect(all).toMatch(/web\/gone.js, which does not exist/);
    expect(all).toMatch(/src\/core.js imports "node:fs", which a browser cannot load/);
    expect(all).toMatch(/\.\.\/src\/noext, which does not exist \(a browser needs the full file name/);
    expect(all).toMatch(/the package "lodash"/);
    expect(all).toMatch(/does not parse: src\/core.js/);
    expect(r.notes.join("\n")).toMatch(/#nope/);
  });

  it("holds a server.js to the Run tab's port", () => {
    const root = tmp("sf-ui-");
    page(root, { "index.html": "<body><main></main><script>1</script></body>", "server.js": 'import { createServer } from "node:http";\ncreateServer(() => {}).listen(3000);' });
    const r = checkUi(root);
    expect(r.server).toBe(true);
    expect(r.problems.join("\n")).toMatch(/process\.env\.PORT/);
  });

  it("reads import specifiers, not comments", () => {
    expect(importsOf('import a from "./a.js";\n// import b from "./b.js"\nexport * from "./c.js";\nimport "./d.js";\nconst e = await import("./e.js");\nimport {\n  f,\n} from "./f.js";')).toEqual(["./a.js", "./c.js", "./d.js", "./f.js", "./e.js"]);
  });
});

/** The mock crew as it was before the GUI default: a CLI with no page. */
class CliOnlyRuntime extends MockRuntime {
  async run(req: AgentRequest): Promise<AgentResult> {
    const r = await super.run(req);
    const station = req.systemPrompt?.match(/Station contract: (\w+)/)?.[1];
    if (station === "plan") {
      const j = JSON.parse(r.text.replace(/^```json\n|\n```$/g, ""));
      delete j.ui; delete j.cli; delete j.examples;
      return { ...r, text: "```json\n" + JSON.stringify(j) + "\n```" };
    }
    if (station === "build" || station === "fix") return { ...r, text: r.text.split("<<<FILE index.html")[0] };
    return r;
  }
}

/** A CLI-only project the factory shipped before the GUI default: its logged plan has no screen. */
function legacyProject(log: EventLog, projects: string) {
  const run = log.append("factory.run.started", { idea: "a CLI that counts words", maxUsd: 1.5, runtime: "mock" }).id;
  const dir = join(projects, `word-counter-${run}`);
  git(projects, "init", "-q", "-b", "main", dir);
  const files = [
    { path: "package.json", content: '{ "name": "word-counter", "type": "module", "scripts": { "test": "node --test" } }\n' },
    { path: "src/count.js", content: "export function countWords(text) {\n  return text.split(/\\s+/).filter(Boolean).length;\n}\n" },
    { path: "bin/wc.js", content: 'import { readFileSync } from "node:fs";\nimport { countWords } from "../src/count.js";\nconsole.log(countWords(readFileSync(process.argv[2], "utf8")));\n' },
    { path: "test/count.test.js", content: 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { countWords } from "../src/count.js";\ntest("empty text has 0 words", () => assert.equal(countWords(""), 0));\n' },
  ];
  writeFiles(dir, files, { lockTests: false });
  git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "Ship"); git(dir, "tag", "v0.1.0");
  const plan = { name: "Word Counter", slug: "word-counter", summary: "Counts words in a file.", interface: "src/count.js exports countWords(text). bin/wc.js prints the count of the file in argv[2].", acceptance: ["empty text has 0 words"], tasks: [{ id: "t1", title: "countWords", dependsOn: [] }], files: ["src/count.js", "bin/wc.js"] };
  log.append("factory.plan", { run, plan, dir, sha: "x", written: [] });
  log.append("factory.run.finished", { run, outcome: "shipped", reason: "Shipped", dir, sha: "x", plan: plan.name, totalUsd: 0, agentCalls: 0, fixRounds: 0 });
  return { run, dir };
}

describe("adding a screen to a finished project", () => {
  it("a build without a page does not ship: the page check holds it", async () => {
    const log = new EventLog();
    const f = new Factory(log, new CliOnlyRuntime({ plantBug: false }), tmp("sf-proj-"));
    const run = f.start("a CLI that counts words", { autoApprove: true, maxFixRounds: 1, autoRetries: 0 });
    await f.wait(run);
    expect(events(log, "factory.ui")[0].problems[0]).toMatch(/index.html is missing/);
    expect(events(log, "factory.run.finished").at(-1).outcome).not.toBe("shipped");
  });

  it("rebuilds a shipped CLI-only project with a page on top, in the same folder, keeping its tests", async () => {
    const log = new EventLog();
    const projects = tmp("sf-proj-");
    const base = legacyProject(log, projects);
    const testsBefore = git(base.dir, "ls-files", "test");

    const rt = new MockRuntime({ plantBug: false });
    const f = new Factory(log, rt, projects);
    const run = f.addScreen(base.run, { autoApprove: true });
    await f.wait(run);
    const fin = events(log, "factory.run.finished").at(-1);
    expect(fin).toMatchObject({ run, outcome: "shipped", dir: base.dir });
    // Only build and review were asked: no Council, no new plan, no new tests.
    expect(rt.calls.map((c) => c.systemPrompt?.match(/Station contract: (\w+)/)?.[1])).toEqual(["build", "review"]);
    expect(rt.calls[0].prompt).toContain("Current code:");
    expect(rt.calls[0].prompt).toContain("bin/wc.js");
    expect(rt.calls[0].prompt).toContain('"ui": "An app for: Counts words in a file.');
    expect(existsSync(join(fin.dir, "index.html"))).toBe(true);
    expect(git(fin.dir, "ls-files", "test")).toBe(testsBefore);
    expect(git(fin.dir, "tag").split("\n").sort()).toEqual(["v0.1.0", "v0.2.0"]);
    expect(events(log, "factory.ui").at(-1)).toMatchObject({ run, pass: true });
    expect(events(log, "factory.station").filter((s) => s.run === run && s.state === "skipped").map((s) => s.station)).toEqual(["intake", "council", "plan", "tests", "evaluate"]);
    expect(events(log, "factory.visual").filter((v) => v.run === run).every((v) => v.pass)).toBe(true);
  });

  it("puts the folder back when the screen run does not ship, and refuses a folder with your changes", async () => {
    const log = new EventLog();
    const projects = tmp("sf-proj-");
    const { run: base, dir } = legacyProject(log, projects);
    const head = git(dir, "rev-parse", "HEAD");

    // The crew never manages a page: fix rounds run out, the unattended run stops, the folder goes back.
    const f = new Factory(log, new CliOnlyRuntime({ plantBug: false }), projects);
    const run = f.addScreen(base, { autoApprove: true, autoRetries: 0 });
    expect(f.addScreen.bind(f, base)).toThrow(/already working in that folder/);
    await f.wait(run);
    const fin = events(log, "factory.run.finished").at(-1);
    expect(fin.outcome).not.toBe("shipped");
    expect(fin.reason).toMatch(/back at/);
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    expect(git(dir, "status", "--porcelain")).toBe("");

    writeFiles(dir, [{ path: "notes.txt", content: "mine\n" }], { lockTests: true });
    expect(() => f.addScreen(base)).toThrow(/not committed/);
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("mine\n");
    expect(() => f.addScreen(run)).toThrow(/has not shipped/);
  });
});
