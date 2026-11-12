import { spawn } from "node:child_process";
import { splitArgs } from "../launch/detect.js";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, isAbsolute, join, normalize, sep } from "node:path";
import type { EventLog } from "../events.js";
import { linkToProject, projectDetail } from "../projects/service.js";
import { assessProject, detectForms, type IntegrationForm, type ReadinessCheck } from "./assess.js";
import type { PluginHost } from "../plugins/host.js";
import "./tables.js";

/**
 * Adding a finished project into SoftwareFactory.
 *
 *   request  → [gate: you approve] → install a frozen copy (tool, panel)  → it appears on the Features page
 *                                  → write a pull-request brief (source)  → copy it to a thread or the Council
 *
 * The copy lives in <data>/extensions/<slug>-<id>/, apart from the project's own folder, so
 * later work on the project never breaks the installed feature; a newer shipped version
 * is added with Update. Installed features need no new SoftwareFactory release: they load
 * from the data folder at runtime.
 *
 * The approval is the gate: the first time a project is added in a form, you approve it.
 * Updating a feature you already approved, from the same project and in the same form,
 * goes through on its own when the project is still ready (minimal approvals).
 */
export interface Integration {
  id: number;
  projectId: number;
  form: IntegrationForm;
  title: string;
  slug: string;
  summary: string;
  sourceDir: string;
  sourceKind: string;
  sourceRef: number | null;
  sha: string | null;
  entry: string | null;
  checks: ReadinessCheck[];
  status: "awaiting" | "installing" | "installed" | "briefed" | "rejected" | "failed" | "removed" | "replaced";
  requestedAt: string;
  requestedBy: string;
  decidedAt: string | null;
  decidedBy: string | null;
  note: string | null;
  dir: string | null;
  head: string | null;
  files: number | null;
  bytes: number | null;
  brief: string | null;
  error: string | null;
  uses: number;
  lastUsedAt: string | null;
  lastOk: boolean | null;
}

type Row = Record<string, any>;

function toIntegration(r: Row): Integration {
  return {
    id: Number(r.id), projectId: Number(r.project_id), form: r.form, title: r.title, slug: r.slug, summary: r.summary ?? "",
    sourceDir: r.source_dir, sourceKind: r.source_kind, sourceRef: r.source_ref == null ? null : Number(r.source_ref), sha: r.sha ?? null, entry: r.entry ?? null,
    checks: (() => { try { return JSON.parse(r.checks); } catch { return []; } })(), status: r.status, requestedAt: r.requested_at, requestedBy: r.requested_by,
    decidedAt: r.decided_at ?? null, decidedBy: r.decided_by ?? null, note: r.note ?? null, dir: r.dir ?? null, head: r.head ?? null,
    files: r.files == null ? null : Number(r.files), bytes: r.bytes == null ? null : Number(r.bytes), brief: r.brief ?? null, error: r.error ?? null,
    uses: Number(r.uses ?? 0), lastUsedAt: r.last_used_at ?? null, lastOk: r.last_ok == null ? null : !!r.last_ok,
  };
}

export function getIntegration(log: EventLog, id: number): Integration | null {
  const r = log.db.prepare("SELECT * FROM integrations WHERE id = ?").get(id) as Row | undefined;
  return r ? toIntegration(r) : null;
}

/** Everything ever requested, newest first. */
export function listIntegrations(log: EventLog, opts: { projectId?: number } = {}): Integration[] {
  const rows = opts.projectId != null
    ? log.db.prepare("SELECT * FROM integrations WHERE project_id = ? ORDER BY id DESC").all(opts.projectId)
    : log.db.prepare("SELECT * FROM integrations ORDER BY id DESC").all();
  return (rows as Row[]).map(toIntegration);
}

/** The Features page: what is installed now (one per project and form). */
export function installedFeatures(log: EventLog): Integration[] {
  // Plugins live on the Plugins page, not here.
  return listIntegrations(log).filter((i) => i.status === "installed" && i.form !== "plugin");
}

/** Split an arguments line the way a shell would for simple cases: spaces, "double" and 'single' quotes. */
export { splitArgs } from "../launch/detect.js";

export interface ToolRun { exitCode: number | null; stdout: string; stderr: string; ms: number; timedOut: boolean; args: string[] }

const MAX_OUTPUT = 256 * 1024;

/** Walk a folder for its file count and size (skipping .git). */
function measure(dir: string): { files: number; bytes: number } {
  let files = 0, bytes = 0;
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (n === ".git") continue;
      const p = join(d, n);
      const s = statSync(p);
      if (s.isDirectory()) walk(p); else { files++; bytes += s.size; }
    }
  };
  walk(dir);
  return { files, bytes };
}

export class Integrations {
  constructor(private log: EventLog, readonly extDir: string, private plugins?: PluginHost) {}

  assess(projectId: number) { return assessProject(this.log, projectId); }

  /** Ask to add a project in a form. Returns the request (an existing open one if there is). */
  request(projectId: number, form: IntegrationForm, opts: { by?: string } = {}): Integration {
    const a = assessProject(this.log, projectId);
    if (!a) throw new Error(`No project #${projectId}`);
    if (!a.source) throw new Error(`${a.name} has nothing finished yet: ship a run or import its repo first.`);
    const fail = a.checks.find((c) => c.state === "fail");
    if (fail) throw new Error(`${a.name} is not ready: ${fail.label.toLowerCase()}: ${fail.detail}`);
    const opt = a.forms.find((f) => f.form === form);
    if (!opt?.available) throw new Error(`${a.name} cannot be added as a ${form}: ${opt?.why ?? "unknown form"}`);
    const open = listIntegrations(this.log, { projectId }).find((i) => i.form === form && (i.status === "awaiting" || i.status === "installing"));
    if (open) return open;
    const id = this.log.append("integration.requested", {
      projectId, form, title: a.name, slug: a.slug, summary: a.summary.slice(0, 500), sourceDir: a.source.dir, sourceKind: a.source.kind, sourceRef: a.source.ref,
      sha: a.source.sha, entry: opt.entry, checks: a.checks, by: opts.by ?? "you",
    }).id;
    try { linkToProject(this.log, projectId, "integration", id); } catch { /* linking is a nicety */ }
    // An update of a feature you already approved (same project, same form) needs no second approval.
    const approvedBefore = listIntegrations(this.log, { projectId }).some((i) => i.id !== id && i.form === form && (i.status === "installed" || i.status === "briefed"));
    if (approvedBefore) this.decide(id, true, { by: "auto", note: "Update of a feature you already approved" });
    return getIntegration(this.log, id)!;
  }

  /** The gate: approve installs (or writes the brief); reject closes the request. */
  decide(id: number, approve: boolean, opts: { note?: string; by?: string } = {}): Integration {
    const i = getIntegration(this.log, id);
    if (!i) throw new Error(`No integration #${id}`);
    if (i.status !== "awaiting") throw new Error(`Integration #${id} is ${i.status}, not waiting for a decision`);
    this.log.append("integration.decided", { id, approve, note: opts.note?.slice(0, 500) ?? null, by: opts.by ?? "you" });
    if (approve) {
      try {
        if (i.form === "source") this.log.append("integration.briefed", { id, brief: this.brief(i) });
        else this.install(i, opts.by ?? "you");
      } catch (e) {
        this.log.append("integration.failed", { id, error: (e as Error).message });
      }
    }
    return getIntegration(this.log, id)!;
  }

  private install(i: Integration, by = "you") {
    if (!existsSync(i.sourceDir)) throw new Error(`${i.sourceDir} is missing`);
    if (i.form === "plugin") {
      // Your approval here is the plugin's approval too: it is copied into the plugins folder and turned on.
      if (!this.plugins) throw new Error("Plugins are not available in this core");
      const p = this.plugins.install(i.sourceDir, { from: `project:${i.projectId}`, by: "integrate" });
      // An update approved on its own never grants new permissions: it stays off until you turn it on.
      if (p.status !== "enabled" && by !== "auto") this.plugins.enable(p.id, { by: `${by} (Integrate)` });
      this.log.append("integration.installed", { id: i.id, dir: p.dir, head: i.sha, ...measure(p.dir) });
      return;
    }
    const dest = join(this.extDir, `${i.slug}-${i.id}`);
    mkdirSync(this.extDir, { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    cpSync(i.sourceDir, dest, { recursive: true, filter: (src) => basename(src) !== ".git" });
    // The copy must still hold what was promised (a tool's script, a panel's page).
    const forms = detectForms(dest).forms;
    const ok = forms.find((f) => f.form === i.form && f.available && f.entry === i.entry);
    if (!ok) throw new Error(`The copy has no ${i.form === "tool" ? i.entry : "index.html"}`);
    const m = measure(dest);
    this.log.append("integration.installed", { id: i.id, dir: dest, head: i.sha, ...m });
  }

  /** Take an installed feature out of SoftwareFactory and delete its copy. The project itself is untouched. */
  async remove(id: number, opts: { by?: string } = {}): Promise<Integration> {
    const i = getIntegration(this.log, id);
    if (!i) throw new Error(`No integration #${id}`);
    if (i.status === "removed") return i;
    if (i.form === "plugin" && i.status === "installed" && i.entry && this.plugins?.get(i.entry)) await this.plugins.remove(i.entry);
    else if (i.dir && i.dir.startsWith(this.extDir)) rmSync(i.dir, { recursive: true, force: true });
    this.log.append("integration.removed", { id, by: opts.by ?? "you" });
    return getIntegration(this.log, id)!;
  }

  /** Run an installed tool with an arguments line. Its environment is scrubbed of keys, like the factory's tests. */
  runTool(id: number, argsLine: string, opts: { stdin?: string; timeoutMs?: number } = {}): Promise<ToolRun> {
    const i = getIntegration(this.log, id);
    if (!i || i.status !== "installed" || i.form !== "tool" || !i.dir || !i.entry) return Promise.reject(new Error(`#${id} is not an installed tool`));
    const args = splitArgs(argsLine).slice(0, 64);
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? process.env.USERPROFILE ?? i.dir };
    if (process.platform === "win32") for (const k of ["SystemRoot", "SystemDrive", "windir", "TEMP", "TMP", "PATHEXT", "ComSpec", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) if (process.env[k]) env[k] = process.env[k];
    const started = Date.now();
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [join(i.dir!, i.entry!), ...args], { cwd: i.dir!, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let stdout = "", stderr = "", timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.timeoutMs ?? 60_000);
      child.stdout.on("data", (d) => { if (stdout.length < MAX_OUTPUT) stdout += d; });
      child.stderr.on("data", (d) => { if (stderr.length < MAX_OUTPUT) stderr += d; });
      child.stdin.on("error", () => {});
      child.stdin.end(opts.stdin ?? "");
      const done = (exitCode: number | null, extra = "") => {
        clearTimeout(timer);
        const r: ToolRun = { exitCode, stdout: stdout.slice(0, MAX_OUTPUT), stderr: (stderr + extra).slice(0, MAX_OUTPUT), ms: Date.now() - started, timedOut, args };
        this.log.append("integration.used", { id, ok: exitCode === 0 && !timedOut, exitCode, ms: r.ms, args: args.join(" ").slice(0, 300) });
        resolve(r);
      };
      child.on("error", (e) => done(null, e.message));
      child.on("close", (code) => done(code));
    });
  }

  /** The file to serve for a panel feature, or null. Never leaves the feature's web folder. */
  panelFile(id: number, relPath: string): string | null {
    const i = getIntegration(this.log, id);
    if (!i || i.status !== "installed" || i.form !== "panel" || !i.dir) return null;
    const root = join(i.dir, i.entry ?? "");
    let rel: string;
    try { rel = decodeURIComponent(relPath || "index.html"); } catch { return null; }
    if (!rel || rel.endsWith("/")) rel += "index.html";
    if (rel.includes("\0") || isAbsolute(rel)) return null;
    const n = normalize(rel);
    if (n.startsWith("..") || n.split(sep).includes("..")) return null;
    const abs = join(root, n);
    try { return statSync(abs).isFile() ? abs : null; } catch { return null; }
  }

  /** A brief that a thread (or the Council) can turn into a pull request to SoftwareFactory. */
  brief(i: Pick<Integration, "projectId" | "title" | "summary" | "sourceDir" | "sourceKind" | "sourceRef" | "sha" | "checks">): string {
    const d = projectDetail(this.log, i.projectId);
    const forms = existsSync(i.sourceDir) ? detectForms(i.sourceDir).forms.filter((f) => f.available && f.form !== "source").map((f) => `${f.form} (${f.why})`) : [];
    return [
      `# Build "${i.title}" into SoftwareFactory`,
      ``,
      `Fold the finished project "${i.title}" (project #${i.projectId}${d ? `, ${d.kind}` : ""}) into SoftwareFactory's own code, so it ships with the app.`,
      i.summary ? `\nWhat it does: ${i.summary}` : ``,
      ``,
      `## Source`,
      `- Folder: ${i.sourceDir}`,
      `- ${i.sourceKind === "factory_run" ? `Shipped by factory run #${i.sourceRef}` : "Imported repo"}${i.sha ? `, commit ${i.sha}` : ""}`,
      forms.length ? `- Already works as: ${forms.join("; ")}` : `- Has no runnable entry of its own`,
      ``,
      `## Readiness`,
      ...i.checks.map((c) => `- [${c.state === "pass" ? "x" : " "}] ${c.label}: ${c.detail}`),
      ``,
      `## How to do it`,
      `1. Work on a new branch of PlonterAsi/SoftwareFactory; open a pull request, never push to main.`,
      `2. Put its logic in packages/core/src/<feature>/ with tests in packages/core/test/; persisted data goes through a projection (docs/storage.md), not loose files.`,
      `3. Give it a place on the Bridge: a project panel (registerProjectPanel) or a page, and a visual of what it does (visualizeEverything).`,
      `4. Keep the original's behaviour: port its tests along with it.`,
      `5. Once it merges and the app updates, remove the installed copy from the Features page if there is one.`,
    ].join("\n");
  }
}
