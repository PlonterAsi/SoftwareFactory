import { BUG_FIX_FLOW, NEW_PROJECT_FLOW, REPO_CHANGE_FLOW, RESEARCH_FLOW, SMALL_CHANGE_FLOW, runnerOf, type FlowDef, type FlowRunner } from "../flows/flow.js";
import type { FlowLibrary } from "../flows/library.js";
import type { WorkRoute } from "../factory/route.js";
import { profileFlow } from "../configs/profiles.js";

/**
 * Which flow a ticket follows (phase 2 of the SF behavior brief: one flow per kind of work).
 *
 *   you picked one       that one, whatever its kind (a Refactor flow on a task, the engine on a bug)
 *   a question           Research or question: a reader answers, nothing changes
 *   in a repo, light     the session flow that serves its kind (Bug fix for a bug, Small change otherwise)
 *   in a repo, engine    the engine flow that serves its kind (Feature in a repo)
 *   no repo              New project: the engine builds the app's next version
 *
 * "Serves its kind" reads each flow's `kinds`, so a flow you save for a kind takes over from the built-in one.
 */
export interface FlowPick { flow: FlowDef; why: string; chosen: boolean }

export function pickFlow(lib: FlowLibrary, t: { kind: string; flow?: string | null; id?: number; project?: number | null }, o: { repo: boolean; route?: WorkRoute | null; routeChosen?: boolean }): FlowPick {
  if (t.flow) {
    const f = lib.get(t.flow);
    if (!f) throw new Error(`This ticket names the flow "${t.flow}", which no longer exists. Pick another on the ticket.`);
    return { flow: f, why: `you picked the ${f.name} flow`, chosen: true };
  }
  // A configuration profile can pick the flow for a kind of ticket (configs/profiles.ts, "flow.<kind>").
  const viaProfile = profileFlow(lib, t);
  const pf = viaProfile ? lib.get(viaProfile) : null;
  if (pf) return { flow: pf, why: `the configuration profile picks the ${pf.name} flow for a ${t.kind}`, chosen: true };
  const serving = (runner: FlowRunner, fallback: FlowDef): FlowDef => {
    const own = lib.list().filter((s) => s.runner === runner && s.kinds.includes(t.kind)).map((s) => lib.get(s.id)!).filter(Boolean);
    return own.find((f) => !f.builtIn) ?? own[0] ?? lib.get(fallback.id) ?? fallback;
  };
  if (t.kind === "question" && !o.routeChosen) return { flow: serving("answer", RESEARCH_FLOW), why: "a question is answered, nothing is changed", chosen: false };
  if (!o.repo) return { flow: lib.get(NEW_PROJECT_FLOW.id) ?? NEW_PROJECT_FLOW, why: "no repo: the engine builds the next version", chosen: false };
  if (o.route === "engine") return { flow: serving("engine", REPO_CHANGE_FLOW), why: "feature-sized: the whole engine in the repo", chosen: false };
  return { flow: serving("session", t.kind === "bug" ? BUG_FIX_FLOW : SMALL_CHANGE_FLOW), why: "one session's work in the repo", chosen: false };
}

/** The route a picked flow takes in a repo. */
export const routeOfFlow = (f: FlowDef): WorkRoute | "answer" => (runnerOf(f) === "engine" ? "engine" : runnerOf(f) === "answer" ? "answer" : "light");
