import { useEffect, useState } from "react";
import { API, post, type SfEvent } from "./api";
import { ago } from "./FeatureMap";

/**
 * The Brain (packages/core/src/brain/): SoftwareFactory's principles, written once.
 * Every station's agent gets the principles that name its station in front of its contract,
 * so an edit here reaches the next call of every loop. The checks in code are listed per
 * principle; the matrix shows who follows what; the prompt viewer shows exactly what an
 * agent reads now.
 *
 * It also proves it is alive: the use strip and each card count the agent calls that read the
 * principles, the history lists every change, and the rules you wrote in Rules and ideas are offered
 * here, to add with one press (packages/core/src/brain/learn.ts).
 */
interface Principle {
  id: string; title: string; text: string; stations: string[]; enabled: boolean; enforcedBy?: string[];
  builtin: boolean; edited: boolean; version: number; updatedAt: string | null; by: string | null;
  source?: { kind: "rule"; fragment: number; node?: string };
}
interface Use {
  reads: number; lastReadAt: string | null; changes: number; lastChangeAt: string | null;
  byPrinciple: Record<string, { reads: number; lastReadAt: string | null }>;
  history: { id: number; ts: string; what: "saved" | "reset" | "dismissed"; principle: string | null; title: string; by: string; note?: string; fromRule: boolean }[];
}
interface Suggestion { fragment: number; text: string; kind: "rule" | "decision"; node: string | null; important: boolean; ts: string; title: string }
interface BrainState { principles: Principle[]; stations: string[]; crew: Record<string, string[]>; use?: Use; suggestions?: Suggestion[] }

const STATION_NAMES: Record<string, string> = {
  council: "Council", design: "Designer", critique: "Critic", evaluate: "Judge", plan: "Planner", tests: "Tester", build: "Builder", review: "Reviewer", fix: "Fixer",
  order: "Archivist", overseer: "Assistant", map: "Cartographer", survey: "Surveyor", inspect: "Inspector", verdict: "Assessor",
};

async function put(path: string, body: unknown) {
  const r = await fetch(`${API}${path}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? "request failed");
  return j;
}

export function BrainPage({ events }: { events: SfEvent[] }) {
  const [state, setState] = useState<BrainState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [station, setStation] = useState("plan");
  // Refetch on a change to the Brain, the crew or your rules, and when an agent call ends (a read to count).
  const at = events.filter((e) => e.type.startsWith("brain.") || e.type === "bay.assign" || e.type === "bay.agent.saved" || e.type === "agent.run.completed" || e.type === "order.fragment").at(-1)?.id ?? 0;
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    fetch(`${API}/api/brain`).then((r) => r.json()).then((j) => { setState(j); setErr(null); }).catch((e) => setErr(String(e.message ?? e)));
  }, [at]);

  if (!state) return <section className="br-page"><p className="muted">{err ? `The Brain cannot be read: ${err}` : "Reading the Brain…"}</p></section>;
  const on = state.principles.filter((p) => p.enabled);
  const use = state.use;
  const suggestions = state.suggestions ?? [];
  const act = async (fragment: number, what: "accept" | "dismiss") => {
    setBusy(fragment); setErr(null);
    try { setState(await post(`/api/brain/suggestions/${fragment}/${what}`)); } catch (x) { setErr((x as Error).message); } finally { setBusy(null); }
  };

  return (
    <section className="br-page">
      <header className="br-head">
        <div>
          <h2>Brain</h2>
          <p className="muted">The principles every loop follows. Each agent reads the ones that name its station before its instructions, on every call, so a change here reaches the next step of every run. Checks in code hold builds to them too.</p>
        </div>
        <button className="sm gate" onClick={() => setEditing("new")}>Add a principle</button>
      </header>
      {err && <p className="error" role="alert">{err}</p>}

      {use && (
        <div className="br-use" aria-label="How the Brain is used">
          <div><b>{use.reads.toLocaleString()}</b><span className="muted">agent calls read it</span></div>
          <div><b>{ago(use.lastReadAt)}</b><span className="muted">last read</span></div>
          <div><b>{use.changes}</b><span className="muted">{use.changes === 1 ? "change" : "changes"} so far</span></div>
          <p>{use.changes === 0
            ? "The Brain is wired in: every agent call above carried these principles. It has never changed because, until now, only typing here could change it. The rules you write in Rules and ideas are now offered below, to add with one press."
            : `Last changed ${ago(use.lastChangeAt)}. Every change reaches the next agent call on the stations it names.`}</p>
        </div>
      )}

      {editing === "new" && <PrincipleForm stations={state.stations} onCancel={() => setEditing(null)} onSave={async (body) => { setState(await post("/api/brain", body)); setEditing(null); }} />}

      <div className="br-list">
        {state.principles.map((p) => editing === p.id
          ? <PrincipleForm key={p.id} p={p} stations={state.stations} onCancel={() => setEditing(null)} onSave={async (body) => { setState(await put(`/api/brain/${encodeURIComponent(p.id)}`, body)); setEditing(null); }} />
          : (
            <article key={p.id} className={`br-card${p.enabled ? "" : " off"}`}>
              <header>
                <h3>{p.title}</h3>
                <span className="muted mono">{p.builtin ? (p.edited ? `edited · v${p.version}` : "default") : `yours · v${p.version}`}{p.enabled ? "" : " · off"}</span>
              </header>
              <p>{p.text}</p>
              {p.source && <span className="br-source">From your rule{p.source.node ? ` on "${p.source.node}"` : ""}</span>}
              <div className="br-stations" aria-label="Who follows it">{p.stations.map((s) => <span key={s} className="br-chip">{STATION_NAMES[s] ?? s}</span>)}</div>
              {!!p.enforcedBy?.length && <ul className="br-enforced">{p.enforcedBy.map((x) => <li key={x}>{x}</li>)}</ul>}
              {use && p.enabled && <span className="br-reads">{use.byPrinciple[p.id]?.reads
                ? <>Read by <b>{use.byPrinciple[p.id].reads.toLocaleString()}</b> agent calls{p.version ? " since this version" : ""}, last {ago(use.byPrinciple[p.id].lastReadAt)}</>
                : p.version ? "No agent call has read this version yet" : "No agent call has read it yet in this base"}</span>}
              <div className="br-actions">
                <button className="sm ghost" onClick={() => setEditing(p.id)}>Edit</button>
                <button className="sm ghost" onClick={async () => setState(await put(`/api/brain/${encodeURIComponent(p.id)}`, { ...p, enabled: !p.enabled }))}>{p.enabled ? "Turn off" : "Turn on"}</button>
                {(p.edited || !p.builtin) && <button className="sm ghost" onClick={async () => { if (confirm(p.builtin ? `Put "${p.title}" back to its default?` : `Remove "${p.title}"?`)) setState(await post(`/api/brain/${encodeURIComponent(p.id)}/reset`)); }}>{p.builtin ? "Reset to default" : "Remove"}</button>}
              </div>
            </article>
          ))}
      </div>

      <h3 className="br-sub">From your rules ({suggestions.length})</h3>
      {suggestions.length === 0
        ? <p className="br-none">Nothing waits. When you write a rule or a decision (in the Assistant, the Helm or Rules and ideas), it appears here, and one press makes it a principle every agent reads.</p>
        : (
          <div className="br-suggest">
            {suggestions.map((s) => (
              <div key={s.fragment} className="br-sug">
                <div>
                  <p>{s.text}</p>
                  <span className="muted">Your {s.kind}{s.node ? ` on "${s.node}"` : ""}{s.important ? " · marked important" : ""} · {ago(s.ts)}</span>
                </div>
                <div className="br-sug-actions">
                  <button className="sm" disabled={busy === s.fragment} onClick={() => act(s.fragment, "accept")} title="Makes it a principle for the agents that make and judge the product, in every project. You can edit its stations after.">Add to the Brain</button>
                  <button className="sm ghost" disabled={busy === s.fragment} onClick={() => act(s.fragment, "dismiss")} title="Keeps it as a rule where it is; it is not offered here again.">Not for the Brain</button>
                </div>
              </div>
            ))}
          </div>
        )}

      <h3 className="br-sub">Who follows what</h3>
      <div className="br-matrix-wrap">
        <table className="br-matrix">
          <thead><tr><th>Station</th><th className="muted">works it</th>{on.map((p) => <th key={p.id} title={p.title}>{p.title}</th>)}</tr></thead>
          <tbody>
            {state.stations.map((s) => (
              <tr key={s} className={s === station ? "on" : undefined} onClick={() => setStation(s)}>
                <td><b>{STATION_NAMES[s] ?? s}</b></td>
                <td className="muted">{state.crew[s]?.join(", ")}</td>
                {on.map((p) => <td key={p.id} className="br-cell">{p.stations.includes(s) ? "●" : ""}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <PromptViewer station={station} setStation={setStation} stations={state.stations} at={at} />

      <h3 className="br-sub">History of changes</h3>
      {use && use.history.length > 0
        ? (
          <ul className="br-history">
            {use.history.map((h) => (
              <li key={h.id}>
                <span className="muted">{ago(h.ts)}</span>
                <span>{h.what === "saved" ? (h.fromRule ? "Added from a rule" : "Saved") : h.what === "reset" ? "Reset or removed" : "Rule turned away"}</span>
                <span>{h.title}{h.note ? <span className="muted"> · {h.note}</span> : null}</span>
                <span className="muted">{h.by}</span>
              </li>
            ))}
          </ul>
        )
        : <p className="br-none">No change yet. Every add, edit, reset and rule you turn away will be listed here.</p>}
    </section>
  );
}

function PromptViewer({ station, setStation, stations, at }: { station: string; setStation: (s: string) => void; stations: string[]; at: number }) {
  const [prompt, setPrompt] = useState<{ name: string; prompt: string } | null>(null);
  useEffect(() => {
    fetch(`${API}/api/brain/prompt?station=${station}`).then((r) => r.json()).then(setPrompt).catch(() => setPrompt(null));
  }, [station, at]);
  return (
    <div className="br-prompt">
      <div className="br-prompt-head">
        <h3 className="br-sub">What the agent reads</h3>
        <label>Station <select value={station} onChange={(e) => setStation(e.target.value)}>{stations.map((s) => <option key={s} value={s}>{STATION_NAMES[s] ?? s}</option>)}</select></label>
      </div>
      <p className="muted">{prompt ? `${prompt.name}'s full instructions on this station right now: its own prompt, the Brain's principles, then the station's contract.` : "Loading…"}</p>
      <pre className="br-prompt-text">{prompt?.prompt ?? ""}</pre>
    </div>
  );
}

function PrincipleForm({ p, stations, onSave, onCancel }: { p?: Principle; stations: string[]; onSave: (b: { title: string; text: string; stations: string[]; enabled: boolean; note?: string }) => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState(p?.title ?? "");
  const [text, setText] = useState(p?.text ?? "");
  const [picked, setPicked] = useState<string[]>(p?.stations ?? ["council", "plan", "build", "review", "fix"]);
  const [enabled, setEnabled] = useState(p?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <form className="br-card br-form" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr(null);
      try { await onSave({ title, text, stations: picked, enabled }); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
    }}>
      <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Say the rule in a few words" required /></label>
      <label>The rule<textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="What every agent on the picked stations must do, in plain words" required /></label>
      <fieldset className="br-pick">
        <legend>Stations that follow it</legend>
        {stations.map((s) => (
          <label key={s} className="br-check"><input type="checkbox" checked={picked.includes(s)} onChange={(e) => setPicked(e.target.checked ? [...picked, s] : picked.filter((x) => x !== s))} /> {STATION_NAMES[s] ?? s}</label>
        ))}
      </fieldset>
      <label className="br-check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> On</label>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="br-actions">
        <button className="sm gate" type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        <button className="sm ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
