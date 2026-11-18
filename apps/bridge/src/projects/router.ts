import { useEffect, useState } from "react";

/**
 * Where the Bridge is, kept in the address hash so a reload (or the back button) stays put.
 *   #/                     home: the board of every ticket across projects (Needs you first) and the live flow
 *   #/projects             projects
 *   #/p/12                 project 12, its first panel
 *   #/p/12/runs/57         project 12, Runs panel, run 57
 *   #/features[/7]         features added from finished projects (feature 7)
 *   #/plugins[/id[/panel]] plugins (one plugin, one of its pages)
 *   #/a/id[/panel]         an add-on's own page from the main menu (its "nav" panel), the whole window
 *   #/brain                the Brain: the principles every loop follows
 *   #/map[/id]             the Feature map: every feature's record, wiring and proof of life (one feature)
 *   #/runners              build runners: GitHub's checks and builds, run on this PC
 *   #/bases                the factories this app hosts (open, create, rename, archive)
 *   #/factory[/view]       the whole factory (floor, bay, order, tickets, improve, cycles, flows, data), as before projects
 *   #/bridge[/mode]        the Factory Bridge dashboard (loom, score, quarter)
 *   #/needs                everything waiting on you (the new shell's first item)
 *   #/_kit                 the shared component kit (not linked; the UI tour shoots it)
 * The old #order, #bay and #data still open the factory views.
 */
export type FactoryView = "factory" | "order" | "bay" | "data" | "tickets" | "improve" | "cycles" | "flows";
export type BridgeMode = "loom" | "score" | "quarter";
const MODES: BridgeMode[] = ["loom", "score", "quarter"];
export type Route =
  | { page: "home" }
  | { page: "projects" }
  | { page: "project"; id: number; panel?: string; run?: number }
  | { page: "factory"; view: FactoryView }
  | { page: "features"; id?: number }
  | { page: "plugins"; id?: string; panel?: string }
  | { page: "addon"; id: string; panel?: string }
  | { page: "brain" }
  | { page: "map"; id?: string }
  | { page: "bases" }
  | { page: "runners" }
  | { page: "kit" }
  | { page: "needs" }
  | { page: "bridge"; mode: BridgeMode };

const VIEWS: FactoryView[] = ["factory", "order", "bay", "data", "tickets", "improve", "cycles", "flows"];

export function parse(hash: string): Route {
  const h = hash.replace(/^#/, "");
  if (VIEWS.includes(h as FactoryView) && h !== "factory") return { page: "factory", view: h as FactoryView };
  const parts = h.split("/").filter(Boolean);
  if (parts[0] === "p" && /^\d+$/.test(parts[1] ?? "")) {
    return { page: "project", id: Number(parts[1]), panel: parts[2] || undefined, run: /^\d+$/.test(parts[3] ?? "") ? Number(parts[3]) : undefined };
  }
  if (parts[0] === "features") return { page: "features", id: /^\d+$/.test(parts[1] ?? "") ? Number(parts[1]) : undefined };
  if (parts[0] === "a" && parts[1]) return { page: "addon", id: parts[1], panel: parts[2] || undefined };
  if (parts[0] === "plugins") return { page: "plugins", id: parts[1] || undefined, panel: parts[2] || undefined };
  if (parts[0] === "brain") return { page: "brain" };
  if (parts[0] === "map") return { page: "map", id: parts[1] ? decodeURIComponent(parts[1]) : undefined };
  if (parts[0] === "bases") return { page: "bases" };
  if (parts[0] === "projects") return { page: "projects" };
  if (parts[0] === "runners") return { page: "runners" };
  if (parts[0] === "_kit") return { page: "kit" };
  if (parts[0] === "needs") return { page: "needs" };
  if (parts[0] === "bridge") return { page: "bridge", mode: MODES.includes(parts[1] as BridgeMode) ? (parts[1] as BridgeMode) : "loom" };
  if (parts[0] === "factory") return { page: "factory", view: VIEWS.includes(parts[1] as FactoryView) ? (parts[1] as FactoryView) : "factory" };
  return { page: "home" };
}

export function href(r: Route): string {
  if (r.page === "project") return `#/p/${r.id}${r.panel ? `/${r.panel}${r.run ? `/${r.run}` : ""}` : ""}`;
  if (r.page === "features") return r.id ? `#/features/${r.id}` : "#/features";
  if (r.page === "addon") return `#/a/${r.id}${r.panel ? `/${r.panel}` : ""}`;
  if (r.page === "plugins") return `#/plugins${r.id ? `/${r.id}${r.panel ? `/${r.panel}` : ""}` : ""}`;
  if (r.page === "brain") return "#/brain";
  if (r.page === "map") return r.id ? `#/map/${encodeURIComponent(r.id)}` : "#/map";
  if (r.page === "bases") return "#/bases";
  if (r.page === "projects") return "#/projects";
  if (r.page === "runners") return "#/runners";
  if (r.page === "kit") return "#/_kit";
  if (r.page === "needs") return "#/needs";
  if (r.page === "bridge") return r.mode === "loom" ? "#/bridge" : `#/bridge/${r.mode}`;
  if (r.page === "factory") return r.view === "factory" ? "#/factory" : `#/factory/${r.view}`;
  return "#/";
}

export function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parse(location.hash));
  useEffect(() => {
    const on = () => setRoute(parse(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = (r: Route) => {
    const h = href(r);
    if (location.hash !== h) location.hash = h;
    else setRoute(r);
  };
  return [route, go];
}
