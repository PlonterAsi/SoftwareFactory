import { useState } from "react";
import type { FactoryRunView } from "./api";

type Tab = "plan" | "tests" | "files" | "visuals";

/** What the selected run produced, drawn instead of listed: task graph, test grid, file heat map, visual checks. */
export function RunDeck({ run }: { run?: FactoryRunView }) {
  const [tab, setTab] = useState<Tab>("plan");
  const last = run?.tests.at(-1);
  const fileCount = run ? Object.keys(run.files).length : 0;
  const vFail = run?.visuals.filter((v) => !v.pass).length ?? 0;
  const tabs: [Tab, string][] = [
    ["plan", `Plan${run?.plan ? ` · ${run.plan.tasks.length}` : ""}`],
    ["tests", `Tests${last ? ` · ${last.passed}/${last.passed + last.failed}` : ""}`],
    ["files", `Files${fileCount ? ` · ${fileCount}` : ""}`],
    ["visuals", `Visuals${run?.visuals.length ? (vFail ? ` · ${vFail} missing` : " · all") : ""}`],
  ];
  return (
    <section className="pane deck" aria-label="Run deck">
      <header className="pane-head deck-head">
        <div className="tabs" role="tablist">
          {tabs.map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "tab on" : "tab"} onClick={() => setTab(id)}>{label}</button>)}
        </div>
        {run?.dir && <span className="muted mono deck-dir" title={run.dir}>{run.dir.split("/").slice(-1)[0]}</span>}
      </header>
      <div className="deck-body">
        {!run && <div className="empty">Start a run to see its plan as a task graph, its tests as a grid and its files as a heat map.</div>}
        {run && tab === "plan" && <TaskGraph run={run} />}
        {run && tab === "tests" && <TestGrid run={run} />}
        {run && tab === "files" && <HeatMap run={run} />}
        {run && tab === "visuals" && <Visuals run={run} />}
      </div>
    </section>
  );
}

function TaskGraph({ run }: { run: FactoryRunView }) {
  const plan = run.plan;
  if (!plan) return <div className="empty">The Planner is writing the spec…</div>;
  // Columns by dependency depth.
  const depth = new Map<string, number>();
  const d = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const t = plan.tasks.find((x) => x.id === id);
    const v = t && t.dependsOn.length ? 1 + Math.max(...t.dependsOn.map((x) => d(x, seen))) : 0;
    depth.set(id, v);
    return v;
  };
  plan.tasks.forEach((t) => d(t.id));
  const cols: string[][] = [];
  plan.tasks.forEach((t) => (cols[depth.get(t.id)!] ??= []).push(t.id));
  const W = 150, H = 34, GX = 40, GY = 12;
  const pos = new Map<string, { x: number; y: number }>();
  cols.forEach((c, i) => c.forEach((id, j) => pos.set(id, { x: i * (W + GX), y: j * (H + GY) })));
  const width = cols.length * (W + GX) - GX;
  const height = Math.max(...cols.map((c) => c.length)) * (H + GY) - GY;
  const built = !!run.stations.build && run.stations.build.state !== "active";
  return (
    <div className="plan-view">
      <div className="plan-summary"><strong>{plan.name}</strong> <span className="muted">{plan.summary}</span></div>
      <svg className="taskgraph" viewBox={`-4 -4 ${width + 8} ${height + 8}`} style={{ maxHeight: Math.min(height + 8, 150) }} role="img" aria-label={`Task graph with ${plan.tasks.length} tasks`}>
        {plan.tasks.flatMap((t) => t.dependsOn.map((dep) => {
          const a = pos.get(dep)!, b = pos.get(t.id)!;
          return <path key={dep + t.id} className="tg-edge" d={`M${a.x + W},${a.y + H / 2} C${a.x + W + GX / 2},${a.y + H / 2} ${b.x - GX / 2},${b.y + H / 2} ${b.x},${b.y + H / 2}`} />;
        }))}
        {plan.tasks.map((t) => { const p = pos.get(t.id)!; return (
          <g key={t.id} transform={`translate(${p.x},${p.y})`} className={built ? "tg-node done" : "tg-node"}>
            <rect width={W} height={H} rx={6} />
            <text x={8} y={H / 2 + 4}><tspan className="tg-id">{t.id}</tspan> {t.title.length > 18 ? t.title.slice(0, 17) + "…" : t.title}</text>
            <title>{t.title}</title>
          </g>
        ); })}
      </svg>
      <ol className="acceptance">{plan.acceptance.map((a, i) => <li key={i}>{a}</li>)}</ol>
    </div>
  );
}

function TestGrid({ run }: { run: FactoryRunView }) {
  if (!run.tests.length) return <div className="empty">{run.stations.tests ? "Tests are locked; waiting for the first build." : "The Tester writes acceptance tests after you approve the plan."}</div>;
  const names = [...new Set(run.tests.flatMap((t) => t.cases.map((c) => c.name)))];
  return (
    <div className="testgrid" style={{ gridTemplateColumns: `minmax(140px, max-content) repeat(${run.tests.length}, 26px)` }}>
      <span className="tg-h muted">test \ round</span>
      {run.tests.map((t) => <span key={t.round} className="tg-h mono muted" title={`${t.passed} pass, ${t.failed} fail`}>{t.round === 0 ? "B" : t.round}</span>)}
      {names.map((n) => [
        <span key={n} className="tg-name" title={n}>{n}</span>,
        ...run.tests.map((t) => {
          const c = t.cases.find((x) => x.name === n);
          return <span key={n + t.round} className={`cell ${c ? (c.pass ? "pass" : "fail") : "none"}`} title={c ? (c.pass ? "pass" : c.error ?? "fail") : "not run"} />;
        }),
      ])}
    </div>
  );
}

function HeatMap({ run }: { run: FactoryRunView }) {
  const files = Object.entries(run.files).sort((a, b) => a[0].localeCompare(b[0]));
  if (!files.length) return <div className="empty">No files yet.</div>;
  const maxW = Math.max(...files.map(([, f]) => f.writes));
  const maxL = Math.max(...files.map(([, f]) => f.lines));
  return (
    <div className="heatmap">
      {files.map(([p, f]) => (
        <div key={p} className={`hm-tile${f.locked ? " locked" : ""}`} title={`${p}: ${f.lines} lines, written ${f.writes}×, last by ${f.last}${f.locked ? " (locked test)" : ""}`}
          style={{ ["--heat" as string]: String(f.writes / maxW), flexGrow: Math.max(1, Math.round((f.lines / maxL) * 4)) }}>
          <span className="mono">{p}</span>
          <span className="mono muted">{f.lines} ln · {f.writes}×{f.locked ? " · 🔒" : ""}</span>
        </div>
      ))}
      {run.refused.map((r, i) => <div key={i} className="hm-refused mono">refused {r.path} from {r.station}: {r.reason}</div>)}
    </div>
  );
}

function Visuals({ run }: { run: FactoryRunView }) {
  if (!run.visuals.length) return <div className="empty">visualizeEverything runs at the end of every station.</div>;
  return (
    <ul className="visuals">
      {run.visuals.map((v, i) => (
        <li key={i} className={v.pass ? "pass" : "fail"}>
          <span className="mono">{v.pass ? "PASS" : "FAIL"} {v.station}{v.round ? ` r${v.round}` : ""}</span>
          <span className="muted">{[...v.items.map((x) => "✓ " + x.replace(/^[^:]+: /, "")), ...v.missing.map((x) => "✗ " + x)].join(" · ")}</span>
        </li>
      ))}
    </ul>
  );
}
