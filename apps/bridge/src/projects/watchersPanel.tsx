import { useEffect, useState } from "react";
import { watchApi, type WatcherView } from "../api";
import { showTicket } from "../BugReport";
import { registerProjectPanel, type PanelContext } from "./panels";

const EVERY: { h: number; label: string }[] = [{ h: 6, label: "every 6 hours" }, { h: 24, label: "daily" }, { h: 168, label: "weekly" }, { h: 720, label: "monthly" }];
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "–");

/**
 * Watchers: scheduled looks at this project that only open tickets (core: watch/watchers.ts). Free: plain code,
 * no agent. A ticket a watcher opens is "open", so the crew leaves it until you make it ready.
 */
function WatchersPanel({ project }: PanelContext) {
  const [list, setList] = useState<WatcherView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { watchApi.watchers(project.id).then((j) => setList(j.watchers)).catch((e) => setErr(String(e.message ?? e))); }, [project.id]);
  const act = async (k: string, fn: () => Promise<{ watchers: WatcherView[]; note?: string }>) => {
    setBusy(k); setErr(null); setNote(null);
    try { const j = await fn(); setList(j.watchers); if (j.note) setNote(j.note); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  if (!list) return err ? <div className="err">{err}</div> : <div className="muted pad">Reading the watchers…</div>;
  return (
    <div className="watchers">
      <p className="muted">Watchers look at this project on a schedule and only open tickets: they never change code, start the crew or spend money. The same finding is filed once. Their tickets wait as "open" until you make them ready.</p>
      {err && <div className="err" role="alert">{err}</div>}
      {note && <p className="small" role="status">{note}</p>}
      <div className="watcher-list">
        {list.map((w) => (
          <article key={w.kind} className={`watcher${w.on ? "" : " off"}`}>
            <header>
              <label className="switch"><input type="checkbox" checked={w.on} disabled={!!busy} onChange={(e) => act(`on${w.kind}`, () => watchApi.setWatcher(project.id, w.kind, { on: e.target.checked }))} /> <b>{w.label}</b></label>
              <select aria-label={`How often ${w.label} looks`} value={w.everyHours} disabled={!!busy || !w.on} onChange={(e) => act(`every${w.kind}`, () => watchApi.setWatcher(project.id, w.kind, { everyHours: Number(e.target.value) }))}>
                {[...EVERY, ...(EVERY.some((x) => x.h === w.everyHours) ? [] : [{ h: w.everyHours, label: `every ${w.everyHours} hours` }])].map((x) => <option key={x.h} value={x.h}>{x.label}</option>)}
              </select>
              <button type="button" className="tiny ghost" disabled={!!busy || !!w.blocked} onClick={() => act(`run${w.kind}`, () => watchApi.runWatcher(project.id, w.kind))}>{busy === `run${w.kind}` ? "Looking…" : "Look now"}</button>
            </header>
            <p className="muted small">{w.text}</p>
            {w.blocked ? <p className="small warn">{w.blocked}</p> : (
              <p className="small">
                {w.lastAt ? `Last look ${when(w.lastAt)}${w.last ? `: ${w.last.note}` : ""}${w.on && w.nextAt ? ` · next ${when(w.nextAt)}` : ""}` : w.on ? "Not looked yet: the first look comes within half an hour, or press Look now." : "Not looked yet."}
                {w.last && w.last.opened.length > 0 && <> {w.last.opened.map((id) => <button key={id} type="button" className="tiny ghost" onClick={() => showTicket(id, project.id)}>#{id}</button>)}</>}
              </p>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}

registerProjectPanel({ id: "watchers", section: "improve", title: "Watchers", order: 40, render: (c) => <WatchersPanel key={c.project.id} {...c} /> });
