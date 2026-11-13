import { useEffect, useMemo, useState, type FormEvent } from "react";
import { duplicateOf, projectsApi, resumeRun, type DuplicateRun, type FactoryRunView } from "../../api";
import { DuplicateNotice } from "../../DuplicateNotice";
import { AskBanner } from "../../Intake";
import { GateActions } from "../../GateActions";
import { ago, describe } from "../builtin";
import { inProject, projectSets, registerProjectPanel, type PanelContext } from "../panels";
import { MissionTrack } from "./MissionTrack";
import { currentStop, designRounds, headline, ORDER, stopsFor, type StopId } from "./model";
import { ProductDocs, StageView } from "./stages";
import "./mission.css";

const usd = (n: number) => `$${n.toFixed(2)}`;
function minutes(from: string, to?: string) {
  const m = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/**
 * A project's first tab: its latest build as a mission. The track shows every stop of the run,
 * the sentence above it says what is happening now, and the stop you pick opens below.
 */
function Mission(ctx: PanelContext) {
  const { project: p, factory, events } = ctx;
  const mine = useMemo(() => factory.factoryRuns.filter((r) => p.runIds.includes(r.run)), [factory.factoryRuns, p.runIds]);
  const [runId, setRunId] = useState<number | null>(ctx.pickedRun);
  const run = mine.find((r) => r.run === runId) ?? mine.at(-1);
  const stops = useMemo(() => stopsFor(run), [run]);
  const cur = currentStop(stops);
  const [picked, setPicked] = useState<StopId | null>(null);
  // Follow the run as it moves, until you pick a stop yourself.
  useEffect(() => { setPicked(null); }, [run?.run]);
  const sel = picked ?? (run ? cur.id : "idea");
  const h = headline(run, stops);
  const idx = ORDER.indexOf(cur.id) + 1;
  return (
    <div className="mission">
      <AskBanner projectId={p.id} name={p.name} hasRuns={p.runIds.length > 0 || p.links.some((l) => l.kind === "self")} archived={p.status === "archived"} />
      <section className="ms-head">
        <div className="ms-what">
          <div className="ms-eyebrow">
            {run ? <>
              {mine.length > 1
                ? <select className="ms-runpick mono" value={run.run} onChange={(e) => setRunId(Number(e.target.value))} aria-label="Which build">
                    {[...mine].reverse().map((r) => <option key={r.run} value={r.run}>Run #{r.run} · {r.finished?.outcome ?? (r.waiting ? "waits for you" : "running")}</option>)}
                  </select>
                : <span className="mono">Run #{run.run}</span>}
              <span>Stop {idx} of {ORDER.length}</span>
              <span>{run.finished ? `took ${minutes(run.startedAt, lastTs(run, events))}` : `${minutes(run.startedAt)} in`}</span>
            </> : <span>No build yet</span>}
          </div>
          <p className={`ms-now tone-${h.tone}`}>{h.who && <em>{h.who} </em>}{h.text}</p>
          {run && <p className="ms-idea" title={run.idea}>{run.idea}</p>}
        </div>
        {run && <Fuel run={run} />}
      </section>
      <MissionTrack stops={stops} selected={sel} onSelect={setPicked} />
      <section className="ms-stage">
        <div className="ms-card ms-main" key={`${run?.run}:${sel}`}><StageView id={sel} run={run} /></div>
        <aside className="ms-aside">
          <ForYou run={run} onOpen={setPicked} />
          <NextIdea {...ctx} />
          <Latest {...ctx} />
        </aside>
      </section>
    </div>
  );
}

function lastTs(run: FactoryRunView, events: PanelContext["events"]) {
  for (let i = events.length - 1; i >= 0; i--) { const e = events[i]; if (e.type === "factory.run.finished" && Number(e.payload?.run) === run.run) return e.ts; }
  return undefined;
}

function Fuel({ run }: { run: FactoryRunView }) {
  const pct = run.maxUsd ? Math.min(100, (run.spentUsd / run.maxUsd) * 100) : 0;
  return (
    <div className="ms-fuel" aria-label={`Budget: ${usd(run.spentUsd)} of ${usd(run.maxUsd)}`}>
      <div className="row"><span>Budget</span><span className="mono">{usd(run.spentUsd)} / {usd(run.maxUsd)}</span></div>
      <div className="bar"><i style={{ width: `${pct}%` }} /><b style={{ left: "35%" }} title="The design loop may use up to 35%" /></div>
      <div className="row muted"><span>design may use 35%</span><span>{Math.round(pct)}% used</span></div>
    </div>
  );
}

/** What the run needs from you: the approval in place, a resume, or what comes next. */
function ForYou({ run, onOpen }: { run?: FactoryRunView; onOpen: (s: StopId) => void }) {
  if (!run) return null;
  if (run.waiting) {
    const at: StopId = run.waiting.gate === "gateA" ? "ok1" : run.waiting.gate === "gateB" ? "ok2" : "check";
    return (
      <div className="ms-card ms-you on">
        <h4><i />{run.waiting.gate === "gateA" ? "Your OK: plan" : run.waiting.gate === "gateB" ? "Your OK: build" : "Your call"}</h4>
        <GateActions run={run} compact />
        <button className="ghost sm" onClick={() => onOpen(at === "ok1" ? "plan" : at === "ok2" ? "judge" : at)}>{at === "ok1" ? "Read the plan" : at === "ok2" ? "See what the Judge saw" : "Show the loop"}</button>
      </div>
    );
  }
  if (run.finished?.resumable) {
    return (
      <div className="ms-card ms-you on">
        <h4><i />Stopped part way</h4>
        <p>{run.finished.reason}</p>
        <button onClick={() => resumeRun(run.run).catch(() => undefined)}>Resume from where it stopped</button>
      </div>
    );
  }
  if (run.finished) return null;
  const next = !run.stations.gateA || run.stations.gateA.state === "idle" ? "the plan" : "the finished build";
  return (
    <div className="ms-card ms-you">
      <h4><i />Coming up for you</h4>
      <p>Nothing needs you right now. You approve {next} when it is ready; it shows here and under Needs you.</p>
    </div>
  );
}

/** Build the next idea in this project (moved here from the old Overview). */
function NextIdea({ project: p, showRun }: PanelContext) {
  const [idea, setIdea] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dup, setDup] = useState<DuplicateRun | null>(null);
  const hasApp = p.rollup.shipped > 0;
  const [asNew, setAsNew] = useState(false);
  const onTop = hasApp && !asNew;
  async function build(e?: FormEvent, again = false) {
    e?.preventDefault();
    if (!idea.trim() || busy) return;
    setBusy(true);
    setDup(null);
    try { const { run } = await projectsApi.build(p.id, idea.trim(), undefined, again, onTop); setIdea(""); setErr(null); showRun(run); }
    catch (x) { const d = duplicateOf(x); if (d) setDup(d); else setErr((x as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <form className="ms-card ms-next" onSubmit={build}>
      <h4>{onTop ? "Add to this app" : p.runIds.length ? "Build another idea" : "Build your first idea"}</h4>
      <textarea value={idea} rows={2} onChange={(e) => setIdea(e.target.value)} placeholder={onTop ? `Add something to ${p.name}…` : `One line is enough…`} aria-label="Idea to build in this project"
        onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) build(); }} />
      <div className="row">
        <button type="submit" disabled={!idea.trim() || busy}>{busy ? "Starting…" : onTop ? "Add it" : "Build it"}</button>
        {hasApp && <label className="muted small"><input type="checkbox" checked={asNew} onChange={(e) => setAsNew(e.target.checked)} /> as a new app</label>}
      </div>
      {err && <p className="error" role="alert">{err}</p>}
      {dup && <DuplicateNotice dup={dup} busy={busy} onShow={showRun} onDismiss={() => setDup(null)} onAgain={() => build(undefined, true)} />}
    </form>
  );
}

function Latest({ project, events, go }: PanelContext) {
  const sets = useMemo(() => projectSets(project), [project]);
  const items = useMemo(() => events.filter((e) => inProject(e, project, sets)).map((e) => ({ e, text: describe(e) ?? stepLine(e) })).filter((x) => x.text).slice(-7).reverse(), [events, project, sets]);
  return (
    <div className="ms-card ms-latest">
      <h4>Latest</h4>
      {items.length ? <ol>{items.map(({ e, text }) => <li key={e.id}><time className="mono">{ago(e.ts)}</time><span>{text}</span></li>)}</ol> : <p className="muted small">Nothing yet.</p>}
      <button className="ghost sm" onClick={() => go("history")}>Full history</button>
    </div>
  );
}

/** Short lines for the engine's own steps, which the project history leaves out. */
function stepLine(e: PanelContext["events"][number]): string | null {
  const p = e.payload ?? {};
  if (e.type === "factory.discovery" && !p.settled && p.critique) return `Critic, round ${p.round}: ${Object.values(p.critique.scores as Record<string, number>).join("·")}${p.pass ? " (passed)" : ""}`;
  if (e.type === "factory.discovery" && p.settled) return `Design loop settled: ${p.settled}`;
  if (e.type === "factory.feature" && p.state === "built") return `${p.id} built: ${p.title}`;
  if (e.type === "factory.feature" && p.state === "regressed") return `${p.id} broke a passing test, sent back`;
  if (e.type === "factory.evaluation" && !p.skipped) return `Judge: ${(p.requirements ?? []).filter((q: { met: boolean }) => q.met).length}/${(p.requirements ?? []).length} seen working`;
  if (e.type === "factory.plan") return `Plan written: ${p.plan?.tasks?.length ?? 0} tasks`;
  return null;
}

/** The Product tab: the latest product design (brief, screens, journeys, requirements). */
function Product({ project: p, factory, go }: PanelContext) {
  const runs = factory.factoryRuns.filter((r) => p.runIds.includes(r.run) && designRounds(r).length);
  const run = runs.at(-1);
  const round = run ? designRounds(run).at(-1) : undefined;
  if (!run || !round) return <div className="mission"><div className="ms-card"><h2>No product design yet</h2><p className="ms-lead">The Design loop writes it on the next build: who it is for, the journeys, the screens and every requirement. <button className="ghost sm" onClick={() => go("overview")}>Go to Mission</button></p></div></div>;
  return (
    <div className="mission">
      <div className="ms-card">
        <p className="ms-eyebrow"><span className="mono">Run #{run.run}</span><span>design round {round.round}</span><span>{round.pass ? "passed the Critic" : "best of the loop"}</span></p>
        <ProductDocs round={round} run={run} />
      </div>
    </div>
  );
}

registerProjectPanel({
  id: "overview", section: "brief", title: "Mission", order: 0, render: (c) => <Mission {...c} />,
  alert: (c) => c.factory.factoryRuns.some((r) => c.project.runIds.includes(r.run) && !!r.waiting),
});
registerProjectPanel({
  id: "product", section: "brief", title: "Product", order: 5, render: (c) => <Product {...c} />,
  appliesTo: (p) => p.rollup.runs > 0,
});
