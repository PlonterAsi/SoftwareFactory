import { useMemo } from "react";
import { orderFor, useProject, type BayState, type OrderState, type useFactory } from "../api";
import { panelsFor, sectionsFor, type PanelContext } from "./panels";
import { shortName } from "./shortName";
import { href, type Route } from "./router";
import { ago } from "./builtin";

/**
 * One project's workspace: a row of tabs under the header (every registered panel that
 * applies to this project; the improve and know ones under More) and the chosen panel
 * below it at the full width of the page.
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
    showRun: (r) => go({ page: "project", id, panel: "overview", run: r }),
    pickedRun: run ?? null,
  };
  const r = detail.rollup;
  // The tabs people use while building sit in a row; the rest (improve, know, add-ons) under More.
  const sections = sectionsFor(detail);
  const main = panels.filter((p) => ["brief", "build", "ship"].includes(p.section ?? "know"));
  const more = panels.filter((p) => !main.includes(p));
  const tab = (p: (typeof panels)[number]) => {
    const badge = p.badge?.(ctx) ?? null;
    const alert = p.alert?.(ctx) ?? false;
    return (
      <a key={p.id} href={href({ page: "project", id, panel: p.id })} aria-current={p.id === current.id ? "page" : undefined}
        className={(p.id === current.id ? "ws-tab on" : "ws-tab") + (alert ? " alert" : "")}>
        {p.title}{badge != null && <span className="ws-badge">{badge}</span>}{alert && <i className="ws-alert" aria-label="needs you" />}
      </a>
    );
  };
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
      <nav className="ws-tabs" aria-label="Project tabs">
        {main.map(tab)}
        {more.length > 0 && (
          <details className={`ws-more${more.some((p) => p.id === current.id) ? " on" : ""}`} key={current.id}>
            <summary>{more.find((p) => p.id === current.id)?.title ?? "More"}</summary>
            <div className="ws-more-menu">
              {sections.filter((s) => s.panels.some((p) => more.includes(p))).map((s) => (
                <div key={s.id} role="group" aria-label={s.title}>
                  <div className="ws-more-sec">{s.title}</div>
                  {s.panels.filter((p) => more.includes(p)).map(tab)}
                </div>
              ))}
            </div>
          </details>
        )}
      </nav>
      <div className={`ws-panel panel-${current.id}`} key={current.id}>{current.render(ctx)}</div>
    </section>
  );
}
