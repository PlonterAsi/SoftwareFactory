import type { IncomingMessage } from "node:http";
import type { EventLog } from "../events.js";
import { featureMap, resetFeature, saveFeature } from "./map.js";

/**
 * The Feature map API. Every change is an event, so the Bridge sees it on the stream.
 *
 *   GET  /api/feature-map             every feature: its record, its wiring from the code, its proof of life
 *   POST /api/feature-map             { name, group, purpose, spec, flow, design, screens, docs, stations }   add a planned feature
 *   PUT  /api/feature-map/:id         the same fields   a new version of a record
 *   POST /api/feature-map/:id/reset   back to the record in code (removes one the person added)
 */
export async function featureMapRoute(ctx: { log: EventLog; readJson: (req: IncomingMessage) => Promise<any> }, req: IncomingMessage, url: URL): Promise<[number, unknown] | null> {
  const { log } = ctx;
  const parts = url.pathname.replace(/^\/api\/feature-map\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  try {
    if (req.method === "GET" && !parts.length) return [200, featureMap(log)];
    if (req.method === "POST" && !parts.length) {
      const id = saveFeature(log, null, await ctx.readJson(req));
      return [201, { id, ...featureMap(log) }];
    }
    if (req.method === "PUT" && parts.length === 1) {
      saveFeature(log, parts[0], await ctx.readJson(req));
      return [200, featureMap(log)];
    }
    if (req.method === "POST" && parts.length === 2 && parts[1] === "reset") {
      resetFeature(log, parts[0]);
      return [200, featureMap(log)];
    }
  } catch (e) {
    return [400, { error: (e as Error).message }];
  }
  return null;
}
