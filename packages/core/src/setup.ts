import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { ClaudeCodeRuntime, MockRuntime, type AgentRequest, type AgentResult, type AgentRuntime } from "./runtime.js";

/**
 * First-run setup: what this machine has, in a form the Bridge can explain.
 * Every check here is free (no model call): it only looks for programs and
 * asks them for their version.
 */

export type CrewMode = "practice" | "real";

export interface ToolCheck { found: boolean; path?: string; version?: string; hint: string }

export interface SetupReport {
  mode: CrewMode;
  runtime: string;
  node: { version: string; ok: boolean; path: string };
  claude: ToolCheck;
  git: ToolCheck;
  /** Can a real factory run start right now? If not, why, in one sentence. */
  realReady: boolean;
  blocker?: string;
}

/**
 * Find Claude Code in a form the core can spawn directly. The native install is
 * `claude` (`claude.exe` on Windows); an npm install on Windows is a `claude.cmd`
 * shim that cannot be spawned, so its `cli.js` is run with this Node instead.
 * Same search as the desktop shell, so a Claude Code installed after the app
 * started is found by "Check again" without a restart.
 */
export function findClaude(env: NodeJS.ProcessEnv = process.env): { bin?: string; js?: string } | null {
  if (env.SF_CLAUDE_JS && isFile(env.SF_CLAUDE_JS)) return { js: env.SF_CLAUDE_JS };
  if (env.SF_CLAUDE_BIN && isFile(env.SF_CLAUDE_BIN)) return { bin: env.SF_CLAUDE_BIN };
  const win = process.platform === "win32";
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const home = env.USERPROFILE ?? env.HOME;
  if (home) dirs.push(join(home, ".local", "bin"), join(home, ".claude", "local"));
  if (env.APPDATA) dirs.push(join(env.APPDATA, "npm"));
  const exe = win ? "claude.exe" : "claude";
  for (const d of dirs) if (isFile(join(d, exe))) return { bin: join(d, exe) };
  for (const d of dirs) {
    const js = join(d, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    if (isFile(join(d, "claude.cmd")) && isFile(js)) return { js };
  }
  return null;
}

function isFile(p: string) {
  try { return statSync(p).isFile(); } catch { return false; }
}

function versionOf(cmd: string, args: string[]): string | undefined {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15_000, windowsHide: true });
    if (r.status !== 0) return undefined;
    return (r.stdout || r.stderr).trim().split("\n")[0].slice(0, 80);
  } catch { return undefined; }
}

export function checkClaude(env: NodeJS.ProcessEnv = process.env): ToolCheck {
  const hint = "Install Claude Code (claude.com/claude-code), open a terminal, run `claude` once and sign in, then press Check again.";
  const c = findClaude(env);
  if (!c) return { found: false, hint };
  const path = c.bin ?? c.js!;
  const version = c.bin ? versionOf(c.bin, ["--version"]) : versionOf(process.execPath, [c.js!, "--version"]);
  return { found: true, path, version, hint: version ? "Found. Real runs use your Claude Code sign-in; every call has a spend cap." : "Found, but it did not answer `--version`. " + hint };
}

export function checkGit(): ToolCheck {
  const version = versionOf("git", ["--version"]);
  return version
    ? { found: true, version, hint: "Found. Every shipped app is a git repo with a tagged commit." }
    : { found: false, hint: "Install Git for Windows (git-scm.com/download/win), then press Check again. The factory keeps every app it builds in a git repo." };
}

export function nodeCheck() {
  const [maj, min] = process.versions.node.split(".").map(Number);
  return { version: process.versions.node, ok: maj > 22 || (maj === 22 && min >= 5), path: process.execPath };
}

/** The runtime for a crew mode, with the Claude Code location found on this machine. */
export function runtimeFor(mode: CrewMode, env: NodeJS.ProcessEnv = process.env): AgentRuntime {
  if (mode === "practice") return new MockRuntime({ delayMs: Number(env.SF_MOCK_DELAY_MS ?? 700) });
  const c = findClaude(env);
  const profile = env.SF_RUNTIME === "claude-code:full" ? "full" : "lean";
  if (c?.js) return new ClaudeCodeRuntime({ profile, command: process.execPath, commandArgs: [c.js] });
  return new ClaudeCodeRuntime({ profile, command: c?.bin ?? "claude" });
}

/**
 * The crew's runtime, switchable while the app runs: Practice (the free mock
 * crew) or Real (Claude Code). Everything holds this one object, so a switch
 * applies to the next agent call; a factory run keeps the runtime it started on.
 */
export class SwitchableRuntime implements AgentRuntime {
  constructor(public current: AgentRuntime, public mode: CrewMode) {}
  get name() { return this.current.name; }
  run(req: AgentRequest): Promise<AgentResult> { return this.current.run(req); }
  switchTo(mode: CrewMode, env: NodeJS.ProcessEnv = process.env) {
    this.current = runtimeFor(mode, env);
    this.mode = mode;
  }
}

export function modeOf(runtime: AgentRuntime): CrewMode {
  return runtime.name === "mock" ? "practice" : "real";
}

let checked: { at: number; claude: ToolCheck; git: ToolCheck } | null = null;

/** What this computer has. The program checks are remembered for 30 s unless `fresh` ("Check again"). */
export function setupReport(runtime: AgentRuntime, fresh = false): SetupReport {
  if (fresh || !checked || Date.now() - checked.at > 30_000) checked = { at: Date.now(), claude: checkClaude(), git: checkGit() };
  const { claude, git } = checked;
  const node = nodeCheck();
  const mode = runtime instanceof SwitchableRuntime ? runtime.mode : modeOf(runtime);
  const blocker = !git.found ? "Git is not installed, so the factory cannot keep the app it builds in a repo."
    : !claude.found ? "Claude Code is not installed, so only the free practice crew can work."
    : undefined;
  return { mode, runtime: runtime.name, node, claude, git, realReady: !blocker, blocker };
}

/**
 * Turn a raw agent failure into something a person can act on. The raw text
 * stays in the log; this is what the Bridge shows first.
 */
export function explainAgentError(raw: string): string {
  const t = raw.toLowerCase();
  if (/enoent|not recognized|command not found|spawn .*claude/.test(t)) return "Claude Code was not found on this computer. Install it and sign in, or switch to the practice crew.";
  if (/invalid api key|please run \/login|not logged in|authentication|unauthorized|oauth/.test(t)) return "Claude Code is installed but not signed in. Open a terminal, run `claude`, sign in, then try again.";
  if (/max-budget|budget/.test(t) && /exceed|reached|spent/.test(t)) return "This call hit its spend cap and was stopped. Raise the agent's cap in the Agent Bay if this keeps happening.";
  if (/timed out/.test(t)) return "The agent took too long and was stopped. Try again, or pick a faster model for that agent.";
  if (/rate limit|overloaded|529|429/.test(t)) return "Claude is busy right now (rate limit). Wait a minute and try again.";
  return raw;
}

