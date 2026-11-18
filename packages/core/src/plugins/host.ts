import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { killTree } from "../launch/launcher.js";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, normalize, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { EventLog, SfEvent } from "../events.js";
import type { AgentBay } from "../bay/bay.js";
import { parseAgentFile } from "../bay/agentfile.js";
import { projectDetail } from "../projects/service.js";
import { asksOf, matchesType, readManifest, PLUGIN_RECORDS, type PluginAction, type PluginManifest, type PluginPermission, type PluginRecordKind } from "./manifest.js";
import type { PluginDoor } from "./door.js";
import { RUNNER_SOURCE } from "./runner.js";
import type { PluginStore } from "./store.js";
import type { PluginAi } from "./ai.js";
import "./tables.js";

/** Where an add-on installed from GitHub came from: `github:owner/repo[/path]@ref#sha`. */
export interface GithubSource { repo: string; path: string; ref: string; sha: string | null }
export function parseGithubSource(from: string | null | undefined): GithubSource | null {
  const m = String(from ?? "").match(/^github:([\w.-]+\/[\w.-]+)((?:\/[\w.-]+)*)@([^#]+)(?:#(\w+))?$/);
  return m ? { repo: m[1], path: m[2].replace(/^\//, ""), ref: m[3], sha: m[4] ?? null } : null;
}
/** "owner/repo", "owner/repo/sub/folder", "https://github.com/owner/repo/tree/main/sub" → its parts. */
export function parseGithubSpec(spec: string, ref?: string): { repo: string; path: string; ref: string } {
  let s = spec.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  let r = ref?.trim() || "";
  const url = s.match(/^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)(?:\/tree\/([^/]+)((?:\/[\w.-]+)*))?/);
  if (url) { s = `${url[1]}${url[3] ?? ""}`; r = r || url[2] || ""; }
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2 || !parts.every((p) => /^[\w.-]+$/.test(p) && p !== "." && p !== "..")) throw new Error("Give the add-on's GitHub repository as owner/repo (or its address)");
  return { repo: `${parts[0]}/${parts[1]}`, path: parts.slice(2).join("/"), ref: r || "HEAD" };
}
export type DownloadTarball = (repo: string, ref: string) => Promise<Buffer>;

/**
 * The plugin host: installs plugin folders, turns them on and off, and runs each enabled
 * plugin's backend in its own locked-down Node process (see runner.ts).
 *
 *   install (a copy goes to <data>/plugins/<id>/)  →  enable (the one approval: its permissions)  →  running
 *                                                                                         crash ×3 →  disabled, with the reason
 *
 * Plugins load at runtime from the data folder, so adding one needs no SoftwareFactory release.
 */
export type PluginStatus = "installed" | "enabled" | "disabled" | "removed";

export interface PluginView {
  id: string;
  name: string;
  version: string;
  description: string;
  dir: string;
  source: string | null;
  status: PluginStatus;
  manifest: PluginManifest;
  /** What you allowed when you turned it on: its permissions, and one `act:<verb>` per action. */
  granted: string[];
  error: string | null;
  crashes: number;
  installedAt: string;
  enabledAt: string | null;
  /** Is its backend process up right now? (null: it has no backend) */
  running: boolean | null;
  dataKeys: number;
}

export interface PluginExample { id: string; name: string; description: string; dir: string; installed: boolean }

type Row = Record<string, any>;

/** Bundled example plugins: packages/core/plugin-examples (next to dist/ in the installed app). */
export const EXAMPLES_DIR = fileURLToPath(new URL("../../plugin-examples/", import.meta.url));

const MAX_CRASHES = 3;
const LIMITS = { dataBytes: 64_000, logChars: 2000, perMinute: { set: 300, emit: 60, log: 200, act: 60 } };

/** What an action made, short enough for the log: ids and names only. */
const summary = (r: unknown) => (r && typeof r === "object" ? Object.fromEntries(Object.entries(r as Record<string, unknown>).filter(([k]) => ["id", "key", "name", "title", "status"].includes(k))) : null);

/** Does an event belong to a project? The core's twin of the Bridge's inProject. */
export function eventInProject(e: SfEvent, d: { id: number; runIds: number[]; nodeIds: number[] }): boolean {
  const p = (e.payload ?? {}) as Row;
  const runs = new Set(d.runIds), nodes = new Set(d.nodeIds);
  if (e.type === "plugin.emitted") return Number(p.projectId) === d.id;
  if (e.type.startsWith("project.")) return Number(p.projectId) === d.id || e.id === d.id;
  if (e.type === "factory.run.started") return runs.has(e.id);
  if (e.type.startsWith("factory.")) return runs.has(Number(p.run));
  if (e.type.startsWith("agent.run.")) return p.factoryRun != null && runs.has(Number(p.factoryRun));
  if (e.type === "order.node") return nodes.has(e.id);
  if (e.type === "order.fragment" || e.type === "order.conflict") return p.nodeId != null && nodes.has(Number(p.nodeId));
  return false;
}

interface Running {
  child: ChildProcess;
  ready: boolean;
  stopping: boolean;
  calls: Map<number, { res: (v: unknown) => void; rej: (e: Error) => void; timer: NodeJS.Timeout }>;
  rate: Map<string, { minute: number; n: number }>;
  stderr: string;
}

export class PluginHost {
  private running = new Map<string, Running>();
  private nextRid = 1;
  private restartTimers = new Map<string, NodeJS.Timeout>();
  private actRate = new Map<string, { minute: number; n: number }>();
  private listening = false;
  readonly runnerPath: string;

  constructor(private log: EventLog, readonly root: string, private opts: { bay?: AgentBay; examplesDir?: string; node?: string; door?: PluginDoor; store?: PluginStore; ai?: PluginAi; tarball?: DownloadTarball; tar?: string } = {}) {
    this.runnerPath = join(root, ".runtime", "runner.mjs");
  }

  // ---- reading -------------------------------------------------------------------------

  private row(id: string): Row | undefined {
    return this.log.db.prepare("SELECT * FROM plugins WHERE id = ?").get(id) as Row | undefined;
  }

  private toView(r: Row): PluginView {
    const manifest = JSON.parse(r.manifest) as PluginManifest;
    const keys = this.log.db.prepare("SELECT count(*) AS n FROM plugin_data WHERE plugin_id = ?").get(r.id) as Row;
    return {
      id: r.id, name: r.name, version: r.version, description: manifest.description ?? "", dir: r.dir, source: r.source ?? null,
      status: r.status, manifest, granted: JSON.parse(r.granted), error: r.error ?? null, crashes: Number(r.crashes ?? 0),
      installedAt: r.installed_at, enabledAt: r.enabled_at ?? null,
      running: manifest.main ? !!this.running.get(r.id)?.ready : null, dataKeys: Number(keys.n),
    };
  }

  get(id: string): PluginView | null {
    const r = this.row(id);
    return r && r.status !== "removed" ? this.toView(r) : null;
  }

  list(): PluginView[] {
    return (this.log.db.prepare("SELECT * FROM plugins WHERE status != 'removed' ORDER BY name").all() as Row[]).map((r) => this.toView(r));
  }

  examples(): PluginExample[] {
    const dir = this.opts.examplesDir ?? EXAMPLES_DIR;
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return []; }
    const out: PluginExample[] = [];
    for (const n of names) {
      try {
        const m = readManifest(join(dir, n));
        out.push({ id: m.id, name: m.name, description: m.description, dir: join(dir, n), installed: !!this.get(m.id) });
      } catch { /* not a plugin */ }
    }
    return out;
  }

  data(id: string): Record<string, unknown> {
    const rows = this.log.db.prepare("SELECT key, value FROM plugin_data WHERE plugin_id = ?").all(id) as Row[];
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  }

  /** The plugin's recent log lines and crashes, newest last. */
  logOf(id: string, limit = 100): { id: number; ts: string; level: string; text: string }[] {
    const rows = this.log.db.prepare(`SELECT id, ts, type, payload FROM events WHERE type IN ('plugin.log', 'plugin.failed', 'plugin.enabled', 'plugin.disabled', 'plugin.installed', 'plugin.acted')
      AND json_extract(payload, '$.id') = ? ORDER BY id DESC LIMIT ?`).all(id, limit) as Row[];
    return rows.reverse().map((r) => {
      const p = JSON.parse(r.payload);
      const line = r.type === "plugin.log" ? { level: p.level, text: p.text }
        : r.type === "plugin.failed" ? { level: "error", text: `Crashed: ${p.error}` }
        : r.type === "plugin.acted" ? (p.ok
          ? { level: "info", text: `Did ${p.verb}${p.result?.key ? `: ${p.result.key}` : p.result?.name ? `: ${p.result.name}` : ""}` }
          : { level: "warn", text: `Tried ${p.verb}, refused: ${p.error}` })
        : r.type === "plugin.enabled" ? { level: "info", text: `Turned on by ${p.by}` }
        : r.type === "plugin.disabled" ? { level: "warn", text: `Turned off by ${p.by}${p.reason ? `: ${p.reason}` : ""}` }
        : { level: "info", text: `Installed version ${p.version}` };
      return { id: Number(r.id), ts: r.ts, ...line };
    });
  }

  /** Events a plugin may read: one project's, or the whole factory's. Needs events:read. */
  events(id: string, opts: { projectId?: number | null; types?: string[]; limit?: number; sinceId?: number } = {}): SfEvent[] {
    const v = this.get(id);
    if (!v || v.status !== "enabled") throw new Error(`Plugin ${id} is not turned on`);
    if (!v.granted.includes("events:read")) throw new Error(`Plugin ${id} may not read events (it did not ask for events:read)`);
    const limit = Math.min(Math.max(1, opts.limit ?? 500), 2000);
    let list = this.log.list({ sinceId: opts.sinceId ?? 0, limit: 1e6 }).filter((e) => !e.type.startsWith("plugin.data"));
    if (opts.types?.length) list = list.filter((e) => opts.types!.some((t) => matchesType(t, e.type)));
    if (opts.projectId != null) {
      const d = projectDetail(this.log, Number(opts.projectId));
      if (!d) throw new Error(`No project #${opts.projectId}`);
      list = list.filter((e) => eventInProject(e, d));
    }
    return list.slice(-limit);
  }

  /** Real records a plugin may read: projects, tickets, agents. Needs records:read. */
  records(id: string, kind: string, opts: { projectId?: number | null; limit?: number } = {}): unknown[] {
    const v = this.get(id);
    if (!v || v.status !== "enabled") throw new Error(`Plugin ${id} is not turned on`);
    if (!v.granted.includes("records:read")) throw new Error(`Plugin ${id} may not read records (it did not ask for records:read)`);
    if (!this.opts.door) throw new Error("Records are not available here");
    if (!(PLUGIN_RECORDS as readonly string[]).includes(kind)) throw new Error(`Unknown records "${kind}"; known: ${PLUGIN_RECORDS.join(", ")}`);
    return this.opts.door.records(kind as PluginRecordKind, opts);
  }

  /**
   * Take one action for a plugin: a verb its manifest lists, granted when it was turned on.
   * Every try is logged as plugin.acted (who, what, did it work), at most 60 a minute per plugin.
   */
  act(id: string, verb: string, args: Record<string, unknown> = {}): unknown {
    const v = this.get(id);
    if (!v || v.status !== "enabled") throw new Error(`Plugin ${id} is not turned on`);
    if (!v.granted.includes("actions")) throw new Error(`Plugin ${id} may not take actions (it did not ask for the actions permission)`);
    if (!(v.manifest.actions ?? []).includes(verb as PluginAction) || !v.granted.includes(`act:${verb}`)) throw new Error(`Plugin ${id} was not given "${verb}" when it was turned on, so it may not do that`);
    if (!this.opts.door) throw new Error("Actions are not available here");
    const minute = Math.floor(Date.now() / 60_000);
    const cur = this.actRate.get(id);
    if (!cur || cur.minute !== minute) this.actRate.set(id, { minute, n: 1 });
    else if (++cur.n > LIMITS.perMinute.act) throw new Error(`Plugin ${id} is acting too fast (more than ${LIMITS.perMinute.act} actions a minute); wait a minute`);
    const projectId = args.project == null ? null : Number(args.project);
    try {
      const result = this.opts.door.act(verb as PluginAction, args, `plugin:${id}`);
      this.log.append("plugin.acted", { id, verb, ok: true, projectId, result: summary(result) });
      return result;
    } catch (e) {
      this.log.append("plugin.acted", { id, verb, ok: false, projectId, error: (e as Error).message.slice(0, 300) });
      throw e;
    }
  }

  // ---- installing and switching ---------------------------------------------------------

  /** Copy a plugin folder into the plugins folder (a newer copy replaces the old one). */
  install(fromDir: string, opts: { by?: string; from?: string } = {}): PluginView {
    const src = resolve(fromDir);
    if (!existsSync(src) || !statSync(src).isDirectory()) throw new Error(`${fromDir} is not a folder`);
    const m = readManifest(src);
    const dest = join(this.root, m.id);
    if (resolve(dest) !== src) {
      this.stop(m.id);
      mkdirSync(this.root, { recursive: true });
      rmSync(dest, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      cpSync(src, dest, { recursive: true, filter: (p) => basename(p) !== ".git" });
    }
    const manifest = readManifest(dest);
    this.log.append("plugin.installed", { id: manifest.id, name: manifest.name, version: manifest.version, dir: dest, manifest, from: opts.from ?? src, by: opts.by ?? "you" });
    const v = this.get(manifest.id)!;
    // Still on after an update that asks for nothing new: bring its agents and backend up to date.
    if (v.status === "enabled") { this.syncAgents(v, true); this.start(v.id); }
    return this.get(manifest.id)!;
  }

  /**
   * Install (or update) an add-on from a GitHub repository: its code is downloaded as one archive (with your GitHub
   * access in Systems when the repository is private), unpacked next to the plugins, and installed like a folder.
   * The source is remembered, so it can update itself (updateFromGithub); an update that asks for nothing new
   * stays on, one that asks for more waits for you to turn it on again.
   */
  async installFromGithub(spec: string, o: { ref?: string; by?: string; onlyIfNew?: string } = {}): Promise<PluginView & { updated: boolean }> {
    const { repo, ref } = parseGithubSpec(spec, o.ref);
    let { path } = parseGithubSpec(spec, o.ref);
    const download = this.opts.tarball ?? (async (r: string, f: string) => {
      const res = await fetch(`https://codeload.github.com/${r}/tar.gz/${encodeURIComponent(f)}`, { headers: { "user-agent": "SoftwareFactory" } });
      if (!res.ok) throw new Error(res.status === 404 ? `GitHub has no ${r} at ${f}, or it is private: add GitHub access in Systems` : `GitHub answered ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    });
    const buf = await download(repo, ref);
    if (buf.length > 50 * 1024 * 1024) throw new Error(`${repo} is ${Math.round(buf.length / 1e6)} MB, over the 50 MB an add-on may be`);
    const work = join(this.root, ".downloads", `${repo.replace("/", "-")}-${Date.now().toString(36)}`);
    mkdirSync(work, { recursive: true });
    try {
      writeFileSync(join(work, "code.tar.gz"), buf);
      mkdirSync(join(work, "x"));
      const x = spawnSync(this.opts.tar ?? "tar", ["-xzf", "code.tar.gz", "-C", "x"], { cwd: work, windowsHide: true, encoding: "utf8", timeout: 120_000 });
      if (x.status !== 0) throw new Error(`Could not unpack ${repo}: ${(x.stderr || x.error?.message || "").slice(0, 200)}`);
      const top = readdirSync(join(work, "x"));
      if (top.length !== 1) throw new Error(`${repo}'s archive is not one folder`);
      const sha = top[0].match(/-([0-9a-f]{7,40})$/)?.[1] ?? null;
      // A repository that keeps its add-on in a plugin/ folder (with tests and docs beside it) is found without naming it.
      if (!path && !existsSync(join(work, "x", top[0], "plugin.json")) && existsSync(join(work, "x", top[0], "plugin", "plugin.json"))) path = "plugin";
      const from = `github:${repo}${path ? `/${path}` : ""}@${ref}${sha ? `#${sha}` : ""}`;
      if (o.onlyIfNew && sha && parseGithubSource(o.onlyIfNew)?.sha === sha) return { ...this.get(readManifest(join(work, "x", top[0], path)).id)!, updated: false };
      const dir = resolve(work, "x", top[0], path);
      if (!dir.startsWith(resolve(work, "x") + sep)) throw new Error("That folder leaves the repository");
      // On Windows a running backend locks its folder (it is its working folder): let it exit before the copy replaces it.
      await this.stop(readManifest(dir).id);
      return { ...this.install(dir, { by: o.by, from }), updated: true };
    } finally {
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }

  /** Bring an add-on installed from GitHub up to date (nothing happens when GitHub has nothing newer). */
  async updateFromGithub(id: string, by = "you"): Promise<PluginView & { updated: boolean }> {
    const v = this.get(id);
    if (!v) throw new Error(`No plugin ${id}`);
    const src = parseGithubSource(v.source);
    if (!src) throw new Error(`${v.name} was not installed from GitHub, so it has nowhere to update from`);
    const out = await this.installFromGithub(`${src.repo}${src.path ? `/${src.path}` : ""}`, { ref: src.ref, by, onlyIfNew: v.source ?? undefined });
    if (out.id !== id) throw new Error(`${src.repo} now holds add-on ${out.id}, not ${id}`);
    return out;
  }

  /** Update every add-on that came from GitHub; failures are logged on the add-on, never thrown. */
  async updateAllFromGithub(): Promise<string[]> {
    const done: string[] = [];
    for (const v of this.list()) {
      if (!parseGithubSource(v.source)) continue;
      try { if ((await this.updateFromGithub(v.id, "auto-update")).updated) done.push(v.id); }
      catch (e) { this.log.append("plugin.log", { id: v.id, level: "warn", text: `Update check failed: ${(e as Error).message.slice(0, 300)}` }); }
    }
    return done;
  }

  /** Its monthly Claude budget and spend (ai), or null when it has no ai. */
  budget(id: string) {
    const v = this.get(id);
    if (!v) throw new Error(`No plugin ${id}`);
    return this.opts.ai && v.manifest.permissions.includes("ai") ? this.opts.ai.budget(v) : null;
  }

  setBudget(id: string, monthlyUsd: number, by = "you") {
    const v = this.get(id);
    if (!v) throw new Error(`No plugin ${id}`);
    if (!v.manifest.permissions.includes("ai")) throw new Error(`${v.name} does not ask Claude, so it has no budget`);
    if (!this.opts.ai) throw new Error("Claude is not available here");
    this.opts.ai.setBudget(id, monthlyUsd, by);
  }

  /** The one approval: turn it on, granting what its manifest asks for. */
  enable(id: string, opts: { by?: string } = {}): PluginView {
    const v = this.get(id);
    if (!v) throw new Error(`No plugin ${id}`);
    if (!existsSync(v.dir)) throw new Error(`Its folder ${v.dir} is missing; install it again`);
    this.log.append("plugin.enabled", { id, permissions: asksOf(v.manifest), by: opts.by ?? "you" });
    const on = this.get(id)!;
    this.syncAgents(on, true);
    this.start(id);
    return this.get(id)!;
  }

  disable(id: string, opts: { by?: string; reason?: string } = {}): PluginView {
    const v = this.get(id);
    if (!v) throw new Error(`No plugin ${id}`);
    this.stop(id);
    this.syncAgents(v, false);
    if (v.status !== "disabled") this.log.append("plugin.disabled", { id, reason: opts.reason ?? null, by: opts.by ?? "you" });
    return this.get(id)!;
  }

  async remove(id: string, opts: { by?: string } = {}): Promise<{ id: string; removed: true }> {
    const v = this.get(id);
    if (!v) throw new Error(`No plugin ${id}`);
    // The backend runs with the plugin's folder as its working directory, and Windows will not
    // delete a folder a live process sits in (EBUSY). Wait for the backend to exit first.
    await this.stop(id);
    this.syncAgents(v, false);
    const dir = resolve(v.dir);
    if (dir.startsWith(resolve(this.root) + sep)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    this.opts.store?.clear(id);
    this.log.append("plugin.removed", { id, by: opts.by ?? "you" });
    return { id, removed: true };
  }

  /** A plugin's agents join the Agent Bay while it is on (ids prefixed with the plugin's), and retire when it is off. */
  private syncAgents(v: PluginView, on: boolean) {
    const bay = this.opts.bay;
    if (!bay || !v.manifest.agents.length) return;
    if (on && !v.granted.includes("agents")) return;
    for (const rel of v.manifest.agents) {
      try {
        const def = parseAgentFile(readFileSync(join(v.dir, rel), "utf8"));
        const agentId = def.id.startsWith(`${v.id}-`) ? def.id : `${v.id}-${def.id}`.slice(0, 40);
        const cur = bay.get(agentId);
        if (!on) { if (cur && !cur.retired) bay.retire(agentId, true); continue; }
        if (!cur) bay.create({ ...def, id: agentId }, `added by plugin ${v.name}`, `plugin:${v.id}`);
        else {
          if (cur.retired) bay.retire(agentId, false);
          bay.save(agentId, { ...def, id: agentId }, { note: `updated by plugin ${v.name} ${v.version}`, by: `plugin:${v.id}` });
        }
      } catch (e) {
        this.log.append("plugin.log", { id: v.id, level: "error", text: `Agent file ${rel}: ${(e as Error).message}` });
      }
    }
  }

  // ---- backends ----------------------------------------------------------------------------

  /** Start every enabled plugin's backend and begin passing events to them. */
  startAll(): string[] {
    this.listen();
    const started: string[] = [];
    for (const v of this.list()) if (v.status === "enabled" && v.manifest.main && this.start(v.id)) started.push(v.id);
    return started;
  }

  private listen() {
    if (this.listening) return;
    this.listening = true;
    this.log.on("event", (e: SfEvent) => this.dispatch(e));
  }

  private dispatch(e: SfEvent) {
    if (e.type === "plugin.data" || e.type === "plugin.log") return;
    for (const [id, r] of this.running) {
      if (!r.ready) continue;
      // A plugin never hears its own entries back (no loops).
      if (e.type.startsWith("plugin.") && (e.payload as Row)?.id === id) continue;
      const v = this.get(id);
      if (!v || !v.granted.includes("events:read") || !v.manifest.subscribe.some((p) => matchesType(p, e.type))) continue;
      this.send(r, { t: "event", event: e });
    }
  }

  private writeRunner() {
    mkdirSync(join(this.root, ".runtime"), { recursive: true });
    let cur = "";
    try { cur = readFileSync(this.runnerPath, "utf8"); } catch { /* first time */ }
    if (cur !== RUNNER_SOURCE) writeFileSync(this.runnerPath, RUNNER_SOURCE);
  }

  /** Start one plugin's backend. Returns false when it has none or is not on. */
  start(id: string): boolean {
    const v = this.get(id);
    if (!v || v.status !== "enabled" || !v.manifest.main) return false;
    this.listen();
    this.stop(id);
    this.writeRunner();
    const dir = resolve(v.dir);
    const env: Record<string, string> = { SF_PLUGIN: id, NODE_OPTIONS: "" };
    if (process.platform === "win32") for (const k of ["SystemRoot", "SystemDrive", "windir", "TEMP", "TMP"]) if (process.env[k]) env[k] = process.env[k]!;
    const child = spawn(this.opts.node ?? process.execPath, [
      "--permission", `--allow-fs-read=${dir}`, `--allow-fs-read=${this.runnerPath}`,
      "--max-old-space-size=128", this.runnerPath, join(dir, v.manifest.main),
    ], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const r: Running = { child, ready: false, stopping: false, calls: new Map(), rate: new Map(), stderr: "" };
    this.running.set(id, r);
    createInterface({ input: child.stdout! }).on("line", (line) => this.onMessage(id, r, line));
    child.stderr!.on("data", (b: Buffer) => { r.stderr = (r.stderr + b.toString()).slice(-2000); });
    child.on("error", (e) => { r.stderr += `\n${e.message}`; });
    // A backend that exits while we write to it must never take the core down (EPIPE on Windows).
    child.stdin!.on("error", () => { /* the exit handler reports it */ });
    child.on("exit", (code, signal) => this.onExit(id, r, code, signal));
    this.send(r, { t: "init", manifest: v.manifest, data: this.data(id) });
    return true;
  }

  /** Stop a plugin's backend (calls still waiting are refused). Resolves once the process has exited (at most ~3 s). */
  stop(id: string, force = false): Promise<void> {
    const t = this.restartTimers.get(id);
    if (t) { clearTimeout(t); this.restartTimers.delete(id); }
    const r = this.running.get(id);
    if (!r) return Promise.resolve();
    const exited = r.child.exitCode != null || r.child.signalCode != null
      ? Promise.resolve()
      : new Promise<void>((res) => { r.child.once("exit", () => res()); setTimeout(res, 3000).unref(); });
    r.stopping = true;
    this.running.delete(id);
    for (const c of r.calls.values()) { clearTimeout(c.timer); c.rej(new Error("The plugin stopped")); }
    r.calls.clear();
    try { this.send(r, { t: "stop" }); } catch { /* gone */ }
    if (force) { try { killTree(r.child, true); } catch { /* gone */ } }
    else setTimeout(() => { try { killTree(r.child, true); } catch { /* gone */ } }, 500).unref();
    return exited;
  }

  /** `force` kills right away: use it when the core is going down and timers will not fire. */
  stopAll(force = false) { for (const id of [...this.running.keys()]) this.stop(id, force); }

  /** Is the backend up and has it finished loading? */
  isReady(id: string) { return !!this.running.get(id)?.ready; }

  /** Wait until the backend has loaded (for tests and the first call after enabling). */
  async whenReady(id: string, ms = 10_000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (this.isReady(id)) return true;
      if (!this.running.has(id) && !this.restartTimers.has(id)) return false;
      await new Promise((r) => setTimeout(r, 25));
    }
    return this.isReady(id);
  }

  /** Call a method the backend handles (sf.handle). */
  async call(id: string, method: string, args: unknown = {}, timeoutMs = 10_000): Promise<unknown> {
    const v = this.get(id);
    if (!v || v.status !== "enabled") throw new Error(`Plugin ${id} is not turned on`);
    if (!v.manifest.main) throw new Error(`Plugin ${id} has no backend`);
    if (!(await this.whenReady(id, timeoutMs))) throw new Error(`Plugin ${id} is not running${v.error ? `: ${v.error}` : ""}`);
    const r = this.running.get(id)!;
    const rid = this.nextRid++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { r.calls.delete(rid); rej(new Error(`Plugin ${id} did not answer "${method}" within ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
      r.calls.set(rid, { res, rej, timer });
      this.send(r, { t: "call", rid, method: String(method), args });
    });
  }

  private send(r: Running, m: unknown) {
    if (r.child.exitCode != null || r.child.signalCode != null || !r.child.stdin?.writable) return;
    try { r.child.stdin.write(JSON.stringify(m) + "\n"); } catch { /* gone */ }
  }

  private allow(r: Running, kind: keyof typeof LIMITS.perMinute): boolean {
    const minute = Math.floor(Date.now() / 60_000);
    const cur = r.rate.get(kind);
    if (!cur || cur.minute !== minute) { r.rate.set(kind, { minute, n: 1 }); return true; }
    cur.n++;
    return cur.n <= LIMITS.perMinute[kind];
  }

  private onMessage(id: string, r: Running, line: string) {
    let m: Row;
    try { m = JSON.parse(line); } catch { return; }
    if (r.stopping) return;
    const v = this.get(id);
    if (!v) return;
    switch (m.t) {
      case "ready":
        r.ready = true;
        return;
      case "reply": {
        const c = r.calls.get(Number(m.rid));
        if (!c) return;
        r.calls.delete(Number(m.rid));
        clearTimeout(c.timer);
        if (m.ok) c.res(m.value); else c.rej(new Error(String(m.error ?? "failed")));
        return;
      }
      case "log":
        if (!this.allow(r, "log")) return;
        this.log.append("plugin.log", { id, level: ["warn", "error"].includes(m.level) ? m.level : "info", text: String(m.text ?? "").slice(0, LIMITS.logChars) });
        return;
      case "set": {
        if (!this.allow(r, "set")) return;
        const key = String(m.key ?? "").slice(0, 100);
        const size = JSON.stringify(m.value ?? null).length;
        if (!key || size > LIMITS.dataBytes) {
          this.log.append("plugin.log", { id, level: "error", text: `data "${key}" not saved: ${key ? `${size} bytes is over the ${LIMITS.dataBytes} limit` : "empty key"}` });
          return;
        }
        this.log.append("plugin.data", { id, key, value: m.value ?? null });
        return;
      }
      case "req":
        this.answer(id, r, m);
        return;
      case "emit": {
        if (!v.granted.includes("events:write")) {
          this.log.append("plugin.log", { id, level: "error", text: `sf.emit("${String(m.name).slice(0, 40)}") refused: the plugin did not ask for events:write` });
          return;
        }
        if (!this.allow(r, "emit")) return;
        const payload = JSON.stringify(m.payload ?? {}).length > LIMITS.dataBytes ? { truncated: true } : (m.payload ?? {});
        this.log.append("plugin.emitted", { id, name: String(m.name ?? "event").slice(0, 60), payload, projectId: m.projectId == null ? null : Number(m.projectId) });
        return;
      }
    }
  }

  /** A backend asked the core for something only the core can do; the permission is checked here, not in the runner. */
  private async answer(id: string, r: Running, m: Row) {
    const reply = (ok: boolean, value?: unknown, error?: string) => this.send(r, { t: "res", rid: m.rid, ok, value: value ?? null, error });
    try { reply(true, await this.serve(id, String(m.op ?? ""), (m.args && typeof m.args === "object" ? m.args : {}) as Row)); }
    catch (e) { reply(false, null, (e as Error).message.slice(0, 1000)); }
  }

  /** What a backend's sf.ai, sf.store, sf.act and sf.records do. */
  async serve(id: string, op: string, a: Row): Promise<unknown> {
    const v = this.get(id);
    if (!v || v.status !== "enabled") throw new Error(`Plugin ${id} is not turned on`);
    if (op.startsWith("ai.")) {
      if (!v.granted.includes("ai")) throw new Error(`Plugin ${id} may not ask Claude (it did not ask for the ai permission)`);
      if (!this.opts.ai) throw new Error("Claude is not available here");
      if (op === "ai.budget") return this.opts.ai.budget(v);
      if (op === "ai.run") return this.opts.ai.run(v, a as never);
    }
    if (op.startsWith("store.")) {
      if (!v.granted.includes("store")) throw new Error(`Plugin ${id} may not keep a catalog (it did not ask for the store permission)`);
      const st = this.opts.store;
      if (!st) throw new Error("The catalog is not available here");
      if (op === "store.put") return st.put(id, a.coll, a.id, a.doc, a.text);
      if (op === "store.get") return st.get(id, a.coll, a.id);
      if (op === "store.delete") return st.delete(id, a.coll, a.id);
      if (op === "store.count") return st.count(id, a.coll ?? undefined);
      if (op === "store.query") return st.query(id, a as never);
    }
    if (op === "act") return this.act(id, String(a.verb ?? ""), (a.args && typeof a.args === "object" ? a.args : {}) as Record<string, unknown>);
    if (op === "records") return this.records(id, String(a.kind ?? ""), { projectId: a.projectId == null ? null : Number(a.projectId), limit: Number(a.limit) || undefined });
    throw new Error(`Unknown request "${op.slice(0, 40)}"`);
  }

  private onExit(id: string, r: Running, code: number | null, signal: NodeJS.Signals | null) {
    for (const c of r.calls.values()) { clearTimeout(c.timer); c.rej(new Error("The plugin stopped")); }
    if (r.stopping || this.running.get(id) !== r) return;
    this.running.delete(id);
    const why = r.stderr.trim().split("\n").filter(Boolean).slice(-3).join(" | ") || `exited with ${signal ?? `code ${code}`}`;
    this.log.append("plugin.failed", { id, error: why.slice(0, 500), code, signal });
    const v = this.get(id);
    if (!v || v.status !== "enabled") return;
    if (v.crashes >= MAX_CRASHES) {
      this.disable(id, { by: "the host", reason: `Stopped after ${v.crashes} crashes. Last: ${why.slice(0, 300)}` });
      return;
    }
    const t = setTimeout(() => { this.restartTimers.delete(id); this.start(id); }, 500 * v.crashes);
    t.unref();
    this.restartTimers.set(id, t);
  }

  // ---- panels ------------------------------------------------------------------------------

  /** A file of an enabled plugin, for its panels. Null if the path leaves its folder. */
  file(id: string, rel: string): string | null {
    const v = this.get(id);
    if (!v || v.status !== "enabled") return null;
    const base = resolve(v.dir);
    let clean: string;
    try { clean = normalize(decodeURIComponent(rel || "")).replace(/^([/\\])+/, ""); } catch { return null; }
    const full = resolve(base, clean);
    if (full !== base && !full.startsWith(base + sep)) return null;
    // The backend's own files are not served; only what a page could need.
    if (v.manifest.main && full === resolve(base, v.manifest.main)) return null;
    try { return statSync(full).isFile() ? full : null; } catch { return null; }
  }
}
