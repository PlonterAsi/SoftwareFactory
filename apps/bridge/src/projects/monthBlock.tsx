import { useEffect, useState } from "react";
import { watchApi, type MonthView } from "../api";

const usd = (n: number) => `$${n.toFixed(2)}`;
const dayName = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/**
 * This month's money, for one project or for everything (projectId null): the monthly budget you set, what was
 * spent, the burn rate over the last seven days, where the month ends at that rate, and one bar per day. The crew's
 * own pickups wait while the month has less left than one start may spend; a start you press gets no more than is left.
 */
export function MonthBlock({ projectId, initial, compact }: { projectId: number | null; initial?: MonthView; compact?: boolean }) {
  const [m, setM] = useState<MonthView | null>(initial ?? null);
  const [edit, setEdit] = useState(false);
  const [val, setVal] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (!initial) watchApi.month(projectId).then(setM).catch((e) => setErr(String(e.message ?? e))); }, [projectId, initial]);
  if (!m) return err ? <div className="err small">{err}</div> : null;
  const save = async () => {
    setErr(null);
    const v = val.trim() === "" ? null : Number(val);
    if (v != null && !(v >= 0)) { setErr("An amount in dollars, or empty for no limit."); return; }
    try { setM(await watchApi.setMonth(projectId, v)); setEdit(false); } catch (e) { setErr((e as Error).message); }
  };
  const used = m.budgetUsd ? Math.min(1, m.spentUsd / m.budgetUsd) : 0;
  const top = Math.max(1e-9, ...m.days.map((d) => d.usd));
  const over = m.budgetUsd != null && m.projectedUsd > m.budgetUsd;
  return (
    <section className={`month-block${compact ? " compact" : ""}`} aria-label={projectId == null ? "This month, all projects" : "This month"}>
      <div className="mb-head">
        <b>{new Date(`${m.month}-15T12:00:00`).toLocaleDateString(undefined, { month: "long" })}{projectId == null ? ", all projects" : ""}</b>
        <span><span className="muted">Spent</span> {usd(m.spentUsd)}{m.budgetUsd != null && <span className="muted"> of {usd(m.budgetUsd)}</span>}</span>
        <span title="Average spend per day over the last seven days"><span className="muted">Burn</span> {usd(m.burnUsd)}/day</span>
        <span className={over ? "warn" : ""} title="What the month comes to at that rate"><span className="muted">Month ends near</span> {usd(m.projectedUsd)}</span>
        {m.runsOutOn && <span className="warn">Runs out {dayName(m.runsOutOn)}</span>}
        {!edit && <button type="button" className="tiny ghost" onClick={() => { setVal(m.budgetUsd == null ? "" : String(m.budgetUsd)); setEdit(true); }}>{m.budgetUsd == null ? "Set a monthly budget" : "Change"}</button>}
      </div>
      {m.budgetUsd != null && <div className="mb-meter" role="img" aria-label={`${Math.round(used * 100)}% of this month's ${usd(m.budgetUsd)} used`}><i style={{ width: `${used * 100}%` }} /></div>}
      {edit && (
        <form className="mb-edit" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <label>{projectId == null ? "All projects together may spend, each month" : "This project may spend, each month"} <input inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value)} placeholder="No limit" autoFocus /></label>
          <button type="submit">Save</button><button type="button" className="ghost" onClick={() => setEdit(false)}>Cancel</button>
        </form>
      )}
      {err && <div className="err small" role="alert">{err}</div>}
      {!compact && m.days.some((d) => d.usd > 0) && (
        <div className="mb-days" role="img" aria-label="Spend per day this month">
          {m.days.map((d) => <i key={d.day} title={`${dayName(d.day)}: ${usd(d.usd)}`} style={{ height: `${Math.max(2, (d.usd / top) * 100)}%` }} />)}
        </div>
      )}
      {!compact && <p className="muted small">The crew picks up ready tickets on its own only while the month has at least one start's cap left; a start you press gets no more than is left. The budget renews on the 1st.</p>}
      {projectId == null && !compact && m.projects && m.projects.length > 0 && (
        <table className="pj-table mb-projects">
          <thead><tr><th>Project</th><th className="num">Spent</th><th className="num">Monthly budget</th><th className="num">Left</th></tr></thead>
          <tbody>{m.projects.map((p) => <tr key={p.projectId}><td>{p.name}</td><td className="num">{usd(p.spentUsd)}</td><td className="num">{p.budgetUsd == null ? "none" : usd(p.budgetUsd)}</td><td className="num">{p.leftUsd == null ? "–" : usd(p.leftUsd)}</td></tr>)}
            {!!m.unassignedUsd && <tr><td className="muted">Not tied to a project</td><td className="num">{usd(m.unassignedUsd)}</td><td /><td /></tr>}</tbody>
        </table>
      )}
    </section>
  );
}
