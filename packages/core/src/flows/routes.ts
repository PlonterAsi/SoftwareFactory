import type { IncomingMessage } from "node:http";
import { ACTIONS, STEP_AGENTS, flowProblems, type FlowDef } from "./flow.js";
import type { FlowLibrary } from "./library.js";

/**
 * The Flows API. A save is a `flow.saved` event, so the Bridge sees it on the stream.
 *
 *   GET  /api/flows                 every flow (built-in and saved), and what a step may do and who may work it
 *   GET  /api/flows/:id             one flow, with its saved versions
 *   GET  /api/flows/:id/v/:version  one saved version (what a past run followed)
 *   POST /api/flows/check           { flow }   the problems that would stop it running, without saving
 *   PUT  /api/flows/:id             { flow }   save it as the next version (refused, with every problem, when it cannot run)
 *   POST /api/flows/:id/reset       back to the flow SoftwareFactory ships, as the next version
 */
export async function flowsRoute(ctx: { flows: FlowLibrary; readJson: (req: IncomingMessage) => Promise<any> }, req: IncomingMessage, url: URL): Promise<[number, unknown] | null> {
  const { flows } = ctx;
  const parts = url.pathname.replace(/^\/api\/flows\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  try {
    if (req.method === "GET" && !parts.length) return [200, { flows: flows.list(), actions: ACTIONS, agents: STEP_AGENTS }];
    if (req.method === "POST" && parts.length === 1 && parts[0] === "check") {
      const body = await ctx.readJson(req);
      return [200, { problems: flowProblems(body.flow as FlowDef) }];
    }
    if (req.method === "GET" && parts.length === 1) {
      const flow = flows.get(parts[0]);
      return flow ? [200, { flow, history: flows.history(parts[0]) }] : [404, { error: `There is no flow "${parts[0]}".` }];
    }
    if (req.method === "GET" && parts.length === 3 && parts[1] === "v") {
      const flow = flows.version(parts[0], Number(parts[2]));
      return flow ? [200, { flow }] : [404, { error: `Flow "${parts[0]}" has no version ${parts[2]}.` }];
    }
    if (req.method === "PUT" && parts.length === 1) {
      const body = await ctx.readJson(req);
      const def = body.flow as FlowDef;
      if (!def || def.id !== parts[0]) return [400, { error: "Send { flow } with the same id as the address." }];
      return [200, { flow: flows.save(def, typeof body.by === "string" ? body.by : "you") }];
    }
    if (req.method === "POST" && parts.length === 2 && parts[1] === "reset") return [200, { flow: flows.reset(parts[0]) }];
  } catch (e) {
    return [400, { error: (e as Error).message }];
  }
  return null;
}
