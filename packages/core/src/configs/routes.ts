import type { IncomingMessage } from "node:http";
import type { EventLog } from "../events.js";
import { CONFIG_LAYERS, configHash, diffConfig } from "./inventory.js";
import { canTrial, decideTrials, onTrial, trialReport } from "./trials.js";
import { CATALOG_STATES, getEntry, listCatalog, saveEntry, setEntryState, type CatalogState } from "./catalog.js";
import type { Tickets } from "../tickets/tickets.js";
import { SETTING_KINDS, assign, assignments, listProfiles, removeProfile, resolveProfiles, saveProfile, type Scope } from "./profiles.js";
import { currentConfig, ranWith, snapshotOf } from "./stamp.js";

/**
 * The Configuration API (docs/configuration.md).
 *
 *   GET /api/config                    the setup SoftwareFactory runs with now, by layer, and its hash
 *   GET /api/config/snapshots/:hash    a setup a past call ran with, and what changed since
 *   GET /api/config/ran?run=N          the setups factory run N ran with (or ?ticket=N for a ticket)
 *   GET    /api/config/profiles        every profile, which scope uses which, and what a profile can set
 *   PUT    /api/config/profiles/:id    { profile }  save (refused, with every problem, when two settings touch the same thing)
 *   DELETE /api/config/profiles/:id    remove; whatever used it falls back to the broader profile
 *   POST   /api/config/assign          { scope: global|project|ticket|run, ref, profile|null }
 *   GET    /api/config/resolve?project=&ticket=&run=   the profiles and settings a call there runs with
 */
export async function configRoute(ctx: { log: EventLog; readJson?: (req: IncomingMessage) => Promise<any>; known?: () => { flows: Set<string>; agents: Set<string> }; tickets?: Tickets | null }, req: IncomingMessage, url: URL): Promise<[number, unknown] | null> {
  const parts = url.pathname.replace(/^\/api\/config\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const num = (k: string) => { const v = url.searchParams.get(k); return v && /^\d+$/.test(v) ? Number(v) : null; };
  try {
    if (parts[0] === "profiles" && parts.length === 1 && req.method === "GET") return [200, { profiles: listProfiles(ctx.log), assignments: assignments(ctx.log), kinds: SETTING_KINDS }];
    if (parts[0] === "profiles" && parts.length === 2 && req.method === "PUT") {
      const body = (await ctx.readJson?.(req)) ?? {};
      const entries = new Map(listCatalog(ctx.log).map((e) => [e.id, e]));
      return [200, saveProfile(ctx.log, { ...(body.profile ?? {}), id: parts[1] }, "you", { ...ctx.known?.(), entries })];
    }
    if (parts[0] === "profiles" && parts.length === 2 && req.method === "DELETE") { removeProfile(ctx.log, parts[1]); return [200, { ok: true }]; }
    if (parts[0] === "assign" && parts.length === 1 && req.method === "POST") {
      const body = (await ctx.readJson?.(req)) ?? {};
      assign(ctx.log, body.scope as Scope, body.ref ?? null, body.profile ? String(body.profile) : null);
      return [200, { assignments: assignments(ctx.log) }];
    }
    if (parts[0] === "catalog" && parts.length === 1 && req.method === "GET") {
      decideTrials(ctx.log, (id, state, note) => setEntryState(ctx.log, ctx.tickets ?? null, id, state, "trial", note));
      const entries = listCatalog(ctx.log);
      return [200, { entries, states: CATALOG_STATES, trials: Object.fromEntries(entries.filter((e) => e.state === "trial").map((e) => [e.id, trialReport(ctx.log, e.id)])) }];
    }
    if (parts[0] === "catalog" && parts.length === 1 && req.method === "POST") { const body = (await ctx.readJson?.(req)) ?? {}; return [200, saveEntry(ctx.log, body.entry ?? {})]; }
    if (parts[0] === "catalog" && parts.length === 3 && parts[2] === "state" && req.method === "POST") {
      const body = (await ctx.readJson?.(req)) ?? {};
      if (body.state === "trial") {
        const e = getEntry(ctx.log, parts[1]);
        const no = canTrial(e);
        if (no) return [400, { error: no }];
        // Two trials at once may not touch the same thing, or neither result would mean anything.
        const mine = new Set([...(e!.touches ?? []), ...(e!.settings ?? []).map((x) => x.path)]);
        const clash = onTrial(ctx.log).find((o) => o.id !== e!.id && [...o.touches, ...(o.settings ?? []).map((x) => x.path)].some((t) => mine.has(t)));
        if (clash) return [400, { error: `"${clash.title}" is on trial and touches the same thing. Wait for it, or drop it.` }];
      }
      return [200, setEntryState(ctx.log, ctx.tickets ?? null, parts[1], String(body.state) as CatalogState, "you", body.note ? String(body.note) : undefined)];
    }
    if (parts[0] === "resolve" && req.method === "GET") return [200, resolveProfiles(ctx.log, { projectId: num("project"), ticket: num("ticket"), factoryRun: num("run") })];
  } catch (e) {
    const err = e as Error & { problems?: string[] };
    return [400, { error: err.message, ...(err.problems ? { problems: err.problems } : {}) }];
  }
  if (req.method !== "GET") return null;
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
