import type { RecordLine } from "./record.js";

/**
 * The story of one ticket as steps with proof (docs/fence.md, "The story in steps").
 *
 * The line-by-line story says everything that happened. This says where the ticket stands on a fixed road, and what
 * proves each step: a count, a commit, a link, and the record lines it was read from. Nothing here is stored. It is
 * read from the record each time, so a step can never say more than the record does.
 */
export type StepState = "done" | "failed" | "now" | "skipped" | "not reached";

export interface StoryStep {
  id: "asked" | "ready" | "fence" | "worked" | "checked" | "proposed" | "accepted" | "undone";
  title: string;
  state: StepState;
  /** One sentence: what proves this step, or why it is not done. */
  proof: string;
  /** Small facts behind the sentence: each check, each line of the test of done, the commit. */
  facts: string[];
  /** A link that shows the proof outside SoftwareFactory, when there is one. */
  url: string | null;
  /** The record lines this step was read from. */
  lines: number[];
  at: string | null;
}

const TITLES: Record<StoryStep["id"], string> = {
  asked: "Asked", ready: "Ready", fence: "Fence held", worked: "Worked", checked: "Checked", proposed: "Proposed", accepted: "Accepted", undone: "Undone",
};
const short = (sha: unknown) => (typeof sha === "string" && sha ? sha.slice(0, 8) : "");
const clean = (s: unknown, n = 300) => String(s ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f\u009b]/g, "").slice(0, n);
const money = (n: number) => (n > 0 ? `$${n.toFixed(2)}` : "no cost");

/** The steps of one ticket. `lines` is that ticket's whole story; `working` says a run is on it right now. */
export function stepsOf(lines: RecordLine[], working = false): StoryStep[] {
  const d = (l?: RecordLine) => (l?.data ?? {}) as Record<string, any>;
  const last = (from: RecordLine[], ...k: string[]) => [...from].reverse().find((l) => k.includes(l.kind));
  const opened = lines.find((l) => l.kind === "ticket.opened");
  if (!opened) return [];
  const sent = last(lines, "ticket.opened", "ticket.queued")!;
  const words = last(lines.filter((l) => l.kind === "ticket.opened" || typeof d(l).sentence === "string"), "ticket.opened", "ticket.edited")!;
  const go = lines.filter((l) => l.id > sent.id);
  const gate = lines.filter((l) => l.id > words.id && l.kind.startsWith("gate."));
  const goes = lines.filter((l) => l.kind === "ticket.opened" || l.kind === "ticket.queued").length;
  const step = (id: StoryStep["id"], state: StepState, proof: string, from: (RecordLine | undefined)[] = [], facts: string[] = [], url: string | null = null): StoryStep => {
    const ls = from.filter((l): l is RecordLine => !!l);
    return { id, title: TITLES[id], state, proof: clean(proof), facts: facts.map((f) => clean(f, 200)).slice(0, 30), url, lines: ls.map((l) => l.id), at: ls.length ? ls[ls.length - 1]!.ts : null };
  };
  const out: StoryStep[] = [];

  // 1. Asked: the words, as they stand now.
  out.push(step("asked", "done", `${words.kind === "ticket.edited" ? "You changed it to" : "You asked"}: ${clean(d(words).sentence ?? d(opened).sentence, 200)}`, [opened, words.id !== opened.id ? words : undefined, sent.id !== opened.id ? sent : undefined], goes > 1 ? [`sent to be worked ${goes} times; this is the latest`] : []));

  // 2. Ready: the test of done, written before any run.
  const asked = last(gate, "gate.asked"), answered = asked ? gate.find((l) => l.kind === "gate.answered" && l.id > asked.id) : undefined, passed = last(gate, "gate.passed");
  const started = last(go, "run.started"), fence = last(go, "fence.tested");
  if (passed && d(passed).skipped) out.push(step("ready", "skipped", `No test of done was written: ${d(passed).skipped}`, [asked, answered, passed]));
  else if (passed) {
    const done = (Array.isArray(d(passed).done) ? d(passed).done : []).map(String), guesses = (Array.isArray(d(passed).guesses) ? d(passed).guesses : []).map(String);
    out.push(step("ready", "done", `The test of done has ${done.length} ${done.length === 1 ? "line" : "lines"}, written before the run${answered ? ", after your answer" : ""}.`, [asked, answered, passed], [...done.map((x: string) => `done when: ${x}`), ...guesses.map((x: string) => `assumed: ${x}`), ...(asked && answered ? [`asked: ${d(asked).question}`, `you answered: ${d(answered).answer}`] : [])]));
  } else if (asked && !answered) out.push(step("ready", "now", `Waiting for your answer: ${d(asked).question}`, [asked]));
  else if (fence || started) out.push(step("ready", "skipped", "This run started without a test of done (the ready gate was off).", []));
  else out.push(step("ready", "not reached", "The test of done is written when its turn comes.", [asked, answered]));

  // 3. Fence: the nine lines, tested before this run.
  if (fence) {
    const fl: any[] = Array.isArray(d(fence).lines) ? d(fence).lines : [], good = fl.filter((x) => x.ok).length;
    if (d(fence).ok) out.push(step("fence", "done", `${good} of ${fl.length} lines came out as they should, tested just before this run.`, [fence], fl.map((x) => `${x.n}. ${x.what}: ${x.verdict}`)));
    else out.push(step("fence", "failed", d(fence).error ? `The fence could not be tested: ${d(fence).error}` : `${fl.length - good} of ${fl.length} lines did not hold, so no run started.`, [fence], fl.filter((x) => !x.ok).map((x) => `${x.n}. ${x.what}: ${x.verdict}${x.detail ? ` (${x.detail})` : ""}`)));
  } else out.push(step("fence", "not reached", "The fence is tested before every run."));

  // 4. Worked: the run in the room.
  const ended = last(go, "run.ended"), run = started?.run ?? null;
  const ofRun = run ? go.filter((l) => l.run === run) : [];
  const agentSteps = ofRun.filter((l) => l.kind === "run.step" && l.who !== "SF itself");
  const finished = agentSteps.find((l) => d(l).finished), committed = ofRun.find((l) => l.kind === "run.step" && d(l).did === "work committed in the room");
  const uses = agentSteps.reduce((a, l) => a + (Array.isArray(d(l).tools) ? d(l).tools.length : 0), 0);
  const cost = ofRun.reduce((a, l) => a + (l.costUsd ?? 0), 0) || Number(d(ended).costUsd ?? 0) || 0;
  const checks = ofRun.filter((l) => l.kind === "run.checked");
  const proposed = last(go, "result.proposed");
  const end = String(d(ended).end ?? ""), reason = clean(d(ended).reason);
  const stoppedBy = go.some((l) => l.kind === "stop.pressed") ? last(go, "stop.pressed") : undefined;
  let broke = false; // a step failed: what comes after was not reached
  if (!started) {
    if (ended && !broke) { out.push(step("worked", "failed", `No run: ${reason}`, [ended])); broke = true; }
    else out.push(step("worked", "not reached", fence && d(fence).ok === false ? "No run started." : "A run works it in the room when its turn comes."));
    if (fence && d(fence).ok === false) broke = true;
  } else {
    const facts = [`model ${d(started).model}`, `${Number(d(finished).turns ?? 0) || agentSteps.length} turns, ${uses} tool uses`, money(cost), ...(short(d(committed).headSha) ? [`commit ${short(d(committed).headSha)} made by SoftwareFactory from a fresh list of files`] : [])];
    if (committed) out.push(step("worked", "done", `The run finished its work and SoftwareFactory committed it (${short(d(committed).headSha)}).`, [started, finished, committed], facts));
    else if (ended) { out.push(step("worked", "failed", `The run ended as ${end}: ${reason}`, [started, stoppedBy, ended], facts)); broke = true; }
    else if (working) out.push(step("worked", "now", agentSteps.length ? `A run is working: ${agentSteps.length} steps so far.` : "A run is starting in the room.", [started], facts.slice(0, 3)));
    else { out.push(step("worked", "failed", "The run was cut off before it finished.", [started, stoppedBy], facts.slice(0, 3))); broke = true; }
  }

  // 5. Checked: SoftwareFactory's own checks, in a box with no network.
  const found = Array.isArray(d(started).checksFound) ? (d(started).checksFound as unknown[]).map(String) : null;
  if (broke || !committed) out.push(step("checked", "not reached", "The checks run after the work is committed."));
  else if (checks.length) {
    const bad = checks.filter((l) => !d(l).ok);
    out.push(step("checked", bad.length ? "failed" : (ended || proposed) ? "done" : "now", bad.length ? `${bad.length} of ${checks.length} checks failed: ${d(bad[0]).command}` : `${checks.length} of ${checks.length} checks passed, run by SoftwareFactory with no network.`, checks, [...checks.map((l) => `${d(l).ok ? "passed" : "FAILED"}: ${d(l).command}`), ...(found ? [`found in the project: ${found.join(", ") || "nothing"}`] : [])]));
    if (bad.length) broke = true;
  } else if (!ended && !proposed) out.push(step("checked", working ? "now" : "not reached", "The checks are running.", []));
  else if (ended && !["passed", ""].includes(end) && !proposed) { out.push(step("checked", "failed", `The run ended as ${end}: ${reason}`, [ended])); broke = true; }
  else out.push(step("checked", "skipped", found ? "No build or type check was found in the project, so nothing was checked." : "No checks are set for this project, so nothing was checked.", [started]));

  // 6. Proposed: on GitHub, or held on this computer.
  if (proposed && d(proposed).held) { out.push(step("proposed", "failed", `Held on this computer: ${d(proposed).reason}`, [proposed])); broke = true; }
  else if (proposed) {
    const files: string[] = Array.isArray(d(proposed).files) ? d(proposed).files.map(String) : [], un: string[] = Array.isArray(d(proposed).unchecked) ? d(proposed).unchecked.map(String) : [];
    out.push(step("proposed", "done", `Draft pull request ${d(proposed).number ? `#${d(proposed).number} ` : ""}on GitHub: ${files.length} ${files.length === 1 ? "file" : "files"} changed, commit ${short(d(proposed).headSha)}.`, [proposed], [...files.map((f) => `changed: ${f}`), ...un.map((f) => `no check looked at: ${f}`)], typeof d(proposed).url === "string" && /^https:\/\//.test(d(proposed).url) ? d(proposed).url : null));
  } else if (!broke && ended && end !== "passed") { out.push(step("proposed", "failed", `Nothing was proposed: ${reason}`, [ended])); broke = true; }
  else out.push(step("proposed", "not reached", broke ? "Nothing was proposed." : "A checked result is proposed on GitHub as a draft."));

  // 7. Accepted, and 8. Undone when it happened. These belong to the ticket, whichever go made them.
  const accepted = last(lines, "result.accepted"), undone = last(lines, "result.undone");
  if (accepted) out.push(step("accepted", "done", d(accepted).foundMerged ? `Found already put into the project on GitHub (${short(d(accepted).sha)})${d(accepted).notTheCheckedCommit ? ", with changes made after SoftwareFactory checked it" : ""}.` : `You accepted it. It is in the project as ${short(d(accepted).sha)}.`, [accepted], d(accepted).githubChecks ? [`GitHub's own checks at that moment: ${d(accepted).githubChecks}`] : []));
  else out.push(step("accepted", proposed && !d(proposed).held && !broke ? "now" : "not reached", proposed && !d(proposed).held && !broke ? "Waiting for you to accept." : "Only you accept a result."));
  if (undone) out.push(step("undone", d(undone).sha ? "done" : "now", d(undone).sha ? `You undid it with a new change (${short(d(undone).sha)}). The history keeps both steps.` : "The undo is on GitHub and still has to be put in there.", [undone], [], typeof d(undone).url === "string" && /^https:\/\//.test(d(undone).url) ? d(undone).url : null));
  return out;
}

/** The steps as lines a person reads in a console. */
export function stepsText(steps: StoryStep[]): string {
  const mark: Record<StepState, string> = { done: "[x]", failed: "[!]", now: "[>]", skipped: "[-]", "not reached": "[ ]" };
  return steps.map((s) => `${mark[s.state]} ${s.title.padEnd(11)} ${s.proof}${s.lines.length ? `  (record ${s.lines.join(", ")})` : ""}`).join("\n");
}
