import type { IncomingMessage } from "node:http";
import type { EventLog } from "../events.js";
import { monthReport, setMonthBudget } from "./spend.js";
import { WATCHER_KINDS, type WatcherKind, type Watchers } from "./watchers.js";

/**
 * Watchers and monthly budgets (docs/watchers.md).
 *
 *   GET  /api/watchers?project=ID                    the project's watchers: settings, last look, next look
 *   POST /api/watchers/:project/:kind     { on?, everyHours? }
 *   POST /api/watchers/:project/:kind/run           look now (free; only opens tickets)
 *   GET  /api/budget/month[?project=ID]              this month: budget, spent, burn rate, where it ends
 *   POST /api/budget/month                { projectId: number | null, usd: number | null }
 */
export async function watchRoute(ctx: { log: EventLog; watchers: Watchers; readJson: (req: IncomingMessage) => Promise<any> }, req: IncomingMessage, url: URL): Promise<[number, unknown] | null> {
  const { log, watchers } = ctx;
  try {
    if (url.pathname === "/api/budget/month") {
      if (req.method === "GET") { const p = url.searchParams.get("project"); return [200, monthReport(log, p ? Number(p) : null)]; }
      if (req.method === "POST") {
        const b = await ctx.readJson(req);
        const pid = b.projectId == null || b.projectId === "" ? null : Number(b.projectId);
        if (pid != null && !Number.isInteger(pid)) return [400, { error: "projectId is a project's number, or null for everything" }];
        return [200, setMonthBudget(log, pid, b.usd)];
      }
      return null;
    }
    const parts = url.pathname.replace(/^\/api\/watchers\/?/, "").split("/").filter(Boolean);
    if (req.method === "GET" && !parts.length) {
      const p = Number(url.searchParams.get("project"));
      if (!Number.isInteger(p)) return [400, { error: "Say which project: ?project=ID" }];
      return [200, { project: p, watchers: watchers.state(p) }];
    }
    if (req.method === "POST" && parts.length >= 2 && /^\d+$/.test(parts[0])) {
      const project = Number(parts[0]);
      const kind = parts[1] as WatcherKind;
      if (!WATCHER_KINDS.includes(kind)) return [404, { error: `There is no "${parts[1]}" watcher.` }];
      if (parts[2] === "run") { const r = await watchers.run(project, kind); return [200, { ...r, watchers: watchers.state(project) }]; }
      if (parts.length === 2) { const b = await ctx.readJson(req); watchers.set(project, kind, b); return [200, { watchers: watchers.state(project) }]; }
    }
    return null;
  } catch (e) {
    return [400, { error: (e as Error).message }];
  }
}
