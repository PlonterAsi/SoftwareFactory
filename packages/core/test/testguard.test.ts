import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { commitAll, git, initRepo } from "../src/factory/workspace.js";
import { testIntegrity } from "../src/safety/testguard.js";

let dir = "";
let base = "";
const put = (p: string, text: string) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), text); };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sf-guard-"));
  initRepo(dir);
  put("test/a.test.js", "import test from 'node:test';\ntest('a', () => {});\n");
  put("test/b.test.js", "import test from 'node:test';\ntest('b', () => {});\n");
  put("src/x.js", "export const x = 1;\n");
  commitAll(dir, "base");
  base = git(dir, "rev-parse", "HEAD");
});

describe("testIntegrity", () => {
  it("is quiet on a clean tree and on ordinary edits", () => {
    expect(testIntegrity(dir, base)).toEqual([]);
    put("src/x.js", "export const x = 2;\n");
    put("test/c.test.js", "import test from 'node:test';\ntest('c', () => {});\n");
    expect(testIntegrity(dir, base, { locked: 2, ran: 3 })).toEqual([]);
  });

  it("reports a deleted test file", () => {
    rmSync(join(dir, "test/a.test.js"));
    expect(testIntegrity(dir, base)).toEqual(["test/a.test.js: test file deleted"]);
  });

  it("reports a test file moved out of test/", () => {
    renameSync(join(dir, "test/a.test.js"), join(dir, "src/a.test.js"));
    const out = testIntegrity(dir, base);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^test\/a\.test\.js: test file renamed away to src\/a\.test\.js/);
  });

  it("reports a test file renamed so it no longer matches *.test.*", () => {
    git(dir, "mv", "test/b.test.js", "test/b.js");
    expect(testIntegrity(dir, base)[0]).toMatch(/^test\/b\.test\.js: test file renamed away to test\/b\.js/);
  });

  it("reports new skip, only, todo, xit and xdescribe", () => {
    put("test/a.test.js", "test.skip('a', () => {});\n");
    put("test/b.test.js", "it.only('b', () => {});\nit.todo('c');\nxit('d');\nxdescribe('e');\n");
    const out = testIntegrity(dir, base);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^test\/a\.test\.js: 1 new/);
    expect(out[1]).toMatch(/^test\/b\.test\.js: 4 new/);
  });

  it("does not count skips that were already there, or in source files", () => {
    put("test/a.test.js", "test.skip('a', () => {});\n");
    commitAll(dir, "skip already at base");
    base = git(dir, "rev-parse", "HEAD");
    put("src/x.js", "// it.skip\n");
    expect(testIntegrity(dir, base)).toEqual([]);
  });

  it("reports fewer test cases than were locked", () => {
    expect(testIntegrity(dir, base, { locked: 5, ran: 3 })).toEqual(["only 3 test cases ran, 5 were locked; 2 went missing"]);
    expect(testIntegrity(dir, base, { locked: 5, ran: 5 })).toEqual([]);
    expect(testIntegrity(dir, base, { ran: 1 })).toEqual([]);
  });
});
