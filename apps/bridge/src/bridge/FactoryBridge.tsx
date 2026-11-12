import { useEffect, useState } from "react";
import type { AgentRunView, FactoryRunView, ProjectSummary } from "../api";
import type { CrewIndex } from "../FactoryFloor";
import { href, type BridgeMode } from "../projects/router";
import { SignalLoom } from "./SignalLoom";

/** The modes of the Factory Bridge. Each answers one question about the factory. */
export const BRIDGE_MODES: { id: BridgeMode; name: string; asks: string }[] = [
  { id: "loom", name: "Signal Loom", asks: "Where is every build, and which one waits for me?" },
];

/**
 * Factory Bridge: the dashboard over the whole factory. A status strip on top (what needs you,
 * who works, what runs, what it cost today), then one mode at a time.
 */
export function FactoryBridge({ mode, factoryRuns, runs, crew, projects, projectOfRun, onShowRun }: {
  mode: BridgeMode; factoryRuns: FactoryRunView[]; runs: AgentRunView[]; crew: CrewIndex; projects: ProjectSummary[] | null;
  projectOfRun: Record<number, number>; onShowRun: (run: number) => void;
}) {
  // Elapsed times tick every few seconds; nothing else animates while the factory is idle.
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(t); }, []);
  const waiting = factoryRuns.filter((r) => r.waiting && !r.finished).length;
  const working = new Set(runs.filter((r) => r.state === "running").map((r) => r.agent)).size;
  const open = factoryRuns.filter((r) => !r.finished).length;
  const today = new Date(now).toDateString();
  const spentToday = runs.filter((r) => new Date(r.startedAt).toDateString() === today).reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const name = (run: number) => { const p = projectOfRun[run]; return p != null ? projects?.find((x) => x.id === p)?.name : undefined; };
  const current = BRIDGE_MODES.find((m) => m.id === mode) ?? BRIDGE_MODES[0];
  return (
    <section className="pane fpage fbridge" aria-label="Factory Bridge">
      <header className="page-head fb-head">
        <div><h1>Factory Bridge</h1><p>{current.asks}</p></div>
        {BRIDGE_MODES.length > 1 && (
          <nav className="fb-modes" aria-label="Bridge modes">
            {BRIDGE_MODES.map((m) => <a key={m.id} href={href({ page: "bridge", mode: m.id })} aria-current={m.id === current.id ? "page" : undefined}>{m.name}</a>)}
          </nav>
        )}
      </header>
      <div className="fb-strip" role="status">
        {waiting > 0
          ? <a className="fb-pill needs" href={href({ page: "needs" })}><span className="fb-dia" aria-hidden /><b className="mono">{waiting}</b> waiting for your OK</a>
          : <span className="fb-pill">Nothing waits for you</span>}
        <span className="fb-stat">Agents working <b className="mono">{working}</b></span>
        <span className="fb-stat">Builds running <b className="mono">{open}</b></span>
        <span className="fb-stat">Spent today <b className="mono">${spentToday.toFixed(2)}</b></span>
      </div>
      {current.id === "loom" && <SignalLoom factoryRuns={factoryRuns} runs={runs} crew={crew} projectOf={name} onShowRun={onShowRun} now={now} />}
    </section>
  );
}
