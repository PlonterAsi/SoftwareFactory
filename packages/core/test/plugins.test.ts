import { afterEach, describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AgentBay, EventLog, Factory, MockRuntime, PluginHost, readManifest, ManifestError, matchesType, eventInProject, createCore, projectOf, projectDetail,
  EXAMPLES_DIR, Integrations,
} from "../src/index.js";

const tmp = (p = "sf-plugins-") => mkdtempSync(join(tmpdir(), p));
const hosts: PluginHost[] = [];
afterEach(() => { for (const h of hosts.splice(0)) h.stopAll(); });

function plugin(files: Record<string, string>, manifest: Record<string, unknown>): string {
  const dir = tmp("sf-plugin-src-");
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

function host(log = new EventLog(":memory:"), bay?: AgentBay) {
  const h = new PluginHost(log, join(tmp(), "plugins"), { bay });
  hosts.push(h);
  return { log, h };
}

const until = async (f: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (f()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return f();
};

describe("plugin manifests", () => {
  it("reads a good one and fills defaults", () => {
    const dir = plugin({ "ui/index.html": "<h1>x</h1>", "main.mjs": "" }, { id: "hello", name: "Hello", permissions: ["events:read"], main: "main.mjs", subscribe: ["factory.*"], panels: [{ id: "tab", entry: "ui/index.html" }] });
    const m = readManifest(dir);
    expect(m).toMatchObject({ id: "hello", name: "Hello", main: "main.mjs", subscribe: ["factory.*"], agents: [] });
    expect(m.panels[0]).toMatchObject({ id: "tab", where: "project", order: 85, entry: "ui/index.html" });
  });

  it("refuses bad ids, unknown permissions, paths that leave the folder, and asks it cannot use", () => {
    const bad = (manifest: Record<string, unknown>, files: Record<string, string> = { "main.mjs": "" }) => () => readManifest(plugin(files, manifest));
    expect(bad({ id: "Bad Id", main: "main.mjs" })).toThrow(ManifestError);
    expect(bad({ id: "ok", main: "main.mjs", permissions: ["root"] })).toThrow(/Unknown permission root/);
    expect(bad({ id: "ok", main: "../main.mjs" })).toThrow(/leaves the plugin folder/);
    expect(bad({ id: "ok", main: "main.mjs", subscribe: ["factory.*"] })).toThrow(/events:read/);
    expect(bad({ id: "ok", agents: ["a.md"] }, { "a.md": "" })).toThrow(/agents permission/);
    expect(bad({ id: "ok" })).toThrow(/adds nothing/);
    expect(() => readManifest(tmp())).toThrow(/No plugin.json/);
  });

  it("matches event patterns", () => {
    expect(matchesType("factory.run.*", "factory.run.finished")).toBe(true);
    expect(matchesType("factory.run.*", "factory.station")).toBe(false);
    expect(matchesType("*", "anything")).toBe(true);
    expect(matchesType("order.node", "order.node")).toBe(true);
  });

  it("the three game demos are page-only plugins that ask for nothing and load nothing from outside", () => {
    for (const id of ["game-dock", "game-sector", "game-workshop"]) {
      const m = readManifest(join(EXAMPLES_DIR, id));
      expect(m).toMatchObject({ id, permissions: [], main: null, agents: [] });
      expect(m.panels).toEqual([expect.objectContaining({ where: "page", entry: "ui/index.html" })]);
      const html = readFileSync(join(EXAMPLES_DIR, id, "ui/index.html"), "utf8");
      expect(html).not.toMatch(/<(script|link|img)[^>]+(src|href)="https?:/i);
      expect(html).toMatch(/nothing is written to SoftwareFactory/i);
    }
  });

  it("the bundled example is a valid plugin", () => {
    const m = readManifest(join(EXAMPLES_DIR, "run-stats"));
    expect(m).toMatchObject({ id: "run-stats", main: "main.mjs", agents: ["agents/run-critic.md"] });
    expect(m.panels.map((p) => p.where)).toEqual(["project"]);
  });
});

describe("the plugin host", () => {
  it("installs a copy that starts off, and the one approval turns it on", () => {
    const { h } = host();
    const src = plugin({ "ui/index.html": "<h1>x</h1>" }, { id: "tabby", panels: [{ id: "t", entry: "ui/index.html" }] });
    const v = h.install(src);
    expect(v).toMatchObject({ id: "tabby", status: "installed", granted: [], running: null });
    expect(v.dir).toBe(join(h.root, "tabby"));
    expect(existsSync(join(v.dir, "ui/index.html"))).toBe(true);
    expect(h.file("tabby", "ui/index.html")).toBeNull(); // not served while off
    expect(h.enable("tabby").status).toBe("enabled");
    expect(h.file("tabby", "ui/index.html")).toBe(join(v.dir, "ui/index.html"));
    expect(h.file("tabby", "../../etc/passwd")).toBeNull();
    expect(h.file("tabby", "%2e%2e/%2e%2e/x")).toBeNull();
    expect(h.disable("tabby").status).toBe("disabled");
    h.remove("tabby");
    expect(h.get("tabby")).toBeNull();
    expect(existsSync(v.dir)).toBe(false);
  });

  it("runs a backend: events in, data and timeline entries out, calls answered", async () => {
    const { log, h } = host();
    const src = plugin({
      "main.mjs": `
        sf.on("factory.run.*", (e) => { const n = (sf.data.get("n") ?? 0) + 1; sf.data.set("n", n); sf.emit("counted", { n, type: e.type }); });
        sf.handle("count", () => sf.data.get("n") ?? 0);
        sf.handle("boom", () => { throw new Error("nope"); });
        console.log("up");`,
    }, { id: "counter", main: "main.mjs", permissions: ["events:read", "events:write"], subscribe: ["factory.run.*"] });
    h.install(src);
    h.enable("counter");
    expect(await h.whenReady("counter")).toBe(true);
    log.append("factory.run.started", { idea: "x" });
    log.append("factory.station", { run: 1 }); // not subscribed
    log.append("factory.run.finished", { run: 1, outcome: "shipped" });
    expect(await until(() => h.data("counter").n === 2)).toBe(true);
    expect(await h.call("counter", "count")).toBe(2);
    await expect(h.call("counter", "boom")).rejects.toThrow("nope");
    await expect(h.call("counter", "missing")).rejects.toThrow(/no method/);
    const emitted = log.list({ type: "plugin.emitted" }).map((e) => e.payload as any);
    expect(emitted.map((p) => p.payload.n)).toEqual([1, 2]);
    expect(h.logOf("counter").some((l) => l.text === "up")).toBe(true);
    // The data survives a restart of the backend.
    h.stop("counter");
    h.start("counter");
    expect(await h.call("counter", "count")).toBe(2);
  });

  it("locks the backend in: no reading other files, no starting programs, no emitting without permission", async () => {
    const { log, h } = host();
    const secret = join(tmp(), "secret.txt");
    writeFileSync(secret, "top secret");
    const src = plugin({
      "main.mjs": `
        import { readFileSync } from "node:fs";
        import { execSync } from "node:child_process";
        sf.handle("read", () => { try { return readFileSync(${JSON.stringify(secret)}, "utf8"); } catch (e) { return "denied:" + e.code; } });
        sf.handle("spawn", () => { try { return String(execSync("echo hi")); } catch (e) { return "denied:" + e.code; } });
        sf.handle("own", () => readFileSync(new URL("./plugin.json", import.meta.url), "utf8").length > 0);
        sf.handle("env", () => Object.keys(process.env).filter((k) => /KEY|TOKEN|SECRET/i.test(k)));
        sf.handle("emit", () => { sf.emit("sneaky", {}); return true; });`,
    }, { id: "jail", main: "main.mjs" });
    process.env.SF_TEST_API_KEY = "sk-should-not-leak";
    h.install(src);
    h.enable("jail");
    expect(await h.call("jail", "read")).toBe("denied:ERR_ACCESS_DENIED");
    expect(await h.call("jail", "spawn")).toBe("denied:ERR_ACCESS_DENIED");
    expect(await h.call("jail", "own")).toBe(true);
    expect(await h.call("jail", "env")).toEqual([]);
    delete process.env.SF_TEST_API_KEY;
    await h.call("jail", "emit");
    expect(await until(() => h.logOf("jail").some((l) => /refused/.test(l.text)))).toBe(true);
    expect(log.list({ type: "plugin.emitted" })).toHaveLength(0);
    expect(() => h.events("jail")).toThrow(/events:read/);
  });

  it("turns a plugin off after three crashes and says why", async () => {
    const { h } = host();
    const src = plugin({ "main.mjs": `throw new Error("broken on purpose");` }, { id: "crashy", main: "main.mjs" });
    h.install(src);
    h.enable("crashy");
    expect(await until(() => h.get("crashy")!.status === "disabled", 15_000)).toBe(true);
    const v = h.get("crashy")!;
    expect(v.crashes).toBe(3);
    expect(v.error).toMatch(/Stopped after 3 crashes/);
    expect(h.logOf("crashy").some((l) => /broken on purpose/.test(l.text))).toBe(true);
    // Turning it on again starts afresh.
    expect(h.enable("crashy").crashes).toBe(0);
    h.disable("crashy");
  }, 20_000);

  it("a reinstall keeps it on unless it asks for more", () => {
    const { h } = host();
    const src = plugin({ "ui/a.html": "a" }, { id: "grow", version: "1.0.0", panels: [{ id: "a", entry: "ui/a.html" }] });
    h.install(src);
    h.enable("grow");
    writeFileSync(join(src, "plugin.json"), JSON.stringify({ id: "grow", version: "1.1.0", panels: [{ id: "a", entry: "ui/a.html" }] }));
    expect(h.install(src)).toMatchObject({ version: "1.1.0", status: "enabled" });
    writeFileSync(join(src, "plugin.json"), JSON.stringify({ id: "grow", version: "2.0.0", permissions: ["events:read"], panels: [{ id: "a", entry: "ui/a.html" }] }));
    expect(h.install(src)).toMatchObject({ version: "2.0.0", status: "installed", granted: [] });
  });

  it("adds its agents to the Agent Bay while on and retires them when off", () => {
    const log = new EventLog(":memory:");
    const bay = new AgentBay(log);
    const { h } = host(log, bay);
    h.install(join(EXAMPLES_DIR, "run-stats"));
    expect(bay.get("run-stats-run-critic")).toBeUndefined();
    h.enable("run-stats");
    expect(bay.get("run-stats-run-critic")).toMatchObject({ retired: false, def: { name: "Run critic", station: "review" } });
    h.disable("run-stats");
    expect(bay.get("run-stats-run-critic")?.retired).toBe(true);
    h.enable("run-stats");
    expect(bay.get("run-stats-run-critic")?.retired).toBe(false);
    h.stopAll();
  });

  it("reads one project's events for a panel", async () => {
    const data = tmp();
    const log = new EventLog(join(data, "factory.db"));
    const f = new Factory(log, new MockRuntime({ delayMs: 0 }), join(data, "projects"));
    const run = f.start("a CLI that counts words", { autoApprove: true });
    await f.wait(run);
    const other = f.start("another thing", { autoApprove: true });
    await f.wait(other);
    const pid = projectOf(log, { kind: "factory_run", ref: run })!;
    const { h } = host(log);
    h.install(plugin({ "ui/a.html": "a" }, { id: "reader", permissions: ["events:read"], panels: [{ id: "a", entry: "ui/a.html" }] }));
    h.enable("reader");
    const evs = h.events("reader", { projectId: pid, types: ["factory.run.*"] });
    expect(evs.map((e) => e.type)).toEqual(["factory.run.started", "factory.run.finished"]);
    expect(evs.every((e) => eventInProject(e, projectDetail(log, pid)!))).toBe(true);
    expect(h.events("reader", { types: ["factory.run.started"] })).toHaveLength(2);
  });
});

describe("plugins through the core", () => {
  it("installs the example over the API, serves its page and the helper, answers calls, and keeps sandboxed pages off the API", async () => {
    const data = tmp();
    const log = new EventLog(join(data, "factory.db"));
    const core = createCore({ log, runtime: new MockRuntime({ delayMs: 0 }), projectsDir: join(data, "projects") });
    hosts.push(core.plugins);
    const server = createServer(core);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, body: unknown = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      let list = await (await fetch(`${base}/api/plugins`)).json();
      expect(list.examples.find((x: any) => x.id === "run-stats")).toMatchObject({ installed: false });
      expect(list.permissions["events:read"]).toMatch(/See what happens/);
      expect((await post("/api/plugins/install", { example: "run-stats" })).status).toBe(201);
      expect((await fetch(`${base}/plugins/run-stats/ui/index.html`)).status).toBe(404); // off
      expect((await post("/api/plugins/run-stats/enable")).status).toBe(200);
      const page = await fetch(`${base}/plugins/run-stats/ui/index.html`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toMatch(/connect-src 'none'/);
      expect(await page.text()).toContain("/plugins/_sdk/sf.js");
      expect((await fetch(`${base}/plugins/run-stats/main.mjs`)).status).toBe(404); // the backend's code is not served
      expect(await (await fetch(`${base}/plugins/_sdk/sf.js`)).text()).toContain("window.sf");
      const r = await (await post("/api/plugins/run-stats/call", { method: "totals" })).json();
      expect(r.value).toEqual({ shipped: 0, failed: 0, other: 0 });
      const blocked = await fetch(`${base}/api/plugins`, { headers: { origin: "null" } });
      expect(blocked.status).toBe(403);
      list = await (await fetch(`${base}/api/plugins`)).json();
      expect(list.plugins[0]).toMatchObject({ id: "run-stats", status: "enabled", running: true });
      expect((await post("/api/plugins/run-stats/remove")).status).toBe(200);
      expect((await (await fetch(`${base}/api/plugins`)).json()).plugins).toEqual([]);
    } finally {
      server.close();
    }
  });

  it("a finished project with a plugin.json can be added from the Integrate tab: one approval installs and turns it on", async () => {
    const data = tmp();
    const log = new EventLog(join(data, "factory.db"));
    const f = new Factory(log, new MockRuntime({ delayMs: 0 }), join(data, "projects"));
    const run = f.start("a CLI that counts words", { autoApprove: true });
    await f.wait(run);
    const pid = projectOf(log, { kind: "factory_run", ref: run })!;
    // The project the factory shipped is a plugin.
    const src = plugin({ "ui/index.html": "<h1>hi</h1>" }, { id: "from-project", name: "From project", panels: [{ id: "t", entry: "ui/index.html" }] });
    const r2 = log.append("factory.run.started", { idea: "plugin", projectId: pid }).id;
    log.append("factory.tests", { run: r2, round: 1, cases: [{ name: "ok", pass: true }], passed: 1, failed: 0 });
    log.append("factory.run.finished", { run: r2, outcome: "shipped", reason: "test", dir: src, sha: null });
    const { h } = host(log);
    const ig = new Integrations(log, join(data, "extensions"), h);
    const a = ig.assess(pid)!;
    expect(a.recommended).toBe("plugin");
    expect(a.forms.find((x) => x.form === "plugin")).toMatchObject({ available: true, entry: "from-project" });
    const req = ig.request(pid, "plugin");
    expect(req.status).toBe("awaiting");
    expect(ig.decide(req.id, true).status).toBe("installed");
    expect(h.get("from-project")).toMatchObject({ status: "enabled" });
    ig.remove(req.id);
    expect(h.get("from-project")).toBeNull();
  });
});
