import { useCallback, useEffect, useState } from "react";
import { API } from "../api";
import { EmptyState } from "../ui";
import { registerProjectPanel, type PanelContext } from "./panels";

/**
 * Git: where this project's code lives and how it moves (docs/git.md). A new project stays on this
 * computer until it is worth continuing; Continue makes a private GitHub repo. The merge policy says
 * whether SF asks before merging a crew PR or merges a confident one by itself. Merged tickets become
 * versions with release notes, on a timeline.
 */
interface VersionTicket { id: number; key: string; kind: string; title: string; source?: string | null; pr?: number | null }
interface VersionView { version: string; sha: string | null; notes: string; tickets: number[]; url: string | null; at: string; by: string }
export interface ProjectGit {
  projectId: number; name: string; where: "github" | "local" | "none"; repo: string | null; url: string | null; private: boolean | null; localDir: string | null; publishedAt: string | null;
  verdict: { verdict: "continue" | "park" | "drop"; why: string; at: string } | null;
  policy: "ask" | "auto"; streak: number; merges: number; offerAuto: boolean; watchedAt: string | null;
  versions: VersionView[]; next: { version: string; bump: string; tickets: VersionTicket[]; notes: string } | null; cannotPublish: string | null;
}

const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const VERDICT: Record<string, string> = { continue: "Continue", park: "Parked", drop: "Dropped" };

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `The core said ${r.status}`);
  return j as T;
}

function GitPanel({ project, events }: PanelContext) {
  const [g, setG] = useState<ProjectGit | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [why, setWhy] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await fetch(`${API}/api/git/projects/${project.id}`);
    const j = await r.json().catch(() => ({}));
    if (r.ok) setG(j as ProjectGit); else setErr(j.error ?? "Could not read this project's git.");
  }, [project.id]);
  // Read again when a git event of this project arrives.
  const last = events.filter((e) => /^(project\.(published|verdict|mergepolicy|version)|repo\.watched|ticket\.(mergecheck|pr))$/.test(e.type)).at(-1)?.id ?? 0;
  useEffect(() => { void load(); }, [load, last]);
  const act = async (what: string, path: string, body: unknown = {}) => {
    setBusy(what); setErr(null);
    try { const j = await post<any>(path, body); setG(j.git ?? (j.projectId ? j : null) ?? g); if (!j.projectId && !j.git) await load(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };
  if (!g) return err ? <EmptyState title="Git is not available">{err}</EmptyState> : <p className="muted pad">Reading where the code lives…</p>;
  const base = `/api/git/projects/${project.id}`;

  return (
    <div className="git-panel">
      <section className="git-where">
        <h3>Where the code lives</h3>
        {g.where === "github" ? (
          <p><span className="pill ok">{g.private === false ? "Public repo" : "Private repo"}</span> <a href={g.url ?? "#"} target="_blank" rel="noreferrer">{g.repo}</a>
            {g.publishedAt && <span className="muted"> · published {when(g.publishedAt)}</span>}</p>
        ) : g.where === "local" ? (
          <>
            <p><span className="pill">On this computer</span> <code>{g.localDir}</code></p>
            <p className="muted">It stays here until you judge it worth continuing. Continue makes a private GitHub repo and sends the code; from then on each ticket is a branch and a PR there.</p>
            <label className="git-why">Why (kept with the verdict)<input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Optional: what made you decide" /></label>
            <div className="row">
              <button type="button" disabled={!!busy || !!g.cannotPublish} title={g.cannotPublish ?? undefined} onClick={() => act("continue", `${base}/verdict`, { verdict: "continue", why })}>{busy === "continue" ? "Making the repo…" : "Continue: make a private repo"}</button>
              <button type="button" className="ghost" disabled={!!busy} onClick={() => act("park", `${base}/verdict`, { verdict: "park", why })}>Park</button>
              <button type="button" className="ghost" disabled={!!busy} onClick={() => act("drop", `${base}/verdict`, { verdict: "drop", why })}>Drop</button>
            </div>
            {g.cannotPublish && <p className="muted">{g.cannotPublish}</p>}
          </>
        ) : <p className="muted">No code yet. Build it first; it stays on this computer until you continue it.</p>}
        {g.verdict && <p className="muted">Verdict: <b>{VERDICT[g.verdict.verdict]}</b>{g.verdict.why ? `, ${g.verdict.why}` : ""} ({when(g.verdict.at)})</p>}
      </section>

      {g.where === "github" && (
        <section className="git-policy">
          <h3>Merging</h3>
          <div className="seg" role="radiogroup" aria-label="Merge policy">
            <button type="button" role="radio" aria-checked={g.policy === "ask"} className={g.policy === "ask" ? "on" : ""} disabled={!!busy} onClick={() => g.policy !== "ask" && act("policy", `${base}/policy`, { mode: "ask" })}>Ask me</button>
            <button type="button" role="radio" aria-checked={g.policy === "auto"} className={g.policy === "auto" ? "on" : ""} disabled={!!busy} onClick={() => g.policy !== "auto" && act("policy", `${base}/policy`, { mode: "auto" })}>Merge confident PRs</button>
          </div>
          <p className="muted">{g.policy === "ask"
            ? "A crew PR that passed CI waits on Needs you with SF's review beside it. You press Merge."
            : "SF merges a crew PR by itself when CI passed and every line of its review passed. Anything less waits on Needs you."}</p>
          <p>{g.streak} right merge{g.streak === 1 ? "" : "s"} in a row · {g.merges} merged through SF</p>
          {g.offerAuto && <p className="git-offer">The last {g.streak} confident merges were right. You can let SF merge confident PRs by itself.</p>}
        </section>
      )}

      <section className="git-versions">
        <div className="git-head">
          <h3>Versions</h3>
          {g.where === "github" && <button type="button" className="tiny ghost" disabled={!!busy} onClick={() => act("watch", `${base}/watch`)}>{busy === "watch" ? "Reading…" : "Look for outside work"}</button>}
        </div>
        {g.next ? (
          <div className="git-next">
            <p><b>{g.next.version}</b> is ready: {g.next.tickets.length} merged ticket{g.next.tickets.length === 1 ? "" : "s"} not in a version yet.</p>
            <pre className="git-notes">{g.next.notes}</pre>
            <button type="button" disabled={!!busy || g.where === "none"} onClick={() => act("cut", `${base}/versions`)}>{busy === "cut" ? "Tagging…" : `Cut ${g.next.version}`}</button>
            <span className="muted"> {g.where === "github" ? "Makes a GitHub release with these notes on the newest commit of main." : "Tags the folder on this computer."}</span>
          </div>
        ) : <p className="muted">Nothing merged since {g.versions[0]?.version ?? "the start"}.</p>}
        {g.versions.length > 0 && (
          <ol className="git-timeline">
            {g.versions.map((v) => (
              <li key={v.version}>
                <button type="button" className="git-ver" aria-expanded={open === v.version} onClick={() => setOpen(open === v.version ? null : v.version)}>
                  <b>{v.version}</b> <span className="muted">{when(v.at)} · {v.tickets.length} ticket{v.tickets.length === 1 ? "" : "s"}{v.sha ? ` · ${v.sha.slice(0, 7)}` : ""}</span>
                </button>
                {v.url && <a href={v.url} target="_blank" rel="noreferrer" className="tiny">Release</a>}
                {open === v.version && <pre className="git-notes">{v.notes}</pre>}
              </li>
            ))}
          </ol>
        )}
      </section>
      {err && <p className="error" role="alert">{err}</p>}
    </div>
  );
}

registerProjectPanel({
  id: "git", section: "ship", title: "Git", order: 35,
  render: (c) => <GitPanel key={c.project.id} {...c} />,
});
