import { useEffect, useRef, useState } from "react";
import type { AgentRunView, FactoryRunView, StationState } from "../api";
import { GateActions } from "../GateActions";
import type { CrewIndex } from "../FactoryFloor";

/**
 * Signal Loom: the factory floor for every build at once. One lane per build through the eleven
 * stations, lamps where an agent works, a knot per fix round, and the two "Your OK" signals that
 * hold a build in amber until you clear it. Under it, a departure board with waiting builds first.
 * Plain SVG, redrawn only when events arrive (no animation loop), so it runs on any GPU.
 */
export const LOOM_STATIONS: [string, string][] = [
  ["intake", "Idea"], ["council", "Council"], ["discover", "Design"], ["plan", "Plan"], ["gateA", "Your OK"], ["tests", "Write tests"], ["build", "Build"],
  ["test", "Run tests"], ["review", "Review"], ["fix", "Fix"], ["gateB", "Your OK"], ["ship", "Ship"],
];
const IDX: Record<string, number> = Object.fromEntries(LOOM_STATIONS.map(([id], i) => [id, i]));
const LABEL: Record<string, string> = { intake: "Idea", council: "Council", discover: "Product design", plan: "Plan", gateA: "Your OK: plan", tests: "Write tests", build: "Build", test: "Run tests", review: "Review", fix: "Fix", gateB: "Your OK: build", ship: "Ship" };

const isWaiting = (r: FactoryRunView) => !!r.waiting && !r.finished;
const runName = (r: FactoryRunView) => r.plan?.name ?? (r.idea.length > 38 ? r.idea.slice(0, 36) + "…" : r.idea);

/** Where a build is now: the active (or waiting) station, else the furthest one it reached. */
export function currentStation(r: FactoryRunView): string {
  if (r.finished?.outcome === "shipped") return "ship";
  if (r.waiting?.gate && IDX[r.waiting.gate] != null) return r.waiting.gate;
  if (r.waiting?.station && IDX[r.waiting.station] != null) return r.waiting.station;
  const active = Object.entries(r.stations).find(([, s]) => s.state === "active" || s.state === "waiting");
  if (active && IDX[active[0]] != null) return active[0];
  let best = "intake";
  for (const id of Object.keys(r.stations)) if (IDX[id] != null && IDX[id] > IDX[best] && r.stations[id].state !== "idle") best = id;
  return best;
}

function fmtDur(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const h = Math.floor(s / 3600);
  return h < 48 ? `${h}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(h / 24)}d`;
}

/** Which builds get a lane: every unfinished one, then the latest finished, at most `max`. */
export function loomLanes(runs: FactoryRunView[], max = 8): FactoryRunView[] {
  const open = runs.filter((r) => !r.finished).sort((a, b) => Number(isWaiting(b)) - Number(isWaiting(a)) || b.run - a.run);
  const done = runs.filter((r) => r.finished).sort((a, b) => b.run - a.run);
  return [...open, ...done].slice(0, Math.max(max, open.length));
}

export function SignalLoom({ factoryRuns, runs, crew, projectOf, onShowRun, now = Date.now() }: {
  factoryRuns: FactoryRunView[]; runs: AgentRunView[]; crew: CrewIndex; projectOf: (run: number) => string | undefined;
  onShowRun: (run: number) => void; now?: number;
}) {
  const lanes = loomLanes(factoryRuns);
  const [open, setOpen] = useState<number | null>(null);
  const openRun = lanes.find((r) => r.run === open && isWaiting(r));
  const working = (run: number) => runs.filter((a) => a.state === "running" && a.factoryRun === run);
  // Drawn at the pane's real width so text stays at its true size; below 720px the floor scrolls sideways.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(1100);
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(720, Math.floor(e.contentRect.width))));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const L = W < 1000 ? 170 : 210, CW = (W - L - 20) / LOOM_STATIONS.length, narrow = CW < 85, HEAD = narrow ? 108 : 100, LANE = 72, H = HEAD + Math.max(1, lanes.length) * LANE + 16;
  const cx = (i: number) => L + CW * i + CW / 2;
  const glyph = (id: string) => crew[id]?.avatar ?? "◆";

  const stationBusy = (id: string): string[] => [...new Set(runs.filter((a) => a.state === "running" && a.factoryRun != null && a.station === id).map((a) => a.agent))];
  const anyWait = (id: string) => lanes.some((r) => isWaiting(r) && currentStation(r) === id);

  const dotFill = (s: StationState | undefined, wait: boolean) =>
    wait ? "var(--gate)" : s === "active" ? "var(--accent)" : s === "pass" ? "var(--good)" : s === "fail" || s === "incomplete" ? "var(--bad)" : s === "skipped" ? "none" : "var(--panel-2)";

  return (
    <div className="loom">
      <div className="loom-scroll" ref={box}>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="loom-svg" role="img" aria-label={`Factory floor: ${lanes.length} builds`}>
          {LOOM_STATIONS.map(([id, label], i) => {
            const x = cx(i), gate = id.startsWith("gate"), busy = gate ? [] : stationBusy(id), wait = anyWait(id), on = busy.length > 0;
            return (
              <g key={id}>
                {gate ? <>
                  <line x1={x} y1={22} x2={x} y2={62} stroke="var(--line-3)" strokeWidth={2} />
                  <rect x={x - 11} y={14} width={22} height={22} rx={4} fill="var(--panel-2)" stroke={wait ? "var(--gate)" : "var(--line-2)"} />
                  <circle className="loom-lamp" cx={x} cy={25} r={6} fill={wait ? "var(--gate)" : "var(--good)"} opacity={wait ? 1 : 0.5} />
                </> : <>
                  <rect className="loom-lamp" x={x - CW / 2 + 6} y={12} width={CW - 12} height={50} rx={8} fill={on ? "var(--accent-dim)" : "var(--panel)"} stroke={on ? "var(--accent)" : "var(--line-2)"} />
                  <circle className="loom-lamp" cx={x - CW / 2 + 18} cy={24} r={4} fill={on ? "var(--accent)" : "var(--muted)"} opacity={on ? 1 : 0.4} />
                  {on && <text x={x + CW / 2 - 14} y={29} textAnchor="end" fontSize={13} fill="var(--agent)">{busy.map(glyph).join(" ")}</text>}
                </>}
                <text x={x} y={narrow ? (i % 2 ? 92 : 76) : gate ? 82 : 50} textAnchor="middle" fontSize={narrow || gate ? 12.5 : 13.5} fill={wait ? "var(--gate)" : "var(--ink-2)"}>{label}</text>
              </g>
            );
          })}
          <path d={`M${cx(8)} 62 C ${cx(8)} 88, ${cx(6)} 88, ${cx(6)} 62`} fill="none" stroke="var(--line-2)" strokeDasharray="3 4" />
          {!narrow && <text x={(cx(6) + cx(8)) / 2} y={94} textAnchor="middle" fontSize={12} fill="var(--muted)">fix loop back to Run tests</text>}

          {lanes.length === 0 && <text x={W / 2} y={HEAD + 36} textAnchor="middle" fontSize={14} fill="var(--muted)">No builds yet. Type an idea in the Helm (Ctrl K) and press Ctrl Enter to build it.</text>}
          {lanes.map((r, li) => {
            const y = HEAD + li * LANE + LANE / 2, at = currentStation(r), idx = IDX[at] ?? 0, wait = isWaiting(r);
            const done = r.finished?.outcome === "shipped", failed = r.finished?.outcome === "failed", stopped = r.finished?.outcome === "stopped";
            const tone = wait ? "var(--gate)" : done ? "var(--good)" : failed ? "var(--bad)" : stopped ? "var(--muted)" : "var(--accent)";
            const ag = working(r.run);
            const spentPct = Math.min(1, r.spentUsd / (r.maxUsd || 1));
            return (
              <g key={r.run} className={`loom-lane${wait ? " wait" : ""}`} tabIndex={0} role="button"
                aria-label={`${runName(r)}: ${wait ? "waiting for your OK" : LABEL[at] ?? at}`}
                onClick={() => (wait ? setOpen(r.run) : onShowRun(r.run))}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); wait ? setOpen(r.run) : onShowRun(r.run); } }}>
                <rect x={0} y={y - LANE / 2 + 4} width={W} height={LANE - 8} rx={10} className="loom-lane-bg" />
                <text x={12} y={y - 6} fontSize={14.5} fill="var(--ink)" fontWeight={500}>{runName(r)}</text>
                <text x={12} y={y + 13} fontSize={12.5} fill="var(--muted)" fontFamily="var(--mono)">#{r.run}  ${r.spentUsd.toFixed(3)} / ${r.maxUsd.toFixed(2)}</text>
                <rect x={12} y={y + 20} width={L - 60} height={3} rx={1.5} fill="var(--panel-2)" />
                <rect x={12} y={y + 20} width={(L - 60) * spentPct} height={3} rx={1.5} fill={spentPct > 0.85 ? "var(--bad)" : "var(--accent)"} />
                <line x1={cx(0)} y1={y} x2={cx(10)} y2={y} stroke="var(--line-2)" strokeWidth={2} />
                <line x1={cx(0)} y1={y} x2={cx(idx)} y2={y} stroke={tone} strokeWidth={2.5} opacity={0.75} />
                {LOOM_STATIONS.map(([id], i) => {
                  const raw = r.stations[id]?.state ?? (i < idx && id !== "council" && id !== "fix" ? "pass" : undefined);
                  const s = r.finished && raw === "active" ? (failed ? "fail" : "idle") : raw;
                  const f = dotFill(s, wait && id === at);
                  return id.startsWith("gate")
                    ? <rect key={id} x={cx(i) - 5} y={y - 5} width={10} height={10} transform={`rotate(45 ${cx(i)} ${y})`} fill={f} />
                    : <circle key={id} cx={cx(i)} cy={y} r={4.5} fill={f} stroke={s === "skipped" ? "var(--line-2)" : "none"} strokeDasharray="2 2" />;
                })}
                {r.fixRounds > 0 && <>
                  {Array.from({ length: r.fixRounds }, (_, k) => <circle key={k} cx={cx(8) + k * 5 - (r.fixRounds - 1) * 2.5} cy={y + 16} r={6} fill="none" stroke="var(--accent)" strokeWidth={1.5} />)}
                  <text x={cx(8) + 14 + r.fixRounds * 3} y={y + 20} fontSize={12} fill="var(--ink-2)" fontFamily="var(--mono)">R{r.fixRounds}/{r.maxFixRounds}</text>
                </>}
                {r.council.length > 0 && <text x={cx(1)} y={y + 22} textAnchor="middle" fontSize={12} fill="var(--muted)" fontFamily="var(--mono)">{r.council.length} round{r.council.length > 1 ? "s" : ""}</text>}
                <g className="loom-token" style={{ transform: `translate(${cx(idx)}px, ${y}px)` }}>
                  <circle r={13} fill="var(--bg)" stroke={tone} strokeWidth={2} />
                  {ag.length > 0 && <text y={-20} textAnchor="middle" fontSize={14} fill="var(--agent)">{ag.map((a) => glyph(a.agent)).join("")}</text>}
                  <text y={4.5} textAnchor="middle" fontSize={12} fill={tone} fontWeight={600}>{wait ? "!" : done ? "✓" : failed ? "×" : stopped ? "■" : "▸"}</text>
                  {wait && <text y={31} textAnchor="middle" fontSize={12.5} fill="var(--gate)">Tap to answer</text>}
                </g>
              </g>
            );
          })}
        </svg>
      </div>
      {openRun && (
        <div className="loom-gate" role="region" aria-label={`Your OK for ${runName(openRun)}`}>
          <div className="loom-gate-head"><b>{runName(openRun)}</b><span className="mono muted">#{openRun.run}</span><button className="ghost sm" onClick={() => setOpen(null)}>Close</button></div>
          <GateActions run={openRun} label={LABEL} />
        </div>
      )}
      <div className="loom-scroll">
        <table className="loom-board">
          <thead><tr><th>Build</th><th>Project</th><th>Station</th><th>Agent</th><th>Time</th><th>Fix rounds</th><th>Budget</th></tr></thead>
          <tbody>
            {lanes.map((r) => {
              const wait = isWaiting(r), at = currentStation(r), ag = working(r.run);
              const end = r.finished ? undefined : now;
              const started = Date.parse(r.startedAt), waitedMs = wait && r.waiting?.at ? now - Date.parse(r.waiting.at) : 0;
              return (
                <tr key={r.run} className={wait ? "wait" : ""} onClick={() => (wait ? setOpen(r.run) : onShowRun(r.run))}>
                  <td className="mono">#{r.run}</td>
                  <td>{projectOf(r.run) ?? runName(r)}</td>
                  <td><span className={`loom-st ${wait ? "n" : r.finished ? (r.finished.outcome === "shipped" ? "g" : r.finished.outcome === "stopped" ? "s" : "b") : "w"}`}><i />{wait ? "Waiting for your OK" : r.finished ? (r.finished.outcome === "shipped" ? "Shipped" : r.finished.outcome === "stopped" ? "Stopped" : "Failed") : LABEL[at] ?? at}</span></td>
                  <td>{ag.length ? <><span className="loom-glyphs">{ag.map((a) => glyph(a.agent)).join("")}</span> {ag.map((a) => crew[a.agent]?.name ?? a.agent).join(", ")}</> : <span className="muted">none</span>}</td>
                  <td className="mono">{end ? fmtDur(end - started) : "done"}{wait && waitedMs > 0 && <span className="loom-waited"> · waiting {fmtDur(waitedMs)}</span>}</td>
                  <td className="mono">{r.fixRounds}/{r.maxFixRounds}</td>
                  <td className="mono"><span className="loom-fuel"><i style={{ width: `${Math.min(100, (r.spentUsd / (r.maxUsd || 1)) * 100)}%` }} /></span>${r.spentUsd.toFixed(3)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
