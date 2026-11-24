import { useEffect, useState } from "react";
import { API } from "./api";

/**
 * The supervisor at a glance (core factory/supervisor.ts, GET /api/supervisor): whether the PC is held awake while
 * the crew works, the last time it slept, each run in flight with the minutes since its last sign of progress, and
 * what the supervisor did lately (cut a stuck run, tried a stopped one again, handed one to you).
 */
interface SupervisorState {
  on: boolean;
  why: string;
  lastTickAt: string | null;
  awake: { on: boolean; why: string; lastSleep: { from: string; to: string; minutes: number } | null };
  working: { run: number; idleMinutes: number; gate: string | null }[];
  recent: { at: string; action: "stuck" | "retry" | "escalated" | "held"; run: number; ticket: number | null; text: string }[];
}

const STUCK_AT = 30;
const ICON: Record<string, string> = { stuck: "✂", retry: "↻", escalated: "!", held: "⏸" };
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function SupervisorCard({ onShowRun }: { onShowRun?: (run: number) => void }) {
  const [s, setS] = useState<SupervisorState | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => fetch(`${API}/api/supervisor`).then((r) => (r.ok ? r.json() : null)).then((j) => { if (live && j) setS(j); }).catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => { live = false; clearInterval(t); };
  }, []);
  if (!s) return null;
  return (
    <section className="sup-card" aria-label="Supervisor">
      <header className="sup-head">
        <span className={"sup-dot " + (s.on ? "on" : "off")} aria-hidden />
        <strong>Supervisor</strong>
        <span className="muted">{s.why}</span>
        <span className={"sup-chip " + (s.awake.on ? "on" : "")} title={s.awake.why}>{s.awake.on ? "PC held awake" : "PC may sleep"}</span>
        {s.awake.lastSleep ? <span className="sup-chip" title="Sleep never counts as run time">slept {hhmm(s.awake.lastSleep.from)}–{hhmm(s.awake.lastSleep.to)} ({s.awake.lastSleep.minutes} min)</span> : null}
      </header>
      {s.working.length ? (
        <ul className="sup-runs" aria-label="Runs in flight">
          {s.working.map((w) => {
            const pct = Math.min(100, Math.round((w.idleMinutes / STUCK_AT) * 100));
            return (
              <li key={w.run}>
                <button className="link" onClick={() => onShowRun?.(w.run)}>#{w.run}</button>
                {w.gate ? <span className="muted">waits at {w.gate}</span> : (
                  <span className="sup-meter" title={`${w.idleMinutes} min since its last progress; cut at ${STUCK_AT}`}>
                    <span className={"sup-fill " + (pct >= 66 ? "warn" : "")} style={{ width: `${Math.max(4, pct)}%` }} />
                  </span>
                )}
                {!w.gate ? <span className="muted">{w.idleMinutes ? `${w.idleMinutes} min quiet` : "working"}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : <p className="muted sup-empty">Nothing in flight.</p>}
      {s.recent.length ? (
        <ol className="sup-log" aria-label="What the supervisor did lately">
          {s.recent.slice(0, 6).map((a, i) => (
            <li key={i} className={"sup-" + a.action}>
              <span className="sup-icon" aria-hidden>{ICON[a.action]}</span>
              <span className="muted">{hhmm(a.at)}</span>
              <span>{a.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
