import { useEffect, useMemo, useState } from "react";
import { launchApi, type DataFileView } from "../api";

/**
 * A project's data files, seen and changed without writing raw files:
 * tables as a grid, JSON as a form (lists of records as a grid too), text as text.
 */
const ROLE: Record<DataFileView["role"], string> = { sample: "Sample inputs", data: "Its data", file: "Other files", fixture: "Test inputs", doc: "Docs" };
const KIND_GLYPH: Record<DataFileView["kind"], string> = { table: "▦", json: "{ }", text: "¶" };

export function DataFiles({ pid, dir, version, onChanged, note }: { pid: number; dir: string | null; version: number; onChanged: () => void; note?: string | null }) {
  const [files, setFiles] = useState<DataFileView[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<{ path: string; isNew?: DataFileView["kind"] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<string | null>(null);
  const load = () => launchApi.files(pid, dir).then((r) => { setFiles(r.files); setErr(null); }).catch((x) => setErr((x as Error).message));
  useEffect(() => { load(); }, [pid, dir, version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (note) setMade(note); }, [note]);

  async function makeSamples() {
    setBusy(true);
    try {
      const r = await launchApi.samples(pid, dir);
      setFiles(r.files);
      setMade(r.made.length ? `Made ${r.made.map((m) => m.path).join(", ")} from ${[...new Set(r.made.map((m) => m.from))].join(", ")}.` : "Found nothing to base a sample on. Add a table or JSON file yourself with New.");
      onChanged();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }
  const groups = useMemo(() => {
    const g = new Map<DataFileView["role"], DataFileView[]>();
    for (const f of files ?? []) g.set(f.role, [...(g.get(f.role) ?? []), f]);
    return [...g.entries()];
  }, [files]);

  return (
    <section className="rn-data" aria-label="Data files">
      <h3>Data</h3>
      {files && !files.length && <p className="muted rn-note">No data files yet. If it reads a table or JSON, press Make sample data and SoftwareFactory writes one from its tests and spec.</p>}
      {groups.map(([role, list]) => (
        <div key={role} className="df-group">
          <span className="df-role">{ROLE[role]}</span>
          <ul>
            {list.map((f) => (
              <li key={f.path}>
                <button className="df-file" onClick={() => setOpen({ path: f.path })} title={f.note ?? `Open ${f.path}`}>
                  <span className={`df-kind k-${f.kind}`} aria-hidden>{KIND_GLYPH[f.kind]}</span>
                  <span className="df-name">{f.path}</span>
                  <span className="muted">{f.note ?? size(f.bytes)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {made && <p className="df-made" role="status">{made}</p>}
      {err && <p className="error rn-note">{err}</p>}
      <div className="rn-row">
        <button className="ghost sm" onClick={makeSamples} disabled={busy}>{busy ? "Making…" : "Make sample data"}</button>
        <button className="ghost sm" onClick={() => setOpen({ path: "samples/new-table.csv", isNew: "table" })}>New table</button>
        <button className="ghost sm" onClick={() => setOpen({ path: "samples/new.json", isNew: "json" })}>New JSON</button>
      </div>
      {open && <DataEditor pid={pid} dir={dir} path={open.path} isNew={open.isNew} onClose={() => setOpen(null)} onSaved={(fs) => { setFiles(fs); onChanged(); }} />}
    </section>
  );
}

// ---------------------------------------------------------------- editor

function DataEditor({ pid, dir, path, isNew, onClose, onSaved }: {
  pid: number; dir: string | null; path: string; isNew?: DataFileView["kind"]; onClose: () => void; onSaved: (files: DataFileView[]) => void;
}) {
  const [name, setName] = useState(path);
  const [kind, setKind] = useState<DataFileView["kind"] | null>(isNew ?? null);
  const [text, setText] = useState<string | null>(isNew === "table" ? "name,amount\n,\n" : isNew === "json" ? "[\n  {\n    \"name\": \"\",\n    \"amount\": 0\n  }\n]\n" : null);
  const [saved, setSaved] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (isNew) return;
    launchApi.file(pid, path, dir).then((f) => { setKind(f.kind); setText(f.content); setSaved(f.content); }).catch((x) => setErr((x as Error).message));
  }, [pid, dir, path, isNew]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const dirty = text != null && (text !== saved || name !== path);
  const jsonValue = useMemo(() => { if (kind !== "json" || text == null) return undefined; try { return { ok: true as const, v: JSON.parse(text) }; } catch (e) { return { ok: false as const, e: (e as Error).message }; } }, [kind, text]);

  async function save() {
    if (text == null) return;
    setErr(null); setMsg(null);
    // A row left blank in the grid is not data: leave it out of the file.
    const content = kind === "table" && !raw ? toCsv(parseCsv(text).filter((r) => r.some((c) => c.trim())), text.split(/\r?\n/, 1)[0].includes("\t") && !text.split(/\r?\n/, 1)[0].includes(",") ? "\t" : ",") : text;
    try {
      if (!isNew && name !== path) await launchApi.renameFile(pid, path, name, dir);
      const r = await launchApi.saveFile(pid, name, content, dir, !!isNew && !saved);
      setText(content); setSaved(content); setMsg("Saved."); onSaved(r.files);
      if (isNew) onClose();
    } catch (x) { setErr((x as Error).message); }
  }
  async function del() {
    try { const r = await launchApi.deleteFile(pid, path, dir); onSaved(r.files); onClose(); } catch (x) { setErr((x as Error).message); }
  }

  return (
    <div className="picker-back" onClick={() => { if (!dirty) onClose(); }}>
      <div className="picker df-editor" role="dialog" aria-modal="true" aria-label={`Edit ${path}`} onClick={(e) => e.stopPropagation()}>
        <header className="picker-head">
          <input className="mono-in df-path" value={name} onChange={(e) => setName(e.target.value)} aria-label="File name" />
          <span className="muted">{kind === "table" ? "table" : kind === "json" ? "records" : kind ?? ""}{dirty ? " · not saved" : ""}</span>
          {kind !== "text" && <button className="ghost tiny" onClick={() => setRaw((v) => !v)} aria-pressed={raw} title="See and edit it as plain text">{raw ? "Form" : "Plain text"}</button>}
          <button className="ghost tiny" onClick={onClose}>Close</button>
        </header>
        <div className="df-body">
          {text == null && !err && <p className="empty">Opening…</p>}
          {text != null && (raw || kind === "text" ? (
            <textarea className="df-raw mono-in" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label="File text" />
          ) : kind === "table" ? (
            <TableEdit text={text} onChange={setText} />
          ) : jsonValue?.ok ? (
            <JsonEdit value={jsonValue.v} onChange={(v) => setText(JSON.stringify(v, null, 2) + "\n")} />
          ) : (
            <p className="error pad">This JSON does not read ({jsonValue && !jsonValue.ok ? jsonValue.e : ""}). Fix it in Plain text.</p>
          ))}
        </div>
        {err && <p className="error pad" role="alert">{err}</p>}
        <footer className="picker-foot">
          {!isNew && (confirmDelete
            ? <span className="rn-row"><span>Delete {path}?</span><button className="sm stop" onClick={del}>Delete</button><button className="ghost sm" onClick={() => setConfirmDelete(false)}>Keep</button></span>
            : <button className="ghost sm" onClick={() => setConfirmDelete(true)}>Delete file</button>)}
          <span className="rn-row">
            {msg && <span className="muted" role="status">{msg}</span>}
            <button className="sm" onClick={save} disabled={!dirty && !isNew}>Save</button>
          </span>
        </footer>
      </div>
    </div>
  );
}

// ---- tables

export function parseCsv(text: string): string[][] {
  const sepCh = text.split(/\r?\n/, 1)[0].includes("\t") && !text.split(/\r?\n/, 1)[0].includes(",") ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"' && cell === "") q = true;
    else if (c === sepCh) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.length ? rows : [[""]];
}
export function toCsv(rows: string[][], sepCh = ","): string {
  return rows.map((r) => r.map((c) => (/[",\n\r\t]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(sepCh)).join("\n") + "\n";
}

function TableEdit({ text, onChange }: { text: string; onChange: (t: string) => void }) {
  const tsv = text.split(/\r?\n/, 1)[0].includes("\t") && !text.split(/\r?\n/, 1)[0].includes(",");
  const rows = useMemo(() => parseCsv(text), [text]);
  const width = Math.max(...rows.map((r) => r.length));
  const grid = rows.map((r) => [...r, ...Array(width - r.length).fill("")]);
  const put = (g: string[][]) => onChange(toCsv(g, tsv ? "\t" : ","));
  const set = (ri: number, ci: number, v: string) => put(grid.map((r, i) => (i === ri ? r.map((c, j) => (j === ci ? v : c)) : r)));
  return (
    <div className="df-grid-wrap">
      <table className="df-grid">
        <thead>
          <tr>
            {grid[0].map((h, ci) => (
              <th key={ci}>
                <input value={h} onChange={(e) => set(0, ci, e.target.value)} aria-label={`Column ${ci + 1} name`} placeholder="column" />
                {width > 1 && <button className="df-x" title="Remove this column" onClick={() => put(grid.map((r) => r.filter((_, j) => j !== ci)))}>×</button>}
              </th>
            ))}
            <th className="df-add"><button className="ghost tiny" onClick={() => put(grid.map((r, i) => [...r, i === 0 ? `column ${width + 1}` : ""]))} title="Add a column">+ column</button></th>
          </tr>
        </thead>
        <tbody>
          {grid.slice(1).map((r, ri) => (
            <tr key={ri}>
              {r.map((c, ci) => <td key={ci}><input value={c} onChange={(e) => set(ri + 1, ci, e.target.value)} aria-label={`${grid[0][ci] || `column ${ci + 1}`}, row ${ri + 1}`} /></td>)}
              <td className="df-add"><button className="df-x" title="Remove this row" onClick={() => put(grid.filter((_, i) => i !== ri + 1))}>×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="ghost sm" onClick={() => put([...grid, Array(width).fill("")])}>+ row</button>
      <span className="muted df-count">{grid.length - 1} rows · {width} columns</span>
    </div>
  );
}

// ---- JSON as a form

type J = null | boolean | number | string | J[] | { [k: string]: J };
const isObj = (v: J): v is { [k: string]: J } => !!v && typeof v === "object" && !Array.isArray(v);
const blankLike = (v: J): J => (Array.isArray(v) ? [] : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, blankLike(x)])) : typeof v === "number" ? 0 : typeof v === "boolean" ? false : v === null ? null : "");
/** A list of flat records with the same fields: show it as a table. */
const recordList = (v: J[]): string[] | null => {
  if (!v.length || !v.every((x) => isObj(x) && Object.values(x).every((y) => y === null || typeof y !== "object"))) return null;
  const keys = [...new Set(v.flatMap((x) => Object.keys(x as object)))];
  return keys.length && keys.length <= 12 ? keys : null;
};

function JsonEdit({ value, onChange }: { value: J; onChange: (v: J) => void }) {
  return <div className="df-json"><JNode v={value} set={onChange} depth={0} /></div>;
}

function Prim({ v, set, label }: { v: J; set: (v: J) => void; label: string }) {
  if (typeof v === "boolean") return <input type="checkbox" checked={v} onChange={(e) => set(e.target.checked)} aria-label={label} />;
  if (typeof v === "number") return <input type="number" value={Number.isFinite(v) ? v : 0} onChange={(e) => set(e.target.value === "" ? 0 : Number(e.target.value))} aria-label={label} />;
  if (v === null) return <button className="ghost tiny" onClick={() => set("")} title="Empty; press to give it a value">empty</button>;
  return <input value={String(v)} onChange={(e) => set(e.target.value)} aria-label={label} />;
}

function JNode({ v, set, depth }: { v: J; set: (v: J) => void; depth: number }) {
  const [newKey, setNewKey] = useState("");
  if (Array.isArray(v)) {
    const keys = recordList(v);
    const add = () => set([...v, v.length ? blankLike(v[v.length - 1]) : ""]);
    if (keys) {
      return (
        <div className="df-grid-wrap">
          <table className="df-grid">
            <thead><tr>{keys.map((k) => <th key={k}><span className="df-key">{k}</span></th>)}<th className="df-add" /></tr></thead>
            <tbody>
              {v.map((row, i) => (
                <tr key={i}>
                  {keys.map((k) => <td key={k}><Prim v={(row as Record<string, J>)[k] ?? ""} set={(x) => set(v.map((r, j) => (j === i ? { ...(r as object), [k]: x } : r)))} label={`${k}, row ${i + 1}`} /></td>)}
                  <td className="df-add"><button className="df-x" title="Remove this one" onClick={() => set(v.filter((_, j) => j !== i))}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="ghost sm" onClick={add}>+ add one</button>
          <span className="muted df-count">{v.length} records</span>
        </div>
      );
    }
    return (
      <div className="df-list">
        {v.map((x, i) => (
          <div key={i} className="df-item">
            <span className="df-key muted">{i + 1}</span>
            <JNode v={x} set={(n) => set(v.map((y, j) => (j === i ? n : y)))} depth={depth + 1} />
            <button className="df-x" title="Remove this one" onClick={() => set(v.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        <button className="ghost tiny" onClick={add}>+ add one</button>
      </div>
    );
  }
  if (isObj(v)) {
    return (
      <div className={depth ? "df-obj nested" : "df-obj"}>
        {Object.entries(v).map(([k, x]) => (
          <div key={k} className={x !== null && typeof x === "object" ? "df-field block" : "df-field"}>
            <span className="df-key">{k}</span>
            <JNode v={x} set={(n) => set({ ...v, [k]: n })} depth={depth + 1} />
            <button className="df-x" title={`Remove ${k}`} onClick={() => { const { [k]: _, ...rest } = v; set(rest); }}>×</button>
          </div>
        ))}
        <form className="df-newkey" onSubmit={(e) => { e.preventDefault(); const k = newKey.trim(); if (k && !(k in v)) { set({ ...v, [k]: "" }); setNewKey(""); } }}>
          <input value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="new field name" aria-label="New field name" />
          <button className="ghost tiny" type="submit" disabled={!newKey.trim()}>+ field</button>
        </form>
      </div>
    );
  }
  return <Prim v={v} set={set} label="value" />;
}

const size = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`);
