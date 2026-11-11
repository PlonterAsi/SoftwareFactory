import type { FactoryRunView } from "../api";
import { GateActions } from "../GateActions";
import { href } from "../projects/router";
import { EmptyState, StatusTag } from "../ui";

/**
 * Needs you: every place the factory waits on you, in one list. Approvals answer right here with
 * the shared approval bar; the rest link to where they are decided.
 */
export function NeedsYou({ factoryRuns, featuresWaiting, conflicts, onShowRun }: {
  factoryRuns: FactoryRunView[]; featuresWaiting: number; conflicts: number; onShowRun: (run: number) => void;
}) {
  const waiting = factoryRuns.filter((r) => r.waiting && !r.finished).sort((a, b) => (a.waiting!.at < b.waiting!.at ? -1 : 1));
  const total = waiting.length + (featuresWaiting ? 1 : 0) + (conflicts ? 1 : 0);
  return (
    <section className="pane needs" aria-label="Needs you">
      <header className="page-head">
        <h1>Needs you</h1>
        <p>{total ? `${total} thing${total > 1 ? "s" : ""} wait${total > 1 ? "" : "s"} on you. Oldest first.` : "Approvals, failed steps and choices land here first."}</p>
      </header>
      {!total ? (
        <EmptyState title="Nothing needs you">The crew is working, or idle. When a build needs your OK or a step fails, it shows up here and in the sidebar.</EmptyState>
      ) : (
        <ol className="needs-list">
          {waiting.map((r) => {
            return (
              <li key={r.run} className="needs-item">
                <div className="needs-meta">
                  <StatusTag status="needs" />
                  <span className="needs-title">{r.plan?.name ?? r.idea}</span>
                  <span className="muted mono">build #{r.run}</span>
                  <button className="link" onClick={() => onShowRun(r.run)}>Open the build</button>
                </div>
                <GateActions run={r} />
              </li>
            );
          })}
          {featuresWaiting > 0 && (
            <li className="needs-item">
              <div className="needs-meta"><StatusTag status="needs" /><span className="needs-title">{featuresWaiting} finished app{featuresWaiting > 1 ? "s" : ""} to approve</span></div>
              <p className="needs-body">A finished project asks to join SoftwareFactory as a feature. <a href={href({ page: "features" })}>Review in Finished apps</a></p>
            </li>
          )}
          {conflicts > 0 && (
            <li className="needs-item">
              <div className="needs-meta"><StatusTag status="needs" /><span className="needs-title">{conflicts} rule conflict{conflicts > 1 ? "s" : ""}</span></div>
              <p className="needs-body">Two project rules say different things. Pick the one that wins. <a href={href({ page: "factory", view: "order" })}>Resolve conflicts</a></p>
            </li>
          )}
        </ol>
      )}
    </section>
  );
}
