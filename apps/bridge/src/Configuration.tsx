import { useEffect, useMemo, useState } from "react";
import { API } from "./api";
import { ago } from "./projects/builtin";

export type ConfigLayer = "how" | "who" | "where";
export interface ConfigSource { kind: "built-in" | "scout" | "pr" | "you" | "add-on" | "switch"; label: string; link?: string }
export interface ConfigEntry { id: string; layer: ConfigLayer; group: string; name: string; on: boolean; detail: string; source: ConfigSource; since?: string | null }
interface ConfigReport { hash: string; layers: { id: ConfigLayer; title: string; note: string }[]; entries: ConfigEntry[] }
export interface ConfigDiff { added: ConfigEntry[]; removed: ConfigEntry[]; changed: { id: string; name: string; was: string; now: string }[] }
interface RanWithView { hash: string; calls: number; first: string; last: string; sinceThen: ConfigDiff | null; sameAsNow: boolean }

const FROM: Record<ConfigSource["kind"], string> = { "built-in": "Built in", scout: "Scout", pr: "PR", you: "You", "add-on": "Add-on", switch: "Switch" };

/**
 * Configuration: what SoftwareFactory runs with right now, in three layers (how we work, who works,
 * where and with what), and where each piece came from. The fingerprint at the top is what every
 * run's "Ran with" line points back to (docs/configuration.md).
 */
export function ConfigurationPage() {
  const [rep, setRep] = useState<ConfigReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [onlyOn, setOnlyOn] = useState(false);
  const [q, setQ] = useState("");
  useEffect(() => {
    const load = () => fetch(`${API}/api/config`).then(async (r) => { if (!r.ok) throw new Error(`The core said ${r.status}`); setRep(await r.json()); setErr(null); }).catch((e) => setErr((e as Error).message));
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);
  const shown = useMemo(() => (rep?.entries ?? []).filter((e) => (!onlyOn || e.on) && (!q || `${e.name} ${e.detail} ${e.group} ${e.source.label}`.toLowerCase().includes(q.toLowerCase()))), [rep, onlyOn, q]);
  const counts = useMemo(() => {
    const all = rep?.entries ?? [];
    return { on: all.filter((e) => e.on).length, off: all.filter((e) => !e.on).length, scout: all.filter((e) => e.source.kind === "scout").length };
  }, [rep]);

  return (
    <section className="pane fleet cfg" aria-label="Configuration">
      <header className="fleet-head">
        <div>
          <h1>Configuration</h1>
          <p className="muted">Everything SoftwareFactory runs with right now, and where each piece came from. Every run records the setup it ran with, so you can see later what was on.</p>
        </div>
        {rep && <div className="cfg-hash" title="The fingerprint of this setup. A run's Ran with line shows the one it used."><span className="muted">Setup</span> <code>{rep.hash}</code></div>}
      </header>
      {err && <div className="err bases-err" role="alert">{err}</div>}
      {!rep ? <div className="empty">Reading the setup…</div> : (
        <div className="cfg-body">
          <div className="cfg-bar">
            <span><b>{counts.on}</b> on · <b>{counts.off}</b> off · <b>{counts.scout}</b> from Scout</span>
            <input type="search" placeholder="Find a piece" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a piece" />
            <label className="muted"><input type="checkbox" checked={onlyOn} onChange={(e) => setOnlyOn(e.target.checked)} /> Only what is on</label>
          </div>
          {rep.layers.map((l) => {
            const rows = shown.filter((e) => e.layer === l.id);
            if (!rows.length) return null;
            return (
              <section key={l.id} className="cfg-layer" aria-label={l.title}>
                <h2>{l.title} <span className="muted">{l.note}</span></h2>
                <table className="pj-table cfg-table">
                  <thead><tr><th>Piece</th><th>State</th><th>Set to</th><th>Came from</th><th>Since</th></tr></thead>
                  <tbody>
                    {rows.map((e, i) => (
                      <tr key={e.id} className={e.on ? "" : "cfg-off"}>
                        <td>{(i === 0 || rows[i - 1].group !== e.group) && <span className="cfg-group muted">{e.group}</span>}<b>{e.name}</b></td>
                        <td><span className={`cfg-state ${e.on ? "on" : "off"}`}>{e.on ? "On" : "Off"}</span></td>
                        <td>{e.detail}</td>
                        <td><span className={`cfg-src ${e.source.kind}`}>{FROM[e.source.kind]}</span> {e.source.link ? <a href={e.source.link} target="_blank" rel="noreferrer">{e.source.label}</a> : e.source.label === "Ships with SoftwareFactory" ? null : <span className="muted">{e.source.label}</span>}</td>
                        <td className="muted">{e.since ? ago(e.since) : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}

function diffWords(d: ConfigDiff): string[] {
  return [
    ...d.changed.map((c) => `${c.name}: was ${c.was}, now ${c.now}`),
    ...d.added.map((e) => `${e.name} added`),
    ...d.removed.map((e) => `${e.name} removed`),
  ];
}

/** The setup a run or a ticket ran with, and what is different now. */
export function RanWith({ run, ticket }: { run?: number; ticket?: number }) {
  const [r, setR] = useState<{ setups: RanWithView[]; unrecorded: number } | null>(null);
  const [open, setOpen] = useState(false);
  const qs = run !== undefined ? `run=${run}` : ticket !== undefined ? `ticket=${ticket}` : null;
  useEffect(() => {
    if (!qs) return;
    let off = false;
    fetch(`${API}/api/config/ran?${qs}`).then((x) => (x.ok ? x.json() : null)).then((j) => { if (!off) setR(j); }).catch(() => undefined);
    return () => { off = true; };
  }, [qs]);
  if (!r || (!r.setups.length && !r.unrecorded)) return null;
  if (!r.setups.length) return <div className="ranwith muted">Ran before setups were recorded.</div>;
  const last = r.setups[r.setups.length - 1];
  const changes = last.sinceThen ? diffWords(last.sinceThen) : [];
  return (
    <div className="ranwith" aria-label="Ran with">
      <span className="muted">Ran with</span> <a href="#/config"><code>{last.hash}</code></a>
      {r.setups.length > 1 && <span className="muted"> (and {r.setups.length - 1} earlier setup{r.setups.length > 2 ? "s" : ""})</span>}
      {" · "}
      {last.sameAsNow ? <span className="muted">same as now</span>
        : last.sinceThen ? <button className="link" onClick={() => setOpen(!open)}>{changes.length} difference{changes.length === 1 ? "" : "s"} from now</button>
        : <span className="muted">setup not kept</span>}
      {open && changes.length > 0 && <ul className="ranwith-diff">{changes.map((c) => <li key={c}>{c}</li>)}</ul>}
    </div>
  );
}
