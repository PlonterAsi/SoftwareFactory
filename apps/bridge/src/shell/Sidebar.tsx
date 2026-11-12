import type { ReactNode } from "react";
import type { FactoryRunView, ProjectSummary } from "../api";
import { href, type Route } from "../projects/router";
import { StatusGlyph } from "../ui";
import { projectStatus } from "../projects/Home";
import { shortName } from "../projects/shortName";

/**
 * The left rail of the Foundry Glass shell: where you are, what needs you, and the projects you
 * were last in. Amber appears here only when something waits for you.
 */
export function Sidebar({ route, needs, projects, factoryRuns, crewBusy, base, conflicts = 0, proposals = 0, tickets = 0, children }: {
  route: Route; needs: number; projects: ProjectSummary[] | null; factoryRuns: FactoryRunView[]; crewBusy: boolean; base?: string;
  conflicts?: number; proposals?: number; tickets?: number; children?: ReactNode;
}) {
  const at = (r: Route["page"], view?: string) => route.page === r && (view == null || (route.page === "factory" && route.view === view));
  const recent = (projects ?? []).filter((p) => p.status !== "archived")
    .sort((a, b) => b.rollup.lastActive.localeCompare(a.rollup.lastActive)).slice(0, 6);
  return (
    <nav className="sb" aria-label="Main">
      <a className="sb-brand" href={href({ page: "home" })}><span className="logo" aria-hidden>◈</span>SoftwareFactory</a>
      <div className="sb-group">
        <Item to={{ page: "needs" }} on={at("needs")} icon={<StatusGlyph status={needs ? "needs" : "idle"} label="" />} badge={needs || undefined} alert={needs > 0}>Needs you</Item>
        <Item to={{ page: "home" }} on={at("home")} icon={<Ico d="M3 4h10v8H3zM3 7h10" />}>Projects</Item>
      </div>
      {recent.length > 0 && (
        <div className="sb-group">
          <div className="sb-label">Recent projects</div>
          {recent.map((p) => {
            const on = route.page === "project" && route.id === p.id;
            return (
              <a key={p.id} className={`sb-item sb-project${on ? " on" : ""}`} href={href({ page: "project", id: p.id })} aria-current={on ? "page" : undefined} title={p.name}>
                <StatusGlyph status={projectStatus(p)} size={12} label="" />
                <span className="sb-text">{shortName(p.name, 26)}</span>
              </a>
            );
          })}
        </div>
      )}
      <div className="sb-group">
        <div className="sb-label">Factory</div>
        <Item to={{ page: "bridge", mode: "loom" }} on={at("bridge")} icon={<Ico d="M2 5h12M2 11h12M4.5 3v4M8 9v4M11.5 3v4" />}>Factory Bridge</Item>
        <Item to={{ page: "factory", view: "bay" }} on={at("factory", "bay")} icon={<StatusGlyph status={crewBusy ? "working" : "agent"} label="" />}>Agents</Item>
        <Item to={{ page: "factory", view: "tickets" }} on={at("factory", "tickets")} icon={<Ico d="M3 4.5h10v2.2a1.3 1.3 0 0 0 0 2.6v2.2H3V9.3a1.3 1.3 0 0 0 0-2.6zM9.5 4.5v7" />} badge={tickets || undefined}>Tickets</Item>
        {base && <Item to={{ page: "bases" }} on={at("bases")} icon={<Ico d="M2 13h12M3 13V6l5-3 5 3v7M6.5 13V9.5h3V13" />}>Base: {base}</Item>}
        <Item to={{ page: "factory", view: "factory" }} on={at("factory", "factory")} icon={<Ico d="M2 13V7l4 2V7l4 2V3h4v10z" />}>All builds</Item>
        <Item to={{ page: "factory", view: "order" }} on={at("factory", "order")} icon={<Ico d="M8 2.5 13.5 8 8 13.5 2.5 8zM8 5.5v5M5.5 8h5" />} badge={conflicts || undefined} alert={conflicts > 0}>Rules and ideas</Item>
        <Item to={{ page: "factory", view: "improve" }} on={at("factory", "improve")} icon={<Ico d="M8 13V3M4 7l4-4 4 4" />} badge={proposals || undefined}>Improve</Item>
        <Item to={{ page: "factory", view: "data" }} on={at("factory", "data")} icon={<Ico d="M3 4c0-1 2.2-1.5 5-1.5s5 .5 5 1.5v8c0 1-2.2 1.5-5 1.5S3 13 3 12zM3 4c0 1 2.2 1.5 5 1.5S13 5 13 4M3 8c0 1 2.2 1.5 5 1.5S13 9 13 8" />}>Data vault</Item>
      </div>
      <div className="sb-group">
        <div className="sb-label">Library</div>
        <Item to={{ page: "features" }} on={at("features")} icon={<Ico d="M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z" />}>Finished apps</Item>
        <Item to={{ page: "plugins" }} on={at("plugins")} icon={<Ico d="M6 2v3M10 2v3M4 5h8v4a4 4 0 0 1-8 0zM8 13v1.5" />}>Add-ons</Item>
        <Item to={{ page: "brain" }} on={at("brain")} icon={<Ico d="M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 5v3l2 1.5" />}>Brain</Item>
      </div>
      <div className="sb-foot">{children}</div>
    </nav>
  );
}

function Item({ to, on, icon, badge, alert, children }: { to: Route; on: boolean; icon: ReactNode; badge?: number; alert?: boolean; children: ReactNode }) {
  return (
    <a className={`sb-item${on ? " on" : ""}${alert ? " alert" : ""}`} href={href(to)} aria-current={on ? "page" : undefined}>
      <span className="sb-icon">{icon}</span><span className="sb-text">{children}</span>
      {badge != null && <span className="sb-badge">{badge}</span>}
    </a>
  );
}

function Ico({ d }: { d: string }) {
  return <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden className="sb-ico"><path d={d} /></svg>;
}
