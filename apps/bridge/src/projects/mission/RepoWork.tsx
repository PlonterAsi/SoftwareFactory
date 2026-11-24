import { useEffect, useMemo, useState } from "react";
import { showTicket } from "../../BugReport";
import { AskBanner } from "../../Intake";
import { ticketsApi, type TicketView } from "../../Tickets";
import { GateActions } from "../../GateActions";
import type { FactoryRunView } from "../../api";
import type { PanelContext } from "../panels";

/** The repo a project is worked in, when it has one and is not built by factory runs: its own GitHub repo, or one you imported. */
export interface WorkedRepo { label: string; url: string | null; imported: boolean }
export function workedRepo(p: PanelContext["project"]): WorkedRepo | null {
  const gh = p.links.find((l) => l.kind === "github");
  if (gh) return { label: String(gh.ref), url: `https://github.com/${gh.ref}`, imported: false };
  const repo = p.links.find((l) => l.kind === "repo");
  if (!repo) return null;
  const ref = String(repo.ref);
  const web = /^https?:\/\//.test(ref) ? ref.replace(/\.git$/, "") : null;
  return { label: web ? web.replace(/^https?:\/\/(www\.)?github\.com\//, "") : ref, url: web, imported: true };
}

interface CodeFacet { status?: string; files?: number; lines?: number; modules?: number; health?: number | null; openSuggestions?: number; branch?: string | null }
const ASKS: { kind: "request" | "bug" | "task"; label: string; hint: string }[] = [
  { kind: "request", label: "A new feature", hint: "What should it do that it does not do today?" },
  { kind: "bug", label: "A bug", hint: "What happens, and what did you expect?" },
  { kind: "task", label: "A small task", hint: "What should be changed or tidied?" },
];

/** Say what you want done in the repo: it becomes a ticket the crew works on a branch. */
function RepoAsk({ projectId, name }: { projectId: number; name: string }) {
  const [kind, setKind] = useState<(typeof ASKS)[number]["kind"]>("request");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ask = ASKS.find((a) => a.kind === kind)!;
  const open = async () => {
    const lines = text.trim().split("\n");
    const title = lines[0].trim().slice(0, 160);
    if (!title) return;
    setBusy(true); setErr(null);
    try {
      const t = await ticketsApi.open({ kind, title, body: lines.slice(1).join("\n").trim() || (lines[0].length > 160 ? text.trim() : ""), project: projectId });
      setText("");
      showTicket(t.id, projectId);
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };
  return (
    <section className="ms-card rw-ask">
      <h4>What do you want done in {name}?</h4>
      <div className="rw-kinds" role="radiogroup" aria-label="Kind of ask">
        {ASKS.map((a) => <button key={a.kind} role="radio" aria-checked={a.kind === kind} className={a.kind === kind ? "on" : undefined} onClick={() => setKind(a.kind)}>{a.label}</button>)}
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={`${ask.hint} The first line is the title.`} rows={3} aria-label="Your ask"
        onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void open(); } }} />
      <div className="rw-ask-foot">
        <span className="rw-hint">It becomes a ticket. The crew works it on a branch of its own copy, and you look before anything is taken. A fix or a small task takes one Builder session; a feature gets the whole engine: designed, planned for your OK, built, reviewed and judged.</span>
        <button onClick={open} disabled={busy || !text.trim()}>{busy ? "Opening…" : "Open the ticket"}</button>
      </div>
      {err && <p className="alert-text" role="alert">{err}</p>}
    </section>
  );
}

const STATION_WORD: Record<string, string> = { intake: "setting up the clone", council: "the Council is talking it over", discover: "designing the change", plan: "planning", gateA: "the plan waits for you", tests: "running the repo's tests", build: "building", test: "testing", fix: "fixing", review: "the Reviewer is checking it", evaluate: "the judge is looking at the site", gateB: "the build waits for you", ship: "handing the branch over" };

/** Where a run stands, in a few words. */
function runWord(r: FactoryRunView): [string, string] {
  if (r.waiting) return [r.waiting.gate === "gateA" ? "The plan waits for your OK" : r.waiting.gate === "gateB" ? "The build waits for your OK" : "Needs your call", "gate"];
  if (r.finished) return r.finished.outcome === "shipped" ? [r.repo?.pr ? `Done: draft PR #${r.repo.pr.number}` : "Done: the branch is ready to take", "done"] : [r.finished.resumable ? "Stopped part way" : r.finished.outcome === "stopped" ? "Stopped" : "Failed", "fail"];
  const at = Object.entries(r.stations).filter(([, v]) => v.state === "active").map(([k]) => k).at(-1);
  return [at ? STATION_WORD[at] ?? at : "starting", "work"];
}

/** The engine's runs in this repo: each a feature being designed, planned, built and judged on its own branch. */
function EngineRuns({ ctx }: { ctx: PanelContext }) {
  const { project: p, factory, showRun } = ctx;
  const mine = useMemo(() => factory.factoryRuns.filter((r) => p.runIds.includes(r.run)).reverse(), [factory.factoryRuns, p.runIds]);
  if (!mine.length) return null;
  return (
    <section className="ms-card rw-runs" aria-label="Features on the engine">
      <h4>Features on the engine<span className="mono rw-n">{mine.length}</span></h4>
      <p className="rw-hint">Each one is designed, planned for your OK, built on its own branch, reviewed and judged on the running site.</p>
      <ul>
        {mine.slice(0, 4).map((r) => {
          const [word, tone] = runWord(r);
          return (
            <li key={r.run} className={`rw-run tone-${tone}`}>
              <div className="rw-run-head">
                <i />
                <button className="link rw-run-name" onClick={() => showRun(r.run)} title={r.idea}><span className="mono">#{r.run}</span> {r.plan?.name ?? r.idea.split("\n")[0].slice(0, 90)}</button>
                <span className="rw-run-word">{word}</span>
                <span className="mono muted">${r.spentUsd.toFixed(2)} of ${r.maxUsd.toFixed(2)}</span>
                {r.repo?.pr && <a className="tk-prchip pr-open" href={r.repo.pr.url} target="_blank" rel="noreferrer">PR #{r.repo.pr.number}</a>}
                <button className="ghost sm" onClick={() => showRun(r.run)}>Open the run</button>
              </div>
              {r.repo && <div className="rw-run-branch mono muted">{r.repo.branch}{r.repo.ticket ? ` · ${r.repo.ticket.key}` : ""}</div>}
              {r.waiting && <GateActions run={r} compact />}
            </li>
          );
        })}
      </ul>
      {mine.length > 4 && <a className="rw-more" href={`#/p/${p.id}/runs`}>and {mine.length - 4} more</a>}
    </section>
  );
}

/**
 * The first tab of a project that lives in a repo of its own (SoftwareFactory itself is one):
 * its work is tickets that come back as pull requests, not builds on the idea track.
 * Three lanes read left to right: waiting, in work, merged.
 */
export function RepoWork({ ctx, repo }: { ctx: PanelContext; repo: WorkedRepo }) {
  const { project: p, events } = ctx;
  const code = (p.facets?.code ?? null) as CodeFacet | null;
  const [all, setAll] = useState<TicketView[] | null>(null);
  const last = useMemo(() => { for (let i = events.length - 1; i >= 0; i--) if (events[i].type.startsWith("ticket.")) return events[i].id; return 0; }, [events]);
  useEffect(() => { ticketsApi.list({ project: p.id, view: "all" }).then((r) => setAll(r.tickets)).catch(() => setAll([])); }, [p.id, last]);
  const t = all ?? [];
  const open = t.filter((x) => x.status !== "closed" && x.status !== "rejected");
  const working = open.filter((x) => x.status === "in_progress");
  const look = open.filter((x) => x.status === "built");
  const ready = open.filter((x) => x.status === "ready");
  const merged = t.filter((x) => x.pr?.state === "merged").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const inPr = open.filter((x) => x.pr?.state === "open");
  const lanes: { title: string; hint: string; tone: string; rows: TicketView[]; total: number }[] = [
    { title: "Waits for your look", hint: "Built or merged; close it when it is right", tone: "gate", rows: look.slice(0, 6), total: look.length },
    { title: "In work", hint: "The crew is on it, or its pull request is open", tone: "work", rows: [...new Set([...working, ...inPr])].slice(0, 6), total: new Set([...working, ...inPr]).size },
    { title: "Ready next", hint: "The crew picks these up in order", tone: "next", rows: ready.slice(0, 6), total: ready.length },
    { title: "Merged lately", hint: repo.imported ? "Their pull requests are merged" : "In the app with the next update", tone: "done", rows: merged.slice(0, 6), total: merged.length },
  ];
  return (
    <div className="mission">
      <AskBanner projectId={p.id} name={p.name} hasRuns archived={p.status === "archived"} />
      <section className="ms-head">
        <div className="ms-what">
          <div className="ms-eyebrow"><span>{repo.imported ? "Imported repo" : "Worked in its repo"}</span><span className="mono">{repo.url ? <a href={repo.url} target="_blank" rel="noreferrer">{repo.label}</a> : repo.label}</span>{repo.imported && code?.branch && <span className="mono">{code.branch}</span>}</div>
          <p className="ms-now">
            {all == null ? "Reading the tickets…" : open.length === 0 ? "Nothing is open. A new ask starts as a ticket." : <><em>{open.length} open.</em> {working.length + inPr.length} in work, {look.length} wait for your look, {merged.length} merged.</>}
          </p>
          <p className="ms-idea">{repo.imported
            ? "This project already has code. Each ask here is a ticket: the crew works it on a branch in its own copy of the repo, and your repo is never changed until you take the branch."
            : "Each ask here is a ticket. The crew works it on a branch, it comes back as a pull request, and its merge closes the ticket."}</p>
        </div>
        <a className="btn-ghost" href={`#/p/${p.id}/tickets`}>Open all tickets</a>
      </section>
      <EngineRuns ctx={ctx} />
      {repo.imported && (
        <>
          <RepoAsk projectId={p.id} name={p.name} />
          {code && (
            <section className="rw-facts">
              <a className="ms-card rw-fact" href={`#/p/${p.id}/code`}>
                <h4>The code</h4>
                <p><em>{code.files ?? 0}</em> files, <em>{(code.lines ?? 0).toLocaleString()}</em> lines in <em>{code.modules ?? 0}</em> parts{code.health != null && <>. Health <em>{code.health}</em> of 100</>}.</p>
                <span className="rw-go">Open the code map</span>
              </a>
              <a className="ms-card rw-fact" href={`#/p/${p.id}/code`}>
                <h4>The crew's suggestions</h4>
                <p>{code.openSuggestions ? <><em>{code.openSuggestions}</em> wait for your yes or no. A yes makes a ticket.</> : "None waiting. The Surveyor suggests more when the code changes."}</p>
                <span className="rw-go">Open the suggestions</span>
              </a>
              <a className="ms-card rw-fact" href={`#/p/${p.id}/run`}>
                <h4>Run it</h4>
                <p>Start the app from its own copy and see its output and pages here.</p>
                <span className="rw-go">Open Use</span>
              </a>
            </section>
          )}
        </>
      )}
      <section className="rw-lanes">
        {lanes.map((l) => (
          <div key={l.title} className={`ms-card rw-lane tone-${l.tone}`}>
            <h4><i />{l.title}<span className="mono rw-n">{l.total}</span></h4>
            <p className="rw-hint">{l.hint}</p>
            {l.rows.length === 0 ? <p className="rw-none">None</p> : (
              <ul>
                {l.rows.map((x) => (
                  <li key={x.id}>
                    <button className="link" onClick={() => showTicket(x.id, p.id)} title={x.title}><span className="mono">{x.key}</span> {x.title}</button>
                    {x.pr && <a className={`tk-prchip pr-${x.pr.state}`} href={x.pr.url} target="_blank" rel="noreferrer" title={`Pull request #${x.pr.number}, ${x.pr.state}`}>PR #{x.pr.number}</a>}
                  </li>
                ))}
              </ul>
            )}
            {l.total > l.rows.length && <a className="rw-more" href={`#/p/${p.id}/tickets`}>and {l.total - l.rows.length} more</a>}
          </div>
        ))}
      </section>
    </div>
  );
}
