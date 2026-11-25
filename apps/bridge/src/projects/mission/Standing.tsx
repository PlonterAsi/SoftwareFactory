import { useEffect, useState } from "react";
import { standingApi, type ProjectStanding } from "../../api";
import { showTicket } from "../../BugReport";
import type { PanelContext } from "../panels";

const usd = (n: number | null) => (n == null ? "" : `$${n.toFixed(2)}`);
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "");

/**
 * Where the project stands, across its versions: the version it is on, how much of the design the product judge
 * saw working, what is left, and who has it. A project is finished when nothing is left, not when version 1 ships.
 */
export function Standing({ ctx }: { ctx: PanelContext }) {
  const { project: p, events, factory } = ctx;
  const [s, setS] = useState<ProjectStanding | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // Anything that can change the standing: a run of this project ending, the list being written down, its ticket moving.
  const beat = events.filter((e) => e.type === "factory.run.finished" || e.type === "factory.left" || e.type === "ticket.noted" || e.type === "ticket.run").length;
  useEffect(() => { let on = true; standingApi.get(p.id).then((x) => { if (on) setS(x); }).catch(() => undefined); return () => { on = false; }; }, [p.id, beat]);
  if (!s) return null;
  const leftCount = s.unmet.length + s.features.length + s.notes.filter((n) => n.severity === "high").length;
  const pct = s.judged ? Math.round((s.working / s.judged) * 100) : s.done ? 100 : 0;
  const running = s.ticket?.run != null && factory.factoryRuns.some((r) => r.run === s.ticket!.run && !r.finished);
  const closed = s.ticket && ["closed", "rejected", "duplicate"].includes(s.ticket.status);
  async function finish() {
    setBusy(true); setErr(null);
    try { setS(await standingApi.finish(p.id)); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  const who = s.done ? "Nothing is left. The project met its design."
    : !s.ticket ? "Nobody has this list yet."
    : running ? `The crew is building the next version now (run #${s.ticket.run}).`
    : closed ? "Its ticket was closed with the list still open."
    : s.ticket.status === "built" ? "The next version is built and waits for a look."
    : s.ticket.asked ? "It is the project's next ticket: the crew starts it by itself, within your standing limit."
    : "Its ticket waits for you: the last version did not shorten the list.";
  return (
    <section className={`ms-card ms-standing${s.done ? " done" : ""}`} aria-label="Where this project stands">
      <div className="ms-st-head">
        <div>
          <p className="ms-eyebrow"><span>Where it stands</span><span className="mono">{s.version}</span><span>shipped {day(s.shippedAt)}</span><span>{s.versions.length} version{s.versions.length === 1 ? "" : "s"}</span></p>
          <p className="ms-st-line">
            {s.judged ? <><b>{s.working} of {s.judged}</b> requirements seen working by the judge</> : <b>Not judged in the running app</b>}
            {leftCount > 0 && <>, <b>{leftCount}</b> left to do</>}
          </p>
        </div>
        <div className="ms-st-acts">
          <button className="ghost sm" onClick={() => ctx.go("use")}>Open the app</button>
          {s.ticket && <button className="ghost sm" onClick={() => showTicket(s.ticket!.id, p.id)}>Open its ticket</button>}
          {!s.done && (!s.ticket || closed) && <button className="sm" disabled={busy} onClick={finish}>{busy ? "Filing…" : "Have the crew finish it"}</button>}
        </div>
      </div>
      <div className="ms-st-bar" role="img" aria-label={`${pct}% of the requirements seen working`}><i style={{ width: `${pct}%` }} /></div>
      <ol className="ms-st-versions">
        {s.versions.map((v) => <li key={v.run} className={v.run === s.run ? "on" : ""}><button className="link" onClick={() => ctx.showRun(v.run)}><span className="mono">{v.version}</span> <span className="muted">{day(v.at)} {usd(v.usd)}</span></button></li>)}
        {!s.done && <li className="next"><span className="mono">next</span> <span className="muted">{who}</span></li>}
      </ol>
      {s.done && <p className="ms-st-who">{who}</p>}
      {err && <p className="err">{err}</p>}
      {leftCount > 0 && (
        <div className="ms-st-left">
          <button className="link" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Hide what is left" : `Show what is left (${leftCount})`}</button>
          {open && (
            <ul>
              {s.unmet.map((r) => <li key={r.id}><b className="mono">{r.id}</b> {r.text || "A requirement of the design"}<span className="muted"> Judge: {r.evidence || "not seen on any screen"}</span></li>)}
              {s.features.map((f) => <li key={f.id}><b className="mono">{f.id}</b> {f.title}<span className="muted"> {f.why}</span></li>)}
              {s.notes.filter((n) => n.severity === "high").map((n, i) => <li key={`n${i}`}><b>Reviewer</b> {n.text}</li>)}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
