import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { delimiter, dirname, join } from "node:path";
import type { EventLog } from "../events.js";
import { quoteArg, splitArgs, type RunProfile } from "./detect.js";
import "./tables.js";

/** One line a running project printed. `n` counts from 1 per session. */
export interface OutputLine { n: number; ts: string; stream: "out" | "err" | "in" | "sys"; text: string }

export type SessionState = "starting" | "running" | "serving" | "exited" | "stopped" | "failed";

export interface SessionView {
  id: number;
  projectId: number;
  profileId: string;
  kind: RunProfile["kind"];
  label: string;
  command: string;
  args: string | null;
  dir: string;
  root: string | null;
  mode: "inline" | "window";
  state: SessionState;
  port: number | null;
  /** Where its pages are: a local address it printed, or the core's /preview/ for plain pages. */
  url: string | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  pid: number | null;
  /** Typed input is still open. */
  stdinOpen: boolean;
  lines: number;
}

interface Live extends SessionView {
  proc: ChildProcess | null;
  out: OutputLine[];
  dropped: number;
  partial: { out: string; err: string };
  stopping: boolean;
}

export interface StartInput {
  projectId: number;
  dir: string;
  profile: RunProfile;
  /** The arguments box, as typed. */
  args?: string;
  /** The arguments as a list (from the options form or an example); wins over `args`. */
  argv?: string[];
  /** Text to type into it, then close its input (for tools that read to the end). */
  stdin?: string;
  /** "window" opens it in a console window of its own; the app does not watch it. */
  mode?: "inline" | "window";
}

const MAX_LINES = 3000;
const MAX_LINE = 4000;
// Never hand keys or tokens to a project's code: generated code is not trusted with them.
const SECRET = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|SESSION_?KEY|AUTH)/i;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(\u0007|\u001b\\)|\r/g;
const URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::\])(?::\d{2,5})?(?:\/[^\s'"<>)\]]*)?/i;

/** Find a free local port. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/** Pull a local address out of a line a program printed ("Local: http://localhost:5173/"). */
export function findLocalUrl(line: string): string | null {
  const m = line.replace(ANSI, "").match(URL_RE);
  if (!m) return null;
  return m[0].replace(/[.,;:]+$/, "").replace("0.0.0.0", "127.0.0.1").replace(/\[::1?\]|\[::\]/, "127.0.0.1");
}

/** The environment a project runs in: yours minus secrets, with its own tools and the bundled Node.js first on PATH. */
export function projectEnv(dir: string, nodePath: string, port: number | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SECRET.test(k) && !k.startsWith("SF_")) env[k] = v;
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = [join(dir, "node_modules", ".bin"), dirname(nodePath), env[pathKey] ?? ""].filter(Boolean).join(delimiter);
  if (port) env.PORT = String(port);
  // Apps the factory built reach their agents through this core (kit route /api/_agent).
  env.SF_CORE_URL = `http://127.0.0.1:${process.env.SF_PORT ?? 4317}`;
  env.BROWSER = "none"; // dev servers must not open a browser of their own; the Bridge shows the page
  env.FORCE_COLOR = "0";
  env.NO_COLOR = "1";
  env.PYTHONUNBUFFERED = "1";
  return env;
}

/** Stop a process and everything it started. */
export function killTree(proc: ChildProcess, force = false) {
  if (proc.pid == null || proc.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
  } else {
    try { process.kill(-proc.pid, force ? "SIGKILL" : "SIGTERM"); } catch { try { proc.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* gone */ } }
  }
}

/**
 * Starts projects from their own folders and keeps what they print, so the
 * Bridge can show a live console and, for web projects, the page itself.
 * Each start is a launch.* event; output stays in memory (last lines kept on exit).
 */
export class Launcher extends EventEmitter {
  private sessions = new Map<number, Live>();
  readonly nodePath: string;

  constructor(private log: EventLog, opts: { nodePath?: string } = {}) {
    super();
    this.setMaxListeners(100);
    this.nodePath = opts.nodePath ?? process.execPath;
    // Anything still marked running belonged to a core that has stopped; its processes went with it.
    const open = log.db.prepare("SELECT id FROM launch_sessions WHERE ended_at IS NULL").all() as { id: number }[];
    for (const r of open) log.append("launch.exited", { session: Number(r.id), code: null, how: "app-closed", tail: [] });
    process.once("exit", () => this.stopAll());
    // An archived project (also merged or turned into a ticket) keeps no apps running.
    log.on("event", (e: { type: string; payload: unknown }) => {
      if (e.type !== "project.updated") return;
      const p = e.payload as { projectId?: number; status?: string };
      if (p.status !== "archived" || p.projectId == null) return;
      for (const s of [...this.sessions.values()]) if (s.projectId === p.projectId && isLive(s.state)) this.stop(s.id);
    });
  }

  /** Running and recent sessions of a project, newest first. Live ones carry their state; past ones come from the table. */
  sessionsOf(projectId: number, limit = 15): SessionView[] {
    const rows = this.log.db.prepare("SELECT * FROM launch_sessions WHERE project_id = ? ORDER BY id DESC LIMIT ?").all(projectId, limit) as Record<string, any>[];
    return rows.map((r) => this.view(Number(r.id)) ?? fromRow(r));
  }

  running(projectId?: number): SessionView[] {
    return [...this.sessions.values()].filter((s) => (projectId == null || s.projectId === projectId) && isLive(s.state)).map(strip);
  }

  view(id: number): SessionView | null {
    const s = this.sessions.get(id);
    if (s) return strip(s);
    const r = this.log.db.prepare("SELECT * FROM launch_sessions WHERE id = ?").get(id) as Record<string, any> | undefined;
    return r ? fromRow(r) : null;
  }

  /** Lines after `after` (0 for all kept). Past sessions give the tail kept on exit. */
  output(id: number, after = 0): { lines: OutputLine[]; dropped: number } {
    const s = this.sessions.get(id);
    if (s) return { lines: s.out.filter((l) => l.n > after), dropped: s.dropped };
    const r = this.log.db.prepare("SELECT tail, ended_at FROM launch_sessions WHERE id = ?").get(id) as { tail: string | null; ended_at: string } | undefined;
    const tail = r?.tail ? r.tail.split("\n") : [];
    return { lines: tail.map((text, i) => ({ n: i + 1, ts: r!.ended_at, stream: "out" as const, text })).filter((l) => l.n > after), dropped: 0 };
  }

  /** The folder a live static session serves, for /preview/. */
  staticRoot(projectId: number): { dir: string; root: string } | null {
    const s = [...this.sessions.values()].reverse().find((x) => x.projectId === projectId && x.kind === "static" && x.state === "serving");
    return s ? { dir: s.dir, root: s.root ?? "" } : null;
  }

  async start(input: StartInput): Promise<SessionView> {
    const { projectId, dir, profile } = input;
    const mode = input.mode === "window" && profile.kind !== "static" ? "window" : "inline";
    const busy = [...this.sessions.values()].find((s) => s.projectId === projectId && s.profileId === profile.id && s.dir === dir && isLive(s.state));
    if (busy) return strip(busy);
    if (mode === "inline" && profile.kind !== "static") {
      for (const o of [...this.sessions.values()]) {
        if (o.projectId !== projectId || o.dir === dir || !isLive(o.state) || o.kind === "static") continue;
        this.sys(o, "Stopped: a newer build of this project started.");
        this.stop(o.id);
      }
    }
    const argList = profile.args ? (input.argv ? input.argv.map(String).slice(0, 64) : input.args ? splitArgs(input.args) : []) : [];
    const command = [profile.command, ...argList.map(quoteArg)].join(" ");
    const argText = argList.length ? argList.map(quoteArg).join(" ") : null;
    const port = profile.kind === "web" || profile.kind === "program" ? await freePort().catch(() => null) : null;

    if (profile.kind === "static") {
      const e = this.log.append("launch.started", { projectId, profileId: profile.id, kind: profile.kind, label: profile.label, command, dir, root: profile.root ?? "", mode, url: `/preview/${projectId}/` });
      const s = this.track(e.id, e.ts, input, { command, args: null, mode, port: null, url: `/preview/${projectId}/`, state: "serving", proc: null });
      // One preview per project: the newest replaces the one before.
      for (const o of this.sessions.values()) if (o !== s && o.projectId === projectId && o.kind === "static" && o.state === "serving") this.finish(o, null, "replaced");
      this.sys(s, `Serving ${profile.root ? profile.root + "/" : "the folder"} from ${dir}`);
      return strip(s);
    }
    if (!profile.exec) throw new Error(`"${profile.label}" has nothing to start.`);

    const env = projectEnv(dir, this.nodePath, port);
    if (mode === "window") {
      const e = this.log.append("launch.started", { projectId, profileId: profile.id, kind: profile.kind, label: profile.label, command, args: argText, dir, mode, port });
      openConsoleWindow(dir, this.lineFor(profile, argList), `${profile.label}`, env);
      return this.view(e.id)!;
    }

    let proc: ChildProcess;
    const win = process.platform === "win32";
    const opts = { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"], windowsHide: true, detached: !win };
    if ("shell" in profile.exec) proc = spawn(this.lineFor(profile, argList), { ...opts, shell: true });
    else {
      const file = profile.exec.file === "node" ? this.nodePath : profile.exec.file;
      proc = spawn(file, [...profile.exec.args, ...argList], { ...opts, shell: false });
    }
    const e = this.log.append("launch.started", { projectId, profileId: profile.id, kind: profile.kind, label: profile.label, command, args: argText, dir, mode, port, pid: proc.pid ?? null });
    const s = this.track(e.id, e.ts, input, { command, args: argText, mode, port, url: null, state: "starting", proc });
    this.sys(s, `${command}   (in ${dir})`);
    proc.on("spawn", () => { if (s.state === "starting") { s.state = "running"; this.emit("state", strip(s)); } });
    proc.stdout?.on("data", (d: Buffer) => this.chunk(s, "out", d.toString("utf8")));
    proc.stderr?.on("data", (d: Buffer) => this.chunk(s, "err", d.toString("utf8")));
    proc.stdin?.on("error", () => { s.stdinOpen = false; });
    if (input.stdin != null) {
      for (const l of input.stdin.split("\n").slice(0, 200)) this.line(s, "in", l);
      proc.stdin?.end(input.stdin.endsWith("\n") ? input.stdin : input.stdin + "\n");
      s.stdinOpen = false;
    }
    proc.on("error", (err: NodeJS.ErrnoException) => {
      const hint = err.code === "ENOENT" ? ` (is ${"file" in profile.exec! ? profile.exec.file : "it"} installed and on PATH?)` : "";
      this.sys(s, `Could not start: ${err.message}${hint}`, "err");
      this.finish(s, null, "failed");
    });
    proc.on("close", (code, signal) => {
      for (const k of ["out", "err"] as const) if (s.partial[k]) { this.line(s, k, s.partial[k]); s.partial[k] = ""; }
      if (s.state === "failed") return;
      const printed = s.out.some((l) => l.stream === "out" || l.stream === "err");
      this.sys(s, s.stopping ? "Stopped." : code === 0 && !printed ? "Finished without printing anything (it found nothing to do, or it works silently)." : `Exited with code ${code ?? signal}.`);
      this.finish(s, code, s.stopping ? "stopped" : "exited");
    });
    return strip(s);
  }

  /** Send a line of typed input, or close the input (`text` null) so a tool that reads to the end can finish. */
  input(id: number, text: string | null) {
    const s = this.sessions.get(id);
    if (!s?.proc || !isLive(s.state) || !s.stdinOpen) throw new Error("That program is not taking input.");
    if (text == null) { s.proc.stdin?.end(); s.stdinOpen = false; this.sys(s, "Input closed."); this.emit("state", strip(s)); return; }
    s.proc.stdin?.write(text + "\n");
    this.line(s, "in", text);
  }

  stop(id: number): SessionView | null {
    const s = this.sessions.get(id);
    if (!s) return this.view(id);
    if (!isLive(s.state)) return strip(s);
    this.log.append("launch.stopped", { session: id, by: "you" });
    if (!s.proc) { this.sys(s, "Preview closed."); this.finish(s, null, "stopped"); return strip(s); }
    s.stopping = true;
    killTree(s.proc);
    const proc = s.proc;
    setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) killTree(proc, true); }, 3000).unref();
    return strip(s);
  }

  stopAll() {
    for (const s of this.sessions.values()) if (s.proc && isLive(s.state)) { s.stopping = true; killTree(s.proc, true); }
  }

  /** What to type in a shell for this profile. */
  private lineFor(profile: RunProfile, argList: string[]): string {
    const ex = profile.exec!;
    const extra = argList.map(quoteArg).join(" ");
    if ("shell" in ex) return extra ? `${ex.shell} ${extra}` : ex.shell;
    const file = ex.file === "node" ? quoteArg(this.nodePath) : ex.file;
    return [file, ...ex.args.map(quoteArg), extra].filter(Boolean).join(" ");
  }

  private track(id: number, ts: string, input: StartInput, rest: Pick<Live, "command" | "args" | "mode" | "port" | "url" | "state" | "proc">): Live {
    const s: Live = {
      id, projectId: input.projectId, profileId: input.profile.id, kind: input.profile.kind, label: input.profile.label,
      dir: input.dir, root: input.profile.root ?? null, startedAt: ts, endedAt: null, exitCode: null,
      pid: rest.proc?.pid ?? null, stdinOpen: !!rest.proc, lines: 0, out: [], dropped: 0, partial: { out: "", err: "" }, stopping: false, ...rest,
    };
    this.sessions.set(id, s);
    // Keep the newest sessions only; their history stays in the table.
    if (this.sessions.size > 60) for (const [k, v] of this.sessions) { if (!isLive(v.state)) { this.sessions.delete(k); break; } }
    this.emit("state", strip(s));
    return s;
  }

  private chunk(s: Live, stream: "out" | "err", text: string) {
    const parts = (s.partial[stream] + text).split("\n");
    s.partial[stream] = parts.pop() ?? "";
    // A prompt without a newline ("Name? ") should still show.
    if (s.partial[stream].length > MAX_LINE || (s.partial[stream] && /[?:>]\s*$/.test(s.partial[stream]))) { parts.push(s.partial[stream]); s.partial[stream] = ""; }
    for (const p of parts) this.line(s, stream, p);
  }

  private line(s: Live, stream: OutputLine["stream"], raw: string) {
    const text = raw.replace(ANSI, "").slice(0, MAX_LINE);
    const l: OutputLine = { n: ++s.lines, ts: new Date().toISOString(), stream, text };
    s.out.push(l);
    if (s.out.length > MAX_LINES) { s.out.shift(); s.dropped++; }
    this.emit("line", s.id, l);
    if (!s.url && (stream === "out" || stream === "err") && s.kind !== "cli") {
      const url = findLocalUrl(text);
      if (url) {
        s.url = url;
        if (s.kind === "program") s.kind = "web";
        try { this.log.append("launch.url", { session: s.id, url }); } catch { /* closed */ }
        this.emit("state", strip(s));
      }
    }
  }

  private sys(s: Live, text: string, stream: "sys" | "err" = "sys") { this.line(s, stream === "err" ? "err" : "sys", text); }

  private finish(s: Live, code: number | null, how: "exited" | "stopped" | "failed" | "replaced") {
    if (!isLive(s.state)) return;
    s.state = how === "replaced" ? "stopped" : how;
    s.exitCode = code;
    s.endedAt = new Date().toISOString();
    s.stdinOpen = false;
    // The database may already be closed when a program ends as the app quits; the next start marks it then.
    try { this.log.append("launch.exited", { session: s.id, code, how, tail: s.out.slice(-60).map((l) => (l.stream === "in" ? "> " : "") + l.text) }); } catch { /* closed */ }
    this.emit("state", strip(s));
  }
}

const isLive = (st: SessionState) => st === "starting" || st === "running" || st === "serving";

function strip(s: Live): SessionView {
  const { proc: _p, out: _o, dropped: _d, partial: _q, stopping: _s, ...v } = s;
  return { ...v };
}

function fromRow(r: Record<string, any>): SessionView {
  const how = r.ended_how as string | null;
  return {
    id: Number(r.id), projectId: Number(r.project_id), profileId: r.profile_id, kind: r.kind, label: r.label, command: r.command,
    args: r.args, dir: r.dir, root: r.root, mode: r.mode, port: r.port, url: r.url, startedAt: r.started_at, endedAt: r.ended_at,
    exitCode: r.exit_code, pid: null, stdinOpen: false,
    state: how === "failed" ? "failed" : how === "stopped" || how === "replaced" || how === "app-closed" || how === "window" ? "stopped" : "exited",
    lines: r.tail ? String(r.tail).split("\n").length : 0,
  };
}

/** Open a console window of its own in the folder, running the command (for big programs or ones that need a real terminal). */
export function openConsoleWindow(dir: string, line: string | null, title: string, env: NodeJS.ProcessEnv = process.env) {
  try {
    let child: ChildProcess;
    if (process.platform === "win32") {
      // start "title" cmd /k <line>: the window stays open after it ends, so you can read the result.
      const inner = line ? `cmd /k ${line}` : "cmd";
      child = spawn(`start "${title.replace(/"/g, "'")}" ${inner}`, { cwd: dir, env, shell: true, detached: true, stdio: "ignore", windowsHide: false });
    } else if (process.platform === "darwin") {
      const script = `cd ${quoteArg(dir)}${line ? "; " + line : ""}`;
      child = spawn("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(script)}`, "-e", 'tell application "Terminal" to activate'], { detached: true, stdio: "ignore" });
    } else {
      const sh = line ? `${line}; exec $SHELL` : "exec $SHELL";
      child = spawn("x-terminal-emulator", ["-e", "sh", "-c", sh], { cwd: dir, env, detached: true, stdio: "ignore" });
    }
    child.on("error", () => {});
    child.unref();
  } catch { /* no desktop here (a server, CI) */ }
}
