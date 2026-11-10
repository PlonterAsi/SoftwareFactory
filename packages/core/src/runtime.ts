import { spawn } from "node:child_process";

/**
 * Agent runtime adapter. The factory talks to agents only through this
 * interface, so the runtime chosen by the milestone 1 spike can be swapped.
 */
export interface AgentRequest {
  prompt: string;
  /** Model alias or id, for example "haiku", "sonnet", "opus". */
  model?: string;
  /** Extra instructions appended to the runtime's system prompt (the agent's role). */
  systemPrompt?: string;
  /** Hard spend cap for this one call, in USD. */
  budgetUsd?: number;
  /** Plugin folders to load (your installed Claude Code plugins). */
  pluginDirs?: string[];
  /** Tools the agent may use. Empty or absent in the lean profile: none (the agent answers in text). */
  tools?: string[];
  /**
   * Run inside this folder (a working copy the agent may edit with its tools).
   * File edits there are accepted without a prompt; nothing outside it is.
   */
  cwd?: string;
}

export interface AgentResult {
  text: string;
  costUsd: number;
  durationMs: number;
  models: string[];
  runtime: string;
  /** Prompt-context tokens written to or read from cache: the fixed cost of loading context. */
  contextTokens: number;
}

export interface AgentRuntime {
  readonly name: string;
  run(req: AgentRequest): Promise<AgentResult>;
}

export interface ClaudeCodeOptions {
  /** Path to the claude CLI. */
  command?: string;
  /**
   * Arguments put before the CLI's own, e.g. the script when `command` is node.
   * On Windows an npm install of Claude Code is a `claude.cmd` shim that cannot be
   * spawned directly, so SF_CLAUDE_JS runs its `cli.js` with this Node instead.
   */
  commandArgs?: string[];
  /**
   * "lean" skips MCP servers and built-in tools, so only what the agent needs is
   * loaded. "full" loads everything installed (all plugins, skills, MCP servers).
   */
  profile?: "lean" | "full";
  defaultModel?: string;
  timeoutMs?: number;
}

/** Option A of the spike: drive Claude Code headless (`claude -p`). */
export class ClaudeCodeRuntime implements AgentRuntime {
  readonly name: string;
  private readonly opts: Required<ClaudeCodeOptions>;

  constructor(opts: ClaudeCodeOptions = {}) {
    this.opts = {
      command: opts.command ?? (process.env.SF_CLAUDE_JS ? process.execPath : process.env.SF_CLAUDE_BIN ?? "claude"),
      commandArgs: opts.commandArgs ?? (opts.command === undefined && process.env.SF_CLAUDE_JS ? [process.env.SF_CLAUDE_JS] : []),
      profile: opts.profile ?? "lean",
      defaultModel: opts.defaultModel ?? "haiku",
      timeoutMs: opts.timeoutMs ?? Number(process.env.SF_AGENT_TIMEOUT_MS ?? 600_000),
    };
    this.name = `claude-code:${this.opts.profile}`;
  }

  buildArgs(req: AgentRequest): string[] {
    const args = ["-p", req.prompt, "--output-format", "json", "--model", req.model ?? this.opts.defaultModel];
    if (req.budgetUsd !== undefined) args.push("--max-budget-usd", String(req.budgetUsd));
    if (req.systemPrompt) args.push("--append-system-prompt", req.systemPrompt);
    for (const dir of req.pluginDirs ?? []) args.push("--plugin-dir", dir);
    if (this.opts.profile === "lean") args.push("--strict-mcp-config", "--tools", (req.tools ?? []).join(","));
    else if (req.tools?.length) args.push("--tools", req.tools.join(","));
    // Headless edits in a working copy: accept file edits there, nothing else is allowed to prompt.
    if (req.cwd && req.tools?.some((t) => t === "Edit" || t === "Write")) args.push("--permission-mode", "acceptEdits");
    return args;
  }

  run(req: AgentRequest): Promise<AgentResult> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.command, [...this.opts.commandArgs, ...this.buildArgs(req)], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...(req.cwd ? { cwd: req.cwd } : {}) });
      let out = "";
      let err = "";
      const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`Agent timed out after ${this.opts.timeoutMs} ms`)); }, this.opts.timeoutMs);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", (code) => {
        clearTimeout(timer);
        try {
          resolve(parseClaudeJson(out, this.name, Date.now() - started));
        } catch (e) {
          reject(new Error(`claude exited ${code}: ${(e as Error).message}${err ? ` | ${err.slice(0, 300)}` : ""}`));
        }
      });
    });
  }
}

/** Parse the JSON that `claude -p --output-format json` prints. */
export function parseClaudeJson(raw: string, runtime: string, wallMs: number): AgentResult {
  const j = JSON.parse(raw.trim());
  if (j.is_error) throw new Error(String(j.result ?? j.subtype ?? "agent error"));
  const u = j.usage ?? {};
  return {
    text: String(j.result ?? ""),
    costUsd: Number(j.total_cost_usd ?? 0),
    durationMs: Number(j.duration_ms ?? wallMs),
    models: Object.keys(j.modelUsage ?? {}),
    runtime,
    contextTokens: Number(u.cache_creation_input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.input_tokens ?? 0),
  };
}

/**
 * Deterministic runtime for tests and offline UI work. Costs nothing.
 * It plays each factory crew role with a canned tiny project, and its first
 * build has a planted bug, so the fix loop is exercised too.
 */
export class MockRuntime implements AgentRuntime {
  readonly name = "mock";
  calls: AgentRequest[] = [];
  constructor(private opts: { delayMs?: number; plantBug?: boolean } = {}) {}
  async run(req: AgentRequest): Promise<AgentResult> {
    this.calls.push(req);
    if (this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs));
    const role = req.systemPrompt ?? "";
    // Any agent can work any station: the station contract says which canned answer fits.
    const station = role.match(/Station contract: (\w+)/)?.[1]
      ?? (role.includes("You are the Planner") ? "plan" : role.includes("You are the Tester") ? "tests" : role.includes("You are the Builder") ? "build" : role.includes("You are the Fixer") ? "fix" : "");
    const isBuild = (c: AgentRequest) => /Station contract: build/.test(c.systemPrompt ?? "") || !!c.systemPrompt?.includes("You are the Builder");
    const builds = this.calls.filter(isBuild).length;
    let text = `Overseer (mock) received: ${req.prompt.slice(0, 80)}`;
    if (station === "plan") text = MOCK.plan;
    else if (station === "tests") text = MOCK.tests;
    else if (station === "build") text = MOCK.build(this.opts.plantBug !== false && builds === 1);
    else if (station === "fix") text = MOCK.build(false);
    else if (station === "council") text = MOCK.council(role);
    else if (station === "review") text = MOCK.review;
    else if (station === "order") text = MOCK.order(req.prompt);
    else if (station === "overseer") text = MOCK.overseer(req.prompt);
    else if (station === "ticket") text = MOCK.ticket(req.prompt);
    else if (station === "repo") text = MOCK.repo(req.prompt);
    return { text, costUsd: role ? 0.0001 : 0, durationMs: this.opts.delayMs ?? 1, models: ["mock"], runtime: this.name, contextTokens: 0 };
  }
}

const MOCK = {
  // The practice crew cannot read a codebase; it leaves a note file on the branch so the whole path can be tried for free.
  repo: (prompt: string) => {
    const id = prompt.match(/^# #(\d+)/m)?.[1] ?? "0";
    const title = prompt.match(/^# #\d+ (.*)$/m)?.[1] ?? "the ticket";
    return [
      `<<<FILE docs/softwarefactory/ticket-${id}.md`,
      `# Ticket #${id}: ${title}`, "", "Practice crew: this note stands in for the change. Switch to the real crew in Systems to have the Builder edit the code.", "FILE>>>",
      "Practice crew: left a note file for the ticket on the branch.",
    ].join("\n");
  },
  // The practice crew reads a ticket back and names the next step; it cannot judge, so it never says "ready".
  ticket: (prompt: string) => {
    const head = prompt.split("\n")[0].replace(/^#\s*/, "");
    return [`Practice crew: I read ${head}.`, "Smallest next step: press Work it with the crew, or switch to the real crew in Systems for a real reading.", "STATUS: open"].join("\n");
  },
  // The practice Overseer cannot think, but it can read the status digest back and offer the Build button.
  overseer: (prompt: string) => {
    const status = prompt.match(/Status of the factory right now:\n([\s\S]*?)\n\nThe person says:/)?.[1] ?? "";
    const said = prompt.split("The person says:\n")[1]?.trim() ?? prompt;
    const facts = status.split("\n").filter((l) => !l.startsWith("Crew:") && !l.startsWith("Agent spend")).slice(0, 2);
    const wantsBuild = /\b(build|make|create|app|tool|cli|website|script)\b/i.test(said);
    return [
      "Practice Overseer here: I only read the status back. Switch to the real crew in Systems for real answers.",
      facts.length ? `Right now: ${facts.map((f) => f.replace(/\.+$/, "")).join("; ")}.` : "Nothing is running and nothing waits for you.",
      wantsBuild ? `BUILD: ${said.split("\n")[0].slice(0, 200)}` : "",
    ].filter(Boolean).join("\n");
  },
  council: (role: string) => {
    const seat = role.match(/You are the (\w+) on the SoftwareFactory Council/)?.[1] ?? "Seat";
    const take = {
      Visionary: { take: "Worth building: one command, instant answer.", proposals: ["read from a file or stdin", "print one number"], concerns: [], vote: "build", scope: "small" },
      Architect: { take: "One pure function and a thin CLI.", proposals: ["pure countWords function in src", "read from a file or stdin"], concerns: ["unicode whitespace"], vote: "build", scope: "small" },
      Skeptic: { take: "Fine if empty input is handled.", proposals: [], concerns: ["empty input must give 0", "unicode whitespace"], vote: "build", scope: "small" },
    } as Record<string, unknown>;
    return "```json\n" + JSON.stringify(take[seat] ?? { take: `${seat} agrees.`, proposals: [], concerns: [], vote: "build", scope: "small" }) + "\n```";
  },
  review: "```json\n" + JSON.stringify({ verdict: "pass", findings: [{ severity: "low", text: "README could show an example with a file argument" }] }) + "\n```",
  order: (prompt: string) => "```json\n" + JSON.stringify({ nodes: [], fragments: [{ text: (prompt.match(/"""\n([\s\S]*?)\n"""/)?.[1] ?? prompt).slice(0, 200), kind: "note", important: false, node: null, confidence: 0.4, contradicts: [] }] }) + "\n```",
  plan: "```json\n" + JSON.stringify({
    name: "Word Counter", slug: "word-counter", summary: "Counts words in text from stdin or a file.",
    interface: "src/count.js exports countWords(text: string): number. bin/wc.js prints countWords of the file given as argv[2].",
    acceptance: ["empty text has 0 words", "words are split on any whitespace", "punctuation-only tokens still count"],
    tasks: [{ id: "t1", title: "countWords", dependsOn: [] }, { id: "t2", title: "CLI wrapper", dependsOn: ["t1"] }, { id: "t3", title: "README", dependsOn: ["t2"] }],
    files: ["package.json", "src/count.js", "bin/wc.js"],
  }) + "\n```",
  tests: `<<<FILE test/count.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { countWords } from "../src/count.js";
test("empty text has 0 words", () => assert.equal(countWords(""), 0));
test("words are split on any whitespace", () => assert.equal(countWords("a  b\\tc\\nd"), 4));
test("punctuation-only tokens still count", () => assert.equal(countWords("hi - there"), 3));
FILE>>>`,
  build: (bug: boolean) => `<<<FILE package.json
{ "name": "word-counter", "type": "module", "scripts": { "test": "node --test" } }
FILE>>>
<<<FILE src/count.js
export function countWords(text) {
  return text.split(${bug ? '" "' : "/\\s+/"}).filter(Boolean).length;
}
FILE>>>
<<<FILE bin/wc.js
#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { countWords } from "../src/count.js";
console.log(countWords(readFileSync(process.argv[2] ?? 0, "utf8")));
FILE>>>`,
};

export function runtimeFromEnv(env = process.env): AgentRuntime {
  const kind = env.SF_RUNTIME ?? "mock";
  if (kind === "claude-code" || kind === "claude-code:lean") return new ClaudeCodeRuntime({ profile: "lean" });
  if (kind === "claude-code:full") return new ClaudeCodeRuntime({ profile: "full" });
  return new MockRuntime({ delayMs: Number(env.SF_MOCK_DELAY_MS ?? 700) });
}
