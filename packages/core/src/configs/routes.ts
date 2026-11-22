import type { IncomingMessage } from "node:http";
import type { EventLog } from "../events.js";
import { CONFIG_LAYERS, configHash, diffConfig } from "./inventory.js";
import { currentConfig, ranWith, snapshotOf } from "./stamp.js";

/**
 * The Configuration API (docs/configuration.md).
 *
 *   GET /api/config                    the setup SoftwareFactory runs with now, by layer, and its hash
 *   GET /api/config/snapshots/:hash    a setup a past call ran with, and what changed since
 *   GET /api/config/ran?run=N          the setups factory run N ran with (or ?ticket=N for a ticket)
 */
export async function configRoute(ctx: { log: EventLog }, req: IncomingMessage, url: URL): Promise<[number, unknown] | null> {
  if (req.method !== "GET") return null;
  const parts = url.pathname.replace(/^\/api\/config\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const entries = currentConfig(ctx.log) ?? [];
  if (!parts.length) return [200, { hash: configHash(entries), layers: CONFIG_LAYERS, entries }];
  if (parts[0] === "snapshots" && parts[1]) {
    const snap = snapshotOf(ctx.log, parts[1]);
    if (!snap) return [404, { error: "No setup with that fingerprint was recorded." }];
    return [200, { ...snap, sinceThen: diffConfig(snap.entries, entries), sameAsNow: snap.hash === configHash(entries) }];
  }
  if (parts[0] === "ran") {
    const run = url.searchParams.get("run");
    const ticket = url.searchParams.get("ticket");
    if (run && /^\d+$/.test(run)) return [200, ranWith(ctx.log, { factoryRun: Number(run) })];
    if (ticket && /^\d+$/.test(ticket)) return [200, ranWith(ctx.log, { ticket: Number(ticket) })];
    return [400, { error: "Say which run (?run=N) or ticket (?ticket=N)." }];
  }
  return null;
}
