import { isSmallJob } from "./council.js";
import { aKind } from "../tickets/model.js";

/**
 * Which way work in an existing codebase goes (Assaf, 14 Nov 2026: "SF needs several entry points, and not
 * all of them trigger the full pipeline").
 *
 * Work comes in through many doors: a new project, a feature for an app that shipped, a bug, a small task,
 * a question, a request. A typo fix does not need a Council, product documents and a judge; a feature does.
 * So an intake step reads what came in and sends it down the route that fits, running only the stations
 * that route needs:
 *
 *   light   one Builder session in a clone, the checks, a Reviewer on the diff (tickets/repowork.ts).
 *           For a bug, a task, a small ask. Cents.
 *   engine  the whole engine in the clone (factory/reporun.ts): the change designed and criticised, a plan
 *           you approve, built one feature per session, reviewed by running it, judged on the running site.
 *           For a feature, a request, anything sized L. Dollars.
 *
 * It is a word and size check: free, instant, and said out loud (`why`) wherever it decides, so the person
 * can always send the work the other way.
 */
export type WorkRoute = "light" | "engine";
export interface Routed { route: WorkRoute; why: string; /** The person chose it; nothing was guessed. */ chosen?: boolean }

/** Kinds of ticket that fix or finish something that exists: one session's work unless sized large. */
const FIX_KINDS = new Set(["bug", "task", "question"]);

export function routeWork(x: { kind?: string | null; size?: string | null; text: string; /** What the person picked, when they did. */ asked?: WorkRoute | null; /** The most this work may spend, when that is already decided. */ maxUsd?: number; /** What an engine run needs at least. */ engineMinUsd?: number }): Routed {
  if (x.asked === "light" || x.asked === "engine") return { route: x.asked, why: "you chose this route", chosen: true };
  const min = x.engineMinUsd ?? 1.5;
  if (x.maxUsd != null && x.maxUsd < min) return { route: "light", why: `its limit of $${x.maxUsd.toFixed(2)} is under the $${min.toFixed(2)} an engine run needs` };
  const kind = x.kind ?? null;
  if (x.size === "L") return { route: "engine", why: "sized L: more than one session's work, so it is designed and planned first" };
  if (kind && FIX_KINDS.has(kind)) return { route: "light", why: `${aKind(kind)}${x.size ? ` sized ${x.size}` : ""}: one session in the repo` };
  if (x.size === "S") return { route: "light", why: "sized S: one session in the repo" };
  if (x.size === "M") return { route: "engine", why: `${kind ? aKind(kind) : "a piece of work"} sized M: designed and planned before it is built` };
  const small = isSmallJob(x.text);
  return small.small ? { route: "light", why: `${small.why}: one session in the repo` } : { route: "engine", why: `${kind ? aKind(kind) : "an ask"} of ${small.why}: feature-sized, so it is designed and planned first` };
}

/**
 * The doors an ask comes through before any route (Assaf, 14 Nov 2026: "several entry points"). Free, words only.
 *
 *   question  "why does the login fail?", "find out which pages are slow": a reader answers it on a question
 *             ticket and nothing changes (cents, no branch).
 *   reloop    "another round on this", "re-loop the project": a reader reviews the project as it stands and
 *             files what it finds as small tickets under an epic of the round; the crew works them like any.
 *   work      anything else: a ticket on the light or engine route (routeWork).
 */
export type IntakeDoor = "question" | "reloop" | "work";

const RELOOP_WORDS = /\b(re-?loop|another (round|pass|loop|iteration)|one more (round|pass|loop)|loop (it |this )?(again|once more)|go (over|through) it again|run (the )?(improvement )?loop again|improve (it|this|the (app|project|site|code|repo)) (again|further|more)|another improvement (round|pass)|next improvement round)\b/i;
/** Openers that ask for an answer, whatever follows: "why", "how does", "find out". */
const ASKS_ANSWER = /^(why|what|how|where|which|who|when|explain|tell me|find out|figure out|look into|investigate|check (whether|if)|is there|are there|do we|does (it|the|this))\b/i;
/** Openers that may be a polite request ("can you add..."): an answer only when no change is asked. */
const MAYBE_ASK = /^(can|could|would|should|will|is|are|do|does|did|has|have|was|were)\b/i;
const CHANGE_WORDS = /\b(add|build|make|create|implement|fix|change|remove|rename|replace|write|update|move|delete|refactor|redesign|improve|support|turn|set up|install|upgrade)\b/i;

export function intakeDoor(text: string): { door: IntakeDoor; why: string } {
  const t = String(text ?? "").trim();
  if (RELOOP_WORDS.test(t)) return { door: "reloop", why: "another round on what exists: a reader reviews it and files what it finds as small tickets" };
  const first = t.split(/\n/)[0].trim();
  if (ASKS_ANSWER.test(first) && !(/^(what|how) (if|about)\b/i.test(first) && CHANGE_WORDS.test(first))) return { door: "question", why: "a question: a reader answers it, nothing is changed" };
  if (MAYBE_ASK.test(first) && first.endsWith("?") && !CHANGE_WORDS.test(first)) return { door: "question", why: "a question: a reader answers it, nothing is changed" };
  return { door: "work", why: "work to do" };
}
