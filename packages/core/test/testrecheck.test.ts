import { describe, expect, it } from "vitest";
import { describeFailures, quietTail, testsWithRecheck, vitestFailures, type FailedTest, type VitestRun } from "../src/tickets/testrecheck.js";

const root = "/clone/packages/core";
const report = (fails: { file: string; name: string; msg?: string }[], loadError?: string) => JSON.stringify({
  testResults: [
    ...fails.map((f) => ({ name: `${root}/${f.file}`, status: "failed", assertionResults: [{ status: "passed", fullName: "fine" }, { status: "failed", fullName: f.name, failureMessages: [`\u001b[31m${f.msg ?? "expected 1 to be 2"}\u001b[39m\n(node:1) ExperimentalWarning: SQLite is an experimental feature`] }] })),
    ...(loadError ? [{ name: `${root}/test/broken.test.ts`, status: "failed", message: loadError, assertionResults: [] }] : []),
  ],
});
const run = (status: number, fails: FailedTest[] | null): VitestRun => ({ status, failures: fails, raw: "" });
const F = (file: string, name: string): FailedTest => ({ file, name, message: "" });

describe("the crew's test step reads failures fairly (24 Nov audit)", () => {
  it("names each failing test and its message, without colours or Node's warnings", () => {
    const f = vitestFailures(report([{ file: "test/a.test.ts", name: "a adds" }], "Cannot find module x"), root)!;
    expect(f).toEqual([
      { file: "test/a.test.ts", name: "a adds", message: "expected 1 to be 2" },
      { file: "test/broken.test.ts", name: "(the file failed to run)", message: "Cannot find module x" },
    ]);
    expect(describeFailures(f)).toContain("× test/a.test.ts › a adds\n    expected 1 to be 2");
    expect(vitestFailures("not json", root)).toBeNull();
  });

  it("takes Node's warning lines out of raw output", () => {
    const raw = `FAIL test/x.test.ts > x\n(node:5) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n(Use \`node --trace-warnings ...\` to show where the warning was created)\n`;
    expect(quietTail(raw)).toBe("FAIL test/x.test.ts > x");
  });

  it("passes when the failing test passes on a second run (flaky), naming it", async () => {
    const calls: string[][] = [];
    const r = await testsWithRecheck("/clone", root, ["src/a.ts"], {
      run: async (_c, args) => { calls.push(args); return calls.length === 1 ? run(1, [F("test/a.test.ts", "slow spawn")]) : run(0, []); },
      stash: { out: () => { throw new Error("no base run needed"); }, back: () => {} },
    });
    expect(r.ok).toBe(true);
    expect(r.flaky.map((f) => f.name)).toEqual(["slow spawn"]);
    expect(r.output).toContain("Flaky");
    expect(calls[1]).toEqual(["run", "--passWithNoTests", JSON.stringify("test/a.test.ts")]);
  });

  it("passes when the test fails on the base too, and puts the change back", async () => {
    const swaps: string[] = [];
    let n = 0;
    const r = await testsWithRecheck("/clone", root, ["src/a.ts"], {
      run: async () => (++n, run(1, [F("test/a.test.ts", "old break")])),
      stash: { out: () => swaps.push("out"), back: () => swaps.push("back") },
    });
    expect(n).toBe(3);
    expect(swaps).toEqual(["out", "back"]);
    expect(r.ok).toBe(true);
    expect(r.preexisting.map((f) => f.name)).toEqual(["old break"]);
    expect(r.output).toContain("Already failing on the base");
  });

  it("fails on what the change broke, with the test named first", async () => {
    let n = 0;
    const r = await testsWithRecheck("/clone", root, ["src/a.ts"], {
      run: async () => (++n === 3 ? run(1, [F("test/a.test.ts", "old break")]) : run(1, [F("test/a.test.ts", "old break"), F("test/a.test.ts", "new break")])),
      stash: { out: () => {}, back: () => {} },
    });
    expect(r.ok).toBe(false);
    expect(r.blamed.map((f) => f.name)).toEqual(["new break"]);
    expect(r.output.startsWith("× test/a.test.ts › new break")).toBe(true);
    expect(r.output).toContain("Already failing on the base before this change, not held against it: test/a.test.ts › old break");
  });

  it("puts the change back even when the base run throws, and then holds the failure", async () => {
    const swaps: string[] = [];
    let n = 0;
    const r = await testsWithRecheck("/clone", root, ["src/a.ts"], {
      run: async () => { if (++n === 3) throw new Error("boom"); return run(1, [F("test/a.test.ts", "x")]); },
      stash: { out: () => swaps.push("out"), back: () => swaps.push("back") },
    });
    expect(swaps).toEqual(["out", "back"]);
    expect(r.ok).toBe(false);
  });
});
