import { useMemo, useState, type FormEvent } from "react";
import { EmptyState, StatusGlyph, type Status } from "../ui";
import { shortName } from "./shortName";
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
export function Home({ list, err, onOpen, events, cards }: { list: ProjectSummary[] | null; err: string | null; onOpen: (id: number) => void; events: SfEvent[]; cards?: boolean }) {
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
  // Live projects sharing a name are usually copies (one idea built twice): each row says so.
  const twins = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of list ?? []) if (p.status !== "archived") m.set(p.name, (m.get(p.name) ?? 0) + 1);
    return m;
  }, [list]);
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
        <EmptyState title="No projects yet">Name one above, or tell the Assistant an idea and press Build it: every build starts its own project, and the notes you file grow projects on their own.</EmptyState>
      ) : (
        <ul className={cards ? "pj-cards" : "manifest"}>
          {shown.map((p) => cards
            ? <Card key={p.id} p={p} onOpen={onOpen} twins={(twins.get(p.name) ?? 1) - 1} />
            : <Row key={p.id} p={p} onOpen={onOpen} twins={(twins.get(p.name) ?? 1) - 1} />)}
          {list && !shown.length && <li className="empty">Nothing matches.</li>}
        </ul>
      )}
    </section>
  );
}

function Row({ p, onOpen, twins }: { p: ProjectSummary; onOpen: (id: number) => void; twins: number }) {
  const r = p.rollup;
  const other = Math.max(0, r.runs - r.shipped - r.failed - r.running);
  const linked = Object.entries(r.linked).filter(([k]) => k !== "self"); // "self" only marks SoftwareFactory's own project
  return (
    <li className={`hull hull-row status-${p.status}`}>
      <a href={href({ page: "project", id: p.id })} onClick={(e) => { e.preventDefault(); onOpen(p.id); }} className="hull-link">
        <span className="lamp" aria-label={p.status} title={p.status} />
        <span className="hull-main">
          <span className="hull-name">{p.name}</span>
          {twins > 0 && <span className="hull-twin" role="link" tabIndex={0} onClick={(e) => { e.preventDefault(); e.stopPropagation(); location.hash = href({ page: "project", id: p.id, panel: "settings" }); }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); location.hash = href({ page: "project", id: p.id, panel: "settings" }); } }} title="Same name as another project: probably the same idea built more than once. Open Settings to merge.">{twins === 1 ? "same name as 1 other" : `same name as ${twins} others`} · merge</span>}
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
      {r.shipped > 0 && (
        <a className="button sm hull-use" href={href({ page: "project", id: p.id, panel: "run" })} title="Open the finished app and use it here">▶ Use</a>
      )}
    </li>
  );
}

/** What a project is doing, as one status mark. */
export function projectStatus(p: ProjectSummary): Status {
  const r = p.rollup;
  return r.running ? "working" : r.failed && !r.shipped ? "failed" : r.shipped ? "done" : "idle";
}

const STATUS_LINE: Record<Status, string> = { working: "Building now", needs: "Needs you", done: "Shipped", failed: "Last build failed", idle: "Not built yet", agent: "" };

/** The project as a card (Foundry Glass shell): short name first, then what it is and how it stands. */
function Card({ p, onOpen, twins }: { p: ProjectSummary; onOpen: (id: number) => void; twins: number }) {
  const r = p.rollup;
  const st = projectStatus(p);
  const short = shortName(p.name);
  const other = Math.max(0, r.runs - r.shipped - r.failed - r.running);
  return (
    <li className={`pj-card st-${st} status-${p.status}`}>
      <a className="pj-card-link" href={href({ page: "project", id: p.id })} onClick={(e) => { e.preventDefault(); onOpen(p.id); }} title={p.name}>
        <span className="pj-card-top">
          <StatusGlyph status={st} size={14} label="" />
          <span className="pj-card-state">{STATUS_LINE[st]}</span>
          <span className="pj-card-kind">{p.kind}</span>
        </span>
        <span className="pj-card-name">{short}</span>
        <span className="pj-card-sub">{short !== p.name ? p.name : p.summary || (p.origin === "factory" ? "Started from a build" : p.origin === "order" ? "Grown from your notes" : "No description yet")}</span>
        <span className="hull-bar pj-card-bar" aria-label={`${r.shipped} shipped, ${r.failed} failed, ${r.running} running, ${other} stopped`}>
          {r.runs ? <>
            <i className="seg-shipped" style={{ flexGrow: r.shipped }} />
            <i className="seg-running" style={{ flexGrow: r.running }} />
            <i className="seg-other" style={{ flexGrow: other }} />
            <i className="seg-failed" style={{ flexGrow: r.failed }} />
          </> : <i className="seg-none" />}
        </span>
        <span className="pj-card-nums">
          <span><b>{r.runs}</b> {r.runs === 1 ? "build" : "builds"}</span>
          <span><b>{r.fragments}</b> {r.fragments === 1 ? "note" : "notes"}</span>
          {r.openConflicts > 0 && <span className="alert-text"><b>{r.openConflicts}</b> conflict{r.openConflicts > 1 ? "s" : ""}</span>}
          <span className="num">${r.spendUsd.toFixed(2)}</span>
          <span className="pj-card-when">{ago(r.lastActive)}</span>
        </span>
        {twins > 0 && <span className="pj-card-twin">Same name as {twins === 1 ? "1 other project" : `${twins} others`}: open Settings to merge</span>}
      </a>
      {r.shipped > 0 && <a className="button sm pj-card-use" href={href({ page: "project", id: p.id, panel: "run" })} title="Open the finished app and use it here">Use</a>}
    </li>
  );
}
