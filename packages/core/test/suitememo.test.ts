import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SuiteMemo, treeHash } from "../src/factory/suitememo.js";

function repo() {
  const d = mkdtempSync(join(tmpdir(), "sf-memo-"));
  execFileSync("git", ["init", "-q"], { cwd: d });
  writeFileSync(join(d, "a.txt"), "one");
  return d;
}

describe("the repo suite is not run again on files nothing changed (run 9398)", () => {
  it("gives the same tree the same fingerprint, sees new and changed files, and leaves the index alone", () => {
    const d = repo();
    const h1 = treeHash(d);
    expect(h1).toMatch(/^[0-9a-f]{40}$/);
    expect(treeHash(d)).toBe(h1);
    writeFileSync(join(d, "b.txt"), "new");
    const h2 = treeHash(d);
    expect(h2).not.toBe(h1);
    writeFileSync(join(d, "a.txt"), "two");
    expect(treeHash(d)).not.toBe(h2);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: d, encoding: "utf8" })).toContain("?? a.txt");
  });

  it("reuses a copy of the last result for the same tree, runs again after a change, and always on a re-check", async () => {
    const d = repo();
    const memo = new SuiteMemo<{ cases: string[] }>();
    let runs = 0;
    const run = async () => ({ cases: [`run ${++runs}`] });
    expect((await memo.get(d, run)).reused).toBe(false);
    const again = await memo.get(d, run);
    expect(again).toEqual({ result: { cases: ["run 1"] }, reused: true });
    again.result.cases.push("changed by the caller");
    expect((await memo.get(d, run)).result.cases).toEqual(["run 1"]);
    expect((await memo.get(d, run, true)).result.cases).toEqual(["run 2"]);
    writeFileSync(join(d, "a.txt"), "edit");
    expect((await memo.get(d, run)).result.cases).toEqual(["run 3"]);
    expect(runs).toBe(3);
  });
});
