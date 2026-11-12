import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBay, BUILTIN_AGENTS, ClaudeCodeRuntime, EventLog } from "../src/index.js";
import { configureKits, kitFor, library, listSkills } from "../src/bay/kits.js";
import { bind } from "../src/factory/crew.js";

const data = mkdtempSync(join(tmpdir(), "sf-kits-"));
configureKits({ dataDir: data });
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
    expect(library().mcp).toEqual([{ name: "docs", command: "node docs.js" }, { name: "other", command: "x" }]);
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
    expect(m.tools).toEqual(["Skill"]);
    expect(m.pluginDirs).toHaveLength(1);
    const args = new ClaudeCodeRuntime({ profile: "lean" }).buildArgs({ prompt: "x", tools: m.tools, pluginDirs: m.pluginDirs });
    expect(args[args.indexOf("--tools") + 1]).toBe("Skill");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Skill");
    expect(existsSync(m.pluginDirs[0])).toBe(true);
  });

  it("an unedited built-in agent follows the shipped one; one the person edited stays theirs", () => {
    const log = new EventLog(":memory:");
    const old = (id: string) => ({ ...BUILTIN_AGENTS.find((a) => a.id === id)!, skills: [] as string[], mcp: undefined });
    log.append("bay.agent.saved", { id: "fixer", version: 1, def: old("fixer"), note: "built-in crew", by: "builtin", builtin: true });
    log.append("bay.agent.saved", { id: "builder", version: 1, def: old("builder"), note: "built-in crew", by: "builtin", builtin: true });
    log.append("bay.agent.saved", { id: "builder", version: 2, def: { ...old("builder"), prompt: "Mine." }, note: "edited", by: "you", builtin: true });
    const bay = new AgentBay(log);
    expect(bay.get("fixer")).toMatchObject({ version: 2, def: { skills: ["systematic-debugging"] } });
    expect(bay.get("fixer")!.versions.at(-1)!.note).toMatch(/^built-in update: changed .*skills/);
    expect(bay.get("builder")).toMatchObject({ version: 2, def: { prompt: "Mine.", skills: [] } });
    // Nothing more on the next start.
    new AgentBay(log);
    expect(bay.get("fixer")!.version).toBe(2);
    expect(bay.state().library.skills.length).toBeGreaterThan(0);
  });
});
