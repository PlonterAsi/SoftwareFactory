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
  it("passes a clean folder and skips the tools it does not have", async () => {
    const dir = fixture({ "src/a.js": "export const a = 1;\n" });
    const g = await fastGates(dir, ["src/a.js"]);
    expect(g.ok).toBe(true);
    expect(g.messages).toBe("");
    expect(g.results.map((r) => [r.gate, r.state])).toEqual([["syntax", "pass"], ["tsc", "skipped"], ["lint", "skipped"], ["secrets", "pass"]]);
    expect(g.results.find((r) => r.gate === "tsc")!.note).toMatch(/tsconfig/);
  });

  it("stops at a syntax error and names the file", async () => {
    const dir = fixture({ "src/a.js": "export const a = ;\n", "src/k.js": "const k = 'AKIAABCDEFGHIJKLMNOP';\n" });
    const g = await fastGates(dir, ["src/a.js", "src/k.js"]);
    expect(g.ok).toBe(false);
    expect(g.results.map((r) => r.gate)).toEqual(["syntax"]);
    expect(g.messages).toContain("src/a.js");
  });

  it("fails on a secret with file:line", async () => {
    const dir = fixture({ "src/k.js": "// ok\nexport const k = 'AKIAABCDEFGHIJKLMNOP';\n" });
    const g = await fastGates(dir, ["src/k.js"]);
    expect(g.ok).toBe(false);
    expect(g.results.at(-1)!.gate).toBe("secrets");
    expect(g.messages).toContain("src/k.js:2");
  });
});

describe("the crew's checks never block the core (20 Nov: six minutes of no answer during a tests step)", () => {
  it("runs a slow test script while timers keep firing, and reports what ran", async () => {
    const { defaultRunTests } = await import("../src/tickets/repowork.js");
    const { runAsync } = await import("../src/factory/workspace.js");
    const dir = fixture({
      "package.json": JSON.stringify({ name: "slow", scripts: { test: "node -e \"setTimeout(() => {}, 1200)\"" } }),
      "node_modules/.keep": "",
      "src/a.js": "export const a = 1;\n",
    });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 50);
    const r = await defaultRunTests(dir, ["src/a.js"]);
    clearInterval(timer);
    expect(r).toMatchObject({ ok: true, output: expect.stringMatching(/npm test/) });
    // A blocked event loop would fire no timer at all while the script ran.
    expect(ticks).toBeGreaterThan(10);
    const t = await runAsync(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { cwd: dir, timeout: 300 });
    expect(t).toMatchObject({ status: null, timedOut: true });
  }, 30_000);
});
