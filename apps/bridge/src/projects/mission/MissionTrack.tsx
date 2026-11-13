import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Bead, Stop, StopId } from "./model";

/** Room one stop needs across, with its label. */
const CELL = 118;
const ROW = 250;
const BEAD: Record<Bead, string> = { done: "var(--good)", live: "var(--accent)", fail: "var(--bad)", todo: "var(--hover)" };

/**
 * The run as a track: one stop per step, zig-zagging left to right. Done is green, working now
 * pulses teal, waiting for you is an amber diamond. A loop is a ring of beads, one per round.
 */
export function MissionTrack({ stops, selected, onSelect }: { stops: Stop[]; selected: StopId; onSelect: (id: StopId) => void }) {
  // Drawn at the pane's real width: one row when the stops fit, otherwise a path that winds back
  // and forth like a board game, so the labels never shrink below their size.
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(1100);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(320, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const cols = Math.max(3, Math.min(stops.length, Math.floor((w - 20) / CELL)));
  const rows = Math.ceil(stops.length / cols);
  const pad = 56;
  const step = cols > 1 ? (w - pad * 2) / (cols - 1) : 0;
  const pos = stops.map((_, i) => {
    const r = Math.floor(i / cols), c = i % cols;
    const col = r % 2 ? cols - 1 - c : c;
    return { x: pad + col * step, y: 40 + r * ROW + (i % 2 ? 55 : 110) };
  });
  const H = rows * ROW - 20;
  return (
    <div className="mission-track" ref={box}>
      <svg viewBox={`0 0 ${w} ${H}`} width={w} height={H} role="group" aria-label="The run as a track of stops">
        {stops.slice(1).map((b, i) => {
          const a = stops[i], p = pos[i], q = pos[i + 1], mx = (p.x + q.x) / 2;
          const cls = b.state === "live" ? "live" : a.state === "done" && b.state !== "todo" ? "done" : "";
          // Between rows the road turns down the side, like the bend on a board game.
          const turn = Math.abs(p.x - q.x) < 1;
          const side = p.x > w / 2 ? 1 : -1;
          const d = turn
            ? `M${p.x},${p.y} C${p.x + side * 70},${p.y} ${q.x + side * 70},${q.y} ${q.x},${q.y}`
            : `M${p.x},${p.y} C${mx},${p.y} ${mx},${q.y} ${q.x},${q.y}`;
          return <path key={b.id} className={`mt-road ${cls}`} d={d} />;
        })}
        {stops.map((s, i) => {
          const { x, y } = pos[i];
          const r = s.gate ? 22 : 30;
          const up = (i % 2) === 1;
          const ring = s.beads ? r + 9 : 0;
          const ty = up ? y - r - (ring ? 24 : 14) : y + r + (ring ? 30 : 22);
          const beads = s.beads ?? [];
          // More than 12 beads would crowd the ring; keep the latest 12.
          const shown = beads.slice(-12);
          return (
            <g key={s.id} className={`mt-stop s-${s.state}${selected === s.id ? " sel" : ""}`} tabIndex={0} role="button"
              aria-pressed={selected === s.id} aria-label={`${s.label}: ${s.sub}${s.note ? `, ${s.note}` : ""}`}
              onClick={() => onSelect(s.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(s.id); } }}>
              <circle className="mt-hit" cx={x} cy={y} r={r + 16} />
              <circle className="mt-halo" cx={x} cy={y} r={r + (ring ? 17 : 12)} />
              {s.state === "live" && <circle className="mt-pulse" cx={x} cy={y} r={r} />}
              {ring > 0 && <circle className="mt-orbit" cx={x} cy={y} r={ring} />}
              {shown.map((b, k) => {
                const a = -Math.PI / 2 + (k * 2 * Math.PI) / Math.max(shown.length, 1);
                return <circle key={k} className={`mt-bead${b === "live" ? " live" : ""}`} cx={x + ring * Math.cos(a)} cy={y + ring * Math.sin(a)} r={5} fill={BEAD[b]} />;
              })}
              {s.gate
                ? <rect className="mt-disc" x={x - r * 0.75} y={y - r * 0.75} width={r * 1.5} height={r * 1.5} rx={4} transform={`rotate(45 ${x} ${y})`} />
                : <circle className="mt-disc" cx={x} cy={y} r={r} />}
              <g className="mt-icon">{icon(s, x, y)}</g>
              <text className="mt-label" x={x} y={up ? ty - 16 : ty} textAnchor="middle">{s.label}</text>
              <text className="mt-sub" x={x} y={up ? ty : ty + 17} textAnchor="middle">{s.sub}</text>
              {s.note && <text className="mt-note" x={x} y={up ? ty + 15 : ty + 33} textAnchor="middle">{s.note}</text>}
              {beads.length > shown.length && <text className="mt-note" x={x + ring + 8} y={y + 4}>+{beads.length - shown.length}</text>}
            </g>
          );
        })}
      </svg>
      <div className="mt-legend">
        <span><i className="mt-sw done" />done</span>
        <span><i className="mt-sw live" />working now</span>
        <span><i className="mt-sw gate" />waits for you</span>
        <span><i className="mt-sw fail" />stopped or failed</span>
        <span><i className="mt-sw todo" />ahead</span>
        <span>Beads on a ring are loop rounds</span>
        <span className="mt-hint">Pick a stop to open it below</span>
      </div>
    </div>
  );
}

function icon(s: Stop, x: number, y: number): ReactNode {
  const p = { fill: "none", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (s.id) {
    case "idea": return <path {...p} d={`M${x - 6},${y + 3} a8,8 0 1 1 12,0 v4 h-12 z M${x - 4},${y + 11} h8`} />;
    case "council": return <>{[0, 1, 2, 3, 4, 5].map((k) => <circle key={k} className="fill" cx={x + 11 * Math.cos((k * Math.PI) / 3)} cy={y + 11 * Math.sin((k * Math.PI) / 3)} r={3} />)}<circle {...p} cx={x} cy={y} r={4} /></>;
    case "design": return <path {...p} d={`M${x - 12},${y - 4} h8 M${x - 8},${y - 8} v8 M${x + 4},${y + 4} h8 M${x - 6},${y + 9} q6,-16 12,-17`} />;
    case "plan": return <path {...p} d={`M${x - 11},${y - 9} h22 v18 h-22z M${x - 6},${y - 3} h12 M${x - 6},${y + 3} h8`} />;
    case "build": return <>{[[-9, -9], [1, -9], [-9, 1], [1, 1]].map(([a, b], k) => <rect key={k} {...p} strokeWidth={1.6} x={x + a} y={y + b} width={8} height={8} rx={1.5} />)}</>;
    case "check": return <path {...p} d={`M${x - 10},${y - 2} a10,10 0 0 1 18,-4 M${x + 8},${y - 10} v5 h-5 M${x + 10},${y + 2} a10,10 0 0 1 -18,4 M${x - 8},${y + 10} v-5 h5`} />;
    case "judge": return <><path {...p} d={`M${x - 11},${y} q11,-14 22,0 q-11,14 -22,0z`} /><circle className="fill" cx={x} cy={y} r={3} /></>;
    case "ship": return <path {...p} d={`M${x - 6},${y + 11} v-22 l13,6 l-13,6`} />;
    default: return s.state === "done" ? <path {...p} d={`M${x - 6},${y} l4,4 l8,-8`} /> : <path {...p} d={`M${x},${y - 6} v6 M${x},${y + 5} v.5`} />;
  }
}
