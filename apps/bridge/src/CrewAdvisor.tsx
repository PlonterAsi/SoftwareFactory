import { useEffect, useState } from "react";
import { API } from "./api";

interface Rule { model: "sonnet" | "opus" | null; minBudgetUsd: number }

/**
 * Anthropic's advisor tool for the crew: an agent working on haiku or sonnet may stop
 * mid-task and ask a stronger model for a plan or a second look. The advisor's tokens
 * count inside each call's own spend cap, so no run can cost more than its limit.
 */
export function CrewAdvisor() {
  const [r, setR] = useState<Rule | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const call = async (body?: Partial<{ model: string; minBudgetUsd: number }>) => {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`${API}/api/crew/advisor`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not reach the core");
      setR(j);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  useEffect(() => { call(); }, []);
  if (!r) return err ? <p className="setup-blocker">{err}</p> : null;
  const state = r.model
    ? `on: crew agents below ${r.model} can ask ${r.model} for advice, on calls with a cap of $${r.minBudgetUsd.toFixed(2)} or more`
    : "off: every agent works alone";
  return (
    <section className="setup-sec">
      <h3>Crew advisor</h3>
      <div className="place">
        <div className="place-top">
          <span className="place-label">Advisor tool</span>
          <span className={`mono ${r.model ? "" : "muted"}`}>{busy ? "saving…" : state}</span>
          <span className="place-actions">
            {(["off", "sonnet", "opus"] as const).map((m) => (
              <button key={m} className={`ghost sm ${(r.model ?? "off") === m ? "on" : ""}`} disabled={busy || (r.model ?? "off") === m} onClick={() => call({ model: m })}>{m === "off" ? "Off" : m[0].toUpperCase() + m.slice(1)}</button>
            ))}
          </span>
        </div>
        <div className="place-hint">
          A cheap agent does the work and consults a stronger model only at the hard moments: before it commits to a plan, when it is stuck, and before it calls the work done.
          You get close to the stronger model's judgment at close to the cheaper model's price. An agent never gets an advisor that is not stronger than itself.
        </div>
        <div className="place-edit">
          <label className="muted">Only on calls capped at $
            <input type="number" min={0} max={5} step={0.05} defaultValue={r.minBudgetUsd} key={r.minBudgetUsd} aria-label="Smallest call cap that gets an advisor"
              onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v !== r.minBudgetUsd) call({ minBudgetUsd: v }); }} /> or more
          </label>
        </div>
        {err && <p className="setup-blocker">{err}</p>}
      </div>
    </section>
  );
}
