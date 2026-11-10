import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  EventLog, MockRuntime, AgentBay, RepoExplorer, scanRepo, normalizeSource, codeMapSummary, importOf, suggestionsOf, moduleNotes, createCore,
  projectOf, estimateUsd, verify,
} from "../src/index.js";

const tmp = (p = "sf-import-") => mkdtempSync(join(tmpdir(), p));
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A small repo with two modules that depend on each other, a test, a committed .env and no CI. */
function fixtureRepo(): string {
  const dir = tmp("sf-fixture-");
  const put = (p: string, text: string) => { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), text); };
  put("package.json", JSON.stringify({ name: "shop", scripts: { test: "node --test", start: "node src/server/main.js" }, dependencies: { express: "^4" } }));
  put("README.md", "# Shop\n");
  put(".env", "API_KEY=abc\n");
  put("src/cart/index.js", "import { price } from '../pricing/price.js';\nexport function total(items) { return items.reduce((s, i) => s + price(i), 0); }\n// TODO: discounts\n");
  put("src/pricing/price.js", "export function price(item) { return item.cents * (item.qty ?? 1); }\nexport const CURRENCY = 'EUR';\n");
  put("src/server/main.js", "import express from 'express';\nimport { total } from '../cart/index.js';\nconst app = express();\napp.listen(3000);\n");
  put("test/cart.test.js", "import { test } from 'node:test';\nimport { total } from '../src/cart/index.js';\ntest('total', () => {});\n");
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return dir;
}
const commit = (dir: string, msg: string) => { git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"); git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", msg); };

describe("repo scan", () => {
  it("maps modules, dependencies, entry points, tests and health without any agent", () => {
    const dir = fixtureRepo();
    const map = scanRepo(dir);
    expect(map.head).toMatch(/^[0-9a-f]{40}$/);
    expect(map.branch).toBe("main");
    expect(map.modules.map((m) => m.id).sort()).toEqual(["(root)", "src/cart", "src/pricing", "src/server", "test"]);
    const edges = map.edges.map((e) => `${e.from}>${e.to}`);
    expect(edges).toEqual(expect.arrayContaining(["src/cart>src/pricing", "src/server>src/cart", "test>src/cart"]));
    expect(map.modules.find((m) => m.id === "src/cart")).toMatchObject({ lang: "JavaScript", exports: ["total"], todos: 1, testedBy: true });
    expect(map.modules.find((m) => m.id === "src/pricing")?.exports).toEqual(["price", "CURRENCY"]);
    expect(map.entryPoints.map((e) => e.path)).toEqual(expect.arrayContaining(["package.json", "src/server/main.js"]));
    expect(map.tests).toMatchObject({ files: 1, frameworks: expect.arrayContaining(["node:test"]) });
    expect(map.tests.command).toMatch(/^npm test/);
    expect(map.dependencies).toEqual([{ manifest: "package.json", name: "express", dev: false }]);
    const flags = map.health.flags.map((f) => f.id);
    expect(flags).toEqual(expect.arrayContaining(["secret-files", "no-ci", "no-lockfile"]));
    expect(flags).not.toContain("no-tests");
    expect(map.health.score).toBeLessThan(100);
  });

  it("gives every module a content hash that changes only with its own files", () => {
    const dir = fixtureRepo();
    const a = scanRepo(dir);
    writeFileSync(join(dir, "src/pricing/price.js"), "export function price(item) { return item.cents; }\n");
    const b = scanRepo(dir);
    const h = (m: typeof a, id: string) => m.modules.find((x) => x.id === id)!.hash;
    expect(h(b, "src/pricing")).not.toBe(h(a, "src/pricing"));
    expect(h(b, "src/cart")).toBe(h(a, "src/cart"));
  });

  it("reads plain folders that are not git repos, skipping dependencies and build output", () => {
    const dir = tmp();
    mkdirSync(join(dir, "node_modules/x"), { recursive: true });
    writeFileSync(join(dir, "node_modules/x/index.js"), "x");
    mkdirSync(join(dir, "app"));
    writeFileSync(join(dir, "app/main.py"), "from app import util\ndef run():\n    pass\n");
    writeFileSync(join(dir, "app/util.py"), "def helper():\n    return 1\n");
    const map = scanRepo(dir);
    expect(map.head).toBeNull();
    expect(map.files).toBe(2);
    expect(map.modules[0]).toMatchObject({ id: "app", lang: "Python", exports: expect.arrayContaining(["run", "helper"]) });
    expect(map.health.flags.map((f) => f.id)).toContain("no-tests");
  });
});

describe("source parsing", () => {
  it("accepts URLs, owner/name and folders, and refuses credentials in URLs", () => {
    expect(normalizeSource("PlonterAsi/SoftwareFactory")).toMatchObject({ local: false, ref: "https://github.com/PlonterAsi/SoftwareFactory", name: "SoftwareFactory" });
    expect(normalizeSource("https://github.com/a/b.git/")).toMatchObject({ ref: "https://github.com/a/b", url: "https://github.com/a/b.git" });
    expect(normalizeSource("git@github.com:a/b.git")).toMatchObject({ local: false, name: "b" });
    expect(normalizeSource("C:\\Dev\\PlonterApp")).toMatchObject({ local: true, name: expect.stringMatching(/PlonterApp$/) });
    expect(() => normalizeSource("https://user:token@github.com/a/b")).toThrow(/token/);
    expect(() => normalizeSource("not a repo")).toThrow();
  });
});

describe("importing and exploring", () => {
  it("imports a local folder as a project, maps it for free on the practice crew, and never writes to it", async () => {
    const dir = fixtureRepo();
    const log = new EventLog();
    const ex = new RepoExplorer(log, new MockRuntime({ delayMs: 0 }), join(tmp(), "imports"));
    const { projectId, done } = ex.importRepo(dir);
    const r = await done;
    expect(r).toMatchObject({ outcome: "done", spentUsd: 0, mapped: 0 });
    expect(log.db.prepare("SELECT name, kind FROM projects WHERE id = ?").get(projectId)).toEqual({ name: expect.stringMatching(/^sf-fixture-/), kind: "imported" });
    expect(projectOf(log, { kind: "repo", ref: dir })).toBe(projectId);
    expect(importOf(log, projectId)).toMatchObject({ local: true, dir, status: "ready", branch: "main", explores: 1 });
    expect([...moduleNotes(log, projectId).values()].every((n) => n.by === "heuristic")).toBe(true);
    const s = suggestionsOf(log, projectId);
    expect(s[0]).toMatchObject({ severity: "critical", lens: "security", files: [".env"], status: "pending" });
    expect(s.map((x) => x.title)).toEqual(expect.arrayContaining(["Run the tests in CI on every push"]));
    // Every station reported, and the visual check passed.
    const stations = log.list({ type: "repo.explore.station" }).map((e) => `${(e.payload as any).station}:${(e.payload as any).state}`);
    expect(stations).toEqual(expect.arrayContaining(["fetch:skipped", "scan:pass", "map:pass", "survey:pass", "visual:pass"]));
    // Read-only: the folder is exactly as it was.
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(codeMapSummary(log, projectId)).toMatch(/Health \d+\/100/);
  });

  it("explores again for nothing when nothing changed, and only re-maps changed modules", async () => {
    const dir = fixtureRepo();
    const log = new EventLog();
    const rt = new MockRuntime({ delayMs: 0 });
    const bay = new AgentBay(log, rt);
    const ex = new RepoExplorer(log, rt, join(tmp(), "imports"), bay, { mode: "agent" });
    const { projectId, done } = ex.importRepo(dir);
    const first = await done;
    expect(first.outcome).toBe("done");
    expect(first.mapped).toBe(4);
    const notes = moduleNotes(log, projectId);
    expect(notes.get("src/cart")).toMatchObject({ by: "cartographer", purpose: "Mock purpose of src/cart." });
    expect(suggestionsOf(log, projectId).some((x) => x.by === "surveyor")).toBe(true);
    // The critical free finding is kept even when the Surveyor answers.
    expect(suggestionsOf(log, projectId).some((x) => x.lens === "security" && x.by === "heuristic")).toBe(true);
    const calls = rt.calls.length;

    const again = await ex.explore(projectId);
    expect(again).toMatchObject({ outcome: "cached", spentUsd: 0, mapped: 0, reused: 4 });
    expect(rt.calls.length).toBe(calls);

    writeFileSync(join(dir, "src/pricing/price.js"), "export function price(item) { return item.cents; }\n");
    commit(dir, "change pricing");
    const third = await ex.explore(projectId);
    expect(third).toMatchObject({ outcome: "done", mapped: 1, reused: 3 });
    // Survey ran again, but the same advice is not filed twice.
    const titles = suggestionsOf(log, projectId).map((x) => x.title);
    expect(new Set(titles).size).toBe(titles.length);
    expect(importOf(log, projectId)?.explores).toBe(3);
  });

  it("stays inside the cap: estimates first and maps the biggest modules it can afford", async () => {
    const dir = fixtureRepo();
    const log = new EventLog();
    const rt = new MockRuntime({ delayMs: 0 });
    const ex = new RepoExplorer(log, rt, join(tmp(), "imports"), new AgentBay(log, rt), { mode: "agent" });
    // Enough for one mapping call and the survey, not for everything.
    // Enough for the survey call, not for mapping as well.
    const cap = 0.012;
    expect(estimateUsd(1, 3000)).toBeLessThan(cap);
    const { done } = ex.importRepo(dir, { maxUsd: cap });
    const r = await done;
    expect(r.outcome).toBe("partial");
    const mapStation = log.list({ type: "repo.explore.station" }).map((e) => e.payload as any).find((p) => p.station === "map" && p.state === "active");
    expect(mapStation.estimateUsd).toBeLessThanOrEqual(cap);
    expect(mapStation.fullUsd).toBeGreaterThan(cap);
  });

  it("clones a URL into its own folder and re-importing the same URL re-explores the same project", async () => {
    const origin = fixtureRepo();
    const log = new EventLog();
    const imports = join(tmp(), "imports");
    const ex = new RepoExplorer(log, new MockRuntime({ delayMs: 0 }), imports);
    const url = `file://${origin}`;
    const a = ex.importRepo(url);
    await a.done;
    const row = importOf(log, a.projectId)!;
    expect(row).toMatchObject({ local: false, status: "ready" });
    expect(row.dir.startsWith(imports)).toBe(true);
    expect(git(row.dir, "rev-parse", "HEAD")).toBe(git(origin, "rev-parse", "HEAD"));
    // A new commit upstream is pulled on the next exploration.
    writeFileSync(join(origin, "src/pricing/price.js"), "export const price = (i) => i.cents;\n");
    commit(origin, "upstream change");
    const b = ex.importRepo(url);
    expect(b).toMatchObject({ projectId: a.projectId, existing: true });
    expect((await b.done).mapped + (await b.done).reused).toBeGreaterThan(0);
    expect(importOf(log, a.projectId)!.head).toBe(git(origin, "rev-parse", "HEAD"));
  });

  it("reports a clone that fails with what to do, and the project stays to retry", async () => {
    const log = new EventLog();
    const ex = new RepoExplorer(log, null, join(tmp(), "imports"));
    const r = ex.importRepo(`file://${join(tmp(), "missing")}`);
    const out = await r.done;
    expect(out.outcome).toBe("failed");
    expect(importOf(log, r.projectId)).toMatchObject({ status: "failed" });
  });

  it("mirrors the Council's decisions on its suggestions", async () => {
    const log = new EventLog();
    const ex = new RepoExplorer(log, null, join(tmp(), "imports"));
    const { projectId, done } = ex.importRepo(fixtureRepo());
    await done;
    const [s1, s2] = suggestionsOf(log, projectId);
    const p1 = log.append("improve.proposal", { title: s1.title, source: { kind: "repo.suggestion", eventId: s1.eventId, suggestionId: s1.id } });
    log.append("improve.proposal", { title: s2.title, source: { kind: "repo.suggestion", eventId: s2.eventId, suggestionId: s2.id } });
    log.append("improve.proposal.decided", { id: p1.id, decision: "rejected" });
    log.append("improve.proposal.accepted", { source: { kind: "repo.suggestion", suggestionId: s2.id } });
    const after = suggestionsOf(log, projectId);
    expect(after.find((x) => x.id === s1.id)).toMatchObject({ status: "rejected", proposalId: p1.id });
    expect(after.find((x) => x.id === s2.id)?.status).toBe("accepted");
    // Tables rebuild from the log with the same answer.
    log.rebuild("imports");
    expect(suggestionsOf(log, projectId).map((x) => x.status)).toEqual(after.map((x) => x.status));
  });

  it("checks Cartographer and Surveyor answers in the Agent Bay", () => {
    expect(verify("map", '```json\n{"modules":[{"id":"a","purpose":"does a","role":"core","risks":[]}]}\n```').every((c) => c.pass)).toBe(true);
    expect(verify("survey", "no json").every((c) => c.pass)).toBe(false);
  });
});

describe("imports API", () => {
  it("imports over HTTP, shows the map, and adds a code facet to the project", async () => {
    const dir = fixtureRepo();
    const log = new EventLog();
    const data = tmp();
    const core = createCore({ log, runtime: new MockRuntime({ delayMs: 0 }), projectsDir: join(data, "projects") });
    const server = createServer(core).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const r = await fetch(`${base}/api/imports`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: dir }) });
      expect(r.status).toBe(202);
      const { projectId } = await r.json();
      await core.explorer.idle();
      const d = await (await fetch(`${base}/api/imports/${projectId}`)).json();
      expect(d.import.status).toBe("ready");
      expect(d.map.map.modules.length).toBe(5);
      expect(Object.keys(d.notes)).toContain("src/cart");
      expect(d.suggestions.length).toBeGreaterThan(2);
      expect(d.explores.some((e: any) => e.type === "repo.explore.finished")).toBe(true);
      const list = await (await fetch(`${base}/api/imports`)).json();
      expect(list.imports[0]).toMatchObject({ projectId, health: expect.any(Number) });
      const p = await (await fetch(`${base}/api/projects/${projectId}`)).json();
      expect(p.facets.code).toMatchObject({ source: dir, modules: 5, status: "ready" });
      expect(p.rootNodeIds.length).toBe(1);
      const bad = await fetch(`${base}/api/imports`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "nope" }) });
      expect(bad.status).toBe(400);
      const again = await fetch(`${base}/api/imports/${projectId}/explore`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(again.status).toBe(202);
      await core.explorer.idle();
      expect(log.list({ type: "repo.explore.finished" }).map((e) => (e.payload as any).outcome)).toEqual(["done", "cached"]);
    } finally {
      server.close();
    }
  });
});
