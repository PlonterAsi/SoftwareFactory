import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fastGates } from "../src/safety/gates.js";

function fixture(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "gates-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
}

describe("fast gates", () => {
  it("passes a clean folder and skips the tools it does not have", () => {
    const dir = fixture({ "src/a.js": "export const a = 1;\n" });
    const g = fastGates(dir, ["src/a.js"]);
    expect(g.ok).toBe(true);
    expect(g.messages).toBe("");
    expect(g.results.map((r) => [r.gate, r.state])).toEqual([["syntax", "pass"], ["tsc", "skipped"], ["lint", "skipped"], ["secrets", "pass"]]);
    expect(g.results.find((r) => r.gate === "tsc")!.note).toMatch(/tsconfig/);
  });

  it("stops at a syntax error and names the file", () => {
    const dir = fixture({ "src/a.js": "export const a = ;\n", "src/k.js": "const k = 'AKIAABCDEFGHIJKLMNOP';\n" });
    const g = fastGates(dir, ["src/a.js", "src/k.js"]);
    expect(g.ok).toBe(false);
    expect(g.results.map((r) => r.gate)).toEqual(["syntax"]);
    expect(g.messages).toContain("src/a.js");
  });

  it("fails on a secret with file:line", () => {
    const dir = fixture({ "src/k.js": "// ok\nexport const k = 'AKIAABCDEFGHIJKLMNOP';\n" });
    const g = fastGates(dir, ["src/k.js"]);
    expect(g.ok).toBe(false);
    expect(g.results.at(-1)!.gate).toBe("secrets");
    expect(g.messages).toContain("src/k.js:2");
  });
});
