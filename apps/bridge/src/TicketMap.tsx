import { STATUS_ICON, STATUS_WORD, type MapStatus, type TicketMapData } from "./ticketMap";

const LEGEND: MapStatus[] = ["done", "current", "waiting", "failed", "stopped", "notstarted"];

/** The ticket's Run map: every station of the factory run as a labeled node, read-only. */
export function TicketMap({ nodes, header, onOpenRun, onOpenMerge }: TicketMapData & { onOpenRun?: (id: number) => void; onOpenMerge?: () => void }) {
  if (!Array.isArray(nodes) || !header) return <div className="tk-map muted small">The run map could not be read.</div>;
  if (header.runId == null || !nodes.length) return <div className="tk-map muted small" aria-label="Run map">No run yet</div>;
  return (
    <section className="tk-map" aria-label="Run map">
      <div className="row">
        <button className="link mono" onClick={() => onOpenRun?.(header.runId!)}>run #{header.runId}</button>
        {header.spentUsd != null && <span className="muted mono">${header.spentUsd.toFixed(4)}</span>}
      </div>
      <div className="tk-map-row">
        {nodes.map((n, i) => (
          <span key={n.key} className="tk-map-item">
            {i > 0 && <span className="tk-map-arrow" aria-hidden>→</span>}
            <button className={`tk-node n-${n.status}`} aria-label={`${n.label}, ${n.word}`}
              onClick={() => (n.target === "merge" ? onOpenMerge?.() : onOpenRun?.(header.runId!))}>
              <span aria-hidden>{n.icon}</span>
              <span className="tk-node-word">{n.word}</span>
              <span className="tk-node-name">{n.label}{n.round ? ` x${n.round}` : ""}</span>
            </button>
          </span>
        ))}
      </div>
      <div className="tk-map-legend muted small" aria-label="Legend">
        {LEGEND.map((s) => <span key={s}><span className={`tk-node-dot n-${s}`} aria-hidden>{STATUS_ICON[s]}</span> {STATUS_WORD[s]}</span>)}
      </div>
    </section>
  );
}
