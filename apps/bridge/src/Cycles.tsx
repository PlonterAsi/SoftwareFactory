import { useEffect, useState } from "react";
import { API, type EngineReviewView } from "./api";

/**
 * Engine cycles: the same prompt built more than once, each run a column. A benchmark run tests the factory's
 * engine, so the page reads across: which app version built it, how the design loop and the product judge scored,
 * what it cost, and the engine's own review of what it did badly and well.
 */
interface CycleRun {
  run: number; cycle: number; startedAt: string; appVersion: string | null; outcome: string; reason: string;
  spentUsd: number; maxUsd: number; minutes: number; agentCalls: number;
  design: { rounds: number; passed: boolean; scores: Record<string, number> } | null;
  judge: { looks: number; passed: boolean; scores: Record<string, number>; met: number; of: number } | null;
  review: EngineReviewView | null;
}
interface EngineCycle { prompt: string; name: string; runs: CycleRun[] }

const money = (n: number) => `$${n.toFixed(2)}`;
const scores = (s: Record<string, number>) => Object.entries(s).map(([k, v]) => `${k} ${v}`).join(" · ") || "no scores";

export function Cycles({ onShowRun, tick }: { onShowRun: (run: number) => void; tick: number }) {
  const [cycles, setCycles] = useState<EngineCycle[] | null>(null);
  const [at, setAt] = useState(0);
  useEffect(() => {
    let live = true;
    fetch(`${API}/api/factory/cycles`).then((r) => r.json()).then((j) => { if (live) setCycles(j.cycles ?? []); }).catch(() => { /* core down: CoreDown speaks */ });
    return () => { live = false; };
  }, [tick]);
  const c = cycles?.[Math.min(at, (cycles?.length ?? 1) - 1)];
  return (
    <section className="pane fpage cycles" aria-label="Engine cycles">
      <header className="page-head">
        <h1>Engine cycles</h1>
        <p>The same prompt, built again after each engine change. Read across to see whether the engine got better: the product's score is only the measurement.</p>
      </header>
      {cycles == null ? <div className="empty">Loading…</div>
        : !c ? <div className="empty">No prompt has been built twice yet. Build the same idea again after an engine change and the runs line up here, side by side.</div>
        : (
          <>
            {cycles.length > 1 && <div className="rounds cycles-pick">{cycles.map((x, i) => <button key={x.runs[0].run} className={`tiny ${x === c ? "" : "ghost"}`} onClick={() => setAt(i)}>{x.name} · {x.runs.length}</button>)}</div>}
            <details className="cycles-prompt"><summary>{c.name}: the prompt every cycle gets</summary><pre>{c.prompt}</pre></details>
            <div className="cycles-grid" style={{ gridTemplateColumns: `repeat(${c.runs.length}, minmax(300px, 1fr))` }}>
              {c.runs.map((r) => (
                <article key={r.run} className="cycle-col">
                  <header>
                    <h2>Cycle {r.cycle}</h2>
                    <button className="tiny ghost" onClick={() => onShowRun(r.run)}>Run {r.run}</button>
                  </header>
                  <div className={`product-verdict ${r.outcome === "shipped" ? "ok" : r.outcome === "running" ? "" : "warn"}`}>{r.outcome} · {money(r.spentUsd)} of {money(r.maxUsd)} · {r.minutes} min · {r.agentCalls} calls</div>
                  <table className="product-reqs"><tbody>
                    <tr><td>Engine</td><td className="mono">{r.appVersion ? `v${r.appVersion}` : "dev"} · {new Date(r.startedAt).toLocaleString()}</td></tr>
                    <tr className={r.design && !r.design.passed ? "unmet" : ""}><td>Design loop</td><td>{r.design ? `${r.design.rounds} round${r.design.rounds === 1 ? "" : "s"}, ${r.design.passed ? "passed" : "did not pass"}: ${scores(r.design.scores)}` : "no design loop"}</td></tr>
                    <tr className={r.judge && !r.judge.passed ? "unmet" : ""}><td>Product judge</td><td>{r.judge ? `${r.judge.met} of ${r.judge.of} requirements seen working after ${r.judge.looks} look${r.judge.looks === 1 ? "" : "s"}: ${scores(r.judge.scores)}` : "not judged"}</td></tr>
                    {r.reason && <tr><td>Ended</td><td>{r.reason}</td></tr>}
                  </tbody></table>
                  {r.review ? (
                    <>
                      <h3 className="cycle-h bad">What the engine did badly ({r.review.bad.length})</h3>
                      <ul className="cycle-list">{r.review.bad.map((x, i) => <li key={i}>{x}</li>)}</ul>
                      <h3 className="cycle-h good">What the engine did well ({r.review.good.length})</h3>
                      <ul className="cycle-list">{r.review.good.map((x, i) => <li key={i}>{x}</li>)}</ul>
                      <h3 className="cycle-h">Agents</h3>
                      <table className="product-reqs"><tbody>
                        {r.review.agents.map((a) => <tr key={a.agent} className={a.fails > a.passes || a.failedCalls ? "unmet" : ""}><td className="mono">{a.agent}</td><td>{a.calls} · {money(a.costUsd)}</td><td>{a.passes} passed · {a.fails} not{a.failedCalls ? ` · ${a.failedCalls} failed` : ""}</td></tr>)}
                      </tbody></table>
                    </>
                  ) : <div className="empty">Still running. The engine review appears when the run ends.</div>}
                </article>
              ))}
            </div>
          </>
        )}
    </section>
  );
}
