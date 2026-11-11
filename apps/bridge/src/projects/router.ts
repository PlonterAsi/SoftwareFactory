import { useEffect, useState } from "react";

/**
 * Where the Bridge is, kept in the address hash so a reload (or the back button) stays put.
 *   #/                     projects
 *   #/p/12                 project 12, its first panel
 *   #/p/12/runs/57         project 12, Runs panel, run 57
 *   #/features[/7]         features added from finished projects (feature 7)
 *   #/plugins[/id[/panel]] plugins (one plugin, one of its pages)
 *   #/brain                the Brain: the principles every loop follows
 *   #/factory[/view]       the whole factory (floor, bay, order, data), as before projects
 *   #/needs                everything waiting on you (the new shell's first item)
 *   #/_kit                 the shared component kit (not linked; the UI tour shoots it)
 * The old #order, #bay and #data still open the factory views.
 */
export type FactoryView = "factory" | "order" | "bay" | "data" | "improve";
export type Route =
  | { page: "home" }
  | { page: "project"; id: number; panel?: string; run?: number }
  | { page: "factory"; view: FactoryView }
  | { page: "features"; id?: number }
  | { page: "plugins"; id?: string; panel?: string }
  | { page: "brain" }
  | { page: "kit" }
  | { page: "needs" };

const VIEWS: FactoryView[] = ["factory", "order", "bay", "data", "improve"];

export function parse(hash: string): Route {
  const h = hash.replace(/^#/, "");
  if (VIEWS.includes(h as FactoryView) && h !== "factory") return { page: "factory", view: h as FactoryView };
  const parts = h.split("/").filter(Boolean);
  if (parts[0] === "p" && /^\d+$/.test(parts[1] ?? "")) {
    return { page: "project", id: Number(parts[1]), panel: parts[2] || undefined, run: /^\d+$/.test(parts[3] ?? "") ? Number(parts[3]) : undefined };
  }
  if (parts[0] === "features") return { page: "features", id: /^\d+$/.test(parts[1] ?? "") ? Number(parts[1]) : undefined };
  if (parts[0] === "plugins") return { page: "plugins", id: parts[1] || undefined, panel: parts[2] || undefined };
  if (parts[0] === "brain") return { page: "brain" };
  if (parts[0] === "_kit") return { page: "kit" };
  if (parts[0] === "needs") return { page: "needs" };
  if (parts[0] === "factory") return { page: "factory", view: VIEWS.includes(parts[1] as FactoryView) ? (parts[1] as FactoryView) : "factory" };
  return { page: "home" };
}

export function href(r: Route): string {
  if (r.page === "project") return `#/p/${r.id}${r.panel ? `/${r.panel}${r.run ? `/${r.run}` : ""}` : ""}`;
  if (r.page === "features") return r.id ? `#/features/${r.id}` : "#/features";
  if (r.page === "plugins") return `#/plugins${r.id ? `/${r.id}${r.panel ? `/${r.panel}` : ""}` : ""}`;
  if (r.page === "brain") return "#/brain";
  if (r.page === "kit") return "#/_kit";
  if (r.page === "needs") return "#/needs";
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
