import type { IncomingMessage } from "node:http";
import type { EventLog } from "../events.js";
import type { AgentBay } from "../bay/bay.js";
import { SLOTS, type Slot } from "../bay/agentfile.js";
import { systemPromptFor } from "../bay/builtin.js";
import { principles, resetPrinciple, savePrinciple } from "./brain.js";

/**
 * The Brain API. Every change is an event, so the Bridge sees it on the stream.
 *
 *   GET  /api/brain                            the principles, the stations, and who works each station
 *   GET  /api/brain/prompt?station=plan        the exact system prompt that station's agent runs with now
 *   POST /api/brain                            { title, text, stations, enabled? }   add a principle
 *   PUT  /api/brain/:id                        { title, text, stations, enabled?, note? }   a new version
 *   POST /api/brain/:id/reset                  back to the default (removes one you added)
 */
export async function brainRoute(ctx: { log: EventLog; bay: AgentBay; readJson: (req: IncomingMessage) => Promise<any> }, req: IncomingMessage, url: URL): Promise<[number, unknown] | null> {
  const { log, bay } = ctx;
  const parts = url.pathname.replace(/^\/api\/brain\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const state = () => {
    const slots = bay.slots();
    const crew: Record<string, string[]> = {};
    for (const s of SLOTS) crew[s] = slots[s].map((id) => bay.get(id)?.def.name ?? id);
    return { principles: principles(log), stations: SLOTS, crew };
  };
  try {
    if (req.method === "GET" && !parts.length) return [200, state()];
    if (req.method === "GET" && parts[0] === "prompt") {
      const station = String(url.searchParams.get("station") ?? "plan") as Slot;
      if (!SLOTS.includes(station)) return [400, { error: `Unknown station "${station}"` }];
      const id = url.searchParams.get("agent") ?? bay.slots()[station][0];
      const a = bay.get(id);
      if (!a) return [404, { error: `No agent "${id}"` }];
      return [200, { station, agent: a.def.id, name: a.def.name, prompt: systemPromptFor(a.def, station, principles(log)) }];
    }
    if (req.method === "POST" && !parts.length) {
      const id = savePrinciple(log, null, await ctx.readJson(req));
      return [201, { id, ...state() }];
    }
    if (req.method === "PUT" && parts.length === 1) {
      savePrinciple(log, parts[0], await ctx.readJson(req));
      return [200, state()];
    }
    if (req.method === "POST" && parts.length === 2 && parts[1] === "reset") {
      resetPrinciple(log, parts[0]);
      return [200, state()];
    }
  } catch (e) {
    return [400, { error: (e as Error).message }];
  }
  return null;
}
