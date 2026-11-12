import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { SLOTS, type AgentRunView, type AgentView, type FactoryRunView } from "../api";
import { LOOM_STATIONS } from "./SignalLoom";

/**
 * Partitura: who works, and when. One staff per agent, one note per agent call (length is time,
 * brightness is cost, red is a failed call, a teal note is working now). Each build keeps its own
 * thin line inside a staff so parallel builds stay apart. Timetable redraws the same calls per
 * build down the stations, so a fix loop shows as a sawtooth.
 */
type Win = "fit" | "1h" | "24h" | "all";
const WINS: [Win, string][] = [["fit", "Work sessions"], ["1h", "Last hour"], ["24h", "24 hours"], ["all", "All"]];
const ROWS = LOOM_STATIONS.filter(([id]) => ["council", "plan", "tests", "build", "review", "fix"].includes(id));
const TINTS = ["var(--accent)", "var(--ink-2)", "var(--good)", "var(--agent)", "#7fb4ff"];

function clock(ms: number, span: number) {
  const d = new Date(ms);
  const t = d.toLocaleTimeString(undefined, span < 5 * 60e3 ? { hour: "2-digit", minute: "2-digit", second: "2-digit" } : { hour: "2-digit", minute: "2-digit" });
  return span > 36 * 3600_000 ? `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${t}` : t;
}
const niceStep = (span: number) => [5e3, 15e3, 30e3, 60e3, 300e3, 600e3, 1800e3, 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 86400e3, 7 * 86400e3].find((s) => span / s <= 8) ?? 30 * 86400e3;
const slotOrder = (s: string) => { const i = (SLOTS as readonly string[]).indexOf(s); return i < 0 ? 99 : i; };

type Call = AgentRunView & { a: number; b: number };

export function Partitura({ runs, agents, factoryRuns, now, onShowRun }: {
  runs: AgentRunView[]; agents: AgentView[]; factoryRuns: FactoryRunView[]; now: number; onShowRun: (run: number) => void;
}) {
  const [mode, setMode] = useState<"score" | "time">("score");
  const calls = useMemo<Call[]>(() => runs.filter((r) => !r.bayTest).map((r) => {
    const a = Date.parse(r.startedAt);
    return { ...r, a, b: r.state === "running" ? now : a + Math.max(r.durationMs ?? 0, 3000) };
  }), [runs, now]);
  // Work sessions: calls with less than 20 minutes between them belong together. The default
  // window is the latest session, so a burst of work fills the score instead of shrinking to dots.
  const [win, setWin] = useState<Win>("fit");
  const sessions = useMemo(() => {
    const out: { from: number; to: number; count: number }[] = [];
    for (const c of [...calls].sort((p, q) => p.a - q.a)) {
      const s = out[out.length - 1];
      if (s && c.a - s.to < 20 * 60e3) { s.to = Math.max(s.to, c.b); s.count++; } else out.push({ from: c.a, to: c.b, count: 1 });
    }
    return out;
  }, [calls]);
  const [pick, setPick] = useState<number | null>(null);
  const si = pick == null || pick >= sessions.length ? sessions.length - 1 : pick;
  const sess = sessions[si];
  const firstAt = calls.length ? Math.min(...calls.map((c) => c.a)) : now - 3600e3;
  const lastAt = calls.length ? Math.max(...calls.map((c) => c.b)) : now;
  let from: number, to: number;
  if (win === "fit" && sess) {
    const pad = Math.max(10e3, (sess.to - sess.from) * 0.04);
    from = sess.from - pad;
    to = si === sessions.length - 1 && now - sess.to < 20 * 60e3 ? Math.max(now, sess.to) + pad : sess.to + pad;
  } else {
    to = Math.max(now, lastAt);
    from = win === "1h" ? now - 3600e3 : win === "24h" ? now - 86400e3 : firstAt - 60e3;
  }
  const span = Math.max(60e3, to - from);
  const shown = calls.filter((c) => c.b >= from && c.a <= to);

  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(1100);
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(720, Math.floor(e.contentRect.width))));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const L = 190, R = 24, x = (t: number) => L + ((W - L - R) * (t - from)) / span;
  const step = niceStep(span);
  const ticks: number[] = [];
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) ticks.push(t);
  const [tip, setTip] = useState<{ x: number; y: number; html: ReactNode } | null>(null);

  const staff = agents.filter((a) => !a.retired || shown.some((c) => c.agent === a.def.id)).sort((p, q) => slotOrder(p.def.station) - slotOrder(q.def.station));
  const runIds = [...new Set(shown.map((c) => c.factoryRun).filter((r): r is number => r != null))].sort((p, q) => p - q);
  const lane = (run?: number) => (run == null ? 0 : runIds.indexOf(run) % 5);
  const nameOf = (run?: number) => { const r = factoryRuns.find((f) => f.run === run); return r ? r.plan?.name ?? r.idea.slice(0, 40) : undefined; };
  const agentName = (id: string) => agents.find((a) => a.def.id === id)?.def.name ?? id;
  const showTip = (e: MouseEvent, c: Call) => setTip({
    x: e.clientX, y: e.clientY,
    html: <>
      <b>{agentName(c.agent)}</b> · {c.station ?? "chat"}<br />
      {c.factoryRun != null && <>{nameOf(c.factoryRun)} <span className="mono">#{c.factoryRun}</span><br /></>}
      <span className="mono">{c.state === "running" ? "working now" : `$${(c.costUsd ?? 0).toFixed(4)} · ${Math.round((c.b - c.a) / 1000)}s${c.state === "failed" ? " · failed" : ""}`}</span>
    </>,
  });

  let H: number;
  let body: ReactNode;
  if (mode === "score") {
    const top = 34, RH = 30;
    H = top + Math.max(1, staff.length) * RH + 30;
    body = <>
      {ticks.map((t) => <g key={t}><line x1={x(t)} y1={top - 8} x2={x(t)} y2={H - 24} stroke="var(--line)" /><text x={x(t)} y={H - 8} textAnchor="middle" fontSize={12} fill="var(--muted)" fontFamily="var(--mono)">{clock(t, span)}</text></g>)}
      {staff.map((a, i) => {
        const y = top + i * RH, busy = shown.some((c) => c.agent === a.def.id && c.state === "running");
        return <g key={a.def.id}>
          <line x1={L} y1={y + RH / 2} x2={W - R} y2={y + RH / 2} stroke="var(--line)" />
          <text x={10} y={y + RH / 2 + 5} fontSize={14} fill={busy ? "var(--agent)" : "var(--muted)"} opacity={busy ? 1 : 0.6}>{a.def.avatar}</text>
          <text x={32} y={y + RH / 2 + 5} fontSize={13.5} fill={busy ? "var(--ink)" : "var(--ink-2)"}>{a.def.name}</text>
          <text x={L - 10} y={y + RH / 2 + 4} textAnchor="end" fontSize={11.5} fill="var(--muted)" fontFamily="var(--mono)">{a.def.model}</text>
        </g>;
      })}
      {shown.map((c) => {
        const i = staff.findIndex((a) => a.def.id === c.agent);
        if (i < 0) return null;
        const y = top + i * RH + 4 + lane(c.factoryRun) * 4.4, open = c.state === "running";
        const fill = open ? "var(--accent)" : c.state === "failed" ? "var(--bad)" : "var(--ink-2)";
        const x0 = Math.max(L, x(c.a));
        return <rect key={c.runId} x={x0} y={y} width={Math.max(3, x(c.b) - x0)} height={3.6} rx={1.5} fill={fill}
          opacity={open ? 1 : Math.min(1, 0.45 + (c.costUsd ?? 0) * 10)} className="pt-note"
          onMouseMove={(e) => showTip(e, c)} onMouseLeave={() => setTip(null)} onClick={() => c.factoryRun != null && onShowRun(c.factoryRun)} />;
      })}
      {now >= from && now <= to && <><line x1={x(now)} y1={top - 14} x2={x(now)} y2={H - 24} stroke="var(--accent)" strokeWidth={1.5} /><text x={x(now) - 6} y={top - 16} textAnchor="end" fontSize={12} fill="var(--accent)">now</text></>}
    </>;
  } else {
    const top = 24, RH = 40;
    H = top + ROWS.length * RH + 30;
    const yOf = (s?: string) => top + ROWS.findIndex(([id]) => id === s) * RH;
    body = <>
      {ROWS.map(([id, label], i) => <g key={id}><line x1={L} y1={top + i * RH} x2={W - R} y2={top + i * RH} stroke="var(--line)" /><text x={L - 12} y={top + i * RH + 4} textAnchor="end" fontSize={13.5} fill="var(--ink-2)">{label}</text></g>)}
      {ticks.map((t) => <text key={t} x={x(t)} y={H - 8} textAnchor="middle" fontSize={12} fill="var(--muted)" fontFamily="var(--mono)">{clock(t, span)}</text>)}
      {runIds.map((run, ri) => {
        const cs = shown.filter((c) => c.factoryRun === run && ROWS.some(([id]) => id === c.station)).sort((p, q) => p.a - q.a);
        if (!cs.length) return null;
        const d = cs.map((c, k) => `${k ? "L" : "M"}${Math.max(L, x(c.a))} ${yOf(c.station)}L${x(c.b)} ${yOf(c.station)}`).join("");
        const last = cs[cs.length - 1], fr = factoryRuns.find((f) => f.run === run), wait = !!fr?.waiting && !fr.finished, tint = TINTS[ri % TINTS.length];
        return <g key={run} className="pt-run" onClick={() => onShowRun(run)}>
          <path d={d} fill="none" stroke={tint} strokeWidth={2.2} strokeLinejoin="round" opacity={0.9} />
          <circle cx={x(last.b)} cy={yOf(last.station)} r={4.5} fill={wait ? "var(--gate)" : tint} />
          <text x={x(last.b) + 8} y={yOf(last.station) - 7} fontSize={12} fill={tint}>{nameOf(run) ?? `#${run}`}</text>
        </g>;
      })}
    </>;
  }
  return (
    <div className="pt">
      <div className="pt-bar">
        <span className="fb-seg" role="group" aria-label="View">
          <button aria-pressed={mode === "score"} onClick={() => setMode("score")}>Score</button>
          <button aria-pressed={mode === "time"} onClick={() => setMode("time")}>Timetable</button>
        </span>
        <span className="fb-seg" role="group" aria-label="Time window">
          {WINS.map(([w, label]) => <button key={w} aria-pressed={win === w} onClick={() => setWin(w)}>{label}</button>)}
        </span>
        {win === "fit" && sessions.length > 1 && (
          <span className="fb-seg" role="group" aria-label="Session">
            <button disabled={si <= 0} onClick={() => setPick(si - 1)} aria-label="Earlier session">‹ Earlier</button>
            <button disabled aria-pressed="true">{si + 1} of {sessions.length}</button>
            <button disabled={si >= sessions.length - 1} onClick={() => setPick(si + 1)} aria-label="Later session">Later ›</button>
          </span>
        )}
        <span className="muted">{shown.length} agent call{shown.length === 1 ? "" : "s"} · <span className="mono">${shown.reduce((s, c) => s + (c.costUsd ?? 0), 0).toFixed(3)}</span></span>
      </div>
      <div className="loom-scroll" ref={box}>
        {shown.length === 0
          ? <p className="muted pt-empty">No agent calls in this window. Pick a wider window, or start a build.</p>
          : <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="loom-svg" role="img" aria-label={mode === "score" ? "Agent calls over time" : "Builds down the stations over time"}>{body}</svg>}
      </div>
      {tip && <div className="pt-tip" style={{ left: Math.min(tip.x + 14, window.innerWidth - 300), top: tip.y + 14 }}>{tip.html}</div>}
    </div>
  );
}
