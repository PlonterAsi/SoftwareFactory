import type { EventLog } from "../events.js";
import { TICKET_SEVERITIES, type TicketSeverity } from "./model.js";

/**
 * Auto-file rules (docs/scout.md, "Auto-file rules"): your settings for which suggestions become tickets by
 * themselves. A suggestion that meets every condition of a rule that is on is filed; the rest wait as
 * proposals you confirm with one press. A rule can also make what it files ready, so the crew picks it up
 * within its usual caps and the monthly budget.
 *
 * Any part of SF that suggests work can hand a candidate to `match`. Scout does for every rated find; the
 * watchers do for the tickets they open (a rule that matches one of theirs can only make it ready, since a
 * watcher files every finding anyway).
 *
 * A condition the candidate has nothing for does not match: a rule "under 20 minutes" never files a
 * suggestion with no estimate. Rules are stored as events (`autofile.rules`), the newest list wins.
 */
export const AUTOFILE_SOURCES = ["scout", "watcher"] as const;
export type AutoFileSource = (typeof AUTOFILE_SOURCES)[number];
export const VERDICTS = ["use", "adapt", "build", "skip"] as const;
export type ScoutVerdict = (typeof VERDICTS)[number];
export const RISKS = ["read-only", "low", "medium", "high"] as const;
export type Risk = (typeof RISKS)[number];

export interface AutoFileRule {
  id: string;
  name: string;
  on: boolean;
  /** Which suggestions it looks at. */
  sources: AutoFileSource[];
  /** One project's suggestions, or every project's (null). */
  projectId: number | null;
  /** Estimated time to do it, at most this many minutes. */
  maxMinutes?: number;
  /** Estimated cost to do it, at most this many dollars. */
  maxUsd?: number;
  /** Severity at or above (blocking > annoying > cosmetic). */
  minSeverity?: TicketSeverity;
  /** Scout's verdicts it accepts. */
  verdicts?: ScoutVerdict[];
  /** Scout's overall score (1 to 5), at least. */
  minScore?: number;
  /** Risk level at most. */
  maxRisk?: Risk;
  /** Scout categories it accepts. */
  categories?: string[];
  /** Also make the ticket ready, so the crew picks it up (within its caps and the monthly budget). */
  makeReady?: boolean;
}

export interface AutoFileCandidate {
  source: AutoFileSource;
  projectId: number | null;
  minutes?: number | null;
  usd?: number | null;
  severity?: TicketSeverity | null;
  verdict?: ScoutVerdict | null;
  score?: number | null;
  risk?: Risk | null;
  category?: string | null;
}

/** Shipped with Scout: a rated find that is safe, quick and cheap to adopt is filed by itself. Not ready. */
export const DEFAULT_RULES: AutoFileRule[] = [
  { id: "scout-quick-wins", name: "Quick, cheap, safe finds to use", on: true, sources: ["scout"], projectId: null, verdicts: ["use"], maxRisk: "medium", maxUsd: 5, maxMinutes: 20, makeReady: false },
];

const sevRank = (s: TicketSeverity) => TICKET_SEVERITIES.length - TICKET_SEVERITIES.indexOf(s); // blocking highest
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Why a candidate fails a rule, or null when it meets every condition. */
export function failsRule(r: AutoFileRule, c: AutoFileCandidate): string | null {
  if (!r.on) return "the rule is off";
  if (!r.sources.includes(c.source)) return `it does not look at ${c.source} suggestions`;
  if (r.projectId != null && r.projectId !== c.projectId) return "another project's rule";
  if (r.maxMinutes != null) { const m = num(c.minutes); if (m == null) return "no time estimate"; if (m > r.maxMinutes) return `about ${m} minutes, over ${r.maxMinutes}`; }
  if (r.maxUsd != null) { const u = num(c.usd); if (u == null) return "no cost estimate"; if (u > r.maxUsd) return `about $${u.toFixed(2)}, over $${r.maxUsd}`; }
  if (r.minSeverity) { if (!c.severity) return "no severity"; if (sevRank(c.severity) < sevRank(r.minSeverity)) return `${c.severity}, below ${r.minSeverity}`; }
  if (r.verdicts?.length) { if (!c.verdict || !r.verdicts.includes(c.verdict)) return `verdict ${c.verdict ?? "none"}`; }
  if (r.minScore != null) { const s = num(c.score); if (s == null) return "no score"; if (s < r.minScore) return `score ${s.toFixed(1)}, under ${r.minScore}`; }
  if (r.maxRisk) { if (!c.risk) return "no risk level"; if (RISKS.indexOf(c.risk) > RISKS.indexOf(r.maxRisk)) return `${c.risk} risk, above ${r.maxRisk}`; }
  if (r.categories?.length) { if (!c.category || !r.categories.includes(c.category)) return `category ${c.category ?? "none"}`; }
  return null;
}

function cleanRule(x: any, i: number): AutoFileRule {
  const name = String(x?.name ?? "").trim().slice(0, 80);
  if (!name) throw new Error(`Rule ${i + 1} needs a name.`);
  const sources = (Array.isArray(x.sources) ? x.sources : ["scout"]).filter((s: string) => (AUTOFILE_SOURCES as readonly string[]).includes(s));
  if (!sources.length) throw new Error(`Rule "${name}" needs at least one source (scout or watcher).`);
  const pos = (v: unknown, what: string, max: number) => {
    if (v === undefined || v === null || v === "") return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || n > max) throw new Error(`Rule "${name}": ${what} must be a number above 0 and at most ${max}.`);
    return n;
  };
  const r: AutoFileRule = {
    id: String(x.id ?? "").trim().slice(0, 40) || `rule-${Date.now().toString(36)}-${i}`,
    name, on: x.on !== false, sources,
    projectId: x.projectId == null || x.projectId === "" ? null : Number(x.projectId),
  };
  if (r.projectId != null && !Number.isInteger(r.projectId)) throw new Error(`Rule "${name}": the project is a project's number.`);
  const mm = pos(x.maxMinutes, "minutes", 60 * 24 * 7); if (mm) r.maxMinutes = mm;
  const mu = pos(x.maxUsd, "dollars", 1000); if (mu) r.maxUsd = mu;
  const ms = pos(x.minScore, "the score", 5); if (ms) r.minScore = ms;
  if (x.minSeverity) { if (!TICKET_SEVERITIES.includes(x.minSeverity)) throw new Error(`Rule "${name}": severity is blocking, annoying or cosmetic.`); r.minSeverity = x.minSeverity; }
  if (Array.isArray(x.verdicts) && x.verdicts.length) r.verdicts = x.verdicts.filter((v: string) => (VERDICTS as readonly string[]).includes(v));
  if (x.maxRisk) { if (!(RISKS as readonly string[]).includes(x.maxRisk)) throw new Error(`Rule "${name}": risk is read-only, low, medium or high.`); r.maxRisk = x.maxRisk; }
  if (Array.isArray(x.categories) && x.categories.length) r.categories = x.categories.map(String).slice(0, 20);
  if (x.makeReady === true) r.makeReady = true;
  return r;
}

export class AutoFile {
  constructor(private log: EventLog) {}

  rules(): AutoFileRule[] {
    const row = this.log.db.prepare("SELECT payload FROM events WHERE type = 'autofile.rules' ORDER BY id DESC LIMIT 1").get() as { payload: string } | undefined;
    if (!row) return DEFAULT_RULES.map((r) => ({ ...r }));
    return (JSON.parse(row.payload) as { rules: AutoFileRule[] }).rules;
  }

  /** Replace the whole list (the settings screen saves it whole). */
  save(rules: unknown, by = "you"): AutoFileRule[] {
    if (!Array.isArray(rules)) throw new Error("Send the rules as a list.");
    if (rules.length > 40) throw new Error("At most 40 rules.");
    const clean = rules.map(cleanRule);
    const ids = new Set<string>();
    for (const r of clean) { if (ids.has(r.id)) throw new Error(`Two rules share the id "${r.id}".`); ids.add(r.id); }
    this.log.append("autofile.rules", { rules: clean, by });
    return clean;
  }

  /** The first rule a candidate meets, or null, with why each rule that is on did not match. */
  match(c: AutoFileCandidate): { rule: AutoFileRule | null; misses: { rule: string; why: string }[] } {
    const misses: { rule: string; why: string }[] = [];
    for (const r of this.rules()) {
      const why = failsRule(r, c);
      if (!why) return { rule: r, misses };
      if (r.on && r.sources.includes(c.source)) misses.push({ rule: r.name, why });
    }
    return { rule: null, misses };
  }
}
