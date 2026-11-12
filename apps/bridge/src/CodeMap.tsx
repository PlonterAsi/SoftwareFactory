import { useEffect, useMemo, useState } from "react";
import { ReactFlow, Background, Handle, Position, MarkerType, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { API, type SfEvent } from "./api";
import { panelsFor, registerProjectPanel } from "./projects/panels";
import { href } from "./projects/router";

/** Mirrors of the core's imports API (packages/core/src/imports/). */
export interface CodeModuleView { id: string; files: number; lines: number; lang: string; tests: number; testedBy: boolean; hash: string; top: string[]; exports: string[]; pkg?: string; todos: number; entry: boolean }
export interface HealthFlagView { id: string; level: "high" | "medium" | "low"; text: string; files?: string[] }
export interface CodeMapView {
  head: string | null; branch: string | null; files: number; lines: number;
  languages: { lang: string; files: number; lines: number }[];
  modules: CodeModuleView[]; edges: { from: string; to: string; weight: number }[];
  entryPoints: { path: string; why: string }[]; tests: { files: number; command: string | null; frameworks: string[] };
  health: { score: number; flags: HealthFlagView[] }; largest: { path: string; lines: number }[]; ms: number;
}
export interface ImportRowView { projectId: number; name?: string; source: string; local: boolean; dir: string; branch: string | null; head: string | null; status: "importing" | "ready" | "exploring" | "failed"; error: string | null; explores: number; spentUsd: number; health?: number | null; suggestions?: number }
export interface SuggestionView { id: string; title: string; body: string; kind: string; lens: string; severity: "critical" | "high" | "medium" | "low"; effort: string; files: string[]; by: string; status: string }
export interface ImportDetailView {
  import: ImportRowView; map: { explore: number; ts: string; map: CodeMapView } | null;
  notes: Record<string, { purpose: string; role: string; risks: string[]; by: string; hash: string }>;
  suggestions: SuggestionView[]; explores: ({ id: number; ts: string; type: string } & Record<string, any>)[]; busy: boolean; maxUsd: number; mode: "agent" | "heuristic";
}

const j = async <T,>(r: Response): Promise<T> => { const b = await r.json(); if (!r.ok) throw new Error(b.error ?? r.statusText); return b as T; };
export const importsApi = {
  list: () => fetch(`${API}/api/imports`).then((r) => j<{ imports: ImportRowView[]; maxUsd: number; mode: string }>(r)),
  detail: (id: number) => fetch(`${API}/api/imports/${id}`).then((r) => j<ImportDetailView>(r)),
  start: (source: string, maxUsd?: number) => fetch(`${API}/api/imports`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source, maxUsd }) }).then((r) => j<{ projectId: number; existing: boolean }>(r)),
  explore: (id: number) => fetch(`${API}/api/imports/${id}/explore`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => j<{ projectId: number }>(r)),
};

/** One imported project's code map, refetched on every repo.* or improve.* event. */
export function useImportDetail(projectId: number, events: SfEvent[]) {
  const [detail, setDetail] = useState<ImportDetailView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const relevant = events.filter((e) => e.type.startsWith("repo.") || e.type.startsWith("improve.")).at(-1)?.id ?? 0;
  useEffect(() => {
    let stop = false;
    const t = setTimeout(() => importsApi.detail(projectId).then((d) => { if (!stop) { setDetail(d); setErr(null); } }).catch((e) => !stop && setErr((e as Error).message)), 150);
    return () => { stop = true; clearTimeout(t); };
  }, [relevant, projectId]);
  return { detail, err };
}

/** The import box on the projects page: a URL or a folder becomes a project, then opens on its Code map. */
export function ImportRepo() {
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const submit = async (e?: { preventDefault(): void }) => {
    e?.preventDefault();
    if (!source.trim() || busy) return;
    setBusy(true); setMsg(null);
    try {
      const r = await importsApi.start(source.trim());
      setSource("");
      location.hash = href({ page: "project", id: r.projectId, panel: "code" });
    } catch (x) { setMsg((x as Error).message); }
    setBusy(false);
  };
  return (
    <form className="cm-import" onSubmit={submit} aria-label="Import a git repo">
      <span className="cm-import-label">Import a repo</span>
      <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="https://github.com/owner/repo, owner/repo, or C:\path\to\folder" aria-label="Repo URL or folder" />
      <button type="submit" disabled={busy || !source.trim()}>{busy ? "Importing…" : "Import"}</button>
      <span className="muted small">The crew maps it and suggests fixes. Read-only: nothing in the repo changes.</span>
      {msg && <span className="cm-import-err small" role="alert">{msg}</span>}
    </form>
  );
}

const ROLE_HUE: Record<string, string> = { ui: "#b48cff", core: "#4fd6e8", api: "#f2b34b", data: "#5ee0a0", cli: "#ff9f6b", test: "#7488a3", config: "#7488a3", build: "#7488a3", docs: "#7488a3", other: "#9fb2cc" };
const usd = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const STATIONS = [
  { id: "fetch", label: "Fetch", sub: "clone or pull" },
  { id: "scan", label: "Scan", sub: "free static map" },
  { id: "map", label: "Map", sub: "Cartographer" },
  { id: "survey", label: "Survey", sub: "Surveyor" },
  { id: "visual", label: "Visualize", sub: "every part drawn" },
] as const;

type ModData = { m: CodeModuleView; note?: ImportDetailView["notes"][string]; picked: boolean; maxLines: number };
function ModuleNode({ data }: NodeProps<Node<ModData>>) {
  const { m, note, picked, maxLines } = data;
  const hue = ROLE_HUE[note?.role ?? "other"] ?? ROLE_HUE.other;
  const fill = Math.max(0.08, m.lines / Math.max(1, maxLines));
  return (
    <div className={`cm-node${picked ? " on" : ""}`} style={{ borderColor: hue, width: 170 + Math.round(fill * 50) }} title={note?.purpose ?? m.id}>
      <Handle type="target" position={Position.Left} />
      <div className="cm-node-top"><span className="cm-role" style={{ color: hue }}>{note?.role ?? "…"}</span>{m.entry && <span className="cm-badge" title="has an entry point">▶</span>}<span className={`cm-badge ${m.tests || m.testedBy ? "ok" : "bad"}`} title={m.tests ? `${m.tests} test files` : m.testedBy ? "tested from another module" : "no tests"}>{m.tests || m.testedBy ? "✓" : "✗"} tests</span></div>
      <div className="cm-name">{m.id}</div>
      <div className="cm-bar"><span style={{ width: `${fill * 100}%`, background: hue }} /></div>
      <div className="cm-sub mono">{m.lang} · {m.lines} lines · {m.files} files{m.todos ? ` · ${m.todos} TODO` : ""}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { mod: ModuleNode };

const CODE_LANGS = new Set(["TypeScript", "JavaScript", "Python", "Rust", "Go", "Java", "Kotlin", "C#", "C++", "C", "Ruby", "PHP", "Swift", "Dart", "Scala", "Lua", "Shell", "PowerShell", "SQL", "Vue", "Svelte", "HTML", "CSS"]);

/**
 * Dependents on the left, what they depend on to the right. Cycles are broken
 * where a depth-first walk finds them, the column is the longest chain that
 * leads to a module, and a tall column wraps so the map stays readable.
 */
function layout(mods: CodeModuleView[], edges: { from: string; to: string; weight: number }[]) {
  const ids = new Set(mods.map((m) => m.id));
  const es = edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  const out = new Map<string, string[]>();
  for (const e of es) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const state = new Map<string, 1 | 2>();
  const back = new Set<string>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const t of out.get(id) ?? []) {
      if (state.get(t) === 1) back.add(`${id}>${t}`);
      else if (!state.has(t)) visit(t);
    }
    state.set(id, 2);
  };
  // Start from modules nothing depends on (apps, tests, entry points), biggest first.
  const indeg = new Map(mods.map((m) => [m.id, 0]));
  for (const e of es) indeg.set(e.to, indeg.get(e.to)! + 1);
  for (const m of [...mods].sort((a, b) => indeg.get(a.id)! - indeg.get(b.id)! || b.lines - a.lines)) if (!state.has(m.id)) visit(m.id);
  const dag = es.filter((e) => !back.has(`${e.from}>${e.to}`));
  const level = new Map(mods.map((m) => [m.id, 0]));
  for (let i = 0; i < mods.length; i++) {
    let moved = false;
    for (const e of dag) if (level.get(e.from)! + 1 > level.get(e.to)!) { level.set(e.to, level.get(e.from)! + 1); moved = true; }
    if (!moved) break;
  }
  const cols = new Map<number, CodeModuleView[]>();
  for (const m of mods) cols.set(level.get(m.id)!, [...(cols.get(level.get(m.id)!) ?? []), m]);
  // Columns of at most 6 modules; at most 4 columns side by side, then the next band starts below.
  const PER = 6;
  const BAND = 4;
  const columns: CodeModuleView[][] = [];
  for (const c of [...cols.keys()].sort((a, b) => a - b)) {
    const list = cols.get(c)!.sort((a, b) => b.lines - a.lines);
    for (let i = 0; i < list.length; i += PER) columns.push(list.slice(i, i + PER));
  }
  const pos = new Map<string, { x: number; y: number }>();
  let top = 0;
  for (let b0 = 0; b0 < columns.length; b0 += BAND) {
    const band = columns.slice(b0, b0 + BAND);
    band.forEach((col, k) => col.forEach((m, row) => pos.set(m.id, { x: k * 270, y: top + row * 110 })));
    top += Math.max(...band.map((c) => c.length)) * 110 + 70;
  }
  return { pos, edges: es, back };
}

export function CodeMapPanel({ projectId, events, onOpenCouncil }: { projectId: number; events: SfEvent[]; onOpenCouncil?: () => void }) {
  const { detail, err } = useImportDetail(projectId, events);
  const [msg, setMsg] = useState<string | null>(null);
  const [mod, setMod] = useState<string | null>(null);
  const map = detail?.map?.map ?? null;
  const code = useMemo(() => (map?.modules ?? []).filter((m) => CODE_LANGS.has(m.lang) && m.lines > 0), [map]);
  const graph = useMemo(() => {
    if (!map) return { nodes: [] as Node<ModData>[], edges: [] as Edge[] };
    const { pos, edges, back } = layout(code, map.edges);
    const maxLines = Math.max(1, ...code.map((m) => m.lines));
    const maxW = Math.max(1, ...edges.map((e) => e.weight));
    return {
      nodes: code.map((m) => ({ id: m.id, type: "mod", position: pos.get(m.id)!, data: { m, note: detail?.notes[m.id], picked: mod === m.id, maxLines } })),
      edges: edges.map((e) => ({ id: `${e.from}>${e.to}`, source: e.from, target: e.to, animated: mod != null && (e.from === mod || e.to === mod),
        style: { stroke: mod != null && (e.from === mod || e.to === mod) ? "var(--accent)" : back.has(`${e.from}>${e.to}`) ? "#5a3a4a" : "#2c4566", strokeWidth: 1 + (2 * e.weight) / maxW, strokeDasharray: back.has(`${e.from}>${e.to}`) ? "4 3" : undefined, opacity: mod == null || e.from === mod || e.to === mod ? 1 : 0.25 },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#2c4566" } })),
    };
  }, [map, code, detail?.notes, mod]);

  // The newest exploration's stations.
  const lastStart = [...(detail?.explores ?? [])].reverse().find((e) => e.type === "repo.explore.started");
  const since = lastStart?.id ?? 0;
  const st = new Map<string, { state: string; note?: string; [k: string]: any }>();
  for (const e of detail?.explores ?? []) {
    // A new exploration clears the strip, except a clone that just happened before it.
    if (e.type === "repo.explore.started") { const f = st.get("fetch"); st.clear(); if (f && f.explore === 0) st.set("fetch", f); }
    else if (e.type === "repo.explore.station") st.set(e.station, e as any);
  }
  const finished = [...(detail?.explores ?? [])].reverse().find((e) => e.type === "repo.explore.finished" && e.explore === since);
  const est = st.get("map")?.estimateUsd as number | undefined;
  const spent = finished?.spentUsd ?? st.get("survey")?.spentUsd ?? st.get("map")?.spentUsd ?? 0;
  const cap = lastStart?.capUsd ?? detail?.maxUsd ?? 0.5;
  const pickedMod = code.find((m) => m.id === mod) ?? null;
  const other = (map?.modules ?? []).filter((m) => !code.includes(m));

  return (
    <section className="code-deck">
      {msg && <div className="cm-msg small">{msg}</div>}
      {err && !detail && <div className="empty">Could not read the code map: {err}</div>}
      {!detail && !err && <div className="empty">Reading the code map…</div>}
      {detail && (
        <div className="cm-body">
          <div className="cm-strip">
            {STATIONS.map((s, i) => {
              const x = st.get(s.id);
              const state = x?.state ?? (detail.busy ? "idle" : finished ? "skipped" : "idle");
              return <div key={s.id} className={`cm-station s-${state}`} title={x?.note ?? s.sub}>{i > 0 && <span className="cm-arrow" aria-hidden>→</span>}<b>{s.label}</b><span className="muted">{x?.note ? x.note.slice(0, 70) : s.sub}</span></div>;
            })}
            <div className="cm-meter" title="Spent this exploration, against the estimate and the cap">
              <div className="cm-meter-bar"><span className="est" style={{ width: `${Math.min(100, ((est ?? 0) / Math.max(cap, 0.0001)) * 100)}%` }} /><span className="spent" style={{ width: `${Math.min(100, (spent / Math.max(cap, 0.0001)) * 100)}%` }} /></div>
              <span className="mono small">{usd(spent)} spent{est != null ? ` · est ${usd(est)}` : ""} · cap {usd(cap)}</span>
            </div>
            <span className="muted small cm-mode">{detail.mode === "agent" ? "real crew" : "practice crew: free heuristics"}</span>
            <button className="ghost sm" disabled={detail.busy || detail.import.status === "importing"} onClick={() => importsApi.explore(detail.import.projectId).catch((e) => setMsg((e as Error).message))}>{detail.busy ? "Exploring…" : "Explore again"}</button>
          </div>
          {detail.import.error && <div className="cm-error">{detail.import.error}</div>}
          {map && (
            <div className="cm-facts mono small">
              <span>{detail.import.local ? "folder" : "clone"} {detail.import.local ? detail.import.dir : detail.import.source}</span>
              {map.head && <span>{map.branch} @ {map.head.slice(0, 7)}</span>}
              <span>{map.files} files · {map.lines.toLocaleString()} lines</span>
              <span>{map.languages.filter((l) => l.lines > 0 && l.lang !== "Other").slice(0, 4).map((l) => `${l.lang} ${Math.round((l.lines / Math.max(1, map.lines)) * 100)}%`).join(" · ")}</span>
              <span>tests: {map.tests.files} files{map.tests.command ? ` (${map.tests.command})` : ""}</span>
            </div>
          )}
          <div className="cm-main">
            <div className="cm-graph">
              {map ? (
                <ReactFlow key={`${projectId}-${detail.map?.explore}`} nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.08, maxZoom: 1.1 }} proOptions={{ hideAttribution: true }} nodesConnectable={false} onNodeClick={(_, n) => setMod(n.id === mod ? null : n.id)} onPaneClick={() => setMod(null)} minZoom={0.2}>
                  <Background color="#142034" gap={22} />
                </ReactFlow>
              ) : <div className="empty">{detail.import.status === "failed" ? "The import failed; see above." : "Scanning…"}</div>}
              {other.length > 0 && <div className="cm-other small muted">Also in the repo: {other.map((m) => `${m.id} (${m.lang})`).join(", ")}</div>}
            </div>
            <aside className="cm-side">
              {pickedMod ? (
                <div className="cm-card">
                  <h4>{pickedMod.id}</h4>
                  <p>{detail.notes[pickedMod.id]?.purpose ?? "Not described yet."}</p>
                  <div className="muted small">by {detail.notes[pickedMod.id]?.by ?? "nobody yet"}{pickedMod.pkg ? ` · package ${pickedMod.pkg}` : ""}</div>
                  {!!detail.notes[pickedMod.id]?.risks.length && <ul className="cm-risks">{detail.notes[pickedMod.id].risks.map((r, i) => <li key={i}>{r}</li>)}</ul>}
                  {!!pickedMod.exports.length && <div className="small"><b>Exports</b> <span className="mono">{pickedMod.exports.join(", ")}</span></div>}
                  <div className="small"><b>Key files</b><ul className="mono">{pickedMod.top.map((f) => <li key={f}>{f}</li>)}</ul></div>
                  <div className="small"><b>Uses</b> {map!.edges.filter((e) => e.from === pickedMod.id).map((e) => e.to).join(", ") || "nothing inside the repo"}</div>
                  <div className="small"><b>Used by</b> {map!.edges.filter((e) => e.to === pickedMod.id).map((e) => e.from).join(", ") || "nothing inside the repo"}</div>
                </div>
              ) : map ? (
                <div className="cm-card">
                  <h4><HealthRing score={map.health.score} /> Health {map.health.score}/100</h4>
                  {map.health.flags.length ? <ul className="cm-flags">{map.health.flags.map((f) => <li key={f.id} className={`lv-${f.level}`}><b>{f.level}</b> {f.text}{f.files?.length ? <span className="mono muted"> {f.files.slice(0, 3).join(", ")}</span> : null}</li>)}</ul> : <p className="muted">No health flags.</p>}
                  {!!map.entryPoints.length && <div className="small"><b>Entry points</b><ul className="mono">{[...new Map(map.entryPoints.map((e) => [e.path, e])).values()].slice(0, 6).map((e) => <li key={e.path} title={e.why}>{e.path}</li>)}</ul></div>}
                  <div className="muted small">Click a module on the map to see what it does.</div>
                </div>
              ) : null}
              <div className="cm-card">
                <h4>Suggestions · {detail.suggestions.length}{onOpenCouncil && <button className="link small" onClick={onOpenCouncil}>open the Council's queue</button>}</h4>
                <div className="muted small">Each one goes to the Council's queue; accepted ones become tickets the crew works on a branch.</div>
                {detail.suggestions.length ? detail.suggestions.map((s) => (
                  <div key={s.id} className={`cm-sug sv-${s.severity}`}>
                    <div className="cm-sug-head"><span className={`chip sv-${s.severity}`}>{s.severity}</span><b>{s.title}</b></div>
                    <div className="small">{s.body}</div>
                    <div className="muted small mono">{s.kind} · {s.lens} · {s.effort} effort · by {s.by}{s.files.length ? ` · ${s.files.slice(0, 3).join(", ")}` : ""} · <span className={`cm-status st-${s.status}`}>{s.status === "pending" ? "waiting for the Council" : s.status}</span></div>
                  </div>
                )) : <div className="muted small">{detail.busy ? "The Surveyor is reading the map…" : "None yet."}</div>}
              </div>
            </aside>
          </div>
        </div>
      )}
    </section>
  );
}

function HealthRing({ score }: { score: number | null }) {
  const s = score ?? 0;
  const c = score == null ? "var(--muted)" : s >= 80 ? "var(--good)" : s >= 55 ? "var(--gate)" : "var(--bad)";
  return (
    <svg className="cm-ring" viewBox="0 0 36 36" width="18" height="18" aria-label={score == null ? "not mapped yet" : `health ${s} of 100`}>
      <circle cx="18" cy="18" r="15" fill="none" stroke="var(--line)" strokeWidth="5" />
      <circle cx="18" cy="18" r="15" fill="none" stroke={c} strokeWidth="5" strokeDasharray={`${(s / 100) * 94.2} 94.2`} transform="rotate(-90 18 18)" />
    </svg>
  );
}

/** The Council's proposal panel, if that part of the app is loaded. */
const queuePanel = (p: Parameters<typeof panelsFor>[0]) => panelsFor(p).find((x) => /improve|council|proposal/i.test(x.id))?.id;

registerProjectPanel({
  id: "code", section: "know", title: "Code map", order: 15,
  appliesTo: (p) => (p.rollup.linked.repo ?? 0) > 0,
  badge: (c) => { const f = (c.project.facets as Record<string, any>).code; return f ? (f.status === "exploring" || f.status === "importing" ? "exploring" : f.openSuggestions || null) : null; },
  alert: (c) => (c.project.facets as Record<string, any>).code?.status === "failed",
  render: (c) => <CodeMapPanel projectId={c.project.id} events={c.events} onOpenCouncil={queuePanel(c.project) ? () => c.go(queuePanel(c.project)!) : undefined} />,
});
