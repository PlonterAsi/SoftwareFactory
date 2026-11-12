import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, git } from "../src/index.js";
import type { AgentRequest, AgentResult, AgentRuntime } from "../src/runtime.js";
import { workInRepo, type LoopChecks } from "../src/tickets/repowork.js";

/** A fake crew: the Builder writes a new file each call; the Reviewer answers from a list. */
class Fake implements AgentRuntime {
  readonly name = "fake";
  calls: AgentRequest[] = [];
  constructor(private review: string[] = ["[]"]) {}
  async run(req: AgentRequest): Promise<AgentResult> {
    this.calls.push(req);
    const reviewer = /Station contract: review/.test(req.systemPrompt ?? "");
    const n = this.calls.length;
    const text = reviewer
      ? "```json\n" + JSON.stringify({ verdict: "pass", findings: JSON.parse(this.review.shift() ?? "[]") }) + "\n```"
      : `<<<FILE src/f${n}.txt\nchange ${n}\nFILE>>>\nDid it.`;
    return { text, costUsd: 0.01, durationMs: 1, models: ["fake"], runtime: "fake", contextTokens: 0 };
  }
}

function setup() {
  const src = mkdtempSync(join(tmpdir(), "sf-rw-src-"));
  git(src, "init", "-q", "-b", "main");
  writeFileSync(join(src, "CLAUDE.md"), "Always write small code.");
  git(src, "add", "-A");
  git(src, "commit", "-q", "-m", "init");
  return { src, workRoot: mkdtempSync(join(tmpdir(), "sf-rw-work-")), log: new EventLog() };
}

const run = (rt: Fake, s: ReturnType<typeof setup>, checks: LoopChecks, id = 1) =>
  workInRepo(s.log, rt, undefined, { id, key: "SF-1", title: "Do it", document: "# SF-1 Do it", repo: { source: s.src, dir: s.src, branch: null }, workRoot: s.workRoot, maxUsd: 0.6, checks });

const ok = { ok: true, output: "" };

describe("workInRepo loop", () => {
  it("a check that could not run is not listed as passed", async () => {
    const s = setup(); const rt = new Fake();
    const r = await run(rt, s, { runTests: () => ({ ok: true, output: "no deps", skipped: true }) });
    expect(r.ok).toBe(true);
    expect(r.checks).toEqual(["gates", "test integrity", "review"]);
  });

  it("the Reviewer is told to look for gamed tests", async () => {
    const s = setup(); const rt = new Fake();
    await run(rt, s, { runTests: () => ok });
    expect(rt.calls.find((c) => /Station contract: review/.test(c.systemPrompt ?? ""))!.systemPrompt).toMatch(/gaming the tests/);
  });

  it("a clean pass commits, reads the repo's rules and logs each step", async () => {
    const s = setup(); const rt = new Fake();
    const r = await run(rt, s, { runTests: () => ok });
    expect(r.ok).toBe(true);
    expect(r.sha).toBeTruthy();
    expect(r.checks).toEqual(["gates", "test integrity", "tests", "review"]);
    expect(rt.calls[0].prompt).toContain("Always write small code.");
    const steps = s.log.db.prepare("SELECT payload FROM events WHERE type = 'ticket.step'").all() as { payload: string }[];
    expect(steps.length).toBeGreaterThan(4);
  });

  it("a failing gate triggers a fix round with the error, then commits", async () => {
    const s = setup(); const rt = new Fake(); let n = 0;
    const r = await run(rt, s, { gates: () => (++n === 1 ? { ok: false, output: "lint: unused x" } : ok), runTests: () => ok });
    expect(r.ok).toBe(true);
    expect(r.sha).toBeTruthy();
    expect(rt.calls[1].prompt).toContain("lint: unused x");
  });

  it("two failed fix rounds stop without a commit", async () => {
    const s = setup(); const rt = new Fake();
    const r = await run(rt, s, { runTests: () => ({ ok: false, output: "1 failing" }) });
    expect(r.ok).toBe(false);
    expect(r.sha).toBeNull();
    expect(r.error).toContain("tests still failing");
    expect(rt.calls.length).toBe(3); // the build and two fixes
    expect(git(r.dir, "rev-list", "--count", "HEAD")).toBe("1");
  });

  it("a high review finding triggers one fix, then the checks run again", async () => {
    const s = setup(); const rt = new Fake([JSON.stringify([{ severity: "high", text: "divides by zero" }])]); let tests = 0;
    const r = await run(rt, s, { runTests: () => { tests++; return ok; } });
    expect(r.ok).toBe(true);
    expect(tests).toBe(2);
    expect(rt.calls.some((c) => c.prompt.includes("divides by zero"))).toBe(true);
    expect(rt.calls.length).toBe(3); // build, review, one fix
  });
});
