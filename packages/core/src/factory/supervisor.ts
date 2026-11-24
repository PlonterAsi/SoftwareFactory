import type { EventLog } from "../events.js";
import type { AutoWork } from "../tickets/shapes.js";
import { keepAwake, lastSleep, type KeepAwake } from "./awake.js";

/**
 * The supervisor (2026-11-24): the one piece of SoftwareFactory responsible for work going on.
 *
 * Assaf found run 10486 stopped, hours after it stopped: "no agent is checking anything, no agent is orchestrating,
 * nothing is responsible for the continuation of work". Until now a run that stopped stayed stopped until someone
 * pressed Retry, the queue moved only when an event happened to wake it, and a hung call waited for its timer.
 *
 * Once a minute, free (no agent call), with auto-work on:
 * 1. Keep-awake: while the crew works, the PC is asked not to sleep (factory/awake.ts).
 * 2. Stuck: a run in flight with no sign of progress for STUCK_MS of awake time (no event, no line streamed by its
 *    agent) is cut at once, not left for its time limit. A run waiting at a gate for you is not stuck.
 * 3. Retry: a run that stopped or failed in the last two days, not on purpose (not stopped by you, not refused money,
 *    not rejected), is tried again from the step it stopped at, with fresh money for what is left, inside the run's
 *    and the project's budget and today's auto-work limit. At most TRIES automatic tries per run (the dispatcher's
 *    count too); after that it waits for you, said once on its ticket.
 * 4. The queue: the dispatcher is asked to start the next ready ticket, so the line never waits for an event.
 */

export const STUCK_MS = Number(process.env.SF_STUCK_MINUTES ?? 30) * 60_000;
export const TRIES = 2;
const LOOK_BACK_MS = 48 * 3_600_000;

/** What the supervisor needs of the factory (a narrow view, so tests can give a fake). */
export interface SupervisedFactory {
  activeIds(): number[];
  activeCount(): number;
  idleMs(run: number): number | null;
  waitingGate(run: number): string | null;
  stop(run: number, o: { by?: string; reason?: string }): { ok: boolean };
  retryable(run: number): { ok: boolean; why?: string; from?: string };
  retryAddUsd(run: number): number;
  retry(run: number, o: { addUsd?: number; by?: string; auto?: boolean }): { run: number; from: string; addUsd: number };
}

/** What it needs of the tickets. */
export interface SupervisedTickets {
  autoWork(): AutoWork;
  autoUsdToday(): number;
  dispatch(): number[];
  retry(id: number, o: { addUsd?: number; by?: string; auto?: boolean }): { run: number; from: string; addUsd: number };
  repoWorkCount(): number;
}

export interface SupervisorAction { at: string; action: "stuck" | "retry" | "escalated" | "held"; run: number; ticket: number | null; text: string }
export interface SupervisorState {
  on: boolean;
  why: string;
  lastTickAt: string | null;
  awake: { on: boolean; why: string; lastSleep: { from: string; to: string; minutes: number } | null };
  working: { run: number; idleMinutes: number; gate: string | null }[];
  recent: SupervisorAction[];
}

/** Why a stopped run is left to you rather than tried again, or null when it may be tried. Pure. */
export function leftToYou(o: { outcome: string; reason: string; stoppedBy: string | null; rejectedBy: string | null }): string | null {
  if (o.outcome === "shipped") return "it shipped";
  if (o.stoppedBy && o.stoppedBy !== "supervisor") return `${o.stoppedBy === "you" ? "you" : o.stoppedBy} stopped it`;
  if (o.rejectedBy && o.rejectedBy !== "auto") return "you said no at a gate";
  if (/budget spent|budget has nothing left|needs \$[\d.]+ more/i.test(o.reason)) return "it needs more money than its budget allows";
  if (/waited for your answer/i.test(o.reason)) return "it waits for your answer";
  if (/failed again the same way/i.test(o.reason)) return "it failed the same way twice: trying again as is would fail again";
  return null;
}

export class Supervisor {
  readonly awake: KeepAwake;
  private recent: SupervisorAction[] = [];
  private lastTickAt: string | null = null;
  private why = "not started yet";

  constructor(private log: EventLog, private factory: SupervisedFactory, private tickets: SupervisedTickets, private o: { canWork?: () => string | null; awake?: KeepAwake; now?: () => number } = {}) {
    this.awake = o.awake ?? keepAwake();
  }

  private now() { return this.o.now?.() ?? Date.now(); }

  /** One look. Returns what it did. Never throws: a look that fails tries again next minute. */
  tick(): SupervisorAction[] {
    const did: SupervisorAction[] = [];
    this.lastTickAt = new Date(this.now()).toISOString();
    try {
      // 1. Keep the PC awake while anything works (a run, or the Builder in a ticket's clone).
      this.awake.set(this.factory.activeCount() > 0 || this.tickets.repoWorkCount() > 0);
      // 2. Stuck runs are cut now.
      for (const run of this.factory.activeIds()) {
        if (this.factory.waitingGate(run)) continue;
        const idle = this.factory.idleMs(run);
        if (idle == null || idle < STUCK_MS) continue;
        const minutes = Math.round(idle / 60_000);
        const r = this.factory.stop(run, { by: "supervisor", reason: `Stuck: no sign of progress for ${minutes} minutes, so the supervisor cut it. It is tried again from the step it was on.` });
        if (r.ok) did.push(this.act("stuck", run, `Run #${run} showed no progress for ${minutes} minutes: cut, to be tried again.`, { idleMinutes: minutes }));
      }
      const rule = this.tickets.autoWork();
      const blocked = this.o.canWork?.() ?? null;
      this.why = !rule.on ? "auto-work is off: stopped runs wait for you" : blocked ? `held: ${blocked}` : "watching: stopped runs are tried again, the queue keeps moving";
      if (!rule.on || blocked) return this.keep(did);
      // 3. One stopped run tried again per look, while there is room to work.
      if (this.factory.activeCount() < rule.wip) {
        const a = this.retryOne(rule);
        if (a) did.push(a);
      }
      // 4. The queue moves whether or not an event woke it.
      this.tickets.dispatch();
    } catch (e) {
      this.why = `the last look failed: ${(e as Error).message.slice(0, 200)}`;
    }
    return this.keep(did);
  }

  private retryOne(rule: AutoWork): SupervisorAction | null {
    const since = new Date(this.now() - LOOK_BACK_MS).toISOString();
    const rows = this.log.db.prepare("SELECT id, outcome, reason FROM factory_runs WHERE outcome IN ('stopped', 'failed') AND finished_at >= ? ORDER BY id").all(since) as { id: number; outcome: string; reason: string | null }[];
    for (const r of rows) {
      const run = Number(r.id);
      if (!this.factory.retryable(run).ok) continue;
      const life = this.life(run);
      const ticket = this.ticketOf(run);
      const mine = leftToYou({ outcome: r.outcome, reason: r.reason ?? "", stoppedBy: life.stoppedBy, rejectedBy: life.rejectedBy });
      if (mine) continue;
      if (life.tries >= TRIES) {
        if (life.escalated) continue;
        const text = `Run #${run} stopped again after ${life.tries} tries by itself (${(r.reason ?? "").slice(0, 200)}). It needs you: look at it, then press Retry, or close it.`;
        if (ticket != null) this.log.append("ticket.noted", { id: ticket, by: "supervisor", kind: "event", needsYou: true, text });
        return this.act("escalated", run, text, { ticket });
      }
      const add = Number(Math.min(this.factory.retryAddUsd(run), rule.askedMaxUsd).toFixed(2));
      const left = rule.dailyUsd - this.tickets.autoUsdToday();
      if (add > left + 1e-9) {
        // Said once a day per run, not every minute.
        if (!this.saidToday(run, "held")) return this.act("held", run, `Run #${run} waits for tomorrow: a try needs $${add.toFixed(2)} and today's auto-work limit has $${Math.max(0, left).toFixed(2)} left.`, { ticket, addUsd: add });
        continue;
      }
      const why = (r.reason ?? "it stopped").slice(0, 200);
      try {
        if (ticket != null) {
          // Written as the dispatcher's start, so it counts toward today's auto-work limit like any other.
          this.log.append("ticket.noted", { id: ticket, by: "dispatcher", auto: 1, capUsd: add, kind: "event", text: `The supervisor tries run #${run} again on its own (try ${life.tries + 1} of ${TRIES}) from the step it stopped at, with $${add.toFixed(2)} more. It had stopped: ${why}` });
          this.tickets.retry(ticket, { addUsd: add, by: "supervisor", auto: true });
        } else this.factory.retry(run, { addUsd: add, by: "supervisor", auto: true });
        return this.act("retry", run, `Run #${run} tried again (try ${life.tries + 1} of ${TRIES}) with $${add.toFixed(2)} more. It had stopped: ${why}`, { ticket, addUsd: add, try: life.tries + 1 });
      } catch (e) {
        this.log.append("factory.supervisor", { action: "failed", run, ticket, text: (e as Error).message.slice(0, 300) });
      }
    }
    return null;
  }

  /** What happened to a run since it started: who stopped it last, a rejected gate, how often it was tried again by itself. */
  private life(run: number): { stoppedBy: string | null; rejectedBy: string | null; tries: number; escalated: boolean } {
    const evs = this.log.db.prepare("SELECT id, type, payload FROM events WHERE id >= ? AND type IN ('factory.run.stop', 'factory.gate', 'factory.run.retried', 'factory.run.resumed', 'factory.supervisor') AND json_extract(payload, '$.run') = ? ORDER BY id").all(run, run) as { id: number; type: string; payload: string }[];
    let stoppedBy: string | null = null;
    let rejectedBy: string | null = null;
    let tries = 0;
    let escalated = false;
    for (const e of evs) {
      const p = JSON.parse(e.payload) as { by?: string; state?: string; action?: string; auto?: boolean };
      // A try (yours or the crew's) starts the story over: what counts is what stopped it after the last one.
      if (e.type === "factory.run.retried" || e.type === "factory.run.resumed") {
        stoppedBy = null; rejectedBy = null;
        if (e.type === "factory.run.retried" && (p.by === "supervisor" || p.by === "dispatcher")) tries++;
        if (e.type === "factory.run.retried" && p.by !== "supervisor" && p.by !== "dispatcher") { tries = 0; escalated = false; }
      } else if (e.type === "factory.run.stop") stoppedBy = p.by ?? "you";
      else if (e.type === "factory.gate" && p.state === "rejected") rejectedBy = p.by ?? "you";
      else if (e.type === "factory.supervisor" && p.action === "escalated") escalated = true;
    }
    return { stoppedBy, rejectedBy, tries, escalated };
  }

  private ticketOf(run: number): number | null {
    try {
      const r = this.log.db.prepare("SELECT id FROM tickets WHERE run = ? ORDER BY id DESC LIMIT 1").get(run) as { id: number } | undefined;
      return r ? Number(r.id) : null;
    } catch { return null; }
  }

  private saidToday(run: number, action: string): boolean {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    return !!this.log.db.prepare("SELECT 1 FROM events WHERE type = 'factory.supervisor' AND json_extract(payload, '$.action') = ? AND json_extract(payload, '$.run') = ? AND ts >= ? LIMIT 1").get(action, run, day);
  }

  private act(action: SupervisorAction["action"], run: number, text: string, extra: Record<string, unknown> = {}): SupervisorAction {
    const ticket = (extra.ticket as number | null | undefined) ?? this.ticketOf(run);
    this.log.append("factory.supervisor", { action, run, ticket, text, ...extra });
    return { at: new Date(this.now()).toISOString(), action, run, ticket, text };
  }

  private keep(did: SupervisorAction[]): SupervisorAction[] {
    if (did.length) this.recent = [...did, ...this.recent].slice(0, 20);
    return did;
  }

  /** For the Bridge (GET /api/supervisor): what it watches, what it did lately, whether the PC is held awake. */
  state(): SupervisorState {
    const rule = this.tickets.autoWork();
    const sleep = lastSleep(this.now() - 24 * 3_600_000);
    if (!this.recent.length) {
      // After a restart: what it did lately, from the log.
      const rows = this.log.db.prepare("SELECT ts, payload FROM events WHERE type = 'factory.supervisor' ORDER BY id DESC LIMIT 20").all() as { ts: string; payload: string }[];
      this.recent = rows.map((r) => { const p = JSON.parse(r.payload) as { action: SupervisorAction["action"]; run: number; ticket: number | null; text: string }; return { at: r.ts, action: p.action, run: p.run, ticket: p.ticket ?? null, text: p.text }; }).filter((a) => a.action !== ("failed" as string));
    }
    return {
      on: rule.on, why: this.why, lastTickAt: this.lastTickAt,
      awake: { on: this.awake.on, why: this.awake.why, lastSleep: sleep ? { from: new Date(sleep.from).toISOString(), to: new Date(sleep.to).toISOString(), minutes: Math.round((sleep.to - sleep.from) / 60_000) } : null },
      working: this.factory.activeIds().map((run) => ({ run, idleMinutes: Math.round((this.factory.idleMs(run) ?? 0) / 60_000), gate: this.factory.waitingGate(run) })),
      recent: this.recent,
    };
  }
}
