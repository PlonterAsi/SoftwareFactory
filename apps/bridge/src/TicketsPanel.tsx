import { registerProjectPanel } from "./projects/panels";
import { Tickets } from "./Tickets";

/** Every project's workspace gets a Tickets tab: the same list, board and ticket page, scoped to the project. */
registerProjectPanel({
  id: "tickets",
  title: "Tickets",
  order: 40,
  // Open tickets (from the core's tickets facet), else how many are linked at all.
  badge: (ctx) => {
    const f = ctx.project.facets?.tickets as { open?: number; look?: number; you?: number } | undefined;
    if (f?.you) return `${f.you} for you`;
    return f?.open || ctx.project.rollup?.linked?.ticket || null;
  },
  render: (ctx) => (
    <Tickets
      events={ctx.events}
      projectId={ctx.project.id}
      onShowRun={ctx.showRun}
      crew={ctx.bay.agents.filter((a) => !a.retired).map((a) => ({ id: a.def.id, name: a.def.name, avatar: a.def.avatar }))}
    />
  ),
});
