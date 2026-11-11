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
import { projectsRoute } from "./projects/routes.js";
import { chatRoutes, projectHome } from "./chat/routes.js";
import { RepoExplorer } from "./imports/explorer.js";
import { importsRoute } from "./imports/routes.js";
import { Launcher } from "./launch/launcher.js";
import { launchRoute } from "./launch/routes.js";
import { Integrations } from "./integrations/service.js";
import { integrationsRoute, serveExtension } from "./integrations/routes.js";
import { PluginHost } from "./plugins/host.js";
import { pluginsRoute, servePluginFile } from "./plugins/routes.js";
import { DropFolder } from "./bridge/drop.js";
import { Tickets } from "./tickets/tickets.js";
import { ErrorCapture, isFault } from "./tickets/capture.js";
import { classifyIntake, ensureSelfProject, projectToTicket } from "./tickets/intake.js";
import { FORMS, KINDS, KIND_LABEL, PRIORITIES, PRIORITY_LABEL, RELATIONS, TICKET_SEVERITIES, STATUS_WORDS, type TicketKind, type TicketStatus, type Relation } from "./tickets/model.js";
import { buildSuggestion, lastSeen, sinceReport, statusDigest } from "./bridge/status.js";
import { ImproveCouncil, type Target } from "./improve/council.js";
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
  /** Improvement Council caps: daily USD and hours between automatic sessions. */
  improve?: { maxUsd?: number; everyHours?: number };
  /** The installed app's version, from the shell (SF_APP_VERSION). A new one is recorded as `app.updated`. */
  appVersion?: string;
}

/** Build the core HTTP handler: a small JSON API plus a server-sent event stream. */
export function createCore({ log, runtime, budgetUsd = 0.25, projectsDir = resolve(process.cwd(), ".sf-data/projects"), order: orderOpts, dropDir, dataDir, improve: improveOpts, appVersion }: CoreOptions) {
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
  recordAppVersion(log, appVersion);
  const order = new OrderEngine(log, runtime, { crew: bay, ...orderOpts });
  const tickets = new Tickets(log, { runtime, factory, bay, budgetUsd: Math.min(budgetUsd, 0.1), workRoot: join(dirname(projectsDir), "ticket-work") });
  // Every fault becomes a bug ticket by itself (docs/tickets.md, "Errors become bugs").
  // SoftwareFactory's own project: the home of asks about the app and of the errors it catches. Made when first needed.
  const ensureSelf = () => ensureSelfProject(log, (name) => order.createNode("project", name));
  const errors = new ErrorCapture(log, tickets, { project: ensureSelf });
  const fault = (where: string, e: unknown, context?: Record<string, unknown>) => {
    const err = e instanceof Error ? e : new Error(String(e));
    return errors.capture({ message: `${err.name !== "Error" ? `${err.name}: ` : ""}${err.message}`, stack: err.stack, where, from: "core", context });
  };
  // Imported repos are cloned next to the factory's own projects, in imports/.
  const explorer = new RepoExplorer(log, runtime, join(dirname(projectsDir), "imports"), bay, { createNode: (title) => order.createNode("project", title) });
  // Finished projects added into SoftwareFactory: their frozen copies live in extensions/, next to projects/.
  // Plugins: folders with a plugin.json, copied into plugins/ next to projects/, each backend in its own locked-down process.
  const plugins = new PluginHost(log, join(dirname(projectsDir), "plugins"), { bay });
  const integrations = new Integrations(log, join(dirname(projectsDir), "extensions"), plugins);
  // The Improvement Council: your caps from the Bridge win over the start options. On its own it runs on the real crew only.
  const improve = new ImproveCouncil(log, runtime, bay, () => order.state(), {
    maxUsd: settings.improveMaxUsd ?? improveOpts?.maxUsd, everyHours: settings.improveEveryHours ?? improveOpts?.everyHours,
    autoGate: () => ((runtime instanceof SwitchableRuntime ? runtime.mode : modeOf(runtime)) === "real" ? null : "the practice crew only answers when you press Look now; switch to the real crew in Systems for automatic sessions"),
  }).listen();
  improve.auto = settings.improveAuto ?? true;
  // Finished projects run from their own folders; the Bridge shows their output and pages.
  const launcher = new Launcher(log);
  // Every Signal, from the Overseer channel or a factory intake, is filed by the Order Engine.
  log.on("event", (e: SfEvent) => {
    if (e.type !== "signal.captured") return;
    const p = e.payload as { text: string; source: string; projectId?: number };
    // Said in a project's chat: the Order Engine files it under that project unless the words point elsewhere.
    const home = p.projectId != null ? projectHome(log, order.state(), Number(p.projectId)) : null;
    order.ingest({ id: e.id, text: p.text, source: p.source, home }).catch((err) => { console.error("order ingest failed:", err); fault("order engine, filing a Signal", err, { signal: e.id }); });
  });
  // Who is talking to the core: the desktop window sends its page origin (http://tauri.localhost
  // on Windows). Kept in memory only; /api/health shows it, so a smoke test can prove the window
  // reached the core, and the shell can tell a blank window from a dead core.
  const clients = { origins: new Map<string, string>(), streams: new Map<string, number>() };
  /** A chat's project id from a request: null for General, false when that project is gone. */
  const chatProject = (v: unknown): number | null | false => {
    if (v == null || v === "" || v === "general") return null;
    const id = Number(v);
    if (!Number.isInteger(id)) return null;
    return log.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id) ? id : false;
  };
  /** What the Overseer reads first when asked in a project's chat: that project, not the whole factory. */
  const projectBrief = (id: number): string => {
    const p = log.db.prepare("SELECT name, kind, status, summary FROM projects WHERE id = ?").get(id) as { name: string; kind: string; status: string; summary: string } | undefined;
    if (!p) return "";
    const runs = log.db.prepare(`SELECT r.id, r.idea, r.outcome, r.reason FROM factory_runs r JOIN project_links l ON l.kind = 'factory_run' AND l.ref = CAST(r.id AS TEXT)
      WHERE l.project_id = ? ORDER BY r.id DESC LIMIT 5`).all(id) as { id: number; idea: string; outcome: string | null; reason: string | null }[];
    const lines = runs.map((r) => `- run #${r.id}: ${r.idea.slice(0, 120)} (${r.outcome ?? "running"}${r.reason ? `: ${r.reason.slice(0, 120)}` : ""})`);
    return `You are in the chat of the project "${p.name}" (${p.kind}, ${p.status})${p.summary ? `: ${p.summary.slice(0, 400)}` : ""}. Answer about this project unless asked otherwise.\n${lines.length ? `Its latest factory runs:\n${lines.join("\n")}\n` : ""}\n`;
  };
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin.slice(0, 100) : null;
    if (origin) clients.origins.set(origin, new Date().toISOString());
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    if (req.method === "OPTIONS") return end(res, 204);
    const url = new URL(req.url ?? "/", "http://localhost");
    // Plugin pages run in sandboxed frames (origin "null"): they reach the core only through the
    // Bridge, which checks their permissions, never by calling the API themselves.
    if (origin === "null" && url.pathname.startsWith("/api/")) return json(res, 403, { error: "Plugin pages talk to SoftwareFactory through sf.js, not the API" });
    try {
      if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, {
        ok: true, runtime: runtime.name, mode: runtime instanceof SwitchableRuntime ? runtime.mode : modeOf(runtime),
        pid: process.pid, node: process.version, schema: log.migration.to,
        appVersion: appVersion ?? null, activeRuns: factory.activeCount(),
        clients: { origins: Object.fromEntries(clients.origins), streams: Object.fromEntries(clients.streams) },
      });
      if (req.method === "GET" && url.pathname === "/api/updates") return json(res, 200, updatesReport(log, appVersion, factory.activeCount()));
      if (req.method === "POST" && url.pathname === "/api/updates") {
        const body = await readJson(req);
        if (typeof body.auto !== "boolean") return json(res, 400, { error: "Send { auto: true } or { auto: false }." });
        log.append("settings.changed", { key: "autoUpdate", value: body.auto });
        return json(res, 200, updatesReport(log, appVersion, factory.activeCount()));
      }
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
        const projectId = chatProject(body.projectId);
        if (projectId === false) return json(res, 404, { error: "That project no longer exists, so its chat is closed. Pick another chat." });
        return json(res, 201, captureSignal(log, String(body.text ?? ""), String(body.source ?? "bridge"), projectId ?? undefined));
      }
      if (req.method === "GET" && url.pathname === "/api/chat/routes") {
        return json(res, 200, chatRoutes(log, order.state()));
      }
      if (req.method === "POST" && url.pathname === "/api/agent/run") {
        const body = await readJson(req);
        const prompt = String(body.prompt ?? "").trim();
        if (!prompt) return json(res, 400, { error: "prompt is required" });
        // The Overseer is an agent like the others: its prompt, model and cap live in the Agent Bay.
        const o = bay.crewFor("overseer")[0];
        const projectId = chatProject(body.projectId);
        if (projectId === false) return json(res, 404, { error: "That project no longer exists, so its chat is closed. Pick another chat." });
        // The Overseer reads a live status digest first, so it answers about this factory, not in general.
        const digest = statusDigest(log, order.state(), runtime.name);
        const room = projectId != null ? projectBrief(projectId) : "";
        const run = await runAgent(log, runtime, o.id, {
          prompt: `Status of the factory right now:\n${digest}\n\n${room}The person says:\n${prompt}`,
          model: body.model ? String(body.model) : o.model,
          systemPrompt: o.role,
          budgetUsd: typeof body.budgetUsd === "number" ? body.budgetUsd : Math.min(budgetUsd, o.budgetUsd),
          pluginDirs: o.pluginDirs.length ? o.pluginDirs : undefined,
        }, { agentVersion: o.version, station: "overseer", ...(projectId != null ? { projectId } : {}) });
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
          projectId: typeof body.projectId === "number" ? body.projectId : undefined,
        });
        return json(res, 202, { run });
      }
      const runMatch = url.pathname.match(/^\/api\/factory\/runs\/(\d+)$/);
      if (req.method === "GET" && runMatch) {
        const id = Number(runMatch[1]);
        const row = log.db.prepare("SELECT * FROM factory_runs WHERE id = ?").get(id);
        if (!row) return json(res, 404, { error: "No such run" });
        const station = log.db.prepare("SELECT payload FROM events WHERE type = 'factory.station' AND json_extract(payload, '$.run') = ? ORDER BY id DESC LIMIT 1").get(id) as { payload: string } | undefined;
        return json(res, 200, { ...row, station: station ? JSON.parse(station.payload) : null, waiting: factory.waitingGate(id), resumable: factory.resumable(id) });
      }
      const resumeMatch = url.pathname.match(/^\/api\/factory\/runs\/(\d+)\/resume$/);
      if (req.method === "POST" && resumeMatch) {
        const id = Number(resumeMatch[1]);
        const ok = factory.resumable(id);
        if (!ok.ok) return json(res, 409, { error: `Run #${id} cannot resume: ${ok.why}` });
        if (!gitReady()) return json(res, 409, { error: "Git is not installed, so the run cannot pick up its repo. Install Git for Windows (git-scm.com/download/win), then press Resume again." });
        factory.resume(id);
        return json(res, 202, { run: id, from: ok.from });
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
      if (url.pathname === "/api/projects" || url.pathname.startsWith("/api/projects/")) {
        const canBuild = () => gitReady() ? null : "Git is not installed, so the factory has nowhere to keep the app it builds. Install Git for Windows (git-scm.com/download/win), then press Build it again.";
        const r = await projectsRoute({ log, order, factory, readJson, canBuild }, req, url);
        if (r) return json(res, r[0], r[1]);
      }
      if (req.method === "POST" && url.pathname === "/api/tickets/capture") {
        // An error the Bridge caught: filed like the core's own.
        const b = await readJson(req);
        const r = errors.capture({ message: String(b.message ?? ""), stack: b.stack ? String(b.stack) : undefined, where: String(b.where ?? "the Bridge"), from: b.from === "shell" ? "shell" : "bridge", context: (b.context && typeof b.context === "object" ? b.context : undefined) as Record<string, unknown> | undefined, project: typeof b.project === "number" ? b.project : null });
        return json(res, 200, r ?? { ticket: null });
      }
      if (req.method === "POST" && url.pathname === "/api/tickets/intake") {
        // Before an idea becomes a project: is it an ask about one you have?
        const b = await readJson(req);
        const v = classifyIntake(log, String(b.text ?? ""), typeof b.exclude === "number" ? b.exclude : undefined);
        if (v.verdict === "ask" && v.projectId == null) v.projectId = ensureSelf();
        return json(res, 200, v);
      }
      if (req.method === "GET" && url.pathname === "/api/tickets/self") return json(res, 200, { projectId: ensureSelf() });
      const turn = url.pathname.match(/^\/api\/tickets\/from-project\/(\d+)$/);
      if (req.method === "POST" && turn) {
        const b = await readJson(req);
        const to = typeof b.to === "number" ? b.to : ensureSelf();
        return json(res, 201, projectToTicket(log, tickets, order.state(), Number(turn[1]), { to, kind: b.kind ? String(b.kind) as TicketKind : undefined }));
      }
      if (url.pathname === "/api/tickets" || url.pathname.startsWith("/api/tickets/")) {
        const r = await ticketRoute(tickets, req, url, gitReady);
        if (r) return r[0] === -1 ? text(res, 200, String(r[1])) : json(res, r[0], r[1]);
      }
      if (url.pathname === "/api/imports" || url.pathname.startsWith("/api/imports/")) {
        const canImport = () => gitReady() ? null : "Git is not installed, so a repo cannot be imported. Install Git for Windows (git-scm.com/download/win), then import again.";
        const r = await importsRoute({ log, explorer, readJson, canImport }, req, url);
        if (r) return json(res, r[0], r[1]);
      }
      if (url.pathname.startsWith("/api/launch/") || url.pathname.startsWith("/preview/")) {
        const r = await launchRoute({ log, launcher, readJson, openUrl: openFolder }, req, res, url);
        if (r === "handled") return;
        if (r) return json(res, r[0], r[1]);
      }
      if (url.pathname === "/api/integrations" || url.pathname.startsWith("/api/integrations/")) {
        const r = await integrationsRoute({ log, integrations, readJson }, req, url);
        if (r) return json(res, r[0], r[1]);
      }
      if (url.pathname.startsWith("/ext/") && serveExtension(integrations, req, res, url)) return;
      if (url.pathname === "/api/plugins" || url.pathname.startsWith("/api/plugins/")) {
        const r = await pluginsRoute({ plugins, readJson }, req, url);
        if (r) return json(res, r[0], r[1]);
      }
      if (url.pathname.startsWith("/plugins/") && servePluginFile(plugins, req, res, url)) return;
      if (url.pathname.startsWith("/api/improve/")) {
        const r = await improveRoute(improve, req, url.pathname, log, (idea) => {
          if (!gitReady()) throw new Error("Git is not installed, so the factory has nowhere to keep the app it builds. Install Git for Windows (git-scm.com/download/win), then press Build again.");
          return factory.start(idea, {});
        });
        if (r) return json(res, r[0], r[1]);
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
        const who = origin ?? "none";
        clients.streams.set(who, (clients.streams.get(who) ?? 0) + 1);
        req.on("close", () => {
          log.off("event", onEvent);
          const n = (clients.streams.get(who) ?? 1) - 1;
          if (n > 0) clients.streams.set(who, n); else clients.streams.delete(who);
        });
        return;
      }
      return json(res, 404, { error: "not found" });
    } catch (e) {
      // A sentence for the person ("A ticket needs a title") is a 400; a fault in the code is a 500 and a bug ticket.
      if (!isFault(e)) return json(res, 400, { error: (e as Error).message });
      const r = fault(`${req.method} ${url.pathname}`, e, { query: Object.fromEntries(url.searchParams) });
      return json(res, 500, { error: (e as Error).message, ticket: r?.ticket ?? null });
    }
  };
  return Object.assign(handler, { factory, order, bay, drop, tickets, improve, explorer, launcher, integrations, plugins, errors, fault, ensureSelf });
}

/**
 * Note the installed version once per change, so the timeline shows each update
 * (from, to) and the Bridge can say "Updated to 0.2.41". The first version seen
 * is recorded with from = null.
 */
export function recordAppVersion(log: EventLog, version: string | undefined) {
  if (!version) return;
  const last = log.db.prepare("SELECT to_version FROM app_versions ORDER BY id DESC LIMIT 1").get() as { to_version: string } | undefined;
  if (last?.to_version === version) return;
  log.append("app.updated", { from: last?.to_version ?? null, to: version });
}

export interface UpdatesReport {
  /** Install updates on its own when the factory is idle (default on). */
  auto: boolean;
  appVersion: string | null;
  activeRuns: number;
  /** Versions this install has run, newest first. */
  history: { ts: string; from: string | null; to: string }[];
}

export function updatesReport(log: EventLog, appVersion: string | undefined, activeRuns: number): UpdatesReport {
  const history = (log.db.prepare("SELECT ts, from_version, to_version FROM app_versions ORDER BY id DESC LIMIT 10").all() as { ts: string; from_version: string | null; to_version: string }[])
    .map((r) => ({ ts: r.ts, from: r.from_version, to: r.to_version }));
  return { auto: readSettings(log).autoUpdate !== false, appVersion: appVersion ?? null, activeRuns, history };
}

/** Settings you changed in the Bridge, newest value per key, from the `settings` table. */
export function readSettings(log: EventLog): { crewMode?: CrewMode; dropDir?: string; improveAuto?: boolean; improveMaxUsd?: number; improveEveryHours?: number; autoUpdate?: boolean } {
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

/** The tickets' API. Every write is an event, so the Bridge sees it on the stream. Status -1 = the work document as Markdown. */
async function ticketRoute(tickets: Tickets, req: IncomingMessage, url: URL, gitReady: () => boolean): Promise<[number, unknown] | null> {
  const path = url.pathname;
  const q = url.searchParams;
  const proj = q.get("project");
  if (req.method === "GET" && path === "/api/tickets/meta") {
    return [200, { kinds: KINDS.map((k) => ({ code: k, label: KIND_LABEL[k], questions: FORMS[k] })), statuses: STATUS_WORDS, priorities: PRIORITIES.map((p) => ({ code: p, label: PRIORITY_LABEL[p] })), severities: TICKET_SEVERITIES, relations: RELATIONS }];
  }
  if (req.method === "GET" && path === "/api/tickets") {
    const project = proj == null || proj === "" ? null : Number(proj);
    const view = (q.get("view") ?? "open") as "open";
    return [200, {
      tickets: tickets.list({ project, view, kind: (q.get("kind") ?? undefined) as TicketKind | undefined, status: (q.get("status") ?? undefined) as TicketStatus | undefined, q: q.get("q") ?? undefined }),
      counts: tickets.counts(project),
    }];
  }
  let m = path.match(/^\/api\/tickets\/(\d+)(?:\/([a-z]+))?$/);
  if (req.method === "GET" && m) {
    const id = Number(m[1]);
    if (m[2] === "document") return [-1, tickets.document(id)];
    if (m[2]) return null;
    const d = tickets.detail(id);
    return d ? [200, d] : [404, { error: `No ticket #${id}` }];
  }
  if (req.method !== "POST") return null;
  const body = await readJson(req);
  if (path === "/api/tickets") return [201, tickets.open({ ...(body as object), by: "you", source: typeof body.source === "string" ? body.source : "you" } as any)];
  m = path.match(/^\/api\/tickets\/(\d+)\/([a-z]+)$/);
  if (!m) return null;
  const id = Number(m[1]);
  switch (m[2]) {
    case "edit": return [200, tickets.edit(id, String(body.field), body.value, "you", body.key ? String(body.key) : undefined)];
    case "say": return [200, tickets.say(id, String(body.text ?? ""), { status: body.status ? String(body.status) as TicketStatus : undefined })];
    case "link": return [200, tickets.link(id, Number(body.to), String(body.relation ?? "related") as Relation, "you", body.removed === true)];
    case "line": return [200, tickets.moveLine(id, body.dir === "up" ? "up" : "down")];
    case "spawn": return [201, tickets.spawn(id, { ...(body as object), by: "you" } as any)];
    case "work":
      if (!gitReady()) return [409, { error: "Git is not installed, so the crew has nowhere to keep what it builds. Install Git for Windows (git-scm.com/download/win), then press Work it again." }];
      return [202, tickets.work(id, { maxUsd: typeof body.maxUsd === "number" ? body.maxUsd : undefined, autoApprove: body.autoApprove === true, where: body.where === "repo" || body.where === "new" ? body.where : "auto" })];
    case "ask": return [200, await tickets.ask(id, body.agent ? String(body.agent) : undefined)];
  }
  return null;
}

/** The Improvement Council's API. Every write is an event, so the Bridge sees it on the stream. */
async function improveRoute(improve: ImproveCouncil, req: IncomingMessage, path: string, log: EventLog, build: (idea: string) => number): Promise<[number, unknown] | null> {
  if (req.method === "GET" && path === "/api/improve/state") return [200, improve.state()];
  if (req.method !== "POST") return null;
  const body = await readJson(req);
  if (path === "/api/improve/run") {
    const t = body.target as Partial<Target> | undefined;
    const target = t && t.kind ? { kind: t.kind, id: t.id == null ? null : Number(t.id), title: String(t.title ?? "") } as Target : undefined;
    try {
      const p = improve.run({ target, trigger: "manual" });
      p.catch((e) => console.error("improve session failed:", e));
    } catch (e) { return [409, { error: (e as Error).message }]; }
    // The session's start event is written before the first agent call, so it is already in the state.
    return [202, { session: improve.sessions().at(-1) }];
  }
  if (path === "/api/improve/settings") {
    const out: Record<string, unknown> = {};
    if (typeof body.auto === "boolean") { improve.auto = body.auto; log.append("settings.changed", { key: "improveAuto", value: body.auto }); out.auto = body.auto; }
    if (typeof body.maxUsd === "number") {
      if (!(body.maxUsd >= 0 && body.maxUsd <= 5)) return [400, { error: "The daily cap must be between $0 and $5." }];
      improve.opts.maxUsd = body.maxUsd; log.append("settings.changed", { key: "improveMaxUsd", value: body.maxUsd });
    }
    if (typeof body.everyHours === "number") {
      if (!(body.everyHours >= 1 && body.everyHours <= 168)) return [400, { error: "Look every 1 to 168 hours." }];
      improve.opts.everyHours = body.everyHours; log.append("settings.changed", { key: "improveEveryHours", value: body.everyHours });
    }
    return [200, improve.state()];
  }
  const m = path.match(/^\/api\/improve\/proposals\/(\d+)\/(decide|build)$/);
  if (m) {
    const id = Number(m[1]);
    if (m[2] === "decide") {
      const d = String(body.decision);
      if (!["accepted", "rejected", "parked", "inbox"].includes(d)) return [400, { error: "decision is accepted, rejected, parked or inbox" }];
      return [200, improve.decide(id, d as "accepted", body.note ? String(body.note) : undefined)];
    }
    const p = improve.proposals().find((x) => x.id === id);
    if (!p) return [404, { error: `No proposal #${id}` }];
    if (p.status !== "accepted") improve.decide(id, "accepted");
    try { return [202, { run: build(improve.buildIdea(id)) }]; } catch (e) { return [409, { error: (e as Error).message }]; }
  }
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
  const improveMax = process.env.SF_IMPROVE_MAX_USD ? Number(process.env.SF_IMPROVE_MAX_USD) : undefined;
  const improveEvery = process.env.SF_IMPROVE_EVERY_H ? Number(process.env.SF_IMPROVE_EVERY_H) : undefined;
  const core = createCore({ log, runtime, projectsDir, dataDir, dropDir: process.env.SF_DROP, order: { mode: orderMode, maxUsd: orderMax }, improve: { maxUsd: improveMax, everyHours: improveEvery }, appVersion: process.env.SF_APP_VERSION });
  core.drop.start();
  core.ensureSelf(); // SoftwareFactory has a project of its own from the first start
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
  // The Improvement Council looks again on its own (real crew only, within its caps): first a few minutes after start, then every 15 minutes it checks if a look is due.
  const improveTick = () => { core.improve.tick().catch((e) => { console.error("improve tick failed:", e); core.fault("improvement council tick", e); }); };
  // Nothing thrown is lost: it is a bug ticket before anything else happens.
  process.on("unhandledRejection", (e) => { console.error("unhandled rejection:", e); core.fault("the core (unhandled promise rejection)", e); });
  process.on("uncaughtException", (e) => {
    console.error("uncaught exception:", e);
    core.fault("the core (uncaught exception, the core stopped)", e);
    try { log.close(); } catch { /* already closed */ }
    process.exit(1);
  });
  setTimeout(improveTick, 3 * 60_000).unref();
  setInterval(improveTick, 15 * 60_000).unref();
  // Runs the app closed on pick up again from their last completed station (SF_AUTO_RESUME=0 leaves them for the Resume button).
  // Plugins you turned on start with the core and stop with it.
  for (const id of core.plugins.startAll()) console.log(`Plugin ${id} started`);
  process.on("exit", () => core.plugins.stopAll());
  if (process.env.SF_AUTO_RESUME !== "0" && core.factory.interrupted.length) {
    if (!checkGit().found) console.log("Not resuming interrupted runs: Git is not installed.");
    else for (const id of core.factory.resumeInterrupted()) console.log(`Resumed run #${id} where it left off`);
  }
  // Started by the desktop shell: leave with it. Polling is cheap and works on every OS,
  // including when the shell is killed outright and cannot stop its child.
  const parent = Number(process.env.SF_PARENT_PID);
  if (parent > 0) {
    setInterval(() => {
      try { process.kill(parent, 0); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EPERM") return; // alive, just not ours to signal
        console.log(`The app (pid ${parent}) is gone; the core stops too.`);
        try { log.close(); } catch { /* already closed */ }
        process.exit(0);
      }
    }, 1000).unref();
  }
  // Keep idle connections longer than any client's keep-alive pool (the Bridge, the smoke test),
  // so a client never sends on a socket the core is closing at that same moment.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  // A connection that breaks before a request is understood is otherwise dropped without a word.
  server.on("clientError", (err: NodeJS.ErrnoException, socket) => {
    if (err.code !== "ECONNRESET") console.error(`${new Date().toISOString()} connection error: ${err.code ?? ""} ${err.message}`);
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); else socket.destroy();
  });
  // A core that stops answering for a while (synchronous work hogging the event loop) says so in core.log,
  // with the time, so a frozen-looking window can be matched to what the core was doing.
  let tick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const stalled = now - tick - 500;
    if (stalled >= 2_000) console.error(`${new Date(now).toISOString()} the core was busy for ${(stalled / 1000).toFixed(1)} s and could not answer`);
    tick = now;
  }, 500).unref();
  server.listen(port, "127.0.0.1", () => console.log(`${new Date().toISOString()} SoftwareFactory core on http://127.0.0.1:${port} (runtime ${runtime.name}, db ${dbPath})`));
}
