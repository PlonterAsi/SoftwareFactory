import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secretHookFile, secretHookSettings } from "./safety/secrets.js";
import { killTree } from "./launch/launcher.js";

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
  /** Tools the agent may use. Empty or absent in the lean profile: none (the agent answers in text). `mcp__<server>` names allow that MCP server's tools. */
  tools?: string[];
  /** An --mcp-config file with only this agent's MCP servers (see bay/kits.ts). */
  mcpConfig?: string;
  /**
   * Run inside this folder (a working copy the agent may edit with its tools).
   * File edits there are accepted without a prompt; nothing outside it is.
   */
  cwd?: string;
  /**
   * The workbench (factory/workbench.ts): shell commands this agent may run in `cwd` without a prompt,
   * as command prefixes ("node", "npm test"). Only with a folder; without it the shell is not offered.
   */
  commands?: string[];
  /** A longer (or shorter) limit for this one call than the runtime's default, in ms. */
  timeoutMs?: number;
  /** Run without any CLAUDE.md or memory, even when editing (a factory build folder has none of its own). */
  noMemory?: boolean;
}

export interface AgentResult {
  text: string;
  costUsd: number;
  durationMs: number;
  models: string[];
  runtime: string;
  /** Prompt-context tokens written to or read from cache: the fixed cost of loading context. */
  contextTokens: number;
  /** Of those, read from the prompt cache (cheap) and written to it (SF-18). */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
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

/** An agent that edits files in a working copy (a ticket's repo work) rather than answering in its contract. */
const edits = (req: AgentRequest) => !!req.cwd && !!req.tools?.some((t) => t === "Edit" || t === "Write");

/** Option A of the spike: drive Claude Code headless (`claude -p`). */
/** Longest role kept on the command line; longer ones go on stdin (Windows command lines stop near 32,000 characters). */
const MAX_ARG_ROLE = 8000;

/** Tools an agent may use headless without a prompt: they read the web and change nothing here. */
export const WEB_TOOLS = ["WebSearch", "WebFetch"];
/** Tools that read files. They only make sense in a folder: without one an agent would read the core's own data folder, so they are dropped. */
export const READ_TOOLS = ["Read", "Glob", "Grep"];
/** Tools that touch files: only with a folder, and only in it. */
const FILE_TOOLS = [...READ_TOOLS, "Edit", "Write", "NotebookEdit"];

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

  /**
   * The prompt goes in on stdin, never on the command line: Windows caps a command line at
   * about 32,000 characters, and a Fixer prompt with the failing tests and the code is longer
   * ("spawn ENAMETOOLONG"). A very long role moves to stdin too, ahead of the prompt.
   */
  buildArgs(req: AgentRequest): string[] {
    const args = ["-p", "--output-format", "json", "--model", req.model ?? this.opts.defaultModel];
    if (req.budgetUsd !== undefined) args.push("--max-budget-usd", String(req.budgetUsd));
    if (req.systemPrompt && req.systemPrompt.length <= MAX_ARG_ROLE) args.push("--append-system-prompt", req.systemPrompt);
    for (const dir of req.pluginDirs ?? []) args.push("--plugin-dir", dir);
    // --tools takes built-in tools only; an MCP server's tools come from --mcp-config and are allowed by name.
    const shell = !!req.cwd && !!req.commands?.length;
    const builtin = [...new Set([...(req.tools ?? []), ...(shell ? ["Bash"] : [])])].filter((t) => !t.startsWith("mcp__") && (req.cwd || !FILE_TOOLS.includes(t)) && (t !== "Bash" || shell));
    if (this.opts.profile === "lean") args.push("--strict-mcp-config", "--tools", builtin.join(","));
    // Without this a station agent with the Skill tool sees every skill and plugin the person installed
    // (130+ on Assaf's PC), not just its own kit. An agent that edits a working copy keeps the person's settings.
    if (this.opts.profile === "lean" && !edits(req)) args.push("--setting-sources", "project,local");
    else if (builtin.length) args.push("--tools", builtin.join(","));
    if (req.mcpConfig) args.push("--mcp-config", req.mcpConfig);
    // Headless edits in a working copy: accept file edits there, nothing else is allowed to prompt.
    if (req.cwd && req.tools?.some((t) => t === "Edit" || t === "Write")) {
      args.push("--permission-mode", "acceptEdits");
      // The secret gate runs after every edit, so a leaked key reaches the agent as an error to fix (SF-17).
      args.push("--settings", secretHookSettings(secretHookFile(join(tmpdir(), "sf-hooks"))));
    }
    // Allowed without a prompt: read-only web tools, the Skill tool (it reads the agent's own skills), and the
    // agent's own MCP servers. Headless, anything unapproved is simply refused.
    const allowed = (req.tools ?? []).filter((t) => WEB_TOOLS.includes(t) || t === "Skill" || (req.cwd && READ_TOOLS.includes(t)) || (req.mcpConfig && t.startsWith("mcp__")));
    // The workbench's shell: only the listed command prefixes run; any other command is refused headless.
    if (shell) allowed.push(...req.commands!.map((c) => `Bash(${c}:*)`));
    if (allowed.length) args.push("--allowedTools", allowed.join(","));
    return args;
  }

  /** What the CLI reads on stdin: the prompt, with the role in front when it was too long for the command line. */
  stdinFor(req: AgentRequest): string {
    return req.systemPrompt && req.systemPrompt.length > MAX_ARG_ROLE ? `<your-role>\n${req.systemPrompt}\n</your-role>\n\n${req.prompt}` : req.prompt;
  }

  /**
   * A station agent answers in its own contract's format, so it runs without the person's own
   * CLAUDE.md files and memory (a "Now: ..." line from a personal rule broke answers). An agent
   * working in a folder (a ticket's working copy) still reads that folder's CLAUDE.md.
   */
  envFor(req: AgentRequest, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    // An agent that only reads a project's files is still a station agent: its contract, not the person's memory.
    // A factory build agent edits a folder SF made, which has no memory of its own: the person's CLAUDE.md is
    // written for them, not for a station agent (run 2623's Builder ended with "Assaf, press Start").
    return edits(req) && !req.noMemory ? base : { ...base, CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };
  }

  run(req: AgentRequest): Promise<AgentResult> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.command, [...this.opts.commandArgs, ...this.buildArgs(req)], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: this.envFor(req), ...(req.cwd ? { cwd: req.cwd } : {}) });
      // A CLI that dies before reading stdin closes the pipe; the exit code says what happened.
      child.stdin.on("error", () => {});
      child.stdin.end(this.stdinFor(req), "utf8");
      let out = "";
      let err = "";
      const limit = req.timeoutMs ?? this.opts.timeoutMs;
      const timer = setTimeout(() => { killTree(child, true); reject(new Error(`Agent timed out after ${limit} ms`)); }, limit);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", (code) => {
        clearTimeout(timer);
        try {
          resolve(parseClaudeJson(out, this.name, Date.now() - started));
        } catch (e) {
          reject(Object.assign(new Error(`claude exited ${code}: ${(e as Error).message}${err ? ` | ${err.slice(0, 300)}` : ""}`), { costUsd: (e as { costUsd?: number }).costUsd ?? 0 }));
        }
      });
    });
  }
}

/** Parse the JSON that `claude -p --output-format json` prints. */
export function parseClaudeJson(raw: string, runtime: string, wallMs: number): AgentResult {
  const j = JSON.parse(raw.trim());
  // A call that failed still spent money (error_max_budget_usd spends the whole cap): say how much.
  if (j.is_error) throw Object.assign(new Error(String(j.result ?? j.subtype ?? "agent error")), { costUsd: Number(j.total_cost_usd ?? 0) });
  const u = j.usage ?? {};
  return {
    text: String(j.result ?? ""),
    costUsd: Number(j.total_cost_usd ?? 0),
    durationMs: Number(j.duration_ms ?? wallMs),
    models: Object.keys(j.modelUsage ?? {}),
    runtime,
    contextTokens: Number(u.cache_creation_input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.input_tokens ?? 0),
    cacheReadTokens: Number(u.cache_read_input_tokens ?? 0),
    cacheWriteTokens: Number(u.cache_creation_input_tokens ?? 0),
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
    else if (station === "map") text = MOCK.map(req.prompt);
    else if (station === "survey") text = MOCK.survey(req.prompt);
    else if (station === "improve") text = MOCK.improve(role, req.prompt);
    return { text, costUsd: role ? 0.0001 : 0, durationMs: this.opts.delayMs ?? 1, models: ["mock"], runtime: this.name, contextTokens: 0 };
  }
}

const MOCK = {
  // The practice crew cannot read a codebase; it leaves a note file on the branch so the whole path can be tried for free.
  repo: (prompt: string) => {
    // The work document starts "# SF-4 Title" (a project's key and number) or "# #4 Title".
    const head = prompt.match(/^# (?:#|[A-Z][A-Z0-9]*-)(\d+) (.*)$/m);
    const id = head?.[1] ?? "0";
    const title = head?.[2] ?? "the ticket";
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
  // The practice Cartographer echoes each module it was given with a canned purpose.
  map: (prompt: string) => "```json\n" + JSON.stringify({ modules: [...prompt.matchAll(/^## module: (.+)$/gm)].map((m) => ({ id: m[1].trim(), purpose: `Mock purpose of ${m[1].trim()}.`, role: /test/.test(m[1]) ? "test" : "core", risks: [] })) }) + "\n```",
  survey: (prompt: string) => {
    const mod = prompt.match(/^- (\S+) \[/m)?.[1] ?? "src";
    return "```json\n" + JSON.stringify({ suggestions: [
      { title: `Add tests for ${mod}`, body: `${mod} is the largest module and has no direct tests.`, kind: "improvement", lens: "tests", severity: "high", effort: "medium", files: [mod] },
      { title: "Document how to run the project", body: "The README does not say how to start it.", kind: "improvement", lens: "docs", severity: "low", effort: "small", files: ["README.md"] },
    ] }) + "\n```";
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
      Visionary: { take: "Worth building as a small writing app: pieces with goals and a live count.", proposals: ["pieces with a word goal", "a progress dashboard"], concerns: [], vote: "build", scope: "small" },
      Architect: { take: "One pure countWords function, one entity, one dashboard view.", proposals: ["pure countWords function in src", "pieces with a word goal"], concerns: ["unicode whitespace"], vote: "build", scope: "small" },
      Skeptic: { take: "Fine if empty input is handled.", proposals: [], concerns: ["empty input must give 0", "unicode whitespace"], vote: "build", scope: "small" },
    } as Record<string, unknown>;
    return "```json\n" + JSON.stringify(take[seat] ?? { take: `${seat} agrees.`, proposals: [], concerns: [], vote: "build", scope: "small" }) + "\n```";
  },
  // The practice lenses cannot think either: one canned proposal per lens, about the subject they were given.
  improve: (role: string, prompt: string) => {
    const lens = role.match(/You are the (.+?) on the SoftwareFactory Improvement Council/)?.[1] ?? "Lens";
    const subject = prompt.match(/^Subject: [^"\n]*"([^"]+)"/m)?.[1] ?? (prompt.includes("SoftwareFactory itself") ? "SoftwareFactory" : "this");
    const said = new Set([...prompt.matchAll(/^- \[\w+\] (.+)$/gm)].map((m) => m[1].trim()));
    const canned: Record<string, [string, string, string, string, string]> = {
      Integrator: [`Share one settings file between ${subject} and your other tools`, "Each tool keeps its own copy of the same settings.", `Read shared settings from one file that ${subject} and the other apps both use.`, "medium", "small"],
      Automator: [`Run ${subject} on a schedule instead of by hand`, "It is started by hand every time.", `Add a scheduled run of ${subject} with a log of what it did.`, "high", "small"],
      Simplifier: [`Cut the least used option from ${subject}`, "Options nobody uses make every run harder to read.", `Remove the least used flag of ${subject} and keep its default behaviour.`, "medium", "small"],
      Enricher: [`Add a dry-run mode to ${subject}`, "Nobody can see what it will do before it does it.", `A --dry-run flag in ${subject} that prints every change and touches nothing.`, "high", "medium"],
      "UX Lens": [`Show a one-line summary when ${subject} finishes`, "The result is hard to see at a glance.", `End every run of ${subject} with one line: what changed, what was skipped.`, "medium", "small"],
      "Flow Lens": [`Ask once up front in ${subject}, then never stop`, "The flow stops in the middle to ask.", `Collect every choice of ${subject} at the start so the rest runs without a stop.`, "medium", "medium"],
    };
    const c = canned[lens];
    const proposals = c && !said.has(c[0]) ? [{ title: c[0], why: c[1], change: c[2], impact: c[3], effort: c[4] }] : [];
    return "```json\n" + JSON.stringify({ proposals }) + "\n```";
  },
  review: "```json\n" + JSON.stringify({ verdict: "pass", findings: [{ severity: "low", text: "README could show an example with a file argument" }] }) + "\n```",
  order: (prompt: string) => "```json\n" + JSON.stringify({ nodes: [], fragments: [{ text: (prompt.match(/"""\n([\s\S]*?)\n"""/)?.[1] ?? prompt).slice(0, 200), kind: "note", important: false, node: null, confidence: 0.4, contradicts: [] }] }) + "\n```",
  plan: "```json\n" + JSON.stringify({
    name: "Word Counter", slug: "word-counter", summary: "Keeps your writing pieces and shows how many words each has against its goal.",
    interface: "src/count.js exports countWords(text: string): number and progress(words: number, goal: number|null): number (percent of the goal, 0 to 100; 0 when there is no goal). src/schema.js exports app, entities (piece), flows, features.",
    entities: [{ name: "piece", label: "Pieces", fields: [{ name: "title", type: "text", required: true }, { name: "text", type: "longtext" }, { name: "goal", type: "number" }, { name: "status", type: "choice", options: ["draft", "editing", "done"], required: true }], seed: "three short pieces at different stages" }],
    flows: [{ name: "Write to a goal", steps: ["Create a piece", "Set its word goal", "Write", "Watch its bar fill on Progress"] }],
    views: [{ id: "dashboard", label: "Progress", shows: "total words, a bar per piece against its goal, and a quick count box" }],
    ui: "A writing desk: Pieces (list, create, edit, delete) in the navigation, and a Progress dashboard with a bar per piece against its goal and a box that counts words as you type.",
    cli: "",
    examples: [],
    acceptance: ["empty text has 0 words", "words are split on any whitespace", "punctuation-only tokens still count", "progress is the share of the goal, capped at 100"],
    tasks: [{ id: "t1", title: "countWords and progress", dependsOn: [] }, { id: "t2", title: "schema: pieces with samples", dependsOn: ["t1"] }, { id: "t3", title: "Progress view", dependsOn: ["t2"] }],
    files: ["package.json", "src/count.js", "src/schema.js", "index.html", "web/app.js", "web/style.css"],
  }) + "\n```",
  tests: `<<<FILE test/count.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { countWords, progress } from "../src/count.js";
test("empty text has 0 words", () => assert.equal(countWords(""), 0));
test("words are split on any whitespace", () => assert.equal(countWords("a  b\\tc\\nd"), 4));
test("punctuation-only tokens still count", () => assert.equal(countWords("hi - there"), 3));
test("progress is the share of the goal, capped at 100", () => { assert.equal(progress(50, 200), 25); assert.equal(progress(300, 200), 100); assert.equal(progress(10, null), 0); });
FILE>>>`,
  build: (bug: boolean) => `<<<FILE package.json
{ "name": "word-counter", "type": "module", "scripts": { "start": "node server.js", "test": "node --test" } }
FILE>>>
<<<FILE src/count.js
export function countWords(text) {
  return String(text ?? "").split(${bug ? '" "' : "/\\s+/"}).filter(Boolean).length;
}
export function progress(words, goal) {
  if (!goal || goal <= 0) return 0;
  return Math.min(100, Math.round((words / goal) * 100));
}
FILE>>>
<<<FILE src/schema.js
import { countWords, progress } from "./count.js";
export const app = { name: "Word Counter", slug: "word-counter", tagline: "Writing desk", summary: "Keep your pieces of writing and watch each one grow toward its word goal." };
export const entities = [{
  name: "piece", label: "Pieces", singular: "Piece", description: "Everything you are writing.", title: "title",
  fields: [
    { name: "title", type: "text", required: true },
    { name: "text", type: "longtext", help: "The words themselves." },
    { name: "goal", label: "Word goal", type: "number", min: 0 },
    { name: "status", type: "choice", options: ["draft", "editing", "done"], required: true },
  ],
  computed: [
    { name: "words", label: "Words", value: (r) => countWords(r.text) },
    { name: "progress", label: "% of goal", value: (r) => progress(countWords(r.text), r.goal) },
  ],
  seed: [
    { title: "Morning pages", text: "Woke early and wrote three lines before coffee. The house was quiet.", goal: 50, status: "draft" },
    { title: "Launch note", text: "SoftwareFactory now builds real apps: every project opens with its data, its screens and a system view.", goal: 40, status: "editing" },
    { title: "Haiku", text: "An old silent pond, a frog jumps into the pond, splash! Silence again.", goal: 17, status: "done" },
  ],
}];
export const flows = [{ name: "Write to a goal", description: "From an empty page to a finished piece.", steps: ["Create a piece", "Set its word goal", "Write", "Watch its bar fill on Progress"] }];
export const features = [{ name: "Progress", description: "Every piece against its goal", where: "home" }, { name: "Quick count", description: "Count any text as you type", where: "home" }];
FILE>>>
<<<FILE index.html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Word Counter</title>
<link rel="stylesheet" href="web/kit/kit.css"><link rel="stylesheet" href="web/style.css"></head>
<body>
<div id="app"></div>
<script type="module" src="web/app.js"></script>
</body>
</html>
FILE>>>
<<<FILE web/app.js
import * as schema from "../src/schema.js";
import { startApp } from "./kit/shell.js";
import { countWords, progress } from "../src/count.js";

const dashboard = {
  id: "dashboard", label: "Progress", description: "Every piece against its word goal, and a quick count box",
  render(el, { store, h, bars, stat, go }) {
    const pieces = store.list("piece");
    const total = pieces.reduce((a, p) => a + countWords(p.text), 0);
    const done = pieces.filter((p) => p.status === "done").length;
    const out = h("span", { class: "big" }, "0");
    const box = h("textarea", { rows: "4", placeholder: "Paste or type any text to count it", oninput: (e) => { out.textContent = String(countWords(e.target.value)); } });
    el.append(
      h("header", { class: "kit-head" }, h("h1", {}, "Progress"), h("p", { class: "kit-sub" }, "Every piece against its word goal.")),
      h("div", { class: "kit-cards" }, stat("Words written", total), stat("Pieces", pieces.length, done + " done"), stat("Average progress", pieces.length ? Math.round(pieces.reduce((a, p) => a + progress(countWords(p.text), p.goal), 0) / pieces.length) + "%" : "—")),
      h("div", { class: "kit-panel" }, h("h2", {}, "Pieces"), pieces.length
        ? bars(pieces.map((p) => ({ label: p.title, value: countWords(p.text), max: p.goal || countWords(p.text) || 1 })), { format: (v, i) => v + (i.max ? " / " + i.max : "") })
        : h("p", { class: "kit-muted" }, "No pieces yet."),
        h("div", { class: "kit-actions" }, h("button", { class: "kit-primary", onclick: () => go("e/piece/new") }, "New piece"))),
      h("div", { class: "kit-panel" }, h("h2", {}, "Quick count"), box, h("p", {}, out, " words")),
    );
  },
};

startApp({ schema, views: [dashboard] });
FILE>>>
<<<FILE web/style.css
.big { font-size: 28px; font-weight: 700; color: var(--kit-accent); }
FILE>>>
<<<FILE README.md
# Word Counter

A writing desk: keep your pieces, give each a word goal and watch its bar fill.
Open it from the project's Run tab in SoftwareFactory and press Start. No arguments, no files to write; data lives in data/db.json.
FILE>>>`,
};

export function runtimeFromEnv(env = process.env): AgentRuntime {
  const kind = env.SF_RUNTIME ?? "mock";
  if (kind === "claude-code" || kind === "claude-code:lean") return new ClaudeCodeRuntime({ profile: "lean" });
  if (kind === "claude-code:full") return new ClaudeCodeRuntime({ profile: "full" });
  return new MockRuntime({ delayMs: Number(env.SF_MOCK_DELAY_MS ?? 700) });
}
