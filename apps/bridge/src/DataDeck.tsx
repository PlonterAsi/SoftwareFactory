import { useEffect, useState } from "react";
import { API, type SfEvent } from "./api";

/** Mirror of the core's StoreReport (packages/core/src/store/inspect.ts). */
export interface StoreReport {
  database: {
    path: string; bytes: number; walBytes: number; schemaVersion: number; latestSchema: number;
    migrations: { version: number; name: string; appliedAt: string }[];
    backups: { file: string; bytes: number }[];
    events: { total: number; lastId: number; byType: { type: string; count: number }[] };
    tables: { name: string; rows: number; projection: string | null }[];
    projections: { name: string; describe: string; version: number; tables: string[]; lastEventId: number; rebuiltAt: string; error: string | null; behind: number }[];
  };
  files: {
    root: string; exists: boolean; orphans: string[];
    projects: { run: number; name: string; dir: string; onDisk: boolean; files: number; bytes: number; tracked: number; missing: string[] }[];
  };
  cache: { views: { name: string; key: number; hits: number; misses: number; lastComputeMs: number; builtAt: string | null }[]; hits: number; misses: number };
}

const kb = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`);
const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** Refetch the store report whenever a new event lands (the tables and cache move with the log). */
export function useStore(events: SfEvent[], active: boolean) {
  const [report, setReport] = useState<StoreReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const lastId = events.at(-1)?.id ?? 0;
  useEffect(() => {
    if (!active) return;
    let stop = false;
    const t = setTimeout(() => {
      fetch(`${API}/api/store`).then((r) => r.json()).then((r: StoreReport) => { if (!stop) { setReport(r); setErr(null); } }).catch((e) => !stop && setErr((e as Error).message));
    }, 250);
    return () => { stop = true; clearTimeout(t); };
  }, [lastId, active]);
  const rebuild = async () => {
    const r = await fetch(`${API}/api/store/rebuild`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? "rebuild failed");
    setReport(j);
  };
  return { report, err, rebuild };
}

/**
 * The Data deck: the three storage tiers, drawn. The event log is the core of
 * the database and every organized table hangs off it (a lagging or broken
 * table shows red); files on disk are checked against the rows that point at
 * them; the cache shows what it is holding and how often it is hit.
 */
export function DataDeck({ store }: { store: ReturnType<typeof useStore> }) {
  const { report: r, err } = store;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!r) return <section className="pane data-deck"><div className="pane-head">Data vault</div><div className="empty">{err ? `Core unreachable: ${err}` : "Reading the store…"}</div></section>;
  const db = r.database;
  const rows = new Map(db.tables.map((t) => [t.name, t.rows]));
  const unhealthy = db.projections.filter((p) => p.error || p.behind > 0);
  const missing = r.files.projects.reduce((s, p) => s + p.missing.length + (p.onDisk ? 0 : 1), 0);
  const hitRate = r.cache.hits + r.cache.misses ? Math.round((100 * r.cache.hits) / (r.cache.hits + r.cache.misses)) : 0;
  const rebuild = async () => {
    setBusy(true);
    try { await store.rebuild(); setMsg("Every table was rebuilt from the event log."); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <section className="pane data-deck">
      <div className="pane-head">
        Data vault
        <span className="muted">schema v{db.schemaVersion}{db.schemaVersion < db.latestSchema ? ` (latest v${db.latestSchema})` : ""} · {kb(db.bytes + db.walBytes)} · {base(db.path)}</span>
      </div>
      <div className="vault">
        <div className="tier tier-db" aria-label="Database">
          <div className="tier-title"><span className="tier-dot" /> Database <span className="muted">source of truth</span></div>
          <div className="core-log">
            <div className="cyl" title="Append-only: nothing is edited or deleted">
              <div className="cyl-n">{db.events.total.toLocaleString()}</div>
              <div className="muted">events</div>
            </div>
            <ul className="types mono">
              {db.events.byType.slice(0, 6).map((t) => <li key={t.type}><span>{t.type}</span><b>{t.count}</b></li>)}
            </ul>
          </div>
          <div className="proj-list">
            {db.projections.map((p) => (
              <div key={p.name} className={`proj ${p.error ? "bad" : p.behind ? "warn" : "ok"}`} title={p.error ?? `${p.describe}. Up to event ${p.lastEventId}.`}>
                <span className="wire" aria-hidden />
                <div className="proj-body">
                  <div className="mono">{p.tables.map((t) => <span key={t} className="tbl">{t} <b>{rows.get(t) ?? 0}</b></span>)}</div>
                  <div className="muted small">{p.error ? `Broken: ${p.error}` : p.behind ? `${p.behind} events behind` : p.describe}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="tier tier-files" aria-label="Files">
          <div className="tier-title"><span className="tier-dot" /> Files <span className="muted">real files only, each pointed at by a row</span></div>
          {r.files.projects.length === 0 && <div className="muted small">No generated projects yet. Factory runs write their repos here.</div>}
          {r.files.projects.map((p) => (
            <div key={p.run} className={`file-row ${!p.onDisk || p.missing.length ? "bad" : ""}`} title={p.dir}>
              <span className="mono">#{p.run}</span>
              <span className="fname">{p.name}</span>
              <span className="mono muted">{p.onDisk ? `${p.files} files · ${kb(p.bytes)} · ${p.tracked} tracked` : "folder missing"}</span>
              {p.missing.length > 0 && <span className="mono bad-text">missing: {p.missing.join(", ")}</span>}
            </div>
          ))}
          {r.files.orphans.length > 0 && <div className="small warn-text">Not referenced by any run: {r.files.orphans.join(", ")}</div>}
          <div className="muted small mono">{r.files.root}</div>
        </div>

        <div className="tier tier-cache" aria-label="Cache">
          <div className="tier-title"><span className="tier-dot" /> Cache <span className="muted">in memory, always safe to drop</span></div>
          <div className="hitbar" role="img" aria-label={`${hitRate}% cache hits`}><span style={{ width: `${hitRate}%` }} /></div>
          <div className="mono small">{r.cache.hits} hits · {r.cache.misses} rebuilds · {hitRate}% served from cache</div>
          {r.cache.views.map((v) => (
            <div key={v.name} className="file-row">
              <span className="fname">{v.name} view</span>
              <span className="mono muted">{v.key >= 0 ? `fresh at event ${v.key}` : "dropped"} · last fold {v.lastComputeMs} ms</span>
            </div>
          ))}
        </div>
      </div>

      <div className="vault-foot">
        <div className="mono small">
          {db.migrations.map((m) => <span key={m.version} className="mig" title={`${m.name}, applied ${new Date(m.appliedAt).toLocaleString()}`}>v{m.version}</span>)}
          <span className="muted"> · {db.backups.length ? `${db.backups.length} backup${db.backups.length > 1 ? "s" : ""} (newest ${kb(db.backups[0].bytes)})` : "no backups needed yet"}</span>
          {(unhealthy.length > 0 || missing > 0) && <span className="bad-text"> · {unhealthy.length ? `${unhealthy.length} table set${unhealthy.length > 1 ? "s" : ""} need a rebuild` : ""}{missing ? ` ${missing} file${missing > 1 ? "s" : ""} missing` : ""}</span>}
        </div>
        <div className="row">
          {msg && <span className="small muted">{msg}</span>}
          <button className="ghost tiny" disabled={busy} onClick={rebuild} title="Drop every organized table and the cache, and rebuild them from the event log">{busy ? "Rebuilding…" : "Rebuild from log"}</button>
        </div>
      </div>
    </section>
  );
}
