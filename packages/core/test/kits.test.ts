import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBay, BUILTIN_AGENTS, ClaudeCodeRuntime, EventLog } from "../src/index.js";
import { configureKits, kitFor, library, listSkills } from "../src/bay/kits.js";
import { bind } from "../src/factory/crew.js";

const data = mkdtempSync(join(tmpdir(), "sf-kits-"));
configureKits({ dataDir: data, bundledMcp: null });
afterAll(() => configureKits({}));

describe("per-agent kits: each agent loads only its own skills and MCP servers", () => {
  it("lists the bundled skills library, and the person's own skills next to it", () => {
    const names = listSkills().map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["frontend-design", "systematic-debugging", "test-driven-development", "visualize-everything"]));
    mkdirSync(join(data, "skills", "house-style"), { recursive: true });
    writeFileSync(join(data, "skills", "house-style", "SKILL.md"), "---\nname: house-style\ndescription: How we name things.\n---\nUse plain words.\n");
    const mine = listSkills().find((s) => s.name === "house-style")!;
    expect(mine).toMatchObject({ source: "yours", description: "How we name things." });
  });

  it("an agent with no skills or MCP stays lean: nothing added", () => {
    const k = kitFor({ plugins: [], skills: [], tools: [], mcp: [] }, []);
    expect(k).toMatchObject({ pluginDirs: [], tools: [], missing: [] });
    expect(k.mcpConfig).toBeUndefined();
  });

  it("builds a plugin folder holding only the chosen skills, and turns on the Skill tool", () => {
    const k = kitFor({ plugins: [], skills: ["systematic-debugging", "nope"], tools: [] }, []);
    expect(k.tools).toEqual(["Skill"]);
    expect(k.missing).toEqual(["skill nope"]);
    const dir = k.pluginDirs[0];
    expect(JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8")).name).toMatch(/^sf-skills-/);
    expect(readdirSync(join(dir, "skills"))).toEqual(["systematic-debugging"]);
    // The same choice reuses the same folder.
    expect(kitFor({ plugins: [], skills: ["systematic-debugging"], tools: [] }, []).pluginDirs[0]).toBe(dir);
  });

  it("writes an agent's own MCP servers to its own config and allows only their tools", () => {
    writeFileSync(join(data, "mcp-servers.json"), JSON.stringify({ mcpServers: { docs: { command: "node", args: ["docs.js"] }, other: { command: "x" } } }));
    expect(library().mcp).toEqual([{ name: "docs", command: "node docs.js", note: "", source: "yours" }, { name: "other", command: "x", note: "", source: "yours" }]);
    const k = kitFor({ plugins: [], skills: [], tools: ["WebFetch"], mcp: ["docs"] }, []);
    expect(k.tools).toEqual(["WebFetch", "mcp__docs"]);
    expect(Object.keys(JSON.parse(readFileSync(k.mcpConfig!, "utf8")).mcpServers)).toEqual(["docs"]);

    const args = new ClaudeCodeRuntime({ profile: "lean" }).buildArgs({ prompt: "x", tools: k.tools, mcpConfig: k.mcpConfig });
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--tools") + 1]).toBe("WebFetch");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe(k.mcpConfig);
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("WebFetch,mcp__docs");
  });

  it("a bound crew member carries its kit; the Skill tool is allowed headless", () => {
    const fixer = BUILTIN_AGENTS.find((a) => a.id === "fixer")!;
    const m = bind(fixer, 1, "fix");
    expect(m.tools).toEqual(["Read", "Glob", "Grep", "WebSearch", "Skill"]);
    expect(readdirSync(join(m.pluginDirs[0], "skills")).sort()).toEqual(["silent-failure-hunting", "systematic-debugging"]);
    const args = new ClaudeCodeRuntime({ profile: "lean" }).buildArgs({ prompt: "x", tools: m.tools, pluginDirs: m.pluginDirs, cwd: "/proj" });
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep,WebSearch,Skill");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Read,Glob,Grep,WebSearch,Skill");
    expect(existsSync(m.pluginDirs[0])).toBe(true);
  });

  it("ships a bundled MCP catalogue (Playwright) that no agent loads unless it is ticked", () => {
    configureKits({ dataDir: data });
    expect(library().mcp.find((m) => m.name === "playwright")).toMatchObject({ source: "bundled", command: expect.stringMatching(/@playwright\/mcp@\d/) });
    const k = kitFor({ plugins: [], skills: [], tools: [], mcp: ["playwright"] }, []);
    const cfg = JSON.parse(readFileSync(k.mcpConfig!, "utf8")).mcpServers.playwright;
    expect(Object.keys(cfg).some((x) => x.startsWith("_"))).toBe(false);
    configureKits({ dataDir: data, bundledMcp: null });
  });

  it("every skill a built-in agent lists is in the library", () => {
    const have = new Set(listSkills().map((s) => s.name));
    for (const a of BUILTIN_AGENTS) for (const s of a.skills) expect(have.has(s), `${a.id}: ${s}`).toBe(true);
  });

  it("an unedited built-in agent follows the shipped one; one the person edited stays theirs", () => {
    const log = new EventLog(":memory:");
    const old = (id: string) => ({ ...BUILTIN_AGENTS.find((a) => a.id === id)!, skills: [] as string[], mcp: undefined });
    log.append("bay.agent.saved", { id: "fixer", version: 1, def: old("fixer"), note: "built-in crew", by: "builtin", builtin: true });
    log.append("bay.agent.saved", { id: "builder", version: 1, def: old("builder"), note: "built-in crew", by: "builtin", builtin: true });
    log.append("bay.agent.saved", { id: "builder", version: 2, def: { ...old("builder"), prompt: "Mine." }, note: "edited", by: "you", builtin: true });
    const bay = new AgentBay(log);
    expect(bay.get("fixer")).toMatchObject({ version: 2, def: { skills: ["systematic-debugging", "silent-failure-hunting"] } });
    expect(bay.get("fixer")!.versions.at(-1)!.note).toMatch(/^built-in update: changed .*skills/);
    expect(bay.get("builder")).toMatchObject({ version: 2, def: { prompt: "Mine.", skills: [] } });
    // Nothing more on the next start.
    new AgentBay(log);
    expect(bay.get("fixer")!.version).toBe(2);
    expect(bay.state().library.skills.length).toBeGreaterThan(0);
  });
});
