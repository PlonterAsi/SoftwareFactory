import { useEffect, useState, type FormEvent } from "react";
import { launchApi, type BrowseView, type UsageExample, type UsageField, type UsageView } from "../api";

/**
 * Use a command-line tool without knowing its arguments: what it does,
 * one-press example runs, and a form for its inputs with file and folder pickers.
 * The arguments it builds are shown, so you learn the command as you go.
 */
export interface ToolRunRequest { argv: string[]; stdin?: string }

export function buildArgv(fields: UsageField[], values: Record<string, string>): { argv: string[]; missing: UsageField[] } {
  const argv: string[] = [];
  const missing: UsageField[] = [];
  const pos = fields.filter((f) => f.kind === "positional");
  for (const f of pos) {
    const v = (values[f.id] ?? "").trim();
    if (!v) { if (f.required) missing.push(f); continue; }
    argv.push(v);
  }
  for (const f of fields.filter((x) => x.kind !== "positional")) {
    const v = (values[f.id] ?? "").trim();
    if (f.kind === "flag") { if (v === "on") argv.push(f.flag!); continue; }
    if (!v) { if (f.required) missing.push(f); continue; }
    argv.push(f.flag!, v);
  }
  return { argv, missing };
}

const shown = (a: string) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a}"`);
const WORDS: Record<string, string> = { dir: "folder", directory: "folder", src: "source", dest: "destination", out: "output", n: "number" };
const nice = (s: string) => { const w = WORDS[s.toLowerCase()] ?? s; return w.charAt(0).toUpperCase() + w.slice(1); };

export function ToolForm({ usage, command, busy, onRun, onWindow }: {
  usage: UsageView; command: string; busy: boolean;
  onRun: (r: ToolRunRequest) => void; onWindow: (r: ToolRunRequest) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [stdin, setStdin] = useState("");
  const [picking, setPicking] = useState<UsageField | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const { argv, missing } = buildArgv(usage.fields, values);
  const set = (id: string, v: string) => setValues((x) => ({ ...x, [id]: v }));
  const req = (): ToolRunRequest => (raw != null ? { argv: raw.trim() ? splitLine(raw) : [], stdin: stdin || undefined } : { argv, stdin: stdin || undefined });
  const ready = raw != null || missing.length === 0;
  function submit(e: FormEvent) { e.preventDefault(); if (ready) onRun(req()); }
  const runExample = (x: UsageExample) => onRun({ argv: x.argv, stdin: x.stdin });

  return (
    <div className="tool">
      {usage.summary && <p className="tool-summary">{usage.summary}</p>}
      {usage.examples.length > 0 && (
        <div className="tool-examples" role="group" aria-label="Example runs">
          {usage.examples.map((x, i) => (
            <button key={i} type="button" className="tool-example" disabled={busy} onClick={() => runExample(x)} title={x.argv.length ? `${command} ${x.argv.map(shown).join(" ")}` : x.stdin ? "Types a sample text into it" : command}>
              <span className="tool-play" aria-hidden>▶</span>
              <span>{x.label}</span>
            </button>
          ))}
        </div>
      )}
      <form className="tool-form" onSubmit={submit}>
        {raw == null ? (
          <>
            {usage.fields.map((f) => <FieldInput key={f.id} f={f} value={values[f.id] ?? ""} set={(v) => set(f.id, v)} pick={() => setPicking(f)} />)}
            {usage.readsStdin && (
              <label className="tool-field">
                <span className="tool-label">Text to give it <em>optional</em></span>
                <textarea rows={3} value={stdin} onChange={(e) => setStdin(e.target.value)} placeholder="Type or paste text here; it is sent as the tool's input." />
              </label>
            )}
          </>
        ) : (
          <label className="tool-field">
            <span className="tool-label">Arguments</span>
            <input className="rn-args" value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="arguments, as on a command line" autoFocus />
          </label>
        )}
        <code className="tool-preview" aria-label="The command it will run">{command}{(raw != null ? (raw ? " " + raw : "") : argv.length ? " " + argv.map(shown).join(" ") : "")}</code>
        {missing.length > 0 && raw == null && <p className="tool-missing">Fill in {missing.map((f) => nice(f.label)).join(", ")} first.</p>}
        <div className="rn-row">
          <button className="sm" type="submit" disabled={busy || !ready}>{busy ? "Running…" : "Run"}</button>
          <button className="ghost sm" type="button" disabled={busy || !ready} onClick={() => onWindow(req())} title="Run it in a console window of its own">Own window</button>
          <button className="link tool-raw" type="button" onClick={() => setRaw((r) => (r == null ? argv.map(shown).join(" ") : null))}>{raw == null ? "Type arguments yourself" : "Back to the form"}</button>
        </div>
      </form>
      {usage.synopsis && <p className="tool-synopsis mono" title={`Read from: ${usage.sources.join(", ")}`}>{usage.synopsis}</p>}
      {picking && (
        <PathPicker mode={picking.type === "folder" ? "folder" : "file"} start={values[picking.id] || picking.suggestions?.[0] || null}
          title={`Choose ${picking.type === "folder" ? "a folder" : "a file"} for ${nice(picking.label)}`}
          onPick={(p) => { set(picking.id, p); setPicking(null); }} onClose={() => setPicking(null)} />
      )}
    </div>
  );
}

function FieldInput({ f, value, set, pick }: { f: UsageField; value: string; set: (v: string) => void; pick: () => void }) {
  const opt = !f.required && <em>optional</em>;
  if (f.type === "switch") {
    return (
      <label className="tool-check">
        <input type="checkbox" checked={value === "on"} onChange={(e) => set(e.target.checked ? "on" : "")} />
        <span>{nice(f.label)} <code>{f.flag}</code></span>
      </label>
    );
  }
  const path = f.type === "file" || f.type === "folder";
  return (
    <div className="tool-field">
      <span className="tool-label">{nice(f.label)} {opt}{f.flag && <code>{f.flag}</code>}{f.hint && f.hint !== f.label && <span className="muted"> · {f.hint}</span>}</span>
      <div className="tool-input">
        <input type={f.type === "number" ? "number" : "text"} value={value} onChange={(e) => set(e.target.value)} aria-label={nice(f.label)}
          placeholder={f.type === "folder" ? "Choose a folder…" : f.type === "file" ? "Choose a file…" : ""} className={path ? "mono-in" : undefined} />
        {path && <button type="button" className="ghost sm" onClick={pick}>Browse</button>}
      </div>
      {f.suggestions && f.suggestions.length > 0 && (
        <div className="tool-suggest">
          {f.suggestions.slice(0, 4).map((s) => <button key={s} type="button" className="chip-s" onClick={() => set(s)} title={s}>{tail(s)}</button>)}
        </div>
      )}
    </div>
  );
}

const tail = (p: string) => p.split(/[\\/]/).filter(Boolean).slice(-2).join("/");

function splitLine(s: string): string[] {
  return (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((a) => a.replace(/^["']|["']$/g, ""));
}

/** Pick a file or a folder on this computer (the core lists folders, so it works in the app and in a browser). */
export function PathPicker({ mode, start, title, onPick, onClose }: { mode: "file" | "folder"; start: string | null; title: string; onPick: (p: string) => void; onClose: () => void }) {
  const [view, setView] = useState<BrowseView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const go = (p: string | null) => launchApi.browse(p).then((v) => { setView(v); setTyped(v.path); setErr(v.error); }).catch((x) => setErr((x as Error).message));
  useEffect(() => {
    // Start in the folder of a file given, or the folder itself.
    go(start ? start.replace(/[\\/][^\\/]*\.[^\\/]+$/, "") : null);
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const shownEntries = view?.entries.filter((e) => e.dir || mode === "file") ?? [];
  return (
    <div className="picker-back" onClick={onClose}>
      <div className="picker" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="picker-head">
          <strong>{title}</strong>
          <button className="ghost tiny" onClick={onClose} aria-label="Close">Close</button>
        </header>
        <form className="picker-path" onSubmit={(e) => { e.preventDefault(); go(typed.trim()); }}>
          <button type="button" className="ghost sm" disabled={!view?.parent} onClick={() => go(view!.parent)} title="Up one folder">↑</button>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Folder path" className="mono-in" />
          <button type="submit" className="ghost sm">Go</button>
        </form>
        <div className="picker-roots">
          {view && <button className="chip-s" onClick={() => go(view.home)}>Home</button>}
          {view?.roots.map((r) => <button key={r} className="chip-s" onClick={() => go(r)}>{r}</button>)}
        </div>
        <ul className="picker-list">
          {shownEntries.map((e) => (
            <li key={e.path}>
              <button className={e.dir ? "pk dir" : "pk"} onClick={() => (e.dir ? go(e.path) : onPick(e.path))} onDoubleClick={() => { if (e.dir && mode === "folder") onPick(e.path); }}>
                <span aria-hidden>{e.dir ? "▸" : "·"}</span><span className="pk-name">{e.name}</span>{e.size != null && <span className="muted">{size(e.size)}</span>}
              </button>
            </li>
          ))}
          {view && !shownEntries.length && <li className="empty">{mode === "folder" ? "No folders inside." : "Empty folder."}</li>}
        </ul>
        {err && <p className="error pad">{err}</p>}
        <footer className="picker-foot">
          <span className="mono muted picker-at">{view?.path}</span>
          {mode === "folder" && <button className="sm" disabled={!view} onClick={() => view && onPick(view.path)}>Use this folder</button>}
        </footer>
      </div>
    </div>
  );
}

const size = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`);
