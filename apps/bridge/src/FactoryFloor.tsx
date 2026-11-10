import { useEffect, useRef, useState } from "react";
import { ReactFlow, Background, useNodesState, type ReactFlowInstance, type Edge, type Node, Handle, Position, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { decideGate, type AgentRunView, type FactoryRunView, type StationState } from "./api";

type StationData = { label: string; sub: string; gate?: boolean; later?: boolean; state: StationState; badge?: string; note?: string };

function Station({ data }: NodeProps<Node<StationData>>) {
  return (
    <div className={`station s-${data.state}${data.gate ? " gate" : ""}${data.later ? " later" : ""}`} title={data.note}>
      <Handle type="target" position={Position.Left} />
      <div className="st-name">{data.label}{data.badge && <span className="st-badge mono">{data.badge}</span>}</div>
      <div className="st-sub">{data.sub}</div>
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
  ["intake", "One-line idea", "saved as a Signal", X[0], 0],
  ["council", "Council", "3 seats · big ideas", X[1], -95],
  ["plan", "Spec and plan", "Planner", X[1], 0],
  ["gateA", "You approve plan", "one tap", X[2], 0, true],
  ["tests", "Acceptance tests", "Tester, then locked", X[0], 130],
  ["build", "Build", "Builder", X[1], 130],
  ["test", "Test", "node --test", X[2], 130],
  ["review", "Review", "Reviewer vs spec", X[3], 130],
  ["gateB", "You accept build", "one tap", X[4], 130, true],
  ["fix", "Fix", "Fixer loop", X[2], 260],
  ["ship", "Ship to disk", "git repo, tagged", X[4], 260],
];
const EDGES: [string, string, string?, string?][] = [
  ["intake", "plan"], ["intake", "council", "tb"], ["council", "plan", undefined, "t"], ["plan", "gateA"], ["gateA", "tests", "b", "t"], ["tests", "build"],
  ["build", "test"], ["test", "fix", "b1", "t1"], ["fix", "test", "t2", "b2"], ["test", "review"], ["review", "fix", "b", "r"], ["review", "gateB"], ["gateB", "ship", "b", "t"],
];

function nodesFor(run?: FactoryRunView): Node<StationData>[] {
  return STATIONS.map(([id, label, sub, x, y, gate, later]) => {
    const s = run?.stations[id];
    let badge: string | undefined;
    if (id === "fix" && run?.fixRounds) badge = `${run.fixRounds}/${run.maxFixRounds}`;
    if (id === "test" && run?.tests.length) { const t = run.tests.at(-1)!; badge = `${t.passed}/${t.passed + t.failed}`; }
    if (id === "council" && run?.council.length) { const b = run.council.at(-1)!.brief; badge = `${Object.values(b.votes).filter((v) => v === b.outcome).length}× ${b.outcome}`; }
    if (id === "review" && run?.reviews.length) { const r = run.reviews.at(-1)!; badge = r.findings.length ? `${r.findings.length} note${r.findings.length > 1 ? "s" : ""}` : "clean"; }
    return { id, type: "station", position: { x, y }, draggable: false, data: { label, sub, gate, later, state: later ? "idle" : s?.state ?? "idle", badge, note: s?.note } };
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
export function FactoryFloor({ runs, factoryRuns, selected, onSelect }: { runs: AgentRunView[]; factoryRuns: FactoryRunView[]; selected?: FactoryRunView; onSelect: (id: number) => void }) {
  const run = selected;
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<StationData>>(nodesFor(run));
  // Controlled through useNodesState so React Flow keeps the measured node and handle sizes between events.
  useEffect(() => {
    setNodes((ns) => { const next = nodesFor(run); return ns.map((n) => ({ ...n, data: next.find((x) => x.id === n.id)!.data })); });
  }, [run, setNodes]);
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
            {[...factoryRuns].reverse().map((r) => <option key={r.run} value={r.run}>#{r.run} {r.plan?.name ?? r.idea.slice(0, 40)} · {r.finished?.outcome ?? "running"}</option>)}
          </select>
        ) : <span className="muted">{overseerBusy ? "Overseer working…" : "no runs yet · type an idea and press Build it"}</span>}
      </header>
      {run && (
        <div className="fuel" title={`Run budget: $${run.spentUsd.toFixed(4)} of $${run.maxUsd.toFixed(2)} spent`}>
          <span className="mono muted">fuel</span>
          <span className="fuel-bar"><span style={{ width: `${Math.max(0, Math.min(100, (left / run.maxUsd) * 100))}%` }} /></span>
          <span className="mono">${run.spentUsd.toFixed(4)} / ${run.maxUsd.toFixed(2)}</span>
          {run.finished && <span className={`outcome ${run.finished.outcome}`}>{run.finished.outcome}</span>}
        </div>
      )}
      {run?.waiting && <GateBar run={run} />}
      <div className="flow-wrap" ref={wrap}>
        <ReactFlow onInit={(i) => { flow.current = i; }} nodes={nodes} onNodesChange={onNodesChange} edges={edgesFor(run)} nodeTypes={{ station: Station }} fitView fitViewOptions={{ padding: 0.1 }} proOptions={{ hideAttribution: true }} nodesConnectable={false} panOnDrag zoomOnScroll={false}>
          <Background gap={24} size={1} color="var(--grid)" />
        </ReactFlow>
      </div>
      {run?.finished && <div className={`run-result ${run.finished.outcome}`}>{run.finished.reason}{run.finished.totalUsd != null && ` · total $${run.finished.totalUsd.toFixed(4)} · ${run.finished.agentCalls ?? 0} agent calls`}</div>}
    </section>
  );
}

function GateBar({ run }: { run: FactoryRunView }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const w = run.waiting!;
  async function go(approve: boolean) {
    setBusy(true); setErr(null);
    try { await decideGate(run.run, w.gate, approve, note.trim() || undefined); setNote(""); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className={`gatebar ${w.gate}`} role="group" aria-label="Approval needed">
      <span className="gate-q">{w.question}</span>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={w.gate === "escalation" ? "optional hint for the Fixer" : "optional: what to change (rejecting with a note sends it back)"} />
      <button disabled={busy} onClick={() => go(true)}>{w.gate === "escalation" ? "Retry" : "Approve"}</button>
      <button className="ghost" disabled={busy} onClick={() => go(false)}>{note.trim() && w.gate !== "escalation" ? "Send back" : "Stop"}</button>
      {err && <span className="err">{err}</span>}
    </div>
  );
}
