import { engineCycles } from "./factory/cycles.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { kitArgs } from "./factory/crew.js";
import { configureKits } from "./bay/kits.js";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EventLog, type SfEvent } from "./events.js";
import { captureSignal, listSignals } from "./signals.js";
import { costSummary, runAgent } from "./agents.js";
import { readAdvisorRule, setAdvisorRule } from "./advisor.js";
import { runtimeFromEnv, type AgentRuntime } from "./runtime.js";
import { duplicateReply, Factory, type GateId } from "./factory/loop.js";
import { enableRepoRuns, githubShipper } from "./factory/reporun.js";
import { OrderEngine, type OrderOptions } from "./order/engine.js";
import { canonFor, type NodeKind } from "./order/model.js";
import { AgentBay } from "./bay/bay.js";
import { SLOTS, type Slot } from "./bay/agentfile.js";
import { storeReport } from "./store/inspect.js";
import "./bridge/tables.js";
import { projectsRoute } from "./projects/routes.js";
import { projectOf } from "./projects/service.js";
import { extraAllowance } from "./projects/budget.js";
import { chatRoutes, projectHome } from "./chat/routes.js";
import { RepoExplorer } from "./imports/explorer.js";
import { importsRoute } from "./imports/routes.js";
import { RepoReviewer } from "./imports/review.js";
import { Launcher, type LaunchFault } from "./launch/launcher.js";
import { launchRoute } from "./launch/routes.js";
import { Integrations } from "./integrations/service.js";
import { integrationsRoute, serveExtension } from "./integrations/routes.js";
import { PluginHost } from "./plugins/host.js";
import { PluginStore } from "./plugins/store.js";
import { PluginAi } from "./plugins/ai.js";
import { coreDoor } from "./plugins/door.js";
import { pluginsRoute, servePluginFile } from "./plugins/routes.js";
import { brainRoute } from "./brain/routes.js";
import { featureMapRoute } from "./featuremap/routes.js";
import { flowsRoute } from "./flows/routes.js";
import { watchRoute } from "./watch/routes.js";
import { monthLeft } from "./watch/spend.js";
import { Watchers } from "./watch/watchers.js";
import { FlowImprover } from "./flows/improver.js";
import { GitManager } from "./git/manager.js";
import { gitRoute } from "./git/routes.js";
import { DropFolder } from "./bridge/drop.js";
import { askForApp } from "./factory/appagent.js";
import { AUTO_WORK_DEFAULT, TICKET_FILE_MAX, Tickets, type AutoWork, type TicketFile } from "./tickets/tickets.js";
import { GitHub, ghCliToken, parseGitHubRepo } from "./tickets/github.js";
import { RunnerManager } from "./runners/manager.js";
import { runnersRoute } from "./runners/routes.js";
import { linkToProject } from "./projects/service.js";
import { ErrorCapture, isFault } from "./tickets/capture.js";
import { classifyIntake, ensureSelfProject, filedAlready, projectToTicket } from "./tickets/intake.js";
import { FORMS, KINDS, KIND_LABEL, PRIORITIES, PRIORITY_LABEL, RELATIONS, TICKET_SEVERITIES, STATUS_WORDS, type TicketKind, type TicketStatus, type Relation } from "./tickets/model.js";
import { buildSuggestion, lastSeen, sinceReport, statusDigest } from "./bridge/status.js";
import { ImproveCouncil, type Target } from "./improve/council.js";
import { BaseHost, type BootedBase } from "./bases/host.js";
import { BaseRegistry } from "./bases/registry.js";
import { SwitchableRuntime, checkGit, modeOf, runtimeFor, setupReport, type CrewMode } from "./setup.js";
import { freeBytesAt, lastAgentCall, preflight, type PreflightReport } from "./safety/preflight.js";

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
  /** GitHub write access for the crew's PRs (tests pass one pointed at a fake GitHub). */
  github?: GitHub;
  /** The installed app's version, from the shell (SF_APP_VERSION). A new one is recorded as `app.updated`. */
  appVersion?: string;
  /** Jobs running on this PC's build runners right now (the app's own, not a base's). An update that installs by itself waits for them. */
  runnerJobs?: () => number;
}

/** Build the core HTTP handler: a small JSON API plus a server-sent event stream. */
export function createCore({ log, runtime, budgetUsd = 0.25, projectsDir = resolve(process.cwd(), ".sf-data/projects"), order: orderOpts, dropDir, dataDir, improve: improveOpts, appVersion, github: githubIn, runnerJobs = () => 0 }: CoreOptions) {
  // GitHub write access for the crew's PRs; the token lives in the data folder, never in the log.
  // Each agent's own skills and MCP servers: the person's library and the built kits live in the data folder.
  if (dataDir) configureKits({ dataDir });
  const github = githubIn ?? (dataDir ? new GitHub({ dataDir }) : undefined);
  const crewMode = () => (runtime instanceof SwitchableRuntime ? runtime.mode : modeOf(runtime));
  const bay = new AgentBay(log, runtime);
  const settings = readSettings(log);
  const drop = new DropFolder(log, settings.dropDir ?? dropDir ?? join(homedir(), "SoftwareFactory", "Drop"));
  // Git is needed to ship anything; checking costs a process spawn, so remember it for a minute.
  let gitOk: { ok: boolean; at: number } = { ok: true, at: 0 };
  const gitReady = () => {
    if (Date.now() - gitOk.at > 60_000) gitOk = { ok: checkGit().found, at: Date.now() };
    return gitOk.ok;
  };
  // Preflight (safety/preflight.ts): free checks that this PC can do paid work, remembered for a minute.
  let pre: { auto: PreflightReport; manual: PreflightReport; at: number } | null = null;
  const preflightNow = (fresh = false) => {
    if (fresh || !pre || Date.now() - pre.at > 60_000) {
      const s = setupReport(runtime, fresh);
      const input = { mode: crewMode(), git: s.git, claude: s.claude, freeBytes: freeBytesAt(existsSync(projectsDir) ? projectsDir : homedir()), lastCall: lastAgentCall(log) };
      pre = { auto: preflight(input), manual: preflight({ ...input, manual: true }), at: Date.now() };
    }
    return pre;
  };
  /** What stops paid work started by a press, past Git (which each route words for itself), or null. */
  const pressProblem = () => { const r = preflightNow().manual; return r.items.find((x) => !x.ok && x.id !== "git")?.text ?? null; };
  const factory = new Factory(log, runtime, projectsDir, bay);
  factory.maxRunMinutes = settings.maxRunMinutes;
  // A build's "add more" never goes past its project's budget.
  factory.extraBudget = (run, want) => extraAllowance(log, run, want, (r) => projectOf(log, { kind: "factory_run", ref: r }));
  recordAppVersion(log, appVersion);
  const order = new OrderEngine(log, runtime, { crew: bay, ...orderOpts });
  // The crew picks up ready bugs and tasks on its own, within your caps (docs/tickets.md, "The ready queue").
  liftAutoWorkLimits(log);
  const autoWork = (): AutoWork => {
    const st = readSettings(log);
    return {
      on: st.ticketsAutoWork ?? AUTO_WORK_DEFAULT.on,
      maxUsd: st.ticketsAutoMaxUsd ?? AUTO_WORK_DEFAULT.maxUsd,
      askedMaxUsd: st.ticketsAskedMaxUsd ?? AUTO_WORK_DEFAULT.askedMaxUsd,
      dailyUsd: st.ticketsAutoDailyUsd ?? AUTO_WORK_DEFAULT.dailyUsd,
      wip: st.ticketsWip ?? AUTO_WORK_DEFAULT.wip,
    };
  };
  const canShip = () => (crewMode() === "real" ? null : "the practice crew never opens a PR; switch to the real crew in Systems for that");
  // The engine also runs in codebases it did not write: imported repos get the same stations, on a branch of a clone.
  const repoRuns = enableRepoRuns(factory, log, { github, ship: githubShipper(github, canShip) });
  const tickets = new Tickets(log, {
    runtime, factory, bay, budgetUsd: Math.min(budgetUsd, 0.1), workRoot: join(dirname(projectsDir), "ticket-work"),
    autoWork, canWork: () => (gitReady() ? preflightNow().auto.problem : "Git is not installed"),
    github, canShip, repoRuns,
    // Monthly budgets hold paid starts on the real crew only: the practice crew costs nothing (watch/spend.ts).
    monthLeft: (p) => (crewMode() === "real" ? monthLeft(log, p) : { leftUsd: null, why: null }),
  });
  // Watchers (watch/watchers.ts): scheduled, free looks at each project that only open tickets.
  const watchers = new Watchers(log, tickets);
  // A flow step may name a Bay agent; saving one that names an agent the Bay does not have is refused.
  factory.flows.agentsKnown = () => new Set(bay.agents().filter((a) => !a.retired).map((a) => a.def.id));
  // Flows that improve themselves (flows/improve.ts): proposals replayed on past runs, one live trial, your decision.
  const flowImprover = new FlowImprover(log, factory.flows, {
    runtime,
    agents: () => bay.agents().filter((a) => !a.retired).map((a) => ({ id: a.def.id, name: a.def.name, station: a.def.station })),
    record: (id) => { const s = bay.stats()[id]; return s ? { passRate: s.passRate, avgUsd: s.avgUsd, calls: s.calls } : null; },
  });
  factory.flows.trial = (id, ticket) => flowImprover.takeTrial(id, ticket);
  // The git manager: local first then a private repo, the merge policy, outside work, versions (docs/git.md).
  const gitman = new GitManager(log, tickets, { github, canShip });
  /** An ask in a project that lives in a repo: a ticket there, sent down the route that fits (the reply both doors share). */
  const repoAsk = (projectId: number, idea: string, o: { maxUsd?: number; route?: "light" | "engine"; autoApprove?: boolean }) => {
    const r = tickets.askInRepo(projectId, idea, o);
    return r && { ticket: { id: r.ticket.id, key: r.ticket.key, title: r.ticket.title }, run: r.run, branch: r.branch ?? null, route: r.route ?? null };
  };
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
  // Add-ons may keep a searchable catalog (store) and ask Claude from their own monthly budget (ai): docs/plugins.md.
  const pluginStore = new PluginStore(log.db);
  const pluginAi = new PluginAi(log, () => runtime);
  const plugins = new PluginHost(log, join(dirname(projectsDir), "plugins"), {
    bay, door: coreDoor({ log, tickets, bay }), store: pluginStore, ai: pluginAi,
    ...(github ? { tarball: (repo: string, ref: string) => github.tarball(repo, ref) } : {}),
  });
  const integrations = new Integrations(log, join(dirname(projectsDir), "extensions"), plugins);
  // The Improvement Council: your caps from the Bridge win over the start options. On its own it runs on the real crew only.
  const improve = new ImproveCouncil(log, runtime, bay, () => order.state(), {
    maxUsd: settings.improveMaxUsd ?? improveOpts?.maxUsd, everyHours: settings.improveEveryHours ?? improveOpts?.everyHours,
    autoGate: () => ((runtime instanceof SwitchableRuntime ? runtime.mode : modeOf(runtime)) === "real" ? null : "the practice crew only answers when you press Look now; switch to the real crew in Systems for automatic sessions"),
  }).listen();
  improve.auto = settings.improveAuto ?? true;
  explorer.follow.on = settings.importsFollow ?? true;
  // A repo imported for the first time is reviewed by itself: run, read, judged, with next steps to approve (docs/review.md).
  const reviewer = new RepoReviewer(log, runtime, explorer, bay, { maxUsd: settings.importReviewMaxUsd, github, canShip });
  // Under the test runner nothing installs or starts a fixture repo unless a test asks for a review.
  reviewer.auto = settings.importReviewAuto ?? !process.env.VITEST;
  reviewer.homeStack = settings.importHomeStack ?? "";
  // Finished projects run from their own folders; the Bridge shows their output and pages.
  const launcher = new Launcher(log);
  // A project's program that dies, or an app that reports its own error, is a bug in that project (SF-40).
  const appFault = (f: { message: string; stack?: string; where: string; project: number; context?: Record<string, unknown> }) => errors.capture({ ...f, from: "app" });
  launcher.on("fault", (f: LaunchFault) => appFault({ message: f.message, stack: f.stack, where: `Run: ${f.label}`, project: f.projectId, context: { output: f.tail } }));
  // Every Signal, from the Overseer channel or a factory intake, is filed by the Order Engine.
  log.on("event", (e: SfEvent) => {
    if (e.type !== "signal.captured") return;
    const p = e.payload as { text: string; source: string; projectId?: number };
    // Said in a project's chat: the Order Engine files it under that project unless the words point elsewhere.
    const home = p.projectId != null ? projectHome(log, order.state(), Number(p.projectId)) : null;
    order.ingest({ id: e.id, text: p.text, source: p.source, home }).catch((err) => { console.error("order ingest failed:", err); fault("order engine, filing a Signal", err, { signal: e.id }); });
  });
  // Agent calls in flight, whoever started them. A factory run counts itself (activeRuns), but a ticket's crew,
  // a Council session, an import or the Overseer are paid work too, and an update that installs by itself
  // must wait for all of them (GET /api/updates).
  const agentCalls = new Set<number>();
  log.on("event", (e: SfEvent) => {
    if (e.type === "agent.run.started") agentCalls.add(e.id);
    else if (e.type === "agent.run.completed" || e.type === "agent.run.failed") agentCalls.delete(Number((e.payload as { runId?: number }).runId));
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
        appVersion: appVersion ?? null, activeRuns: factory.activeCount(), agentCalls: agentCalls.size,
        clients: { origins: Object.fromEntries(clients.origins), streams: Object.fromEntries(clients.streams) },
      });
      if (req.method === "GET" && url.pathname === "/api/preflight") { const r = preflightNow(url.searchParams.get("fresh") === "1"); return json(res, 200, { ...r.auto, press: r.manual }); }
      if (req.method === "GET" && url.pathname === "/api/factory/cycles") return json(res, 200, { cycles: log.view("engine-cycles", engineCycles) });
      if (req.method === "GET" && url.pathname === "/api/updates") return json(res, 200, updatesReport(log, appVersion, factory.activeCount(), agentCalls.size, runnerJobs()));
      if (req.method === "POST" && url.pathname === "/api/updates") {
        const body = await readJson(req);
        if (typeof body.auto !== "boolean") return json(res, 400, { error: "Send { auto: true } or { auto: false }." });
        log.append("settings.changed", { key: "autoUpdate", value: body.auto });
        return json(res, 200, updatesReport(log, appVersion, factory.activeCount(), agentCalls.size, runnerJobs()));
      }
      if (req.method === "POST" && url.pathname === "/api/updates/install") {
        // The Bridge says so before it installs. An install that starts by itself is refused while anything is
        // working (a build, also one waiting at a gate, or an agent call); the person may still install then.
        // Either way the log says who started it and what was in flight.
        const body = await readJson(req);
        const by = body.by === "person" ? "person" : "auto";
        const runs = factory.activeRuns();
        const payload = { by, version: typeof body.version === "string" ? body.version.slice(0, 40) : null, from: appVersion ?? null, activeRuns: runs.length, agentCalls: agentCalls.size, runnerJobs: runnerJobs(), runs: runs.slice(0, 10) };
        if (by === "auto" && (runs.length || agentCalls.size || payload.runnerJobs)) {
          log.append("app.update.held", payload);
          return json(res, 409, { ok: false, activeRuns: runs.length, agentCalls: agentCalls.size, runnerJobs: payload.runnerJobs, error: "Work is in flight, so the update waits." });
        }
        log.append("app.update.started", payload);
        return json(res, 200, { ok: true, activeRuns: runs.length, agentCalls: agentCalls.size });
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
          ...kitArgs(o),
        }, { agentVersion: o.version, station: "overseer", ...(projectId != null ? { projectId } : {}) });
        return json(res, run.error ? 502 : 200, { ...run, suggestion: run.result ? buildSuggestion(run.result.text).build : undefined });
      }
      if (req.method === "POST" && url.pathname === "/api/apps/agent") {
        // An app the factory built asks one of your agents (the Researcher by default) for work plain code cannot do.
        // Only app servers on this machine (no browser origin) or SoftwareFactory's own pages may spend on it.
        if (origin && !/^https?:\/\/(tauri\.localhost|localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return json(res, 403, { error: "App agents answer apps on this computer only" });
        const r = await askForApp(log, runtime, bay, await readJson(req));
        return json(res, r.status, r.body);
      }
      if (req.method === "POST" && url.pathname === "/api/apps/error") {
        // An app the factory built reports an error of its own (kit server.js): a bug in its project, never spent on.
        if (origin && !/^https?:\/\/(tauri\.localhost|localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return json(res, 403, { error: "Apps on this computer only" });
        const b = await readJson(req);
        const project = Number(b.project);
        if (!Number.isInteger(project) || !log.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(project)) return json(res, 400, { error: "Which project? (SF_PROJECT_ID)" });
        const r = appFault({ message: String(b.message ?? "").slice(0, 2000), stack: b.stack ? String(b.stack).slice(0, 8000) : undefined, where: `${String(b.app ?? "the app").slice(0, 60)}: ${String(b.where ?? "server").slice(0, 100)}`, project });
        return json(res, 200, { ticket: r?.ticket ?? null, again: r?.again ?? false });
      }
      if (req.method === "POST" && url.pathname === "/api/factory/runs") {
        const body = await readJson(req);
        if (!gitReady()) return json(res, 409, { error: "Git is not installed, so the factory has nowhere to keep the app it builds. Install Git for Windows (git-scm.com/download/win), then press Build it again." });
        { const why = pressProblem(); if (why) return json(res, 409, { error: why }); }
        // Said inside a project that lives in a repo: it is work in that repo (a ticket, on the route that fits), not a new app.
        if (typeof body.projectId === "number" && !body.newApp && String(body.idea ?? "").trim()) {
          try {
            const r = repoAsk(body.projectId, String(body.idea).trim(), { maxUsd: typeof body.maxUsd === "number" ? body.maxUsd : undefined, route: body.route === "light" || body.route === "engine" ? body.route : undefined, autoApprove: body.autoApprove === true });
            if (r) return json(res, 202, { projectId: body.projectId, inRepo: true, ...r });
          } catch (e) { return json(res, 409, { error: (e as Error).message, inRepo: true }); }
        }
        const dup = duplicateReply(factory, String(body.idea ?? ""), body.again);
        if (dup) return json(res, dup[0], dup[1]);
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
      const retryMatch = url.pathname.match(/^\/api\/factory\/runs\/(\d+)\/retry$/);
      if (req.method === "POST" && retryMatch) {
        // SF-65: a stopped or failed run, from the step it stopped at, with fresh money for what is left.
        const b = await readJson(req);
        try { return json(res, 202, factory.retry(Number(retryMatch[1]), { addUsd: typeof b.addUsd === "number" ? b.addUsd : undefined })); }
        catch (e) { return json(res, 409, { error: (e as Error).message }); }
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
        const r = await projectsRoute({ log, order, factory, readJson, canBuild, repoAsk }, req, url);
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
        if (v.verdict === "ask" && v.projectId != null) { const x = filedAlready(log, v.projectId, String(b.text ?? "")); if (x) v.existing = x; }
        return json(res, 200, v);
      }
      if (req.method === "GET" && url.pathname === "/api/tickets/self") return json(res, 200, { projectId: ensureSelf() });
      const turn = url.pathname.match(/^\/api\/tickets\/from-project\/(\d+)$/);
      if (req.method === "POST" && turn) {
        const b = await readJson(req);
        const to = typeof b.to === "number" ? b.to : ensureSelf();
        return json(res, 201, projectToTicket(log, tickets, order.state(), Number(turn[1]), { to, kind: b.kind ? String(b.kind) as TicketKind : undefined }));
      }
      if (url.pathname === "/api/crew/advisor") {
        // The advisor tool (advisor.ts): GET reads the rule, POST changes model ("off", "sonnet", "opus") and/or minBudgetUsd.
        if (req.method === "POST") {
          try { return json(res, 200, setAdvisorRule(log, await readJson(req))); }
          catch (e) { return json(res, 400, { error: (e as Error).message }); }
        }
        return json(res, 200, readAdvisorRule(log));
      }
      if (url.pathname === "/api/tickets" || url.pathname.startsWith("/api/tickets/")) {
        if (url.pathname === "/api/tickets/github") {
          // GitHub write access for the crew's PRs. The token is written to the data folder and never sent back.
          if (!github) return json(res, 501, { error: "GitHub access needs a data folder." });
          const self = selfGitHub(log);
          if (req.method === "POST") {
            const b = await readJson(req);
            github.setToken(typeof b.token === "string" && b.token.trim() ? b.token : null);
          }
          const check = self && github.hasToken() ? await github.check(self) : null;
          const source = github.tokenSource();
          const login = source && check?.ok ? await github.login() : null;
          return json(res, 200, { hasToken: github.hasToken(), source, login, repo: self ? `${self.owner}/${self.name}` : null, canPush: check?.ok ?? false, why: check?.why ?? null });
        }
        if (url.pathname === "/api/tickets/auto") {
          // The auto-work rule, your standing approval: GET reads it, POST changes any of on, maxUsd, askedMaxUsd, dailyUsd, wip.
          if (req.method === "POST") {
            const b = await readJson(req);
            const set = (key: string, v: unknown, ok: boolean) => { if (ok) log.append("settings.changed", { key, value: v }); };
            set("ticketsAutoWork", b.on, typeof b.on === "boolean");
            set("ticketsAutoMaxUsd", b.maxUsd, typeof b.maxUsd === "number" && b.maxUsd > 0 && b.maxUsd <= 5);
            set("ticketsAskedMaxUsd", b.askedMaxUsd, typeof b.askedMaxUsd === "number" && b.askedMaxUsd > 0 && b.askedMaxUsd <= 20);
            set("ticketsAutoDailyUsd", b.dailyUsd, typeof b.dailyUsd === "number" && b.dailyUsd >= 0 && b.dailyUsd <= 50);
            set("ticketsWip", b.wip, Number.isInteger(b.wip) && Number(b.wip) >= 1 && Number(b.wip) <= 6);
            tickets.dispatch();
          }
          return json(res, 200, tickets.autoWork());
        }
        const r = await ticketRoute(tickets, req, url, gitReady, pressProblem);
        if (r && r[0] === -2) return sendFile(res, r[1] as TicketFile);
        if (r) return r[0] === -1 ? text(res, 200, String(r[1])) : json(res, r[0], r[1]);
      }
      if (url.pathname === "/api/imports" || url.pathname.startsWith("/api/imports/")) {
        const canImport = () => gitReady() ? null : "Git is not installed, so a repo cannot be imported. Install Git for Windows (git-scm.com/download/win), then import again.";
        const r = await importsRoute({ log, explorer, reviewer, readJson, canImport }, req, url);
        if (r) return json(res, r[0], r[1]);
      }
      if (url.pathname === "/api/launch" || url.pathname.startsWith("/api/launch/") || url.pathname.startsWith("/preview/")) {
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
        const r = await pluginsRoute({ plugins, readJson, openUrl: openFolder }, req, url);
        if (r) return json(res, r[0], r[1]);
      }
      if (url.pathname.startsWith("/plugins/") && servePluginFile(plugins, req, res, url)) return;
      if (url.pathname === "/api/brain" || url.pathname.startsWith("/api/brain/")) {
        const r = await brainRoute({ log, bay, order: () => order.state(), readJson }, req, url);
        if (r) return json(res, r[0], r[1]);
      }
      if (url.pathname === "/api/flows" || url.pathname.startsWith("/api/flows/")) {
        const r = await flowsRoute({ flows: factory.flows, improver: flowImprover, readJson }, req, url);
        if (r) return json(res, r[0], r[1]);
      }
      if (url.pathname === "/api/watchers" || url.pathname.startsWith("/api/watchers/") || url.pathname === "/api/budget/month") {
        const r = await watchRoute({ log, watchers, readJson }, req, url);
        if (r) return json(res, r[0], r[1]);
      }
      if (url.pathname === "/api/git" || url.pathname.startsWith("/api/git/")) {
        const r = await gitRoute({ git: gitman, readJson }, req, url);
        if (r) return json(res, r[0], r[1]);
      }
      if (url.pathname === "/api/feature-map" || url.pathname.startsWith("/api/feature-map/")) {
        const r = await featureMapRoute({ log, readJson }, req, url);
        if (r) return json(res, r[0], r[1]);
      }
      if (url.pathname.startsWith("/api/improve/")) {
        const r = await improveRoute(improve, req, url.pathname, log, factory, (idea, projectId) => {
          if (!gitReady()) throw new Error("Git is not installed, so the factory has nowhere to keep the app it builds. Install Git for Windows (git-scm.com/download/win), then press Build again.");
          return factory.start(idea, projectId != null ? { projectId } : {});
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
  return Object.assign(handler, { github, git: gitman, flowImprover, watchers, factory, order, bay, drop, tickets, improve, explorer, reviewer, launcher, integrations, plugins, errors, fault, ensureSelf });
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
  /** Factory runs in flight, a run waiting at a gate included. */
  activeRuns: number;
  /** Agent calls in flight anywhere in the core: a ticket's crew, a Council session, an import, the Overseer. */
  agentCalls: number;
  /** Jobs running on this PC's build runners. Installing would cut them off, so an update that installs by itself waits. */
  runnerJobs: number;
  /** Versions this install has run, newest first. */
  history: { ts: string; from: string | null; to: string }[];
}

export function updatesReport(log: EventLog, appVersion: string | undefined, activeRuns: number, agentCalls = 0, runnerJobs = 0): UpdatesReport {
  const history = (log.db.prepare("SELECT ts, from_version, to_version FROM app_versions ORDER BY id DESC LIMIT 10").all() as { ts: string; from_version: string | null; to_version: string }[])
    .map((r) => ({ ts: r.ts, from: r.from_version, to: r.to_version }));
  return { auto: readSettings(log).autoUpdate !== false, appVersion: appVersion ?? null, activeRuns, agentCalls, runnerJobs, history };
}

/** Link SoftwareFactory's own project to its GitHub repo once, so its tickets are worked there. */
export function linkSelfRepo(log: EventLog, project: number, repo: string) {
  const g = parseGitHubRepo(repo);
  if (!g) return;
  const has = log.db.prepare("SELECT 1 FROM project_links WHERE project_id = ? AND kind = 'github'").get(project);
  if (!has) linkToProject(log, project, "github", `${g.owner}/${g.name}`);
}

/** The GitHub repo of SoftwareFactory's own project, if linked. */
function selfGitHub(log: EventLog) {
  const row = log.db.prepare("SELECT l.ref FROM project_links l JOIN project_links s ON s.project_id = l.project_id AND s.kind = 'self' WHERE l.kind = 'github' LIMIT 1").get() as { ref: string } | undefined;
  return row ? parseGitHubRepo(row.ref) : null;
}

/** Settings you changed in the Bridge, newest value per key, from the `settings` table. */
export function readSettings(log: EventLog): {
  crewMode?: CrewMode; dropDir?: string; improveAuto?: boolean; improveMaxUsd?: number; improveEveryHours?: number; autoUpdate?: boolean; importsFollow?: boolean;
  importReviewMaxUsd?: number; importReviewAuto?: boolean; importHomeStack?: string;
  ticketsAutoWork?: boolean; ticketsAutoMaxUsd?: number; ticketsAskedMaxUsd?: number; ticketsAutoDailyUsd?: number; ticketsWip?: number;
  maxRunMinutes?: number;
} {
  const rows = log.db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
}

/**
 * Once: Assaf raised the standing auto-work limits on 19 Nov 2026 ("yes" to $10 a day, so SF's tickets stop waiting
 * for tomorrow; a crew start capped at $0.60 ran out of money mid-fix on SF-53). A limit still at the old default is
 * lifted to the new one; a limit set to anything else is yours and stays.
 */
export function liftAutoWorkLimits(log: EventLog): void {
  const st = readSettings(log) as Record<string, unknown>;
  if (st.ticketsLimitsLifted) return;
  if (st.ticketsAutoDailyUsd === 3) log.append("settings.changed", { key: "ticketsAutoDailyUsd", value: AUTO_WORK_DEFAULT.dailyUsd });
  if (st.ticketsAutoMaxUsd === 0.6) log.append("settings.changed", { key: "ticketsAutoMaxUsd", value: AUTO_WORK_DEFAULT.maxUsd });
  log.append("settings.changed", { key: "ticketsLimitsLifted", value: true });
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
  // Each agent's own memory (bay/memory.ts): teach, forget, the free tidy, and a capped cleaning you accept or reject.
  m = path.match(/^\/api\/bay\/agents\/([a-z0-9-]+)\/memory(?:\/(forget|tidy|dream))?$/);
  if (m) {
    const [, id, verb] = m;
    if (!verb) return [201, bay.teach(id, String(body.text ?? ""))];
    if (verb === "forget") return [200, { removed: bay.forget(id, (Array.isArray(body.ids) ? body.ids : [body.id]).map(Number)) }];
    if (verb === "tidy") return [200, bay.tidy(id)];
    if (verb === "dream") return [200, await bay.dream(id, body.maxUsd == null ? undefined : Number(body.maxUsd))];
  }
  m = path.match(/^\/api\/bay\/dreams\/(\d+)\/(accept|reject)$/);
  if (m) return [200, m[2] === "accept" ? bay.acceptDream(Number(m[1])) : bay.rejectDream(Number(m[1]))];
  m = path.match(/^\/api\/bay\/slots\/([a-z]+)$/);
  if (m && SLOTS.includes(m[1] as Slot)) return [200, bay.assign(m[1] as Slot, (Array.isArray(body.agents) ? body.agents : []).map(String))];
  return null;
}

/** The tickets' API. Every write is an event, so the Bridge sees it on the stream. Status -1 = the work document as Markdown. */
async function ticketRoute(tickets: Tickets, req: IncomingMessage, url: URL, gitReady: () => boolean, pressProblem: () => string | null = () => null): Promise<[number, unknown] | null> {
  const path = url.pathname;
  const q = url.searchParams;
  const proj = q.get("project");
  if (req.method === "GET" && path === "/api/tickets/meta") {
    return [200, { kinds: KINDS.map((k) => ({ code: k, label: KIND_LABEL[k], questions: FORMS[k] })), statuses: STATUS_WORDS, priorities: PRIORITIES.map((p) => ({ code: p, label: PRIORITY_LABEL[p] })), severities: TICKET_SEVERITIES, relations: RELATIONS }];
  }
  if (req.method === "GET" && path === "/api/tickets/queue") {
    const project = proj == null || proj === "" ? null : Number(proj);
    return [200, { rule: tickets.autoWork(), queue: tickets.queue(project).map((q) => ({ id: q.ticket.id, key: q.ticket.key, title: q.ticket.title, kind: q.ticket.kind, size: q.ticket.size, position: q.position, why: q.why })) }];
  }
  if (req.method === "GET" && path === "/api/tickets/board") {
    const project = proj == null || proj === "" ? null : Number(proj);
    return [200, tickets.board({ project })];
  }
  if (req.method === "GET" && path === "/api/tickets/checks") {
    const project = proj == null || proj === "" ? null : Number(proj);
    return [200, { items: tickets.checks(project) }];
  }
  if (req.method === "GET" && path === "/api/tickets/waiting") {
    const project = proj == null || proj === "" ? null : Number(proj);
    return [200, { items: tickets.waiting(project) }];
  }
  if (req.method === "GET" && path === "/api/tickets/export") {
    const ids = (q.get("ids") ?? "").split(",").map(Number).filter((n) => n > 0);
    const format = q.get("format") === "json" ? "json" : "md";
    return [format === "json" ? 200 : -1, format === "json" ? JSON.parse(tickets.exportTickets(ids, "json")) : tickets.exportTickets(ids, "md")];
  }
  const byKey = path.match(/^\/api\/tickets\/key\/([^/]+)$/);
  if (req.method === "GET" && byKey) {
    const t = tickets.byKey(decodeURIComponent(byKey[1]));
    return t ? [200, tickets.detail(t.id)] : [404, { error: `No ticket ${decodeURIComponent(byKey[1])}` }];
  }
  if (req.method === "GET" && path === "/api/tickets") {
    const project = proj == null || proj === "" ? null : Number(proj);
    const view = (q.get("view") ?? "open") as "open";
    const parent = q.get("parent");
    return [200, {
      tickets: tickets.list({ project, view, parent: parent ? Number(parent) : undefined, kind: (q.get("kind") ?? undefined) as TicketKind | undefined, status: (q.get("status") ?? undefined) as TicketStatus | undefined, q: q.get("q") ?? undefined }),
      counts: tickets.counts(project),
    }];
  }
  const fileGet = path.match(/^\/api\/tickets\/(\d+)\/files\/([^/]+)$/);
  if (req.method === "GET" && fileGet) {
    const f = tickets.files(Number(fileGet[1])).find((x) => x.file === decodeURIComponent(fileGet[2]));
    return f ? [-2, f] : [404, { error: "No such file on this ticket." }];
  }
  let m = path.match(/^\/api\/tickets\/(\d+)(?:\/([a-z]+))?$/);
  if (req.method === "GET" && m) {
    const id = Number(m[1]);
    if (m[2] === "document") return [-1, tickets.document(id)];
    if (m[2] === "check") return [200, tickets.check(id)];
    if (m[2]) return null;
    const d = tickets.detail(id);
    return d ? [200, d] : [404, { error: `No ticket #${id}` }];
  }
  if (req.method !== "POST") return null;
  // A file for a ticket: the raw bytes as the body, its name in ?name= (no JSON, so a 10 MB screenshot is not inflated).
  const fileAdd = path.match(/^\/api\/tickets\/(\d+)\/files$/);
  if (fileAdd) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) { size += (c as Buffer).length; if (size > TICKET_FILE_MAX) return [413, { error: "A ticket takes files up to 15 MB." }]; chunks.push(c as Buffer); }
    try { return [201, tickets.attach(Number(fileAdd[1]), q.get("name") ?? "file", Buffer.concat(chunks), { mime: String(req.headers["content-type"] ?? "") })]; } catch (e) { return [400, { error: (e as Error).message }]; }
  }
  const fileOff = path.match(/^\/api\/tickets\/(\d+)\/files\/([^/]+)\/remove$/);
  if (fileOff) { try { return [200, tickets.detach(Number(fileOff[1]), decodeURIComponent(fileOff[2]))]; } catch (e) { return [400, { error: (e as Error).message }]; } }
  const body = await readJson(req);
  // Your answers to the check before money, in one batch; with run, the tickets that are then clear start.
  if (path === "/api/tickets/checks") {
    const answers = Array.isArray(body.answers) ? (body.answers as { id: number; q: string; text: string }[]) : [];
    try { return [200, tickets.answerChecks(answers, { run: body.run === true })]; } catch (e) { return [400, { error: (e as Error).message }]; }
  }
  // Many tickets at once: a status move, asked, size, priority, parent or assignee. Each says why it refused.
  if (path === "/api/tickets/bulk") {
    try { return [200, tickets.bulk(Array.isArray(body.ids) ? body.ids.map(Number) : [], String(body.action ?? ""), body.value)]; } catch (e) { return [400, { error: (e as Error).message }]; }
  }
  if (path === "/api/tickets") return [201, tickets.open({ ...(body as object), by: "you", source: typeof body.source === "string" ? body.source : "you" } as any)];
  m = path.match(/^\/api\/tickets\/(\d+)\/([a-z]+)$/);
  if (!m) return null;
  const id = Number(m[1]);
  switch (m[2]) {
    case "edit": return [200, tickets.edit(id, String(body.field), body.value, "you", body.key ? String(body.key) : undefined)];
    case "say": return [200, tickets.say(id, String(body.text ?? ""), { status: body.status ? String(body.status) as TicketStatus : undefined })];
    case "link": {
      // "SF-4", "#4" or 4: people say a ticket by its key.
      const to = typeof body.to === "number" ? body.to : tickets.byKey(String(body.to ?? ""))?.id;
      if (to == null) return [400, { error: `No ticket ${String(body.to ?? "")} to link to.` }];
      return [200, tickets.link(id, to, String(body.relation ?? "related") as Relation, "you", body.removed === true)];
    }
    case "line": return [200, tickets.moveLine(id, body.dir === "up" ? "up" : "down")];
    // A pull request opened outside SoftwareFactory: link it, and its merge moves this ticket.
    case "pr":
      try { return [200, await tickets.linkPr(id, String(body.pr ?? body.number ?? ""))]; } catch (e) { return [400, { error: (e as Error).message }]; }
    // Your press: the ticket's branch goes to GitHub (a draft PR with a token, else this PC's own Git sign-in).
    case "send":
      try { return [200, await tickets.send(id)]; } catch (e) { return [400, { error: (e as Error).message }]; }
    case "spawn": return [201, tickets.spawn(id, { ...(body as object), by: "you" } as any)];
    case "work":
      if (!gitReady()) return [409, { error: "Git is not installed, so the crew has nowhere to keep what it builds. Install Git for Windows (git-scm.com/download/win), then press Work it again." }];
      { const why = pressProblem(); if (why) return [409, { error: why }]; }
      try {
        return [202, tickets.work(id, { maxUsd: typeof body.maxUsd === "number" ? body.maxUsd : undefined, autoApprove: body.autoApprove === true, again: body.again === true, where: body.where === "repo" || body.where === "new" ? body.where : "auto", route: body.route === "light" || body.route === "engine" ? body.route : undefined, check: body.anyway !== true })];
      } catch (e) {
        const dup = (e as { duplicate?: Record<string, unknown> }).duplicate;
        if (dup) return [409, { error: (e as Error).message, ...dup }];
        // The check before money asks first: its questions come back, and "anyway" runs it regardless.
        const check = (e as { check?: unknown }).check;
        if (check) return [409, { error: (e as Error).message, check }];
        throw e;
      }
    case "ask": return [200, await tickets.ask(id, body.agent ? String(body.agent) : undefined)];
    // You asked for it: the crew starts it by itself within the standing auto-work limit (no press each time).
    case "asked": try { return [200, tickets.setAsked(id, body.on !== false)]; } catch (e) { return [400, { error: (e as Error).message }]; }
    // SF-65: its run stopped or failed: pick it up from that step with fresh money, keeping what was built.
    case "retry":
      try { return [202, tickets.retry(id, { addUsd: typeof body.addUsd === "number" ? body.addUsd : undefined })]; } catch (e) { return [409, { error: (e as Error).message }]; }
  }
  return null;
}

/** The Improvement Council's API. Every write is an event, so the Bridge sees it on the stream. */
async function improveRoute(improve: ImproveCouncil, req: IncomingMessage, path: string, log: EventLog, factory: Pick<Factory, "duplicateOf">, build: (idea: string, projectId?: number) => number): Promise<[number, unknown] | null> {
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
    const idea = improve.buildIdea(id);
    const dup = duplicateReply(factory, idea, body.again);
    if (dup) return dup;
    if (p.status !== "accepted") improve.decide(id, "accepted");
    // A proposal about a project builds in that project, not as a new one beside it.
    // (Proposal targets name Order Engine nodes and factory runs; the project is whoever owns that.)
    const owner = p.target.id == null ? null
      : p.target.kind === "run" ? projectOf(log, { kind: "factory_run", ref: p.target.id })
      : p.target.kind === "project" || p.target.kind === "idea" ? projectOf(log, { kind: "order_node", ref: p.target.id }) : null;
    const projectId = owner ?? undefined;
    try { return [202, { run: build(idea, projectId) }]; } catch (e) { return [409, { error: (e as Error).message }]; }
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
/** A ticket's file. Pictures, video, PDF and plain text show in place; anything that could run (HTML, SVG) is downloaded. */
function sendFile(res: ServerResponse, f: TicketFile) {
  const inline = /^(image\/(png|jpeg|gif|webp)|video\/|application\/pdf|text\/plain)/.test(f.mime);
  res.writeHead(200, {
    "content-type": inline ? f.mime : "application/octet-stream", "content-length": String(f.size),
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${f.name.replace(/"/g, "")}"`,
    "x-content-type-options": "nosniff", "content-security-policy": "sandbox", "cache-control": "private, max-age=3600",
  });
  res.end(readFileSync(f.path));
}
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

/**
 * Open one base's factory: its database, crew, core and background timers.
 * The default base keeps the old env overrides (SF_PROJECTS, SF_DROP); other bases keep
 * everything inside their own folder.
 */
export function bootBase(dbPath: string, { isDefault = true, runnerJobs }: { isDefault?: boolean; runnerJobs?: () => number } = {}): BootedBase & { core: ReturnType<typeof createCore>; log: EventLog } {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const log = new EventLog(dbPath);
  // Crew mode: what you last picked in the Bridge, else what the shell found (real when Claude Code is installed).
  const picked = readSettings(log).crewMode;
  const envMode: CrewMode = modeOf(runtimeFromEnv());
  const mode = picked ?? envMode;
  const runtime = new SwitchableRuntime(mode === "real" && process.env.SF_RUNTIME?.startsWith("claude-code") ? runtimeFromEnv() : runtimeFor(mode), mode);
  const dataDir = dbPath === ":memory:" ? process.cwd() : dirname(dbPath);
  const projectsDir = (isDefault ? process.env.SF_PROJECTS : undefined) ?? resolve(dataDir, "projects");
  const dropDir = isDefault ? process.env.SF_DROP : join(dataDir, "Drop");
  const orderMode = process.env.SF_ORDER_MODE as "agent" | "heuristic" | undefined;
  const orderMax = process.env.SF_ORDER_MAX_USD ? Number(process.env.SF_ORDER_MAX_USD) : undefined;
  const improveMax = process.env.SF_IMPROVE_MAX_USD ? Number(process.env.SF_IMPROVE_MAX_USD) : undefined;
  const improveEvery = process.env.SF_IMPROVE_EVERY_H ? Number(process.env.SF_IMPROVE_EVERY_H) : undefined;
  // The installed app may use the GitHub CLI's login for crew PRs; tests build a core without it, so they never reach the real GitHub.
  const core = createCore({ log, runtime, projectsDir, dataDir, dropDir, github: new GitHub({ dataDir, cli: process.env.VITEST ? undefined : ghCliToken }), order: { mode: orderMode, maxUsd: orderMax }, improve: { maxUsd: improveMax, everyHours: improveEvery }, appVersion: process.env.SF_APP_VERSION, runnerJobs });
  core.drop.start();
  const timers: NodeJS.Timeout[] = [];
  faultCore = core; // the open base hears what the process throws
  core.ensureSelf(); // SoftwareFactory has a project of its own from the first start
  core.tickets.backfillKeys(); // projects whose tickets came before keys get theirs (SF for SoftwareFactory)
  // SoftwareFactory's own tickets are worked in its own repo, as PRs (Assaf, 11 Nov 2026: the crew may open PRs, never push to main).
  linkSelfRepo(log, core.ensureSelf(), process.env.SF_SELF_REPO ?? "PlonterAsi/SoftwareFactory");
  // Follow the crew's open PRs: a merge moves the ticket on. At start, then every 5 minutes.
  // Work merged without the crew's own PR (a thread's PR that names SF-13) moves its ticket too.
  // Then the git manager: a merge review of each crew PR whose CI ended (and a merge under "auto"), and outside work.
  const follow = () => core.tickets.followPrs().then(() => core.tickets.followMerges()).then(() => core.git.tend()).then(() => core.git.watchAll()).then(() => core.flowImprover.suggestAll()).catch((e) => console.error("following PRs failed:", e));
  follow();
  timers.push(setInterval(follow, 5 * 60_000).unref());
  // The Order Engine's daily sweep and briefing: at start if the last one is a day old, then once a day.
  const { order } = core;
  const sweepIfDue = () => {
    // Nothing filed yet (a first launch): no briefing, the welcome speaks instead.
    if (!order.state().fragments.length) return;
    const last = order.state().briefings.at(-1);
    if (!last || Date.now() - Date.parse(last.ts) >= 86_400_000) order.sweep();
  };
  sweepIfDue();
  timers.push(setInterval(sweepIfDue, 3_600_000).unref());
  // The Improvement Council looks again on its own (real crew only, within its caps): first a few minutes after start, then every 15 minutes it checks if a look is due.
  // Imported repos are kept current: a free look at each source, and a capped exploration when it moved.
  // Watchers look when they are due (free; they only open tickets), then the queue gets a look: a new month's budget lets waiting tickets start.
  const watchTick = () => { core.watchers.runDue().then(() => core.tickets.dispatch()).catch((e) => console.error("watchers failed:", e)); };
  setTimeout(watchTick, 4 * 60_000).unref();
  timers.push(setInterval(watchTick, 30 * 60_000).unref());
  const followTick = () => { core.explorer.followTick().catch((e) => console.error("following imported repos failed:", e)); };
  setTimeout(followTick, 3 * 60_000).unref();
  timers.push(setInterval(followTick, 30 * 60_000).unref());
  const improveTick = () => { core.improve.tick().catch((e) => { console.error("improve tick failed:", e); core.fault("improvement council tick", e); }); };
  timers.push(setTimeout(improveTick, 3 * 60_000).unref());
  timers.push(setInterval(improveTick, 15 * 60_000).unref());
  // Plugins you turned on start with the core and stop with it.
  for (const id of core.plugins.startAll()) console.log(`Plugin ${id} started`);
  // Add-ons installed from GitHub keep themselves up to date: a minute after start, then every 6 hours.
  const addonTick = () => { if (!process.env.VITEST) core.plugins.updateAllFromGithub().then((ids) => { for (const id of ids) console.log(`Add-on ${id} updated`); }).catch((e) => console.error("add-on updates failed:", e)); };
  timers.push(setTimeout(addonTick, 60_000).unref());
  timers.push(setInterval(addonTick, 6 * 3_600_000).unref());
  // Runs the app closed on pick up again from their last completed station (SF_AUTO_RESUME=0 leaves them for the Resume button).
  if (process.env.SF_AUTO_RESUME !== "0" && core.factory.interrupted.length) {
    if (!checkGit().found) console.log("Not resuming interrupted runs: Git is not installed.");
    else for (const id of core.factory.resumeInterrupted()) console.log(`Resumed run #${id} where it left off`);
  }
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const t of timers) clearTimeout(t);
    try { core.drop.stop(); } catch { /* not watching */ }
    try { core.plugins.stopAll(true); } catch (e) { console.error("stopping plugins failed:", e); }
    try { core.launcher.stopAll(); } catch (e) { console.error("stopping launched apps failed:", e); }
    log.removeAllListeners();
    try { log.close(); } catch { /* already closed */ }
  };
  return { handler: core, activeRuns: () => core.factory.activeCount(), dispose, core, log };
}

/** The core of the base opened last: errors the process throws are filed there. */
let faultCore: { fault: (where: string, e: unknown) => void } | null = null;

// Started directly (dev, or as the Tauri sidecar): listen on localhost only.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dbPath = process.env.SF_DB ?? resolve(process.cwd(), ".sf-data/factory.db");
  const port = Number(process.env.SF_PORT ?? 4317);
  // Bases: the home folder (where factory.db has always been) keeps the list of factories this app hosts.
  // The factory that was here before is "Main factory"; the others live in their own folders.
  const home = dbPath === ":memory:" ? null : dirname(dbPath);
  // Build runners belong to the app, not to a base: they keep working across a base switch and stop with the core.
  // The GitHub sign-in used is the GitHub CLI's on this PC, else the token pasted in Systems; neither is stored here.
  const runners = home ? new RunnerManager({ home, token: () => ghCliToken() ?? pastedToken(home) }) : null;
  const runnerJobs = () => runners?.busyCount() ?? 0;
  const host = home ? new BaseHost(new BaseRegistry(home), (b) => {
    console.log(`${new Date().toISOString()} opening base #${b.id} "${b.name}" at ${b.folder}`);
    return bootBase(b.isDefault ? dbPath : join(b.folder, "factory.db"), { isDefault: b.isDefault, runnerJobs });
  }, openFolder) : null;
  const single = host ? null : bootBase(dbPath);
  const inner = host ? host.handle : single!.handler;
  const server = createServer(async (req, res) => {
    if (runners && (req.url ?? "").startsWith("/api/runners")) {
      try { if (await runnersRoute(runners, req, res, new URL(req.url ?? "/", "http://localhost"))) return; } catch (e) { console.error("runners route failed:", e); }
    }
    return inner(req, res);
  });
  process.on("exit", () => { runners?.stopAll(); if (host) host.dispose(); else single!.dispose(); });
  // Nothing thrown is lost: it is a bug ticket on the open base before anything else happens.
  process.on("unhandledRejection", (e) => { console.error("unhandled rejection:", e); faultCore?.fault("the core (unhandled promise rejection)", e); });
  process.on("uncaughtException", (e) => {
    console.error("uncaught exception:", e);
    faultCore?.fault("the core (uncaught exception, the core stopped)", e);
    process.exit(1); // the exit handler closes the open base's database
  });
  const runtime = { name: process.env.SF_RUNTIME ?? "auto" };
  // Started by the desktop shell: leave with it. Polling is cheap and works on every OS,
  // including when the shell is killed outright and cannot stop its child.
  const parent = Number(process.env.SF_PARENT_PID);
  if (parent > 0) {
    setInterval(() => {
      try { process.kill(parent, 0); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EPERM") return; // alive, just not ours to signal
        console.log(`The app (pid ${parent}) is gone; the core stops too.`);
        process.exit(0); // the exit handler closes the open base's database
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
    // A gap of minutes is the PC asleep, not the core at work (core.log of 2026-11-14 said "busy for 14105.6 s" after a night's sleep).
    if (stalled >= 120_000) console.log(`${new Date(now).toISOString()} the clock jumped ${Math.round(stalled / 1000)} s: the PC slept, or the core was held that long`);
    else if (stalled >= 2_000) console.error(`${new Date(now).toISOString()} the core was busy for ${(stalled / 1000).toFixed(1)} s and could not answer`);
    tick = now;
  }, 500).unref();
  runners?.startAll();
  server.listen(port, "127.0.0.1", () => console.log(`${new Date().toISOString()} SoftwareFactory core on http://127.0.0.1:${port} (runtime ${runtime.name}, base ${host ? `"${host.current.name}" at ${host.current.folder}` : dbPath})`));
}

/** The GitHub token pasted in Systems (the file `github-token` in the data folder), or null. */
function pastedToken(home: string): string | null {
  try { return readFileSync(join(home, "github-token"), "utf8").trim() || null; } catch { return null; }
}
