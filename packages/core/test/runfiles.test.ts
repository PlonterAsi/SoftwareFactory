import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  EventLog, MockRuntime, createCore, createProject, listDataFiles, readDataFile, writeDataFile, renameDataFile, deleteDataFile,
  samplesFromTests, samplesFromDocs, columnsFromSpec, makeTable, makeSamples, planQuickRun, sampleFiles,
} from "../src/index.js";

function folder(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "sf-files-"));
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), c); }
  return dir;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A tool like the ones the factory built before it made real apps: it needs a CSV and nobody knows its shape.
const EXPENSES = `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const USAGE = "usage: expenses <file.csv>";
const f = process.argv[2];
if (!f) { console.error(USAGE); process.exit(2); }
const [head, ...rows] = readFileSync(f, "utf8").trim().split(/\\r?\\n/);
const cols = head.split(",");
const ci = cols.indexOf("category"), ai = cols.indexOf("amount");
const by = {};
for (const r of rows) { const c = r.split(","); by[c[ci]] = (by[c[ci]] ?? 0) + Number(c[ai]); }
for (const [k, v] of Object.entries(by)) console.log(k + ": " + v.toFixed(2));
`;
const SPEC = "# Expense summary\n\nSums a CSV of expenses by category. The CSV has the columns date, category, amount.\n\nusage: expenses <file.csv>\n";

describe("run: data files and samples, so nobody writes raw files by hand", () => {
  it("lists a project's data files, samples and data first, and leaves code and packages out", () => {
    const dir = folder({
      "samples/a.csv": "x,y\n1,2\n", "data/db.json": "{}", "notes.md": "# hi", "package.json": "{}", "src/schema.js": "",
      "node_modules/x/data.json": "{}", "test/fixtures/in.json": "[1]", "web/index.html": "",
    });
    const files = listDataFiles(dir);
    expect(files.map((f) => [f.path, f.role])).toEqual([["samples/a.csv", "sample"], ["data/db.json", "data"], ["test/fixtures/in.json", "fixture"], ["notes.md", "doc"]]);
    expect(files.find((f) => f.path === "data/db.json")!.note).toMatch(/own data store/);
    // The app's store is never offered as an input to a tool.
    expect(sampleFiles(dir)).not.toContain("data/db.json");
  });

  it("reads, saves, renames and deletes data files, and nothing outside the folder", () => {
    const dir = folder({ "samples/a.csv": "x,y\n1,2\n" });
    expect(readDataFile(dir, "samples/a.csv").kind).toBe("table");
    writeDataFile(dir, "samples/a.csv", "x,y\n3,4\n");
    expect(readFileSync(join(dir, "samples/a.csv"), "utf8")).toBe("x,y\n3,4\n");
    expect(() => writeDataFile(dir, "samples/a.csv", "", { create: true })).toThrow(/already exists/);
    expect(() => writeDataFile(dir, "data/b.json", "{nope")).toThrow(/Not valid JSON/);
    expect(() => writeDataFile(dir, "../escape.csv", "a")).toThrow(/Refused/);
    expect(() => writeDataFile(dir, "bin/tool.js", "a")).toThrow(/Only data files/);
    expect(() => readDataFile(dir, "node_modules/x.json")).toThrow(/Refused/);
    renameDataFile(dir, "samples/a.csv", "samples/b.csv");
    expect(existsSync(join(dir, "samples/b.csv"))).toBe(true);
    deleteDataFile(dir, "samples/b.csv");
    expect(existsSync(join(dir, "samples/b.csv"))).toBe(false);
  });

  it("finds sample inputs in the project's tests and docs, and makes a table from the spec's columns", () => {
    const dir = folder({
      "test/sum.test.js": "const csv = `date,category,amount\n2024-01-02,food,12.50\n2024-01-03,bus,3.00`;\nconst j = '{\"items\": [1, 2]}';\nconst x = [\"name,age\", \"Dana,30\"].join(\"\\n\");\n",
      "README.md": "Example:\n\n```json\n{\"tasks\": [{\"title\": \"Buy milk\", \"done\": false}]}\n```\n",
    });
    const t = samplesFromTests(dir);
    expect(t.map((s) => s.path)).toEqual(expect.arrayContaining(["samples/date-category.csv", "samples/name-age.csv"]));
    expect(t.find((s) => s.path === "samples/date-category.csv")!.content).toContain("food,12.50");
    expect(samplesFromDocs(dir)[0]).toMatchObject({ path: "samples/example-1.json", kind: "json", from: "README.md" });
    expect(columnsFromSpec(SPEC)).toEqual(["date", "category", "amount"]);
    const table = makeTable(["date", "category", "amount", "note"], 3).trim().split("\n");
    expect(table[0]).toBe("date,category,amount,note");
    expect(table[1]).toMatch(/^2024-03-01,food,\d+\.\d\d,/);
    const made = makeSamples(dir);
    expect(made.length).toBe(3);
    // Never overwrites: a second batch gets new names.
    const again = makeSamples(dir);
    expect(again.every((m) => !made.some((x) => x.path === m.path))).toBe(true);
  });

  it("plans a one-press run for a tool that needs a CSV nobody has, by making one from its spec", () => {
    const dir = folder({ "bin/expenses.js": EXPENSES, "SPEC.md": SPEC });
    const plan = planQuickRun(dir);
    expect(plan.profile.id).toBe("bin:expenses");
    expect(plan.made.map((m) => m.path)).toEqual(["samples/date-category.csv"]);
    expect(plan.argv).toEqual([join(dir, "samples/date-category.csv")]);
    expect(plan.why).toMatch(/Made samples\/date-category\.csv/);
    // The second press uses what is there now and makes nothing new.
    expect(planQuickRun(dir).made).toEqual([]);
  });

  it("Start with one press, over the API: makes the sample, runs it, and the file can be edited and run again", async () => {
    const log = new EventLog(":memory:");
    const core = createCore({ log, runtime: new MockRuntime({ delayMs: 0 }), projectsDir: join(mkdtempSync(join(tmpdir(), "sf-files-")), "projects"), order: { mode: "heuristic" } });
    const server = createServer(core);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (path: string, body?: unknown) => {
      const r = await fetch(base + path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() as any };
    };
    const lines = async (sid: number) => {
      for (let i = 0; i < 100; i++) { const r = (await call(`/api/launch/sessions/${sid}`)).body; if (r.session.state === "exited") return r.lines.map((l: any) => l.text) as string[]; await sleep(80); }
      throw new Error("never finished");
    };
    try {
      const dir = folder({ "bin/expenses.js": EXPENSES, "SPEC.md": SPEC });
      const pid = createProject(log, { name: "Expenses" });
      await call(`/api/launch/projects/${pid}/folder`, { dir });
      const go = await call(`/api/launch/projects/${pid}/go`, {});
      expect(go.status).toBe(202);
      expect(go.body.made).toEqual([{ path: "samples/date-category.csv", kind: "table", from: "SPEC.md" }]);
      expect((await lines(go.body.session.id)).some((l) => /^food: \d+\.\d\d$/.test(l))).toBe(true);

      const list = await call(`/api/launch/projects/${pid}/files`);
      expect(list.body.files.map((f: any) => [f.path, f.role])).toEqual([["samples/date-category.csv", "sample"], ["SPEC.md", "doc"]]);
      const f = await call(`/api/launch/projects/${pid}/files?path=${encodeURIComponent("samples/date-category.csv")}`);
      expect(f.body.content.split("\n")[0]).toBe("date,category,amount");
      await call(`/api/launch/projects/${pid}/files`, { path: "samples/date-category.csv", content: "date,category,amount\n2024-01-01,books,40\n2024-01-02,books,2\n" });
      const go2 = await call(`/api/launch/projects/${pid}/go`, {});
      expect(await lines(go2.body.session.id)).toContain("books: 42.00");

      expect((await call(`/api/launch/projects/${pid}/files`, { path: "../x.csv", content: "a" })).status).toBe(400);
      const bad = await call(`/api/launch/projects/${pid}/files`, { path: "data/x.json", content: "{" });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toMatch(/Not valid JSON/);
      const ren = await call(`/api/launch/projects/${pid}/files`, { from: "samples/date-category.csv", to: "samples/mine.csv" });
      expect(ren.body.files.map((x: any) => x.path)).toEqual(["samples/mine.csv", "SPEC.md"]);
      const del = await call(`/api/launch/projects/${pid}/files`, { path: "samples/mine.csv", delete: true });
      expect(del.body.files.map((x: any) => x.path)).toEqual(["SPEC.md"]);
      const mk = await call(`/api/launch/projects/${pid}/samples`, {});
      expect(mk.body.made[0].path).toBe("samples/date-category.csv");
    } finally {
      core.launcher.stopAll();
      server.close();
    }
  }, 30_000);
});
