import { registerProjectPanel } from "./panels";
import { ImproveDeck, useImprove } from "../ImproveDeck";
import type { PanelContext } from "./panels";

/** The Improvement Council inside each project: only this project's proposals, and Look now looks at this project. */
function ImprovePanel({ ctx }: { ctx: PanelContext }) {
  const improve = useImprove(ctx.events);
  return <ImproveDeck improve={improve} crew={ctx.bay.agents} projectId={ctx.project.id} onRunStarted={ctx.showRun} />;
}

registerProjectPanel({
  id: "improve", section: "improve",
  title: "Improvements",
  order: 50,
  badge: (ctx) => {
    const f = ctx.project.facets?.improvements as Record<string, number> | undefined;
    return f?.inbox ? f.inbox : null;
  },
  render: (ctx) => <ImprovePanel ctx={ctx} />,
});
