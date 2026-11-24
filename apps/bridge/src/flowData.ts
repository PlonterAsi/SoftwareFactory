import { useEffect, useState } from "react";
import { flowsApi, type FactoryRunView, type FlowView } from "./api";

/** Flows fetched once per id and shared by every canvas that draws them. */
const cache = new Map<string, Promise<FlowView>>();
export function loadFlow(id: string): Promise<FlowView> {
  let p = cache.get(id);
  if (!p) { p = flowsApi.get(id).then((r) => r.flow); p.catch(() => cache.delete(id)); cache.set(id, p); }
  return p;
}
/** Forget a flow after it was saved, so the next canvas reads the new version. */

/** The id of the built-in flow a run of this kind follows when it carries no copy of its own (runs from before flows). */
export const defaultFlowId = (run?: FactoryRunView) => (run?.repo ? "repo-change" : "new-project");

/** The flow a run follows: its own copy, else the built-in of its kind (null while it loads). */
export function useRunFlow(run?: FactoryRunView): FlowView | null {
  const id = defaultFlowId(run);
  const [fallback, setFallback] = useState<FlowView | null>(null);
  useEffect(() => {
    if (run?.flow) return;
    let live = true;
    loadFlow(id).then((f) => { if (live) setFallback(f); }).catch(() => { /* the canvas shows its empty state */ });
    return () => { live = false; };
  }, [id, run?.flow]);
  return run?.flow ?? (fallback?.id === id ? fallback : null);
}
