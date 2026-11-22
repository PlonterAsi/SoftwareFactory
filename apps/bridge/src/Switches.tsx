import { useEffect, useState } from "react";
import { API } from "./api";
import { ago } from "./projects/builtin";

interface Switch {
  name: string; what: string; kind: "onoff" | "number" | "choice" | "text"; choices?: (string | null)[]; unset: string; live: boolean;
  value: string | null; from: "page" | "pc" | "default"; at?: string; pcValue?: string | null; needsRestart?: boolean; min?: number; max?: number;
}

const FROM: Record<Switch["from"], string> = { page: "Set by you here", pc: "Set in this PC's environment", default: "Default" };

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}/api/config/switches${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `The core said ${r.status}`);
  return j as T;
}

/** One switch's control: on/off, a pick list, or a box with Save. */
function Control({ s, set }: { s: Switch; set: (v: string | null) => void }) {
  const [draft, setDraft] = useState(s.value ?? "");
  useEffect(() => setDraft(s.value ?? ""), [s.value]);
  if (s.kind === "onoff") {
    // choices = [value when on, value when off]; null (unset) is one of them.
    const [onV, offV] = s.choices ?? ["1", null];
    const isOn = (s.value ?? null) === (onV ?? null);
    return <label className="cfg-switch"><input type="checkbox" checked={isOn} onChange={(e) => set(e.target.checked ? onV ?? null : offV ?? null)} /> {isOn ? "On" : "Off"}</label>;
  }
  if (s.kind === "choice") {
    return (
      <select value={s.value ?? ""} onChange={(e) => set(e.target.value || null)} aria-label={s.name}>
        <option value="">Unset ({s.unset})</option>
        {(s.choices ?? []).filter(Boolean).map((c) => <option key={c!} value={c!}>{c}</option>)}
      </select>
    );
  }
  return (
    <form className="cfg-switch-form" onSubmit={(e) => { e.preventDefault(); set(draft.trim() || null); }}>
      <input type={s.kind === "number" ? "number" : "text"} value={draft} placeholder={s.unset} min={s.min} max={s.max} onChange={(e) => setDraft(e.target.value)} aria-label={s.name} />
      {draft !== (s.value ?? "") && <button className="sm" type="submit">Save</button>}
    </form>
  );
}

/**
 * The SF_* switches you can change (configs/switches.ts). A value set here wins over this PC's environment and is
 * kept across restarts; Reset gives the PC's own value back. Some apply at once, the rest after a restart.
 */
export function SwitchesSection({ onChanged, onNames }: { onChanged: () => void; onNames?: (names: string[]) => void }) {
  const [list, setList] = useState<Switch[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => send<{ switches: Switch[] }>("GET", "").then((r) => { setList(r.switches); onNames?.(r.switches.map((s) => s.name)); }).catch((e) => setErr((e as Error).message));
  useEffect(() => { load(); }, []);
  if (!list) return null;
  const done = () => { setErr(null); load(); onChanged(); };
  const set = (name: string, value: string | null) => send("PUT", `/${encodeURIComponent(name)}`, { value }).then(done).catch((e) => setErr((e as Error).message));
  const reset = (name: string) => send("DELETE", `/${encodeURIComponent(name)}`).then(done).catch((e) => setErr((e as Error).message));
  const waiting = list.filter((s) => s.needsRestart).length;
  return (
    <section className="cfg-layer cfg-switches" aria-label="Switches">
      <h2>Switches <span className="muted">The SF_* settings behind the crew. A value set here wins over this PC's environment and stays after a restart.</span></h2>
      {err && <div className="err bases-err" role="alert">{err}</div>}
      {waiting > 0 && <p className="cfg-restart">{waiting} change{waiting === 1 ? "" : "s"} wait{waiting === 1 ? "s" : ""} for SoftwareFactory to restart.</p>}
      <table className="pj-table cfg-table">
        <thead><tr><th>Switch</th><th>Set to</th><th>Came from</th><th>Applies</th><th /></tr></thead>
        <tbody>
          {list.map((s) => (
            <tr key={s.name}>
              <td><b>{s.what}</b><div className="muted"><code>{s.name}</code></div></td>
              <td><Control s={s} set={(v) => set(s.name, v)} /></td>
              <td className="muted">{FROM[s.from]}{s.at ? `, ${ago(s.at)}` : ""}{s.from === "page" && s.pcValue != null ? ` (this PC says ${s.pcValue})` : ""}</td>
              <td className="muted">{s.needsRestart ? <span className="cfg-restart">After a restart</span> : s.live ? "At once" : "At start"}</td>
              <td className="cfg-acts">{s.from === "page" && <button className="ghost sm" onClick={() => reset(s.name)}>Reset</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
