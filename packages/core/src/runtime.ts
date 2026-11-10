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
      command: opts.command ?? process.env.SF_CLAUDE_BIN ?? "claude",
      profile: opts.profile ?? "lean",
      defaultModel: opts.defaultModel ?? "haiku",
      timeoutMs: opts.timeoutMs ?? 180_000,
    };
    this.name = `claude-code:${this.opts.profile}`;
  }

  buildArgs(req: AgentRequest): string[] {
    const args = ["-p", req.prompt, "--output-format", "json", "--model", req.model ?? this.opts.defaultModel];
    if (req.budgetUsd !== undefined) args.push("--max-budget-usd", String(req.budgetUsd));
    if (req.systemPrompt) args.push("--append-system-prompt", req.systemPrompt);
    for (const dir of req.pluginDirs ?? []) args.push("--plugin-dir", dir);
    if (this.opts.profile === "lean") args.push("--strict-mcp-config", "--tools", "");
    return args;
  }

  run(req: AgentRequest): Promise<AgentResult> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.command, this.buildArgs(req), { stdio: ["ignore", "pipe", "pipe"] });
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

/** Deterministic runtime for tests and offline UI work. Costs nothing. */
export class MockRuntime implements AgentRuntime {
  readonly name = "mock";
  calls: AgentRequest[] = [];
  async run(req: AgentRequest): Promise<AgentResult> {
    this.calls.push(req);
    return {
      text: `Overseer (mock) received: ${req.prompt.slice(0, 80)}`,
      costUsd: 0,
      durationMs: 1,
      models: ["mock"],
      runtime: this.name,
      contextTokens: 0,
    };
  }
}

export function runtimeFromEnv(env = process.env): AgentRuntime {
  const kind = env.SF_RUNTIME ?? "mock";
  if (kind === "claude-code" || kind === "claude-code:lean") return new ClaudeCodeRuntime({ profile: "lean" });
  if (kind === "claude-code:full") return new ClaudeCodeRuntime({ profile: "full" });
  return new MockRuntime();
}
