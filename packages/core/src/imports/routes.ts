import type { IncomingMessage } from "node:http";
import type { EventLog } from "../events.js";
import { projectOf, registerProjectFacet } from "../projects/service.js";
import { registerImproveChange, registerImproveContext } from "../improve/council.js";
import { codeMapSummary, importDetail, importOf, latestMap, listImports, suggestionsOf, type RepoExplorer } from "./explorer.js";
import { REVIEW_MAX_USD, REVIEW_MIN_USD, latestReview, reviewBrief, type RepoReviewer } from "./review.js";

/**
 * The imports API. Every write is an event, so the Bridge sees it on the stream.
 *
 *   GET  /api/imports                     every imported repo with its health and suggestion count
 *   POST /api/imports                     { source, name?, maxUsd? }   a git URL, owner/name, or a folder path
 *   GET  /api/imports/:projectId          the import, newest code map, module notes, suggestions, exploration log
 *   POST /api/imports/:projectId/explore  { maxUsd? }   explore again (pull, rescan, map what changed)
 *   POST /api/imports/follow              { on }   keep imported repos current on their own (on by default)
 *
 * The deep review of an import (imports/review.ts):
 *
 *   GET    /api/imports/:projectId/review              the newest review, the verdict shown, what the owner said, the next steps
 *   POST   /api/imports/:projectId/review              { maxUsd? }   review the repo again, from the start
 *   POST   /api/imports/:projectId/review/update       rewrite the verdict with what the owner said since
 *   POST   /api/imports/:projectId/review/answers      { answers: [{ questionId, answer }] }   interview answers
 *   POST   /api/imports/:projectId/review/corrections  { about, was?, text }   one point the review got wrong
 *   DELETE /api/imports/:projectId/review/notes/:id    take back an answer or a correction
 *   GET    /api/imports/:projectId/review/brief        the brief as Markdown text
 *   POST   /api/imports/:projectId/review/brief        put the brief in the repo, on a branch of its own
 *   POST   /api/imports/review/settings                { maxUsd?, auto?, homeStack? }
 */
export async function importsRoute(
  ctx: { log: EventLog; explorer: RepoExplorer; reviewer?: RepoReviewer; readJson: (req: IncomingMessage) => Promise<Record<string, unknown>>; canImport?: () => string | null },
  req: IncomingMessage,
  url: URL,
): Promise<[number, unknown] | null> {
  const { log, explorer, reviewer } = ctx;
  const path = url.pathname;
  if (reviewer) { const r = await reviewRoute({ log, reviewer, readJson: ctx.readJson }, req, path); if (r) return r; }
  if (req.method === "GET" && path === "/api/imports") return [200, { imports: listImports(log), maxUsd: explorer.maxUsd, mode: explorer.mode(), follow: followView(explorer) }];
  if (req.method === "POST" && path === "/api/imports/follow") {
    const body = await ctx.readJson(req);
    if (typeof body.on !== "boolean") return [400, { error: "Say { on: true } or { on: false }." }];
    explorer.follow.on = body.on;
    log.append("settings.changed", { key: "importsFollow", value: body.on });
    return [200, followView(explorer)];
  }
  if (req.method === "POST" && path === "/api/imports") {
    const blocked = ctx.canImport?.();
    if (blocked) return [409, { error: blocked }];
    const body = await ctx.readJson(req);
    const r = explorer.importRepo(String(body.source ?? ""), { name: body.name ? String(body.name) : undefined, maxUsd: typeof body.maxUsd === "number" ? body.maxUsd : undefined });
    r.done.catch(() => {});
    // A repo seen for the first time is reviewed by itself once it is mapped ({ review: false } leaves that to a press).
    reviewer?.afterImport(r, { review: typeof body.review === "boolean" ? body.review : undefined, maxUsd: typeof body.reviewMaxUsd === "number" && body.reviewMaxUsd >= 0 ? body.reviewMaxUsd : undefined });
    return [202, { projectId: r.projectId, existing: r.existing }];
  }
  const m = path.match(/^\/api\/imports\/(\d+)(?:\/(explore))?$/);
  if (!m) return null;
  const id = Number(m[1]);
  if (req.method === "GET" && !m[2]) {
    const d = importDetail(log, id);
    return d ? [200, { ...d, busy: explorer.busy(id), maxUsd: explorer.maxUsd, mode: explorer.mode(), follow: followView(explorer) }] : [404, { error: `Project #${id} was not imported from a repo` }];
  }
  if (req.method === "POST" && m[2] === "explore") {
    if (!importOf(log, id)) return [404, { error: `Project #${id} was not imported from a repo` }];
    const body = await ctx.readJson(req);
    explorer.explore(id, { maxUsd: typeof body.maxUsd === "number" ? body.maxUsd : undefined }).catch(() => {});
    return [202, { projectId: id }];
  }
  return null;
}

async function reviewRoute(ctx: { log: EventLog; reviewer: RepoReviewer; readJson: (req: IncomingMessage) => Promise<Record<string, unknown>> }, req: IncomingMessage, path: string): Promise<[number, unknown] | null> {
  const { log, reviewer } = ctx;
  if (path === "/api/imports/review/settings") {
    if (req.method === "POST") {
      const b = await ctx.readJson(req);
      if (b.maxUsd !== undefined) {
        if (typeof b.maxUsd !== "number" || !(b.maxUsd >= REVIEW_MIN_USD && b.maxUsd <= REVIEW_MAX_USD)) return [400, { error: `The limit for one review is between $${REVIEW_MIN_USD.toFixed(2)} and $${REVIEW_MAX_USD.toFixed(2)}.` }];
        reviewer.maxUsd = Number(b.maxUsd.toFixed(2));
        log.append("settings.changed", { key: "importReviewMaxUsd", value: reviewer.maxUsd });
      }
      if (typeof b.auto === "boolean") { reviewer.auto = b.auto; log.append("settings.changed", { key: "importReviewAuto", value: b.auto }); }
      if (typeof b.homeStack === "string") { reviewer.homeStack = b.homeStack.trim().slice(0, 600); log.append("settings.changed", { key: "importHomeStack", value: reviewer.homeStack }); }
    }
    return [200, reviewer.settings()];
  }
  const m = path.match(/^\/api\/imports\/(\d+)\/review(?:\/(update|answers|corrections|brief|notes)(?:\/(\d+))?)?$/);
  if (!m) return null;
  const id = Number(m[1]);
  if (!importOf(log, id)) return [404, { error: `Project #${id} was not imported from a repo` }];
  const sub = m[2];
  try {
    if (!sub && req.method === "GET") return [200, reviewer.detail(id)];
    if (!sub && req.method === "POST") {
      if (reviewer.busy(id)) return [409, { error: "This repo is being reviewed right now." }];
      const b = await ctx.readJson(req);
      reviewer.review(id, { maxUsd: typeof b.maxUsd === "number" && b.maxUsd >= 0 ? b.maxUsd : undefined, trigger: "manual" }).catch(() => {});
      return [202, { projectId: id }];
    }
    if (sub === "update" && req.method === "POST") {
      if (reviewer.busy(id)) return [409, { error: "This repo is being reviewed right now." }];
      if (!latestReview(log, id, { withVerdict: true })) return [409, { error: "There is no verdict to update yet: press Review this repo first." }];
      const b = await ctx.readJson(req);
      reviewer.update(id, { maxUsd: typeof b.maxUsd === "number" && b.maxUsd >= 0 ? b.maxUsd : undefined }).catch(() => {});
      return [202, { projectId: id }];
    }
    if (sub === "answers" && req.method === "POST") {
      const b = await ctx.readJson(req);
      const answers = (Array.isArray(b.answers) ? b.answers : []).map((a: any) => ({ questionId: String(a?.questionId ?? ""), answer: String(a?.answer ?? "") }));
      return [200, { notes: reviewer.answer(id, answers) }];
    }
    if (sub === "corrections" && req.method === "POST") {
      const b = await ctx.readJson(req);
      return [200, { notes: reviewer.correct(id, { about: String(b.about ?? ""), was: b.was ? String(b.was) : undefined, text: String(b.text ?? "") }) }];
    }
    if (sub === "notes" && m[3] && req.method === "DELETE") return [200, { notes: reviewer.removeNote(id, Number(m[3])) }];
    if (sub === "brief" && req.method === "GET") {
      const r = latestReview(log, id, { withVerdict: true });
      return r?.brief ? [200, { brief: r.brief, path: reviewer.detail(id)!.briefPath }] : [404, { error: "There is no brief yet." }];
    }
    if (sub === "brief" && req.method === "POST") return [200, await reviewer.saveBrief(id)];
  } catch (e) { return [400, { error: (e as Error).message }]; }
  return null;
}

const followView = (x: RepoExplorer) => ({ ...x.follow, spentTodayUsd: x.followSpentUsd() });

// Every imported project's detail carries its code facts.
registerProjectFacet({
  id: "code",
  compute(log, project) {
    const imp = importOf(log, project.id);
    if (!imp) return null;
    const m = latestMap(log, project.id);
    const s = suggestionsOf(log, project.id);
    return {
      source: imp.source, local: imp.local, dir: imp.dir, branch: imp.branch, head: imp.head, status: imp.status, spentUsd: imp.spentUsd,
      files: m?.map.files ?? null, lines: m?.map.lines ?? null, modules: m?.map.modules.length ?? null, health: m?.map.health.score ?? null,
      suggestions: s.length, openSuggestions: s.filter((x) => x.status === "pending" || x.status === "proposed").length,
      ...reviewFacet(log, project.id),
    };
  },
});

/** The review's share of a project's code facts: its state and its call, for the tab's badge and the project's home. */
function reviewFacet(log: EventLog, projectId: number) {
  const r = latestReview(log, projectId);
  if (!r) return { review: null };
  const v = r.verdict ?? latestReview(log, projectId, { withVerdict: true })?.verdict ?? null;
  const pending = Number((log.db.prepare("SELECT count(*) AS n FROM repo_review_notes WHERE project_id = ? AND applied IS NULL").get(projectId) as { n: number }).n);
  return { review: { status: r.status, call: v?.recommendation.call ?? null, headline: v?.headline ?? null, questions: v?.questions.length ?? 0, pending, scores: v ? { codeHealth: v.scores.codeHealth.score, goalFit: v.scores.goalFit.score, costToFix: v.scores.costToFix.score } : null } };
}

// The Improvement Council's lenses read the code map of an imported project before they propose anything.
// A project target may carry the project id or its Order Engine root node id; both find the import.
registerImproveContext("code-map", (log, t) => {
  if (t.kind !== "project" || t.id == null) return null;
  return codeMapSummary(log, Number(t.id)) ?? (() => { const p = projectOf(log, { kind: "order_node", ref: t.id }); return p == null ? null : codeMapSummary(log, p); })();
});
// ...and what the review found the app to be, so a lens proposes for this app and not for any codebase.
registerImproveContext("repo-review", (log, t) => {
  if (t.kind !== "project" || t.id == null) return null;
  const direct = reviewBrief(log, Number(t.id), 1800);
  if (direct) return direct.trim();
  const p = projectOf(log, { kind: "order_node", ref: t.id });
  return p == null ? null : reviewBrief(log, p, 1800).trim() || null;
});

// A new understanding of the code (an exploration that mapped something) counts as a change, so the
// Council looks at an imported project again after its repo moved, not only every two weeks.
registerImproveChange("code-map", (log, projectId) => {
  const r = log.db.prepare(`SELECT max(ts) AS t FROM events WHERE type = 'repo.explore.finished'
    AND json_extract(payload, '$.projectId') = ? AND json_extract(payload, '$.outcome') IN ('done', 'partial')`).get(projectId) as { t: string | null } | undefined;
  return r?.t ?? null;
});
