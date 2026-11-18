import { afterEach, describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { EventLog, PluginHost, PluginStore, PluginAi, readManifest, ftsQuery, parseGithubSpec, parseGithubSource, type AgentRuntime, type AgentRequest } from "../src/index.js";

/** Add-ons as tools of their own (docs/plugins.md): main menu pages, a searchable catalog, Claude from a monthly budget, install from GitHub. */
const tmp = (p = "sf-addon-") => mkdtempSync(join(tmpdir(), p));
const hosts: PluginHost[] = [];
afterEach(() => { for (const h of hosts.splice(0)) h.stopAll(); });

function folder(files: Record<string, string>, manifest: Record<string, unknown>, dir = tmp("sf-addon-src-")): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
  for (const [rel, text] of Object.entries(files)) { mkdirSync(join(dir, rel, ".."), { recursive: true }); writeFileSync(join(dir, rel), text); }
  return dir;
}

/** A runtime that answers like Claude Code and records what it was asked. */
class FakeClaude implements AgentRuntime {
  readonly name = "claude-code:lean";
  calls: AgentRequest[] = [];
  constructor(private answer = "ok", private cost = 0.1) {}
  async run(req: AgentRequest) { this.calls.push(req); return { text: this.answer, costUsd: this.cost, durationMs: 5, models: ["claude-haiku"], runtime: this.name, contextTokens: 0 }; }
}

describe("add-on manifests", () => {
  it("knows main menu pages and the ai budget, and keeps ai and store for backends", () => {
    const m = readManifest(folder({ "ui/i.html": "x", "main.mjs": "" }, { id: "scout", main: "main.mjs", permissions: ["ai", "store"], budget: { monthlyUsd: 30 }, panels: [{ id: "home", title: "Scout", entry: "ui/i.html", where: "nav" }] }));
    expect(m.panels[0].where).toBe("nav");
    expect(m.budget).toEqual({ monthlyUsd: 30 });
    expect(readManifest(folder({ "main.mjs": "" }, { id: "a1", main: "main.mjs", permissions: ["ai"] })).budget).toEqual({ monthlyUsd: 5 });
    expect(readManifest(folder({ "main.mjs": "" }, { id: "a2", main: "main.mjs", permissions: ["ai"], budget: { monthlyUsd: 900 } })).budget).toEqual({ monthlyUsd: 100 });
    expect(() => readManifest(folder({ "ui/i.html": "x" }, { id: "a3", permissions: ["store"], panels: [{ id: "p", entry: "ui/i.html" }] }))).toThrow(/backend/);
    expect(readManifest(folder({ "main.mjs": "" }, { id: "a4", main: "main.mjs" })).budget).toBeNull();
  });
});

describe("the add-on catalog (store)", () => {
  const st = () => new PluginStore(new EventLog(":memory:").db);

  it("finds documents by any word, stemmed and by prefix, best match first", () => {
    const s = st();
    s.put("scout", "finds", "1", { title: "Claude Code skills pack", score: 4.2, category: "skill" }, "Claude Code skills pack: reusable skills for agents");
    s.put("scout", "finds", "2", { title: "MCP server for Postgres", score: 3.1, category: "mcp" }, "MCP server for Postgres databases");
    s.put("scout", "finds", "3", { title: "Prompt caching tips", score: 4.8, category: "tip" }, "Prompt caching tips to save tokens with Claude");
    s.put("other", "finds", "9", { title: "Claude elsewhere" }, "Claude skill");
    expect(s.query("scout", { coll: "finds", text: "skill" }).items.map((d) => d.id)).toEqual(["1"]);
    expect(s.query("scout", { coll: "finds", text: "postgr" }).items.map((d) => d.id)).toEqual(["2"]);
    expect(s.query("scout", { coll: "finds", text: "claude" }).total).toBe(2);
    expect(s.query("scout", { coll: "finds", text: "claude", sort: "-score" }).items.map((d) => d.id)).toEqual(["3", "1"]);
    expect(s.query("scout", { coll: "finds", text: "claude" }).items[0].snippet).toMatch(/\[/);
    expect(s.query("scout", { coll: "finds", text: "kubernetes" }).total).toBe(0);
    expect(s.query("scout", { coll: "finds", text: "\"; DROP TABLE x; --" }).total).toBe(0);
  });

  it("filters and sorts on fields, updates in place, deletes and clears", () => {
    const s = st();
    for (const [id, score, cat] of [["a", 2, "mcp"], ["b", 4, "skill"], ["c", 5, "mcp"]] as const) s.put("scout", "finds", id, { score, category: cat, starred: id === "c" }, `find ${id}`);
    expect(s.query("scout", { coll: "finds", where: { category: "mcp" }, sort: "-score" }).items.map((d) => d.id)).toEqual(["c", "a"]);
    expect(s.query("scout", { coll: "finds", where: { score: { gte: 4 } } }).total).toBe(2);
    expect(s.query("scout", { coll: "finds", where: { category: { in: ["skill"] } } }).items.map((d) => d.id)).toEqual(["b"]);
    expect(s.query("scout", { coll: "finds", where: { starred: true } }).items.map((d) => d.id)).toEqual(["c"]);
    s.put("scout", "finds", "a", { score: 1, category: "mcp" }, "renamed thing");
    expect(s.count("scout", "finds")).toBe(3);
    expect(s.query("scout", { coll: "finds", text: "renamed" }).items.map((d) => d.id)).toEqual(["a"]);
    expect(s.query("scout", { coll: "finds", text: "find a" }).total).toBe(0);
    expect(s.delete("scout", "finds", "a")).toBe(true);
    expect(s.get("scout", "finds", "a")).toBeNull();
    expect(() => s.query("scout", { coll: "finds", where: { "x') OR 1=1 --": 1 } })).toThrow(/Cannot filter/);
    expect(() => s.put("scout", "Bad Coll", "1", {})).toThrow(/collection/);
    s.clear("scout");
    expect(s.count("scout")).toBe(0);
  });

  it("turns typed words into a safe search", () => {
    expect(ftsQuery("MCP servers")).toBe('"mcp" AND ("servers" OR "servers"*)');
    expect(ftsQuery("  ")).toBeNull();
    expect(ftsQuery('a"b')).not.toContain('""');
  });
});

describe("Claude for add-ons (ai)", () => {
  const view = (granted = ["ai"], budget = 1) => ({ id: "scout", name: "Scout", manifest: readManifest(folder({ "main.mjs": "" }, { id: "scout", main: "main.mjs", permissions: ["ai"], budget: { monthlyUsd: budget } })), granted }) as any;

  it("runs a web-only call, logs it as the add-on's agent run and charges its month", async () => {
    const log = new EventLog(":memory:");
    const rt = new FakeClaude("answer", 0.3);
    const ai = new PluginAi(log, () => rt);
    const a = await ai.run(view(), { prompt: "find X", tools: ["WebSearch", "WebFetch"], model: "sonnet", budgetUsd: 0.5 });
    expect(a).toMatchObject({ text: "answer", costUsd: 0.3, practice: false });
    expect(rt.calls[0]).toMatchObject({ model: "sonnet", tools: ["WebSearch", "WebFetch"], budgetUsd: 0.5 });
    expect(rt.calls[0].cwd).toBeUndefined();
    expect(ai.budget(view())).toMatchObject({ monthlyUsd: 1, spentUsd: 0.3, leftUsd: 0.7, calls: 1, setBy: "manifest" });
    await ai.run(view(), { prompt: "again", budgetUsd: 2 });
    expect(rt.calls[1].budgetUsd).toBe(0.7); // cut to what is left of the month
    expect(log.list({ sinceId: 0, limit: 100 }).filter((e) => e.type === "agent.run.completed").every((e) => (e.payload as any).agent === "plugin:scout")).toBe(true);
  });

  it("refuses other tools, other models, no permission, and an empty month; your budget wins", async () => {
    const log = new EventLog(":memory:");
    const rt = new FakeClaude("x", 0.6);
    const ai = new PluginAi(log, () => rt);
    await expect(ai.run(view(), { prompt: "p", tools: ["Bash"] })).rejects.toThrow(/WebSearch and WebFetch/);
    await expect(ai.run(view(), { prompt: "p", model: "gpt" })).rejects.toThrow(/not one of/);
    await expect(ai.run(view([]), { prompt: "p" })).rejects.toThrow(/ai permission/);
    await ai.run(view(), { prompt: "p" });
    await ai.run(view(), { prompt: "p" });
    await expect(ai.run(view(), { prompt: "p" })).rejects.toThrow(/used up/);
    expect(rt.calls).toHaveLength(2);
    ai.setBudget("scout", 30);
    expect(ai.budget(view())).toMatchObject({ monthlyUsd: 30, setBy: "you" });
    await expect(ai.run(view(), { prompt: "p" })).resolves.toBeTruthy();
  });

  it("costs nothing on the practice crew: the add-on's practice answer comes back", async () => {
    const ai = new PluginAi(new EventLog(":memory:"), () => ({ name: "mock", run: async () => { throw new Error("never"); } }));
    expect(await ai.run(view(), { prompt: "p", practice: "[]" })).toMatchObject({ text: "[]", costUsd: 0, practice: true });
  });
});

describe("an add-on backend asks the core (sf.ai, sf.store)", () => {
  it("keeps and searches its catalog and asks Claude, all through the locked-down process", async () => {
    const log = new EventLog(":memory:");
    const rt = new FakeClaude("hello from claude", 0.01);
    const h = new PluginHost(log, join(tmp(), "plugins"), { store: new PluginStore(log.db), ai: new PluginAi(log, () => rt) });
    hosts.push(h);
    const dir = folder({ "main.mjs": `
      sf.handle("add", async ({ id, title }) => sf.store.put("finds", id, { title }, title));
      sf.handle("search", async ({ q }) => (await sf.store.query({ coll: "finds", text: q })).items.map((d) => d.id));
      sf.handle("ask", async () => (await sf.ai.run({ prompt: "hi", tools: ["WebSearch"] })).text);
      sf.handle("budget", async () => sf.ai.budget());
      sf.handle("bad", async () => sf.ai.run({ prompt: "hi", tools: ["Bash"] }));
    ` }, { id: "scout", main: "main.mjs", permissions: ["ai", "store"], budget: { monthlyUsd: 30 } });
    h.install(dir);
    h.enable("scout");
    expect(await h.whenReady("scout")).toBe(true);
    await h.call("scout", "add", { id: "1", title: "Claude skills for testing" });
    await h.call("scout", "add", { id: "2", title: "Postgres MCP server" });
    expect(await h.call("scout", "search", { q: "skill" })).toEqual(["1"]);
    expect(await h.call("scout", "ask")).toBe("hello from claude");
    expect(await h.call("scout", "budget")).toMatchObject({ monthlyUsd: 30, calls: 1 });
    await expect(h.call("scout", "bad")).rejects.toThrow(/WebSearch and WebFetch/);
    // Removing the add-on removes its catalog.
    await h.remove("scout");
    expect(new PluginStore(log.db).count("scout")).toBe(0);
  }, 20_000);

  it("refuses the catalog and Claude to an add-on that did not ask for them", async () => {
    const log = new EventLog(":memory:");
    const h = new PluginHost(log, join(tmp(), "plugins"), { store: new PluginStore(log.db), ai: new PluginAi(log, () => new FakeClaude()) });
    hosts.push(h);
    h.install(folder({ "main.mjs": `sf.handle("put", () => sf.store.put("x", "1", {})); sf.handle("ask", () => sf.ai.run({ prompt: "p" }));` }, { id: "plain", main: "main.mjs" }));
    h.enable("plain");
    await h.whenReady("plain");
    await expect(h.call("plain", "put")).rejects.toThrow(/store permission/);
    await expect(h.call("plain", "ask")).rejects.toThrow(/ai permission/);
  }, 20_000);
});

describe("add-ons from GitHub", () => {
  it("reads a repository however it is written", () => {
    expect(parseGithubSpec("PlonterAsi/Scout")).toEqual({ repo: "PlonterAsi/Scout", path: "", ref: "HEAD" });
    expect(parseGithubSpec("https://github.com/PlonterAsi/Scout/tree/dev/plugin")).toEqual({ repo: "PlonterAsi/Scout", path: "plugin", ref: "dev" });
    expect(parseGithubSpec("o/r/sub", "v1")).toEqual({ repo: "o/r", path: "sub", ref: "v1" });
    expect(() => parseGithubSpec("just-a-name")).toThrow(/owner\/repo/);
    expect(() => parseGithubSpec("o/r/../x")).toThrow();
    expect(parseGithubSource("github:o/r/plugin@main#abc1234")).toEqual({ repo: "o/r", path: "plugin", ref: "main", sha: "abc1234" });
  });

  /** A .tar.gz like GitHub's: one top folder named owner-repo-<sha>. */
  function tarball(sha: string, version: string, extra: Record<string, unknown> = {}): Buffer {
    const root = tmp("sf-gh-");
    folder({ "plugin/main.mjs": "sf.handle('v', () => sf.plugin.version);", "README.md": "x" }, {}, join(root, `o-r-${sha}`));
    writeFileSync(join(root, `o-r-${sha}`, "plugin", "plugin.json"), JSON.stringify({ id: "gh-addon", name: "From GitHub", version, main: "main.mjs", ...extra }));
    rmSync(join(root, `o-r-${sha}`, "plugin.json"));
    const out = join(root, "a.tar.gz");
    const r = spawnSync("tar", ["-czf", out, "-C", root, `o-r-${sha}`]);
    expect(r.status).toBe(0);
    return readFileSync(out);
  }

  it("installs from a repository folder, remembers where from, and updates only when there is something new", async () => {
    let serve = tarball("aaaaaaa", "1.0.0");
    const asked: string[] = [];
    const log = new EventLog(":memory:");
    const h = new PluginHost(log, join(tmp(), "plugins"), { tarball: async (repo, ref) => { asked.push(`${repo}@${ref}`); return serve; } });
    hosts.push(h);
    const v = await h.installFromGithub("o/r", { ref: "main" });
    expect(v).toMatchObject({ id: "gh-addon", version: "1.0.0", source: "github:o/r/plugin@main#aaaaaaa", status: "installed", updated: true });
    h.enable("gh-addon");
    expect(await h.whenReady("gh-addon")).toBe(true);
    expect((await h.updateFromGithub("gh-addon")).updated).toBe(false);
    serve = tarball("bbbbbbb", "1.1.0");
    const u = await h.updateFromGithub("gh-addon");
    expect(u).toMatchObject({ version: "1.1.0", status: "enabled", updated: true, source: "github:o/r/plugin@main#bbbbbbb" });
    expect(await h.call("gh-addon", "v")).toBe("1.1.0");
    // An update that asks for more waits for you to turn it on again.
    serve = tarball("ccccccc", "2.0.0", { permissions: ["store"] });
    expect(await h.updateAllFromGithub()).toEqual(["gh-addon"]);
    expect(h.get("gh-addon")!.status).toBe("installed");
    expect(asked.every((a) => a === "o/r@main")).toBe(true);
  }, 30_000);

  it("says plainly when it cannot update", async () => {
    const log = new EventLog(":memory:");
    const h = new PluginHost(log, join(tmp(), "plugins"));
    hosts.push(h);
    h.install(folder({ "main.mjs": "" }, { id: "local-one", main: "main.mjs" }));
    await expect(h.updateFromGithub("local-one")).rejects.toThrow(/not installed from GitHub/);
  });
});
