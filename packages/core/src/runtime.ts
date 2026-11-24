import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secretHookFile, secretHookSettings } from "./safety/secrets.js";
import { killTree } from "./launch/launcher.js";
import { AwakeClock } from "./factory/awake.js";

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
  /** The most a profile that moves this call to a pricier model may lift budgetUsd to (what the run has left). Absent: no lift. */
  ceilingUsd?: number;
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
  /**
   * True for a session in a folder the factory made itself: it gets its own kit only, not the skills and
   * plugins installed on the PC. (Run 3185: each Builder and Fixer turn carried the person's 119 skills.)
   * Work in the person's own repository leaves it off and keeps their setup.
   */
  ownKitOnly?: boolean;
  /** Set by a configuration profile (crew.personalSettings): load the person's own Claude Code settings when editing a repo. Absent: SF_CREW_PERSONAL_SETTINGS decides. */
  personalSettings?: boolean;
  /** A longer (or shorter) limit for this one call than the runtime's default, in ms. */
  timeoutMs?: number;
  /** Run without any CLAUDE.md or memory, even when editing (a factory build folder has none of its own). */
  noMemory?: boolean;
  /** Continue this CLI session instead of starting fresh: the agent still has everything it saw and said. */
  resume?: string;
  /** Folders put first on the agent's PATH (a codebase's own tools, such as its Python environment), so its shell finds them. */
  pathFirst?: string[];
  /**
   * The advisor (Claude's advisor tool): a stronger model the agent consults before it commits to an approach and
   * before it declares done. A model alias ("opus") sets it, null turns it off for this call, absent leaves the
   * runtime's rule (see `advisorFor`).
   */
  advisor?: string | null;
  /** SF-115: aborting it ends the call at once (the CLI is killed); a stopped run cuts its call in flight. */
  signal?: AbortSignal;
  /**
   * Called whenever the agent shows a sign of life (a streamed message, a tool call, a tool's result): the
   * supervisor's heartbeat (factory/supervisor.ts). Never called for a runtime that cannot stream.
   */
  onProgress?: () => void;
  /** Awake ms with no output after which the call counts as stuck and is cut (default SF_AGENT_IDLE_MS, 10 minutes). */
  idleMs?: number;
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
  /** The CLI session, so a follow-up can continue the same conversation (--resume). */
  sessionId?: string;
  /** The advisor model this call asked for, if any. */
  advisor?: string;
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
  /**
   * The advisor for working sessions on a cheaper model: "opus" by default, "off" for none (SF_ADVISOR overrides).
   */
  advisor?: string;
  /** Whether the CLI has `--advisor`. Absent: asked once from `claude --help`. */
  advisorSupported?: boolean;
}

/** An agent that edits files in a working copy (a ticket's repo work) rather than answering in its contract. */
export const edits = (req: AgentRequest) => !!req.cwd && !!req.tools?.some((t) => t === "Edit" || t === "Write");

/** Option A of the spike: drive Claude Code headless (`claude -p`). */
/** Longest role kept on the command line; longer ones go on stdin (Windows command lines stop near 32,000 characters). */
const MAX_ARG_ROLE = 8000;

/** Tools an agent may use headless without a prompt: they read the web and change nothing here. */
export const WEB_TOOLS = ["WebSearch", "WebFetch"];
/** Tools that read files. They only make sense in a folder: without one an agent would read the core's own data folder, so they are dropped. */
export const READ_TOOLS = ["Read", "Glob", "Grep"];
/** Tools that touch files: only with a folder, and only in it. */
const FILE_TOOLS = [...READ_TOOLS, "Edit", "Write", "NotebookEdit"];

/** Models the advisor ranks above. An advisor must be at least as capable as the agent it advises. */
const ADVISOR_RANK: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3, fable: 4 };
const rankOf = (model: string): number => {
  const m = model.toLowerCase();
  const hit = Object.keys(ADVISOR_RANK).find((k) => m === k || m.startsWith(`claude-${k}`) || m.startsWith(k));
  return hit ? ADVISOR_RANK[hit] : 0;
};

/**
 * Which advisor a call gets. An explicit request wins (null is off). Otherwise only a working session (an agent with
 * edit tools in a folder: Builder, Fixer, a ticket's repo work) on a cheaper model gets the default advisor: those are
 * long, multi-step turns where a plan check up front and a review before "done" pay back. Short answer-only station
 * calls stay without one. An advisor that is not stronger than the agent's own model is dropped.
 */
export function advisorFor(req: AgentRequest, model: string, fallback: string): string | null {
  if (req.advisor === null) return null;
  const pick = req.advisor ?? (fallback !== "off" && edits(req) ? fallback : null);
  if (!pick || pick === "off") return null;
  const a = rankOf(pick), m = rankOf(model);
  if (req.advisor === undefined && a && m && a <= m) return null;
  return pick;
}

const advisorProbe = new Map<string, boolean>();
/**
 * Ask the CLI once whether it knows `--advisor` (Claude Code added it in 2026; an older CLI refuses the flag and the
 * whole call fails). `--help` does not list it, so the probe passes it with a made-up flag after it: the CLI stops at
 * the first option it does not know, before any model call, and names it.
 */
export function cliHasAdvisor(command: string, commandArgs: string[]): boolean {
  const key = [command, ...commandArgs].join(" ");
  let has = advisorProbe.get(key);
  if (has === undefined) {
    try {
      const r = spawnSync(command, [...commandArgs, "--advisor", "opus", "--sf-advisor-probe", "-p"], { encoding: "utf8", timeout: 15_000, windowsHide: true, input: "" });
      has = /unknown option '--sf-advisor-probe'/.test(`${r.stdout ?? ""}${r.stderr ?? ""}`);
    } catch { has = false; }
    advisorProbe.set(key, has);
  }
  return has;
}

export class ClaudeCodeRuntime implements AgentRuntime {
  readonly name: string;
  private readonly opts: Required<Omit<ClaudeCodeOptions, "advisorSupported">> & { advisorSupported?: boolean };

  constructor(opts: ClaudeCodeOptions = {}) {
    this.opts = {
      command: opts.command ?? (process.env.SF_CLAUDE_JS ? process.execPath : process.env.SF_CLAUDE_BIN ?? "claude"),
      commandArgs: opts.commandArgs ?? (opts.command === undefined && process.env.SF_CLAUDE_JS ? [process.env.SF_CLAUDE_JS] : []),
      profile: opts.profile ?? "lean",
      defaultModel: opts.defaultModel ?? "haiku",
      timeoutMs: opts.timeoutMs ?? Number(process.env.SF_AGENT_TIMEOUT_MS ?? 600_000),
      advisor: opts.advisor ?? process.env.SF_ADVISOR ?? "opus",
      ...(opts.advisorSupported !== undefined ? { advisorSupported: opts.advisorSupported } : {}),
    };
    this.name = `claude-code:${this.opts.profile}`;
  }

  /**
   * The prompt goes in on stdin, never on the command line: Windows caps a command line at
   * about 32,000 characters, and a Fixer prompt with the failing tests and the code is longer
   * ("spawn ENAMETOOLONG"). A very long role moves to stdin too, ahead of the prompt.
   */
  buildArgs(req: AgentRequest): string[] {
    const model = req.model ?? this.opts.defaultModel;
    // stream-json (with --verbose, which it needs) prints a line per message and tool call as the agent works: the
    // heartbeat that tells a stuck call from a busy one. Its last line is the same result object `json` prints.
    // SF_AGENT_STREAM=0 goes back to one JSON at the end (and to a plain time limit).
    const args = ["-p", "--output-format", ...(streams() ? ["stream-json", "--verbose"] : ["json"]), "--model", model];
    const advisor = advisorFor(req, model, this.opts.advisor);
    if (advisor && (this.opts.advisorSupported ?? cliHasAdvisor(this.opts.command, this.opts.commandArgs))) args.push("--advisor", advisor);
    if (req.resume) args.push("--resume", req.resume);
    if (req.budgetUsd !== undefined) args.push("--max-budget-usd", String(req.budgetUsd));
    if (req.systemPrompt && req.systemPrompt.length <= MAX_ARG_ROLE) args.push("--append-system-prompt", req.systemPrompt);
    for (const dir of req.pluginDirs ?? []) args.push("--plugin-dir", dir);
    // --tools takes built-in tools only; an MCP server's tools come from --mcp-config and are allowed by name.
    const shell = !!req.cwd && !!req.commands?.length;
    const builtin = [...new Set([...(req.tools ?? []), ...(shell ? ["Bash"] : [])])].filter((t) => !t.startsWith("mcp__") && (req.cwd || !FILE_TOOLS.includes(t)) && (t !== "Bash" || shell));
    if (this.opts.profile === "lean") args.push("--strict-mcp-config", "--tools", builtin.join(","));
    // Without this an agent sees every skill, plugin, hook and CLAUDE.md the person installed for themselves
    // (130+ on Assaf's PC), not just its own kit. Since the configuration brief (22 Nov 2026) that holds for
    // agents editing a repo too: the crew runs only on what SoftwareFactory gives it. SF_CREW_PERSONAL_SETTINGS=1
    // brings back the old way, where the Builder and Fixer in a person's repo also load the person's settings.
    if (this.opts.profile === "lean" && (!edits(req) || req.ownKitOnly || !(req.personalSettings ?? crewUsesPersonalSettings()))) args.push("--setting-sources", "project,local");
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
    // Auto memory is off for every agent SF starts (SF-19): what an agent should know comes from the Brain and its own
    // memory in SF, never from notes Claude Code keeps on the side, which no one sees and which drift between runs.
    const env: NodeJS.ProcessEnv = edits(req) && !req.noMemory ? { ...base, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } : { ...base, CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };
    return req.pathFirst?.length ? withPathFirst(env, req.pathFirst) : env;
  }

  run(req: AgentRequest): Promise<AgentResult> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const args = this.buildArgs(req);
      const advisor = args.includes("--advisor") ? args[args.indexOf("--advisor") + 1] : undefined;
      const env = this.envFor(req);
      // Claude Code keeps `--advisor` behind a gate on some accounts; a call that passes it opens the gate.
      if (advisor) env.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL = "1";
      const child = spawn(this.opts.command, [...this.opts.commandArgs, ...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env, ...(req.cwd ? { cwd: req.cwd } : {}) });
      // A CLI that dies before reading stdin closes the pipe; the exit code says what happened.
      child.stdin.on("error", () => {});
      child.stdin.end(this.stdinFor(req), "utf8");
      let err = "";
      const limit = req.timeoutMs ?? this.opts.timeoutMs;
      const stream = streams();
      // Lines are read as they come; only the result line is kept, so a long session's tool output is never held.
      const reader = new StreamReader(() => req.onProgress?.());
      // The limits count awake time only (factory/awake.ts): a PC that slept through a call does not kill it on waking
      // (run 10486). With a stream, no output for `idle` means stuck: cut now, do not wait for the limit. A call that is
      // still talking when its limit comes gets more time, up to three times the limit (its money cap still holds).
      const idle = req.idleMs ?? Number(process.env.SF_AGENT_IDLE_MS ?? 600_000);
      const clock = new AwakeClock();
      let finished = false;
      const fail = (e: Error) => { if (finished) return; finished = true; clearInterval(watch); killTree(child, true); reject(e); };
      const watch = setInterval(() => {
        const v = callVerdict({ elapsedMs: clock.elapsed(), idleMs: clock.idle(), limitMs: limit, idleLimitMs: idle, stream });
        if (v) fail(new Error(v));
      }, Math.min(5_000, Math.max(50, Math.floor(Math.min(limit, idle) / 4))));
      watch.unref?.();
      const onAbort = () => { req.signal?.removeEventListener("abort", onAbort); fail(new Error("The run was stopped, so this call was cut.")); };
      if (req.signal?.aborted) onAbort(); else req.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (d) => { clock.beat(); reader.push(String(d)); });
      child.stderr.on("data", (d) => { if (err.length < 20_000) err += d; });
      child.on("error", (e) => fail(e));
      child.on("close", (code) => {
        clearInterval(watch);
        req.signal?.removeEventListener("abort", onAbort);
        if (finished) return;
        finished = true;
        try {
          const r = parseClaudeJson(reader.result(), this.name, Date.now() - started);
          resolve(advisor ? { ...r, advisor } : r);
        } catch (e) {
          reject(Object.assign(new Error(`claude exited ${code}: ${(e as Error).message}${err ? ` | ${err.slice(0, 300)}` : ""}`), { costUsd: (e as { costUsd?: number }).costUsd ?? 0 }));
        }
      });
    });
  }
}

/** An environment with these folders first on its PATH. Windows names the variable "Path": the name it already has is kept. */
export function withPathFirst(env: NodeJS.ProcessEnv, dirs: string[], platform = process.platform): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  return { ...env, [key]: [...dirs, env[key] ?? ""].filter(Boolean).join(platform === "win32" ? ";" : ":") };
}

/** Whether agent calls stream their progress (SF_AGENT_STREAM=0 turns it off). */
export const streams = (env = process.env) => env.SF_AGENT_STREAM !== "0";

/**
 * Why an agent call should be cut now, or null. Pure. Times are awake time. With a stream: no output for the idle
 * limit is stuck; past the time limit the call goes on while it keeps talking, up to three times the limit.
 * Without one (an older CLI or SF_AGENT_STREAM=0) the plain limit holds.
 */
export const CALL_CEILING_TIMES = 3;
export function callVerdict(o: { elapsedMs: number; idleMs: number; limitMs: number; idleLimitMs: number; stream: boolean }): string | null {
  const min = (ms: number) => `${Math.round(ms / 60_000)} minute${Math.round(ms / 60_000) === 1 ? "" : "s"}`;
  if (!o.stream) return o.elapsedMs > o.limitMs ? `Agent timed out after ${o.limitMs} ms` : null;
  if (o.idleMs > o.idleLimitMs) return `Agent stuck: no output for ${min(o.idleMs)}, so the call was cut (it timed out without progress).`;
  if (o.elapsedMs > o.limitMs * CALL_CEILING_TIMES) return `Agent timed out after ${o.limitMs * CALL_CEILING_TIMES} ms (still working at three times its limit).`;
  return null;
}

/**
 * Reads `claude -p` output as it arrives. A stream-json line is a sign of life; the line whose type is "result" is
 * the answer. Plain `json` output (one object, maybe over several chunks) is kept whole and parsed at the end.
 */
export class StreamReader {
  private buf = "";
  private whole = "";
  private last: string | null = null;
  constructor(private onLine: () => void = () => {}) {}
  push(chunk: string): void {
    this.buf += chunk;
    if (this.whole.length < 4_000_000 && this.last === null) this.whole += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      this.line(line);
    }
  }
  private line(line: string) {
    if (!line) return;
    const type = lineType(line);
    if (type === "result") { this.last = line; this.whole = ""; }
    else if (type !== null) this.onLine();
  }
  /** The result line, or else everything read (the one-object format). */
  result(): string {
    if (this.buf.trim()) { const rest = this.buf.trim(); this.buf = ""; if (lineType(rest) === "result") { this.last = rest; this.whole = ""; } }
    return this.last ?? this.whole;
  }
}

/**
 * The "type" of one stream-json line, or null when the line is not a whole JSON object with one. The key's place
 * in the object is not fixed: Claude Code 2.1.328 prints the result line as {"duration_api_ms":…,"type":"result",…},
 * so a check on how the line starts missed it and every call failed to parse (found 2026-11-24).
 */
export function lineType(line: string): string | null {
  if (!line.startsWith("{")) return null;
  if (line.startsWith('{"type":"')) return line.slice(9, line.indexOf('"', 9));
  try {
    const j = JSON.parse(line) as { type?: unknown };
    return typeof j?.type === "string" ? j.type : null;
  } catch {
    return null;
  }
}

/** Parse the JSON that `claude -p --output-format json` prints (or the result line of stream-json: the same object). */
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
    ...(j.session_id ? { sessionId: String(j.session_id) } : {}),
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
    else if (station === "design") text = MOCK.design;
    else if (station === "critique") text = MOCK.critique;
    else if (station === "evaluate") text = MOCK.evaluate;
    else if (station === "review") text = MOCK.review;
    else if (station === "order") text = MOCK.order(req.prompt);
    else if (station === "overseer") text = MOCK.overseer(req.prompt);
    else if (station === "ticket") text = MOCK.ticket(req.prompt);
    else if (station === "repo") text = MOCK.repo(req.prompt);
    else if (station === "map") text = MOCK.map(req.prompt);
    else if (station === "survey") text = MOCK.survey(req.prompt);
    else if (station === "inspect") text = MOCK.inspect(req.prompt);
    else if (station === "verdict") text = MOCK.verdict(req.prompt);
    else if (station === "research") text = MOCK.research(req.prompt);
    return { text, costUsd: role ? 0.0001 : 0, durationMs: this.opts.delayMs ?? 1, models: ["mock"], runtime: this.name, contextTokens: 0 };
  }
}

const MOCK = {
  // The practice reader: a short answer that names what it read, from the question it was asked.
  research: (prompt: string) => `Practice crew: this is where the answer to "${(prompt.match(/^#\s*(.+)$/m)?.[1] ?? prompt.split("\n")[0]).slice(0, 100)}" goes. The real crew reads the repo and answers in plain words.\n\nFiles read: README.md`,
  // The practice Designer and Critic: fixed documents that fit the practice plan, and a pass on the first round.
  design: "```json\n" + JSON.stringify({
    brief: { who: "Someone trying the practice crew.", problem: "They want to see the whole loop run without paying for it.", promise: "A tiny app that shows the loop end to end.", notThis: ["a real design: switch to the real crew for that"] },
    research: [{ finding: "The practice crew cannot search the web." }],
    journeys: [{ moment: "First time", goal: "See it work", steps: ["Open the app", "Look at the home screen", "Add a record"] }],
    screens: [{ id: "dashboard", name: "Home", purpose: "Shows what the logic works out.", shows: ["the result"], actions: ["add a record"] }, { id: "history", name: "History", purpose: "Shows what was done before.", shows: ["past records"], actions: ["open one"] }],
    requirements: [{ id: "R1", text: "It does what the idea says.", from: "person", must: true }],
    rules: [{ name: "Order", rule: "Items are listed newest first; ties keep the order they were added in." }],
    assumptions: ["Practice crew: nothing was researched."],
  }) + "\n```",
  evaluate: "```json\n" + JSON.stringify({ requirements: [{ id: "R1", met: true, evidence: "Practice crew: the home screen shows it." }], scores: { function: 4, design: 4, content: 4 }, problems: [] }) + "\n```",
  critique: "```json\n" + JSON.stringify({ scores: { coverage: 4, journey: 4, screens: 4, originality: 4, buildable: 5 }, problems: [] }) + "\n```",
  // The practice crew cannot read a codebase; it leaves a note file on the branch so the whole path can be tried for free.
  repo: (prompt: string) => {
    // The work document starts "# SF-4 Title" (a project's key and number) or "# #4 Title".
    const head = prompt.match(/^# (?:#|[A-Z][A-Z0-9]*-)(\d+) (.*)$/m);
    // An engine run in a repo names its ticket in the ask ("... (ticket LP-3)") and its plan in the first line.
    const id = head?.[1] ?? prompt.match(/\(ticket (?:#|[A-Z][A-Z0-9]*-)(\d+)\)/)?.[1] ?? "0";
    const title = head?.[2] ?? prompt.match(/^You are building "([^"]+)"/)?.[1] ?? "the ticket";
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
  // The practice Inspector and Assessor: canned answers in the right shape, built from the routes the evidence names.
  inspect: (prompt: string) => {
    const routes = [...prompt.matchAll(/^\s+(GET|POST|PUT|DELETE|ANY) (\/\S*)\s+\[([^\]:]+)/gm)].slice(0, 6);
    const steps = routes.map((m, i) => ({ id: `s${i + 1}`, name: `${m[1]} ${m[2]}`, kind: m[1] === "GET" ? "page" : "api", route: m[2], what: `Mock: handled in ${m[3]}.`, state: "code-only" }));
    return "```json\n" + JSON.stringify({
      purpose: "Mock purpose: an app read by the practice Inspector.", users: "Mock users.", usage: "Mock usage.", stack: "Mock stack.",
      features: steps.map((x) => ({ id: x.id, name: x.name, what: x.what, where: [], state: "unknown" })),
      flow: { steps, links: steps.slice(1).map((x) => ({ from: steps[0].id, to: x.id })) }, data: [], integrations: [], unsure: ["Mock: what it is really for."],
    }) + "\n```";
  },
  verdict: (prompt: string) => {
    const v = {
      headline: "Mock verdict: keep it and fix the short list.",
      scores: { codeHealth: { score: 60, why: "Mock." }, goalFit: { score: 70, why: "Mock." }, costToFix: { score: 30, why: "Mock." } },
      recommendation: { call: "keep", confidence: "low", why: "Mock reasons.", ifKeep: "Fix the list.", ifRewrite: "Carry the features over." },
      stack: { call: "keep", advice: "Mock: keep the stack.", suite: "Mock: fits." }, gaps: [{ title: "Mock gap", detail: "A step the purpose needs is missing.", level: "medium" }], strengths: ["Mock strength."],
      nextSteps: [{ title: "Add a test for the main flow", body: "Mock: nothing checks the main flow.", kind: "improvement", lens: "tests", severity: "medium", effort: "small", files: [] }],
      questions: /TASK: revise/.test(prompt) ? [] : [{ id: "Q1", question: "Who uses this app?", why: "It decides how careful a change must be.", guess: "Mock users." }],
    };
    if (!/TASK: revise/.test(prompt)) return "```json\n" + JSON.stringify(v) + "\n```";
    const said = prompt.match(/the owner (?:answered|corrects): (.+)$/m)?.[1] ?? "what the owner said";
    return "```json\n" + JSON.stringify({ understanding: { purpose: `Mock purpose, revised: ${said}`, users: said, usage: "Mock usage.", stack: "Mock stack.", features: [], flow: { steps: [], links: [] }, data: [], integrations: [], unsure: [] }, verdict: { ...v, headline: "Mock verdict, revised with what the owner said." } }) + "\n```";
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
export const features = [{ name: "Progress", purpose: "Shows every piece against its word goal", flow: ["Open the app", "Read each piece's bar"], where: "home" }, { name: "Quick count", purpose: "Counts any text as you type it", flow: ["Type or paste text", "Read the count"], where: "home" }];
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

/** True only when SF_CREW_PERSONAL_SETTINGS=1: the Builder and Fixer in a person's repo load the person's own Claude Code settings. */
export function crewUsesPersonalSettings(env = process.env): boolean {
  return env.SF_CREW_PERSONAL_SETTINGS === "1";
}

export function runtimeFromEnv(env = process.env): AgentRuntime {
  const kind = env.SF_RUNTIME ?? "mock";
  if (kind === "claude-code" || kind === "claude-code:lean") return new ClaudeCodeRuntime({ profile: "lean" });
  if (kind === "claude-code:full") return new ClaudeCodeRuntime({ profile: "full" });
  return new MockRuntime({ delayMs: Number(env.SF_MOCK_DELAY_MS ?? 700) });
}
