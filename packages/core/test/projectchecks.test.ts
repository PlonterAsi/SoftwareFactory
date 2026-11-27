import { describe, expect, it } from "vitest";
import { findChecks } from "../src/fence/projectchecks.js";

const tree = (files: Record<string, string>) => findChecks(Object.keys(files), (p) => files[p] ?? null);

describe("the project tells its own checks", () => {
  it("finds RoadToMill's: the web build first, then Go's vet and build", () => {
    const r = tree({ "web/package.json": JSON.stringify({ scripts: { dev: "vite", build: "tsc -b && vite build" } }), "web/package-lock.json": "{}", "backend/go.mod": "module x", "backend/main.go": "", "README.md": "" });
    expect(r.prepare).toEqual(["npm ci --prefix web", "go -C backend mod download"]);
    expect(r.checks).toEqual(["npm run build --prefix web", "go -C backend vet ./...", "go -C backend build ./..."]);
    expect(r.found).toEqual(["web/package.json: build", "backend/go.mod: vet and build"]);
  });
  it("lets the top folder speak for its workspaces, type check before build", () => {
    const r = tree({ "package.json": JSON.stringify({ workspaces: ["packages/*"], scripts: { build: "x", typecheck: "y", test: "z" } }), "package-lock.json": "{}", "apps/package.json": JSON.stringify({ scripts: { build: "x" } }) });
    expect(r.prepare).toEqual(["npm ci"]);
    expect(r.checks).toEqual(["npm run typecheck", "npm run build"]);
  });
  it("takes no tests, and nothing from a project without a build", () => {
    expect(tree({ "package.json": JSON.stringify({ scripts: { test: "vitest" } }), "package-lock.json": "{}" })).toEqual({ prepare: [], checks: [], found: [] });
  });
  it("installs without a lock file when there is none", () => {
    expect(tree({ "package.json": JSON.stringify({ scripts: { build: "x" } }) }).prepare).toEqual(["npm install --no-audit --no-fund"]);
  });
  it("says so when a folder needs pnpm or yarn", () => {
    const r = tree({ "ui/package.json": JSON.stringify({ scripts: { build: "x" } }), "ui/pnpm-lock.yaml": "" });
    expect(r.checks).toEqual([]);
    expect(r.found[0]).toMatch(/pnpm or yarn/);
  });
  it("never puts a strange folder name into a command", () => {
    const r = tree({ "a b; rm -rf ~/package.json": JSON.stringify({ scripts: { build: "x" } }), "$(x)/go.mod": "", "node_modules/go.mod": "", "ok/go.mod": "" });
    expect(r.checks).toEqual(["go -C ok vet ./...", "go -C ok build ./..."]);
  });
  it("survives a package file that is not JSON", () => {
    expect(tree({ "package.json": "{nope" }).checks).toEqual([]);
  });
});
