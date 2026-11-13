import { useEffect, useMemo, useRef, useState } from "react";
import { captureSignal, startFactoryRun, type ProjectSummary } from "../api";
import type { Route } from "../projects/router";
import { shortName } from "../projects/shortName";

/**
 * The helm (Ctrl K): one line to file an idea, build it, or jump anywhere.
 *   Enter       files what you typed as a note (in the open project, if one is open)
 *   Ctrl Enter  builds it
 *   ↑ ↓ Enter   opens a project or page from the list
 */
type Row = { key: string; label: string; hint?: string; kind: "note" | "build" | "go" | "act"; to?: Route; act?: () => void };

const PAGES: { label: string; to: Route; words: string }[] = [
  { label: "Needs you", to: { page: "needs" }, words: "approvals waiting gates ok" },
  { label: "Projects", to: { page: "home" }, words: "all projects home" },
  { label: "Agents", to: { page: "factory", view: "bay" }, words: "crew agent bay models" },
  { label: "Tickets", to: { page: "factory", view: "tickets" }, words: "tickets bugs tasks work" },
  { label: "All builds", to: { page: "factory", view: "factory" }, words: "floor runs builds whole factory" },
  { label: "Rules and ideas", to: { page: "factory", view: "order" }, words: "order canon unsorted conflicts rules" },
  { label: "Improve", to: { page: "factory", view: "improve" }, words: "council improvements proposals" },
  { label: "Engine cycles", to: { page: "factory", view: "cycles" }, words: "benchmark same prompt engine review compare runs" },
  { label: "Data vault", to: { page: "factory", view: "data" }, words: "database store tables" },
  { label: "Finished apps", to: { page: "features" }, words: "features integrate" },
  { label: "Add-ons", to: { page: "plugins" }, words: "plugins extensions game" },
  { label: "Brain", to: { page: "brain" }, words: "principles rules loops" },
];

export function Helm({ open, onClose, projects, projectId, projectName, go, onSystems, onRunStarted }: {
  open: boolean; onClose: () => void; projects: ProjectSummary[] | null; projectId?: number; projectName?: string;
  go: (r: Route) => void; onSystems: () => void; onRunStarted: (run: number, projectId?: number) => void;
}) {
  const [text, setText] = useState("");
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setSel(0); setMsg(null); setTimeout(() => input.current?.focus(), 0); } }, [open]);

  const q = text.trim().toLowerCase();
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (q) {
      out.push({ key: "note", kind: "note", label: `File as a note: “${text.trim()}”`, hint: projectName ? `in ${shortName(projectName)} · Enter` : "Enter" });
      out.push({ key: "build", kind: "build", label: `Build it: “${text.trim()}”`, hint: "Ctrl Enter" });
    }
    const ps = (projects ?? []).filter((p) => p.status !== "archived" && (!q || p.name.toLowerCase().includes(q)))
      .sort((a, b) => b.rollup.lastActive.localeCompare(a.rollup.lastActive)).slice(0, q ? 6 : 4);
    for (const p of ps) out.push({ key: `p${p.id}`, kind: "go", label: shortName(p.name, 48), hint: "project", to: { page: "project", id: p.id } });
    for (const pg of PAGES) if (!q || pg.label.toLowerCase().includes(q) || pg.words.includes(q)) out.push({ key: pg.label, kind: "go", label: pg.label, hint: "page", to: pg.to });
    if (!q || "systems crew settings updates".includes(q)) out.push({ key: "systems", kind: "act", label: "Systems", hint: "crew, checks, folders, updates", act: onSystems });
    return out;
  }, [q, text, projects, projectName, onSystems]);
  useEffect(() => { setSel(0); }, [q]);

  if (!open) return null;
  async function run(r: Row | undefined) {
    if (!r || busy) return;
    if (r.kind === "go" && r.to) { go(r.to); onClose(); setText(""); return; }
    if (r.kind === "act") { r.act?.(); onClose(); return; }
    const t = text.trim();
    if (!t) return;
    setBusy(true); setMsg(null);
    try {
      if (r.kind === "note") { await captureSignal(t, projectId); setMsg({ ok: true, text: `Filed${projectName ? ` in ${projectName}` : ""}. The Order Engine sorts it in a moment.` }); setText(""); }
      else { const run = await startFactoryRun(t, undefined, projectId); setText(""); onClose(); onRunStarted(run, projectId); }
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally { setBusy(false); }
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(rows.length - 1, s + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); run((e.ctrlKey || e.metaKey) ? rows.find((r) => r.kind === "build") : rows[sel]); }
  };
  return (
    <div className="helm-scrim" onClick={onClose}>
      <div className="helm" role="dialog" aria-modal="true" aria-label="Helm" onClick={(e) => e.stopPropagation()}>
        <div className="helm-field">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="helm-mark"><path d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3" /></svg>
          <input ref={input} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} disabled={busy}
            placeholder={projectName ? `An idea for ${shortName(projectName)}, or where to go…` : "Type an idea, or where to go…"} aria-label="Idea or search"
            role="combobox" aria-expanded aria-controls="helm-list" aria-activedescendant={rows[sel] ? `helm-${rows[sel].key}` : undefined} />
          <kbd>Esc</kbd>
        </div>
        {msg && <div className={`helm-msg${msg.ok ? " ok" : " err"}`} role="status">{msg.text}</div>}
        <ul className="helm-list" id="helm-list" role="listbox">
          {rows.map((r, i) => (
            <li key={r.key} id={`helm-${r.key}`} role="option" aria-selected={i === sel} className={`helm-row k-${r.kind}${i === sel ? " on" : ""}`}
              onMouseEnter={() => setSel(i)} onClick={() => run(r)}>
              <span className="helm-label">{r.label}</span>{r.hint && <span className="helm-hint">{r.hint}</span>}
            </li>
          ))}
        </ul>
        <div className="helm-foot"><span><kbd>Enter</kbd> file or open</span><span><kbd>Ctrl</kbd><kbd>Enter</kbd> build</span><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Ctrl</kbd><kbd>J</kbd> Assistant</span></div>
      </div>
    </div>
  );
}

/** What the top strip shows in place of the helm until it is opened. */
export function HelmButton({ onOpen, projectName }: { onOpen: () => void; projectName?: string }) {
  return (
    <button className="helm-btn" onClick={onOpen} aria-keyshortcuts="Control+K">
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><path d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3" /></svg>
      <span>{projectName ? `Idea for ${shortName(projectName)}, or go to…` : "Type an idea, or go to…"}</span>
      <kbd>Ctrl K</kbd>
    </button>
  );
}
