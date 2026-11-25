import type { EventLog } from "../events.js";
import type { TicketView } from "./model.js";
import type { OpenTicket } from "./shapes.js";
import { leftOfRun, nothingLeft, type LeftAtShip } from "../factory/leftover.js";

/**
 * A project keeps going after its first version. Until now a ticket in a project the factory built from an idea
 * started a whole new app (seven "Game Mastery" projects), and what a version left undone was forgotten when it
 * shipped. Now: work on such a project is the next version of the app it shipped, in the same folder
 * (shippedAppOf), and what a version left to do is the project's next ticket, asked for, so the crew goes on by
 * itself within the standing limit (fileLeft) until the product judge sees every requirement working.
 */

/** The newest build of this project that shipped an app of the factory's own (not a branch in a repo), or null. */
export function shippedAppOf(log: EventLog, project: number | null | undefined): number | null {
  if (project == null) return null;
  let rows: { id: number }[];
  try {
    rows = log.db.prepare("SELECT r.id AS id FROM factory_runs r JOIN project_links l ON l.kind = 'factory_run' AND l.ref = CAST(r.id AS TEXT) WHERE l.project_id = ? AND r.outcome = 'shipped' ORDER BY r.id DESC LIMIT 50").all(project) as { id: number }[];
  } catch { return null; }
  for (const r of rows) {
    const started = log.get(Number(r.id))?.payload as { kind?: string } | undefined;
    // A run that worked in an existing repo left a branch in a clone, not an app to build on.
    if (started && started.kind !== "repo") return Number(r.id);
  }
  return null;
}

interface Left {
  /** "you": the person pressed for it, so it is asked for even when the last version did not shorten the list. */
  by?: string;
  plan?: string; version?: string; baseRun?: number | null; judged?: number;
  unmet?: { id: string; text: string; evidence: string }[];
  notes?: { severity: string; text: string }[];
  features?: { id: string; title: string; why: string }[];
}

export interface GrowHost {
  log: EventLog;
  open(o: OpenTicket): TicketView;
  say(id: number, text: string, opts?: { status?: "ready"; by?: string; kind?: "note" | "reply" | "event" }): TicketView;
  edit(id: number, field: string, value: unknown, by?: string): TicketView;
}

const count = (l: Left) => (l.unmet?.length ?? 0) + (l.features?.length ?? 0) + (l.notes ?? []).filter((n) => n.severity === "high").length;

/**
 * The ticket for what a shipped version left to do, in its project. Asked for (the crew starts it by itself)
 * while each version brings the list down; when a version did not, the ticket waits for the person instead of
 * spending on a loop that is not converging.
 */
export function fileLeft(host: GrowHost, run: number, project: number | null, p: Left): TicketView | null {
  const unmet = p.unmet ?? [], notes = p.notes ?? [], features = p.features ?? [];
  if (project == null || count(p) === 0) return null;
  const name = p.plan ?? "the app", version = p.version ?? "the first version";
  // Counted the same way for both versions: the list v0.3.0 wrote down when it shipped had dropped what v0.1.0
  // left, so v0.4.0 (15 down to 9) read as "did not shorten the list".
  let before: Left | undefined;
  try { before = p.baseRun != null ? leftOfRun(host.log, p.baseRun) : undefined; } catch { before = undefined; }
  const converging = p.by === "you" || !before || count(p) < count(before);
  const parts = [unmet.length ? `${unmet.length} requirement${unmet.length === 1 ? "" : "s"}` : "", features.length ? `${features.length} feature${features.length === 1 ? "" : "s"}` : "", notes.length ? `${notes.length} note${notes.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
  const body = [
    `Run #${run} shipped ${version} of "${name}". This is what was not working or not built when it shipped. Build it into the same app as its next version.`,
    unmet.length ? `\n## Requirements the product judge did not see working (${unmet.length} of ${p.judged ?? unmet.length})\n\n${unmet.map((r) => `- ${r.id}${r.text ? `: ${r.text}` : ""}\n  What the judge saw: ${r.evidence || "nothing on any screen"}`).join("\n")}` : "",
    features.length ? `\n## Features of the plan that were not built\n\n${features.map((f) => `- ${f.id} ${f.title} (${f.why})`).join("\n")}` : "",
    notes.length ? `\n## Notes the Reviewer left on the code\n\n${notes.map((n) => `- (${n.severity}) ${n.text}`).join("\n")}` : "",
    `\nDone when: the product judge sees every requirement above working in the running app, every feature above is built, and each high note is fixed.`,
  ].filter(Boolean).join("\n");
  const t = host.open({
    kind: "request", title: `${name}: finish what ${version} left (${parts})`.slice(0, 200), body, project,
    by: "factory", source: "factory", fingerprint: `left:${run}`, asked: converging,
  });
  try { host.edit(t.id, "size", count(p) > 3 ? "M" : "S", "factory"); } catch { /* sized later */ }
  try {
    host.say(t.id, converging
      ? `Filed when ${version} shipped. It is the project's next version: the crew builds it on top of the app, by itself, within your standing limit.`
      : `Filed when ${version} shipped. The version before it left ${before ? count(before) : "as many"} things and this one left ${count(p)}, so the list is not getting shorter: the crew does not start this one by itself. Press Work it to try once more, or say what to change.`,
    { status: "ready", by: "factory", kind: "event" });
  } catch { /* stays open */ }
  return t;
}

/** Every build of this project that shipped an app of the factory's own, oldest first. */
function shippedApps(log: EventLog, project: number): number[] {
  let rows: { id: number }[] = [];
  try { rows = log.db.prepare("SELECT r.id AS id FROM factory_runs r JOIN project_links l ON l.kind = 'factory_run' AND l.ref = CAST(r.id AS TEXT) WHERE l.project_id = ? AND r.outcome = 'shipped' ORDER BY r.id").all(project) as { id: number }[]; } catch { /* projects not loaded */ }
  return rows.map((r) => Number(r.id)).filter((id) => (log.get(id)?.payload as { kind?: string } | undefined)?.kind !== "repo");
}

/**
 * Where a project stands, in one look: the version it is on, how much of what was designed the product judge
 * saw working, what is left, and who has it (the project's own ticket, and the run building it).
 */
export interface Standing extends LeftAtShip {
  run: number; version: string; plan: string; shippedAt: string | null; versions: { run: number; version: string; at: string | null; usd: number | null }[];
  working: number;
  /** Nothing the judge missed, no feature unbuilt, no high note. */
  done: boolean;
  ticket: { id: number; title: string; status: string; run: number | null; asked: boolean } | null;
}

const versionOf = (log: EventLog, run: number) => String((log.get(run)?.payload as { screen?: { tag?: string } } | undefined)?.screen?.tag ?? "v0.1.0");

export function standingOf(log: EventLog, project: number): Standing | null {
  const runs = shippedApps(log, project);
  const run = runs.at(-1);
  if (run == null) return null;
  const fin = (r: number) => log.db.prepare("SELECT finished_at AS at, total_usd AS usd, plan_name AS plan FROM factory_runs WHERE id = ?").get(r) as { at: string | null; usd: number | null; plan: string | null } | undefined;
  const left = leftOfRun(log, run);
  let ticket: Standing["ticket"] = null;
  try {
    const t = log.db.prepare("SELECT id, title, status, run FROM tickets WHERE fingerprint = ? ORDER BY id DESC LIMIT 1").get(`left:${run}`) as { id: number; title: string; status: string; run: number | null } | undefined;
    if (t) {
      const asked = log.list({ type: "ticket.asked", limit: 1e6 }).map((e) => e.payload as { id: number; on: boolean }).filter((a) => a.id === Number(t.id)).at(-1)?.on
        ?? !!(log.list({ type: "ticket.opened", limit: 1e6 }).map((e) => ({ id: e.id, ...(e.payload as { asked?: boolean; fingerprint?: string }) })).find((o) => o.fingerprint === `left:${run}`)?.asked);
      ticket = { id: Number(t.id), title: String(t.title), status: String(t.status), run: t.run != null ? Number(t.run) : null, asked: !!asked };
    }
  } catch { /* tickets not loaded */ }
  return {
    run, version: versionOf(log, run), plan: String(fin(run)?.plan ?? ""), shippedAt: fin(run)?.at ?? null,
    versions: runs.map((r) => ({ run: r, version: versionOf(log, r), at: fin(r)?.at ?? null, usd: fin(r)?.usd ?? null })),
    ...left, working: left.judged - left.unmet.length, done: nothingLeft(left), ticket,
  };
}

/**
 * Have the crew finish what the project's newest version left: writes the list down (factory.left), which files
 * the project's ticket for it. For versions that shipped before the list was kept, and for a list the crew
 * stopped working by itself. Returns why not, or null when it is filed.
 */
export function finishLeft(log: EventLog, project: number): string | null {
  const s = standingOf(log, project);
  if (!s) return "This project has no shipped app yet.";
  if (s.done) return "Nothing is left: the judge saw every requirement working and no high note is open.";
  if (s.ticket) return null;
  const baseRun = (log.get(s.run)?.payload as { screen?: { baseRun?: number } } | undefined)?.screen?.baseRun ?? null;
  log.append("factory.left", { run: s.run, plan: s.plan, version: s.version, baseRun, unmet: s.unmet, judged: s.judged, notes: s.notes, features: s.features, by: "you" });
  return null;
}
