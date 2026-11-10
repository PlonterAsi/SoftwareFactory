import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EventLog, type SfEvent } from "./events.js";
import { captureSignal, listSignals } from "./signals.js";
import { costSummary, runAgent } from "./agents.js";
import { runtimeFromEnv, type AgentRuntime } from "./runtime.js";
import { Factory, type GateId } from "./factory/loop.js";
import { OrderEngine, type OrderOptions } from "./order/engine.js";
import { canonFor, type NodeKind } from "./order/model.js";
import { storeReport } from "./store/inspect.js";

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
}

/** Build the core HTTP handler: a small JSON API plus a server-sent event stream. */
export function createCore({ log, runtime, budgetUsd = 0.25, projectsDir = resolve(process.cwd(), ".sf-data/projects"), order: orderOpts }: CoreOptions) {
  const factory = new Factory(log, runtime, projectsDir);
  const order = new OrderEngine(log, runtime, orderOpts);
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
      if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { ok: true, runtime: runtime.name });
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
        const run = await runAgent(log, runtime, String(body.agent ?? "overseer"), {
          prompt,
          model: body.model ? String(body.model) : undefined,
          systemPrompt: OVERSEER_ROLE,
          budgetUsd: typeof body.budgetUsd === "number" ? body.budgetUsd : budgetUsd,
        });
        return json(res, run.error ? 502 : 200, run);
      }
      if (req.method === "POST" && url.pathname === "/api/factory/runs") {
        const body = await readJson(req);
        const run = factory.start(String(body.idea ?? ""), {
          maxUsd: typeof body.maxUsd === "number" ? body.maxUsd : undefined,
          autoApprove: body.autoApprove === true,
          models: typeof body.models === "object" && body.models ? body.models as Record<string, string> : undefined,
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
  return Object.assign(handler, { factory, order });
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
  const runtime = runtimeFromEnv();
  const projectsDir = process.env.SF_PROJECTS ?? resolve(dbPath === ":memory:" ? process.cwd() : dirname(dbPath), "projects");
  const orderMode = process.env.SF_ORDER_MODE as "agent" | "heuristic" | undefined;
  const orderMax = process.env.SF_ORDER_MAX_USD ? Number(process.env.SF_ORDER_MAX_USD) : undefined;
  const core = createCore({ log: new EventLog(dbPath), runtime, projectsDir, order: { mode: orderMode, maxUsd: orderMax } });
  const server = createServer(core);
  // The Order Engine's daily sweep and briefing: at start if the last one is a day old, then once a day.
  const { order } = core;
  const sweepIfDue = () => {
    const last = order.state().briefings.at(-1);
    if (!last || Date.now() - Date.parse(last.ts) >= 86_400_000) order.sweep();
  };
  sweepIfDue();
  setInterval(sweepIfDue, 3_600_000).unref();
  server.listen(port, "127.0.0.1", () =>console.log(`SoftwareFactory core on http://127.0.0.1:${port} (runtime ${runtime.name}, db ${dbPath})`));
}
