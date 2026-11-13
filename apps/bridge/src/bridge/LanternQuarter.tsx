import { useEffect, useState } from "react";
import type { AgentRunView, AgentStats, AgentView, FactoryRunView, ProjectSummary, SfEvent } from "../api";
import { href } from "../projects/router";
import { shortName } from "../projects/shortName";
import { ticketsApi, type TicketView } from "../Tickets";
import { LOOM_STATIONS, currentStation } from "./SignalLoom";

/**
 * Lantern Quarter: every project is a district seen from above at night. Its street has a lot per
 * station, lit while a build works there; small houses are its open tickets (taller = sooner, red
 * roof = bug); the porch light turns amber when the project waits for you. Agents rise along the
 * bottom as moons, filled by their share of the spend, with a violet rim while they work.
 */
const SOON: Record<string, number> = { now: 22, this_week: 17, next: 13 };

function useOpenTickets(events: SfEvent[]) {
  const [list, setList] = useState<TicketView[]>([]);
  const at = events.filter((e) => e.type.startsWith("ticket.")).at(-1)?.id ?? 0;
  useEffect(() => {
    let stop = false;
    const t = setTimeout(() => ticketsApi.list({ view: "open" }).then((r) => { if (!stop) setList(r.tickets); }).catch(() => {}), 250);
    return () => { stop = true; clearTimeout(t); };
  }, [at]);
  return list;
}

export function LanternQuarter({ projects, factoryRuns, runs, agents, stats, projectOfRun, events }: {
  projects: ProjectSummary[] | null; factoryRuns: FactoryRunView[]; runs: AgentRunView[]; agents: AgentView[];
  stats: Record<string, AgentStats>; projectOfRun: Record<number, number>; events: SfEvent[];
}) {
  const tickets = useOpenTickets(events);
  const list = (projects ?? []).filter((p) => p.status !== "archived")
    .sort((a, b) => b.rollup.lastActive.localeCompare(a.rollup.lastActive));
  const runsOf = (pid: number) => factoryRuns.filter((r) => projectOfRun[r.run] === pid).sort((a, b) => b.run - a.run);
  const working = (run: number) => runs.filter((a) => a.state === "running" && a.factoryRun === run);
  const glyph = (id: string) => agents.find((a) => a.def.id === id)?.def.avatar ?? "◆";
  const maxSpend = Math.max(0.0001, ...agents.map((a) => stats[a.def.id]?.costUsd ?? 0));

  return (
    <div className="lq">
      {list.length === 0 && <p className="muted">No projects yet. Type an idea in the Helm (Ctrl K) to start one.</p>}
      <div className="lq-districts">
        {list.map((p) => {
          const rs = runsOf(p.id), live = rs.find((r) => !r.finished), latest = live ?? rs[0];
          const wait = rs.some((r) => r.waiting && !r.finished);
          const at = latest ? currentStation(latest) : null, atIdx = at ? LOOM_STATIONS.findIndex(([id]) => id === at) : -1;
          const ts = tickets.filter((t) => t.project === p.id && t.level !== "subtask").slice(0, 14);
          const ag = live ? working(live.run) : [];
          return (
            <a key={p.id} className={`lq-d${wait ? " wait" : live ? " live" : ""}`} href={href({ page: "project", id: p.id, ...(wait || live ? { panel: "overview", run: (live ?? latest)!.run } : {}) })} title={p.name}>
              <h4><i className={`lq-porch${wait ? " ask" : live ? " on" : ""}`} aria-hidden /><span>{shortName(p.name, 34)}</span></h4>
              <div className="lq-street" aria-label={latest ? `Latest build at ${at}` : "No builds yet"}>
                {LOOM_STATIONS.map(([id, label], i) => {
                  const s = latest?.stations[id]?.state;
                  const c = !latest ? "" : wait && i === atIdx ? "ask" : s === "active" ? (latest.finished ? (latest.finished.outcome === "failed" ? "bad" : "stop") : "on") : s === "fail" ? "bad" : s === "pass" || (latest.finished?.outcome === "shipped" && s !== "skipped" && s !== "idle" && s != null) || (i < atIdx && s !== "skipped" && id !== "fix" && id !== "council") ? "done" : "";
                  return <i key={id} className={`lq-lot ${c}${id.startsWith("gate") ? " gate" : ""}`} title={label} />;
                })}
              </div>
              <div className="lq-houses" aria-label={`${ts.length} open tickets`}>
                {ts.length ? ts.map((t) => <i key={t.id} className={`lq-house${t.kind === "bug" ? " bug" : ""}`} style={{ height: SOON[t.priority ?? ""] ?? 10 }} title={`${t.key} ${t.title}`} />)
                  : <span className="muted">no open tickets</span>}
              </div>
              <div className="lq-sub">
                <span className="mono">{p.rollup.runs} build{p.rollup.runs === 1 ? "" : "s"}</span>
                <span className="mono">${p.rollup.spendUsd.toFixed(2)}</span>
                {ag.length > 0 && <span className="loom-glyphs">{ag.map((a) => glyph(a.agent)).join(" ")}</span>}
                {wait && <span className="lq-ask">needs your OK</span>}
              </div>
            </a>
          );
        })}
      </div>
      <h3 className="lq-h">Agents</h3>
      <div className="lq-moons">
        {agents.filter((a) => !a.retired).map((a) => {
          const st = stats[a.def.id], spent = st?.costUsd ?? 0, f = Math.sqrt(spent / maxSpend);
          const busy = runs.some((r) => r.state === "running" && r.agent === a.def.id), R = 13;
          return (
            <a key={a.def.id} className={`lq-moon${busy ? " busy" : ""}`} href={href({ page: "factory", view: "bay" })} title={`${a.def.name}: $${spent.toFixed(3)} over ${st?.calls ?? 0} calls · ${a.def.model}`}>
              <svg width={28} height={28} viewBox="-1 -1 28 28" aria-hidden>
                <defs><clipPath id={`lqm-${a.def.id}`}><circle cx={R} cy={R} r={R} /></clipPath></defs>
                <circle cx={R} cy={R} r={R} fill="var(--panel-2)" stroke={busy ? "var(--agent)" : "var(--line-2)"} strokeWidth={busy ? 2 : 1} />
                <rect clipPath={`url(#lqm-${a.def.id})`} x={R * 2 * (1 - f)} y={0} width={R * 2} height={R * 2} fill="var(--agent)" opacity={0.55} />
              </svg>
              <span>{a.def.name}</span>
            </a>
          );
        })}
      </div>
      <div className="lq-legend"><span><i style={{ background: "var(--accent)" }} />working now</span><span><i style={{ background: "rgba(143,212,122,.5)" }} />station done</span><span><i style={{ background: "var(--gate)" }} />waiting for your OK</span><span><i style={{ background: "var(--muted)" }} />stopped there</span><span><i style={{ background: "var(--bad)" }} />failed or bug ticket</span><span><i style={{ background: "var(--agent)" }} />agent spend</span></div>
    </div>
  );
}
