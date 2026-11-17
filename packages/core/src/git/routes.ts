import type { IncomingMessage } from "node:http";
import type { GitManager } from "./manager.js";

/**
 * The git manager's API (docs/git.md). Every write is an event, so the Bridge sees it on the stream.
 *
 *   GET  /api/git/projects/:id                 where its code lives, verdict, merge policy, versions, the next version
 *   POST /api/git/projects/:id/publish         { name?, private? }   make a private GitHub repo and send the code
 *   POST /api/git/projects/:id/verdict         { verdict: continue|park|drop, why? }
 *   POST /api/git/projects/:id/policy          { mode: ask|auto }
 *   POST /api/git/projects/:id/watch           read the repo for outside work now
 *   POST /api/git/projects/:id/versions        { bump?, notes? }   cut the next version
 *   GET  /api/git/tickets/:id                  the last merge review of the ticket's PR
 *   POST /api/git/tickets/:id/check            review it again now
 *   POST /api/git/tickets/:id/merge            merge it (your press)
 *   POST /api/git/tickets/:id/not-right        { why? }   the merge was not right
 */
export async function gitRoute(ctx: { git: GitManager; readJson: (req: IncomingMessage) => Promise<any> }, req: IncomingMessage, url: URL): Promise<[number, unknown] | null> {
  const { git } = ctx;
  const parts = url.pathname.replace(/^\/api\/git\/?/, "").split("/").filter(Boolean);
  const id = Number(parts[1]);
  if (parts.length < 2 || !Number.isInteger(id)) return null;
  try {
    if (parts[0] === "projects") {
      if (req.method === "GET" && parts.length === 2) return [200, git.status(id)];
      if (req.method !== "POST" || parts.length !== 3) return null;
      const body = await ctx.readJson(req).catch(() => ({}));
      const by = typeof body.by === "string" ? body.by : "you";
      switch (parts[2]) {
        case "publish": return [200, await git.publish(id, { name: body.name, private: body.private !== false, by })];
        case "verdict": return [200, await git.verdict(id, body.verdict, String(body.why ?? ""), by)];
        case "policy": return [200, git.setPolicy(id, body.mode, by)];
        case "watch": return [200, { found: await git.watch(id), git: git.status(id) }];
        case "versions": return [200, { version: await git.cutVersion(id, { bump: body.bump, notes: body.notes, by }), git: git.status(id) }];
      }
      return null;
    }
    if (parts[0] === "tickets") {
      if (req.method === "GET" && parts.length === 2) return [200, { check: git.mergeCheck(id) }];
      if (req.method !== "POST" || parts.length !== 3) return null;
      const body = await ctx.readJson(req).catch(() => ({}));
      if (parts[2] === "check") return [200, { check: await git.check(id) }];
      if (parts[2] === "merge") return [200, { ticket: await git.merge(id, "you") }];
      if (parts[2] === "not-right") return [200, { git: git.notRight(id, String(body.why ?? "")) }];
    }
  } catch (e) {
    return [400, { error: (e as Error).message }];
  }
  return null;
}
