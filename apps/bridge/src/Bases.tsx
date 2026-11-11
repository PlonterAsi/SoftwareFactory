import { useEffect, useState, type FormEvent } from "react";
import { API } from "./api";
import { ago } from "./projects/builtin";

/** A factory this app hosts: one folder, its own database, projects, plugins and crew. */
export interface BaseCardView {
  id: number;
  name: string;
  folder: string;
  status: "active" | "archived";
  isDefault: boolean;
  createdAt: string;
  lastOpenedAt: string | null;
  current: boolean;
  reachable: boolean;
  stats: { projects: number; runs: number; signals: number; events: number; spentUsd: number; lastActivity: string | null } | null;
}
export interface BasesView { current: number; home: string; bases: BaseCardView[]; activeRuns: number }
interface BrowseView { path: string | null; parent: string | null; dirs: { name: string; path: string; base: string | null }[]; places: { name: string; path: string }[] }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}/api/bases${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `The core said ${r.status}`);
  return j as T;
}
export const basesApi = {
  list: () => call<BasesView>("GET", ""),
  create: (name: string, folder: string | undefined, open: boolean) => call<BasesView & { adopted: boolean }>("POST", "", { name, folder, open }),
  open: (id: number) => call<BasesView>("POST", `/${id}/open`),
  rename: (id: number, name: string) => call<BasesView>("POST", `/${id}`, { name }),
  archive: (id: number, archived: boolean) => call<BasesView>("POST", `/${id}/archive`, { archived }),
  reveal: (id: number) => call<{ ok: true }>("POST", `/${id}/reveal`),
  suggest: (name: string) => call<{ folder: string }>("GET", `/suggest?name=${encodeURIComponent(name)}`),
  browse: (path?: string) => call<BrowseView>("GET", `/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`),
};

/** The open base, for the top bar. Older cores without bases answer 404: then there is no chip. */
export function useBases(online: boolean) {
  const [data, setData] = useState<BasesView | null>(null);
  const refresh = () => basesApi.list().then(setData).catch(() => setData(null));
  useEffect(() => { if (online) refresh(); }, [online]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, refresh, current: data?.bases.find((b) => b.current) ?? null };
}

/** After a switch everything on screen belongs to the other base: start the Bridge fresh on its projects. */
function reloadInto() {
  location.hash = "#/";
  location.reload();
}

/**
 * Bases: the factories this app hosts, like save slots. Each card peeks inside its
 * database (projects, runs, spend, last activity). Open one to load it; make a new
 * one to start a fresh factory in its own folder. Nothing here deletes files.
 */
export function BasesPage({ bases, refresh }: { bases: BasesView | null; refresh: () => void }) {
  const [show, setShow] = useState<"active" | "archived">("active");
  const [err, setErr] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const list = (bases?.bases ?? []).filter((b) => b.status === show);
  const archived = (bases?.bases ?? []).filter((b) => b.status === "archived").length;

  const act = async (f: () => Promise<unknown>) => {
    setErr(null);
    try { await f(); refresh(); } catch (e) { setErr((e as Error).message); }
  };
  const open = async (b: BaseCardView) => {
    setErr(null); setSwitching(b.name);
    try { await basesApi.open(b.id); reloadInto(); } catch (e) { setSwitching(null); setErr((e as Error).message); }
  };

  return (
    <section className="pane fleet bases" aria-label="Bases">
      <header className="fleet-head">
        <div>
          <h1>Bases</h1>
          <p className="muted">Each base is a whole factory in its own folder, with its own projects, plugins, agents and crew. One is open at a time.</p>
        </div>
        <button onClick={() => setCreating(true)}>New base</button>
      </header>
      <div className="fleet-tools">
        <div className="seg" role="tablist" aria-label="Which bases">
          <button role="tab" aria-selected={show === "active"} className={show === "active" ? "on" : ""} onClick={() => setShow("active")}>Bases</button>
          <button role="tab" aria-selected={show === "archived"} className={show === "archived" ? "on" : ""} onClick={() => setShow("archived")}>Archived{archived ? ` · ${archived}` : ""}</button>
        </div>
        {bases && bases.activeRuns > 0 && <span className="muted">{bases.activeRuns} run{bases.activeRuns > 1 ? "s" : ""} working here: switching waits until {bases.activeRuns > 1 ? "they finish" : "it finishes"}.</span>}
      </div>
      {err && <div className="err bases-err" role="alert">{err}</div>}
      {!bases ? <div className="empty">Reading your bases…</div>
        : !list.length ? <div className="fleet-empty"><p>{show === "archived" ? "Nothing archived." : "No bases."}</p></div>
        : <div className="base-grid">{list.map((b) => <BaseCard key={b.id} b={b} busy={!!switching} onOpen={() => open(b)} act={act} />)}</div>}
      {creating && <NewBase onClose={() => setCreating(false)} onMade={(opened) => { setCreating(false); if (opened) reloadInto(); else refresh(); }} onSwitching={setSwitching} />}
      {switching && <div className="scrim solid base-loading" role="status"><div><span className="logo" aria-hidden>◈</span> Opening {switching}…</div></div>}
    </section>
  );
}

function BaseCard({ b, busy, onOpen, act }: { b: BaseCardView; busy: boolean; onOpen: () => void; act: (f: () => Promise<unknown>) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(b.name);
  const s = b.stats;
  const rename = (e: FormEvent) => { e.preventDefault(); if (name.trim()) act(() => basesApi.rename(b.id, name.trim())).then(() => setEditing(false)); };
  return (
    <article className={`base-card${b.current ? " current" : ""}${b.status === "archived" ? " archived" : ""}${b.reachable ? "" : " lost"}`} aria-label={b.name}>
      <div className="base-emblem" aria-hidden>{b.name.slice(0, 1).toUpperCase()}</div>
      <div className="base-body">
        {editing
          ? <form className="base-rename" onSubmit={rename}><input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label="Base name" /><button className="sm" disabled={!name.trim()}>Save</button><button type="button" className="ghost sm" onClick={() => { setEditing(false); setName(b.name); }}>Cancel</button></form>
          : <h2>{b.name} {b.current && <span className="base-tag">Open now</span>}{b.isDefault && <span className="base-tag dim">Main</span>}</h2>}
        <code className="place-path">{b.folder}</code>
        {!b.reachable
          ? <p className="err">This folder cannot be found. Was a drive removed or the folder moved? Put it back to open this base.</p>
          : s ? <p className="base-stats"><span><b>{s.projects}</b> projects</span><span><b>{s.runs}</b> runs</span><span><b>{s.signals}</b> signals</span><span><b>${s.spentUsd.toFixed(2)}</b> spent</span></p>
          : <p className="muted">Could not read inside this base.</p>}
        <p className="muted base-when">{s?.lastActivity ? `Last activity ${ago(s.lastActivity)}` : "Nothing built yet"}{b.lastOpenedAt && !b.current ? ` · opened ${ago(b.lastOpenedAt)}` : ""}</p>
      </div>
      <div className="base-actions">
        {b.status === "active" && !b.current && <button disabled={busy || !b.reachable} onClick={onOpen}>Open</button>}
        {!editing && <button className="ghost sm" onClick={() => setEditing(true)}>Rename</button>}
        <button className="ghost sm" disabled={!b.reachable} onClick={() => act(() => basesApi.reveal(b.id))}>Show folder</button>
        {!b.current && !b.isDefault && <button className="ghost sm" onClick={() => act(() => basesApi.archive(b.id, b.status === "active"))}>{b.status === "active" ? "Archive" : "Bring back"}</button>}
      </div>
    </article>
  );
}

/** Start a new base: a name, and a folder (suggested, or picked with the folder picker). */
function NewBase({ onClose, onMade, onSwitching }: { onClose: () => void; onMade: (opened: boolean) => void; onSwitching: (name: string | null) => void }) {
  const [name, setName] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [suggested, setSuggested] = useState("");
  const [openNow, setOpenNow] = useState(true);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => basesApi.suggest(name.trim() || "New base").then((r) => setSuggested(r.folder)).catch(() => {}), 150);
    return () => clearTimeout(t);
  }, [name]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && !picking && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose, picking]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true); setErr(null);
    if (openNow) onSwitching(name.trim());
    try { await basesApi.create(name.trim(), folder ?? undefined, openNow); onMade(openNow); }
    catch (x) { onSwitching(null); setErr((x as Error).message); setBusy(false); }
  };
  return (
    <div className="scrim solid" onClick={onClose}>
      <form className="picker base-new" role="dialog" aria-modal="true" aria-label="New base" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="setup-kicker mono">NEW BASE</div>
        <h2>Start a new factory</h2>
        <p className="muted">It starts empty: its own projects, chats, agents, plugins and crew. Your other bases stay exactly as they are.</p>
        <label className="base-field"><span>Name</span><input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Games lab" maxLength={60} /></label>
        <div className="base-field">
          <span>Folder</span>
          <code className="place-path">{folder ?? suggested}</code>
          <span className="base-folder-actions">
            <button type="button" className="ghost sm" onClick={() => setPicking(true)}>Choose another folder…</button>
            {folder && <button type="button" className="link" onClick={() => setFolder(null)}>Use the suggested one</button>}
          </span>
          <span className="muted base-hint">{folder ? "A folder that already holds a base (factory.db) is added as it is." : "Made for you inside SoftwareFactory's own data folder."}</span>
        </div>
        <label className="base-check"><input type="checkbox" checked={openNow} onChange={(e) => setOpenNow(e.target.checked)} /> Open it right away</label>
        {err && <div className="err" role="alert">{err}</div>}
        <div className="base-new-actions">
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={!name.trim() || busy}>{busy ? "Making…" : openNow ? "Create and open" : "Create base"}</button>
        </div>
        {picking && <FolderPicker start={folder ?? undefined} newName={name.trim()} onPick={(p) => { setFolder(p); setPicking(false); }} onClose={() => setPicking(false)} />}
      </form>
    </div>
  );
}

/** Walk the computer's folders; no typing paths, no system dialog needed. */
function FolderPicker({ start, newName, onPick, onClose }: { start?: string; newName: string; onPick: (path: string) => void; onClose: () => void }) {
  const [view, setView] = useState<BrowseView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [paste, setPaste] = useState("");
  const go = (p?: string) => basesApi.browse(p).then((v) => { setView(v); setErr(null); }).catch((e) => setErr((e as Error).message));
  useEffect(() => { basesApi.browse().then((v) => go(start ?? v.places[0]?.path)).catch((e) => setErr((e as Error).message)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const slug = (newName || "New base").replace(/[<>:"/\\|?*]+/g, "").trim() || "New base";
  const sep = view?.path?.includes("\\") ? "\\" : "/";
  const inside = view?.path ? `${view.path.replace(/[\\/]+$/, "")}${sep}${slug}` : null;
  return (
    <div className="scrim solid" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="picker folder-picker" role="dialog" aria-modal="true" aria-label="Choose a folder" onClick={(e) => e.stopPropagation()}>
        <div className="fp-head"><h3>Choose a folder</h3><button type="button" className="ghost sm" onClick={onClose}>Close</button></div>
        <div className="fp-places">{view?.places.map((p) => <button type="button" key={p.path} className="ghost sm" onClick={() => go(p.path)}>{p.name}</button>)}</div>
        <div className="fp-path">
          <button type="button" className="ghost sm" disabled={!view?.parent} onClick={() => go(view?.parent ?? undefined)} aria-label="Up one folder">↑ Up</button>
          <code className="place-path">{view?.path ?? "…"}</code>
        </div>
        {err && <div className="err" role="alert">{err}</div>}
        <ul className="fp-list">
          {view?.dirs.length === 0 && <li className="muted fp-none">No folders inside.</li>}
          {view?.dirs.map((d) => (
            <li key={d.path}><button type="button" className="fp-dir" onClick={() => go(d.path)}><span aria-hidden>▸</span> {d.name}{d.base && <span className="base-tag dim">base: {d.base}</span>}</button></li>
          ))}
        </ul>
        <div className="fp-actions">
          {inside && <button type="button" onClick={() => onPick(inside)} title={inside}>New folder here: {slug}</button>}
          {view?.path && <button type="button" className="ghost" onClick={() => onPick(view.path!)}>Use this folder</button>}
        </div>
        <details className="fp-paste"><summary className="muted">Paste a path instead</summary>
          <div className="place-edit"><input value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="D:\Factories\Games" aria-label="Folder path" /><button type="button" className="sm" disabled={!paste.trim()} onClick={() => onPick(paste.trim())}>Use it</button></div>
        </details>
      </div>
    </div>
  );
}
