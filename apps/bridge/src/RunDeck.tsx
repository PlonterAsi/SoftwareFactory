import { useState } from "react";
import type { FactoryRunView, LoopEventView, SeatView, Vote } from "./api";

type Tab = "council" | "product" | "build" | "judge" | "plan" | "tests" | "loop" | "files" | "review" | "engine" | "visuals";

/** What the selected run produced, drawn instead of listed: task graph, test grid, file heat map, visual checks. */
export function RunDeck({ run }: { run?: FactoryRunView }) {
  const [tab, setTab] = useState<Tab>("plan");
  const last = run?.tests.at(-1);
  const fileCount = run ? Object.keys(run.files).length : 0;
  const vFail = run?.visuals.filter((v) => !v.pass).length ?? 0;
  const lastCouncil = run?.council.at(-1);
  const lastReview = run?.reviews.at(-1);
  const lastDisc = run?.discovery.at(-1);
  const lastEval = run?.evaluations.at(-1);
  const tabs: [Tab, string][] = [
    ["council", `Council${lastCouncil ? ` · ${lastCouncil.brief.outcome}` : run?.stations.council?.state === "skipped" ? " · skipped" : ""}`],
    ["product", `Product${lastDisc ? ` · ${lastDisc.pass ? "passed" : `round ${lastDisc.round}`}` : ""}`],
    ["plan", `Plan${run?.plan ? ` · ${run.plan.tasks.length}` : ""}`],
    ["tests", `Tests${last ? ` · ${last.passed}/${last.passed + last.failed}` : ""}`],
    ["build", `Build${run?.features.length ? ` · ${run.features.filter((f) => f.state === "built").length}/${run.features.length}` : ""}`],
    ["loop", `Loop${run?.loop.length ? ` · ${run.loop.filter((l) => l.kind === "attempt").length}` : ""}`],
    ["files", `Files${fileCount ? ` · ${fileCount}` : ""}`],
    ["review", `Review${lastReview ? ` · ${lastReview.findings.length}` : ""}`],
    ["judge", `Judge${lastEval ? (lastEval.skipped ? " · skipped" : lastEval.pass ? " · passed" : ` · ${lastEval.requirements.filter((q) => !q.met).length} open`) : ""}`],
    ["engine", `Engine${run?.retro ? ` · ${run.retro.bad.length} to fix` : ""}`],
    ["visuals", `Visuals${run?.visuals.length ? (vFail ? ` · ${vFail} missing` : " · all") : ""}`],
  ];
  return (
    <section className="pane deck" aria-label="Run deck">
      <header className="pane-head deck-head">
        <div className="tabs" role="tablist">
          {tabs.map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "tab on" : "tab"} onClick={() => setTab(id)}>{label}</button>)}
        </div>
        {run?.dir && <span className="muted mono deck-dir" title={run.dir}>{run.dir.split(/[\\/]/).slice(-1)[0]}</span>}
      </header>
      <div className="deck-body">
        {!run && <div className="empty">Start a run to see its plan as a task graph, its tests as a grid and its files as a heat map.</div>}
        {run && tab === "plan" && <TaskGraph run={run} />}
        {run && tab === "tests" && <TestGrid run={run} />}
        {run && tab === "loop" && <LoopView run={run} />}
        {run && tab === "files" && <HeatMap run={run} />}
        {run && tab === "visuals" && <Visuals run={run} />}
        {run && tab === "council" && <CouncilView run={run} />}
        {run && tab === "product" && <ProductView run={run} />}
        {run && tab === "build" && <BuildView run={run} />}
        {run && tab === "judge" && <JudgeView run={run} />}
        {run && tab === "engine" && <EngineView run={run} />}
        {run && tab === "review" && <ReviewView run={run} />}
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

const VOTE_LABEL: Record<Vote, string> = { build: "build", reshape: "reshape", drop: "drop" };

/** The Council as a round table: three to six seats, each coloured by its vote; a line joins seats that agree on a point. */
function CouncilView({ run }: { run: FactoryRunView }) {
  const st = run.stations.council;
  const [round, setRound] = useState<number | null>(null);
  if (!run.council.length) return <div className="empty">{st?.state === "skipped" ? `The Council was skipped: ${st.note ?? "small job"}.` : st?.state === "active" ? "The Council is sitting…" : "The Council sits before the Planner for bigger ideas."}</div>;
  const r = run.council.find((c) => c.round === round) ?? run.council.at(-1)!;
  const seats = r.seats;
  const W = 300, H = 190, cx = W / 2, cy = H / 2, R = 62;
  // Seats sit around an oval table: two above, one below (any count works).
  const pos = seats.map((_, i) => { const a = -Math.PI / 2 - Math.PI / seats.length + (i * 2 * Math.PI) / Math.max(1, seats.length); return { x: cx + R * 1.55 * Math.cos(a), y: cy + R * 0.95 * Math.sin(a) }; });
  // Seats that raised a point that ended up "agreed" are joined.
  const raised = (s: SeatView, text: string) => [...(s.take?.proposals ?? []), ...(s.take?.concerns ?? [])].some((x) => overlap(x, text));
  const links: [number, number][] = [];
  for (let i = 0; i < seats.length; i++) for (let j = i + 1; j < seats.length; j++) if (r.brief.agreed.some((t) => raised(seats[i], t) && raised(seats[j], t))) links.push([i, j]);
  return (
    <div className="council">
      <div className="council-top">
        <svg className="table" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Council round ${r.round}: ${seats.map((s) => `${s.name} ${s.take?.vote ?? "no answer"}`).join(", ")}; majority ${r.brief.outcome}`}>
          <ellipse className="tbl" cx={cx} cy={cy} rx={R * 1.05} ry={R * 0.5} />
          <text className="tbl-out" x={cx} y={cy - 2} textAnchor="middle">{r.brief.outcome.toUpperCase()}</text>
          <text className="tbl-sub" x={cx} y={cy + 13} textAnchor="middle">round {r.round} of {run.council.length}</text>
          {links.map(([i, j]) => <line key={`${i}-${j}`} className="agree" x1={pos[i].x} y1={pos[i].y} x2={pos[j].x} y2={pos[j].y} />)}
          {seats.map((s, i) => (
            <g key={s.agent} className={`seat-g v-${s.take?.vote ?? "none"}`} transform={`translate(${pos[i].x},${pos[i].y})`}>
              <circle r={17} />
              <text y={4} textAnchor="middle">{s.name.slice(0, 1)}</text>
              <text className="seat-lbl" y={pos[i].y < cy ? -23 : 31} textAnchor="middle">{s.name} · {s.take ? VOTE_LABEL[s.take.vote] : "no answer"}</text>
            </g>
          ))}
        </svg>
        <div className="brief">
          {run.council.length > 1 && <div className="rounds">{run.council.map((c) => <button key={c.round} className={`tiny ${c.round === r.round ? "" : "ghost"}`} onClick={() => setRound(c.round)}>Round {c.round}</button>)}</div>}
          <BriefList title="Agreed" cls="agreed" items={r.brief.agreed} />
          <BriefList title="Proposals" cls="props" items={r.brief.proposals} />
          <BriefList title="Concerns" cls="concerns" items={r.brief.concerns} />
        </div>
      </div>
      <div className="takes">
        {seats.map((s) => (
          <div key={s.agent} className={`take v-${s.take?.vote ?? "none"}`}>
            <div className="take-head"><strong>{s.name}</strong> <span className="mono muted">v{s.version}</span> <span className="vote">{s.take ? s.take.vote : "no answer"}</span>{s.take && <span className="mono muted">{s.take.scope}</span>}</div>
            <div className="take-text">{s.take?.take ?? s.error}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The product judge, drawn: a row per must-have requirement (seen working or not, with what the judge saw) and the scores. */
/** The engine review, drawn: what the factory did well and badly on this run, and where the money and time went. */
function EngineView({ run }: { run: FactoryRunView }) {
  const r = run.retro;
  if (!r) return <div className="empty">When the run ends, SoftwareFactory reviews its own work here: which stations, loops and agents did their job, which did not, and where the money and time went.</div>;
  const top = Math.max(0.0001, ...r.stages.map((s) => s.costUsd));
  const money = (n: number) => `$${n.toFixed(2)}`;
  return (
    <div className="product">
      <div className="product-top">
        <div className={`product-verdict ${r.outcome === "shipped" ? "ok" : "warn"}`}>{r.outcome} · {money(r.spentUsd)} of {money(r.maxUsd)} · {Math.round(r.minutes)} minutes</div>
      </div>
      <BriefList title="What the engine did badly (the work list)" cls="concerns" items={r.bad} />
      <BriefList title="What the engine did well" cls="agreed" items={r.good} />
      <div className="scores" role="img" aria-label={`Spend by station: ${r.stages.map((s) => `${s.station} ${money(s.costUsd)}`).join(", ")}`}>
        {r.stages.filter((s) => s.calls).map((s) => (
          <div key={s.station} className="score ok"><span className="score-k">{s.station}</span><span className="score-bar"><i style={{ width: `${(s.costUsd / top) * 100}%` }} /></span><span className="mono">{money(s.costUsd)} · {s.calls} call{s.calls === 1 ? "" : "s"} · {s.seconds}s</span></div>
        ))}
      </div>
      <table className="product-reqs"><tbody>
        {r.agents.map((a) => <tr key={a.agent} className={a.fails > a.passes || a.failedCalls ? "unmet" : ""}><td className="mono">{a.agent}</td><td>{a.calls} call{a.calls === 1 ? "" : "s"} · {money(a.costUsd)}</td><td>{a.passes} passed · {a.fails} not{a.failedCalls ? ` · ${a.failedCalls} failed calls` : ""}{a.lastNote ? ` · ${a.lastNote}` : ""}</td></tr>)}
      </tbody></table>
    </div>
  );
}

function JudgeView({ run }: { run: FactoryRunView }) {
  const [at, setAt] = useState<number | null>(null);
  if (!run.evaluations.length) return <div className="empty">{run.stations.evaluate?.state === "skipped" ? run.stations.evaluate.note ?? "The product was not judged on this run." : "After the review, a separate judge reads every screen of the running app and checks it against the product design: each requirement, then scores for function, design and content."}</div>;
  const i = at != null && at < run.evaluations.length ? at : run.evaluations.length - 1;
  const e = run.evaluations[i];
  if (e.skipped) return <div className="empty">Not judged: {e.skipped}.</div>;
  const met = e.requirements.filter((q) => q.met).length;
  return (
    <div className="product">
      <div className="product-top">
        <div className="rounds">{run.evaluations.map((x, k) => <button key={k} className={`tiny ${k === i ? "" : "ghost"}`} onClick={() => setAt(k)}>Look {x.round}{x.pass ? " ✓" : ""}</button>)}</div>
        <div className={`product-verdict ${e.pass ? "ok" : "warn"}`}>{e.pass ? "The judge saw every requirement working." : `${met} of ${e.requirements.length} requirements seen working on ${e.screens} screens.`}</div>
      </div>
      <div className="scores" role="img" aria-label={`Product scores: ${Object.entries(e.scores).map(([k, v]) => `${k} ${v} of 5`).join(", ")}`}>
        {Object.entries(e.scores).map(([k, v]) => (
          <div key={k} className={`score ${v >= e.bar ? "ok" : "low"}`}><span className="score-k">{k}</span><span className="score-bar"><i style={{ width: `${v * 20}%` }} /></span><span className="mono">{v}/5</span></div>
        ))}
      </div>
      <table className="product-reqs"><tbody>
        {e.requirements.map((q) => <tr key={q.id} className={q.met ? "" : "unmet"}><td className="mono muted">{q.id}</td><td>{q.met ? "✓ seen working" : "✗ not seen"}</td><td>{q.evidence}</td></tr>)}
      </tbody></table>
      {!!e.problems.length && <BriefList title="What a user would hit" cls="concerns" items={e.problems.map((p) => `${p.where ? `${p.where}: ` : ""}${p.problem}${p.fix ? ` → ${p.fix}` : ""}`)} />}
    </div>
  );
}

/** The build loop, drawn: one row per feature, in build order, with the locked tests passing after it. */
function BuildView({ run }: { run: FactoryRunView }) {
  if (!run.features.length) return <div className="empty">{run.stations.build?.state ? "This build was written in one call. Product-sized runs (from $3) are built one feature at a time, and each feature shows here." : "After the plan is approved, the app is built one feature at a time: the model and shell, the logic, then each screen."}</div>;
  const LABEL = { building: "building now", built: "built", empty: "nothing changed", regressed: "broke a passing test", broken: "a screen did not draw" } as const;
  return (
    <ol className="feat-list">
      {run.features.map((f) => {
        const total = (f.passed ?? 0) + (f.failed ?? 0);
        return (
          <li key={f.id} className={`feat ${f.state}`}>
            <div className="feat-head"><span className="mono muted">{f.id}</span> <strong>{f.title}</strong> <span className="feat-state">{LABEL[f.state]}{f.attempt > 1 ? ` · try ${f.attempt}` : ""}</span></div>
            {total > 0 && <div className="score"><span className="score-k">locked tests</span><span className="score-bar"><i style={{ width: `${((f.passed ?? 0) / total) * 100}%` }} /></span><span className="mono">{f.passed}/{total}</span></div>}
            {!!f.files?.length && <div className="loop-files">{f.files.slice(0, 8).join(", ")}{f.files.length > 8 ? ` +${f.files.length - 8}` : ""}</div>}
            {!!f.broke?.length && <div className="loop-dispute">Broke: {f.broke.slice(0, 3).map((x) => x.split("::")[1] ?? x).join("; ")}</div>}
            {!!f.crashed?.length && <div className="loop-dispute">Did not draw: {f.crashed.slice(0, 3).join("; ")}</div>}
          </li>
        );
      })}
    </ol>
  );
}

/** Discovery, drawn: the scores of each round as a bar per rubric line, then the documents the plan is built from. */
function ProductView({ run }: { run: FactoryRunView }) {
  const [at, setAt] = useState<number | null>(null);
  if (!run.discovery.length) return <div className="empty">{run.stations.discover?.state === "skipped" ? run.stations.discover.note ?? "No product design on this run." : "The Designer is working out what this product is: who it is for, the journeys, the screens. The Critic then scores it."}</div>;
  const i = at != null && at < run.discovery.length ? at : run.discovery.length - 1;
  const r = run.discovery[i];
  const d = r.docs;
  return (
    <div className="product">
      <div className="product-top">
        <div className="rounds">{run.discovery.map((x, k) => <button key={k} className={`tiny ${k === i ? "" : "ghost"}`} onClick={() => setAt(k)}>{x.settled ? "Kept" : `Round ${x.round}`}{x.pass ? " ✓" : ""}</button>)}</div>
        <div className={`product-verdict ${r.pass ? "ok" : "warn"}`}>{r.pass ? "The Critic passed this design." : r.settled ? `Went on with the best design: ${r.settled}.` : "Sent back to the Designer."}</div>
      </div>
      {r.critique && (
        <div className="scores" role="img" aria-label={`Design scores: ${Object.entries(r.critique.scores).map(([k, v]) => `${k} ${v} of 5`).join(", ")}`}>
          {Object.entries(r.critique.scores).map(([k, v]) => (
            <div key={k} className={`score ${v >= r.bar ? "ok" : "low"}`}><span className="score-k">{k}</span><span className="score-bar"><i style={{ width: `${v * 20}%` }} /></span><span className="mono">{v}/5</span></div>
          ))}
        </div>
      )}
      {!!r.critique?.problems.length && <BriefList title="What the Critic wants changed" cls="concerns" items={r.critique.problems.map((p) => `${p.problem}${p.fix ? ` → ${p.fix}` : ""}`)} />}
      <div className="product-brief">
        <p><strong>For:</strong> {d.brief.who}</p>
        <p><strong>Problem:</strong> {d.brief.problem}</p>
        <p><strong>Promise:</strong> {d.brief.promise}</p>
        {!!d.brief.notThis.length && <p className="muted"><strong>Not:</strong> {d.brief.notThis.join("; ")}</p>}
      </div>
      <h4>Screens</h4>
      <div className="product-screens">
        {d.screens.map((s, k) => (
          <div key={s.id} className="product-screen">
            <div className="take-head"><span className="mono muted">{k + 1}</span> <strong>{s.name}</strong>{k === 0 && <span className="vote">home</span>}</div>
            <div className="take-text">{s.purpose}</div>
            <ul>{s.shows.map((x) => <li key={x}>{x}</li>)}</ul>
            <div className="product-actions">{s.actions.map((x) => <span key={x} className="chip">{x}</span>)}</div>
          </div>
        ))}
      </div>
      <h4>Journeys</h4>
      {d.journeys.map((j) => (
        <div key={j.moment} className="product-journey">
          <div className="take-head"><strong>{j.moment}</strong> <span className="muted">{j.goal}</span></div>
          <ol className="product-steps">{j.steps.map((s, k) => <li key={k}>{s}</li>)}</ol>
        </div>
      ))}
      <h4>Requirements</h4>
      <table className="product-reqs"><tbody>
        {d.requirements.map((q) => <tr key={q.id}><td className="mono muted">{q.id}</td><td>{q.text}</td><td className="muted">{q.from === "person" ? "you asked" : "design"}</td><td className="muted">{q.must ? "must" : "nice to have"}</td></tr>)}
      </tbody></table>
      {!!d.research.length && <><h4>Research</h4><ul className="product-research">{d.research.map((x, k) => <li key={k}>{x.finding}{x.source && <> <span className="mono muted">{x.source}</span></>}</li>)}</ul></>}
      {!!d.rules?.length && <BriefList title="Rules the product decides by" cls="props" items={d.rules.map((r) => (r.name ? `${r.name}: ${r.rule}` : r.rule))} />}
      {!!d.assumptions.length && <BriefList title="Assumptions" cls="props" items={d.assumptions} />}
    </div>
  );
}

function overlap(a: string, b: string) {
  const t = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  const A = t(a), B = t(b);
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return A.size && B.size ? n / (A.size + B.size - n) >= 0.4 : false;
}

function BriefList({ title, cls, items }: { title: string; cls: string; items: string[] }) {
  if (!items.length) return null;
  return <div className={`brief-sec ${cls}`}><span className="kind">{title}</span><ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul></div>;
}

function ReviewView({ run }: { run: FactoryRunView }) {
  const st = run.stations.review;
  if (!run.reviews.length) return <div className="empty">{st?.state === "skipped" ? "Review was turned off for this run." : st?.state === "active" ? "The Reviewer is reading the build…" : "After the tests pass, the Reviewer checks the build against the spec."}</div>;
  return (
    <div className="reviews">
      {run.reviews.map((r) => (
        <div key={r.round} className={`review-card ${r.verdict}`}>
          <div className="take-head"><strong>Round {r.round}</strong> <span className="mono muted">{r.agent}</span> <span className="vote">{r.verdict === "fix" ? "sent to the Fixer" : "pass"}</span></div>
          {r.criteria?.length ? (
            <ul className="criteria">{r.criteria.map((c, i) => <li key={i} className={c.pass ? "crit-pass" : "crit-fail"}><span className="kind">{c.pass ? "seen working" : "not met"}</span> {c.text}{c.evidence && <div className="muted small">{c.evidence}</div>}</li>)}</ul>
          ) : null}
          {r.findings.length ? <ul>{r.findings.map((f, i) => <li key={i} className={`sev-${f.severity}`}><span className="kind">{f.severity}</span> {f.text}</li>)}</ul> : <div className="muted">No findings.</div>}
        </div>
      ))}
    </div>
  );
}

const RUNG: Record<string, string> = { deeper: "Deeper fix on a stronger model", dispute: "Questioning a locked test", person: "Asking you", normal: "Back to normal fixes" };

/** The engine's loop, drawn: each fix attempt (what it changed, failing before → after), each step up the ladder. */
function LoopView({ run }: { run: FactoryRunView }) {
  if (!run.loop.length) return <div className="empty">{run.fixRounds ? "Loading the loop…" : "When a test fails, every fix attempt shows here: what it changed, what the agent said, and whether the failures went down. A stall climbs a ladder (a deeper fix on a stronger model, then questioning a locked test) before you are asked."}</div>;
  return (
    <ol className="loop-list">
      {run.loop.map((l: LoopEventView, i) => {
        if (l.kind === "attempt") {
          const trend = l.after < l.before ? "down" : l.after > l.before ? "up" : "flat";
          return (
            <li key={i} className={`loop-item attempt ${l.after === 0 ? "green" : trend}`}>
              <div className="loop-head"><b>Round {l.round}</b> <span className="muted">{l.agent} · {l.model}</span> <span className={`loop-trend ${trend}`}>failing {l.before} → {l.after}</span></div>
              <div className="loop-files">{l.files.length ? l.files.slice(0, 8).join(", ") : "changed nothing"}</div>
              {l.said && <p className="loop-said">{l.said}</p>}
              {l.dispute && <p className="loop-dispute">Disputed a test: {l.dispute}</p>}
            </li>
          );
        }
        if (l.kind === "ladder") return <li key={i} className="loop-item ladder"><b>{RUNG[l.to] ?? l.to}</b> <span className="muted">{l.reason}</span></li>;
        if (l.kind === "relocked") return <li key={i} className="loop-item relocked"><b>Locked tests corrected and locked again</b> <span className="muted">{l.files.join(", ")}</span><p className="loop-said">{l.reason}</p></li>;
        return <li key={i} className="loop-item kept"><b>The locked tests stand</b><p className="loop-said">{l.said || l.evidence}</p></li>;
      })}
    </ol>
  );
}
