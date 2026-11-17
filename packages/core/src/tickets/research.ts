import type { EventLog } from "../events.js";
import { runAgent } from "../agents.js";
import type { AgentRuntime } from "../runtime.js";
import type { AgentBay } from "../bay/bay.js";
import { RESEARCH_FLOW, crewPick, stepsToRun, type FlowDef } from "../flows/flow.js";
import { branchFor, overviewBlock, prepareClone, repoGuidance, type RepoRef } from "./repowork.js";

/**
 * The Research or question flow (runner "answer"): a reader goes through the repo, read-only, and answers the
 * ticket in plain words, naming the files it read. Nothing is written, no branch is pushed, no PR is opened:
 * the clone it reads is SF's own copy. Without a repo it answers from the ticket and what the project knows.
 */
export const RESEARCH_CONTRACT = [
  "Station contract: research. You answer one question about a project. You may only read: change no file.",
  "Answer in plain words a non-programmer can follow, in at most 20 lines: the answer first, then what it rests on.",
  "End with one line `Files read: a, b, c` (or `Files read: none`).",
].join("\n");

export interface AnswerResult { ok: boolean; text: string; files: string[]; costUsd: number; error?: string }

export async function answerTicket(log: EventLog, runtime: AgentRuntime, bay: AgentBay | undefined, o: {
  id: number; key: string; title: string; document: string; repo: RepoRef | null; workRoot: string; maxUsd: number; projectId?: number | null; flow?: FlowDef;
  git?: (dir: string, ...args: string[]) => string;
}): Promise<AnswerResult> {
  const flow = o.flow ?? RESEARCH_FLOW;
  const reader = bay?.crewFor("survey", crewPick(flow, "survey"))[0];
  const step = (name: string, state: "running" | "passed" | "failed" | "skipped", note = "") =>
    log.append("ticket.step", { id: o.id, key: o.key, step: name, state, note: note.slice(0, 500) });
  let dir: string | null = null;
  let text = "";
  let costUsd = 0;
  for (const s of stepsToRun(flow)) {
    if (s.action === "orient") {
      if (!o.repo) { step("orient", "skipped", "no repo: answered from the ticket and its project"); continue; }
      // SF's own clone, on a local branch nobody pushes: the reader's tools cannot write, and nothing leaves it.
      dir = prepareClone(o.repo, o.workRoot, o.id, branchFor(o.key, o.title), o.git, `ask-${o.id}`).dir;
      step("orient", "passed", "a clone to read");
    } else if (s.action === "answer") {
      step("answer", "running");
      const run = await runAgent(log, runtime, reader?.id ?? "surveyor", {
        prompt: `${o.document}${dir ? `\n\nYou are in a read-only copy of ${o.repo!.source}.${repoGuidance(dir)}${overviewBlock(log, o.projectId)}` : overviewBlock(log, o.projectId)}`,
        model: reader?.model ?? "sonnet",
        systemPrompt: `${reader?.role.split("Station contract:")[0].trim() || "You are the Surveyor: you read code and explain it."}${flow.brief ? `\n\n${flow.brief}` : ""}\n\n${RESEARCH_CONTRACT}`,
        budgetUsd: Math.min(o.maxUsd, reader?.budgetUsd ?? o.maxUsd),
        tools: dir ? ["Read", "Glob", "Grep"] : [],
        ...(dir ? { cwd: dir } : {}),
        timeoutMs: 10 * 60_000,
      }, { agentVersion: reader?.version, station: "research", ticket: o.id });
      costUsd += run.result?.costUsd ?? 0;
      if (run.error || !run.result) { step("answer", "failed", run.error ?? "no reply"); return { ok: false, text: "", files: [], costUsd, error: run.error ?? "no reply" }; }
      text = run.result.text.trim();
      step("answer", "passed");
    } else return { ok: false, text: "", files: [], costUsd, error: `The flow "${flow.name}" asks for "${s.action}", which a reader cannot do.` };
  }
  const files = (text.match(/^Files read:\s*(.+)$/im)?.[1] ?? "").split(",").map((f) => f.trim()).filter((f) => f && f.toLowerCase() !== "none");
  return { ok: true, text, files, costUsd };
}
