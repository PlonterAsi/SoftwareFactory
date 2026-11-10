import { useMemo, useState } from "react";
import type { Signal } from "./api";

/** Deterministic position from an id, so a Signal's star never jumps around. */
function place(id: number) {
  const a = Math.sin(id * 12.9898) * 43758.5453;
  const b = Math.sin(id * 78.233) * 12543.123;
  return { x: 0.08 + (a - Math.floor(a)) * 0.84, y: 0.1 + (b - Math.floor(b)) * 0.62 };
}

/**
 * Milestone 1 star map: every Signal is a star. Until the Order Engine (milestone 3)
 * files them into projects, they all drift in the Unsorted belt.
 */
export function StarMap({ signals }: { signals: Signal[] }) {
  const [hover, setHover] = useState<Signal | null>(null);
  const newest = signals.at(-1)?.id;
  const bg = useMemo(() => Array.from({ length: 70 }, (_, i) => ({ ...place(i + 1000), r: ((i * 7) % 3) * 0.35 + 0.3 })), []);
  return (
    <section className="pane starmap" aria-label="Star map">
      <header className="pane-head"><span>Star map</span><span className="muted">{signals.length} signals</span></header>
      <div className="map-wrap">
        <svg viewBox="0 0 100 200" preserveAspectRatio="xMidYMid meet" className="map">
          {bg.map((s, i) => <circle key={i} cx={s.x * 100} cy={s.y * 200 + 8} r={s.r * 0.25} className="bgstar" />)}
          <ellipse cx="50" cy="176" rx="46" ry="12" className="belt" />
          {signals.map((s, i) => {
            const p = place(s.id);
            const bx = 8 + ((i * 37) % 84);
            const by = 170 + ((i * 13) % 12);
            return (
              <g key={s.id} onMouseEnter={() => setHover(s)} onMouseLeave={() => setHover(null)}>
                <line x1={p.x * 100} y1={p.y * 200} x2={bx} y2={by} className="trail" />
                <circle cx={bx} cy={by} r={s.id === newest ? 1.6 : 1} className={s.id === newest ? "star new" : "star"} />
              </g>
            );
          })}
        </svg>
        <div className="belt-label">Unsorted belt · the Order Engine files these into projects in milestone 3</div>
        {hover && <div className="star-tip"><span className="mono muted">#{hover.id} · {hover.source}</span>{hover.text.slice(0, 220)}</div>}
        {!signals.length && <div className="empty">No signals yet. Say anything in the Overseer channel.</div>}
      </div>
    </section>
  );
}
