import { describe, expect, it } from "vitest";
import { TheRecord } from "../src/fence/record.js";
import { stepsOf, stepsText } from "../src/fence/story.js";

/** A ticket's record, written the way the real pieces write it. */
function ticket() {
  const r = new TheRecord();
  const s = { ticket: "T1", project: "o/p" };
  const run = { ...s, run: "r1" };
  const api = {
    r,
    open: () => r.append({ kind: "ticket.opened", who: "you", ...s, data: { sentence: "Add a hello file.", kind: "request" } }),
    gate: () => r.append({ kind: "gate.passed", who: "SF itself", ...s, costUsd: 0.01, data: { kind: "task", done: ["hello.txt exists", "it says hello"], guesses: ["at the top folder"] } }),
    fence: (ok = true) => r.append({ kind: "fence.tested", who: "SF itself", ...s, data: { ok, ms: 5, lines: Array.from({ length: 9 }, (_, i) => ({ n: i + 1, what: `line ${i + 1}`, verdict: ok || i ? "refused" : "ALLOWED", ok: ok || i > 0, detail: "" })) } }),
    start: (found?: string[]) => r.append({ kind: "run.started", who: "SF itself", ...run, data: { model: "sonnet", checks: ["npm run build"], ...(found ? { checksFound: found } : {}) } }),
    agent: () => { r.append({ kind: "run.step", who: "worker", ...run, data: { says: "Writing.", tools: [{ tool: "Write", input: "{}" }] } }); r.append({ kind: "run.step", who: "worker", ...run, costUsd: 0.2, data: { finished: true, turns: 3, denials: 0 } }); },
    commit: () => r.append({ kind: "run.step", who: "SF itself", ...run, data: { did: "work committed in the room", headSha: "abcdef1234567890" } }),
    check: (ok = true) => r.append({ kind: "run.checked", who: "SF itself", ...run, data: { command: "npm run build", ok, exit: ok ? 0 : 1, tail: "" } }),
    end: (end: string, reason: string) => r.append({ kind: "run.ended", who: "SF itself", ...run, data: { end, reason, costUsd: 0.2 } }),
    propose: () => r.append({ kind: "result.proposed", who: "SF itself", ...run, data: { url: "https://github.com/o/p/pull/7", number: 7, files: ["hello.txt", "notes.py"], unchecked: ["notes.py"], headSha: "abcdef1234567890" } }),
    steps: (working = false) => stepsOf(r.story("T1"), working),
  };
  return api;
}
const states = (t: ReturnType<typeof ticket>, working = false) => Object.fromEntries(t.steps(working).map((s) => [s.id, s.state]));

describe("the story in steps", () => {
  it("shows a waiting ticket as asked, with the rest of the road not reached", () => {
    const t = ticket(); t.open();
    expect(states(t)).toEqual({ asked: "done", ready: "not reached", fence: "not reached", worked: "not reached", checked: "not reached", proposed: "not reached", accepted: "not reached" });
    expect(t.steps()[0]!.proof).toBe("You asked: Add a hello file.");
    expect(t.steps()[0]!.lines).toEqual([1]);
  });

  it("gives every step of a finished ticket its proof and the record lines it was read from", () => {
    const t = ticket(); t.open(); t.gate(); t.fence(); t.start(["npm run build"]); t.agent(); t.commit(); t.check(); t.end("passed", "all checks passed"); t.propose();
    const steps = t.steps();
    expect(states(t)).toEqual({ asked: "done", ready: "done", fence: "done", worked: "done", checked: "done", proposed: "done", accepted: "now" });
    const by = Object.fromEntries(steps.map((s) => [s.id, s]));
    expect(by.ready!.facts).toEqual(["done when: hello.txt exists", "done when: it says hello", "assumed: at the top folder"]);
    expect(by.fence!.proof).toMatch(/^9 of 9 lines/);
    expect(by.worked!.proof).toContain("abcdef12");
    expect(by.worked!.facts).toEqual(expect.arrayContaining(["model sonnet", "3 turns, 1 tool uses", "$0.20"]));
    expect(by.checked!.proof).toMatch(/^1 of 1 checks passed/);
    expect(by.proposed!.url).toBe("https://github.com/o/p/pull/7");
    expect(by.proposed!.facts).toContain("no check looked at: notes.py");
    for (const s of steps.filter((x) => x.state === "done")) expect(s.lines.length).toBeGreaterThan(0);
    expect(stepsText(steps)).toMatch(/\[x\] Proposed .*#7.*\(record \d+\)/);
    t.r.append({ kind: "result.accepted", who: "you", run: "r1", ticket: "T1", project: "o/p", data: { number: 7, sha: "1234567890abcdef", githubChecks: "none" } });
    expect(states(t).accepted).toBe("done");
    t.r.append({ kind: "result.undone", who: "you", run: "r1", ticket: "T1", project: "o/p", data: { sha: "fedcba9876543210" } });
    expect(t.steps().at(-1)).toMatchObject({ id: "undone", state: "done" });
  });

  it("marks the step that failed and leaves what follows not reached", () => {
    const a = ticket(); a.open(); a.gate(); a.fence(); a.start(); a.agent(); a.commit(); a.check(false); a.end("failed its checks", "npm run build failed");
    expect(states(a)).toMatchObject({ worked: "done", checked: "failed", proposed: "not reached", accepted: "not reached" });
    const b = ticket(); b.open(); b.fence(false);
    expect(states(b)).toMatchObject({ fence: "failed", worked: "not reached", checked: "not reached" });
    expect(b.steps()[2]!.facts).toEqual(["1. line 1: ALLOWED"]);
    const c = ticket(); c.open(); c.fence(); c.start(); c.end("parked", "the plan limit was reached");
    expect(states(c)).toMatchObject({ ready: "skipped", worked: "failed", checked: "not reached", proposed: "not reached" });
    expect(c.steps()[3]!.proof).toBe("The run ended as parked: the plan limit was reached");
    const d = ticket(); d.open(); d.fence(); d.start(); d.agent(); d.commit(); d.check();
    d.r.append({ kind: "result.proposed", who: "SF itself", run: "r1", ticket: "T1", project: "o/p", data: { held: true, reason: "the result changes a check script" } });
    expect(states(d)).toMatchObject({ checked: "done", proposed: "failed", accepted: "not reached" });
  });

  it("never calls the checks done when the end says otherwise, when not all ran, or when nothing is running", () => {
    const two = (t: ReturnType<typeof ticket>) => t.r.append({ kind: "run.started", who: "SF itself", run: "r1", ticket: "T1", project: "o/p", data: { model: "sonnet", checks: ["npm run build", "go vet"] } });
    // The files changed while the checks ran: every check passed, the end did not.
    const a = ticket(); a.open(); a.fence(); a.start(); a.agent(); a.commit(); a.check(); a.end("failed its checks", "the project's files changed while the checks ran");
    expect(a.steps()[4]).toMatchObject({ state: "failed", proof: "The checks did not count: the project's files changed while the checks ran" });
    // Stop after the first of two checks.
    const b = ticket(); b.open(); b.fence(); two(b); b.agent(); b.commit(); b.check(); b.end("stopped", "you pressed stop");
    expect(b.steps()[4]).toMatchObject({ state: "failed" });
    expect(b.steps()[4]!.proof).toMatch(/^Only 1 of 2 checks ran/);
    // SoftwareFactory was closed after one check: nothing is running, so nothing is "now".
    const c = ticket(); c.open(); c.fence(); two(c); c.agent(); c.commit(); c.check();
    expect(states(c, false).checked).toBe("failed");
    expect(states(c, true).checked).toBe("now");
    // No checks at all, and the proposal failed outside the room: the blame is on Proposed, not on Checked.
    const d = ticket(); d.open(); d.fence();
    d.r.append({ kind: "run.started", who: "SF itself", run: "r1", ticket: "T1", project: "o/p", data: { model: "sonnet", checks: [], checksFound: [] } });
    d.agent(); d.commit(); d.end("passed", "ok");
    d.r.append({ kind: "run.ended", who: "SF itself", run: "r1", ticket: "T1", project: "o/p", data: { end: "crashed", reason: "push refused", where: "outside the room" } });
    expect(states(d)).toMatchObject({ checked: "skipped", proposed: "failed" });
    // Stop pressed while the fence was being tested: no run, and the road says why.
    const e = ticket(); e.open(); e.fence();
    e.r.append({ kind: "stop.pressed", who: "you", ticket: "T1", data: {} });
    expect(e.steps()[3]).toMatchObject({ state: "failed", proof: "No run: you pressed stop." });
  });

  it("says what it waits for: your answer at the gate, a run at work, a run cut off", () => {
    const a = ticket(); a.open();
    a.r.append({ kind: "gate.asked", who: "SF itself", ticket: "T1", project: "o/p", data: { question: "Which page?" } });
    expect(a.steps()[1]).toMatchObject({ state: "now", proof: "Waiting for your answer: Which page?" });
    const b = ticket(); b.open(); b.gate(); b.fence(); b.start();
    expect(states(b, true)).toMatchObject({ worked: "now", checked: "not reached" });
    expect(states(b, false)).toMatchObject({ worked: "failed" });
  });

  it("reads only the latest go once a ticket is sent again, and counts the goes", () => {
    const t = ticket(); t.open(); t.fence(); t.start(); t.end("crashed", "boom");
    t.r.append({ kind: "ticket.queued", who: "you", ticket: "T1", project: "o/p", data: {} });
    expect(states(t)).toMatchObject({ fence: "not reached", worked: "not reached" });
    expect(t.steps()[0]!.facts).toEqual(["sent to be worked 2 times; this is the latest"]);
  });

  it("carries nothing that could move a cursor, whatever the record holds", () => {
    const t = ticket();
    t.r.append({ kind: "ticket.opened", who: "you", ticket: "T1", project: "o/p", data: { sentence: "hi\u001b[2J there", kind: "request" } });
    expect(t.steps()[0]!.proof).toBe("You asked: hi[2J there");
  });
});
