import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { orderApi, type FactoryRunView, type Fragment, type OrderNode, type OrderState, type Signal } from "./api";

/** Deterministic noise from an id, so a body never jumps around between renders. */
function hash(id: number, salt = 1) {
  const a = Math.sin(id * 12.9898 * salt) * 43758.5453;
  return a - Math.floor(a);
}

const W = 100, H = 200, BELT_Y = 182, INPUT = { x: 100, y: 40 };

interface Body { node: OrderNode; x: number; y: number; r: number; count: number; glow: boolean; stale: boolean; depth: number }

/** Lay the node tree out as a galaxy: projects are systems, ideas planets, threads (and sub-ideas) moons. */
function layout(o: OrderState, now: number): Map<number, Body> {
  const live = o.nodes.filter((n) => n.mergedInto == null);
  const count = new Map<number, number>();
  const glow = new Set<number>();
  for (const f of o.fragments) {
    if (f.nodeId == null || f.state !== "live" || f.kind === "noise") continue;
    count.set(f.nodeId, (count.get(f.nodeId) ?? 0) + 1);
    if ((f.kind === "rule" || f.kind === "decision") && (f.important || f.pinned)) glow.add(f.nodeId);
  }
  const bodies = new Map<number, Body>();
  const projects = live.filter((n) => n.parentId == null);
  const band = (BELT_Y - 20) / Math.max(1, projects.length);
  const size = (n: OrderNode, base: number) => base + 0.45 * Math.sqrt(count.get(n.id) ?? 0);
  const stale = (n: OrderNode) => now - Date.parse(n.lastActive) > 7 * 86_400_000;
  const place = (parent: Body, kids: OrderNode[], rx: number, ry: number, depth: number) => {
    kids.forEach((k, i) => {
      const a = (i / kids.length) * Math.PI * 2 + hash(parent.node.id) * Math.PI - Math.PI / 2;
      const b: Body = { node: k, x: parent.x + Math.cos(a) * rx, y: parent.y + Math.sin(a) * ry, r: size(k, depth === 1 ? 2.2 : 1.2), count: count.get(k.id) ?? 0, glow: glow.has(k.id), stale: stale(k), depth };
      bodies.set(k.id, b);
      const sub = live.filter((n) => n.parentId === k.id);
      if (sub.length) place(b, sub, Math.min(7, rx * 0.3), Math.min(7, ry * 0.35), depth + 1);
    });
  };
  projects.forEach((p, i) => {
    const b: Body = { node: p, x: W / 2, y: 14 + band * (i + 0.5), r: size(p, 4), count: count.get(p.id) ?? 0, glow: glow.has(p.id), stale: stale(p), depth: 0 };
    bodies.set(p.id, b);
    const kids = live.filter((n) => n.parentId === p.id);
    place(b, kids, 33, Math.min(band * 0.38, 30), 1);
  });
  return bodies;
}

/**
 * The star map, drawn from the Order Engine: every node is a body, every new
 * Fragment flies in from the Overseer channel as a particle, unsure ones drift
 * in the Unsorted belt until you drag them onto a body, important Canon glows,
 * stale bodies dim, and a conflict is a red link.
 */
export function StarMap({ signals, order, selected, onSelect, factoryRuns = [], onShowRun }: { signals: Signal[]; order: OrderState & { arrivals: Record<number, number> }; selected: number | null; onSelect: (id: number | null) => void; factoryRuns?: FactoryRunView[]; onShowRun?: (run: number) => void }) {
  const [hover, setHover] = useState<{ title: string; body: string } | null>(null);
  const [drag, setDrag] = useState<{ id: number; x: number; y: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(Date.now());
  const svgRef = useRef<SVGSVGElement>(null);
  const bodies = useMemo(() => layout(order, tick), [order, tick]);
  const bg = useMemo(() => Array.from({ length: 70 }, (_, i) => ({ x: hash(i + 1000) * W, y: hash(i + 1000, 7) * (BELT_Y - 10), r: ((i * 7) % 3) * 0.1 + 0.1 })), []);
  const tray = order.fragments.filter((f) => f.nodeId == null && f.kind !== "noise" && f.state === "live");
  const recent = order.fragments.filter((f) => f.nodeId != null && (order.arrivals[f.id] ?? 0) > tick - 2600);

  // Keep particles moving while any are in flight.
  useEffect(() => {
    const busy = Object.values(order.arrivals).some((t) => t > Date.now() - 2600);
    const id = setInterval(() => setTick(Date.now()), busy ? 250 : 15_000);
    return () => clearInterval(id);
  }, [order.arrivals]);

  const toSvg = (e: PointerEvent) => {
    const m = svgRef.current?.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };
  const drop = async (nodeId: number) => {
    if (!drag) return;
    const id = drag.id;
    setDrag(null);
    try { await orderApi.move(id, nodeId); setErr(null); } catch (x) { setErr((x as Error).message); }
  };
  const fragTip = (f: Fragment) => ({ title: `${f.kind} · ${Math.round(f.confidence * 100)}% sure${f.suggestedNodeId ? ` · maybe "${order.nodes.find((n) => n.id === f.suggestedNodeId)?.title}"` : ""}`, body: f.text });
  // A factory run's idea is its own system: find the run behind each body by its intake Signal.
  const runOf = useMemo(() => {
    const m = new Map<number, FactoryRunView>();
    for (const r of factoryRuns) {
      const sig = signals.find((s) => s.source === "factory" && s.id > r.run && s.text === r.idea);
      const body = sig && order.nodes.find((n) => n.signalId === sig.id && n.parentId == null);
      if (body) m.set(body.id, r);
    }
    return m;
  }, [factoryRuns, signals, order.nodes]);
  const conflictLinks = order.conflicts.filter((c) => c.status === "open").map((c) => {
    const a = order.fragments.find((f) => f.id === c.a), b = order.fragments.find((f) => f.id === c.b);
    return { id: c.id, a: a?.nodeId != null ? bodies.get(a.nodeId) : undefined, b: b?.nodeId != null ? bodies.get(b.nodeId) : undefined };
  });

  return (
    <section className="pane starmap" aria-label="Star map">
      <header className="pane-head"><span>Star map</span><span className="muted">{order.nodes.filter((n) => n.mergedInto == null).length} bodies · {tray.length} unsorted · {signals.length} signals</span></header>
      <div className="map-wrap">
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className={drag ? "map dragging" : "map"}
          onPointerMove={(e) => drag && setDrag({ ...drag, ...toSvg(e) })} onPointerUp={() => setDrag(null)} onClick={(e) => e.target === svgRef.current && onSelect(null)}>
          <defs>
            <radialGradient id="glow"><stop offset="0%" stopColor="#4fd6e8" stopOpacity="0.55" /><stop offset="100%" stopColor="#4fd6e8" stopOpacity="0" /></radialGradient>
          </defs>
          {bg.map((s, i) => <circle key={i} cx={s.x} cy={s.y} r={s.r} className="bgstar" />)}
          {/* Orbits and tethers */}
          {[...bodies.values()].filter((b) => b.node.parentId != null).map((b) => {
            const p = bodies.get(b.node.parentId!);
            return p ? <line key={"t" + b.node.id} x1={p.x} y1={p.y} x2={b.x} y2={b.y} className="tether" /> : null;
          })}
          {conflictLinks.map((l) => l.a && l.b && l.a !== l.b ? <line key={"c" + l.id} x1={l.a.x} y1={l.a.y} x2={l.b.x} y2={l.b.y} className="conflict-link" /> : null)}
          {[...bodies.values()].map((b) => {
            const sel = selected === b.node.id;
            const hot = conflictLinks.some((l) => l.a === b || l.b === b);
            return (
              <g key={b.node.id} className={`body k-${b.node.kind}${b.stale ? " stale" : ""}${sel ? " sel" : ""}${drag ? " droppable" : ""}`}
                onClick={(e) => { e.stopPropagation(); onSelect(b.node.id); }} onDoubleClick={() => { const r = runOf.get(b.node.id); if (r) onShowRun?.(r.run); }} onPointerUp={() => drop(b.node.id)}
                onMouseEnter={() => { const r = runOf.get(b.node.id); setHover({ title: `${b.node.kind} · ${b.count} fragments${(order.canon[b.node.id]?.length ?? 0) ? ` · ${order.canon[b.node.id].length} in Canon` : ""}${r ? ` · factory run #${r.run}: ${r.finished?.outcome ?? (r.waiting ? "waiting for you" : "building")} (double-click to watch)` : ""}`, body: b.node.title }); }} onMouseLeave={() => setHover(null)}>
                {b.glow && <circle cx={b.x} cy={b.y} r={b.r * 2.6} fill="url(#glow)" className="halo" />}
                {hot && <circle cx={b.x} cy={b.y} r={b.r + 1.6} className="hot-ring" />}
                {runOf.has(b.node.id) && (() => {
                  const r = runOf.get(b.node.id)!;
                  const st = r.finished?.outcome ?? (r.waiting ? "waiting" : "building");
                  // A shipyard ring: spinning while the crew builds, solid when shipped, red when it stopped.
                  return <circle cx={b.x} cy={b.y} r={b.r + 2.4} className={`yard-ring y-${st}`} />;
                })()}
                <circle cx={b.x} cy={b.y} r={b.r} className="planet" />
                {sel && <circle cx={b.x} cy={b.y} r={b.r + 1} className="sel-ring" />}
                {(b.depth <= 1 || sel) && <text x={b.x} y={b.y + b.r + (b.depth === 0 ? 4.2 : 3.2) + (runOf.has(b.node.id) ? 2.6 : 0)} className={b.depth === 0 ? "body-label big" : "body-label"}>{b.node.title.length > 22 ? b.node.title.slice(0, 21) + "…" : b.node.title}</text>}
              </g>
            );
          })}
          {/* Particles: each new fragment flies from the Overseer channel to the body it was filed under. */}
          {recent.map((f) => {
            const t = bodies.get(f.nodeId!);
            if (!t) return null;
            return (
              <circle key={"p" + f.id} r="0.9" className={`particle k-${f.kind}`} cx={t.x} cy={t.y}>
                <animate attributeName="cx" from={INPUT.x} to={t.x} dur="1.1s" fill="freeze" />
                <animate attributeName="cy" from={INPUT.y + hash(f.id) * 40} to={t.y} dur="1.1s" fill="freeze" />
                <animate attributeName="opacity" values="1;1;0" keyTimes="0;0.7;1" dur="2.4s" fill="freeze" />
              </circle>
            );
          })}
          <ellipse cx={W / 2} cy={BELT_Y} rx="46" ry="10" className="belt" />
          {tray.map((f, i) => {
            const x = 8 + ((i * 37 + f.id * 7) % 84);
            const y = BELT_Y - 6 + ((i * 13 + f.id) % 12);
            return (
              <g key={f.id} className="asteroid" onPointerDown={(e) => { e.preventDefault(); setDrag({ id: f.id, ...toSvg(e) }); }}
                onMouseEnter={() => setHover(fragTip(f))} onMouseLeave={() => setHover(null)}>
                <circle cx={x} cy={y} r="2.4" className="hit" />
                <polygon points={`${x - 1.2},${y} ${x - 0.3},${y - 1.1} ${x + 1.1},${y - 0.6} ${x + 1},${y + 0.7} ${x - 0.4},${y + 1}`} className={`rock k-${f.kind}`} />
                {drag?.id === f.id && <line x1={x} y1={y} x2={drag.x} y2={drag.y} className="drag-line" />}
              </g>
            );
          })}
        </svg>
        <div className="belt-label">{tray.length ? "Unsorted belt · drag a rock onto a body to file it" : "Unsorted belt · empty, everything is filed"}</div>
        {hover && <div className="star-tip"><span className="mono muted">{hover.title}</span>{hover.body.slice(0, 260)}</div>}
        {err && <div className="star-tip err">{err}</div>}
        {!order.nodes.length && <div className="empty">No bodies yet. Say something in the Overseer channel, for example "Project: My idea".</div>}
      </div>
    </section>
  );
}
