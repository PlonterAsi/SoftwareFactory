import { useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, Background, type ReactFlowInstance, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { flowsApi, type FlowStepView, type FlowSummaryView, type FlowView } from "./api";
import { Station, edgesFor, nodesFor, type StationData } from "./FactoryFloor";
import { loadFlow } from "./flowData";

const KIND_WORD: Record<FlowStepView["kind"], string> = { step: "Step", loop: "Loop", gate: "Your OK" };
/** The library grouped by who carries each flow out, cheapest last so the engine leads. */
const GROUPS: { runner: FlowSummaryView["runner"]; label: string; note: string }[] = [
  { runner: "engine", label: "The whole engine", note: "design, plan, build, judge · dollars" },
  { runner: "session", label: "One Builder session", note: "in a clone of the repo · cents" },
  { runner: "answer", label: "Answered, nothing changed", note: "a reader · cents" },
  { runner: "door", label: "Carried out by their own screen", note: "drawn here so every kind of work is on one map" },
];

/**
 * The flows the engine follows. Each flow is data: its steps in order, which steps are loops and what ends
 * them, where it stops for you, and which crew slot works each step. The engine carries out the flow a run
 * started with, and the factory floor draws the same definition.
 */
export function FlowsPage() {
  const [list, setList] = useState<FlowSummaryView[] | null>(null);
  const [agents, setAgents] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [pick, setPick] = useState("new-project");
  const [flow, setFlow] = useState<FlowView | null>(null);
  const [history, setHistory] = useState<{ version: number; savedBy: string; savedAt: string }[]>([]);
  const [step, setStep] = useState<string | null>(null);
  useEffect(() => { flowsApi.list().then((j) => { setList(j.flows); setAgents(j.agents); }).catch((e) => setErr(String(e.message ?? e))); }, []);
  useEffect(() => {
    let live = true;
    setStep(null);
    loadFlow(pick).then((f) => { if (live) setFlow(f); }).catch((e) => setErr(String(e.message ?? e)));
    flowsApi.get(pick).then((j) => { if (live) setHistory(j.history); }).catch(() => { /* the flow itself says what failed */ });
    return () => { live = false; };
  }, [pick]);
  const nodes = useMemo<Node<StationData>[]>(() => nodesFor(flow).map((n) => ({ ...n, selected: n.id === step })), [flow, step]);
  const edges = useMemo(() => edgesFor(flow), [flow]);
  const rf = useRef<ReactFlowInstance<Node<StationData>> | null>(null);
  useEffect(() => { requestAnimationFrame(() => rf.current?.fitView({ padding: 0.1 })); }, [flow?.id]);
  const picked = flow?.steps.find((s) => s.id === step) ?? null;

  return (
    <div className="fpage flows-page">
      <header className="flows-head">
        <h1>Flows</h1>
        <p className="muted">How each kind of work travels through the factory. A run follows the flow it started with; the factory floor and the project track draw the same steps. Pick a step to read its rule.</p>
      </header>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="flows-grid">
        <nav className="flows-list" aria-label="Flows">
          {!list && !err && <div className="muted">Loading…</div>}
          {list && GROUPS.map((g) => {
            const fs = list.filter((f) => (f.runner ?? "engine") === g.runner);
            if (!fs.length) return null;
            return (
              <div key={g.runner} className="flows-group">
                <div className="flows-group-head"><b>{g.label}</b> <span className="muted small">{g.note}</span></div>
                {fs.map((f) => (
                  <button key={f.id} className={`flows-item${pick === f.id ? " on" : ""}`} aria-pressed={pick === f.id} onClick={() => setPick(f.id)}>
                    <b>{f.name}</b>
                    <span className="muted small">{f.steps} steps · v{f.version}{f.builtIn ? " · as shipped" : " · edited"}{f.kinds.length ? ` · takes ${f.kinds.join(", ")} tickets` : ""}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </nav>
        <section className="flows-main">
          {flow && <>
            <div className="flows-canvas" aria-label={`${flow.name} drawn`}>
              <ReactFlow onInit={(i) => { rf.current = i; }} nodes={nodes} edges={edges} nodeTypes={{ station: Station }} fitView fitViewOptions={{ padding: 0.1 }}
                proOptions={{ hideAttribution: true }} nodesConnectable={false} nodesDraggable={false} elementsSelectable panOnDrag zoomOnScroll={false}
                onNodeClick={(_, n) => setStep(n.id === step ? null : n.id)} onPaneClick={() => setStep(null)}>
                <Background gap={24} size={1} color="var(--grid)" />
              </ReactFlow>
            </div>
            {picked ? <StepCard s={picked} flow={flow} /> : (
              <div className="flows-about">
                <p>{flow.purpose}</p>
                {flow.brief && <p className="small"><b>Told to the crew on every run:</b> {flow.brief}</p>}
                {flow.door && <p className="small muted"><b>Carried out by:</b> {flow.door}. Its steps follow these boxes once that screen reads flows.</p>}
              </div>
            )}
            <table className="flows-steps">
              <thead><tr><th>#</th><th>Step</th><th>Kind</th><th>Who works it</th><th>Passes when</th><th>Stops anyway</th></tr></thead>
              <tbody>
                {flow.steps.map((s, i) => (
                  <tr key={s.id} className={s.id === step ? "on" : ""} onClick={() => setStep(s.id)}>
                    <td className="mono muted">{s.within ? "" : flow.steps.filter((x) => !x.within).indexOf(s) + 1}</td>
                    <td><b>{s.label}</b>{s.within && <span className="muted small"> inside {flow.steps.find((x) => x.id === s.within)?.label}</span>}<div className="muted small">{s.sub}</div></td>
                    <td><span className={`flows-kind k-${s.kind}`}>{KIND_WORD[s.kind]}</span>{s.loop?.maxRounds ? <span className="mono muted small"> ≤{s.loop.maxRounds}</span> : null}</td>
                    <td className="small">{s.agents.length ? s.agents.join(", ") : <span className="muted">the core</span>}</td>
                    <td className="small">{s.loop?.passes ?? (s.gate ? "you approve" : "")}</td>
                    <td className="small">{s.loop?.stops ?? (s.skippedWhen ? `skipped when ${s.skippedWhen}` : "")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">
              Version {flow.version}{history.length ? `, saved ${history.length} time${history.length > 1 ? "s" : ""}` : ", as SoftwareFactory ships it"}.
              Crew slots a step may name: {agents.join(", ")}. Editing a flow in words or by dragging comes in a later phase; the engine and one-session tickets already follow whatever flow is saved. Pick a flow for one ticket on the ticket itself.
            </p>
          </>}
        </section>
      </div>
    </div>
  );
}

function StepCard({ s, flow }: { s: FlowStepView; flow: FlowView }) {
  const into = flow.edges.filter((e) => e.to === s.id).map((e) => flow.steps.find((x) => x.id === e.from)?.label ?? e.from);
  const out = flow.edges.filter((e) => e.from === s.id).map((e) => `${flow.steps.find((x) => x.id === e.to)?.label ?? e.to}${e.label ? ` (${e.label})` : ""}`);
  return (
    <div className="flows-card" aria-live="polite">
      <h3>{s.label} <span className={`flows-kind k-${s.kind}`}>{KIND_WORD[s.kind]}</span></h3>
      <dl>
        <dt>Does</dt><dd>{s.sub}{s.action ? "" : s.within ? `, inside ${flow.steps.find((x) => x.id === s.within)?.label}` : ""}</dd>
        <dt>Who</dt><dd>{s.agents.length ? s.agents.join(", ") : "the core, no agent"}</dd>
        {s.loop && <><dt>Goal</dt><dd>{s.loop.goal}</dd><dt>Judged by</dt><dd>{s.loop.observer}</dd><dt>Passes when</dt><dd>{s.loop.passes}</dd><dt>Stops anyway</dt><dd>{s.loop.stops}{s.loop.maxRounds ? ` (at most ${s.loop.maxRounds} rounds)` : ""}</dd></>}
        {s.gate && <><dt>Asks you</dt><dd>{s.gate.asks}</dd><dt>Answers itself</dt><dd>{s.gate.auto}</dd></>}
        {s.skippedWhen && <><dt>Skipped when</dt><dd>{s.skippedWhen}</dd></>}
        {into.length > 0 && <><dt>Comes from</dt><dd>{into.join(", ")}</dd></>}
        {out.length > 0 && <><dt>Goes to</dt><dd>{out.join(", ")}</dd></>}
      </dl>
    </div>
  );
}
