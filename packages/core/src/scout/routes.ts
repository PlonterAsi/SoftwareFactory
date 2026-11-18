import type { IncomingMessage } from "node:http";
import type { Scout } from "./scout.js";
import type { Sandbox } from "./sandbox.js";

/**
 * Scout and the auto-file rules (docs/scout.md).
 *
 *   GET  /api/scout                                   every Scout project, with today's counts (the home card)
 *   GET  /api/scout/:project                          settings, counts, last look, sandbox state
 *   POST /api/scout/:project                          { on?, everyHours?, runUsd?, perLook?, trialsPerWeek?, ticketsTo?, focus?, sources?, follow? }  (turns Scout on the first time)
 *   POST /api/scout/:project/look                     look now { analyze?: boolean }
 *   GET  /api/scout/:project/finds?category&verdict&status&trial&q    the catalog
 *   GET  /api/scout/:project/week                     the weekly summary
 *   POST /api/scout/:project/inbox                    { url, note? }   a link you drop
 *   POST /api/scout/:project/follow                   { url, name?, note? }
 *   POST /api/scout/find/:id/judge                    { verdict, note? }
 *   POST /api/scout/find/:id/file                     make it a ticket
 *   POST /api/scout/find/:id/try | approve | decline | run     the sandbox trial
 *   GET  /api/autofile                                the rules
 *   POST /api/autofile                                { rules: [...] }  saves the whole list
 */
export async function scoutRoute(ctx: { scout: Scout; sandbox: Sandbox; readJson: (req: IncomingMessage) => Promise<any> }, req: IncomingMessage, url: URL): Promise<[number, unknown] | null> {
  const { scout, sandbox } = ctx;
  try {
    if (url.pathname === "/api/autofile") {
      if (req.method === "GET") return [200, { rules: scout.autofile.rules() }];
      if (req.method === "POST") { const b = await ctx.readJson(req); return [200, { rules: scout.autofile.save(b.rules) }]; }
      return null;
    }
    const parts = url.pathname.replace(/^\/api\/scout\/?/, "").split("/").filter(Boolean);
    if (!parts.length && req.method === "GET") return [200, { projects: scout.today() }];
    if (parts[0] === "find" && /^\d+$/.test(parts[1] ?? "") && req.method === "POST") {
      const id = Number(parts[1]);
      const b = parts[2] === "judge" ? await ctx.readJson(req) : {};
      if (parts[2] === "judge") return [200, { find: scout.judge(id, String(b.verdict ?? ""), String(b.note ?? "")) }];
      if (parts[2] === "file") return [200, { find: scout.file(id) }];
      if (parts[2] === "try") return [200, { find: sandbox.request(id) }];
      if (parts[2] === "approve") return [200, { find: sandbox.approve(id) }];
      if (parts[2] === "decline") return [200, { find: sandbox.decline(id) }];
      if (parts[2] === "run") return [200, { find: await sandbox.run(id) }];
      return null;
    }
    if (!/^\d+$/.test(parts[0] ?? "")) return null;
    const project = Number(parts[0]);
    if (parts.length === 1) {
      if (req.method === "POST") { const b = await ctx.readJson(req); scout.configure(project, b); }
      else if (req.method !== "GET") return null;
      const settings = scout.settings(project);
      return [200, { project, settings, on: !!settings?.on, counts: settings ? scout.counts(project) : null, last: scout.lastLook(project), sandbox: await sandbox.available() }];
    }
    if (parts[1] === "finds" && req.method === "GET") {
      const g = (k: string) => url.searchParams.get(k) ?? undefined;
      return [200, { finds: scout.catalog(project, { category: g("category"), verdict: g("verdict"), status: g("status"), trial: g("trial"), q: g("q") }), counts: scout.counts(project) }];
    }
    if (parts[1] === "week" && req.method === "GET") return [200, scout.week(project)];
    if (req.method !== "POST") return null;
    const b = await ctx.readJson(req);
    if (parts[1] === "look") { const r = await scout.look(project, { analyze: b.analyze !== false }); return [200, { look: r, counts: scout.counts(project) }]; }
    if (parts[1] === "inbox") return [200, { find: scout.addLink(project, String(b.url ?? ""), String(b.note ?? "")) }];
    if (parts[1] === "follow") return [200, { settings: scout.follow(project, { url: String(b.url ?? ""), name: b.name, note: b.note }) }];
    return null;
  } catch (e) {
    return [400, { error: (e as Error).message }];
  }
}
