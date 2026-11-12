import { useMemo } from "react";
import { orderFor, useProject, type BayState, type OrderState, type useFactory } from "../api";
import { panelsFor, sectionsFor, type PanelContext } from "./panels";
import { shortName } from "./shortName";
import { href, type Route } from "./router";
import { ago } from "./builtin";

/**
 * One project's workspace: a rail of panels on the left (every registered panel
 * that applies to this project) and the chosen panel beside it.
 */
export function Workspace({ id, panel, run, factory, order, bay, go }: {
  id: number; panel?: string; run?: number;
  factory: ReturnType<typeof useFactory>;
  order: OrderState & { arrivals: Record<number, number> };
  bay: BayState;
  go: (r: Route) => void;
}) {
  const { detail, err } = useProject(id, factory.events, factory.online);
  const scoped = useMemo(() => (detail ? orderFor(order, detail.nodeIds) : null), [order, detail]);
  if (!detail || !scoped) {
    return (
      <section className="pane workspace loading" aria-busy={!err}>
        <p className={err ? "error pad" : "empty"}>{err ? `${err}.` : "Opening the project…"}</p>
        {err && <a className="pad" href={href({ page: "home" })}>Back to projects</a>}
      </section>
    );
  }
  const panels = panelsFor(detail);
  const current = panels.find((p) => p.id === panel) ?? panels[0];
  const ctx: PanelContext = {
    project: detail, events: factory.events, factory, order: scoped, bay,
    go: (p) => go({ page: "project", id, panel: p }),
    showRun: (r) => go({ page: "project", id, panel: "runs", run: r }),
    pickedRun: run ?? null,
  };
  const r = detail.rollup;
  const short = shortName(detail.name);
  return (
    <section className={`pane workspace status-${detail.status}`} aria-label={`Project ${detail.name}`}>
      <header className="ws-head">
        <a className="ws-back" href={href({ page: "home" })} aria-label="All projects">Projects</a>
        <span className="ws-slash" aria-hidden>/</span>
        <h1 className="ws-name" title={detail.name}>{short}</h1>
        <span className="ws-tag">{detail.kind}</span>
        <span className={`ws-tag status ${detail.status}`}>{detail.status}</span>
        {short !== detail.name && <span className="ws-full muted">{detail.name}</span>}
        <span className="ws-meta muted">{r.running ? `${r.running} run${r.running > 1 ? "s" : ""} live · ` : ""}active {ago(r.lastActive)}</span>
      </header>
      <div className="ws-body">
        <nav className="ws-rail" aria-label="Project panels">
          {sectionsFor(detail).map((sec) => (
            <div key={sec.id} className={`rail-sec sec-${sec.id}`} role="group" aria-label={sec.title}>
              <div className="rail-sec-title">{sec.title}</div>
              {sec.panels.map((p) => {
                const badge = p.badge?.(ctx) ?? null;
                const alert = p.alert?.(ctx) ?? false;
                return (
                  <a key={p.id} href={href({ page: "project", id, panel: p.id })} aria-current={p.id === current.id ? "page" : undefined}
                    className={(p.id === current.id ? "rail-item on" : "rail-item") + (alert ? " alert" : "")}>
                    <span>{p.title}</span>{badge != null && <span className="rail-badge">{badge}</span>}
                  </a>
                );
              })}
            </div>
          ))}
        </nav>
        <div className={`ws-panel panel-${current.id}`} key={current.id}>{current.render(ctx)}</div>
      </div>
    </section>
  );
}
