import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { API, launchApi, type LaunchInfo, type LaunchSession, type OutputLine, type RunProfileView } from "../api";
import { registerProjectPanel, type PanelContext } from "./panels";
import { ago } from "./builtin";

/**
 * The Run tab: start a finished project from its own folder without a command line.
 * A launch pad of the ways to run it, a live console, and for anything that
 * serves pages, the page itself in a preview frame.
 */
const GLYPH: Record<RunProfileView["kind"], string> = { web: "◉", static: "▣", cli: "⌘", program: "▶" };
const KIND_LABEL: Record<RunProfileView["kind"], string> = { web: "web app", static: "pages", cli: "command-line tool", program: "program" };
const live = (s: LaunchSession) => s.state === "starting" || s.state === "running" || s.state === "serving";
const fullUrl = (u: string) => (u.startsWith("/") ? `${API || location.origin}${u}` : u);

function useLaunch(projectId: number, events: PanelContext["events"]) {
  const [info, setInfo] = useState<LaunchInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dir, setDir] = useState<string | null>(null);
  const at = useMemo(() => events.filter((e) => e.type.startsWith("launch.") || (e.type === "project.linked" && e.payload?.kind === "folder")).at(-1)?.id ?? 0, [events]);
  const reload = () => launchApi.info(projectId, dir).then((i) => { setInfo(i); setErr(null); }).catch((x) => setErr((x as Error).message));
  useEffect(() => { const t = setTimeout(reload, 120); return () => clearTimeout(t); }, [projectId, dir, at]); // eslint-disable-line react-hooks/exhaustive-deps
  return { info, err, dir: dir ?? info?.dir ?? null, setDir, reload };
}

/** Follow one session's output and state as it happens. */
function useSession(id: number | null) {
  const [session, setSession] = useState<LaunchSession | null>(null);
  const [lines, setLines] = useState<OutputLine[]>([]);
  useEffect(() => {
    setSession(null); setLines([]);
    if (id == null) return;
    const es = new EventSource(`${API}/api/launch/sessions/${id}/stream`);
    let buf: OutputLine[] = [];
    let raf = 0;
    const flush = () => { raf = 0; const b = buf; buf = []; setLines((l) => { const next = l.concat(b); return next.length > 3000 ? next.slice(-3000) : next; }); };
    es.addEventListener("state", (e) => setSession(JSON.parse((e as MessageEvent).data)));
    es.addEventListener("line", (e) => { buf.push(JSON.parse((e as MessageEvent).data)); if (!raf) raf = requestAnimationFrame(flush); });
    es.onerror = () => {
      // Ended sessions close the stream; read what is kept instead of retrying forever.
      es.close();
      launchApi.session(id).then((r) => { setSession(r.session); setLines((l) => (l.length ? l : r.lines)); }).catch(() => {});
    };
    return () => { es.close(); if (raf) cancelAnimationFrame(raf); };
  }, [id]);
  return { session, lines };
}

function RunPanel({ ctx }: { ctx: PanelContext }) {
  const pid = ctx.project.id;
  const { info, err, dir, setDir, reload } = useLaunch(pid, ctx.events);
  const [picked, setPicked] = useState<number | null>(null);
  const [args, setArgs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [actErr, setActErr] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [newDir, setNewDir] = useState("");

  // Show the newest live session on arrival, else the newest one.
  useEffect(() => {
    if (picked != null || !info) return;
    const first = info.running[0] ?? info.sessions[0];
    if (first) setPicked(first.id);
  }, [info, picked]);

  const liveByProfile = new Map((info?.running ?? []).filter((s) => s.dir === dir).map((s) => [s.profileId, s]));
  async function start(p: RunProfileView, mode: "inline" | "window" = "inline") {
    setBusy(p.id); setActErr(null);
    try {
      const s = await launchApi.start(pid, { profileId: p.id, args: args[p.id], dir: dir ?? undefined, mode });
      if (mode === "inline") setPicked(s.id);
      reload();
    } catch (x) { setActErr((x as Error).message); } finally { setBusy(null); }
  }
  async function stop(id: number) {
    try { await launchApi.stop(id); reload(); } catch (x) { setActErr((x as Error).message); }
  }
  async function addFolder(e: FormEvent) {
    e.preventDefault();
    try { await launchApi.addFolder(pid, newDir.trim()); setDir(newDir.trim()); setNewDir(""); setAddOpen(false); setActErr(null); } catch (x) { setActErr((x as Error).message); }
  }

  if (!info) return <p className={err ? "error pad" : "empty"}>{err ?? "Looking at the project folder…"}</p>;
  const folder = info.folders.find((f) => f.dir === dir);
  const main = info.profiles.filter((p) => !p.utility);
  const util = info.profiles.filter((p) => p.utility);

  return (
    <div className="rn">
      <aside className="rn-pad" aria-label="Ways to run this project">
        <section className="rn-folder">
          <h3>Folder</h3>
          {info.folders.length ? (
            <select value={dir ?? ""} onChange={(e) => { setDir(e.target.value); setPicked(null); }} aria-label="Project folder">
              {info.folders.map((f) => <option key={f.dir} value={f.dir}>{f.label}{f.exists ? "" : " (missing)"}</option>)}
            </select>
          ) : <p className="muted rn-note">This project has no folder yet. Build an idea in it, import a repo, or point it at a folder of yours.</p>}
          {dir && <p className="mono rn-path" title={dir}>{dir}</p>}
          <div className="rn-row">
            {folder?.exists && <button className="ghost sm" onClick={() => launchApi.terminal(pid, dir).catch((x) => setActErr((x as Error).message))} title="Open a terminal window in this folder">Terminal here</button>}
            <button className="ghost sm" onClick={() => setAddOpen((v) => !v)} aria-expanded={addOpen}>{addOpen ? "Cancel" : "Use another folder"}</button>
          </div>
          {addOpen && (
            <form className="rn-add" onSubmit={addFolder}>
              <input value={newDir} onChange={(e) => setNewDir(e.target.value)} placeholder="C:\Dev\my-app" aria-label="Full folder path" autoFocus />
              <button className="sm" type="submit" disabled={!newDir.trim()}>Add</button>
            </form>
          )}
        </section>

        {folder && !info.exists && <p className="error rn-note">The folder is not on disk any more.</p>}
        {info.exists && !main.length && <p className="muted rn-note">Nothing runnable was found here: no package.json scripts, bin/ tools, index.html, or Python, Rust or Go entry point. Use Terminal here to run it your way.</p>}

        {main.length > 0 && <h3>Launch pad</h3>}
        <ul className="rn-profiles">
          {main.map((p) => <ProfileCard key={p.id} p={p} s={liveByProfile.get(p.id)} args={args[p.id] ?? ""} setArgs={(v) => setArgs((a) => ({ ...a, [p.id]: v }))}
            busy={busy === p.id} onStart={(m) => start(p, m)} onStop={stop} onShow={setPicked} picked={picked} />)}
        </ul>
        {util.length > 0 && (
          <>
            <h3>Tools</h3>
            <ul className="rn-profiles util">
              {util.map((p) => <ProfileCard key={p.id} p={p} s={liveByProfile.get(p.id)} args="" setArgs={() => {}} busy={busy === p.id} onStart={(m) => start(p, m)} onStop={stop} onShow={setPicked} picked={picked} />)}
            </ul>
          </>
        )}
        {actErr && <p className="error rn-note" role="alert">{actErr}</p>}

        {info.sessions.length > 0 && (
          <section className="rn-history">
            <h3>Recent</h3>
            <ol>
              {info.sessions.map((s) => (
                <li key={s.id}>
                  <button className={"rn-hist" + (picked === s.id ? " on" : "")} onClick={() => setPicked(s.id)}>
                    <span className={`rn-light st-${s.state}${s.exitCode ? " bad" : ""}`} aria-hidden />
                    <span className="rn-hist-label">{s.label}{s.args ? <span className="muted"> {s.args}</span> : null}</span>
                    <span className="muted">{live(s) ? s.state : s.mode === "window" ? "own window" : s.exitCode != null ? `exit ${s.exitCode}` : s.state} · {ago(s.startedAt)}</span>
                  </button>
                </li>
              ))}
            </ol>
          </section>
        )}
      </aside>
      <Stage id={picked} onStop={stop} recommended={main[0] ?? null} onStart={(p) => start(p)} />
    </div>
  );
}

function ProfileCard({ p, s, args, setArgs, busy, onStart, onStop, onShow, picked }: {
  p: RunProfileView; s?: LaunchSession; args: string; setArgs: (v: string) => void; busy: boolean;
  onStart: (mode?: "inline" | "window") => void; onStop: (id: number) => void; onShow: (id: number) => void; picked: number | null;
}) {
  const on = !!s;
  return (
    <li className={`rn-card k-${p.kind}${on ? " live" : ""}${p.recommended ? " best" : ""}${s && picked === s.id ? " shown" : ""}`}>
      <div className="rn-card-head">
        <span className="rn-glyph" aria-hidden>{GLYPH[p.kind]}</span>
        <span className="rn-card-title">{p.label}<span className="rn-kind">{KIND_LABEL[p.kind]}{p.recommended ? " · best guess" : ""}</span></span>
        {on && <span className={`rn-light st-${s!.state}`} title={s!.state} />}
      </div>
      <code className="rn-cmd">{p.command}</code>
      {p.note && <p className="rn-card-note">{p.note}</p>}
      {p.args && !on && (
        <input className="rn-args" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="arguments (optional)" aria-label={`Arguments for ${p.label}`}
          onKeyDown={(e) => { if (e.key === "Enter") onStart(); }} />
      )}
      <div className="rn-row">
        {on ? (
          <>
            <button className="sm" onClick={() => onShow(s!.id)}>Show</button>
            <button className="sm stop" onClick={() => onStop(s!.id)}>Stop</button>
          </>
        ) : (
          <>
            <button className="sm" onClick={() => onStart()} disabled={busy}>{busy ? "Starting…" : p.kind === "static" ? "Preview" : "Start"}</button>
            {p.kind !== "static" && <button className="ghost sm" onClick={() => onStart("window")} disabled={busy} title="Run it in a console window of its own (for big programs, or ones that need a real terminal)">Own window</button>}
          </>
        )}
      </div>
    </li>
  );
}

function Stage({ id, onStop, recommended, onStart }: { id: number | null; onStop: (id: number) => void; recommended: RunProfileView | null; onStart: (p: RunProfileView) => void }) {
  const { session: s, lines } = useSession(id);
  const [, tick] = useState(0);
  const [frameKey, setFrameKey] = useState(0);
  const [wide, setWide] = useState(false);
  const [showConsole, setShowConsole] = useState(true);
  const [input, setInput] = useState("");
  const [inErr, setInErr] = useState<string | null>(null);
  const consoleRef = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  useEffect(() => { if (!s || !live(s)) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [s]);
  useEffect(() => { const el = consoleRef.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [lines]);
  useEffect(() => { setWide(false); setShowConsole(true); setInErr(null); }, [id]);

  if (id == null || !s) {
    return (
      <section className="rn-stage idle" aria-label="Launch stage">
        <div className="rn-idle">
          <div className="rn-ring" aria-hidden><span>▶</span></div>
          <p>{id != null ? "Connecting…" : recommended ? `Ready to start ${recommended.label}.` : "Nothing is running."}</p>
          {id == null && recommended && <button onClick={() => onStart(recommended)}>{recommended.kind === "static" ? "Preview" : "Start"} {recommended.label}</button>}
          <p className="muted">Its output shows here, and anything that serves pages opens right inside the app.</p>
        </div>
      </section>
    );
  }
  const url = s.url ? fullUrl(s.url) : null;
  const up = s.endedAt ? Date.parse(s.endedAt) - Date.parse(s.startedAt) : Date.now() - Date.parse(s.startedAt);
  async function send(e: FormEvent) {
    e.preventDefault();
    try { await launchApi.input(s!.id, input); setInput(""); setInErr(null); } catch (x) { setInErr((x as Error).message); }
  }
  return (
    <section className={`rn-stage${wide ? " wide" : ""}`} aria-label={`${s.label} output`}>
      <header className="rn-stage-head">
        <span className={`rn-light st-${s.state}${s.exitCode ? " bad" : ""}`} aria-hidden />
        <strong>{s.label}</strong>
        <span className={`rn-pill st-${s.state}`}>{s.mode === "window" ? "in its own window" : s.state}{s.exitCode != null ? ` · exit ${s.exitCode}` : ""}</span>
        <span className="muted mono">{clock(up)}</span>
        <code className="rn-cmd grow" title={s.dir}>{s.command}</code>
        {live(s) && <button className="sm stop" onClick={() => onStop(s.id)}>Stop</button>}
      </header>
      {url && (
        <div className={`rn-preview${showConsole ? "" : " full"}`}>
          <div className="rn-bar">
            <button className="ghost tiny" onClick={() => setFrameKey((k) => k + 1)} title="Reload the page">↻</button>
            <span className="mono rn-url" title={url}>{url}</span>
            <button className="ghost tiny" onClick={() => launchApi.open(url).catch(() => window.open(url, "_blank"))} title="Open in your browser">Browser</button>
            <button className="ghost tiny" onClick={() => setShowConsole((v) => !v)}>{showConsole ? "Hide console" : "Console"}</button>
            <button className="ghost tiny" onClick={() => setWide((v) => !v)} aria-pressed={wide}>{wide ? "Shrink" : "Expand"}</button>
          </div>
          {live(s) ? <iframe key={`${s.id}-${frameKey}`} src={url} title={`${s.label} preview`} className="rn-frame" /> : <p className="empty">The app has stopped, so its page is gone. Start it again to see it.</p>}
        </div>
      )}
      {(!url || showConsole) && (
        <div className={`rn-console${url ? " short" : ""}`}>
          {s.mode === "window" ? <p className="empty">It is running in a console window of its own; its output shows there.</p> : (
            <ol ref={consoleRef} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30; }}>
              {lines.map((l) => <li key={l.n} className={`ln ${l.stream}`}>{l.stream === "in" ? "› " : ""}{l.text || " "}</li>)}
              {s.state === "starting" && <li className="ln sys">starting…</li>}
            </ol>
          )}
          {live(s) && s.stdinOpen && s.kind !== "static" && (
            <form className="rn-input" onSubmit={send}>
              <span className="mono" aria-hidden>›</span>
              <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="type input for the program, Enter sends" aria-label="Input for the program" />
              <button className="ghost sm" type="button" onClick={() => launchApi.input(s.id, null).catch((x) => setInErr((x as Error).message))} title="Close the input (end of file), for tools that read to the end">End input</button>
            </form>
          )}
          {inErr && <p className="error pad">{inErr}</p>}
        </div>
      )}
    </section>
  );
}

function clock(ms: number) {
  const t = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

registerProjectPanel({
  id: "run",
  title: "Run",
  order: 5,
  badge: (ctx) => {
    const f = ctx.project.facets?.launch as { running?: number } | undefined;
    return f?.running ? "live" : null;
  },
  render: (ctx) => <RunPanel ctx={ctx} />,
});
