import { useState } from "react";
import { API } from "../api";
import { EmptyState } from "../ui";
import { registerProjectPanel, type PanelContext } from "./panels";

/**
 * Money: what this project may spend in all, what each version gets, and where the money went version by
 * version. A build started here without its own limit takes the version default, and never more than the
 * project has left. Empty fields mean no limit (the factory's own defaults apply).
 */
interface VersionSpend { run: number; version: number; kind: "first" | "next"; idea: string; startedAt: string; maxUsd: number; spentUsd: number; outcome: string }
interface Budget { totalUsd: number | null; firstUsd: number | null; nextUsd: number | null; spentUsd: number; heldUsd: number; leftUsd: number | null; versions: VersionSpend[] }

const usd = (n: number) => `$${n.toFixed(2)}`;
const field = (n: number | null) => (n == null ? "" : String(n));
const amount = (s: string): number | null => (s.trim() === "" ? null : Number(s));

function Money({ project, showRun }: PanelContext) {
  const fromFacet = project.facets?.budget as Budget | undefined;
  const [saved, setSaved] = useState<Budget | null>(null);
  const b = saved ?? fromFacet;
  const [total, setTotal] = useState(field(b?.totalUsd ?? null));
  const [first, setFirst] = useState(field(b?.firstUsd ?? null));
  const [next, setNext] = useState(field(b?.nextUsd ?? null));
  const [msg, setMsg] = useState<string | null>(null);
  if (!b) return <EmptyState title="No money information">The core did not report this project's budget.</EmptyState>;
  const bad = [total, first, next].some((s) => s.trim() !== "" && !(Number(s) >= 0));
  const changed = total !== field(b.totalUsd) || first !== field(b.firstUsd) || next !== field(b.nextUsd);
  const save = async () => {
    setMsg(null);
    const r = await fetch(`${API}/api/projects/${project.id}/budget`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ totalUsd: amount(total), firstUsd: amount(first), nextUsd: amount(next) }) });
    const j = await r.json();
    if (!r.ok) { setMsg(j.error ?? "Could not save."); return; }
    setSaved(j); setMsg("Saved.");
  };
  const used = b.totalUsd ? Math.min(1, (b.spentUsd + b.heldUsd) / b.totalUsd) : 0;
  const top = Math.max(1e-9, ...b.versions.map((v) => Math.max(v.maxUsd, v.spentUsd)));
  return (
    <div className="pj-money">
      <div className="money-head">
        <div><span className="muted">Spent</span><b>{usd(b.spentUsd)}</b></div>
        {b.heldUsd > 0 && <div><span className="muted">Held by a running build</span><b>{usd(b.heldUsd)}</b></div>}
        <div><span className="muted">Left</span><b className={b.leftUsd != null && b.leftUsd < 0.25 ? "warn" : ""}>{b.leftUsd == null ? "no limit" : usd(b.leftUsd)}</b></div>
        {b.totalUsd != null && <div className="money-meter" role="img" aria-label={`${Math.round(used * 100)}% of ${usd(b.totalUsd)} used`}><i style={{ width: `${used * 100}%` }} /></div>}
      </div>
      <form className="pj-settings" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label>Project total, in dollars <input inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} placeholder="No limit" /></label>
        <label>A first version gets <input inputMode="decimal" value={first} onChange={(e) => setFirst(e.target.value)} placeholder="Factory default" /></label>
        <label>Each later version gets <input inputMode="decimal" value={next} onChange={(e) => setNext(e.target.value)} placeholder="Factory default" /></label>
        <p className="muted">A build started here without its own limit takes the version amount, never more than the project has left. When a build runs out it asks you before it spends more, and only up to what is left.</p>
        <div className="row"><button type="submit" disabled={bad || !changed}>Save limits</button>{msg && <span className={msg === "Saved." ? "muted" : "error"} role="status">{msg}</span>}</div>
      </form>
      {b.versions.length ? (
        <table className="pj-table">
          <thead><tr><th>Version</th><th>What it built</th><th className="num">Limit</th><th className="num">Spent</th><th aria-label="Spent of its limit" /><th>Ended</th></tr></thead>
          <tbody>
            {b.versions.map((v) => (
              <tr key={v.run}>
                <td><button type="button" className="tiny ghost" onClick={() => showRun(v.run)}>v{v.version} · run {v.run}</button></td>
                <td>{v.kind === "first" ? "New app: " : "On top: "}{v.idea}</td>
                <td className="num">{usd(v.maxUsd)}</td>
                <td className="num">{usd(v.spentUsd)}</td>
                <td className="bar-cell"><span className="bar" style={{ width: `${Math.max(2, (v.spentUsd / top) * 100)}%` }} /></td>
                <td>{v.outcome}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <EmptyState title="Nothing spent yet">Each build of this project shows here with its limit and what it spent.</EmptyState>}
    </div>
  );
}

registerProjectPanel({
  id: "money", section: "build", title: "Money", order: 25,
  render: (c) => <Money key={c.project.id} {...c} />,
  badge: (c) => { const b = c.project.facets?.budget as Budget | undefined; return b?.leftUsd != null ? `${usd(b.leftUsd)} left` : null; },
  alert: (c) => { const b = c.project.facets?.budget as Budget | undefined; return b?.leftUsd != null && b.leftUsd < 0.25; },
});
