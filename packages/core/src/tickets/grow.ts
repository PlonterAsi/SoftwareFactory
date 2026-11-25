import type { EventLog } from "../events.js";
import type { TicketView } from "./model.js";
import type { OpenTicket } from "./shapes.js";

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
  const before = p.baseRun != null
    ? host.log.list({ type: "factory.left", limit: 1e6 }).map((e) => e.payload as Left & { run?: number }).filter((x) => x.run === p.baseRun).at(-1)
    : undefined;
  const converging = !before || count(p) < count(before);
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
