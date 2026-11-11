import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  EventLog, Factory, MockRuntime, createCore, createProject, Integrations, assessProject, detectForms, splitArgs, listIntegrations, installedFeatures,
  projectDetail, projectOf,
} from "../src/index.js";

const tmp = (p = "sf-integrate-") => mkdtempSync(join(tmpdir(), p));

/** A database with one project the factory shipped (the practice crew builds a small CLI). */
async function shipped() {
  const data = tmp();
  const log = new EventLog(join(data, "factory.db"));
  const f = new Factory(log, new MockRuntime({ delayMs: 0 }), join(data, "projects"));
  const run = f.start("a CLI that counts words", { autoApprove: true });
  await f.wait(run);
  const projectId = projectOf(log, { kind: "factory_run", ref: run })!;
  return { data, log, run, projectId, integrations: new Integrations(log, join(data, "extensions")) };
}

/** Pretend a run in this project shipped the given folder (its tests passing). */
function shipFolder(log: EventLog, projectId: number, dir: string) {
  const run = log.append("factory.run.started", { idea: "folder", projectId }).id;
  log.append("factory.tests", { run, round: 1, cases: [{ name: "ok", pass: true }], passed: 1, failed: 0 });
  log.append("factory.run.finished", { run, outcome: "shipped", reason: "test", dir, sha: null });
  return run;
}

describe("detecting forms", () => {
  it("finds a tool from package.json bin, a panel from index.html, and honours softwarefactory.json", () => {
    const dir = tmp("sf-forms-");
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "Inside Runner", bin: { run: "./bin/run.js" } }));
    writeFileSync(join(dir, "bin/run.js"), "console.log('hi')\n");
    let r = detectForms(dir);
    expect(r.forms.find((f) => f.form === "tool")).toMatchObject({ available: true, entry: "bin/run.js" });
    expect(r.forms.find((f) => f.form === "panel")?.available).toBe(false);
    expect(r.forms.find((f) => f.form === "source")?.available).toBe(true);
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist/index.html"), "<h1>hi</h1>");
    r = detectForms(dir);
    expect(r.forms.find((f) => f.form === "panel")).toMatchObject({ available: true, entry: "dist" });
    writeFileSync(join(dir, "softwarefactory.json"), JSON.stringify({ form: "panel", title: "Runner", web: "dist" }));
    expect(detectForms(dir).manifest?.title).toBe("Runner");
  });

  it("splits an arguments line like a shell, quotes included", () => {
    expect(splitArgs(`count "my file.txt" --top 3 ''`)).toEqual(["count", "my file.txt", "--top", "3", ""]);
    expect(splitArgs("   ")).toEqual([]);
  });
});

describe("integrations", () => {
  it("says a project with nothing finished is not ready, and refuses to add it", () => {
    const log = new EventLog(":memory:");
    const id = createProject(log, { name: "Idea only" });
    const a = assessProject(log, id)!;
    expect(a.ready).toBe(false);
    expect(a.checks[0]).toMatchObject({ id: "finished", state: "fail" });
    expect(() => new Integrations(log, tmp()).request(id, "tool")).toThrow(/nothing finished/);
  });

  it("adds a shipped CLI as a tool after approval, runs it from the frozen copy, and removes it", async () => {
    const { log, projectId, integrations, data } = await shipped();
    const a = integrations.assess(projectId)!;
    expect(a.ready).toBe(true);
    expect(a.checks.find((c) => c.id === "tests")?.state).toBe("pass");
    const tool = a.forms.find((f) => f.form === "tool")!;
    expect(tool.available).toBe(true);

    // The gate: nothing is installed until you approve.
    const req = integrations.request(projectId, "tool");
    expect(req.status).toBe("awaiting");
    expect(installedFeatures(log)).toEqual([]);
    expect(integrations.request(projectId, "tool").id).toBe(req.id); // asking twice keeps one request
    const done = integrations.decide(req.id, true);
    expect(done.status).toBe("installed");
    expect(done.dir!.startsWith(join(data, "extensions"))).toBe(true);
    expect(existsSync(join(done.dir!, tool.entry!))).toBe(true);
    expect(existsSync(join(done.dir!, ".git"))).toBe(false);

    // It runs from the copy, not the project folder.
    const out = await integrations.runTool(req.id, "--help");
    expect(out.timedOut).toBe(false);
    expect(typeof out.exitCode).toBe("number");
    expect(listIntegrations(log)[0].uses).toBe(1);

    // The project's detail knows it lives inside SoftwareFactory now.
    expect(projectDetail(log, projectId)!.facets.integration).toMatchObject({ installed: [{ id: req.id, form: "tool" }] });

    integrations.remove(req.id);
    expect(installedFeatures(log)).toEqual([]);
    expect(existsSync(done.dir!)).toBe(false);
  });

  it("an update of an approved feature goes through on its own and replaces the old copy", async () => {
    const { log, projectId, integrations } = await shipped();
    const first = integrations.decide(integrations.request(projectId, "tool").id, true);
    const second = integrations.request(projectId, "tool");
    expect(second.status).toBe("installed");
    expect(second.decidedBy).toBe("auto");
    expect(listIntegrations(log).find((i) => i.id === first.id)?.status).toBe("replaced");
    expect(installedFeatures(log).map((i) => i.id)).toEqual([second.id]);
  });

  it("rejecting closes the request; the source form writes a pull-request brief", async () => {
    const { projectId, integrations } = await shipped();
    const r = integrations.decide(integrations.request(projectId, "tool").id, false, { note: "not yet" });
    expect(r).toMatchObject({ status: "rejected", note: "not yet" });
    const s = integrations.decide(integrations.request(projectId, "source").id, true);
    expect(s.status).toBe("briefed");
    expect(s.brief).toMatch(/pull request, never push to main/);
    expect(s.brief).toMatch(/Tests pass/);
  });

  it("serves an installed panel over HTTP, never outside its folder", async () => {
    const data = tmp();
    const log = new EventLog(join(data, "factory.db"));
    const projectId = createProject(log, { name: "Dashboard" });
    const src = tmp("sf-panel-");
    writeFileSync(join(src, "index.html"), "<!doctype html><title>Dash</title><script src='app.js'></script>");
    writeFileSync(join(src, "app.js"), "document.title = 'ok'");
    writeFileSync(join(data, "secret.txt"), "nope");
    shipFolder(log, projectId, src);
    const core = createCore({ log, runtime: new MockRuntime({ delayMs: 0 }), projectsDir: join(data, "projects") });
    const server = createServer(core).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      const a = await (await fetch(`${base}/api/integrations/assess/${projectId}`)).json();
      expect(a.recommended).toBe("panel");
      const bad = await post("/api/integrations", { projectId, form: "tool" });
      expect(bad.status).toBe(409);
      const req = await (await post("/api/integrations", { projectId, form: "panel" })).json();
      expect(req.status).toBe("awaiting");
      const ok = await (await post(`/api/integrations/${req.id}/decide`, { approve: true })).json();
      expect(ok.status).toBe("installed");
      const page = await fetch(`${base}/ext/${req.id}/`);
      expect(page.headers.get("content-type")).toMatch(/text\/html/);
      expect(await page.text()).toMatch(/<title>Dash/);
      expect((await fetch(`${base}/ext/${req.id}/app.js`)).headers.get("content-type")).toMatch(/javascript/);
      expect((await fetch(`${base}/ext/${req.id}/..%2F..%2Fsecret.txt`)).status).toBe(404);
      expect((await fetch(`${base}/ext/${req.id}`, { redirect: "manual" })).status).toBe(302);
      const list = await (await fetch(`${base}/api/integrations`)).json();
      expect(list.installed.map((i: { id: number }) => i.id)).toEqual([req.id]);
      // Changing the project's own folder later does not touch the installed copy.
      writeFileSync(join(src, "index.html"), "changed");
      expect(await (await fetch(`${base}/ext/${req.id}/`)).text()).toMatch(/<title>Dash/);
      expect(readFileSync(join(ok.dir, "index.html"), "utf8")).toMatch(/Dash/);
    } finally {
      server.close();
    }
  });
});
