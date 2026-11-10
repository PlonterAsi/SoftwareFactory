import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EventLog, type SfEvent } from "./events.js";
import { captureSignal, listSignals } from "./signals.js";
import { costSummary, runAgent } from "./agents.js";
import { runtimeFromEnv, type AgentRuntime } from "./runtime.js";
import { Factory, type GateId } from "./factory/loop.js";
import { OrderEngine, type OrderOptions } from "./order/engine.js";
import { canonFor, type NodeKind } from "./order/model.js";
import { AgentBay } from "./bay/bay.js";
import { SLOTS, type Slot } from "./bay/agentfile.js";
import { storeReport } from "./store/inspect.js";
import "./bridge/tables.js";
import { DropFolder } from "./bridge/drop.js";
import { buildSuggestion, lastSeen, sinceReport, statusDigest } from "./bridge/status.js";
import { SwitchableRuntime, checkGit, modeOf, runtimeFor, setupReport, type CrewMode } from "./setup.js";

/** The built-in Overseer's prompt with its station contract (the live one comes from the Agent Bay). */
export const OVERSEER_ROLE =
  "You are the Overseer, the manager AI of SoftwareFactory. Answer in at most 3 short sentences. Be concrete.";

export interface CoreOptions {
  log: EventLog;
  runtime: AgentRuntime;
  /** Default spend cap per agent call, USD. */
  budgetUsd?: number;
  /** Where factory runs create their project repos. */
  projectsDir?: string;
  /** Order Engine options; by default the agent Archivist runs on any real runtime, heuristics on the mock. */
  order?: OrderOptions;
  /** The drop folder: notes saved here become Signals. Off when absent. */
  dropDir?: string;
  /** Where the database lives (shown in the setup panel). */
  dataDir?: string;
}

/** Build the core HTTP handler: a small JSON API plus a server-sent event stream. */
export function createCore({ log, runtime, budgetUsd = 0.25, projectsDir = resolve(process.cwd(), ".sf-data/projects"), order: orderOpts, dropDir, dataDir }: CoreOptions) {
  const bay = new AgentBay(log, runtime);
  const settings = readSettings(log);
  const drop = new DropFolder(log, settings.dropDir ?? dropDir ?? join(homedir(), "SoftwareFactory", "Drop"));
  // Git is needed to ship anything; checking costs a process spawn, so remember it for a minute.
  let gitOk: { ok: boolean; at: number } = { ok: true, at: 0 };
  const gitReady = () => {
    if (Date.now() - gitOk.at > 60_000) gitOk = { ok: checkGit().found, at: Date.now() };
    return gitOk.ok;
  };
  const factory = new Factory(log, runtime, projectsDir, bay);
  const order = new OrderEngine(log, runtime, { crew: bay, ...orderOpts });
  // Every Signal, from the Overseer channel or a factory intake, is filed by the Order Engine.
  log.on("event", (e: SfEvent) => {
    if (e.type !== "signal.captured") return;
    const p = e.payload as { text: string; source: string };
    order.ingest({ id: e.id, text: p.text, source: p.source }).catch((err) => console.error("order ingest failed:", err));
  });
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    if (req.method === "OPTIONS") return end(res, 204);
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { ok: true, runtime: runtime.name, mode: runtime instanceof SwitchableRuntime ? runtime.mode : modeOf(runtime) });
      if (req.method === "GET" && url.pathname === "/api/setup") {
        const fresh = url.searchParams.get("fresh") === "1";
        if (fresh) gitOk.at = 0;
        return json(res, 200, { ...setupReport(runtime, fresh), paths: { data: dataDir ?? dirname(projectsDir), projects: projectsDir, drop: drop.dir }, drops: drop.recent(10) });
      }
      if (req.method === "POST" && url.pathname === "/api/setup/mode") {
        const body = await readJson(req);
        const mode = body.mode === "real" ? "real" : "practice";
        if (!(runtime instanceof SwitchableRuntime)) return json(res, 409, { error: "This core was started with a fixed runtime." });
        const rep = setupReport(runtime, true);
        if (mode === "real" && !rep.claude.found) return json(res, 409, { error: rep.claude.hint });
        runtime.switchTo(mode);
        // The Archivist follows the crew unless its mode was pinned (SF_ORDER_MODE).
        if (!orderOpts?.mode) order.opts.mode = mode === "real" ? "agent" : "heuristic";
        log.append("settings.changed", { key: "crewMode", value: mode });
        return json(res, 200, { ...setupReport(runtime), paths: { data: dataDir ?? dirname(projectsDir), projects: projectsDir, drop: drop.dir }, drops: drop.recent(10) });
      }
      if (req.method === "POST" && url.pathname === "/api/setup/drop") {
        const body = await readJson(req);
        const dir = String(body.dir ?? "").trim();
        if (!dir || !isAbsolute(dir)) return json(res, 400, { error: "Give a full folder path, for example C:\\Users\\you\\OneDrive\\SoftwareFactory Drop" });
        mkdirSync(dir, { recursive: true });
        drop.dir = dir;
        log.append("settings.changed", { key: "dropDir", value: dir });
        drop.scan();
        return json(res, 200, { dir });
      }
      if (req.method === "POST" && url.pathname === "/api/setup/drop/scan") return json(res, 200, { results: drop.scan(), drops: drop.recent(10) });
      if (req.method === "POST" && url.pathname === "/api/open") {
        const body = await readJson(req);
        const target = String(body.target ?? "");
        let dir: string | null = null;
        if (target === "projects") dir = projectsDir;
        else if (target === "drop") dir = drop.dir;
        else if (target === "data") dir = dataDir ?? dirname(projectsDir);
        else if (target === "run") {
          const row = log.db.prepare("SELECT dir FROM factory_runs WHERE id = ?").get(Number(body.run)) as { dir: string | null } | undefined;
          dir = row?.dir ?? null;
        }
        if (!dir) return json(res, 404, { error: "Nothing to open there yet." });
        mkdirSync(dir, { recursive: true });
        openFolder(dir);
        return json(res, 200, { ok: true, dir });
      }
      if (req.method === "GET" && url.pathname === "/api/since") {
        const from = url.searchParams.get("from");
        return json(res, 200, sinceReport(log, order.state(), from ? Number(from) : undefined));
      }
      if (req.method === "POST" && url.pathname === "/api/presence") {
        // The Bridge says "seen up to here" as you leave it; the next "since you left" starts there.
        const body = await readJson(req);
        const eventId = Number(body.eventId);
        const prev = lastSeen(log);
        if (Number.isFinite(eventId) && eventId > (prev?.eventId ?? 0)) log.append("bridge.seen", { eventId });
        return json(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/api/signals") {
        const q = url.searchParams.get("q");
        return json(res, 200, q ? log.searchSignals(q) : listSignals(log));
      }
      if (req.method === "POST" && url.pathname === "/api/signals") {
        const body = await readJson(req);
        return json(res, 201, captureSignal(log, String(body.text ?? ""), String(body.source ?? "bridge")));
      }
      if (req.method === "POST" && url.pathname === "/api/agent/run") {
        const body = await readJson(req);
        const prompt = String(body.prompt ?? "").trim();
        if (!prompt) return json(res, 400, { error: "prompt is required" });
        // The Overseer is an agent like the others: its prompt, model and cap live in the Agent Bay.
        const o = bay.crewFor("overseer")[0];
        // The Overseer reads a live status digest first, so it answers about this factory, not in general.
        const digest = statusDigest(log, order.state(), runtime.name);
        const run = await runAgent(log, runtime, o.id, {
          prompt: `Status of the factory right now:\n${digest}\n\nThe person says:\n${prompt}`,
          model: body.model ? String(body.model) : o.model,
          systemPrompt: o.role,
          budgetUsd: typeof body.budgetUsd === "number" ? body.budgetUsd : Math.min(budgetUsd, o.budgetUsd),
          pluginDirs: o.pluginDirs.length ? o.pluginDirs : undefined,
        }, { agentVersion: o.version, station: "overseer" });
        return json(res, run.error ? 502 : 200, { ...run, suggestion: run.result ? buildSuggestion(run.result.text).build : undefined });
      }
      if (req.method === "POST" && url.pathname === "/api/factory/runs") {
        const body = await readJson(req);
        if (!gitReady()) return json(res, 409, { error: "Git is not installed, so the factory has nowhere to keep the app it builds. Install Git for Windows (git-scm.com/download/win), then press Build it again." });
        const run = factory.start(String(body.idea ?? ""), {
          maxUsd: typeof body.maxUsd === "number" ? body.maxUsd : undefined,
          autoApprove: body.autoApprove === true,
          models: typeof body.models === "object" && body.models ? body.models as Record<string, string> : undefined,
          council: body.council === "always" || body.council === "never" ? body.council : undefined,
        });
        return json(res, 202, { run });
      }
      const gateMatch = url.pathname.match(/^\/api\/factory\/runs\/(\d+)\/gate$/);
      if (req.method === "POST" && gateMatch) {
        const body = await readJson(req);
        const ok = factory.decide(Number(gateMatch[1]), String(body.gate) as GateId, { approve: body.approve === true, note: body.note ? String(body.note) : undefined, by: "you" });
        return json(res, ok ? 200 : 409, ok ? { ok } : { error: "That run is not waiting at that gate" });
      }
      if (req.method === "GET" && url.pathname === "/api/cost") return json(res, 200, costSummary(log));
      if (url.pathname.startsWith("/api/bay/")) {
        const r = await bayRoute(bay, req, url);
        if (r) return r[0] === -1 ? text(res, 200, String(r[1])) : json(res, r[0], r[1]);
      }
      if (req.method === "GET" && url.pathname === "/api/store") return json(res, 200, storeReport(log, projectsDir));
      if (req.method === "POST" && url.pathname === "/api/store/rebuild") {
        const body = await readJson(req);
        log.rebuild(body.name ? String(body.name) : undefined);
        return json(res, 200, storeReport(log, projectsDir));
      }
      if (url.pathname.startsWith("/api/order/")) {
        const r = await orderRoute(order, req, url.pathname);
        if (r) return json(res, r[0], r[1]);
      }
      if (req.method === "GET" && url.pathname === "/api/events") {
        const since = Number(url.searchParams.get("since") ?? 0);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        for (const e of log.list({ sinceId: since, limit: 1e6 })) send(res, e);
        const onEvent = (e: SfEvent) => send(res, e);
        log.on("event", onEvent);
        req.on("close", () => log.off("event", onEvent));
        return;
      }
      return json(res, 404, { error: "not found" });
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }
  };
  return Object.assign(handler, { factory, order, bay, drop });
}

/** Settings you changed in the Bridge, newest value per key, from the `settings` table. */
export function readSettings(log: EventLog): { crewMode?: CrewMode; dropDir?: string } {
  const rows = log.db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
}

/** Show a folder in the system file manager (Explorer on Windows). */
export function openFolder(dir: string) {
  const [cmd, args] = process.platform === "win32" ? ["explorer.exe", [dir]] : process.platform === "darwin" ? ["open", [dir]] : ["xdg-open", [dir]];
  try {
    const child = spawn(cmd, args as string[], { detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", () => {});
    child.unref();
  } catch { /* no file manager here (a server, CI); the Bridge shows the path anyway */ }
}

/** The Agent Bay's API. Every write is an event, so the Bridge sees it on the stream. Status -1 = a plain-text file. */
async function bayRoute(bay: AgentBay, req: IncomingMessage, url: URL): Promise<[number, unknown] | null> {
  const path = url.pathname;
  if (req.method === "GET" && path === "/api/bay/state") return [200, bay.state()];
  let m = path.match(/^\/api\/bay\/agents\/([a-z0-9-]+)\/file$/);
  if (req.method === "GET" && m) { const v = url.searchParams.get("version"); return [-1, bay.file(m[1], v ? Number(v) : undefined)]; }
  m = path.match(/^\/api\/bay\/agents\/([a-z0-9-]+)\/versions\/(\d+)$/);
  if (req.method === "GET" && m) { const v = bay.version(m[1], Number(m[2])); return v ? [200, v] : [404, { error: "no such version" }]; }
  if (req.method !== "POST") return null;
  const body = await readJson(req);
  if (path === "/api/bay/agents") return [201, bay.create(body as any)];
  if (path === "/api/bay/import") return [201, bay.importFile(String(body.text ?? ""))];
  if (path === "/api/bay/draft") return [201, await bay.draft(String(body.description ?? ""))];
  m = path.match(/^\/api\/bay\/agents\/([a-z0-9-]+)\/(save|clone|rollback|retire|test)$/);
  if (m) {
    const [, id, verb] = m;
    if (verb === "save") return [200, bay.save(id, (body.def ?? {}) as any, { note: body.note ? String(body.note) : undefined, expectVersion: typeof body.expectVersion === "number" ? body.expectVersion : undefined })];
    if (verb === "clone") return [201, bay.clone(id, body.name ? String(body.name) : undefined)];
    if (verb === "rollback") return [200, bay.rollback(id, Number(body.version))];
    if (verb === "retire") { bay.retire(id, body.retired !== false); return [200, { ok: true }]; }
    if (verb === "test") return [200, await bay.test(id, body.task ? String(body.task) : undefined)];
  }
  m = path.match(/^\/api\/bay\/slots\/([a-z]+)$/);
  if (m && SLOTS.includes(m[1] as Slot)) return [200, bay.assign(m[1] as Slot, (Array.isArray(body.agents) ? body.agents : []).map(String))];
  return null;
}

/** The Order Engine's API. Every write is an event, so the Bridge sees it on the stream. */
async function orderRoute(order: OrderEngine, req: IncomingMessage, path: string): Promise<[number, unknown] | null> {
  const id = (re: RegExp) => { const m = path.match(re); return m ? Number(m[1]) : null; };
  if (req.method === "GET" && path === "/api/order/state") {
    const st = order.state();
    const canon = Object.fromEntries(st.nodes.map((n) => [n.id, canonFor(st, n.id).map((c) => ({ id: c.fragment.id, inheritedFrom: c.inheritedFrom, rank: c.rank }))]));
    return [200, { ...st, canon, spentUsd: order.spentUsd(), mode: order.opts.mode, maxUsd: order.opts.maxUsd }];
  }
  if (req.method !== "POST") return null;
  const body = await readJson(req);
  if (path === "/api/order/nodes") return [201, { id: order.createNode(String(body.kind ?? "project") as NodeKind, String(body.title ?? ""), body.parentId == null ? null : Number(body.parentId)) }];
  if (path === "/api/order/sweep") return [200, order.sweep()];
  if (path === "/api/order/briefing") return [200, order.briefing()];
  let n: number | null;
  if ((n = id(/^\/api\/order\/fragments\/(\d+)\/move$/)) != null) return [200, { conflicts: order.moveFragment(n, body.nodeId == null ? null : Number(body.nodeId)) }];
  if ((n = id(/^\/api\/order\/fragments\/(\d+)\/pin$/)) != null) { order.pin(n, body.pinned !== false); return [200, { ok: true }]; }
  if ((n = id(/^\/api\/order\/conflicts\/(\d+)\/resolve$/)) != null) { order.resolveConflict(n, Number(body.winner)); return [200, { ok: true }]; }
  if ((n = id(/^\/api\/order\/sweeps\/(\d+)\/undo$/)) != null) { order.undoSweep(n); return [200, { ok: true }]; }
  if ((n = id(/^\/api\/order\/sweeps\/(\d+)\/accept$/)) != null) return [200, { id: order.acceptMerge(n) }];
  return null;
}

function send(res: ServerResponse, e: SfEvent) { res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`); }
function end(res: ServerResponse, status: number) { res.writeHead(status); res.end(); }
function text(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "text/markdown; charset=utf-8" });
  res.end(body);
}
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 1_000_000) throw new Error("body too large"); }
  return raw ? JSON.parse(raw) : {};
}

// Started directly (dev, or as the Tauri sidecar): listen on localhost only.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dbPath = process.env.SF_DB ?? resolve(process.cwd(), ".sf-data/factory.db");
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const port = Number(process.env.SF_PORT ?? 4317);
  const log = new EventLog(dbPath);
  // Crew mode: what you last picked in the Bridge, else what the shell found (real when Claude Code is installed).
  const picked = readSettings(log).crewMode;
  const envMode: CrewMode = modeOf(runtimeFromEnv());
  const mode = picked ?? envMode;
  const runtime = new SwitchableRuntime(mode === "real" && process.env.SF_RUNTIME?.startsWith("claude-code") ? runtimeFromEnv() : runtimeFor(mode), mode);
  const dataDir = dbPath === ":memory:" ? process.cwd() : dirname(dbPath);
  const projectsDir = process.env.SF_PROJECTS ?? resolve(dataDir, "projects");
  const orderMode = process.env.SF_ORDER_MODE as "agent" | "heuristic" | undefined;
  const orderMax = process.env.SF_ORDER_MAX_USD ? Number(process.env.SF_ORDER_MAX_USD) : undefined;
  const core = createCore({ log, runtime, projectsDir, dataDir, dropDir: process.env.SF_DROP, order: { mode: orderMode, maxUsd: orderMax } });
  core.drop.start();
  const server = createServer(core);
  // The Order Engine's daily sweep and briefing: at start if the last one is a day old, then once a day.
  const { order } = core;
  const sweepIfDue = () => {
    // Nothing filed yet (a first launch): no briefing, the welcome speaks instead.
    if (!order.state().fragments.length) return;
    const last = order.state().briefings.at(-1);
    if (!last || Date.now() - Date.parse(last.ts) >= 86_400_000) order.sweep();
  };
  sweepIfDue();
  setInterval(sweepIfDue, 3_600_000).unref();
  server.listen(port, "127.0.0.1", () =>console.log(`SoftwareFactory core on http://127.0.0.1:${port} (runtime ${runtime.name}, db ${dbPath})`));
}
