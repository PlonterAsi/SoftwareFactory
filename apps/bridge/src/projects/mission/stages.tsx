import { useState } from "react";
import type { DiscoveryRoundView, FactoryRunView, ProductDocsView } from "../../api";
import { GateActions } from "../../GateActions";
import { CouncilView, JudgeView, LoopView, ReviewView, TestGrid } from "../../RunDeck";
import { designRounds, type StopId } from "./model";

const CRIT: [string, string][] = [["coverage", "Coverage"], ["journey", "Journeys"], ["screens", "Screens"], ["originality", "Originality"], ["buildable", "Buildable"]];

/** The detail of one stop, opened under the track. */
export function StageView({ id, run }: { id: StopId; run?: FactoryRunView }) {
  if (!run) return <Intro />;
  switch (id) {
    case "idea": return <Stage title="Your idea" lead={null}><p className="ms-idea-full">{run.idea}</p>{run.resumed && <p className="muted small">Picked up again from {run.resumed.from}{run.resumed.auto ? " by itself" : ""} ({run.resumed.count}×).</p>}</Stage>;
    case "council": return <Stage title="Council" lead="Six seats read your idea before anything is designed: what to build, what to change, what to drop."><CouncilView run={run} /></Stage>;
    case "design": return <DesignLoop run={run} />;
    case "plan": return <PlanBoard run={run} />;
    case "ok1": return <GateStage run={run} gate="gateA" title="Your OK: plan" lead="You read the plan and approve it or send it back with a note. One of the two places a run stops for you." />;
    case "build": return <BuildStage run={run} />;
    case "check": return <CheckStage run={run} />;
    case "judge": return <JudgeStage run={run} />;
    case "ok2": return <GateStage run={run} gate="gateB" title="Your OK: build" lead="After the Judge, you try the running app and accept it or send it back with what to fix." />;
    case "ship": return <Stage title="Ship" lead="The app is committed, tagged and listed under Finished apps with a Use button.">{run.finished?.outcome === "shipped" ? <p>Shipped{run.finished.sha ? <> at <span className="mono">{run.finished.sha.slice(0, 8)}</span></> : null}{run.finished.totalUsd != null ? ` for $${run.finished.totalUsd.toFixed(2)}` : ""}. Open it from the Use tab.</p> : <p className="muted">Not shipped yet.</p>}</Stage>;
  }
}

function Stage({ title, lead, tag, children }: { title: string; lead: string | null; tag?: string; children: React.ReactNode }) {
  return (
    <div className="ms-stage-in">
      <h2>{title}{tag && <span className="ms-tag">{tag}</span>}</h2>
      {lead && <p className="ms-lead">{lead}</p>}
      {children}
    </div>
  );
}

function Intro() {
  return (
    <Stage title="How a build travels" lead="Your idea goes through every stop on the track above. Two of them are yours: the plan and the finished build. Everything else runs on its own.">
      <ol className="ms-intro">
        <li><b>Council</b> Six seats say what to build, change or drop.</li>
        <li><b>Design loop</b> A Designer writes the product (who, journeys, screens) and a Critic scores it until it reaches the bar.</li>
        <li><b>Plan</b> One view per screen and a check for every requirement.</li>
        <li><b>Build</b> One feature at a time, the locked tests run after each.</li>
        <li><b>Test and fix</b> Failures go to the Fixer until the tests pass.</li>
        <li><b>Judge</b> A separate agent uses the running app and checks each requirement on screen.</li>
      </ol>
    </Stage>
  );
}

function Pips({ v, bar }: { v: number; bar: number }) {
  return (
    <span className="ms-pipcell" title={`${v} of 5; the bar is ${bar}`}>
      <span className={`ms-pips${v < bar ? " low" : ""}`} style={{ ["--bar" as string]: bar }}>{[1, 2, 3, 4, 5].map((k) => <i key={k} className={k <= v ? "f" : ""} />)}</span>
      <span className="mono ms-pipv">{v}</span>
    </span>
  );
}

/** Discovery as a match: the Designer writes, the Critic scores five lines, every line must reach the bar. */
function DesignLoop({ run }: { run: FactoryRunView }) {
  const rounds = designRounds(run);
  const settled = run.discovery.find((d) => d.settled);
  const [pick, setPick] = useState<number | null>(null);
  if (!rounds.length) {
    const s = run.stations.discover;
    return <Stage title="Design loop" lead={s?.state === "skipped" ? (s.note ?? "This run kept the app's existing design.") : "The Designer is writing the product documents. The Critic scores them next."}>{null}</Stage>;
  }
  const last = rounds.at(-1)!;
  const shown = rounds.find((r) => r.round === pick) ?? last;
  const bar = last.bar;
  return (
    <Stage title="Design loop" lead={`The Designer writes the product and the Critic, who sees only your words and the documents, scores it on five lines. Every line must reach ${bar}. Under the bar, the Designer revises, up to 3 rounds.`}>
      <div className="ms-fighters">
        <div className="ms-fighter"><span className="ms-av">De</span><div><b>Designer</b><span>brief, journeys, screens, requirements</span></div></div>
        <span className="mono muted">{rounds.length} round{rounds.length > 1 ? "s" : ""}</span>
        <div className="ms-fighter critic"><span className="ms-av">Cr</span><div><b>Critic</b><span>scores against your words</span></div></div>
      </div>
      <div className="ms-duel-wrap">
        <table className="ms-duel">
          <thead><tr><th>Line</th>{rounds.map((r) => <th key={r.round} className={r === last ? "kept" : ""}><button className="ms-linkbtn" onClick={() => setPick(r.round)} aria-pressed={shown === r}>Round {r.round}{r.pass ? " ✓" : ""}{r === last ? " · kept" : ""}</button></th>)}</tr></thead>
          <tbody>{CRIT.map(([k, label]) => <tr key={k}><td>{label}</td>{rounds.map((r) => <td key={r.round}>{r.critique ? <Pips v={r.critique.scores[k] ?? 0} bar={r.bar} /> : "–"}</td>)}</tr>)}</tbody>
        </table>
      </div>
      {last.pass
        ? <div className="ms-verdict ok"><b>Passed.</b> Every line reached {bar} in round {last.round}, so these documents went on to the Plan.</div>
        : settled ? <div className="ms-verdict warn"><b>Went on under the bar.</b> {cap(settled.settled!)}. The best documents (round {last.round}) went on to the Plan with the Critic's open notes.</div>
        : <div className="ms-verdict live"><b>Still looping.</b> Round {last.round} is under the bar; the Designer is revising.</div>}
      {!!shown.critique?.problems.length && <>
        <h3>{shown === last && !last.pass ? "What the Critic still wants" : `The Critic's notes, round ${shown.round}`}</h3>
        <div className="ms-probs">{shown.critique.problems.map((p, i) => <div key={i} className="ms-prob"><span className="mono">{p.where}</span>{p.problem}{p.fix && <em>Fix: {p.fix}</em>}</div>)}</div>
      </>}
      <h3>What came out: {shown.docs.screens.length} screens, {shown.docs.journeys.length} journeys, {shown.docs.requirements.length} requirements</h3>
      <ScreenStrip docs={shown.docs} run={run} />
    </Stage>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The screens in navigation order, each as a little window. Built screens light up during the build. */
export function ScreenStrip({ docs, run }: { docs: ProductDocsView; run?: FactoryRunView }) {
  const stateOf = (name: string) => run?.features.find((f) => f.title.toLowerCase().includes(name.toLowerCase()))?.state;
  return (
    <div className="ms-screens">
      {docs.screens.map((s, i) => {
        const st = stateOf(s.name);
        return (
          <div key={s.id} className={`ms-scr${st ? ` st-${st}` : ""}`} title={s.purpose}>
            <div className="ms-mini" aria-hidden>
              <div className="nav">{docs.screens.map((_, k) => <i key={k} className={k === i ? "on" : ""} />)}</div>
              <div className="cnt"><i /><i /><i /><i /></div>
            </div>
            <div className="ms-scr-t">{s.name}<span className="mono">{st === "built" ? "built" : st === "building" ? "building" : st === "regressed" ? "broke a test" : i + 1}</span></div>
            <div className="ms-scr-p">{s.purpose}</div>
          </div>
        );
      })}
    </div>
  );
}

/** The plan as a board: tasks in columns by what they wait on, the checks that say "done", and the requirements behind them. */
function PlanBoard({ run }: { run: FactoryRunView }) {
  const plan = run.plan;
  const docs = designRounds(run).at(-1)?.docs;
  const lastEval = run.evaluations.filter((e) => !e.skipped).at(-1);
  const met = new Map(lastEval?.requirements.map((q) => [q.id, q.met]) ?? []);
  if (!plan) {
    return (
      <Stage title="Plan" tag={run.stations.plan?.state === "active" ? "writing now" : undefined} lead="The Planner turns the design into tasks, one view per screen, and a check for every requirement. Then it waits for your OK.">
        {docs ? <>
          <div className="ms-meter"><div><b>{docs.screens.length}</b><span>screens to plan</span></div><div><b>{docs.requirements.filter((r) => r.must).length}</b><span>must-have requirements</span></div><div><b>{docs.journeys.length}</b><span>journeys</span></div></div>
          <div className="ms-board">{docs.screens.map((s) => <div key={s.id} className="ms-lane"><h5>{s.name}</h5><div className="ms-task pending">waiting for the Planner</div></div>)}</div>
          <Reqs docs={docs} met={met} />
        </> : <p className="muted">Waiting for the Planner.</p>}
      </Stage>
    );
  }
  // Columns by dependency depth: step 1 needs nothing, step 2 needs step 1, and so on.
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
  const cols: typeof plan.tasks[] = [];
  plan.tasks.forEach((t) => (cols[depth.get(t.id)!] ??= []).push(t));
  const builtFiles = new Set(Object.keys(run.files));
  const doneTask = (title: string) => [...builtFiles].some((f) => title.includes(f));
  return (
    <Stage title={plan.name || "Plan"} lead={plan.summary}>
      <div className="ms-meter">
        <div><b>{plan.tasks.length}</b><span>tasks</span></div>
        <div><b>{cols.length}</b><span>steps</span></div>
        <div><b>{plan.acceptance.length}</b><span>checks that mean done</span></div>
        {docs && <div><b>{docs.requirements.length}</b><span>requirements</span></div>}
      </div>
      <div className="ms-board steps">
        {cols.map((c, i) => (
          <div key={i} className="ms-lane">
            <h5>Step {i + 1}<span>{i === 0 ? "needs nothing" : `after step ${i}`}</span></h5>
            {c.map((t) => <div key={t.id} className={`ms-task${doneTask(t.title) ? " done" : ""}`}><b className="mono">{t.id}</b>{t.title}{t.dependsOn.length > 0 && <span className="ms-dep">needs {t.dependsOn.join(", ")}</span>}</div>)}
          </div>
        ))}
      </div>
      <h3>Done means</h3>
      <ol className="ms-checks">{plan.acceptance.map((a, i) => <li key={i}>{a}</li>)}</ol>
      {docs && <Reqs docs={docs} met={met} />}
    </Stage>
  );
}

function Reqs({ docs, met }: { docs: ProductDocsView; met: Map<string, boolean> }) {
  return <>
    <h3>Requirements</h3>
    <div className="ms-reqs">{docs.requirements.map((r) => {
      const m = met.get(r.id);
      return <span key={r.id} className={`ms-req${r.from === "design" ? " d" : ""}${m === true ? " ok" : m === false ? " no" : ""}`} title={`${r.text}${r.must ? "" : " (nice to have)"}`}>{r.id}</span>;
    })}</div>
    <p className="muted small">Solid: you asked for it. Dashed: the Designer added it. Green or red once the Judge has used the app. Hover for the text.</p>
  </>;
}

function GateStage({ run, gate, title, lead }: { run: FactoryRunView; gate: "gateA" | "gateB"; title: string; lead: string }) {
  const waiting = run.waiting?.gate === gate;
  const lastEval = run.evaluations.filter((e) => !e.skipped).at(-1);
  return (
    <Stage title={title} lead={lead}>
      {waiting && <div className="ms-gate"><GateActions run={run} /></div>}
      {gate === "gateA" && run.plan && <p>The plan: <b>{run.plan.tasks.length} tasks</b>, <b>{run.plan.acceptance.length} checks</b>. Open the Plan stop to read it.</p>}
      {gate === "gateB" && lastEval && <p>The Judge saw <b>{lastEval.requirements.filter((q) => q.met).length} of {lastEval.requirements.length}</b> requirements working. Open the Judge stop for the red ones.</p>}
      {!waiting && <p className="muted">{run.stations[gate]?.state === "pass" ? "Approved." : "Not reached yet."}</p>}
    </Stage>
  );
}

function BuildStage({ run }: { run: FactoryRunView }) {
  const docs = designRounds(run).at(-1)?.docs;
  const f = run.features;
  const last = f.filter((x) => x.passed != null).at(-1);
  const total = last ? (last.passed ?? 0) + (last.failed ?? 0) : 0;
  const ahead = Math.max(0, Math.max(0, ...f.map((x) => x.of ?? 0)) - f.length);
  return (
    <Stage title="Build" lead={f.length ? "One feature per fresh Builder session. After each one the core runs the locked tests for free, and a feature that breaks a passing test goes back once." : "The Tester writes the tests and locks them, then the Builder writes the app."}>
      {total > 0 && <div className="ms-xp"><span className="mono">{last!.passed}/{total}</span><div className="ms-xpbar"><i style={{ width: `${((last!.passed ?? 0) / total) * 100}%` }} /></div><span className="muted small">locked tests passing</span></div>}
      {f.length ? (
        <div className="ms-feats">
          {f.map((x) => {
            const t = (x.passed ?? 0) + (x.failed ?? 0);
            const label = { built: "built", building: "building now", regressed: `broke ${x.broke?.length ?? ""} test${x.broke?.length === 1 ? "" : "s"}, sent back`, empty: "nothing changed", broken: `screen did not draw${x.crashed?.length ? ": " + x.crashed[0] : ""}, sent back` }[x.state];
            return (
              <div key={x.id} className={`ms-feat fs-${x.state}`}>
                <span className="mono muted">{x.id}</span><span className="ms-feat-t">{x.title}{x.attempt > 1 ? <span className="muted"> · try {x.attempt}</span> : null}</span>
                <span className="ms-tb">{t > 0 && <i style={{ width: `${((x.passed ?? 0) / t) * 100}%` }} />}</span>
                <span className="ms-feat-s">{label}</span>
              </div>
            );
          })}
          {Array.from({ length: ahead }, (_, k) => <div key={`ahead${k}`} className="ms-feat fs-ahead"><span className="mono muted">F{f.length + k + 1}</span><span className="ms-feat-t muted">next feature</span><span className="ms-tb" /><span className="ms-feat-s">ahead</span></div>)}
        </div>
      ) : <p className="muted">{run.stations.build?.state ? "This build was written in one call (runs under $3 are)." : "Starts after you approve the plan."}</p>}
      {docs && <><h3>Screens</h3><ScreenStrip docs={docs} run={run} /></>}
    </Stage>
  );
}

function CheckStage({ run }: { run: FactoryRunView }) {
  const last = run.tests.at(-1);
  const total = last ? last.passed + last.failed : 0;
  return (
    <Stage title="Test and fix" lead="The core runs the locked tests. Failures go to the Fixer, who works until they pass; a stall climbs to a stronger model before anyone asks you. Then the Reviewer checks each criterion by running the app.">
      {total > 0 && <div className="ms-xp"><span className="mono">{last!.passed}/{total}</span><div className="ms-xpbar"><i style={{ width: `${(last!.passed / total) * 100}%` }} /></div><span className="muted small">tests passing{run.fixRounds ? ` after ${run.fixRounds} fix round${run.fixRounds > 1 ? "s" : ""}` : ""}</span></div>}
      <h3>Tests by round</h3><TestGrid run={run} />
      <h3>Fix rounds</h3><LoopView run={run} />
      <h3>Review</h3><ReviewView run={run} />
    </Stage>
  );
}

function JudgeStage({ run }: { run: FactoryRunView }) {
  const e = run.evaluations.filter((x) => !x.skipped).at(-1);
  const docs = designRounds(run).at(-1)?.docs;
  const text = new Map(docs?.requirements.map((r) => [r.id, r.text]) ?? []);
  return (
    <Stage title="Judge" lead="A separate agent that never sees the code opens the running app in a real browser and checks every must-have requirement on screen.">
      {e ? <>
        <div className="ms-meter">{Object.entries(e.scores).map(([k, v]) => <div key={k} className={v >= e.bar ? "" : "low"}><b>{v}<small>/5</small></b><span>{k}</span></div>)}
          <div><b>{e.requirements.filter((q) => q.met).length}<small>/{e.requirements.length}</small></b><span>seen working</span></div></div>
        <div className="ms-hearts">{e.requirements.map((q) => <span key={q.id} className={`ms-heart ${q.met ? "ok" : "no"}`} title={`${text.get(q.id) ?? q.id}\n\n${q.met ? "Seen: " : "Not seen: "}${q.evidence}`}>{q.id}</span>)}</div>
        <h3>Details</h3>
      </> : docs ? <div className="ms-hearts">{docs.requirements.filter((r) => r.must).map((r) => <span key={r.id} className="ms-heart" title={r.text}>{r.id}</span>)}</div> : null}
      <JudgeView run={run} />
    </Stage>
  );
}

/** The product documents of the latest design, for the Product tab. */
export function ProductDocs({ round, run }: { round: DiscoveryRoundView; run: FactoryRunView }) {
  const d = round.docs;
  const lastEval = run.evaluations.filter((e) => !e.skipped).at(-1);
  const met = new Map(lastEval?.requirements.map((q) => [q.id, q.met]) ?? []);
  return (
    <div className="ms-product">
      <section className="ms-brief">
        <div><span>For</span><p>{d.brief.who}</p></div>
        <div><span>Problem</span><p>{d.brief.problem}</p></div>
        <div className="promise"><span>Promise</span><p>{d.brief.promise}</p></div>
        {!!d.brief.notThis.length && <div><span>Not this</span><ul>{d.brief.notThis.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
      </section>
      <h3>Screens</h3>
      <ScreenStrip docs={d} run={run} />
      <h3>Journeys</h3>
      <div className="ms-journeys">
        {d.journeys.map((j) => (
          <details key={j.moment} className="ms-jr">
            <summary><b>{j.moment}</b><span>{j.goal}</span><span className="ms-steps" aria-label={`${j.steps.length} steps`}>{j.steps.map((_, k) => <i key={k} />)}</span></summary>
            <ol>{j.steps.map((s, k) => <li key={k}>{s}</li>)}</ol>
          </details>
        ))}
      </div>
      <h3>Requirements</h3>
      <table className="ms-reqtable"><tbody>
        {d.requirements.map((q) => {
          const m = met.get(q.id);
          return <tr key={q.id}><td className="mono">{q.id}</td><td>{q.text}</td><td className="muted">{q.from === "person" ? "you asked" : "Designer"}</td><td className={m === true ? "ok" : m === false ? "no" : "muted"}>{m === true ? "seen working" : m === false ? "not seen" : q.must ? "must" : "nice to have"}</td></tr>;
        })}
      </tbody></table>
    </div>
  );
}
