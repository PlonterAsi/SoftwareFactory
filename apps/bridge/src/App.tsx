import { useFactory } from "./api";
import { StarMap } from "./StarMap";
import { FactoryFloor } from "./FactoryFloor";
import { Timeline } from "./Timeline";
import { Overseer } from "./Overseer";

export function App() {
  const f = useFactory();
  return (
    <div className="bridge">
      <header className="topbar">
        <div className="brand"><span className="logo" aria-hidden>◈</span> SOFTWAREFACTORY <span className="muted">/ Bridge</span></div>
        <div className="stats mono">
          <span className={f.online ? "dot on" : "dot"} /> core {f.online ? "online" : "offline"}
          <span className="sep">·</span> runtime {f.runtime}
          <span className="sep">·</span> {f.signals.length} signals
          <span className="sep">·</span> {f.runs.length} agent calls
          <span className="sep">·</span> spend ${f.totalUsd.toFixed(4)}
        </div>
      </header>
      <main className="grid">
        <StarMap signals={f.signals} />
        <div className="center">
          <FactoryFloor runs={f.runs} />
          <Timeline runs={f.runs} totalUsd={f.totalUsd} />
        </div>
        <Overseer signals={f.signals} runs={f.runs} />
      </main>
    </div>
  );
}
