import { useEffect, useMemo, useState, type FormEvent } from "react";
import { DuplicateNotice } from "../DuplicateNotice";
import { duplicateOf, projectsApi, setupApi, type DuplicateRun, PROJECT_KINDS, PROJECT_STATUSES, type ProjectDetail, type ProjectSummary, type SfEvent } from "../api";
import { href } from "./router";
import { StarMap } from "../StarMap";
import { OrderDeck } from "../OrderDeck";
import { FactoryFloor } from "../FactoryFloor";
import { RunDeck } from "../RunDeck";
import { inProject, projectSets, registerProjectPanel, type PanelContext } from "./panels";
import { AskBanner, TurnIntoTicket } from "../Intake";

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const usd = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;
export function ago(ts?: string) {
  if (!ts) return "never";
  const m = Math.round((Date.now() - Date.parse(ts)) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ---- Overview ----
function Overview({ project: p, events, go, showRun }: PanelContext) {
  const [idea, setIdea] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const r = p.rollup;
  const sets = useMemo(() => projectSets(p), [p]);
  const recent = useMemo(() => events.filter((e) => inProject(e, p, sets) && describe(e)).slice(-8).reverse(), [events, p, sets]);
  const [dup, setDup] = useState<DuplicateRun | null>(null);
  async function build(e?: FormEvent, again = false) {
    e?.preventDefault();
    if (!idea.trim() || busy) return;
    setBusy(true);
    setDup(null);
    try { const { run } = await projectsApi.build(p.id, idea.trim(), undefined, again); setIdea(""); setErr(null); showRun(run); }
    catch (x) { const d = duplicateOf(x); if (d) setDup(d); else setErr((x as Error).message); }
    finally { setBusy(false); }
  }
  const saveSummary = async () => {
    if (summary == null || summary === p.summary) return setSummary(null);
    try { await projectsApi.update(p.id, { summary }); setSummary(null); } catch (x) { setErr((x as Error).message); }
  };
  return (
    <div className="pj-overview">
      <AskBanner projectId={p.id} name={p.name} hasRuns={p.runIds.length > 0 || p.links.some((l) => l.kind === "self")} archived={p.status === "archived"} />
      <section className="pj-brief">
        {summary == null ? (
          <p className={p.summary ? "pj-summary" : "pj-summary empty-line"} onClick={() => setSummary(p.summary)} title="Click to edit">
            {p.summary || "No description yet. Click to say what this project is for."}
          </p>
        ) : (
          <textarea className="pj-summary-edit" autoFocus value={summary} rows={3} onChange={(e) => setSummary(e.target.value)} onBlur={saveSummary}
            onKeyDown={(e) => { if (e.key === "Escape") setSummary(null); if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) saveSummary(); }} aria-label="Project description" />
        )}
        <form className="pj-build" onSubmit={build}>
          <input value={idea} onChange={(e) => setIdea(e.target.value)} placeholder={`Build something in ${p.name}…`} aria-label="Idea to build in this project" />
          <button type="submit" disabled={!idea.trim() || busy}>{busy ? "Starting…" : "Build it"}</button>
        </form>
        {err && <p className="error" role="alert">{err}</p>}
        {dup && <DuplicateNotice dup={dup} busy={busy} onShow={showRun} onDismiss={() => setDup(null)} onAgain={() => build(undefined, true)} />}
      </section>
      <section className="pj-gauges" aria-label="Project numbers">
        <Gauge label="Runs" value={String(r.runs)} sub={r.running ? `${r.running} running` : r.runs ? `${r.shipped} shipped, ${r.failed} failed` : "none yet"} onClick={() => go("runs")} />
        <Gauge label="Ideas and notes" value={String(r.fragments)} sub={`${r.important} important, ${r.nodes} nodes`} onClick={() => go("ideas")} />
        <Gauge label="Conflicts" value={String(r.openConflicts)} sub={r.openConflicts ? "need your call" : "none open"} alert={r.openConflicts > 0} onClick={() => go("ideas")} />
        <Gauge label="Spend" value={usd(r.spendUsd)} sub={`${r.agentCalls} agent calls`} onClick={() => go("agents")} />
        {(() => {
          const l = p.facets?.launch as { running?: number; folder?: string | null; lastStartedAt?: string | null } | undefined;
          if (!l?.folder && !l?.running) return null;
          return <Gauge label="Run it" value={l.running ? "Live" : "Ready"} sub={l.running ? `${l.running} running` : l.lastStartedAt ? `last started ${ago(l.lastStartedAt)}` : "start it from the app"} onClick={() => go("run")} />;
        })()}
        {Object.entries(r.linked).filter(([k]) => k !== "folder").map(([k, n]) => <Gauge key={k} label={cap(k.replace(/_/g, " ")) + "s"} value={String(n)} sub="linked" onClick={() => go(k === "ticket" ? "tickets" : k)} />)}
      </section>
      <section className="pj-recent">
        <h3>Latest</h3>
        {recent.length ? (
          <ol className="pj-feed">
            {recent.map((e) => <li key={e.id}><time>{ago(e.ts)}</time><span>{describe(e)}</span></li>)}
          </ol>
        ) : <p className="empty">Nothing has happened here yet. Build an idea above, or file notes in the Overseer.</p>}
        <button className="ghost sm" onClick={() => go("history")}>Full history</button>
      </section>
    </div>
  );
}

function Gauge({ label, value, sub, alert, onClick }: { label: string; value: string; sub: string; alert?: boolean; onClick?: () => void }) {
  return (
    <button className={alert ? "gauge alert" : "gauge"} onClick={onClick}>
      <span className="g-value">{value}</span>
      <span className="g-label">{label}</span>
      <span className="g-sub">{sub}</span>
    </button>
  );
}

/** One line in plain words for an event, or null for the noisy ones. */
export function describe(e: SfEvent): string | null {
  const p = e.payload ?? {};
  switch (e.type) {
    case "project.created": return `Project made: ${p.name}`;
    case "project.updated": return p.status ? `Marked ${p.status}` : p.name ? `Renamed to ${p.name}` : "Details edited";
    // The core's own links (ideas, runs) show up as their own events; only other kinds get a line.
    case "project.linked": return p.kind === "order_node" || p.kind === "factory_run" ? null : `${cap(String(p.kind).replace(/_/g, " "))} ${p.ref} moved in`;
    case "project.unlinked": return p.kind === "order_node" || p.kind === "factory_run" ? null : `${cap(String(p.kind).replace(/_/g, " "))} ${p.ref} moved out`;
    case "factory.run.started": return `Run #${e.id} started: ${p.idea}`;
    case "factory.run.finished": return `Run #${p.run} ${p.outcome}${p.reason ? `: ${p.reason}` : ""}`;
    case "factory.gate": return p.state === "waiting" ? `Run #${p.run} waits for you: ${p.question ?? p.gate}` : `Run #${p.run}: ${p.gate} ${p.state} by ${p.by ?? "you"}`;
    case "order.node": return `New ${p.kind === "project" ? "topic" : p.kind}: ${p.title}`;
    case "order.fragment": return p.kind === "noise" ? null : `${p.kind}: ${p.text}`;
    case "order.conflict": return `Conflict: ${p.reason}`;
    default: return null;
  }
}

// ---- Ideas: the project's own star map and Order deck ----
function Ideas({ order, factory }: PanelContext) {
  const [node, setNode] = useState<number | null>(null);
  const runs = factory.factoryRuns;
  return (
    <div className="pj-ideas">
      <StarMap signals={factory.signals} order={order} selected={node} onSelect={setNode} factoryRuns={runs} />
      <OrderDeck order={order} selected={node} onSelect={setNode} />
    </div>
  );
}

// ---- Runs: the factory floor, only this project's runs ----
function Runs({ project, factory, pickedRun, showRun }: PanelContext) {
  const mine = useMemo(() => factory.factoryRuns.filter((r) => project.runIds.includes(r.run)), [factory.factoryRuns, project.runIds]);
  const selected = mine.find((r) => r.run === pickedRun) ?? mine.at(-1);
  if (!mine.length) return <p className="empty pad">No runs in this project yet. Use Build it on the Overview, or ask the Overseer while this project is open.</p>;
  return (
    <div className="pj-runs">
      <FactoryFloor runs={factory.runs} factoryRuns={mine} selected={selected} onSelect={showRun} mode={factory.mode} />
      <RunDeck run={selected} />
    </div>
  );
}

// ---- Agents: who worked here and what it cost ----
function Agents({ project, bay }: PanelContext) {
  const byId = new Map(bay.agents.map((a) => [a.def.id, a.def]));
  if (!project.agents.length) return <p className="empty pad">No agent has worked on this project yet.</p>;
  const max = Math.max(...project.agents.map((a) => a.costUsd), 1e-9);
  return (
    <table className="pj-table">
      <thead><tr><th>Agent</th><th className="num">Calls</th><th className="num">Spend</th><th aria-label="Share of spend" /><th>Last call</th></tr></thead>
      <tbody>
        {project.agents.map((a) => {
          const def = byId.get(a.agent);
          return (
            <tr key={a.agent}>
              <td>{def ? `${def.name}` : a.agent}</td>
              <td className="num">{a.calls}</td>
              <td className="num">{usd(a.costUsd)}</td>
              <td className="bar-cell"><span className="bar" style={{ width: `${Math.max(2, (a.costUsd / max) * 100)}%` }} /></td>
              <td>{ago(a.lastAt)}</td>
            </tr>
          );
        })}
      </tbody>
      <tfoot><tr><td colSpan={5} className="muted">{project.artifacts.files} files written ({Math.round(project.artifacts.bytes / 1024)} KB) across {project.runIds.length} runs.</td></tr></tfoot>
    </table>
  );
}

// ---- History: everything that happened in this project ----
function History({ project, events, showRun }: PanelContext) {
  const sets = useMemo(() => projectSets(project), [project]);
  const items = useMemo(() => events.filter((e) => inProject(e, project, sets)).map((e) => ({ e, text: describe(e) })).filter((x) => x.text).reverse().slice(0, 300), [events, project, sets]);
  if (!items.length) return <p className="empty pad">No history yet.</p>;
  return (
    <ol className="pj-feed long">
      {items.map(({ e, text }) => {
        const run = e.type === "factory.run.started" ? e.id : e.type.startsWith("factory.") ? Number(e.payload?.run) : null;
        return (
          <li key={e.id}>
            <time dateTime={e.ts}>{new Date(e.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
            <span>{text}</span>
            {run ? <button className="ghost sm" onClick={() => showRun(run)}>Show run</button> : null}
          </li>
        );
      })}
    </ol>
  );
}

// ---- Settings: name, kind, status, folders ----
function Settings({ project: p }: PanelContext) {
  const [name, setName] = useState(p.name);
  const [kind, setKind] = useState(p.kind);
  const [msg, setMsg] = useState<string | null>(null);
  const act = (f: Promise<unknown>, ok: string) => f.then(() => setMsg(ok)).catch((x) => setMsg((x as Error).message));
  const kinds = PROJECT_KINDS.includes(p.kind) ? PROJECT_KINDS : [...PROJECT_KINDS, p.kind];
  return (
    <form className="pj-settings" onSubmit={(e) => { e.preventDefault(); act(projectsApi.update(p.id, { name, kind }), "Saved."); }}>
      <label>Name <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></label>
      <label>Kind
        <select value={kind} onChange={(e) => setKind(e.target.value)}>{kinds.map((k) => <option key={k}>{k}</option>)}</select>
      </label>
      <div className="row"><button type="submit" disabled={!name.trim() || (name === p.name && kind === p.kind)}>Save changes</button></div>
      <fieldset>
        <legend>Status</legend>
        <div className="row">
          {PROJECT_STATUSES.map((s) => (
            <button type="button" key={s} className={s === p.status ? "chip on" : "chip"} aria-pressed={s === p.status} onClick={() => act(projectsApi.update(p.id, { status: s }), `Marked ${s}.`)}>{s}</button>
          ))}
        </div>
      </fieldset>
      <MergeInto project={p} />
      {p.runs.some((r) => r.dir) && (
        <fieldset>
          <legend>Folders</legend>
          {p.runs.filter((r) => r.dir).map((r) => (
            <div className="row" key={r.id}>
              <span className="mono path">{r.dir}</span>
              <button type="button" className="ghost sm" onClick={() => act(setupApi.open("run", Number(r.id)), "Opened.")}>Open folder</button>
            </div>
          ))}
        </fieldset>
      )}
      {!p.links.some((l) => l.kind === "self") && p.status !== "archived" && <TurnIntoTicket projectId={p.id} name={p.name} />}
      <p className="muted small">Made {new Date(p.createdAt).toLocaleDateString()} · {p.origin === "you" ? "by you" : p.origin === "factory" ? "from a factory run" : "by the Order Engine from your notes"} · id {p.id}</p>
      {msg && <p className="muted" role="status">{msg}</p>}
    </form>
  );
}

/**
 * Merge this project into another: its runs, ideas, tickets and links move over, and this one goes away
 * (archived instead, if you made it). Projects with the same name come first, since those are usually copies.
 */
function MergeInto({ project: p }: { project: ProjectDetail }) {
  const [all, setAll] = useState<ProjectSummary[] | null>(null);
  const [into, setInto] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { projectsApi.list().then(setAll).catch(() => setAll([])); }, [p.id]);
  const others = (all ?? []).filter((x) => x.id !== p.id && x.status !== "archived");
  const same = others.filter((x) => x.name === p.name);
  const rest = others.filter((x) => x.name !== p.name).sort((a, b) => a.name.localeCompare(b.name));
  if (!others.length) return null;
  const label = (x: ProjectSummary) => `${x.name} · #${x.id} · ${x.rollup.runs} run${x.rollup.runs === 1 ? "" : "s"}`;
  async function merge() {
    const target = others.find((x) => String(x.id) === into);
    if (!target || busy) return;
    if (!confirm(`Move everything in "${p.name}" (#${p.id}) into "${target.name}" (#${target.id})? ${p.origin === "you" ? "This project is then archived." : "This project then goes away."} Its folders on disk stay as they are.`)) return;
    setBusy(true);
    try { await projectsApi.merge(p.id, target.id); location.hash = href({ page: "project", id: target.id }); }
    catch (x) { setMsg((x as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <fieldset className="pj-merge">
      <legend>Merge into another project</legend>
      {same.length > 0 && <p className="muted small">{same.length === 1 ? "Another project has" : `${same.length} other projects have`} this same name, so this is likely a copy. Merging keeps every run and its folder; only the duplicate entry goes.</p>}
      <div className="row">
        <select value={into} onChange={(e) => setInto(e.target.value)} aria-label="Project to merge into">
          <option value="">Choose a project…</option>
          {same.length > 0 && <optgroup label="Same name">{same.map((x) => <option key={x.id} value={x.id}>{label(x)}</option>)}</optgroup>}
          {rest.length > 0 && <optgroup label={same.length ? "Others" : "Projects"}>{rest.map((x) => <option key={x.id} value={x.id}>{label(x)}</option>)}</optgroup>}
        </select>
        <button type="button" className="ghost" disabled={!into || busy} onClick={merge}>{busy ? "Merging…" : "Merge"}</button>
      </div>
      {msg && <p className="error" role="alert">{msg}</p>}
    </fieldset>
  );
}

registerProjectPanel({ id: "overview", title: "Overview", order: 0, render: (c) => <Overview {...c} /> });
registerProjectPanel({
  id: "ideas", title: "Ideas", order: 10, render: (c) => <Ideas {...c} />,
  badge: (c) => c.project.rollup.fragments || null, alert: (c) => c.project.rollup.openConflicts > 0,
});
registerProjectPanel({ id: "runs", title: "Runs", order: 20, render: (c) => <Runs {...c} />, badge: (c) => c.project.rollup.running ? `${c.project.rollup.running} live` : c.project.rollup.runs || null });
registerProjectPanel({ id: "agents", title: "Agents", order: 60, render: (c) => <Agents {...c} />, badge: (c) => c.project.agents.length || null });
registerProjectPanel({ id: "history", title: "History", order: 90, render: (c) => <History {...c} /> });
registerProjectPanel({ id: "settings", title: "Settings", order: 99, render: (c) => <Settings key={c.project.id + c.project.updatedAt} {...c} /> });

export type { ProjectDetail };
