import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { EventLog, ClaudeCodeRuntime } from "../src/index.js";
import { AwakeClock, clearSleepLedger, keepAwake, noteGap, sleptBetween, holdScriptFor } from "../src/factory/awake.js";
import { StreamReader, callVerdict } from "../src/runtime.js";
import { extendTime, MAX_TIME_EXTENSIONS } from "../src/factory/stoprules.js";
import { Supervisor, STUCK_MS, TRIES, leftToYou, type SupervisedFactory, type SupervisedTickets } from "../src/factory/supervisor.js";
import { AUTO_WORK_DEFAULT } from "../src/tickets/shapes.js";

// Run 10486 (24 Nov 2026): 35 minutes of work, then the PC slept 10:27 to 14:19, and the run was stopped as too long.
describe("sleep is not work", () => {
  beforeEach(() => clearSleepLedger());

  it("leaves the time the PC slept out of every work clock", () => {
    noteGap(1_000, 5_000);
    noteGap(10_000, 11_000);
    expect(sleptBetween(0, 20_000)).toBe(5_000);
    expect(sleptBetween(3_000, 10_500)).toBe(2_500);
    expect(sleptBetween(6_000, 9_000)).toBe(0);
    let t = 0;
    const c = new AwakeClock(() => t);
    t = 20_000;
    expect(c.elapsed()).toBe(15_000);
    c.beat();
    t = 25_000;
    expect(c.idle()).toBe(5_000);
  });

  it("holds the PC awake only while asked, and the hold ends with the core", () => {
    const kids: (EventEmitter & { killed?: boolean })[] = [];
    const k = keepAwake({ platform: "win32", env: {}, spawnHold: () => { const c = Object.assign(new EventEmitter(), { kill() { (c as { killed?: boolean }).killed = true; return true; } }); kids.push(c); return c as unknown as ChildProcess; } });
    expect(k.on).toBe(false);
    k.set(true); k.set(true);
    expect(kids).toHaveLength(1);
    expect(k.on).toBe(true);
    k.set(false);
    expect(kids[0].killed).toBe(true);
    expect(k.on).toBe(false);
    // The script loops only while the core's process is there (Windows does not end a child with its parent).
    expect(holdScriptFor(4242)).toContain("Get-Process -Id 4242");
    expect(holdScriptFor(4242)).toContain("2147483649");
    expect(keepAwake({ platform: "win32", env: { SF_KEEP_AWAKE: "off" } }).why).toMatch(/turned off/);
    expect(keepAwake({ platform: "linux", env: {} }).why).toMatch(/only on Windows/);
  });
});

describe("an agent call is judged by its progress, not a fixed clock", () => {
  it("cuts a silent call as stuck, lets a talking one run past its limit up to three times", () => {
    const base = { limitMs: 25 * 60_000, idleLimitMs: 10 * 60_000, stream: true };
    expect(callVerdict({ ...base, elapsedMs: 12 * 60_000, idleMs: 11 * 60_000 })).toMatch(/Agent stuck: no output for 11 minutes/);
    expect(callVerdict({ ...base, elapsedMs: 40 * 60_000, idleMs: 10_000 })).toBeNull();
    expect(callVerdict({ ...base, elapsedMs: 76 * 60_000, idleMs: 10_000 })).toMatch(/timed out/);
    // Without a stream (SF_AGENT_STREAM=0, an old CLI) the plain limit holds.
    expect(callVerdict({ ...base, stream: false, elapsedMs: 26 * 60_000, idleMs: 26 * 60_000 })).toMatch(/timed out/);
    expect(callVerdict({ ...base, stream: false, elapsedMs: 24 * 60_000, idleMs: 24 * 60_000 })).toBeNull();
  });

  it("reads stream-json as it comes: each line is a beat, the result line is the answer", () => {
    let beats = 0;
    const r = new StreamReader(() => beats++);
    r.push('{"type":"system","subtype":"init"}\n{"type":"assistant","message":{}}\n{"type":"us');
    r.push('er","message":{}}\n{"type":"result","subtype":"success","result":"done","total_cost_usd":0.01}\n');
    expect(beats).toBe(3);
    expect(JSON.parse(r.result())).toMatchObject({ result: "done", total_cost_usd: 0.01 });
    // The one-object format still works.
    const old = new StreamReader();
    old.push('{"result":"pong",');
    old.push('"total_cost_usd":0}');
    expect(JSON.parse(old.result()).result).toBe("pong");
  });

  it("asks the CLI to stream, and runs a streaming CLI end to end", async () => {
    expect(new ClaudeCodeRuntime().buildArgs({ prompt: "p" }).slice(0, 4)).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
    const dir = mkdtempSync(join(tmpdir(), "sf-stream-"));
    const bin = join(dir, "claude.js");
    writeFileSync(bin, `process.stdin.resume();process.stdin.on('end',()=>{let i=0;const t=setInterval(()=>{if(i++<3){console.log(JSON.stringify({type:'assistant',message:{n:i}}));return;}clearInterval(t);console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'built',total_cost_usd:0.03,session_id:'s1'}));},40);});\n`);
    let beats = 0;
    const r = await new ClaudeCodeRuntime({ command: process.execPath, commandArgs: [bin] }).run({ prompt: "go", onProgress: () => beats++ });
    expect(r.text).toBe("built");
    expect(r.costUsd).toBe(0.03);
    expect(r.sessionId).toBe("s1");
    expect(beats).toBe(3);
  });

  it("cuts a CLI that goes silent, long before its time limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-stuck-"));
    const bin = join(dir, "claude.js");
    writeFileSync(bin, `process.stdin.resume();console.log(JSON.stringify({type:'system',subtype:'init'}));setTimeout(()=>{},60000);\n`);
    const began = Date.now();
    await expect(new ClaudeCodeRuntime({ command: process.execPath, commandArgs: [bin] }).run({ prompt: "go", timeoutMs: 60_000, idleMs: 300 })).rejects.toThrow(/Agent stuck/);
    expect(Date.now() - began).toBeLessThan(10_000);
  });
});

describe("a run still making progress at its time limit gets more time", () => {
  it("extends on progress and money, at most twice", () => {
    expect(extendTime({ rounds: [{ failing: 0 }], extensions: 0, moneyLeftUsd: 1 })).toBe(true);
    expect(extendTime({ rounds: [{ failing: 4 }, { failing: 2 }], extensions: 1, moneyLeftUsd: 1 })).toBe(true);
    expect(extendTime({ rounds: [{ failing: 2 }, { failing: 2 }], extensions: 0, moneyLeftUsd: 1 })).toBe(false);
    expect(extendTime({ rounds: [{ failing: 0 }], extensions: MAX_TIME_EXTENSIONS, moneyLeftUsd: 1 })).toBe(false);
    expect(extendTime({ rounds: [{ failing: 0 }], extensions: 0, moneyLeftUsd: 0.01 })).toBe(false);
  });
});

/** A factory with stopped runs in the log (the projection fills factory_runs from the events). */
function world(o: { auto?: boolean; spentToday?: number } = {}) {
  const log = new EventLog();
  const retried: { run: number; addUsd?: number; by?: string }[] = [];
  const stopped: { run: number; by?: string }[] = [];
  const active = new Map<number, { idle: number; gate: string | null }>();
  let dispatched = 0;
  const factory: SupervisedFactory = {
    activeIds: () => [...active.keys()],
    activeCount: () => active.size,
    idleMs: (r) => active.get(r)?.idle ?? null,
    waitingGate: (r) => active.get(r)?.gate ?? null,
    stop: (run, x) => { stopped.push({ run, by: x.by }); log.append("factory.run.stop", { run, by: x.by, reason: x.reason }); active.delete(run); log.append("factory.run.finished", { run, outcome: "stopped", reason: x.reason, resumable: false }); return { ok: true }; },
    retryable: (run) => ({ ok: !active.has(run), from: "review" }),
    retryAddUsd: () => 0.75,
    retry: (run, x) => { retried.push({ run, addUsd: x.addUsd, by: x.by }); log.append("factory.run.retried", { run, from: "review", addUsd: x.addUsd, by: x.by }); log.append("factory.run.finished", { run, outcome: "stopped", reason: "The run took longer than 90 minutes." }); return { run, from: "review", addUsd: x.addUsd ?? 0 }; },
  };
  const tickets: SupervisedTickets = {
    autoWork: () => ({ ...AUTO_WORK_DEFAULT, on: o.auto ?? true }),
    autoUsdToday: () => o.spentToday ?? 0,
    dispatch: () => { dispatched++; return []; },
    retry: (id, x) => { const t = log.db.prepare("SELECT run FROM tickets WHERE id = ?").get(id) as { run: number } | undefined; return factory.retry(Number(t?.run), x); },
    repoWorkCount: () => 0,
  };
  const held: boolean[] = [];
  const awake = { on: false, why: "", set: (w: boolean) => { held.push(w); }, stop() {} };
  const sup = new Supervisor(log, factory, tickets, { awake });
  const startRun = (reason: string, x: { by?: string } = {}) => {
    const s = log.append("factory.run.started", { idea: "Gig Station", maxUsd: 6, runtime: "claude-code:lean" });
    if (x.by) log.append("factory.run.stop", { run: s.id, by: x.by, reason });
    log.append("factory.run.finished", { run: s.id, outcome: "stopped", reason });
    return s.id;
  };
  return { log, sup, startRun, retried, stopped, active, held, dispatched: () => dispatched };
}

describe("the supervisor keeps the factory working", () => {
  it("tries a run that stopped on time again, from its step, then hands it to you after two tries", () => {
    const w = world();
    const run = w.startRun("The run took longer than 90 minutes.");
    w.sup.tick();
    expect(w.retried).toEqual([{ run, addUsd: 0.75, by: "supervisor" }]);
    w.sup.tick();
    expect(w.retried).toHaveLength(TRIES);
    const third = w.sup.tick();
    expect(w.retried).toHaveLength(TRIES);
    expect(third[0]).toMatchObject({ action: "escalated", run });
    // Said once, not every minute.
    expect(w.sup.tick()).toEqual([]);
    expect(w.dispatched()).toBe(4);
  });

  it("never retries what you stopped, refused money for, or what waits for your answer", () => {
    const w = world();
    w.startRun("You stopped this run.", { by: "you" });
    w.startRun("Budget spent: the run's $6.00 is used and the project's budget has nothing left.");
    w.startRun("The app closed while this run waited for your answer: Approve the plan?");
    w.sup.tick();
    expect(w.retried).toEqual([]);
    expect(leftToYou({ outcome: "stopped", reason: "x", stoppedBy: "supervisor", rejectedBy: "auto" })).toBeNull();
    expect(leftToYou({ outcome: "failed", reason: "x", stoppedBy: null, rejectedBy: "you" })).toMatch(/you said no/);
  });

  it("cuts a run with no progress for 30 minutes, and leaves one waiting at a gate alone", () => {
    const w = world();
    const s1 = w.log.append("factory.run.started", { idea: "a", maxUsd: 1, runtime: "mock" }).id;
    const s2 = w.log.append("factory.run.started", { idea: "b", maxUsd: 1, runtime: "mock" }).id;
    const s3 = w.log.append("factory.run.started", { idea: "c", maxUsd: 1, runtime: "mock" }).id;
    w.active.set(s1, { idle: STUCK_MS + 60_000, gate: null });
    w.active.set(s2, { idle: STUCK_MS * 4, gate: "gateB" });
    w.active.set(s3, { idle: 60_000, gate: null });
    const did = w.sup.tick();
    expect(w.stopped).toEqual([{ run: s1, by: "supervisor" }]);
    expect(did[0]).toMatchObject({ action: "stuck", run: s1 });
    expect(w.held[0]).toBe(true);
    // Stopped by the supervisor, so the next look tries it again.
    w.active.clear();
    w.sup.tick();
    expect(w.retried.map((r) => r.run)).toContain(s1);
  });

  it("stays inside today's auto-work limit and does nothing with auto-work off", () => {
    const full = world({ spentToday: AUTO_WORK_DEFAULT.dailyUsd - 0.1 });
    full.startRun("The run took longer than 90 minutes.");
    expect(full.sup.tick()[0]).toMatchObject({ action: "held" });
    expect(full.retried).toEqual([]);
    const off = world({ auto: false });
    off.startRun("The run took longer than 90 minutes.");
    off.sup.tick();
    expect(off.retried).toEqual([]);
    expect(off.dispatched()).toBe(0);
    expect(off.sup.state().why).toMatch(/auto-work is off/);
  });
});
