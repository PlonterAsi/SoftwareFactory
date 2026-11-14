import { useEffect, useMemo, useState } from "react";
import { showTicket } from "../../BugReport";
import { AskBanner } from "../../Intake";
import { ticketsApi, type TicketView } from "../../Tickets";
import type { PanelContext } from "../panels";

/** The GitHub repo a project is worked in ("owner/name"), when it has one and is not built by factory runs. */
export function workedRepo(p: PanelContext["project"]): string | null {
  const gh = p.links.find((l) => l.kind === "github");
  return gh ? String(gh.ref) : null;
}

/**
 * The first tab of a project that lives in a repo of its own (SoftwareFactory itself is one):
 * its work is tickets that come back as pull requests, not builds on the idea track.
 * Three lanes read left to right: waiting, in work, merged.
 */
export function RepoWork({ ctx, repo }: { ctx: PanelContext; repo: string }) {
  const { project: p, events } = ctx;
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
    { title: "Merged lately", hint: "In the app with the next update", tone: "done", rows: merged.slice(0, 6), total: merged.length },
  ];
  return (
    <div className="mission">
      <AskBanner projectId={p.id} name={p.name} hasRuns archived={p.status === "archived"} />
      <section className="ms-head">
        <div className="ms-what">
          <div className="ms-eyebrow"><span>Worked in its repo</span><a className="mono" href={`https://github.com/${repo}`} target="_blank" rel="noreferrer">{repo}</a></div>
          <p className="ms-now">
            {all == null ? "Reading the tickets…" : open.length === 0 ? "Nothing is open. A new ask starts as a ticket." : <><em>{open.length} open.</em> {working.length + inPr.length} in work, {look.length} wait for your look, {merged.length} merged.</>}
          </p>
          <p className="ms-idea">Each ask here is a ticket. The crew works it on a branch, it comes back as a pull request, and its merge closes the ticket.</p>
        </div>
        <a className="btn-ghost" href={`#/p/${p.id}/tickets`}>Open all tickets</a>
      </section>
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
