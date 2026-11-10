import type { AgentRunView } from "./api";

/** Every computation is visible: one pulse per agent call, width = time, label = model and cost. */
export function Timeline({ runs, totalUsd }: { runs: AgentRunView[]; totalUsd: number }) {
  const maxMs = Math.max(1000, ...runs.map((r) => r.durationMs ?? 0));
  return (
    <section className="pane timeline" aria-label="Computation timeline">
      <header className="pane-head"><span>Computation</span><span className="muted mono">{runs.length} calls · ${totalUsd.toFixed(4)}</span></header>
      <div className="pulses">
        {!runs.length && <div className="empty">Agent calls appear here as pulses with model, time and cost.</div>}
        {runs.slice(-12).reverse().map((r) => (
          <div key={r.runId} className={`pulse ${r.state}`}>
            <span className="mono p-model" title={r.models?.[0] ?? r.model ?? ""}><span className="p-agent">{r.agent}</span> {r.models?.[0]?.replace("claude-", "").replace(/-\d.*$/, "") ?? r.model ?? "…"}</span>
            <span className="p-bar"><span style={{ width: r.state === "running" ? "100%" : `${Math.max(4, ((r.durationMs ?? 0) / maxMs) * 100)}%` }} /></span>
            <span className="mono p-meta">{r.state === "running" ? "running" : r.state === "failed" ? "failed" : `${((r.durationMs ?? 0) / 1000).toFixed(1)}s · ${(r.contextTokens ?? 0).toLocaleString()} tok · $${(r.costUsd ?? 0).toFixed(4)}`}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
