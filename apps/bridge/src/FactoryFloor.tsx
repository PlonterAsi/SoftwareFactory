import { useEffect } from "react";
import { ReactFlow, Background, useNodesState, type Edge, type Node, Handle, Position, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { AgentRunView } from "./api";

type StationData = { label: string; sub: string; gate?: boolean; active?: boolean; live?: boolean };

function Station({ data }: NodeProps<Node<StationData>>) {
  return (
    <div className={`station${data.gate ? " gate" : ""}${data.active ? " active" : ""}${data.live ? " live" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <div className="st-name">{data.label}</div>
      <div className="st-sub">{data.sub}</div>
      <Handle type="source" position={Position.Right} />
      <Handle id="b" type="source" position={Position.Bottom} />
      <Handle id="t" type="target" position={Position.Top} />
    </div>
  );
}

const X = [0, 190, 380, 570];
const stations: [string, string, string, number, number, boolean?][] = [
  ["intake", "One-line idea", "Archivist files it", X[0], 0],
  ["council", "Council", "3 agents argue it out", X[1], 0],
  ["plan", "Spec and plan", "spec + task graph", X[2], 0],
  ["gateA", "You approve plan", "one tap", X[3], 0, true],
  ["build", "Build", "Builder, own worktree", X[0], 130],
  ["test", "Test", "Tester runs suite", X[1], 130],
  ["review", "Review", "Reviewer checks spec", X[2], 130],
  ["gateB", "You accept build", "one tap", X[3], 130, true],
  ["fix", "Fix", "Fixer, max 5 rounds", X[1], 250],
  ["ship", "Ship to disk", "retro tunes agents", X[3], 250],
];
const edges: Edge[] = [
  ["intake", "council"], ["council", "plan"], ["plan", "gateA"], ["gateA", "build", "b", "t"],
  ["build", "test"], ["test", "review"], ["review", "gateB"], ["test", "fix", "b", "t"], ["review", "fix", "b"], ["gateB", "ship", "b", "t"],
].map(([s, t, sh, th]) => ({ id: `${s}-${t}`, source: s!, target: t!, sourceHandle: sh, targetHandle: th, type: "smoothstep", className: "flow-edge" }));

const initialNodes: Node<StationData>[] = stations.map(([id, label, sub, x, y, gate]) => ({
  id, type: "station", position: { x, y }, draggable: false,
  data: { label, sub, gate, live: id === "intake", active: false },
}));

/** The factory floor. In milestone 1 only the Overseer runs, shown lighting up the intake station. */
export function FactoryFloor({ runs }: { runs: AgentRunView[] }) {
  const running = runs.some((r) => r.state === "running");
  // Controlled through useNodesState so React Flow keeps the measured node and handle sizes between events.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<StationData>>(initialNodes);
  useEffect(() => {
    setNodes((ns) => ns.map((n) => (n.id === "intake" ? { ...n, data: { ...n.data, active: running } } : n)));
  }, [running, setNodes]);
  return (
    <section className="pane floor" aria-label="Factory floor">
      <header className="pane-head"><span>Factory floor</span><span className="muted">{running ? "Overseer working…" : "idle"} · stations go live in milestone 2</span></header>
      <div className="flow-wrap">
        <ReactFlow nodes={nodes} onNodesChange={onNodesChange} edges={edges} nodeTypes={{ station: Station }} fitView fitViewOptions={{ padding: 0.12 }} proOptions={{ hideAttribution: true }} nodesConnectable={false} panOnDrag zoomOnScroll={false}>
          <Background gap={24} size={1} color="var(--grid)" />
        </ReactFlow>
      </div>
    </section>
  );
}
