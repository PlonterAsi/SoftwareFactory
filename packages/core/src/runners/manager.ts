import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { hideTokens, parseGitHubRepo, type GitHubRepo } from "../tickets/github.js";

/**
 * Build runners: SoftwareFactory's own manager for GitHub Actions runners on this PC, so a
 * repository's checks and builds run here, free, instead of on GitHub's machines.
 *
 * A runner is GitHub's own program (actions/runner) in a folder of its own. This module
 * downloads it (checksum checked), registers it on a repository, starts it, keeps it running
 * (a runner that ends by itself starts again after 5 s, doubling to 5 min), reads the jobs it
 * takes from what it prints, and stops it with everything it started. Every runner the core
 * starts ends with the core: nothing is left behind (a leftover from a core that was killed is
 * ended at the next start).
 *
 * It belongs to the app, not to a base: runners keep working when you switch bases. Its files
 * are in `<home>/runners/`: `runners.json` (the list), `jobs.json` (the last jobs),
 * `logs/<id>.log`, `cache/` (the downloaded runner program).
 *
 * The GitHub token (a one-time registration token, and the token used to ask for it) is held in
 * memory only: never written to a file or a log.
 */

export type RunnerState = "not-set-up" | "setting-up" | "off" | "starting" | "idle" | "busy" | "waiting" | "stopping";

export interface RunnerConfig {
  id: string;
  /** owner/name */
  repo: string;
  /** Its name on GitHub. */
  name: string;
  /** Extra labels (GitHub adds self-hosted, the system and the CPU). */
  labels: string[];
  dir: string;
  /** Starts with the app. Stop turns it off; Start turns it on. */
  on: boolean;
  createdAt: string;
}

export interface RunnerJob {
  runner: string;
  repo: string;
  name: string;
  startedAt: string;
  endedAt: string | null;
  /** Succeeded, Failed, Canceled; "cut off" when the runner was stopped mid-job. */
  result: string | null;
}

export interface RunnerLine { n: number; ts: string; text: string }

export interface RunnerView extends RunnerConfig {
  state: RunnerState;
  /** A sentence for the state: why it waits, what set-up is doing, what went wrong. */
  note: string | null;
  pid: number | null;
  runningSince: string | null;
  restarts: number;
  retryInSecs: number | null;
  job: string | null;
  version: string | null;
  registered: boolean;
  /** What a workflow writes in `runs-on` to land here. */
  runsOn: string[];
  log: string;
  lines: number;
}

interface Live {
  cfg: RunnerConfig;
  state: RunnerState;
  note: string | null;
  proc: ChildProcess | null;
  startedAt: number | null;
  delay: number;
  timer: NodeJS.Timeout | null;
  retryAt: number | null;
  restarts: number;
  job: RunnerJob | null;
  version: string | null;
  out: RunnerLine[];
  n: number;
  partial: string;
}

export interface RunnerManagerOptions {
  /** The app's data folder. */
  home: string;
  /** A GitHub token that may administer the repository, or null. Asked each time, never stored. */
  token?: () => string | null;
  fetch?: typeof fetch;
  api?: string;
  /** How a runner folder is started. Tests pass their own. */
  runCommand?: (dir: string) => { cmd: string; args: string[] };
  /** How a runner folder is configured (registered, removed). Tests pass their own. */
  configCommand?: (dir: string, args: string[]) => { cmd: string; args: string[] };
  /** Restart waits in ms: first, and the most. Tests shorten them. */
  backoff?: { first: number; max: number; settled: number };
  platform?: NodeJS.Platform;
  /** Whether this PC can run a disposable Windows Sandbox. Tests pass their own. */
  sandbox?: () => boolean;
}

const MAX_LINES = 2000;
const LOG_MAX = 5_000_000;
const SECRET = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|SESSION_?KEY|AUTH)/i;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\r/g;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
/** The label every runner this app sets up carries, so a workflow can ask for "a runner SoftwareFactory manages". */
export const SF_LABEL = "sf-build";
/** The repository variable a workflow reads to choose its machine: set = this PC, deleted = GitHub's machines. */
export const ROUTE_VARIABLE = "CI_WINDOWS";
/**
 * The same for jobs that must not run in your own Windows account (a test that reinstalls an app):
 * the workflow runs those inside a disposable Windows Sandbox, so it is set only when this PC has one.
 */
export const ISOLATED_VARIABLE = "CI_SMOKE";

const isLive = (s: RunnerState) => s === "starting" || s === "idle" || s === "busy";
const now = () => new Date().toISOString();

/** GitHub's name for this system in a runner download and in the labels it gives a runner. */
export function runnerPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch) {
  const os = platform === "win32" ? "win" : platform === "darwin" ? "osx" : "linux";
  const cpu = arch === "arm64" ? "arm64" : "x64";
  return { asset: `${os}-${cpu}`, ext: os === "win" ? "zip" : "tar.gz", labels: ["self-hosted", os === "win" ? "Windows" : os === "osx" ? "macOS" : "Linux", cpu.toUpperCase()] };
}

/** The checksum GitHub publishes for a runner download, from the release notes. */
export function shaFromRelease(body: string, asset: string): string | null {
  const m = String(body ?? "").match(new RegExp(`<!-- BEGIN SHA ${asset} -->\\s*([a-fA-F0-9]{64})\\s*<!-- END SHA ${asset} -->`));
  return m ? m[1].toLowerCase() : null;
}

/** What a runner said, read for the jobs it takes: "Running job: build", "Job build completed with result: Succeeded". */
export function readRunnerLine(text: string): { kind: "listening" } | { kind: "job-start"; name: string } | { kind: "job-end"; name: string; result: string } | { kind: "version"; version: string } | null {
  let m = text.match(/Running job: (.+)$/);
  if (m) return { kind: "job-start", name: m[1].trim() };
  m = text.match(/Job (.+) completed with result: (\w+)/);
  if (m) return { kind: "job-end", name: m[1].trim(), result: m[2] };
  if (/Listening for Jobs/.test(text)) return { kind: "listening" };
  m = text.match(/Current runner version: '([^']+)'/);
  if (m) return { kind: "version", version: m[1] };
  return null;
}

/** The checks a new runner must pass before anything is downloaded. Empty when it is fine. */
export function runnerProblems(input: { repo: string; name: string; labels: string[]; dir: string }, others: RunnerConfig[], platform: NodeJS.Platform = process.platform): string[] {
  const out: string[] = [];
  if (!parseGitHubRepo(input.repo)) out.push("Give the repository as owner/name, for example PlonterAsi/SoftwareFactory.");
  if (!NAME_RE.test(input.name)) out.push("The runner's name takes letters, digits, dashes, dots and underscores.");
  if (input.labels.some((l) => !NAME_RE.test(l))) out.push("Labels are single words: letters, digits, dashes, dots and underscores.");
  const d = input.dir.trim();
  if (!d) out.push("Give the runner a folder of its own.");
  else if (/[\s"']/.test(d)) out.push("The folder's path cannot hold spaces or quotes: GitHub's runner breaks on them. For example C:\\sf-runners\\softwarefactory.");
  else if (platform === "win32" && !/^[A-Za-z]:\\/.test(d)) out.push("Give the folder as a full path, for example C:\\sf-runners\\softwarefactory.");
  else if (platform === "win32" && d.length > 60) out.push("Keep the folder's path short (60 characters at most): builds make long paths inside it, and Windows has a limit.");
  if (others.some((r) => resolve(r.dir).toLowerCase() === resolve(d || ".").toLowerCase())) out.push("Another runner already lives in that folder.");
  if (others.some((r) => r.repo.toLowerCase() === input.repo.toLowerCase() && r.name.toLowerCase() === input.name.toLowerCase())) out.push(`${input.repo} already has a runner called ${input.name} here.`);
  return out;
}

/** A folder for a repository's runner that is short and has no spaces. */
export function suggestRunnerDir(repo: string, platform: NodeJS.Platform = process.platform): string {
  const short = (parseGitHubRepo(repo)?.name ?? "runner").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "runner";
  return platform === "win32" ? `C:\\sf-runners\\${short}` : join(homedir(), "sf-runners", short);
}

/** End a process and everything it started. */
function killTree(pid: number, platform: NodeJS.Platform) {
  if (platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
  else { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } }
}

/** Where Git's own bash is on Windows, so a job's `shell: bash` never finds the WSL one in System32. */
function gitBashDir(): string | null {
  const guesses = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs")]
    .filter(Boolean).map((p) => join(p as string, "Git", "bin"));
  try {
    const r = spawnSync("where", ["git"], { windowsHide: true, encoding: "utf8", timeout: 5000 });
    const first = String(r.stdout ?? "").split(/\r?\n/).find((l) => l.trim());
    if (r.status === 0 && first) guesses.unshift(join(dirname(dirname(first.trim())), "bin"));
  } catch { /* no where */ }
  return guesses.find((g) => existsSync(join(g, "bash.exe"))) ?? null;
}

export class RunnerManager {
  private live = new Map<string, Live>();
  private jobs: RunnerJob[] = [];
  private readonly dir: string;
  private readonly platform: NodeJS.Platform;
  private readonly backoff: { first: number; max: number; settled: number };
  private awake: ChildProcess | null = null;
  private closed = false;
  private onExit = () => this.stopAll();

  constructor(private o: RunnerManagerOptions) {
    this.dir = join(o.home, "runners");
    this.platform = o.platform ?? process.platform;
    this.backoff = o.backoff ?? { first: 5_000, max: 300_000, settled: 600_000 };
    mkdirSync(join(this.dir, "logs"), { recursive: true });
    try { this.jobs = JSON.parse(readFileSync(join(this.dir, "jobs.json"), "utf8")); } catch { this.jobs = []; }
    // A job still open in the file belonged to a core that stopped: its runner went with it.
    for (const j of this.jobs) if (!j.endedAt) { j.endedAt = now(); j.result = "cut off"; }
    for (const cfg of this.read()) this.live.set(cfg.id, this.slot(cfg));
    process.once("exit", this.onExit);
  }

  /** Start every runner that is on. Called once, when the core starts. */
  startAll() {
    for (const l of this.live.values()) if (l.cfg.on && this.registered(l.cfg.dir)) this.launch(l);
  }

  // ----- the list -----

  private get file() { return join(this.dir, "runners.json"); }
  private read(): RunnerConfig[] {
    try { const j = JSON.parse(readFileSync(this.file, "utf8")); return Array.isArray(j.runners) ? j.runners : []; } catch { return []; }
  }
  private save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, runners: [...this.live.values()].map((l) => l.cfg) }, null, 2));
    renameSync(tmp, this.file);
  }
  private saveJobs() {
    this.jobs = this.jobs.slice(-200);
    try { writeFileSync(join(this.dir, "jobs.json"), JSON.stringify(this.jobs, null, 1)); } catch { /* shown live anyway */ }
  }
  private slot(cfg: RunnerConfig): Live {
    return { cfg, state: this.registered(cfg.dir) ? "off" : "not-set-up", note: null, proc: null, startedAt: null, delay: 0, timer: null, retryAt: null, restarts: 0, job: null, version: null, out: [], n: 0, partial: "" };
  }
  private get(id: string): Live {
    const l = this.live.get(id);
    if (!l) throw Object.assign(new Error(`No runner "${id}"`), { status: 404 });
    return l;
  }
  private registered(dir: string) { return existsSync(join(dir, ".runner")); }
  logPath(id: string) { return join(this.dir, "logs", `${id}.log`); }

  private view(l: Live): RunnerView {
    const registered = this.registered(l.cfg.dir);
    const state: RunnerState = !registered && (l.state === "off" || l.state === "not-set-up") ? "not-set-up" : l.state === "not-set-up" && registered ? "off" : l.state;
    return {
      ...l.cfg, state, note: l.note, pid: l.proc?.pid ?? null,
      runningSince: l.startedAt ? new Date(l.startedAt).toISOString() : null, restarts: l.restarts,
      retryInSecs: l.retryAt ? Math.max(0, Math.round((l.retryAt - Date.now()) / 1000)) : null,
      job: l.job?.name ?? null, version: l.version, registered,
      runsOn: [...runnerPlatform(this.platform).labels.slice(0, 2), ...l.cfg.labels],
      log: this.logPath(l.cfg.id), lines: l.n,
    };
  }

  list(): RunnerView[] { return [...this.live.values()].map((l) => this.view(l)); }
  one(id: string): RunnerView { return this.view(this.get(id)); }
  recentJobs(limit = 50): RunnerJob[] { return this.jobs.slice(-limit).reverse(); }
  /** Jobs running on this PC right now. The app does not update itself over them. */
  busyCount(): number { return [...this.live.values()].filter((l) => l.state === "busy").length; }
  linesAfter(id: string, after = 0): RunnerLine[] { return this.get(id).out.filter((x) => x.n > after); }
  suggest(repo: string) {
    const g = parseGitHubRepo(repo);
    return { dir: suggestRunnerDir(repo, this.platform), name: `sf-${(g?.name ?? "runner").toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 30)}`, labels: [SF_LABEL] };
  }

  // ----- output -----

  private say(l: Live, text: string) {
    const clean = hideTokens(text.replace(ANSI, "")).slice(0, 2000);
    const line = { n: ++l.n, ts: now(), text: clean };
    l.out.push(line);
    if (l.out.length > MAX_LINES) l.out.splice(0, l.out.length - MAX_LINES);
    const file = this.logPath(l.cfg.id);
    try {
      try { if (statSync(file).size > LOG_MAX) renameSync(file, `${file}.1`); } catch { /* no log yet */ }
      appendFileSync(file, `${line.ts} ${clean}\n`);
    } catch { /* the log is a convenience; the line is in memory */ }
  }

  private feed(l: Live, chunk: string) {
    const parts = (l.partial + chunk).split("\n");
    l.partial = parts.pop() ?? "";
    for (const raw of parts) {
      const text = raw.replace(ANSI, "").trimEnd();
      if (!text.trim()) continue;
      this.say(l, text);
      const what = readRunnerLine(text);
      if (!what) continue;
      if (what.kind === "version") l.version = what.version;
      else if (what.kind === "listening") { if (l.state === "starting") l.state = "idle"; l.note = null; }
      else if (what.kind === "job-start") {
        l.state = "busy";
        l.job = { runner: l.cfg.name, repo: l.cfg.repo, name: what.name, startedAt: now(), endedAt: null, result: null };
        this.jobs.push(l.job); this.saveJobs(); this.holdAwake();
      } else if (what.kind === "job-end") {
        if (l.job) { l.job.endedAt = now(); l.job.result = what.result; }
        l.job = null; this.saveJobs();
        if (l.state === "busy") l.state = "idle";
        this.holdAwake();
      }
    }
  }

  // ----- running -----

  /** The environment a runner gets: yours without secrets or this app's own settings, with Git's bash and Rust's tools on PATH. */
  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || SECRET.test(k) || k.startsWith("SF_")) continue;
      // A shell that sets this (Claude Code's does) stops cmd finding run.cmd in its own folder.
      if (k.toLowerCase() === "nodefaultcurrentdirectoryinexepath") continue;
      env[k] = v;
    }
    if (this.platform === "win32") {
      const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "Path";
      const extra = [gitBashDir(), join(homedir(), ".cargo", "bin")].filter((p): p is string => !!p && existsSync(p));
      env[key] = [...extra, env[key] ?? ""].filter(Boolean).join(delimiter);
    }
    return env;
  }

  private command(dir: string) {
    if (this.o.runCommand) return this.o.runCommand(dir);
    return this.platform === "win32" ? { cmd: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/c", "run.cmd"] } : { cmd: "/bin/bash", args: ["run.sh"] };
  }
  private configCommand(dir: string, args: string[]) {
    if (this.o.configCommand) return this.o.configCommand(dir, args);
    return this.platform === "win32" ? { cmd: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/c", "config.cmd", ...args] } : { cmd: "/bin/bash", args: ["config.sh", ...args] };
  }

  /** A runner of ours left running by a core that was killed: end it, so two never fight over one registration. */
  private endLeftover(l: Live) {
    const file = join(this.dir, `${l.cfg.id}.pid`);
    let pid = 0;
    try { pid = Number(readFileSync(file, "utf8").trim()); } catch { return; }
    if (!(pid > 0)) return;
    try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EPERM") return; }
    this.say(l, `Ending a runner left over from before (pid ${pid}).`);
    killTree(pid, this.platform);
  }

  private launch(l: Live) {
    if (this.closed || l.proc) return;
    if (l.timer) { clearTimeout(l.timer); l.timer = null; }
    l.retryAt = null;
    if (!this.registered(l.cfg.dir)) { l.state = "not-set-up"; l.note = "It is not registered on GitHub yet. Press Set up."; return; }
    this.endLeftover(l);
    const { cmd, args } = this.command(l.cfg.dir);
    this.say(l, `Starting runner ${l.cfg.name} for ${l.cfg.repo}.`);
    let proc: ChildProcess;
    try {
      proc = spawn(cmd, args, { cwd: l.cfg.dir, env: this.env(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: this.platform !== "win32" });
    } catch (e) { this.failedStart(l, (e as Error).message); return; }
    l.proc = proc;
    l.state = "starting";
    l.note = null;
    l.startedAt = Date.now();
    if (proc.pid) { try { writeFileSync(join(this.dir, `${l.cfg.id}.pid`), String(proc.pid)); } catch { /* only for leftovers */ } }
    proc.stdout?.setEncoding("utf8").on("data", (c: string) => this.feed(l, c));
    proc.stderr?.setEncoding("utf8").on("data", (c: string) => this.feed(l, c));
    proc.on("error", (e) => { if (l.proc === proc) { l.proc = null; this.failedStart(l, e.message); } });
    proc.on("exit", (code) => {
      if (l.proc !== proc) return;
      l.proc = null;
      const ran = l.startedAt ? Date.now() - l.startedAt : 0;
      l.startedAt = null;
      if (l.job) { l.job.endedAt = now(); l.job.result = "cut off"; l.job = null; this.saveJobs(); }
      this.holdAwake();
      if (l.state === "stopping" || !l.cfg.on || this.closed) { l.state = "off"; return; }
      l.restarts++;
      l.delay = ran >= this.backoff.settled ? this.backoff.first : Math.min(this.backoff.max, l.delay ? l.delay * 2 : this.backoff.first);
      this.say(l, `The runner ended by itself (code ${code ?? "none"}). Starting it again in ${Math.round(l.delay / 1000)} s.`);
      this.waitThenLaunch(l, `It ended by itself (code ${code ?? "none"}).`);
    });
  }

  private failedStart(l: Live, why: string) {
    l.delay = Math.min(this.backoff.max, l.delay ? l.delay * 2 : this.backoff.first);
    this.say(l, `Could not start the runner: ${why}`);
    this.waitThenLaunch(l, `It could not start: ${why}`);
  }
  private waitThenLaunch(l: Live, note: string) {
    l.state = "waiting";
    l.note = note;
    l.retryAt = Date.now() + l.delay;
    l.timer = setTimeout(() => { l.timer = null; if (l.cfg.on) this.launch(l); }, l.delay);
    l.timer.unref();
  }

  /** Turn a runner on: it starts now and is kept running. */
  start(id: string): RunnerView {
    const l = this.get(id);
    if (!this.registered(l.cfg.dir)) throw Object.assign(new Error("This runner is not registered on GitHub yet. Press Set up first."), { status: 409 });
    if (l.state === "setting-up") throw Object.assign(new Error("It is still being set up."), { status: 409 });
    l.cfg.on = true; l.delay = 0; this.save();
    if (!isLive(l.state)) this.launch(l);
    return this.view(l);
  }

  /** Turn a runner off, with everything it started. A job running on it is cut off and shows as failed on GitHub. */
  stop(id: string): RunnerView {
    const l = this.get(id);
    l.cfg.on = false; this.save();
    this.halt(l, "Stopped from SoftwareFactory.");
    return this.view(l);
  }

  restart(id: string): RunnerView {
    const l = this.get(id);
    this.halt(l, "Restarting.");
    l.cfg.on = true; l.delay = 0; this.save();
    this.launch(l);
    return this.view(l);
  }

  private halt(l: Live, why: string) {
    if (l.timer) { clearTimeout(l.timer); l.timer = null; }
    l.retryAt = null;
    const proc = l.proc;
    if (proc?.pid) {
      l.state = "stopping";
      l.proc = null;
      this.say(l, why);
      killTree(proc.pid, this.platform);
      if (l.job) { l.job.endedAt = now(); l.job.result = "cut off"; l.job = null; this.saveJobs(); }
    }
    l.startedAt = null;
    l.state = this.registered(l.cfg.dir) ? "off" : "not-set-up";
    l.note = null;
    this.holdAwake();
  }

  /** Stop everything this app started (the core is closing). Runners that were on start again next time. */
  stopAll() {
    this.closed = true;
    for (const l of this.live.values()) {
      if (l.timer) { clearTimeout(l.timer); l.timer = null; }
      if (l.proc?.pid) { killTree(l.proc.pid, this.platform); l.proc = null; }
    }
    if (this.awake?.pid) { try { this.awake.kill(); } catch { /* gone */ } this.awake = null; }
  }
  dispose() { this.stopAll(); process.removeListener("exit", this.onExit); }

  /** While a job runs here, Windows is asked not to fall asleep on its own; it may again once the job is done. */
  private holdAwake() {
    if (this.platform !== "win32") return;
    const busy = this.busyCount() > 0 && !this.closed;
    if (busy && !this.awake) {
      const ps = "$t = Add-Type -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);' -Name Awake -Namespace SF -PassThru; while ($true) { [void]$t::SetThreadExecutionState([uint32]2147483649); Start-Sleep -Seconds 30 }";
      try {
        this.awake = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, stdio: "ignore" });
        this.awake.on("exit", () => { this.awake = null; });
        this.awake.on("error", () => { this.awake = null; });
      } catch { this.awake = null; }
    } else if (!busy && this.awake) {
      try { this.awake.kill(); } catch { /* gone */ }
      this.awake = null;
    }
  }

  /** Windows Sandbox is turned on here, so jobs that need an isolated Windows can run on this PC. */
  hasSandbox(): boolean {
    if (this.o.sandbox) return this.o.sandbox();
    return this.platform === "win32" && existsSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsSandbox.exe"));
  }

  // ----- GitHub -----

  private tokenAt: { at: number; t: string | null } | null = null;
  /** The GitHub sign-in, asked at most once a minute (asking the GitHub CLI starts a process). Memory only. */
  private token(): string | null {
    if (this.tokenAt && Date.now() - this.tokenAt.at < 60_000 && this.tokenAt.t) return this.tokenAt.t;
    let t: string | null = null;
    try { t = this.o.token?.() ?? null; } catch { t = null; }
    this.tokenAt = { at: Date.now(), t };
    return t;
  }

  private async gh<T>(method: string, path: string, body?: unknown, anonymous = false): Promise<T> {
    const token = anonymous ? null : this.token();
    if (!token && !anonymous) throw Object.assign(new Error("No GitHub access on this PC: sign in with the GitHub CLI (gh auth login), or add a token in Systems, Crew pull requests."), { status: 409 });
    const r = await (this.o.fetch ?? fetch)(`${this.o.api ?? "https://api.github.com"}${path}`, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json", "user-agent": "SoftwareFactory" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.status === 204) return {} as T;
    const j = await r.json().catch(() => ({})) as any;
    if (!r.ok) {
      const hint = r.status === 401 ? " The GitHub sign-in on this PC has expired: run gh auth login, or replace the token in Systems." : r.status === 403 || r.status === 404 ? " The GitHub sign-in on this PC needs admin rights on the repository for this." : "";
      throw Object.assign(new Error(hideTokens(`GitHub said ${r.status}${j?.message ? `: ${j.message}` : ""}.${hint}`)), { status: 502, github: r.status });
    }
    return j as T;
  }

  /** Download GitHub's runner program into a folder, checking it against the checksum GitHub publishes. */
  private async download(l: Live) {
    const { asset, ext } = runnerPlatform(this.platform);
    l.note = "Asking GitHub for the newest runner program.";
    const rel = await this.gh<{ tag_name: string; body: string; assets: { name: string; browser_download_url: string }[] }>("GET", "/repos/actions/runner/releases/latest", undefined, !this.token());
    const version = String(rel.tag_name ?? "").replace(/^v/, "");
    const name = `actions-runner-${asset}-${version}.${ext}`;
    const hit = rel.assets?.find((a) => a.name === name);
    const sha = shaFromRelease(rel.body, asset);
    if (!hit || !sha) throw new Error(`GitHub's release ${rel.tag_name} has no ${name} with a checksum.`);
    const cache = join(this.dir, "cache");
    mkdirSync(cache, { recursive: true });
    const file = join(cache, name);
    const sum = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
    if (!existsSync(file) || sum(file) !== sha) {
      l.note = `Downloading the runner program ${version}.`;
      this.say(l, `Downloading ${hit.browser_download_url}`);
      const r = await (this.o.fetch ?? fetch)(hit.browser_download_url);
      if (!r.ok) throw new Error(`The download failed: ${r.status}.`);
      writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      if (sum(file) !== sha) throw new Error("The downloaded runner program does not match GitHub's checksum. Nothing was installed.");
    }
    this.say(l, `Runner program ${version}: checksum matches.`);
    l.note = "Unpacking the runner program.";
    mkdirSync(l.cfg.dir, { recursive: true });
    // tar reads zip too (bsdtar ships with Windows 10 and 11).
    const tar = this.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
    const x = spawnSync(tar, ["-xf", file, "-C", l.cfg.dir], { windowsHide: true, encoding: "utf8", timeout: 600_000 });
    if (x.status !== 0) throw new Error(`Unpacking failed: ${String(x.stderr || x.error?.message || "").slice(0, 300)}`);
    l.version = version;
  }

  private runConfig(l: Live, args: string[], token: string): Promise<number | null> {
    const { cmd, args: full } = this.configCommand(l.cfg.dir, args);
    return new Promise((done) => {
      const p = spawn(cmd, full, { cwd: l.cfg.dir, env: this.env(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const t = setTimeout(() => { if (p.pid) killTree(p.pid, this.platform); }, 300_000);
      const hear = (c: string) => { for (const line of c.split(/\r?\n/)) if (line.trim()) this.say(l, line.split(token).join("***")); };
      p.stdout?.setEncoding("utf8").on("data", hear);
      p.stderr?.setEncoding("utf8").on("data", hear);
      p.on("error", (e) => { clearTimeout(t); this.say(l, `Could not run the runner's set-up: ${e.message}`); done(null); });
      p.on("exit", (code) => { clearTimeout(t); done(code); });
    });
  }

  /**
   * Add a runner: checks, then set-up in the background (download, register, start). The view
   * comes back at once in state "setting-up"; its note and log say how far it is.
   */
  add(input: { repo: string; name?: string; labels?: string[]; dir?: string }): RunnerView {
    const g = parseGitHubRepo(String(input.repo ?? ""));
    const repo = g ? `${g.owner}/${g.name}` : String(input.repo ?? "");
    const sug = this.suggest(repo);
    const cfgIn = {
      repo, name: (input.name ?? "").trim() || sug.name,
      labels: [...new Set((input.labels?.length ? input.labels : sug.labels).map((s) => s.trim()).filter(Boolean))],
      dir: (input.dir ?? "").trim() || sug.dir,
    };
    const others = [...this.live.values()].map((l) => l.cfg);
    const bad = runnerProblems(cfgIn, others, this.platform);
    if (bad.length) throw Object.assign(new Error(bad[0]), { status: 400, problems: bad });
    let id = cfgIn.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    while (this.live.has(id)) id += "-2";
    const l = this.slot({ id, ...cfgIn, on: true, createdAt: now() });
    this.live.set(id, l);
    this.save();
    void this.setUp(id);
    return this.view(l);
  }

  /** Download (when the folder has no runner program), register on GitHub, start. Safe to press again after a failure. */
  async setUp(id: string): Promise<RunnerView> {
    const l = this.get(id);
    if (l.state === "setting-up" && l.note && !l.note.startsWith("Waiting")) return this.view(l);
    if (isLive(l.state)) return this.view(l);
    l.state = "setting-up";
    l.note = "Starting set-up.";
    try {
      const g = parseGitHubRepo(l.cfg.repo) as GitHubRepo;
      const hasProgram = existsSync(join(l.cfg.dir, this.platform === "win32" ? "config.cmd" : "config.sh"));
      if (!hasProgram) await this.download(l);
      if (!this.registered(l.cfg.dir)) {
        l.note = `Registering on ${l.cfg.repo}.`;
        const { token } = await this.gh<{ token: string }>("POST", `/repos/${g.owner}/${g.name}/actions/runners/registration-token`);
        if (!token) throw new Error("GitHub gave no registration token.");
        this.say(l, `Got a one-time registration token for ${l.cfg.repo} (not written down).`);
        const code = await this.runConfig(l, ["--unattended", "--url", `https://github.com/${g.owner}/${g.name}`, "--token", token, "--name", l.cfg.name, "--labels", l.cfg.labels.join(","), "--work", "_work", "--replace"], token);
        if (code !== 0 || !this.registered(l.cfg.dir)) throw new Error(`The runner's own set-up did not finish (code ${code ?? "none"}). Its log has the reason.`);
      }
      this.say(l, "Set-up is done.");
      l.state = "off";
      l.note = null;
      if (l.cfg.on) this.launch(l);
    } catch (e) {
      l.state = this.registered(l.cfg.dir) ? "off" : "not-set-up";
      l.note = `Set-up stopped: ${(e as Error).message}`;
      this.say(l, l.note);
    }
    return this.view(l);
  }

  /**
   * Remove a runner: stop it, take its registration off GitHub, forget it here. Its folder
   * stays on disk (nothing is deleted); the answer says where it is.
   */
  async remove(id: string): Promise<{ removed: string; dir: string; unregistered: boolean; note: string | null }> {
    const l = this.get(id);
    this.halt(l, "Removing this runner.");
    let unregistered = !this.registered(l.cfg.dir);
    let note: string | null = null;
    if (!unregistered) {
      try {
        const g = parseGitHubRepo(l.cfg.repo) as GitHubRepo;
        const { token } = await this.gh<{ token: string }>("POST", `/repos/${g.owner}/${g.name}/actions/runners/remove-token`);
        const code = await this.runConfig(l, ["remove", "--token", token], token);
        unregistered = code === 0 && !this.registered(l.cfg.dir);
        if (!unregistered) note = `GitHub still lists it (its own remove ended with code ${code ?? "none"}). Remove it on GitHub: the repository's Settings, Actions, Runners.`;
      } catch (e) { note = `It could not be taken off GitHub: ${(e as Error).message} Remove it there: the repository's Settings, Actions, Runners.`; }
    }
    this.live.delete(id);
    this.save();
    return { removed: id, dir: l.cfg.dir, unregistered, note };
  }

  /**
   * What GitHub says about a repository's builds: its runners, whether its workflows are sent
   * to this PC (the repository variable), and the latest runs with the machine each job ran on.
   */
  async github(repo: string): Promise<{
    repo: string; private: boolean | null;
    runners: { name: string; status: string; busy: boolean; labels: string[] }[];
    route: { variable: string; value: string | null; isolatedVariable: string; isolated: string | null; sandbox: boolean };
    runs: { id: number; name: string; title: string; event: string; branch: string | null; status: string; conclusion: string | null; createdAt: string; url: string; jobs: { name: string; status: string; conclusion: string | null; runner: string | null; here: boolean | null; startedAt: string | null; endedAt: string | null }[] }[];
  }> {
    const g = parseGitHubRepo(repo);
    if (!g) throw Object.assign(new Error("Give the repository as owner/name."), { status: 400 });
    const base = `/repos/${g.owner}/${g.name}`;
    const readVar = (name: string) => this.gh<{ value?: string }>("GET", `${base}/actions/variables/${name}`).catch((e) => { if ((e as { github?: number }).github === 404) return { value: undefined }; throw e; });
    const [info, rs, variable, isolated, runs] = await Promise.all([
      this.gh<{ private?: boolean }>("GET", base).catch(() => ({} as { private?: boolean })),
      this.gh<{ runners?: any[] }>("GET", `${base}/actions/runners`),
      readVar(ROUTE_VARIABLE),
      readVar(ISOLATED_VARIABLE),
      this.gh<{ workflow_runs?: any[] }>("GET", `${base}/actions/runs?per_page=8`),
    ]);
    const mine = new Set((rs.runners ?? []).map((r) => String(r.name)));
    const list = runs.workflow_runs ?? [];
    const jobs = await Promise.all(list.map((r) => this.gh<{ jobs?: any[] }>("GET", `${base}/actions/runs/${r.id}/jobs?per_page=30`).catch(() => ({ jobs: [] as any[] }))));
    return {
      repo: `${g.owner}/${g.name}`, private: info.private ?? null,
      runners: (rs.runners ?? []).map((r) => ({ name: String(r.name), status: String(r.status), busy: !!r.busy, labels: (r.labels ?? []).map((x: any) => String(x.name)) })),
      route: { variable: ROUTE_VARIABLE, value: variable.value ?? null, isolatedVariable: ISOLATED_VARIABLE, isolated: isolated.value ?? null, sandbox: this.hasSandbox() },
      runs: list.map((r, i) => ({
        id: Number(r.id), name: String(r.name ?? ""), title: String(r.display_title ?? ""), event: String(r.event ?? ""), branch: r.head_branch ?? null,
        status: String(r.status), conclusion: r.conclusion ?? null, createdAt: String(r.created_at), url: String(r.html_url),
        jobs: (jobs[i].jobs ?? []).map((j) => ({
          name: String(j.name), status: String(j.status), conclusion: j.conclusion ?? null, runner: j.runner_name ?? null,
          // A job that has a machine ran here when that machine is one of the repository's own runners.
          here: j.runner_name ? mine.has(String(j.runner_name)) : null,
          startedAt: j.started_at ?? null, endedAt: j.completed_at ?? null,
        })),
      })),
    };
  }

  /**
   * A public repository takes pull requests from anyone, and a pull request can carry its own
   * workflow. So before builds come to this PC, GitHub is told to hold every outside
   * contributor's workflow until the owner approves it. Says what happened when it matters.
   */
  private async guardPublic(g: GitHubRepo): Promise<string | null> {
    try {
      const info = await this.gh<{ private?: boolean }>("GET", `/repos/${g.owner}/${g.name}`);
      if (info.private) return null;
      await this.gh("PUT", `/repos/${g.owner}/${g.name}/actions/permissions/fork-pr-contributor-approval`, { approval_policy: "all_external_contributors" });
      return "This repository is public, so GitHub now holds workflows from outside contributors until you approve them: a stranger's pull request never runs on this PC by itself.";
    } catch (e) {
      return `This repository is public and the safety setting could not be turned on (${(e as Error).message}) On GitHub: Settings, Actions, General, "Require approval for all external contributors". Until then a stranger's pull request could run code on this PC.`;
    }
  }

  /**
   * Send a repository's builds to this PC, or back to GitHub's machines: sets or deletes the
   * repository variable its workflows read in `runs-on`. Turning it on needs a runner here.
   */
  async route(id: string, on: boolean): Promise<{ variable: string; value: string | null; isolated: string | null; note?: string | null }> {
    const l = this.get(id);
    const g = parseGitHubRepo(l.cfg.repo) as GitHubRepo;
    const base = `/repos/${g.owner}/${g.name}/actions/variables`;
    const drop = (name: string) => this.gh("DELETE", `${base}/${name}`).catch((e) => { if ((e as { github?: number }).github !== 404) throw e; });
    const put = async (name: string, value: string) => {
      try { await this.gh("PATCH", `${base}/${name}`, { name, value }); }
      catch (e) { if ((e as { github?: number }).github !== 404) throw e; await this.gh("POST", base, { name, value }); }
    };
    if (!on) {
      await drop(ROUTE_VARIABLE);
      await drop(ISOLATED_VARIABLE);
      return { variable: ROUTE_VARIABLE, value: null, isolated: null };
    }
    if (!this.registered(l.cfg.dir)) throw Object.assign(new Error("Set this runner up first: with no runner, builds sent here would wait forever."), { status: 409 });
    const value = JSON.stringify(this.view(l).runsOn);
    await put(ROUTE_VARIABLE, value);
    // Jobs that need an isolated Windows come here only when this PC can give them one.
    const sandbox = this.hasSandbox();
    if (sandbox) await put(ISOLATED_VARIABLE, value); else await drop(ISOLATED_VARIABLE);
    const notes = [
      await this.guardPublic(g),
      sandbox ? null : "Windows Sandbox is not turned on on this PC, so tests that need an isolated Windows (the smoke test) stay on GitHub's machines. Turn it on in Windows features, then press this button again.",
    ].filter(Boolean);
    return { variable: ROUTE_VARIABLE, value, isolated: sandbox ? value : null, note: notes.join(" ") || null };
  }
}
