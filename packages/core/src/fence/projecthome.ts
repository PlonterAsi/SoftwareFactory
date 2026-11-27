/**
 * Projects (docs/fence.md, "Projects on one screen").
 *
 * A project is one product on GitHub that SoftwareFactory works on. Each has a card: its starting branch, what
 * prepares it, its checks, a name of your own, and whether it sleeps. One project is the chosen one: new tickets go
 * to it and the Settings fields speak for it. Tickets of every awake project are worked from the one queue. On the
 * screen each project is one colour and one sentence, read from where its tickets stand.
 */
import { parseGitHubRepo } from "../tickets/github.js";

export interface ProjectCard {
  /** owner/name on GitHub. */
  repo: string;
  /** Your own name for it. Empty: the GitHub name is shown. */
  name: string;
  base: string;
  checks: string[];
  prepare: string[];
  /** A sleeping project keeps its tickets, and none of them is worked. */
  asleep: boolean;
}
export interface ProjectSettings { projects: ProjectCard[]; maxProjects: number }
export const PROJECT_DEFAULTS: ProjectSettings = { projects: [], maxProjects: 30 };

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/;
const lines = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, 40) : []);

/** The cards as they may be kept. A sentence says what is wrong. */
export function cleanProjects(raw: unknown, from: ProjectCard[], max: number): ProjectCard[] {
  if (raw === undefined) return from;
  if (!Array.isArray(raw)) throw new Error("The projects must be a list.");
  if (raw.length > max) throw new Error(`There can be up to ${max} projects (Settings, "The most projects").`);
  const seen = new Set<string>();
  return raw.map((x) => {
    const r = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const got = parseGitHubRepo(typeof r.repo === "string" ? r.repo.trim() : "");
    if (!got) throw new Error(`"${String(r.repo ?? "").slice(0, 80)}" is not a project on GitHub. Write it as owner/name.`);
    const repo = `${got.owner}/${got.name}`, key = repo.toLowerCase();
    if (seen.has(key)) throw new Error(`${repo} is on the list twice.`);
    seen.add(key);
    const base = typeof r.base === "string" ? r.base.trim() : "";
    if (base && (!BRANCH.test(base) || base.includes("..") || /^(HEAD|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD)$/.test(base))) throw new Error(`"${base.slice(0, 80)}" is not a branch name.`);
    return { repo, name: typeof r.name === "string" ? r.name.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 60) : "", base, checks: lines(r.checks), prepare: lines(r.prepare), asleep: r.asleep === true };
  });
}

export interface Chosen { repo: string; base: string; checks: string[]; prepare: string[] }
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Every project there is: the cards, with the chosen one's fields taken from Settings, where they are edited. */
export function projectList(s: Chosen & ProjectSettings): ProjectCard[] {
  const chosen = parseGitHubRepo(s.repo) ? s.repo : "";
  const out = s.projects.map((c) => (chosen && same(c.repo, chosen) ? { ...c, base: s.base, checks: s.checks, prepare: s.prepare } : c));
  if (chosen && !out.some((c) => same(c.repo, chosen))) out.unshift({ repo: chosen, name: "", base: s.base, checks: s.checks, prepare: s.prepare, asleep: false });
  return out;
}
export const cardOf = (s: Chosen & ProjectSettings, project: string | null): ProjectCard | null => projectList(s).find((c) => same(c.repo, project ?? "")) ?? null;

export type Colour = "red" | "amber" | "green" | "blue" | "grey";
export interface ProjectLight { repo: string; name: string; chosen: boolean; asleep: boolean; colour: Colour; says: string; open: number }
export interface LightTicket { project: string | null; state: string; removed: boolean; canRelease?: boolean }

const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

/**
 * One colour and one sentence for each project. What waits for the owner comes first, then what did not finish,
 * then what is ready, then what is being worked. The sentence names the first of these and counts the rest.
 */
export function projectLights(cards: ProjectCard[], chosen: string, tickets: LightTicket[], running: string[] = []): ProjectLight[] {
  return cards.map((c) => {
    const mine = tickets.filter((t) => !t.removed && same(t.project ?? "", c.repo));
    const count = (...states: string[]) => mine.filter((t) => states.includes(t.state)).length;
    const yours = count("asked") + mine.filter((t) => t.state === "held" && t.canRelease).length;
    const unfinished = count("failed its checks", "parked", "crashed", "not started", "interrupted", "split") + mine.filter((t) => t.state === "held" && !t.canRelease).length;
    const ready = count("proposed"), waiting = count("waiting"), working = count("working") + running.filter((r) => same(r, c.repo)).length;
    const parts: string[] = [];
    if (yours) parts.push(`${n(yours, "ticket waits", "tickets wait")} for your word`);
    if (unfinished) parts.push(`${n(unfinished, "ticket", "tickets")} did not finish`);
    if (ready) parts.push(`${n(ready, "result is", "results are")} ready for you`);
    if (working) parts.push(`${n(working, "ticket is", "tickets are")} being worked`);
    if (waiting) parts.push(`${n(waiting, "ticket waits its", "tickets wait their")} turn`);
    const colour: Colour = c.asleep ? "grey" : yours ? "red" : unfinished ? "amber" : ready ? "green" : working || waiting ? "blue" : "grey";
    const open = yours + unfinished + ready + working + waiting;
    const says = c.asleep ? `Asleep${open ? `: ${n(open, "ticket", "tickets")} kept, none is worked` : ""}.` : parts.length ? `${parts.join("; ")}.`.replace(/^./, (x) => x.toUpperCase()) : "Nothing open.";
    return { repo: c.repo, name: c.name, chosen: same(c.repo, chosen), asleep: c.asleep, colour, says, open };
  });
}
