import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunnerManager } from "./manager.js";

/**
 * The build runners API. It belongs to the app, not to a base, so it is answered before a
 * request reaches the open base's core.
 *
 *   GET  /api/runners                     the runners on this PC, the jobs they ran, how many run now
 *   GET  /api/runners/suggest?repo=       a name, labels and folder for a repository's runner
 *   POST /api/runners                     { repo, name?, labels?, dir? }  add one: download, register, start
 *   GET  /api/runners/github?repo=        what GitHub says: its runners, where builds are sent, the latest runs and the machine of each job
 *   GET  /api/runners/:id/log?after=      what the runner printed after line n
 *   POST /api/runners/:id/start | stop | restart | setup
 *   POST /api/runners/:id/route           { on }  send the repository's builds to this PC, or back to GitHub's machines
 *   POST /api/runners/:id/remove          stop it, take it off GitHub, forget it (its folder stays)
 */
export async function runnersRoute(m: RunnerManager, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  if (path !== "/api/runners" && !path.startsWith("/api/runners/")) return false;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return true; }
  // A plugin's page (a sandboxed frame) never starts, stops or registers a runner.
  if (req.headers.origin === "null") { json(res, 403, { error: "Plugin pages cannot manage build runners" }); return true; }
  try {
    const [status, body] = await route(m, req, url);
    json(res, status, body);
  } catch (e) {
    const err = e as { status?: number; message: string; problems?: string[] };
    json(res, err.status ?? 400, { error: err.message, problems: err.problems });
  }
  return true;
}

async function route(m: RunnerManager, req: IncomingMessage, url: URL): Promise<[number, unknown]> {
  const path = url.pathname;
  const report = () => ({ runners: m.list(), jobs: m.recentJobs(), busy: m.busyCount() });
  if (req.method === "GET") {
    if (path === "/api/runners") return [200, report()];
    if (path === "/api/runners/suggest") return [200, m.suggest(url.searchParams.get("repo") ?? "")];
    if (path === "/api/runners/github") return [200, await m.github(url.searchParams.get("repo") ?? "")];
    const lg = path.match(/^\/api\/runners\/([a-z0-9-]+)\/log$/);
    if (lg) return [200, { runner: m.one(lg[1]), lines: m.linesAfter(lg[1], Number(url.searchParams.get("after") ?? 0)) }];
    return [404, { error: "not found" }];
  }
  if (req.method !== "POST") return [404, { error: "not found" }];
  const body = await readJson(req);
  if (path === "/api/runners") {
    const labels = Array.isArray(body.labels) ? body.labels.map(String) : typeof body.labels === "string" ? body.labels.split(",") : undefined;
    const runner = m.add({ repo: String(body.repo ?? ""), name: body.name ? String(body.name) : undefined, labels, dir: body.dir ? String(body.dir) : undefined });
    return [201, { runner, ...report() }];
  }
  const a = path.match(/^\/api\/runners\/([a-z0-9-]+)\/(start|stop|restart|setup|route|remove)$/);
  if (!a) return [404, { error: "not found" }];
  const id = a[1];
  switch (a[2]) {
    case "start": m.start(id); break;
    case "stop": m.stop(id); break;
    case "restart": m.restart(id); break;
    case "setup": void m.setUp(id); break;
    case "route": return [200, { route: await m.route(id, body.on !== false), ...report() }];
    case "remove": return [200, { ...(await m.remove(id)), ...report() }];
  }
  return [200, report()];
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 100_000) throw new Error("body too large"); }
  return raw ? JSON.parse(raw) : {};
}
