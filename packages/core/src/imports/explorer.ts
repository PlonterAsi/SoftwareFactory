import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { EventLog } from "../events.js";
import type { AgentRuntime } from "../runtime.js";
import { runAgent } from "../agents.js";
import type { CrewSource } from "../factory/crew.js";
import { createProject, linkToProject, projectOf } from "../projects/service.js";
import { modeOf, SwitchableRuntime } from "../setup.js";
import { scanRepo, type CodeMap } from "./scan.js";
import {
  batchDigests, estimateUsd, heuristicNote, heuristicSuggestions, isCodeModule, mapPrompt, mapText, moduleDigest,
  parseModuleNotes, parseSuggestions, suggestionId, surveyPrompt, type ModuleNote, type Suggestion,
} from "./crew.js";
import "./tables.js";

/**
 * Import a git repo (a URL or a folder on this computer) as a project, then
 * explore it: a free static scan, the Cartographer saying what each module is
 * for, and the Surveyor suggesting fixes and improvements.
 *
 * Read-only by design. A URL is cloned into the factory's own imports folder;
 * a local folder is read where it is and never written to. Agents get text
 * digests and no tools. Suggestions are events that the Council files as
 * proposals; nothing in the repo changes until a person accepts one, and even
 * then work happens on a branch, never on the repo's main line.
 *
 * Spend is estimated before any agent runs and capped per exploration
 * (SF_IMPORT_MAX_USD, default $0.50). Over the cap, the biggest modules are
 * mapped first and the rest are described by the free heuristics. Module
 * understanding is cached by content hash, so exploring again after a few
 * commits only pays for the modules that changed.
 */
export type ExploreMode = "agent" | "heuristic";
export type ExploreStation = "fetch" | "scan" | "map" | "survey" | "visual";
export const EXPLORE_STATIONS: ExploreStation[] = ["fetch", "scan", "map", "survey", "visual"];

export interface ExplorerOptions {
  /** Cap per exploration, USD. */
  maxUsd?: number;
  /** Force agent or heuristic; by default it follows the crew (practice = heuristic). */
  mode?: ExploreMode;
  /** Gives an imported project its own Order Engine root, like POST /api/projects does. */
  createNode?: (title: string) => number;
}

export interface ImportRow {
  projectId: number; source: string; local: boolean; dir: string; branch: string | null; head: string | null;
  status: "importing" | "ready" | "exploring" | "failed"; error: string | null; importedAt: string; exploredAt: string | null;
  explores: number; spentUsd: number; mappedHead: string | null;
}

export interface ExploreResult {
  projectId: number;
  outcome: "done" | "partial" | "cached" | "failed";
  spentUsd: number;
  mapped: number;
  reused: number;
  suggestions: number;
  error?: string;
}

const toRow = (r: Record<string, any>): ImportRow => ({
  projectId: Number(r.project_id), source: r.source, local: !!r.local, dir: r.dir, branch: r.branch, head: r.head, status: r.status, error: r.error,
  importedAt: r.imported_at, exploredAt: r.explored_at, explores: Number(r.explores), spentUsd: Number(r.spent_usd), mappedHead: r.mapped_head,
});

/** Where an imported project's working copy is, for the factory and the ticket crew. Null if it is not an import. */
export function importOf(log: EventLog, projectId: number): ImportRow | null {
  const r = log.db.prepare("SELECT * FROM repo_imports WHERE project_id = ?").get(projectId) as Record<string, any> | undefined;
  return r ? toRow(r) : null;
}

export function listImports(log: EventLog): (ImportRow & { name: string; health: number | null; suggestions: number })[] {
  const rows = log.db.prepare(`SELECT i.*, p.name AS name,
      (SELECT health FROM code_maps m WHERE m.project_id = i.project_id ORDER BY explore DESC LIMIT 1) AS health,
      (SELECT count(*) FROM code_suggestions s WHERE s.project_id = i.project_id) AS suggestions
    FROM repo_imports i LEFT JOIN projects p ON p.id = i.project_id ORDER BY i.imported_at DESC`).all() as Record<string, any>[];
  return rows.map((r) => ({ ...toRow(r), name: r.name ?? basename(r.dir), health: r.health == null ? null : Number(r.health), suggestions: Number(r.suggestions) }));
}

/** The newest code map of a project. */
export function latestMap(log: EventLog, projectId: number): { explore: number; ts: string; map: CodeMap } | null {
  const r = log.db.prepare("SELECT explore, ts, map FROM code_maps WHERE project_id = ? ORDER BY explore DESC LIMIT 1").get(projectId) as { explore: number; ts: string; map: string } | undefined;
  return r ? { explore: Number(r.explore), ts: r.ts, map: JSON.parse(r.map) } : null;
}

export function moduleNotes(log: EventLog, projectId: number): Map<string, { hash: string; purpose: string; role: string; risks: string[]; by: string }> {
  const rows = log.db.prepare("SELECT module, hash, purpose, role, risks, by FROM code_modules WHERE project_id = ?").all(projectId) as Record<string, string>[];
  return new Map(rows.map((r) => [r.module, { hash: r.hash, purpose: r.purpose, role: r.role, risks: JSON.parse(r.risks), by: r.by }]));
}

export function suggestionsOf(log: EventLog, projectId: number) {
  const rank = "CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END";
  return (log.db.prepare(`SELECT * FROM code_suggestions WHERE project_id = ? ORDER BY ${rank}, event_id`).all(projectId) as Record<string, any>[])
    .map((r) => ({ id: r.id, eventId: Number(r.event_id), ts: r.ts, title: r.title, body: r.body, kind: r.kind, lens: r.lens, severity: r.severity, effort: r.effort, files: JSON.parse(r.files) as string[], by: r.by, status: r.status, proposalId: r.proposal_id == null ? null : Number(r.proposal_id) }));
}

/** A short plain-text code map, for the Council's lenses and the Overseer. Null when the project is not an import. */
export function codeMapSummary(log: EventLog, projectId: number, maxChars = 3000): string | null {
  const m = latestMap(log, projectId);
  if (!m) return null;
  const notes = moduleNotes(log, projectId);
  const imp = importOf(log, projectId);
  return `Imported repo ${imp?.source ?? ""}${m.map.head ? ` at ${m.map.head.slice(0, 7)}` : ""}.\n${mapText(m.map, notes, maxChars - 120)}`;
}

/** Everything the Bridge's Code map shows for one project. */
export function importDetail(log: EventLog, projectId: number) {
  const imp = importOf(log, projectId);
  if (!imp) return null;
  const m = latestMap(log, projectId);
  const notes = moduleNotes(log, projectId);
  const explores = (log.db.prepare("SELECT id, ts, type, payload FROM events WHERE type LIKE 'repo.explore.%' AND json_extract(payload, '$.projectId') = ? ORDER BY id DESC LIMIT 60").all(projectId) as { id: number; ts: string; type: string; payload: string }[])
    .map((e) => ({ id: Number(e.id), ts: e.ts, type: e.type, ...JSON.parse(e.payload) }));
  return { import: imp, map: m, notes: Object.fromEntries(notes), suggestions: suggestionsOf(log, projectId), explores: explores.reverse() };
}

export class RepoExplorer {
  private running = new Map<number, Promise<ExploreResult>>();

  constructor(
    private log: EventLog,
    private runtime: AgentRuntime | null,
    /** Where URL imports are cloned. */
    readonly importsDir: string,
    private crew?: CrewSource,
    readonly opts: ExplorerOptions = {},
  ) {}

  get maxUsd() { return this.opts.maxUsd ?? Number(process.env.SF_IMPORT_MAX_USD ?? 0.5); }

  mode(): ExploreMode {
    if (this.opts.mode) return this.opts.mode;
    if (!this.runtime) return "heuristic";
    const m = this.runtime instanceof SwitchableRuntime ? this.runtime.mode : modeOf(this.runtime);
    return m === "real" ? "agent" : "heuristic";
  }

  /**
   * Import a repo as a project and start exploring it. Returns as soon as the
   * project exists; cloning and exploring continue in the background.
   * Importing the same source again re-explores the project it already became.
   */
  importRepo(sourceIn: string, o: { name?: string; maxUsd?: number; explore?: boolean } = {}): { projectId: number; existing: boolean; done: Promise<ExploreResult> } {
    const src = normalizeSource(sourceIn);
    const known = projectOf(this.log, { kind: "repo", ref: src.ref });
    if (known != null && importOf(this.log, known)) return { projectId: known, existing: true, done: this.explore(known, { maxUsd: o.maxUsd }) };
    if (src.local) {
      if (!existsSync(src.ref) || !statSync(src.ref).isDirectory()) throw new Error(`No folder at ${src.ref}`);
    }
    const name = (o.name ?? src.name).trim() || "Imported repo";
    const projectId = createProject(this.log, { name, kind: "imported", summary: `Imported from ${src.ref}` });
    if (this.opts.createNode) linkToProject(this.log, projectId, "order_node", this.opts.createNode(name));
    linkToProject(this.log, projectId, "repo", src.ref);
    const dir = src.local ? src.ref : join(this.importsDir, `${slug(name)}-${projectId}`);
    this.log.append("repo.import.started", { projectId, source: src.ref, local: src.local, dir });
    const done = this.guard(projectId, async () => {
      if (!src.local) {
        this.station(projectId, 0, "fetch", "active", `cloning ${src.ref}`);
        mkdirSync(this.importsDir, { recursive: true });
        try {
          await git(["clone", "--no-tags", "--", src.url, dir], this.importsDir, 10 * 60_000);
        } catch (e) {
          const error = cloneHint((e as Error).message);
          this.station(projectId, 0, "fetch", "fail", error);
          this.log.append("repo.import.failed", { projectId, source: src.ref, error });
          return { projectId, outcome: "failed", spentUsd: 0, mapped: 0, reused: 0, suggestions: 0, error } as ExploreResult;
        }
      }
      const g = headOf(dir);
      this.log.append("repo.imported", { projectId, source: src.ref, local: src.local, dir, ...g });
      if (o.explore === false) return { projectId, outcome: "cached", spentUsd: 0, mapped: 0, reused: 0, suggestions: 0 } as ExploreResult;
      return this.exploreNow(projectId, { maxUsd: o.maxUsd, fetched: !src.local });
    });
    return { projectId, existing: false, done };
  }

  /** Explore (again): pull a cloned repo, rescan, and ask agents only about what changed. */
  explore(projectId: number, o: { maxUsd?: number } = {}): Promise<ExploreResult> {
    const busy = this.running.get(projectId);
    if (busy) return busy;
    return this.guard(projectId, () => this.exploreNow(projectId, o));
  }

  busy(projectId: number) { return this.running.has(projectId); }

  /** Wait for every exploration in flight (tests, shutdown). */
  async idle() { while (this.running.size) await Promise.allSettled([...this.running.values()]); }

  private guard(projectId: number, fn: () => Promise<ExploreResult>): Promise<ExploreResult> {
    const p = fn().catch((e) => {
      const error = (e as Error).message;
      this.log.append("repo.explore.finished", { projectId, explore: 0, outcome: "failed", error, spentUsd: 0 });
      return { projectId, outcome: "failed", spentUsd: 0, mapped: 0, reused: 0, suggestions: 0, error } as ExploreResult;
    }).finally(() => { if (this.running.get(projectId) === p) this.running.delete(projectId); });
    this.running.set(projectId, p);
    return p;
  }

  private station(projectId: number, explore: number, station: ExploreStation, state: "active" | "pass" | "fail" | "skipped", note?: string, extra: Record<string, unknown> = {}) {
    this.log.append("repo.explore.station", { projectId, explore, station, state, ...(note ? { note } : {}), ...extra });
  }

  private async exploreNow(projectId: number, o: { maxUsd?: number; fetched?: boolean }): Promise<ExploreResult> {
    const imp = importOf(this.log, projectId);
    if (!imp) throw new Error(`Project #${projectId} was not imported from a repo`);
    const cap = o.maxUsd ?? this.maxUsd;
    const mode = this.mode();
    const start = this.log.append("repo.explore.started", { projectId, mode, capUsd: cap, source: imp.source });
    const ex = start.id;

    // 1. Fetch: a clone is brought up to date; a local folder is read as it is.
    if (imp.local) this.station(projectId, ex, "fetch", "skipped", "a folder on this computer: read where it is, never changed");
    else if (o.fetched) this.station(projectId, ex, "fetch", "pass", "cloned");
    else {
      this.station(projectId, ex, "fetch", "active", "pulling the newest commits");
      try { await git(["pull", "--ff-only", "--no-tags"], imp.dir, 5 * 60_000); this.station(projectId, ex, "fetch", "pass", "up to date with its remote"); }
      catch (e) { this.station(projectId, ex, "fetch", "fail", `could not pull, exploring the copy we have: ${(e as Error).message.slice(0, 160)}`); }
    }

    // 2. Scan: free and complete.
    this.station(projectId, ex, "scan", "active");
    const map = scanRepo(imp.dir);
    const prev = moduleNotes(this.log, projectId);
    const code = map.modules.filter(isCodeModule);
    const changed = code.filter((m) => prev.get(m.id)?.hash !== m.hash);
    const reused = code.length - changed.length;
    this.log.append("repo.mapped", { projectId, explore: ex, map });
    this.station(projectId, ex, "scan", "pass", `${map.files} files, ${map.lines} lines, ${map.modules.length} modules, health ${map.health.score}/100 in ${map.ms} ms`);

    // Nothing changed since the last exploration: everything is cached, nothing is spent.
    const hadSuggestions = !!(this.log.db.prepare("SELECT 1 FROM code_suggestions WHERE project_id = ? LIMIT 1").get(projectId));
    if (!changed.length && prev.size && hadSuggestions) {
      this.station(projectId, ex, "map", "skipped", `all ${reused} modules unchanged: cached`);
      this.station(projectId, ex, "survey", "skipped", "nothing changed since the last survey");
      this.visualCheck(projectId, ex, map);
      this.log.append("repo.explore.finished", { projectId, explore: ex, outcome: "cached", spentUsd: 0, mapped: 0, reused, suggestions: 0, head: map.head });
      return { projectId, outcome: "cached", spentUsd: 0, mapped: 0, reused, suggestions: 0 };
    }

    // 3. Estimate, then map within the cap: biggest modules first.
    const repoName = imp.source;
    const digests = changed.map((m) => ({ id: m.id, text: moduleDigest(imp.dir, m) }));
    const surveyChars = mapText(map, new Map()).length + 2000;
    const allBatches = batchDigests(digests);
    const full = mode === "agent" ? estimateUsd(allBatches.length + 1, digests.reduce((s, d) => s + d.text.length, 0) + surveyChars) : 0;
    let take = digests;
    if (mode === "agent" && full > cap) {
      take = [];
      for (const d of digests) { if (estimateUsd(batchDigests([...take, d]).length + 1, [...take, d].reduce((s, x) => s + x.text.length, 0) + surveyChars) > cap) break; take.push(d); }
    }
    const batches = batchDigests(take);
    const estimate = mode === "agent" ? estimateUsd(batches.length + 1, take.reduce((s, d) => s + d.text.length, 0) + surveyChars) : 0;
    this.station(projectId, ex, "map", "active", mode === "agent"
      ? `${changed.length} module${changed.length === 1 ? "" : "s"} to map (${reused} cached); estimate $${estimate.toFixed(3)} of a $${cap.toFixed(2)} cap${take.length < digests.length ? `; the full map would be about $${full.toFixed(3)}, so ${digests.length - take.length} smaller modules get the free description` : ""}`
      : `practice crew: free descriptions for ${changed.length} modules (${reused} cached)`, { estimateUsd: estimate, fullUsd: full, capUsd: cap, calls: mode === "agent" ? batches.length + 1 : 0 });

    let spent = 0;
    let mapped = 0;
    const understood = new Set<string>();
    const note = (n: ModuleNote, by: string) => {
      const m = changed.find((x) => x.id === n.id);
      if (!m || understood.has(m.id)) return;
      understood.add(m.id);
      this.log.append("repo.module.understood", { projectId, explore: ex, module: m.id, hash: m.hash, purpose: n.purpose, role: n.role, risks: n.risks, by });
    };
    if (mode === "agent" && this.runtime) {
      const cart = this.crew?.crewFor("map")[0];
      for (const b of batches) {
        if (spent >= cap) break;
        const r = await runAgent(this.log, this.runtime, cart?.id ?? "cartographer", {
          prompt: mapPrompt(repoName, b), model: cart?.model ?? "haiku", systemPrompt: cart?.role,
          budgetUsd: Number(Math.max(0.01, Math.min(cart?.budgetUsd ?? 0.05, cap - spent)).toFixed(4)), pluginDirs: cart?.pluginDirs.length ? cart.pluginDirs : undefined,
        }, { station: "map", agentVersion: cart?.version });
        spent += r.result?.costUsd ?? 0;
        for (const n of (r.result && parseModuleNotes(r.result.text)) || []) { note(n, cart?.id ?? "cartographer"); mapped++; }
      }
    }
    for (const m of changed) if (!understood.has(m.id)) note(heuristicNote(m), "heuristic");
    // A module that is gone keeps no note: its row stays for history, the Bridge draws only what the map has.
    this.station(projectId, ex, "map", "pass", mode === "agent" ? `${mapped} modules mapped by the Cartographer, ${changed.length - mapped} described for free, ${reused} cached; spent $${spent.toFixed(4)}` : `${changed.length} described, ${reused} cached`, { spentUsd: Number(spent.toFixed(6)) });

    // 4. Survey: suggestions, each one a proposal for the Council's queue.
    this.station(projectId, ex, "survey", "active");
    let suggestions: Suggestion[] | null = null;
    let by = "heuristic";
    const notes = moduleNotes(this.log, projectId);
    if (mode === "agent" && this.runtime && spent < cap) {
      const sv = this.crew?.crewFor("survey")[0];
      const r = await runAgent(this.log, this.runtime, sv?.id ?? "surveyor", {
        prompt: surveyPrompt(repoName, mapText(map, notes)), model: sv?.model ?? "haiku", systemPrompt: sv?.role,
        budgetUsd: Number(Math.max(0.01, Math.min(sv?.budgetUsd ?? 0.1, cap - spent)).toFixed(4)), pluginDirs: sv?.pluginDirs.length ? sv.pluginDirs : undefined,
      }, { station: "survey", agentVersion: sv?.version });
      spent += r.result?.costUsd ?? 0;
      suggestions = r.result ? parseSuggestions(r.result.text) : null;
      if (suggestions) by = sv?.id ?? "surveyor";
    }
    // The free survey always adds what the health flags prove (a committed secret must never be missed).
    const free = heuristicSuggestions(map);
    const all = [...(suggestions ?? []), ...free.filter((f) => !suggestions || f.severity === "critical" || f.severity === "high")];
    const known = new Set((this.log.db.prepare("SELECT id FROM code_suggestions WHERE project_id = ?").all(projectId) as { id: string }[]).map((r) => r.id));
    const knownFiles = new Set([...map.modules.map((m) => m.id), ...map.largest.map((f) => f.path)]);
    let filed = 0;
    for (const s of all) {
      const id = suggestionId(projectId, s.title);
      if (known.has(id)) continue;
      known.add(id);
      const byThis = free.includes(s) ? "heuristic" : by;
      this.log.append("repo.suggestion", { projectId, explore: ex, suggestionId: id, ...s, grounded: s.files.some((f) => knownFiles.has(f) || [...knownFiles].some((k) => f.startsWith(k))), by: byThis });
      filed++;
    }
    this.station(projectId, ex, "survey", "pass", `${filed} new suggestion${filed === 1 ? "" : "s"} sent to the Council's queue${all.length - filed ? `, ${all.length - filed} already known` : ""}`, { spentUsd: Number(spent.toFixed(6)) });

    this.visualCheck(projectId, ex, map);
    const outcome = mode === "agent" && take.length < digests.length ? "partial" : "done";
    this.log.append("repo.explore.finished", { projectId, explore: ex, outcome, spentUsd: Number(spent.toFixed(6)), mapped, reused, suggestions: filed, head: map.head });
    return { projectId, outcome, spentUsd: Number(spent.toFixed(6)), mapped, reused, suggestions: filed };
  }

  /** visualizeEverything: every module is a node on the map, every dependency an edge, every suggestion a card. */
  private visualCheck(projectId: number, ex: number, map: CodeMap) {
    const notes = moduleNotes(this.log, projectId);
    const items: string[] = [];
    const missing: string[] = [];
    const code = map.modules.filter(isCodeModule);
    const unnoted = code.filter((m) => !notes.has(m.id));
    (unnoted.length ? missing : items).push(unnoted.length ? `${unnoted.length} modules without a note: ${unnoted.slice(0, 4).map((m) => m.id).join(", ")}` : `${code.length} code modules on the map, each with its purpose`);
    items.push(`${map.edges.length} dependencies drawn`, `${map.health.flags.length} health flags`, `${suggestionsOf(this.log, projectId).length} suggestion cards`);
    this.station(projectId, ex, "visual", missing.length ? "fail" : "pass", missing.length ? missing.join("; ") : "every module, dependency and suggestion has a visual", { items, missing });
  }
}

/** A repo source: a folder on this computer, a git URL, or owner/name for GitHub. */
export function normalizeSource(input: string): { local: boolean; ref: string; url: string; name: string } {
  const s = input.trim().replace(/^["']|["']$/g, "");
  if (!s) throw new Error("Give a git URL (https://github.com/owner/repo) or a folder on this computer");
  if (isAbsolute(s) || /^[A-Za-z]:[\\/]/.test(s) || s.startsWith("~")) {
    const ref = resolve(s.startsWith("~") ? s.replace(/^~/, process.env.HOME ?? process.env.USERPROFILE ?? "~") : s);
    return { local: true, ref, url: ref, name: basename(ref) };
  }
  let url = s;
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) url = `https://github.com/${s}`;
  if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(url)) throw new Error(`"${s}" is neither a git URL nor a full folder path`);
  if (/^https?:\/\/[^/]*@/.test(url)) throw new Error("Leave the password or token out of the URL; Git asks for it, or uses the sign-in you already have");
  const clean = url.replace(/\/+$/, "").replace(/\.git$/, "");
  const name = clean.split(/[/:]/).pop() || "repo";
  return { local: false, ref: clean, url: /^https?:\/\//.test(clean) ? `${clean}.git` : url, name };
}

function headOf(dir: string): { head: string | null; branch: string | null } {
  const run = (args: string[]) => { try { return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim(); } catch { return null; } };
  return { head: run(["rev-parse", "HEAD"]), branch: run(["rev-parse", "--abbrev-ref", "HEAD"]) };
}

function git(args: string[], cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((ok, fail) => {
    // Never prompt in a hidden window: a private repo without a saved sign-in fails fast with a hint instead.
    const child = spawn("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"], windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let err = "";
    const t = setTimeout(() => { child.kill(); fail(new Error(`git ${args[0]} took longer than ${Math.round(timeoutMs / 60000)} minutes`)); }, timeoutMs);
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(t); fail(e); });
    child.on("close", (code) => { clearTimeout(t); code === 0 ? ok() : fail(new Error(err.trim().split("\n").slice(-2).join(" ") || `git ${args[0]} exited ${code}`)); });
  });
}

function cloneHint(raw: string): string {
  if (/ENOENT/.test(raw)) return "Git is not installed. Install Git for Windows (git-scm.com/download/win), then import again.";
  if (/Authentication failed|could not read Username|terminal prompts disabled|Repository not found|403/i.test(raw)) return `Git could not open that repo: it is private or does not exist. Sign in once with Git on this computer (for GitHub: run "git clone <url>" in a terminal and follow the sign-in), then import again. (${raw.slice(0, 160)})`;
  if (/Could not resolve host|unable to access/i.test(raw)) return `No connection to the repo's host. Check the URL and the network, then import again. (${raw.slice(0, 160)})`;
  return raw.slice(0, 300);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "repo";
