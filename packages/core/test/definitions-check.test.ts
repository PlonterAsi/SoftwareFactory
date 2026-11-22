import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { checkHookSettings, checkMcpEntry, checkSkill, checkSubAgent, type PluginPin } from "../src/bay/definitions-check.js";
import { configureKits, library } from "../src/bay/kits.js";
import { secretHookSettings } from "../src/safety/secrets.js";

const pin = JSON.parse(readFileSync(new URL("../reference/plugin-reference.json", import.meta.url), "utf8")) as PluginPin;

describe("definitions-check against the pinned reference", () => {
  it("accepts a good skill and names each skill problem", () => {
    expect(checkSkill("a", "---\nname: a\ndescription: Does a.\n---\nSteps.\n", pin)).toEqual([]);
    expect(checkSkill("a", "---\nname: b\ndescription: x\n---\nSteps\n", pin)[0]).toMatch(/"b".*folder name is "a"/);
    expect(checkSkill("a", "---\nname: a\ndescription:\n---\n \n", pin)).toHaveLength(2);
    expect(checkSkill("a", "no front matter", pin)).toHaveLength(1);
  });

  it("checks MCP entries, ignoring keys that start with _", () => {
    expect(checkMcpEntry("m", { command: "npx", _note: "x" }, pin)).toEqual([]);
    expect(checkMcpEntry("m", { url: "https://x" }, pin)).toEqual([]);
    expect(checkMcpEntry("m", { _command: "npx", command: " " }, pin)[0]).toMatch(/MCP server m.*command or url/);
  });

  it("accepts the secret-scan hook settings and rejects broken ones", () => {
    expect(checkHookSettings(secretHookSettings("h.js"), pin)).toEqual([]);
    expect(checkHookSettings("{", pin)).toHaveLength(1);
    expect(checkHookSettings(JSON.stringify({ hooks: { Bogus: [] } }), pin)).toHaveLength(2);
    const bad = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "shell", command: "" }] }] } });
    expect(checkHookSettings(bad, pin)).toHaveLength(3);
  });

  it("checks a sub-agent's model against the pinned values", () => {
    expect(checkSubAgent("x", "---\nname: x\nmodel: haiku\n---\nbody", pin)).toEqual([]);
    expect(checkSubAgent("x", "---\nmodel: gpt\n---\n", pin)[0]).toMatch(/haiku, sonnet, opus/);
  });
});

describe("library() carries the checks, failing first", () => {
  const data = mkdtempSync(join(tmpdir(), "sf-defcheck-"));
  configureKits({ dataDir: data, bundledMcp: null });
  afterAll(() => configureKits({}));

  it("lists the pin, the hook and a failing skill before the passing ones", () => {
    mkdirSync(join(data, "skills", "zz-broken"), { recursive: true });
    writeFileSync(join(data, "skills", "zz-broken", "SKILL.md"), "---\nname: other\ndescription: d\n---\nbody\n");
    writeFileSync(join(data, "mcp-servers.json"), JSON.stringify({ mcpServers: { good: { command: "npx" }, bad: { _note: "x" } } }));
    const lib = library();
    expect(lib.reference).toMatchObject({ repo: "anthropics/claude-plugins-official", commit: pin.commit });
    expect(lib.checks.find((c) => c.kind === "hook")?.checks).toEqual([]);
    expect(lib.checks.slice(0, 2).map((c) => c.name).sort()).toEqual(["bad", "zz-broken"]);
    const firstOk = lib.checks.findIndex((c) => c.checks.length === 0);
    expect(lib.checks.slice(firstOk).every((c) => c.checks.length === 0)).toBe(true);
    expect(lib.checks.filter((c) => c.kind === "sub-agent").every((a) => a.checks.length === 0)).toBe(true);
  });
});
