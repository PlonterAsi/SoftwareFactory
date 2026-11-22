import type { EventLog } from "../events.js";
import type { AgentBay } from "../bay/bay.js";
import type { Tickets } from "../tickets/tickets.js";
import { createProject, listProjects } from "../projects/service.js";
import type { PluginAction, PluginRecordKind } from "./manifest.js";
import { isClosed } from "../tickets/model.js";
import { CATALOG_TAG, saveEntry } from "../configs/catalog.js";

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
      if (verb === "catalog.add") {
        // A pick goes to the catalog (configs/catalog.ts): one entry, and a build ticket the crew leaves alone until you choose Build it.
        const title = text(args.title, 200);
        if (!title) throw new Error("catalog.add needs a title");
        const t = tickets.open({ kind: "task", title, body: text(args.body, 8000), project: args.project == null ? null : Number(args.project), by });
        tickets.edit(t.id, "tags", [...(t.tags ?? []), CATALOG_TAG], by);
        const src = (args.source ?? {}) as Record<string, unknown>;
        const e = saveEntry(log, {
          title, what: text(args.what ?? args.body, 1200), kind: text(args.kind, 16) as never,
          source: { kind: "scout", label: text(src.label, 300) || `From ${by.replace(/^plugin:/, "")}`, ...(src.link ? { link: text(src.link, 500) } : {}), ...(src.video ? { video: text(src.video, 300) } : {}), ...(src.at ? { at: text(src.at, 16) } : {}) },
          touches: Array.isArray(args.touches) ? args.touches.map((x) => text(x, 60)) : [], ticket: t.id, state: "proposed",
        }, by);
        return { entry: e.id, ticket: ticketRow(tickets.get(t.id)!) };
      }
      if (verb === "ticket.note") {
        const id = Number(args.id);
        const note = text(args.text, 4000);
        if (!Number.isFinite(id) || !note) throw new Error("ticket.note needs an id and a text");
        if (!tickets.get(id)) throw new Error(`No ticket ${id}`);
        return ticketRow(tickets.say(id, note, { by }));
      }
      if (verb === "ticket.ask") {
        // Your verdict in an add-on is your ask: the crew starts it within the standing auto-work limit, never past it.
        const id = Number(args.id);
        const t = Number.isFinite(id) ? tickets.get(id) : null;
        if (!t) throw new Error(`No ticket ${args.id}`);
        if (t.openedBy !== by) throw new Error("An add-on can ask only for tickets it opened itself");
        // A ticket people closed or marked a duplicate stays put: an add-on cannot put it back in line (20 Nov: Scout re-asked #89).
        if (args.on !== false && (isClosed(t.status) || tickets.links(id).some((l) => l.from === id && l.relation === "duplicate_of"))) throw new Error(`Ticket ${t.key} is ${isClosed(t.status) ? "closed" : "a duplicate"}; an add-on cannot ask for it again`);
        return ticketRow(tickets.setAsked(id, args.on !== false, by));
      }
      throw new Error(`Unknown action "${verb}"`);
    },
  };
}
