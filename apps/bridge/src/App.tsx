import { useEffect, useRef, useState } from "react";
import { useFactory, useOrder } from "./api";
import { RunDeck } from "./RunDeck";
import { StarMap } from "./StarMap";
import { FactoryFloor } from "./FactoryFloor";
import { Timeline } from "./Timeline";
import { Overseer } from "./Overseer";
import { OrderDeck } from "./OrderDeck";
import { DataDeck, useStore } from "./DataDeck";

export function App() {
  const f = useFactory();
  const order = useOrder(f.events);
  const [picked, setPicked] = useState<number | null>(null);
  const [node, setNode] = useState<number | null>(null);
  const [view, setView] = useState<"factory" | "order" | "data">(() => (location.hash === "#order" ? "order" : location.hash === "#data" ? "data" : "factory"));
  const store = useStore(f.events, view === "data");
  // Follow the newest run unless one was picked.
  const selected = f.factoryRuns.find((r) => r.run === picked) ?? f.factoryRuns.at(-1);
  const open = order.conflicts.filter((c) => c.status === "open").length;
  // A new conflict card pulls the Order deck forward once; it never blocks anything.
  const seenOpen = useRef(0);
  useEffect(() => { if (open > seenOpen.current) setView("order"); seenOpen.current = open; }, [open]);
  const pickNode = (id: number | null) => { setNode(id); if (id != null) setView("order"); };
  return (
    <div className="bridge">
      <header className="topbar">
        <div className="brand"><span className="logo" aria-hidden>◈</span> SOFTWAREFACTORY <span className="muted">/ Bridge</span></div>
        <div className="stats mono">
          <span className={f.online ? "dot on" : "dot"} /> core {f.online ? "online" : "offline"}
          <span className="sep">·</span> runtime {f.runtime}
          <span className="sep">·</span> {f.signals.length} signals
          <span className="sep">·</span> {order.nodes.filter((n) => n.mergedInto == null).length} bodies
          {open > 0 && <><span className="sep">·</span><span className="alert-text">{open} conflict{open > 1 ? "s" : ""}</span></>}
          <span className="sep">·</span> {f.factoryRuns.length} factory runs
          <span className="sep">·</span> {f.runs.length} agent calls
          <span className="sep">·</span> spend ${f.totalUsd.toFixed(4)}
        </div>
      </header>
      <main className="grid">
        <StarMap signals={f.signals} order={order} selected={node} onSelect={pickNode} />
        <div className={`center view-${view}`}>
          <nav className="viewbar" role="tablist" aria-label="Center view">
            <button role="tab" aria-selected={view === "factory"} className={view === "factory" ? "tab on" : "tab"} onClick={() => setView("factory")}>Factory floor</button>
            <button role="tab" aria-selected={view === "order"} className={(view === "order" ? "tab on" : "tab") + (open ? " alert" : "")} onClick={() => setView("order")}>Order deck{open ? ` · ${open}` : ""}</button>
            <button role="tab" aria-selected={view === "data"} className={view === "data" ? "tab on" : "tab"} onClick={() => setView("data")}>Data vault</button>
          </nav>
          {view === "factory" ? <>
            <FactoryFloor runs={f.runs} factoryRuns={f.factoryRuns} selected={selected} onSelect={setPicked} />
            <RunDeck run={selected} />
          </> : view === "order" ? <OrderDeck order={order} selected={node} onSelect={pickNode} /> : <DataDeck store={store} />}
          <Timeline runs={f.runs} totalUsd={f.totalUsd} />
        </div>
        <Overseer signals={f.signals} runs={f.runs} factoryRuns={f.factoryRuns} briefings={order.briefings} ingests={order.ingests} onRunStarted={setPicked} />
      </main>
    </div>
  );
}
