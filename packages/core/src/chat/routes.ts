import type { EventLog } from "../events.js";
import type { OrderState } from "../order/model.js";
import "../projects/tables.js";

/**
 * Project chats. The Overseer channel is split into one chat per project plus a
 * General chat, so each place only shows what belongs there.
 *
 * Where a message lives:
 *   - a Signal said in a project's chat carries { projectId } and lives there;
 *   - a Signal said in General lives in General, and also in every project the
 *     Order Engine filed one of its fragments into (so a brain dump about two
 *     projects shows up in both, marked "from General");
 *   - an Overseer answer carries the { projectId } of the chat it was asked in;
 *   - a factory run lives in the project that owns it (project_links).
 *
 * Nothing new is stored: this is read from the projects and Order Engine tables
 * the log already keeps, so it rebuilds with them.
 */
export interface ChatRoutes {
  /** Signal id → projects its filed fragments landed in (only Signals with at least one). */
  filed: Record<number, number[]>;
  /** Factory run id → owning project. */
  factoryRuns: Record<number, number>;
}

/** Order node id → the root it hangs under, following merges. */
export function rootOf(nodes: OrderState["nodes"]): (id: number) => number {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return (id: number) => {
    const seen = new Set<number>();
    let n = byId.get(id);
    let last = id;
    while (n && !seen.has(n.id)) {
      seen.add(n.id);
      last = n.id;
      const next = n.mergedInto ?? n.parentId;
      if (next == null) return n.id;
      n = byId.get(next);
    }
    return last;
  };
}

function links(log: EventLog, kind: string): Map<string, number> {
  const rows = log.db.prepare("SELECT project_id, ref FROM project_links WHERE kind = ?").all(kind) as { project_id: number; ref: string }[];
  return new Map(rows.map((r) => [String(r.ref), Number(r.project_id)]));
}

export function chatRoutes(log: EventLog, order: OrderState): ChatRoutes {
  const nodeOwner = links(log, "order_node");
  const root = rootOf(order.nodes);
  const filed: Record<number, number[]> = {};
  for (const f of order.fragments) {
    if (f.nodeId == null || f.state !== "live") continue;
    const pid = nodeOwner.get(String(root(f.nodeId))) ?? nodeOwner.get(String(f.nodeId));
    if (pid == null) continue;
    const list = (filed[f.signalId] ??= []);
    if (!list.includes(pid)) list.push(pid);
  }
  const factoryRuns: Record<number, number> = {};
  for (const [ref, pid] of links(log, "factory_run")) factoryRuns[Number(ref)] = pid;
  return { filed, factoryRuns };
}

/**
 * The Order Engine root node of a project: where words said in its chat are filed.
 * A project made in the Bridge gets one at birth; an adopted one is its own root.
 */
export function projectHome(log: EventLog, order: OrderState, projectId: number): number | null {
  const live = new Map(order.nodes.filter((n) => n.mergedInto == null).map((n) => [n.id, n]));
  const rows = log.db.prepare("SELECT ref FROM project_links WHERE kind = 'order_node' AND project_id = ? ORDER BY ts ASC").all(projectId) as { ref: string }[];
  for (const r of rows) {
    const n = live.get(Number(r.ref));
    if (n && n.parentId == null) return n.id;
  }
  return null;
}
