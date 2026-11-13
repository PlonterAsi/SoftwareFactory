import { GateActions, STEP } from "./GateActions";
import { useEffect, useRef, useState } from "react";
import { ReactFlow, Background, useNodesState, type ReactFlowInstance, type Edge, type Node, Handle, Position, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { resumeRun, setupApi, type AgentRunView, type CrewMode, type FactoryRunView, type StationState } from "./api";

type Worker = { name: string; avatar: string; since: string };
type StationData = { label: string; sub: string; gate?: boolean; later?: boolean; state: StationState; badge?: string; note?: string; workers?: Worker[] };
export type CrewIndex = Record<string, { name: string; avatar: string }>;

function Station({ data }: NodeProps<Node<StationData>>) {
  const w = data.workers ?? [];
  return (
    <div className={`station s-${data.state}${data.gate ? " gate" : ""}${data.later ? " later" : ""}${w.length ? " manned" : ""}`} title={data.note}>
      <Handle type="target" position={Position.Left} />
      {/* The agent working this station right now, docked on its top edge. */}
      {w.length > 0 && <div className="st-crew" aria-label={`${w.map((x) => x.name).join(", ")} working`}>{w.map((x, i) => <span key={i} className="st-avatar" title={x.name}>{x.avatar}</span>)}<span className="st-crew-name">{w.length === 1 ? w[0].name : `${w.length} seats`}</span></div>}
      <div className="st-name">{data.label}{data.badge && <span className="st-badge mono">{data.badge}</span>}</div>
      <div className="st-sub">{data.sub}</div>
      {data.state === "active" && <div className="st-scan" aria-hidden />}
      <Handle type="source" position={Position.Right} />
      <Handle id="b" type="source" position={Position.Bottom} />
      <Handle id="r" type="target" position={Position.Right} />
      <Handle id="t" type="target" position={Position.Top} />
      <Handle id="tb" type="source" position={Position.Top} />
      {/* Offset pair for the test ⇄ fix loop, so the two edges run side by side. */}
      <Handle id="b1" type="source" position={Position.Bottom} style={{ left: "35%" }} />
      <Handle id="b2" type="target" position={Position.Bottom} style={{ left: "65%" }} />
      <Handle id="t1" type="target" position={Position.Top} style={{ left: "35%" }} />
      <Handle id="t2" type="source" position={Position.Top} style={{ left: "65%" }} />
    </div>
  );
}

const X = [0, 190, 380, 570, 760];
// id, label, what it does, x, y, gate?, later?
const STATIONS: [string, string, string, number, number, boolean?, boolean?][] = [
  ["intake", "One-line idea", "saved as a note", X[0], 0],
  ["council", "Council", "up to 6 seats · big ideas", X[1], -95],
  ["discover", "Product design", "Designer ⇄ Critic loop", X[1], 0],
  ["plan", "Spec and plan", "Planner", X[2], 0],
  ["gateA", "Your OK: plan", "one tap", X[3], 0, true],
  ["tests", "Acceptance tests", "Tester, then locked", X[0], 130],
  ["build", "Build", "Builder", X[1], 130],
  ["test", "Test", "node --test", X[2], 130],
  ["review", "Review", "Reviewer vs spec", X[3], 130],
  ["gateB", "Your OK: build", "one tap", X[4], 130, true],
  ["fix", "Fix", "Fixer loop", X[2], 260],
  ["evaluate", "Product judge", "reads the running app", X[3], 260],
  ["ship", "Ship to disk", "git repo, tagged", X[4], 260],
];
const EDGES: [string, string, string?, string?][] = [
  ["intake", "discover"], ["intake", "council", "tb"], ["council", "discover", undefined, "t"], ["discover", "plan"], ["plan", "gateA"], ["gateA", "tests", "b", "t"], ["tests", "build"],
  ["build", "test"], ["test", "fix", "b1", "t1"], ["fix", "test", "t2", "b2"], ["test", "review"], ["review", "fix", "b", "r"], ["review", "evaluate", "b", "t"], ["evaluate", "gateB", undefined, "b2"], ["gateB", "ship", "b", "t"],
];

// Agent-call stations ("tests" is the Tester; the floor's "test" box is node --test).
const CALL_STATION: Record<string, string> = { council: "council", discover: "design", plan: "plan", tests: "tests", build: "build", fix: "fix", review: "review", evaluate: "evaluate" };

function nodesFor(run?: FactoryRunView, runs: AgentRunView[] = [], crew: CrewIndex = {}): Node<StationData>[] {
  const working = runs.filter((r) => r.state === "running" && run && r.factoryRun === run.run);
  return STATIONS.map(([id, label, sub, x, y, gate, later]) => {
    const workers = working.filter((r) => CALL_STATION[id] && r.station === CALL_STATION[id]).map((r) => ({ name: crew[r.agent]?.name ?? r.agent, avatar: crew[r.agent]?.avatar ?? "◆", since: r.startedAt }));
    const s = run?.stations[id];
    let badge: string | undefined;
    if (id === "fix" && run?.fixRounds) badge = `${run.fixRounds}/${run.maxFixRounds}`;
    if (id === "test" && run?.tests.length) { const t = run.tests.at(-1)!; badge = `${t.passed}/${t.passed + t.failed}`; }
    if (id === "council" && run?.council.length) { const b = run.council.at(-1)!.brief; badge = `${Object.values(b.votes).filter((v) => v === b.outcome).length}× ${b.outcome}`; }
    if (id === "discover" && run?.discovery.length) { const d = run.discovery.at(-1)!; badge = d.pass ? "passed" : d.settled ? "best kept" : `round ${d.round}`; }
    if (id === "evaluate" && run?.evaluations.length) { const e = run.evaluations.at(-1)!; badge = e.skipped ? "skipped" : e.pass ? "passed" : `${e.requirements.filter((q) => !q.met).length} open`; }
    if (id === "review" && run?.reviews.length) { const r = run.reviews.at(-1)!; badge = r.findings.length ? `${r.findings.length} note${r.findings.length > 1 ? "s" : ""}` : "clean"; }
    return { id, type: "station", position: { x, y }, draggable: false, data: { label, sub, gate, later, state: later ? "idle" : s?.state ?? "idle", badge, note: s?.note, workers } };
  });
}

function edgesFor(run?: FactoryRunView): Edge[] {
  return EDGES.map(([s, t, sh, th]) => {
    const target = run?.stations[t]?.state;
    const later = (s === "council" || t === "council") && run?.stations.council?.state === "skipped";
    return {
      id: `${s}-${t}`, source: s, target: t, sourceHandle: sh, targetHandle: th, type: "smoothstep",
      animated: target === "active", className: `flow-edge${later ? " later" : ""}${run?.stations[s] && target ? " lit" : ""}`,
    };
  });
}

/** The factory floor: the selected run's stations light up as agents work, the fix loop counts rounds, gates wait for a tap. */
const NO_CREW: CrewIndex = {};

export function FactoryFloor({ runs, factoryRuns, selected, onSelect, crew = NO_CREW, mode }: { runs: AgentRunView[]; factoryRuns: FactoryRunView[]; selected?: FactoryRunView; onSelect: (id: number) => void; crew?: CrewIndex; mode?: CrewMode | null }) {
  const run = selected;
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<StationData>>(nodesFor(run, runs, crew));
  const [openErr, setOpenErr] = useState<string | null>(null);
  // Controlled through useNodesState so React Flow keeps the measured node and handle sizes between events.
  useEffect(() => {
    setNodes((ns) => { const next = nodesFor(run, runs, crew); return ns.map((n) => ({ ...n, data: next.find((x) => x.id === n.id)!.data })); });
  }, [run, runs, crew, setNodes]);
  // Refit the floor whenever its pane changes size, so every station stays in view.
  const wrap = useRef<HTMLDivElement>(null);
  const flow = useRef<ReactFlowInstance<Node<StationData>> | null>(null);
  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(() => flow.current?.fitView({ padding: 0.08 }));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);
  const overseerBusy = runs.some((r) => r.state === "running" && !r.factoryRun);
  const left = run ? Math.max(0, run.maxUsd - run.spentUsd) : 0;
  return (
    <section className="pane floor" aria-label="Factory floor">
      <header className="pane-head">
        <span>Factory floor</span>
        {factoryRuns.length > 0 ? (
          <select className="run-pick" value={run?.run ?? ""} onChange={(e) => onSelect(Number(e.target.value))} aria-label="Factory run">
            {[...factoryRuns].reverse().map((r) => <option key={r.run} value={r.run}>#{r.run} {r.plan?.name ?? r.idea.slice(0, 40)} · {r.finished?.outcome ?? (r.resumed ? "resumed" : "running")}</option>)}
          </select>
        ) : <span className="muted">{overseerBusy ? "Assistant working…" : "no runs yet · type an idea to the Assistant and press Build it"}</span>}
      </header>
      {run && (
        <div className="fuel" title={`Run budget: $${run.spentUsd.toFixed(4)} of $${run.maxUsd.toFixed(2)} spent`}>
          <span className="muted">Budget</span>
          <span className="fuel-bar"><span style={{ width: `${Math.max(0, Math.min(100, (left / run.maxUsd) * 100))}%` }} /></span>
          <span className="mono">${run.spentUsd.toFixed(4)} / ${run.maxUsd.toFixed(2)}</span>
          {run.finished && <span className={`outcome ${run.finished.outcome}`}>{run.finished.outcome}</span>}
        </div>
      )}
      {run?.waiting && !run.finished && <GateBar run={run} />}
      {run?.retrying && !run.waiting && !run.finished && <div className="run-result retrying" role="status">↻ Retrying <b>{STATION_LABEL[run.retrying.station] ?? run.retrying.station}</b> (attempt {run.retrying.attempt})…</div>}
      {run?.resumed && !run.finished && <div className="run-result resumed" role="status">↻ Picked up again at <b>{STATION_LABEL[run.resumed.from] ?? run.resumed.from}</b> after the app closed{run.resumed.count > 1 ? ` (${run.resumed.count} times)` : ""}. Finished stations were kept; spend carries over.</div>}
      <div className="flow-wrap" ref={wrap}>
        <ReactFlow onInit={(i) => { flow.current = i; }} nodes={nodes} onNodesChange={onNodesChange} edges={edgesFor(run)} nodeTypes={{ station: Station }} fitView fitViewOptions={{ padding: 0.1 }} proOptions={{ hideAttribution: true }} nodesConnectable={false} panOnDrag zoomOnScroll={false}>
          <Background gap={24} size={1} color="var(--grid)" />
        </ReactFlow>
      </div>
      {run && !run.finished && mode === "practice" && run.stations.plan == null && <div className="run-result note">Practice crew at work: it builds the sample word counter whatever the idea, so you can watch the loop for free.</div>}
      {run?.finished && (
        <div className={`run-result ${run.finished.outcome}`}>
          <span>{run.finished.reason}{run.finished.totalUsd != null && ` · total $${run.finished.totalUsd.toFixed(4)} · ${run.finished.agentCalls ?? 0} agent calls`}</span>
          {run.finished.outcome === "stopped" && run.finished.resumable && <button className="sm" onClick={() => resumeRun(run.run).then(() => setOpenErr(null)).catch((e) => setOpenErr((e as Error).message))}>Resume from where it stopped</button>}
          {run.finished.outcome === "shipped" && run.resumed && <span className="muted">resumed {run.resumed.count}× after the app closed</span>}
          {run.finished.outcome === "shipped" && <button className="ghost sm" onClick={() => setupApi.open("run", run.run).then(() => setOpenErr(null)).catch((e) => setOpenErr((e as Error).message))}>Open folder</button>}
          {openErr && <span className="err">{openErr}</span>}
        </div>
      )}
    </section>
  );
}

const STATION_LABEL = STEP;

function GateBar({ run }: { run: FactoryRunView }) {
  return <GateActions run={run} label={STATION_LABEL} />;
}
