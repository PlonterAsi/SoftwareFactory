import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTO_WORK_DEFAULT, EventLog, MAX_TICKETS_PER_LOOK, Tickets, Watchers, createProject, debtFindings, flakyFindings, linkToProject, monthLeft, monthReport,
  securityFindings, setMonthBudget, type Factory, type WatchTools,
} from "../src/index.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
/** A paid agent call, at a given time, made for a ticket or a project. */
const charge = (log: EventLog, usd: number, meta: Record<string, unknown>, at?: Date) => {
  const e = log.append("agent.run.completed", { runId: 1, agent: "builder", costUsd: usd, ...meta });
  if (at) log.db.prepare("UPDATE events SET ts = ? WHERE id = ?").run(at.toISOString(), e.id);
};

describe("monthly budgets and the burn rate", () => {
  it("charges each call to its project, reports the month, and says where it ends", () => {
    const log = new EventLog();
    const a = createProject(log, { name: "Habits" });
    const b = createProject(log, { name: "Reading list" });
    const t = new Tickets(log);
    const tk = t.open({ project: a, kind: "task", title: "Streaks" });
    const now = new Date();
    charge(log, 0.4, { ticket: tk.id });
    charge(log, 0.2, { projectId: b });
    charge(log, 0.1, { station: "chat" });
    const all = monthReport(log, null, now);
    expect(all.spentUsd).toBeCloseTo(0.7);
    expect(all.unassignedUsd).toBeCloseTo(0.1);
    expect(all.projects!.map((p) => [p.name, p.spentUsd])).toEqual([["Habits", 0.4], ["Reading list", 0.2]]);
    expect(all.burnUsd).toBeCloseTo(0.1);
    expect(all.days.at(-1)!.usd).toBeCloseTo(0.7);
    expect(monthReport(log, a, now)).toMatchObject({ spentUsd: 0.4, budgetUsd: null, leftUsd: null });

    setMonthBudget(log, a, 0.5);
    setMonthBudget(log, null, 5);
    const ma = monthReport(log, a, now);
    expect(ma).toMatchObject({ budgetUsd: 0.5, leftUsd: 0.1 });
    // The smaller of what the project and everything have left holds the work, and says which.
    expect(monthLeft(log, a, now)).toMatchObject({ leftUsd: 0.1, why: expect.stringMatching(/this project's monthly budget of \$0\.50 has \$0\.10 left/) });
    expect(monthLeft(log, b, now)).toMatchObject({ leftUsd: 4.3, why: expect.stringMatching(/this month's budget of \$5\.00/) });
    expect(() => setMonthBudget(log, 999, 1)).toThrow(/No project/);
    setMonthBudget(log, a, null);
    expect(monthReport(log, a, now).budgetUsd).toBeNull();
  });

  it("does not count last month, and reads the burn rate from the last seven days", () => {
    const log = new EventLog();
    const now = new Date(2026, 10, 20, 12);
    charge(log, 2, {}, new Date(2026, 9, 30, 12));
    charge(log, 0.7, {}, new Date(2026, 10, 18, 12));
    setMonthBudget(log, null, 1);
    const r = monthReport(log, null, now);
    expect(r.month).toBe("2026-11");
    expect(r.spentUsd).toBeCloseTo(0.7);
    expect(r.burnUsd).toBeCloseTo(0.1);
    expect(r.projectedUsd).toBeGreaterThan(1.6);
    // $0.30 left at $0.10 a day: about three days.
    expect(r.runsOutOn).toBe("2026-11-23");
  });
});

describe("the queue fits the monthly budgets", () => {
  function setup(left: number | null) {
    const log = new EventLog();
    const started: any[] = [];
    const factory = { start: (_i: string, o: any) => { started.push(o); return 1000 + started.length; }, isActive: () => true, duplicateOf: () => null };
    const t = new Tickets(log, { factory: factory as unknown as Factory, autoWork: () => AUTO_WORK_DEFAULT, monthLeft: () => ({ leftUsd: left, why: left == null ? null : `this month's budget of $3.00 has $${left.toFixed(2)} left (it renews Dec 1)` }) });
    const x = t.open({ project: 7, kind: "bug", title: "List blank after restart", body: "After a restart the screen shows nothing. It should show the list it showed before the restart.", answers: { expected: "The list it showed before" } });
    t.edit(x.id, "size", "S");
    t.say(x.id, "", { status: "ready" });
    return { t, id: x.id, started };
  }

  it("holds the crew's own starts while the month has less left than one start, and says why", () => {
    const { t, id } = setup(0.4);
    expect(t.dispatch()).toEqual([]);
    expect(t.queue(7)[0]).toMatchObject({ position: null, why: expect.stringMatching(/^Waits for money: this month's budget of \$3\.00 has \$0\.40 left.*\$1\.50 one start/) });
    expect(t.get(id)!.status).toBe("ready");
  });

  it("starts them when enough is left, and gives a start you press no more than is left", () => {
    expect(setup(2).t.dispatch()).toHaveLength(1);
    const s = setup(0.4);
    s.t.work(s.id, { maxUsd: 1 });
    expect(s.started[0].maxUsd).toBe(0.4);
    const none = setup(0.01);
    expect(() => none.t.work(none.id)).toThrow(/No money left this month/);
  });
});

describe("watchers only open tickets", () => {
  it("finds long files, TODO piles and secrets without copying them, and a .env git does not ignore", () => {
    const dir = tmp("sf-watch-");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "big.ts"), Array.from({ length: 1200 }, (_, i) => `export const v${i} = ${i}; // TODO: tidy ${i % 40 === 0 ? "now" : ""}`).join("\n"));
    writeFileSync(join(dir, "app.py"), 'from flask import Flask\napp = Flask(__name__)\nPASSWORD = "hunter2hunter2"\napp.run(debug=True)\n');
    writeFileSync(join(dir, ".env"), "TOKEN=abc\n");
    const debt = debtFindings(dir);
    expect(debt.map((f) => f.key)).toEqual(expect.arrayContaining(["long:src/big.ts", expect.stringMatching(/^todos:/)]));
    const sec = securityFindings(dir);
    expect(sec.map((f) => f.title).join(" | ")).toMatch(/Take the secret out of the code/);
    expect(sec.some((f) => f.key === "env-not-ignored")).toBe(true);
    expect(JSON.stringify(sec)).not.toContain("hunter2");
    writeFileSync(join(dir, ".gitignore"), ".env\n");
    expect(securityFindings(dir).some((f) => f.key === "env-not-ignored")).toBe(false);
  });

  it("finds a password under a longer name, or passed straight to a mail login, and not a setting read at start", () => {
    const secretPlaces = (code: string) => {
      const dir = tmp("sf-watch-sec-");
      writeFileSync(join(dir, "app.py"), code);
      return securityFindings(dir).filter((f) => /secret/i.test(f.title)).length;
    };
    expect(secretPlaces('MAIL_PASSWORD = "abcd efgh ijkl mnop"\n')).toBe(1);
    expect(secretPlaces('server.login("me@example.com", "abcdefghijklmnop")\n')).toBe(1);
    expect(secretPlaces('MAIL_PASSWORD = os.environ["MAIL_PASSWORD"]\nserver.login(user, password)\n')).toBe(0);
  });

  it("finds a test that passed and then failed again inside one build, in two builds", () => {
    const log = new EventLog();
    const p = createProject(log, { name: "Timer" });
    for (const run of [11, 12, 13]) log.append("project.linked", { projectId: p, kind: "factory_run", ref: run });
    const tests = (run: number, round: number, pass: boolean) => log.append("factory.tests", { run, round, cases: [{ name: "counts down", file: "test/timer.test.js", pass, durationMs: 5 }, { name: "starts", file: "test/timer.test.js", pass: round > 1, durationMs: 1 }], passed: 1, failed: 1, timedOut: false });
    tests(11, 1, true); tests(11, 2, false); tests(11, 3, true);
    tests(12, 1, true); tests(12, 2, false);
    tests(13, 1, false); tests(13, 2, true);
    const f = flakyFindings(log, p);
    expect(f).toHaveLength(1);
    expect(f[0].title).toMatch(/counts down/);
    expect(f[0].body).toMatch(/in 2 builds \(run 11, run 12\)/);
  });

  it("runs on schedule, files each finding once as an open ticket, and keeps a look from flooding the board", async () => {
    const log = new EventLog();
    const p = createProject(log, { name: "LandingPage" });
    const dir = tmp("sf-watch-proj-");
    linkToProject(log, p, "folder", dir);
    const t = new Tickets(log);
    const files = new Map<string, string>([["app.py", 'SECRET_KEY = "s3cr3t-value"\n'], ["run.py", "import os\nos.system(cmd)\n"]]);
    const tools: WatchTools = {
      scan: () => ({ largest: Array.from({ length: 7 }, (_, i) => ({ path: `src/f${i}.ts`, lines: 1500 + i })), modules: [] }) as any,
      readCode: () => files,
      dependencyScan: async () => ({ reports: [{ tool: "npm audit", ran: true, note: "1 package with a known vulnerability", vulnerable: [{ name: "lodash", severity: "high", detail: "prototype pollution" }] }], unpinned: [], total: 3 }),
    };
    const w = new Watchers(log, t, tools);
    // Everything on and due at first.
    expect(w.due().filter((d) => d.projectId === p).map((d) => d.kind).sort()).toEqual(["debt", "dependencies", "flaky", "security"]);
    const debt = await w.run(p, "debt");
    expect(debt.opened).toHaveLength(MAX_TICKETS_PER_LOOK);
    expect(debt.note).toMatch(/7 found: 5 new tickets, 2 wait for the next look/);
    const again = await w.run(p, "debt");
    expect(again.opened).toHaveLength(2);
    expect((await w.run(p, "debt")).opened).toEqual([]);
    const sec = await w.run(p, "security");
    expect(sec.opened.length).toBe(2);
    const tk = t.get(sec.opened[0])!;
    expect(tk).toMatchObject({ status: "open", kind: "bug", project: p });
    expect(tk.tags).toEqual(expect.arrayContaining(["watcher", "security"]));
    expect((await w.run(p, "dependencies")).opened).toHaveLength(1);
    // Looked: none due until the schedule comes round; a watcher you turn off never is.
    expect(w.due().filter((d) => d.projectId === p).map((d) => d.kind)).toEqual(["flaky"]);
    w.set(p, "flaky", { on: false });
    expect(w.due().filter((d) => d.projectId === p)).toEqual([]);
    expect(w.due(Date.now() + 25 * 3_600_000).filter((d) => d.projectId === p).map((d) => d.kind)).toEqual(["security"]);
    expect(() => w.set(p, "debt", { everyHours: 0 })).toThrow(/every 1 hour/);
    // A project with no folder: the code watchers say so; flaky tests reads the records.
    const q = createProject(log, { name: "Idea only" });
    expect(w.state(q).find((s) => s.kind === "security")!.blocked).toMatch(/no folder/);
    expect(w.state(q).find((s) => s.kind === "flaky")!.blocked).toBeNull();
  });
});
