import { useEffect, useState } from "react";
import { API, projectsApi, type ProjectSummary } from "./api";

export interface ProfileSetting { path: string; value: unknown; why?: string }
export interface Profile { id: string; name: string; note?: string; settings: ProfileSetting[]; savedAt?: string }
interface Assignment { scope: "global" | "project" | "ticket" | "run"; ref: string | null; profile: string }
interface Kind { pattern: string; layer: "how" | "who" | "where"; label: string; value: "model" | "usd" | "advisor" | "bool" | "flow" | "minutes" }
interface ProfilesReport { profiles: Profile[]; assignments: Assignment[]; kinds: Kind[] }

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}/api/config${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.problems?.join(" ") ?? j.error ?? `The core said ${r.status}`);
  return j as T;
}

export function useProfiles() {
  const [rep, setRep] = useState<ProfilesReport | null>(null);
  const refresh = () => send<ProfilesReport>("GET", "/profiles").then(setRep).catch(() => undefined);
  useEffect(() => { refresh(); }, []);
  return { rep, refresh };
}

const LAYER: Record<string, string> = { how: "How", who: "Who", where: "Where" };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "profile";
const say = (v: unknown) => (v === null ? "off" : typeof v === "boolean" ? (v ? "on" : "off") : String(v));

/**
 * Profiles: named sets of settings, picked globally, per project, per ticket or per run. The narrowest
 * one that sets a thing wins; inside one profile two settings that touch the same thing are refused.
 */
export function ProfilesSection({ onChanged }: { onChanged: () => void }) {
  const { rep, refresh } = useProfiles();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [edit, setEdit] = useState<Profile | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { projectsApi.list().then(setProjects).catch(() => undefined); }, []);
  if (!rep) return null;
  const of = (scope: string, ref: string | null) => rep.assignments.find((a) => a.scope === scope && a.ref === ref)?.profile ?? "";
  const act = async (f: () => Promise<unknown>) => { setErr(null); try { await f(); await refresh(); onChanged(); } catch (e) { setErr((e as Error).message); } };
  const pick = (scope: string, ref: string | number | null, profile: string) => act(() => send("POST", "/assign", { scope, ref, profile: profile || null }));
  const others = { ticket: rep.assignments.filter((a) => a.scope === "ticket").length, run: rep.assignments.filter((a) => a.scope === "run").length };

  return (
    <section className="cfg-layer cfg-profiles" aria-label="Profiles">
      <h2>Profiles <span className="muted">Pick how SoftwareFactory works: everywhere, per project, or on one ticket. The narrowest profile wins.</span></h2>
      {err && <div className="err bases-err" role="alert">{err}</div>}
      <div className="cfg-assign">
        <label><span className="muted">Everywhere</span>
          <select value={of("global", null)} onChange={(e) => pick("global", null, e.target.value)}>
            <option value="">No profile (as listed below)</option>
            {rep.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        {projects.map((pr) => (
          <label key={pr.id}><span className="muted">{pr.name}</span>
            <select value={of("project", String(pr.id))} onChange={(e) => pick("project", pr.id, e.target.value)}>
              <option value="">Same as everywhere</option>
              {rep.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        ))}
      </div>
      {(others.ticket > 0 || others.run > 0) && <p className="muted">Also set on {others.ticket} ticket{others.ticket === 1 ? "" : "s"} and {others.run} run{others.run === 1 ? "" : "s"} (change those on the ticket).</p>}
      <div className="cfg-plist">
        {rep.profiles.map((p) => (
          <div key={p.id} className="cfg-pcard">
            <div className="cfg-pcard-head"><b>{p.name}</b> <code className="muted">{p.id}</code>
              <span className="cfg-pcard-acts"><button className="ghost sm" onClick={() => setEdit(p)}>Edit</button><button className="ghost sm" onClick={() => act(() => send("DELETE", `/profiles/${encodeURIComponent(p.id)}`))}>Remove</button></span>
            </div>
            {p.note && <p className="muted">{p.note}</p>}
            {!p.settings.length ? <p className="muted">No settings: same as no profile.</p> : (
              <ul>{p.settings.map((s) => <li key={s.path}><code>{s.path}</code> = <b>{say(s.value)}</b>{s.why ? <span className="muted"> · {s.why}</span> : null}</li>)}</ul>
            )}
          </div>
        ))}
        <button className="cfg-pnew" onClick={() => setEdit({ id: "", name: "", settings: [] })}>New profile</button>
      </div>
      {edit && <ProfileEditor p={edit} kinds={rep.kinds} isNew={!rep.profiles.some((x) => x.id === edit.id)} onCancel={() => setEdit(null)}
        onSave={(p) => act(async () => { await send("PUT", `/profiles/${encodeURIComponent(p.id)}`, { profile: p }); setEdit(null); })} />}
    </section>
  );
}

function ProfileEditor({ p, kinds, isNew, onSave, onCancel }: { p: Profile; kinds: Kind[]; isNew: boolean; onSave: (p: Profile) => void; onCancel: () => void }) {
  const [name, setName] = useState(p.name);
  const [note, setNote] = useState(p.note ?? "");
  const [rows, setRows] = useState<{ path: string; value: string; why: string }[]>(p.settings.map((s) => ({ path: s.path, value: say(s.value), why: s.why ?? "" })));
  const kindOf = (path: string) => kinds.find((k) => new RegExp(`^${k.pattern.replace(/\./g, "\\.").replace(/<[a-z]+>/g, "[a-z0-9-]+")}$`).test(path));
  const value = (path: string, v: string): unknown => {
    const k = kindOf(path);
    if (k?.value === "usd" || k?.value === "minutes") return Number(v);
    if (k?.value === "bool") return v === "on" || v === "true";
    if (k?.value === "advisor") return v === "off" || !v ? null : v;
    return v;
  };
  const dupes = new Set(rows.map((r) => r.path).filter((x, i, a) => a.indexOf(x) !== i));
  return (
    <div className="cfg-editor" role="dialog" aria-label="Edit profile">
      <label>Name <input value={name} onChange={(e) => setName(e.target.value)} placeholder="For example: Cheap bug fixing" /></label>
      <label>Note <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What it is for" /></label>
      <table className="pj-table">
        <thead><tr><th>Setting (what it touches)</th><th>Value</th><th>Why</th><th /></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={dupes.has(r.path) ? "cfg-clash" : ""}>
              <td><input value={r.path} list="cfg-paths" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))} placeholder="agent.builder.model" />
                <div className="muted">{dupes.has(r.path) ? "Another setting touches this. Keep one." : kindOf(r.path) ? `${LAYER[kindOf(r.path)!.layer]}: ${kindOf(r.path)!.label}` : ""}</div></td>
              <td><input value={r.value} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder="opus, 0.4, on, refactor…" /></td>
              <td><input value={r.why} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, why: e.target.value } : x)))} /></td>
              <td><button className="ghost sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <datalist id="cfg-paths">{kinds.map((k) => <option key={k.pattern} value={k.pattern}>{k.label}</option>)}</datalist>
      <p className="muted">Settings: {kinds.map((k) => k.pattern).join(" · ")}</p>
      <div className="cfg-editor-acts">
        <button className="ghost" onClick={() => setRows([...rows, { path: "", value: "", why: "" }])}>Add a setting</button>
        <span style={{ flex: 1 }} />
        <button className="ghost" onClick={onCancel}>Cancel</button>
        <button disabled={!name.trim() || dupes.size > 0} onClick={() => onSave({ id: isNew ? slug(name) : p.id, name, note, settings: rows.filter((r) => r.path).map((r) => ({ path: r.path, value: value(r.path, r.value), ...(r.why ? { why: r.why } : {}) })) })}>Save</button>
      </div>
    </div>
  );
}

/** The profile one ticket uses: its project's (or the global one) unless picked here. */
export function TicketProfile({ ticket }: { ticket: number }) {
  const { rep, refresh } = useProfiles();
  const [err, setErr] = useState<string | null>(null);
  if (!rep || !rep.profiles.length) return null;
  const cur = rep.assignments.find((a) => a.scope === "ticket" && a.ref === String(ticket))?.profile ?? "";
  return (
    <div className="ranwith"><span className="muted">Profile</span>{" "}
      <select value={cur} onChange={(e) => { setErr(null); send("POST", "/assign", { scope: "ticket", ref: ticket, profile: e.target.value || null }).then(refresh).catch((x) => setErr((x as Error).message)); }}>
        <option value="">The project's (or everywhere)</option>
        {rep.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      {err && <span className="err"> {err}</span>}
    </div>
  );
}
