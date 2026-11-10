import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EventLog, type SfEvent } from "./events.js";
import { captureSignal, listSignals } from "./signals.js";
import { costSummary, runAgent } from "./agents.js";
import { runtimeFromEnv, type AgentRuntime } from "./runtime.js";
import { Factory, type GateId } from "./factory/loop.js";

export const OVERSEER_ROLE =
  "You are the Overseer, the manager AI of SoftwareFactory. Answer in at most 3 short sentences. Be concrete.";

export interface CoreOptions {
  log: EventLog;
  runtime: AgentRuntime;
  /** Default spend cap per agent call, USD. */
  budgetUsd?: number;
  /** Where factory runs create their project repos. */
  projectsDir?: string;
}

/** Build the core HTTP handler: a small JSON API plus a server-sent event stream. */
export function createCore({ log, runtime, budgetUsd = 0.25, projectsDir = resolve(process.cwd(), ".sf-data/projects") }: CoreOptions) {
  const factory = new Factory(log, runtime, projectsDir);
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
  return Object.assign(handler, { factory });
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
  const server = createServer(createCore({ log: new EventLog(dbPath), runtime, projectsDir }));
  server.listen(port, "127.0.0.1", () => console.log(`SoftwareFactory core on http://127.0.0.1:${port} (runtime ${runtime.name}, db ${dbPath})`));
}
