import { useEffect, useState } from "react";
import { API } from "./api";
import { ticketsApi } from "./Tickets";
import { showTicket } from "./BugReport";

/**
 * Not every idea is a project. Before "Create project" or "Build it" makes a
 * new one, the core reads the words; when they sound like an ask about a
 * project you have (SoftwareFactory itself included), this card offers a
 * ticket there instead. It only offers: "Start a new project" is one tap.
 */

export interface IntakeVerdict { verdict: "project" | "ask"; projectId?: number; projectName?: string; kind?: string; why?: string; confidence?: "high" | "low"; existing?: { id: number; title: string; status: string } }
export interface TurnedIntoTicket { ticket: { id: number; project: number | null }; from: number; to: number; moved: number }

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? `${path} failed`);
  return j as T;
}

export const intakeApi = {
  check: (text: string, exclude?: number) => post<IntakeVerdict>("/api/tickets/intake", { text, exclude }),
  /** Turn a project into a ticket on another (SoftwareFactory's own project when `to` is left out). */
  turn: (projectId: number, to?: number, kind?: string) => post<TurnedIntoTicket>(`/api/tickets/from-project/${projectId}`, { to, kind }),
  self: async () => ((await (await fetch(`${API}/api/tickets/self`)).json()) as { projectId: number }).projectId,
};

/** Ask the core before making a project; null means go ahead. Never blocks on an error: a failed check is a new project. */
export async function checkIntake(text: string, exclude?: number): Promise<IntakeVerdict | null> {
  try { const v = await intakeApi.check(text, exclude); return v.verdict === "ask" && v.projectId != null ? v : null; } catch { return null; }
}

/** The choice: a ticket on the project it is about, or a new project anyway. */
export function AskNotProject({ text, verdict, onProject, onFiled, onCancel }: {
  text: string; verdict: IntakeVerdict; onProject: () => void; onFiled: (ticket: number, project: number | null) => void; onCancel: () => void;
}) {
  const [kind, setKind] = useState(verdict.kind ?? "request");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const file = async () => {
    setBusy(true); setErr(null);
    try {
      const t = await ticketsApi.open({ kind: kind as any, title: text.split("\n")[0], body: text, project: verdict.projectId ?? null });
      onFiled(t.id, verdict.projectId ?? null);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="intake-card" role="alertdialog" aria-label="This sounds like an ask">
      <p><strong>This sounds like {kind === "bug" ? "a bug in" : "an ask about"} {verdict.projectName}</strong>, not a new project. {verdict.why}</p>
      {verdict.existing ? (
        <div className="row">
          <span>It is already filed there as #{verdict.existing.id} ({verdict.existing.status.replace("_", " ")}).</span>
          <button onClick={() => onFiled(verdict.existing!.id, verdict.projectId ?? null)}>Open #{verdict.existing.id}</button>
          <button className="ghost" onClick={file} disabled={busy}>File it again</button>
          <button className="ghost" onClick={onCancel}>Cancel</button>
        </div>
      ) : (
      <div className="row">
        <button onClick={file} disabled={busy}>{busy ? "Filing…" : `File as a ${kind} on ${verdict.projectName}`}</button>
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Ticket kind">
          {["request", "bug", "task", "idea", "question"].map((k) => <option key={k}>{k}</option>)}
        </select>
        <button className="ghost" onClick={onProject} disabled={busy}>Start a new project anyway</button>
        <button className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
      )}
      {err && <p className="alert-text">{err}</p>}
    </div>
  );
}

/** On a project that reads like an ask: say so, and offer to turn it into a ticket where it belongs. */
export function AskBanner({ projectId, name, hasRuns, archived }: { projectId: number; name: string; hasRuns: boolean; archived: boolean }) {
  const [v, setV] = useState<IntakeVerdict | null>(null);
  const keepKey = `sf.keepProject.${projectId}`;
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(keepKey) === "1"; } catch { return false; } });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (hasRuns || archived) return;
    let live = true;
    checkIntake(name, projectId).then((x) => { if (live) setV(x && x.projectId !== projectId ? x : null); });
    return () => { live = false; };
  }, [projectId, name, hasRuns, archived]);
  if (!v || hidden) return null;
  const turn = async () => {
    setBusy(true); setErr(null);
    try { const r = await intakeApi.turn(projectId, v.projectId, v.kind); showTicket(r.ticket.id, r.to); } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <div className="intake-card banner" role="note">
      <p><strong>This reads like {v.kind === "bug" ? "a bug in" : "an ask about"} {v.projectName}</strong> more than a project of its own. Turning it into a ticket there keeps its description and notes, moves its things along, and archives this project.</p>
      <div className="row">
        <button onClick={turn} disabled={busy}>{busy ? "Turning…" : `Turn into a ticket on ${v.projectName}`}</button>
        <button className="ghost" onClick={() => { setHidden(true); try { localStorage.setItem(keepKey, "1"); } catch { /* private window */ } }}>Keep it a project</button>
      </div>
      {err && <p className="alert-text">{err}</p>}
    </div>
  );
}

/** Settings › Turn into a ticket: any project but SoftwareFactory's own can become a ticket on another. */
export function TurnIntoTicket({ projectId, name }: { projectId: number; name: string }) {
  const [projects, setProjects] = useState<{ id: number; name: string; status: string }[]>([]);
  const [to, setTo] = useState<number | "">("");
  const [kind, setKind] = useState("request");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([fetch(`${API}/api/projects`).then((r) => r.json()), intakeApi.self()]).then(([list, self]) => {
      if (!live) return;
      const ps = (list as { id: number; name: string; status: string }[]).filter((x) => x.id !== projectId && x.status !== "archived");
      setProjects(ps);
      setTo(ps.some((x) => x.id === self) ? self : ps[0]?.id ?? "");
    }).catch((e) => setErr((e as Error).message));
    return () => { live = false; };
  }, [projectId]);
  const target = projects.find((x) => x.id === to);
  const turn = async () => {
    if (to === "") return;
    setBusy(true); setErr(null);
    try { const r = await intakeApi.turn(projectId, to, kind); showTicket(r.ticket.id, r.to); } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <fieldset className="turn-ticket">
      <legend>Turn into a ticket</legend>
      <p className="muted small">When "{name}" is really an ask about another project, make it a ticket there. Its description and notes go into the ticket, its runs and tickets move along, and this project is archived with a pointer to the ticket.</p>
      <div className="row">
        <label>A
          <select value={kind} onChange={(e) => setKind(e.target.value)}>{["request", "task", "idea", "bug", "plan"].map((k) => <option key={k}>{k}</option>)}</select>
        </label>
        <label>on
          <select value={to} onChange={(e) => setTo(e.target.value === "" ? "" : Number(e.target.value))}>
            {projects.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
        <button type="button" disabled={busy || to === ""} onClick={turn}>{busy ? "Turning…" : `Turn into a ${kind}${target ? ` on ${target.name}` : ""}`}</button>
      </div>
      {err && <p className="alert-text">{err}</p>}
    </fieldset>
  );
}
