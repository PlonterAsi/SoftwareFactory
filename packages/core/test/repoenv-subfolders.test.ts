import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { backendFor, parseCases, prepareEnv, subPackages } from "../src/factory/repoenv.js";
import { modelPrice } from "../src/agents.js";

// A repo shaped like RoadToMill: a Go module in backend/, a React app in web/, nothing at the root.
function goAndWebRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-subs-"));
  mkdirSync(join(dir, "backend"));
  writeFileSync(join(dir, "backend", "go.mod"), "module example.com/x\n\ngo 1.22\n");
  mkdirSync(join(dir, "web"));
  writeFileSync(join(dir, "web", "package.json"), JSON.stringify({ name: "web", scripts: { dev: "vite", build: "tsc -b && vite build" } }));
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "README.md"), "# x\n");
  return dir;
}

describe("repos with their code in subfolders", () => {
  it("finds a Go module and a Node package one folder down", () => {
    expect(subPackages(goAndWebRepo())).toEqual({ go: ["backend"], node: ["web"] });
  });

  it("checks the web app by its build when it has no tests, in its own folder", async () => {
    const env = await prepareEnv(goAndWebRepo(), { install: false });
    expect(env.stack).toContain("node");
    const web = env.tests.find((t) => t.cwd === "web");
    expect(web).toMatchObject({ label: "npm run build (web)", args: ["run", "build"], kind: "check" });
    expect(env.testHint).toContain("npm run build (in web/)");
  });

  it("reads go test -v output: passing, failing and skipped tests, with a skip's reason", () => {
    const out = [
      "=== RUN   TestOk", "--- PASS: TestOk (0.00s)",
      "=== RUN   TestNeedsDb", "    gig_test.go:16: TEST_DATABASE_URL not set", "--- SKIP: TestNeedsDb (0.00s)",
      "=== RUN   TestOther", "--- SKIP: TestOther (0.00s)",
      "--- FAIL: TestRoundTrip (0.00s)", "FAIL\texample.com/x/b\t0.30s", "ok  \texample.com/x/a\t0.12s",
    ].join("\n");
    const cases = parseCases(out, "go");
    expect(cases.map((c) => [c.name, c.pass, c.skipped ?? null])).toEqual([
      ["TestOk", true, null], ["TestNeedsDb", true, "TEST_DATABASE_URL not set"], ["TestOther", true, "skipped"],
      ["TestRoundTrip", false, null], ["example.com/x/b (package)", false, null],
    ]);
    expect(parseCases("anything at all", "check")).toEqual([]);
  });
});

describe("model prices for cap lifts", () => {
  it("ranks Fable above Opus above Sonnet above Haiku", () => {
    expect(modelPrice("fable")).toBeGreaterThan(modelPrice("claude-opus-5-5"));
    expect(modelPrice("opus")).toBeGreaterThan(modelPrice("sonnet"));
    expect(modelPrice("sonnet")).toBeGreaterThan(modelPrice("haiku"));
  });
});

describe("a front end that proxies to its backend", () => {
  it("finds the Go program that listens on the port the dev server proxies to", () => {
    const dir = goAndWebRepo();
    writeFileSync(join(dir, "web", "vite.config.ts"), "export default { server: { proxy: { '/api': 'http://127.0.0.1:8787' } } }");
    mkdirSync(join(dir, "backend", "cmd", "hosted"), { recursive: true });
    writeFileSync(join(dir, "backend", "cmd", "hosted", "main.go"), 'package main; const addr = ":8080"');
    mkdirSync(join(dir, "backend", "cmd", "local"), { recursive: true });
    writeFileSync(join(dir, "backend", "cmd", "local", "main.go"), 'package main; const addr = "127.0.0.1:8787"');
    expect(backendFor(dir, { cwd: "web" })).toEqual({ port: 8787, cwd: "backend", file: "go", args: ["run", "./cmd/local"], label: "go run ./cmd/local (in backend)", addrFlag: false });
    expect(backendFor(dir, {})).toBeNull();
  });
});
