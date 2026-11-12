import { useEffect, useState } from "react";
import { setupApi, type CrewMode, type SetupView, type ToolCheck } from "./api";
import { UpdatesSection, type Updates } from "./Updates";
import type { Layout } from "./shell/prefs";

/**
 * Ship's systems: which crew works (free practice crew or real Claude Code
 * agents), what this computer has, and where everything lands on disk.
 * Every check is free; nothing here calls a model.
 */
export function Setup({ open, onClose, dropsAt, updates, layout, onLayout }: { open: boolean; onClose: () => void; dropsAt: number; updates?: Updates; layout?: Layout; onLayout?: (l: Layout) => void }) {
  const [s, setS] = useState<SetupView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dropDir, setDropDir] = useState("");
  const [editDrop, setEditDrop] = useState(false);

  const load = async (fresh = false) => {
    setBusy(true);
    try { const v = await setupApi.get(fresh); setS(v); setDropDir(v.paths.drop); setErr(null); } catch (e) { setErr("The core is not answering. " + (e as Error).message); } finally { setBusy(false); }
  };
  useEffect(() => { if (open) load(true); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // Keep the drop list fresh while open.
  useEffect(() => { if (open && s) setupApi.get().then(setS).catch(() => {}); }, [dropsAt]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);

  const act = async (f: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await f(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const pick = (mode: CrewMode) => act(async () => setS(await setupApi.mode(mode)));
  const open_ = (t: "projects" | "drop" | "data") => act(() => setupApi.open(t));
  const saveDrop = () => act(async () => { await setupApi.drop(dropDir.trim()); setEditDrop(false); await load(); });

  if (!open) return null;
  return (
    <div className="scrim" onClick={onClose}>
      <aside className="setup" role="dialog" aria-modal="true" aria-label="Systems" onClick={(e) => e.stopPropagation()}>
        <header className="setup-head">
          <div>
            <div className="setup-kicker">Systems</div>
            <h2>Who builds, and where it lands</h2>
          </div>
          <button className="ghost" onClick={onClose} aria-label="Close">Close</button>
        </header>
        {!s ? <div className="empty">{err ?? "Checking this computer…"}</div> : <>
          <section className="setup-sec">
            <h3>Crew</h3>
            <div className="crew-modes">
              <button className={`mode-card${s.mode === "practice" ? " on" : ""}`} disabled={busy} onClick={() => pick("practice")} aria-pressed={s.mode === "practice"}>
                <span className="mode-name">Practice crew</span>
                <span className="mode-tag mono">free · no AI</span>
                <span className="mode-body">Canned agents walk the whole loop so you can learn the Bridge. Whatever you type, they build the same small word counter, with one planted bug for the Fixer.</span>
              </button>
              <button className={`mode-card real${s.mode === "real" ? " on" : ""}`} disabled={busy || !s.claude.found} onClick={() => pick("real")} aria-pressed={s.mode === "real"}>
                <span className="mode-name">Real crew</span>
                <span className="mode-tag mono">Claude Code · capped</span>
                <span className="mode-body">Your idea, really built: Claude agents plan, write tests, code, review and fix. Uses your Claude Code sign-in. Every call and every run has a hard spend cap (default $1.50 a run).</span>
                {!s.claude.found && <span className="mode-need">Needs Claude Code, see below.</span>}
              </button>
            </div>
          </section>

          {onLayout && (
            <section className="setup-sec">
              <h3>Layout</h3>
              <div className="crew-modes">
                <button className={`mode-card${layout !== "foundry" ? " on" : ""}`} onClick={() => onLayout("classic")} aria-pressed={layout !== "foundry"}>
                  <span className="mode-name">Classic</span>
                  <span className="mode-tag">old top bar</span>
                  <span className="mode-body">Pages along the top, the Assistant always on the right.</span>
                </button>
                <button className={`mode-card${layout === "foundry" ? " on" : ""}`} onClick={() => onLayout("foundry")} aria-pressed={layout === "foundry"}>
                  <span className="mode-name">Foundry Glass</span>
                  <span className="mode-tag">new · default</span>
                  <span className="mode-body">A sidebar with Needs you and recent projects, Ctrl K to file, build or go anywhere, Ctrl J to show or hide the Assistant.</span>
                </button>
              </div>
            </section>
          )}

          <section className="setup-sec">
            <h3>This computer <button className="link" disabled={busy} onClick={() => load(true)}>{busy ? "checking…" : "Check again"}</button></h3>
            <Check name="Node.js" c={{ found: s.node.ok, version: `v${s.node.version}`, path: s.node.path, hint: s.node.ok ? "Runs the factory's core and the tests it writes." : "Node 22.5 or newer is needed." }} />
            <Check name="Claude Code" c={s.claude} />
            <Check name="Git" c={s.git} />
            {s.blocker && <p className="setup-blocker">{s.blocker}</p>}
          </section>

          <section className="setup-sec">
            <h3>Where things land</h3>
            <Place label="Built apps" hint="Every shipped app is a git repo here, one folder per run." path={s.paths.projects} onOpen={() => open_("projects")} />
            <div className="place">
              <div className="place-top">
                <span className="place-label">Drop folder</span>
                <span className="place-actions">
                  <button className="ghost sm" onClick={() => open_("drop")}>Open</button>
                  <button className="ghost sm" onClick={() => setEditDrop(!editDrop)}>{editDrop ? "Cancel" : "Change"}</button>
                </span>
              </div>
              <div className="place-hint">Save a .txt or .md note here, even from your phone, and it becomes a note within seconds. Point it at a OneDrive or Google Drive folder to capture ideas away from the desk.</div>
              {editDrop
                ? <div className="place-edit"><input value={dropDir} onChange={(e) => setDropDir(e.target.value)} aria-label="Drop folder path" /><button className="sm" disabled={busy || !dropDir.trim()} onClick={saveDrop}>Use this folder</button></div>
                : <code className="place-path">{s.paths.drop}</code>}
              {s.drops.length > 0 && (
                <ul className="drops">
                  {s.drops.slice(0, 5).map((d) => (
                    <li key={d.id} className={d.status}><span className="mono">{new Date(d.ts).toLocaleString()}</span> {d.file} <span className="muted">{d.status === "filed" ? "· captured" : `· ${d.note ?? "skipped"}`}</span></li>
                  ))}
                </ul>
              )}
            </div>
            <Place label="Database" hint="factory.db: the event log and every table. Open it in any SQLite browser." path={s.paths.data} onOpen={() => open_("data")} />
          </section>
          {updates && <UpdatesSection u={updates} />}
          {err && <div className="err">{err}</div>}
        </>}
      </aside>
    </div>
  );
}

function Check({ name, c }: { name: string; c: ToolCheck }) {
  return (
    <div className={`check ${c.found ? "ok" : "no"}`}>
      <span className="check-mark" aria-hidden>{c.found ? "✓" : "✕"}</span>
      <div>
        <div><strong>{name}</strong> <span className="mono muted">{c.found ? c.version ?? "found" : "not found"}</span></div>
        <div className="check-hint">{c.hint}</div>
      </div>
    </div>
  );
}

function Place({ label, hint, path, onOpen }: { label: string; hint: string; path: string; onOpen: () => void }) {
  return (
    <div className="place">
      <div className="place-top"><span className="place-label">{label}</span><span className="place-actions"><button className="ghost sm" onClick={onOpen}>Open</button><button className="ghost sm" onClick={() => navigator.clipboard?.writeText(path)}>Copy path</button></span></div>
      <div className="place-hint">{hint}</div>
      <code className="place-path">{path}</code>
    </div>
  );
}
