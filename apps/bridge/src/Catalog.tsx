import { useEffect, useState } from "react";
import { API } from "./api";
import { ago } from "./projects/builtin";

type State = "proposed" | "building" | "ready" | "trial" | "promoted" | "dropped";
interface Entry {
  id: string; title: string; what: string; kind: string; state: State; touches: string[]; ticket?: number | null; merged?: number[];
  source: { kind: string; label: string; link?: string; video?: string; at?: string }; addedAt?: string; stateAt?: string; note?: string;
  settings?: { path: string; value: unknown }[];
}
interface Side { finished: number; passed: number; passRate: number | null; avgUsd: number | null; avgMinutes: number | null; running: number }
interface Trial { verdict: "running" | "promote" | "drop" | "unclear"; why: string; sides: { with: Side; without: Side } }

const pct = (x: number | null) => (x == null ? "n/a" : `${Math.round(x * 100)}%`);
const usd = (x: number | null) => (x == null ? "n/a" : `$${x.toFixed(2)}`);

/** One trial: both sides, so you can see why it was (or will be) promoted, dropped or left to you. */
function TrialLine({ t }: { t: Trial }) {
  const side = (label: string, s: Side) => <span>{label}: {s.finished ? `${s.passed} of ${s.finished} passed (${pct(s.passRate)}), ${usd(s.avgUsd)} each` : "nothing finished yet"}{s.running ? `, ${s.running} still going` : ""}</span>;
  return (
    <div className={`cfg-trial ct-${t.verdict}`}>
      {side("With it", t.sides.with)} · {side("Without", t.sides.without)}
      <div className="muted">{t.why}</div>
    </div>
  );
}

const STATE: Record<State, string> = {
  proposed: "Picked, nothing runs", building: "Being built", ready: "Built, can join a profile",
  trial: "On trial", promoted: "Promoted", dropped: "Dropped",
};
const ORDER: State[] = ["building", "trial", "ready", "proposed", "promoted", "dropped"];

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}/api/config${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `The core said ${r.status}`);
  return j as T;
}

/**
 * The catalog: every technique, tool or workflow you picked (from Scout's videos and finds, or yourself), where it
 * came from, and where it stands. Nothing here runs until you choose Build it; its ticket waits, held from the crew.
 */
export function CatalogSection({ onChanged }: { onChanged: () => void }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [trials, setTrials] = useState<Record<string, Trial>>({});
  const [err, setErr] = useState<string | null>(null);
  const [showDropped, setShowDropped] = useState(false);
  const load = () => send<{ entries: Entry[]; trials?: Record<string, Trial> }>("GET", "/catalog").then((r) => { setEntries(r.entries); setTrials(r.trials ?? {}); }).catch((e) => setErr((e as Error).message));
  useEffect(() => { load(); }, []);
  if (!entries) return null;
  const move = (id: string, state: State) => { setErr(null); send("POST", `/catalog/${encodeURIComponent(id)}/state`, { state }).then(() => { load(); onChanged(); }).catch((e) => setErr((e as Error).message)); };
  const shown = entries.filter((e) => showDropped || e.state !== "dropped").sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || (b.addedAt ?? "").localeCompare(a.addedAt ?? ""));
  const dropped = entries.filter((e) => e.state === "dropped").length;
  return (
    <section className="cfg-layer cfg-catalog" aria-label="Catalog">
      <h2>Catalog <span className="muted">Every pick, where it came from and where it stands. Nothing runs until you choose Build it. On trial, every second piece of work gets it; after 5 finished on each side SF promotes or drops it, or asks you.</span></h2>
      {err && <div className="err bases-err" role="alert">{err}</div>}
      {!entries.length ? <p className="muted">No picks yet. Scout's Add to catalog puts them here.</p> : (
        <table className="pj-table cfg-table">
          <thead><tr><th>Pick</th><th>Stands</th><th>Came from</th><th>Ticket</th><th /></tr></thead>
          <tbody>
            {shown.map((e) => (
              <tr key={e.id} className={e.state === "dropped" ? "cfg-off" : ""}>
                <td><span className="cfg-group muted">{e.kind}</span><b>{e.title}</b>{e.what && <div className="muted cfg-what">{e.what}</div>}
                  {e.touches.length > 0 && <div className="muted">Touches: {e.touches.join(", ")}</div>}
                  {e.settings?.length ? <div className="muted">Sets: {e.settings.map((x) => `${x.path} = ${JSON.stringify(x.value)}`).join(", ")}</div> : null}
                  {trials[e.id] && <TrialLine t={trials[e.id]} />}
                  {e.note && !trials[e.id] && <div className="muted cfg-what">{e.note}</div>}</td>
                <td><span className={`cfg-state cs-${e.state}`}>{STATE[e.state]}</span>{e.stateAt && <div className="muted">{ago(e.stateAt)}</div>}</td>
                <td>{e.source.link ? <a href={e.source.link} target="_blank" rel="noreferrer">{e.source.label}</a> : <span className="muted">{e.source.label}</span>}</td>
                <td>{e.ticket != null ? <a href={`#/factory/tickets`} title="Open Tickets">#{e.ticket}</a> : <span className="muted">none</span>}
                  {e.merged?.length ? <div className="muted">merged in: {e.merged.map((m) => `#${m}`).join(", ")}</div> : null}</td>
                <td className="cfg-acts">
                  {e.state === "proposed" && <button className="sm" onClick={() => move(e.id, "building")}>Build it</button>}
                  {e.state === "building" && <button className="ghost sm" onClick={() => move(e.id, "ready")}>Mark built</button>}
                  {(e.state === "ready" || e.state === "dropped") && (e.settings?.length ?? 0) > 0 && <button className="sm" onClick={() => move(e.id, "trial")}>Put on trial</button>}
                  {e.state === "trial" && <button className="sm" onClick={() => move(e.id, "promoted")}>Promote</button>}
                  {e.state !== "dropped" && e.state !== "promoted" && <button className="ghost sm" onClick={() => move(e.id, "dropped")}>Drop</button>}
                  {e.state === "dropped" && <button className="ghost sm" onClick={() => move(e.id, "proposed")}>Bring back</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {dropped > 0 && <label className="muted"><input type="checkbox" checked={showDropped} onChange={(e) => setShowDropped(e.target.checked)} /> Show {dropped} dropped</label>}
    </section>
  );
}
