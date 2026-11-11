import { useEffect, useState } from "react";

/**
 * Where the Bridge is, kept in the address hash so a reload (or the back button) stays put.
 *   #/                     projects
 *   #/p/12                 project 12, its first panel
 *   #/p/12/runs/57         project 12, Runs panel, run 57
 *   #/features[/7]         features added from finished projects (feature 7)
 *   #/factory[/view]       the whole factory (floor, bay, order, data), as before projects
 * The old #order, #bay and #data still open the factory views.
 */
export type FactoryView = "factory" | "order" | "bay" | "data" | "improve";
export type Route =
  | { page: "home" }
  | { page: "project"; id: number; panel?: string; run?: number }
  | { page: "factory"; view: FactoryView }
  | { page: "features"; id?: number };

const VIEWS: FactoryView[] = ["factory", "order", "bay", "data", "improve"];

export function parse(hash: string): Route {
  const h = hash.replace(/^#/, "");
  if (VIEWS.includes(h as FactoryView) && h !== "factory") return { page: "factory", view: h as FactoryView };
  const parts = h.split("/").filter(Boolean);
  if (parts[0] === "p" && /^\d+$/.test(parts[1] ?? "")) {
    return { page: "project", id: Number(parts[1]), panel: parts[2] || undefined, run: /^\d+$/.test(parts[3] ?? "") ? Number(parts[3]) : undefined };
  }
  if (parts[0] === "features") return { page: "features", id: /^\d+$/.test(parts[1] ?? "") ? Number(parts[1]) : undefined };
  if (parts[0] === "factory") return { page: "factory", view: VIEWS.includes(parts[1] as FactoryView) ? (parts[1] as FactoryView) : "factory" };
  return { page: "home" };
}

export function href(r: Route): string {
  if (r.page === "project") return `#/p/${r.id}${r.panel ? `/${r.panel}${r.run ? `/${r.run}` : ""}` : ""}`;
  if (r.page === "features") return r.id ? `#/features/${r.id}` : "#/features";
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
