import type { EventLog } from "../events.js";
import type { AgentBay } from "../bay/bay.js";
import type { Tickets } from "../tickets/tickets.js";
import { createProject, listProjects } from "../projects/service.js";
import type { PluginAction, PluginRecordKind } from "./manifest.js";

/**
 * The door plugins use to reach real records: what `records:read` shows and what each `actions`
 * verb does. Every verb calls the same command the app's own screens call, and marks who did it
 * (`plugin:<id>`), so work done through a plugin can be told apart and measured.
 */
export interface PluginDoor {
  records(kind: PluginRecordKind, opts: { projectId?: number | null; limit?: number }): unknown[];
  act(verb: PluginAction, args: Record<string, unknown>, by: string): unknown;
}

const text = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
const TICKET_KINDS = ["bug", "task", "request", "idea", "question"] as const;

export function coreDoor(deps: { log: EventLog; tickets: Tickets; bay?: AgentBay }): PluginDoor {
  const { log, tickets, bay } = deps;
  const ticketRow = (t: ReturnType<Tickets["list"]>[number]) => ({
    id: t.id, key: t.key, kind: t.kind, level: t.level, title: t.title, status: t.status, priority: t.priority, severity: t.severity,
    project: t.project, assignee: t.assignee, parentId: t.parentId, run: t.run, openedBy: t.openedBy,
  });
  return {
    records(kind, opts) {
      const limit = Math.min(Math.max(1, Number(opts.limit) || 500), 2000);
      if (kind === "projects") return listProjects(log).slice(0, limit).map((p) => ({ id: p.id, name: p.name, kind: p.kind, status: p.status, summary: p.summary, rollup: p.rollup }));
      if (kind === "tickets") return tickets.list({ project: opts.projectId ?? undefined, view: "all" }).slice(0, limit).map(ticketRow);
      if (kind === "agents") {
        const stats = bay?.stats() ?? {};
        return (bay?.agents() ?? []).slice(0, limit).map((a) => ({ id: a.def.id, name: a.def.name, avatar: a.def.avatar, station: a.def.station, model: a.def.model, retired: a.retired, stats: stats[a.def.id] ?? null }));
      }
      throw new Error(`Unknown records "${kind}"`);
    },
    act(verb, args, by) {
      if (verb === "project.create") {
        const name = text(args.name, 80);
        if (!name) throw new Error("project.create needs a name");
        const id = createProject(log, { name, kind: text(args.kind, 24) || undefined, summary: text(args.summary, 2000) });
        return { id, name: listProjects(log).find((p) => p.id === id)?.name ?? name };
      }
      if (verb === "ticket.open") {
        const title = text(args.title, 200);
        if (!title) throw new Error("ticket.open needs a title");
        const kind = TICKET_KINDS.find((k) => k === args.kind) ?? "task";
        const t = tickets.open({ kind, title, body: text(args.body, 8000), project: args.project == null ? null : Number(args.project), by });
        return ticketRow(t);
      }
      if (verb === "ticket.note") {
        const id = Number(args.id);
        const note = text(args.text, 4000);
        if (!Number.isFinite(id) || !note) throw new Error("ticket.note needs an id and a text");
        if (!tickets.get(id)) throw new Error(`No ticket ${id}`);
        return ticketRow(tickets.say(id, note, { by }));
      }
      throw new Error(`Unknown action "${verb}"`);
    },
  };
}
