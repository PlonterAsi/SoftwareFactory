import { useMemo, useState, type FormEvent } from "react";
import { projectsApi, PROJECT_KINDS, type ProjectSummary } from "../api";
import { ago } from "./builtin";
import { href } from "./router";
import { ImportRepo } from "../CodeMap";
import { AskNotProject, checkIntake, type IntakeVerdict } from "../Intake";
import { showTicket } from "../BugReport";
import { Waiting } from "../Tickets";
import type { SfEvent } from "../api";

type Filter = "live" | "archived" | "all";

/**
 * The fleet: every project, most recently active first. Each row's hull bar shows
 * its runs (shipped, failed, running) at a glance; the numbers say the rest.
 */
export function Home({ list, err, onOpen, events }: { list: ProjectSummary[] | null; err: string | null; onOpen: (id: number) => void; events: SfEvent[] }) {
  const [filter, setFilter] = useState<Filter>("live");
  const [q, setQ] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState("app");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [ask, setAsk] = useState<IntakeVerdict | null>(null);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (list ?? []).filter((p) => (filter === "all" ? true : filter === "archived" ? p.status === "archived" : p.status !== "archived"))
      .filter((p) => !s || p.name.toLowerCase().includes(s) || p.summary.toLowerCase().includes(s));
  }, [list, filter, q]);
  const archived = (list ?? []).filter((p) => p.status === "archived").length;
  const totals = useMemo(() => (list ?? []).reduce((t, p) => ({ runs: t.runs + p.rollup.runs, usd: t.usd + p.rollup.spendUsd, conflicts: t.conflicts + p.rollup.openConflicts }), { runs: 0, usd: 0, conflicts: 0 }), [list]);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    // An ask about a project you have is a ticket there, not a project: offer that first.
    const v = await checkIntake(name.trim());
    setBusy(false);
    if (v) setAsk(v); else await make();
  }
  async function make() {
    setAsk(null);
    setBusy(true);
    try { const p = await projectsApi.create(name.trim(), kind); setName(""); setMsg(null); onOpen(p.id); }
    catch (x) { setMsg((x as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <section className="pane fleet" aria-label="Projects">
      <header className="fleet-head">
        <div>
          <h1>Projects</h1>
          <p className="muted">{list ? `${list.length - archived} in flight${archived ? `, ${archived} archived` : ""} · ${totals.runs} runs · $${totals.usd.toFixed(2)} spent` : "Reading the log…"}</p>
        </div>
        <form className="fleet-new" onSubmit={create}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New project name" aria-label="New project name" maxLength={80} />
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">{PROJECT_KINDS.map((k) => <option key={k}>{k}</option>)}</select>
          <button type="submit" disabled={!name.trim() || busy}>Create project</button>
        </form>
      </header>
      {ask && <AskNotProject text={name.trim()} verdict={ask} onProject={make} onCancel={() => setAsk(null)} onFiled={(id, project) => { setAsk(null); setName(""); showTicket(id, project); }} />}
      <section className="waiting-home" aria-label="Waiting on you">
        <h2>Waiting on you</h2>
        <Waiting events={events} onSelect={(id, project) => showTicket(id, project)} limit={6} />
      </section>
      <ImportRepo />
      <div className="fleet-tools">
        <div className="seg" role="tablist" aria-label="Which projects">
          {(["live", "archived", "all"] as Filter[]).map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{f === "live" ? "In flight" : f === "archived" ? "Archived" : "All"}</button>
          ))}
        </div>
        <input className="fleet-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a project" aria-label="Find a project" />
      </div>
      {(err || msg) && <p className="error pad" role="alert">{msg ?? `Could not read projects: ${err}`}</p>}
      {list && !list.length ? (
        <div className="fleet-empty">
          <p>No projects yet.</p>
          <p className="muted">Name one above, or tell the Overseer an idea and press Build it: every build starts its own project, and the notes you file grow projects on their own.</p>
        </div>
      ) : (
        <ul className="manifest">
          {shown.map((p) => <Row key={p.id} p={p} onOpen={onOpen} />)}
          {list && !shown.length && <li className="empty">Nothing matches.</li>}
        </ul>
      )}
    </section>
  );
}

function Row({ p, onOpen }: { p: ProjectSummary; onOpen: (id: number) => void }) {
  const r = p.rollup;
  const other = Math.max(0, r.runs - r.shipped - r.failed - r.running);
  const linked = Object.entries(r.linked).filter(([k]) => k !== "self"); // "self" only marks SoftwareFactory's own project
  return (
    <li className={`hull status-${p.status}`}>
      <a href={href({ page: "project", id: p.id })} onClick={(e) => { e.preventDefault(); onOpen(p.id); }} className="hull-link">
        <span className="lamp" aria-label={p.status} title={p.status} />
        <span className="hull-main">
          <span className="hull-name">{p.name}</span>
          <span className="hull-sub">{p.summary || (p.origin === "factory" ? "Started from a build" : p.origin === "order" ? "Grown from your notes" : "No description yet")}</span>
        </span>
        <span className="hull-kind">{p.kind}</span>
        <span className="hull-bar" aria-label={`${r.shipped} shipped, ${r.failed} failed, ${r.running} running, ${other} stopped`}>
          {r.runs ? <>
            <i className="seg-shipped" style={{ flexGrow: r.shipped }} />
            <i className="seg-running" style={{ flexGrow: r.running }} />
            <i className="seg-other" style={{ flexGrow: other }} />
            <i className="seg-failed" style={{ flexGrow: r.failed }} />
          </> : <i className="seg-none" />}
        </span>
        <span className="hull-nums">
          <span><b>{r.runs}</b> {r.runs === 1 ? "run" : "runs"}</span>
          <span><b>{r.fragments}</b> {r.fragments === 1 ? "note" : "notes"}</span>
          {r.openConflicts > 0 && <span className="alert-text"><b>{r.openConflicts}</b> conflict{r.openConflicts > 1 ? "s" : ""}</span>}
          {linked.map(([k, n]) => <span key={k}><b>{n}</b> {k.replace(/_/g, " ")}{n > 1 ? "s" : ""}</span>)}
          <span><b>${r.spendUsd.toFixed(2)}</b></span>
        </span>
        <span className="hull-when">{ago(r.lastActive)}</span>
      </a>
    </li>
  );
}
