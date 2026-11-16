import { useEffect, useMemo, useState } from "react";
import { API, post, type SfEvent } from "./api";
import { StatusTag, EmptyState, type Status } from "./ui";

/**
 * The Feature map (packages/core/src/featuremap/): one record per feature of SoftwareFactory, with
 * its wiring read from the real code and its proof of life from the event log.
 *
 *   #/map        every feature by group, the totals, and what is connected to nothing
 *   #/map/brain  one feature: its record (purpose, spec, flow, design), what it uses and what uses it,
 *                the events and tables it shares, when it last ran, its loose ends and its code
 * Records are edited here in a form; what a feature owns in code is checked by the test run.
 */
interface Link { feature: string; name: string; code: number; events: string[]; api: string[]; tables: string[] }
type State = "alive" | "never" | "untraced" | "planned";
interface Feature {
  id: string; name: string; group: string; purpose: string; spec: string[]; flow: string[]; design: string;
  screens: string[]; docs: string[]; stations: string[]; files: string[]; api: string[];
  builtin: boolean; edited: boolean; version: number; updatedAt: string | null; by: string | null;
  code: { files: { path: string; lines: number }[]; lines: number };
  writes: string[]; reads: string[]; tables: string[]; uses: Link[]; usedBy: Link[];
  alive: { events: number; lastAt: string | null; lastType: string | null; calls: number; lastCallAt: string | null; byType: { type: string; n: number; lastAt: string }[] };
  state: State; loose: string[];
}
interface MapData {
  features: Feature[]; groups: string[];
  totals: { features: number; alive: number; never: number; untraced: number; planned: number; files: number; lines: number; events: number; tables: number; apiAreas: number };
  loose: { unownedFiles: string[]; unownedApi: string[]; eventsNeverWritten: string[]; eventsNeverRead: { type: string; feature: string | null }[]; apiNeverCalled: { area: string; feature: string | null }[] };
}

const STATE: Record<State, { status: Status; word: string; hint: string }> = {
  alive: { status: "done", word: "Alive", hint: "It ran in this base: its events are in the log." },
  never: { status: "idle", word: "Never ran", hint: "It is built, but none of its events are in this base's log." },
  untraced: { status: "idle", word: "No trace", hint: "It writes no events, so the app cannot show when it was last used." },
  planned: { status: "idle", word: "Planned", hint: "A record with no code yet." },
};
const STATION_NAMES: Record<string, string> = {
  council: "Council", design: "Designer", critique: "Critic", plan: "Planner", tests: "Tester", build: "Builder", review: "Reviewer", evaluate: "Judge", fix: "Fixer",
  order: "Archivist", overseer: "Assistant", improve: "Improvement Council", map: "Cartographer", survey: "Surveyor", inspect: "Inspector", verdict: "Assessor",
};
const STATIONS = Object.keys(STATION_NAMES);

export function ago(ts: string | null): string {
  if (!ts) return "never";
  const m = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 60 * 36) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}
const short = (p: string) => p.replace("packages/core/src/", "core/").replace("apps/bridge/src/", "bridge/").replace("src-tauri/src/", "shell/");
const via = (l: Link) => [l.code ? `${l.code} import${l.code > 1 ? "s" : ""}` : "", l.events.length ? `${l.events.length} event${l.events.length > 1 ? "s" : ""}` : "", l.api.length ? "API" : "", l.tables.length ? `${l.tables.length} table${l.tables.length > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ");

async function put(path: string, body: unknown) {
  const r = await fetch(`${API}${path}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? "request failed");
  return j;
}

export function FeatureMapPage({ events, id, go }: { events: SfEvent[]; id?: string; go: (id?: string) => void }) {
  const [data, setData] = useState<MapData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | State | "loose">("all");
  const [q, setQ] = useState("");
  // Refetch when a record changes, and every so often as the log grows (proof of life moves with it).
  const at = events.filter((e) => e.type.startsWith("featuremap.")).at(-1)?.id ?? 0;
  const tick = Math.floor(events.length / 25);
  useEffect(() => {
    fetch(`${API}/api/feature-map`).then((r) => r.json()).then((j) => { if (j.error) throw new Error(j.error); setData(j); setErr(null); }).catch((e) => setErr(String(e.message ?? e)));
  }, [at, tick]);

  const shown = useMemo(() => (data?.features ?? []).filter((f) =>
    (filter === "all" || (filter === "loose" ? f.loose.length > 0 : f.state === filter))
    && (!q.trim() || `${f.name} ${f.purpose} ${f.id}`.toLowerCase().includes(q.trim().toLowerCase()))), [data, filter, q]);

  if (!data) return <section className="fm-page"><p className="muted">{err ? `The feature map cannot be read: ${err}` : "Reading the feature map…"}</p></section>;
  const picked = id ? data.features.find((f) => f.id === id) : undefined;
  const t = data.totals;
  const looseCount = data.loose.eventsNeverWritten.length + data.loose.eventsNeverRead.length + data.loose.apiNeverCalled.length + data.loose.unownedFiles.length + data.loose.unownedApi.length;

  return (
    <section className="fm-page">
      <header className="br-head">
        <div>
          <h2>Feature map</h2>
          <p className="muted">Every feature of SoftwareFactory has one record here: what it is for, what it must do, how it flows and where it lives. What it is connected to is read from the code, and whether it is alive is read from this base's log.</p>
        </div>
        <button className="sm gate" onClick={() => setEditing("new")}>Add a feature</button>
      </header>
      {err && <p className="error" role="alert">{err}</p>}

      <div className="fm-totals" role="list">
        <Total n={t.features} label="features" on={filter === "all"} onClick={() => setFilter("all")} />
        <Total n={t.alive} label="alive" tone="good" on={filter === "alive"} onClick={() => setFilter("alive")} />
        <Total n={t.never} label="never ran" tone="flag" on={filter === "never"} onClick={() => setFilter("never")} />
        <Total n={t.untraced} label="leave no trace" on={filter === "untraced"} onClick={() => setFilter("untraced")} />
        {t.planned > 0 && <Total n={t.planned} label="planned" on={filter === "planned"} onClick={() => setFilter("planned")} />}
        <Total n={data.features.filter((f) => f.loose.length).length} label="with loose ends" on={filter === "loose"} onClick={() => setFilter("loose")} />
        <span className="fm-total-note muted">{t.files} files · {t.lines.toLocaleString()} lines · {t.events} event types · {t.tables} tables · {t.apiAreas} API areas, all owned by a feature</span>
      </div>

      {editing === "new" && <RecordForm groups={data.groups} onCancel={() => setEditing(null)} onSave={async (b) => { const j = await post("/api/feature-map", b); setData(j); setEditing(null); go(j.id); }} />}

      <div className="fm-body">
        <nav className="fm-list" aria-label="Features">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a feature" aria-label="Find a feature" />
          <button className={`fm-item fm-all${!picked ? " on" : ""}`} onClick={() => go()}><span className="fm-item-name">The whole map</span><span className="muted">{looseCount} loose ends</span></button>
          {data.groups.map((g) => {
            const list = shown.filter((f) => f.group === g);
            if (!list.length) return null;
            return (
              <div key={g} className="fm-group">
                <div className="sb-label">{g}</div>
                {list.map((f) => (
                  <button key={f.id} className={`fm-item s-${f.state}${picked?.id === f.id ? " on" : ""}`} onClick={() => go(f.id)} aria-current={picked?.id === f.id ? "page" : undefined} title={STATE[f.state].hint}>
                    <span className={`fm-dot s-${f.state}`} aria-hidden />
                    <span className="fm-item-name">{f.name}</span>
                    {f.loose.length > 0 && <span className="fm-loose-n" title={f.loose.join("\n")}>{f.loose.length}</span>}
                  </button>
                ))}
              </div>
            );
          })}
          {!shown.length && <p className="muted fm-none">No feature matches.</p>}
        </nav>

        <div className="fm-detail">
          {picked
            ? editing === picked.id
              ? <RecordForm f={picked} groups={data.groups} onCancel={() => setEditing(null)} onSave={async (b) => { setData(await put(`/api/feature-map/${encodeURIComponent(picked.id)}`, b)); setEditing(null); }} />
              : <FeaturePage f={picked} all={data.features} go={go} onEdit={() => setEditing(picked.id)}
                  onReset={async () => { if (confirm(picked.builtin ? `Put the record of "${picked.name}" back to the one in code?` : `Remove "${picked.name}"?`)) { setData(await post(`/api/feature-map/${encodeURIComponent(picked.id)}/reset`)); if (!picked.builtin) go(); } }} />
            : <Overview data={data} shown={shown} go={go} />}
        </div>
      </div>
    </section>
  );
}

function Total({ n, label, tone, on, onClick }: { n: number; label: string; tone?: "good" | "flag"; on: boolean; onClick: () => void }) {
  return <button role="listitem" className={`fm-total${on ? " on" : ""}${tone ? ` t-${tone}` : ""}`} onClick={onClick} aria-pressed={on}><b className="num">{n}</b><span>{label}</span></button>;
}

/** The whole map: every feature as a tile sized by nothing, coloured by state, with its links counted; then what is connected to nothing. */
function Overview({ data, shown, go }: { data: MapData; shown: Feature[]; go: (id?: string) => void }) {
  const name = (id: string | null) => data.features.find((f) => f.id === id)?.name ?? "no feature";
  const L = data.loose;
  return (
    <>
      {data.groups.map((g) => {
        const list = shown.filter((f) => f.group === g);
        if (!list.length) return null;
        return (
          <div key={g} className="fm-band">
            <h3 className="br-sub">{g}</h3>
            <div className="fm-tiles">
              {list.map((f) => (
                <button key={f.id} className={`fm-tile s-${f.state}`} onClick={() => go(f.id)}>
                  <span className="fm-tile-head"><b>{f.name}</b><StatusTag status={STATE[f.state].status}>{STATE[f.state].word}</StatusTag></span>
                  <span className="fm-tile-purpose">{f.purpose}</span>
                  <span className="fm-tile-foot muted">
                    <span title="Features that depend on it">← {f.usedBy.length}</span>
                    <span title="Features it depends on">→ {f.uses.length}</span>
                    <span>{f.state === "alive" ? `last ${ago(f.alive.lastAt ?? f.alive.lastCallAt)}` : f.code.files.length ? `${f.code.files.length} files` : "no code yet"}</span>
                    {f.loose.length > 0 && <span className="fm-warn">{f.loose.length} loose</span>}
                  </span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
      {!shown.length && <EmptyState title="No feature matches">Clear the search box or pick another filter above.</EmptyState>}

      <h3 className="br-sub fm-loose-title">Connected to nothing</h3>
      <p className="muted fm-loose-lede">Read from the code. Each line is something that exists but has no other end.</p>
      <div className="fm-loose-grid">
        <LooseBox title="Events declared, never written" empty="Every declared event has a writer." items={L.eventsNeverWritten.map((t) => ({ key: t, text: t, note: "nothing appends it" }))} />
        <LooseBox title="Events written, never read by name" empty="Every written event has a reader." items={L.eventsNeverRead.map((x) => ({ key: x.type, text: x.type, note: `written by ${name(x.feature)}`, to: x.feature }))} go={go} />
        <LooseBox title="API areas no screen calls" empty="Every API area is called by a screen." items={L.apiNeverCalled.map((x) => ({ key: x.area, text: x.area, note: `answered by ${name(x.feature)}`, to: x.feature }))} go={go} />
        <LooseBox title="Code with no record" empty="Every source file and API area belongs to a feature. The test run fails when one does not." items={[...L.unownedFiles, ...L.unownedApi].map((t) => ({ key: t, text: t, note: "no feature owns it" }))} />
      </div>
    </>
  );
}

function LooseBox({ title, empty, items, go }: { title: string; empty: string; items: { key: string; text: string; note: string; to?: string | null }[]; go?: (id?: string) => void }) {
  return (
    <div className={`fm-loose-box${items.length ? " has" : ""}`}>
      <h4>{title} <span className="num muted">{items.length}</span></h4>
      {items.length === 0 ? <p className="muted">{empty}</p> : (
        <ul>{items.map((i) => <li key={i.key}><span className="mono">{i.text}</span> <span className="muted">{i.to && go ? <button className="link" onClick={() => go(i.to!)}>{i.note}</button> : i.note}</span></li>)}</ul>
      )}
    </div>
  );
}

function FeaturePage({ f, all, go, onEdit, onReset }: { f: Feature; all: Feature[]; go: (id?: string) => void; onEdit: () => void; onReset: () => void }) {
  const s = STATE[f.state];
  const last = [f.alive.lastAt, f.alive.lastCallAt].filter(Boolean).sort().at(-1) ?? null;
  return (
    <article className="fm-feature">
      <header className="fm-f-head">
        <div>
          <div className="muted fm-crumb"><button className="link" onClick={() => go()}>Feature map</button> / {f.group}</div>
          <h2>{f.name}</h2>
        </div>
        <div className="fm-f-actions">
          <StatusTag status={s.status}>{s.word}</StatusTag>
          <span className="muted mono">{f.builtin ? (f.edited ? `edited · v${f.version}` : "record in code") : `yours · v${f.version}`}</span>
          <button className="sm ghost" onClick={onEdit}>Edit the record</button>
          {(f.edited || !f.builtin) && <button className="sm ghost" onClick={onReset}>{f.builtin ? "Reset" : "Remove"}</button>}
        </div>
      </header>
      <p className="fm-purpose">{f.purpose}</p>

      <div className="fm-cols">
        <section className="fm-box">
          <h3 className="br-sub">Spec: what it must do</h3>
          {f.spec.length ? <ul className="fm-spec">{f.spec.map((x) => <li key={x}>{x}</li>)}</ul> : <p className="muted">Not written yet.</p>}
        </section>
        <section className="fm-box">
          <h3 className="br-sub">Flow: how it moves</h3>
          {f.flow.length ? <ol className="fm-flow">{f.flow.map((x, i) => <li key={i}><span className="fm-step-n num">{i + 1}</span><span>{x}</span></li>)}</ol> : <p className="muted">Not written yet.</p>}
        </section>
        <section className="fm-box">
          <h3 className="br-sub">Design: where it lives</h3>
          <p>{f.design || <span className="muted">Not written yet.</span>}</p>
          {f.screens.length > 0 && <p className="fm-kv"><span className="muted">Screens</span>{f.screens.map((x) => x.includes("ID") ? <span key={x} className="br-chip">#{x}</span> : <a key={x} className="br-chip fm-screen" href={`#${x}`}>#{x}</a>)}</p>}
          {f.stations.length > 0 && <p className="fm-kv"><span className="muted">Agents</span>{f.stations.map((x) => <span key={x} className="br-chip fm-agent">{STATION_NAMES[x] ?? x}</span>)}</p>}
          {f.docs.length > 0 && <p className="fm-kv"><span className="muted">Documents</span>{f.docs.map((x) => <span key={x} className="br-chip">{x}</span>)}</p>}
        </section>
      </div>

      <h3 className="br-sub">Connections, read from the code</h3>
      <Wires f={f} go={go} />

      <div className="fm-cols fm-cols-2">
        <section className="fm-box">
          <h3 className="br-sub">Proof of life</h3>
          <div className="fm-life">
            <div><b className="num">{f.alive.events.toLocaleString()}</b><span className="muted">of its events in the log</span></div>
            {f.stations.length > 0 && <div><b className="num">{f.alive.calls.toLocaleString()}</b><span className="muted">agent calls on its stations</span></div>}
            <div><b>{ago(last)}</b><span className="muted">{f.alive.lastType ? `last: ${f.alive.lastType}` : "last activity"}</span></div>
          </div>
          {f.alive.byType.length > 0
            ? <ul className="fm-bytype">{f.alive.byType.map((x) => { const max = Math.max(...f.alive.byType.map((y) => y.n)); return <li key={x.type}><span className="mono">{x.type}</span><span className="fm-bar"><i style={{ width: `${Math.max(3, (x.n / max) * 100)}%` }} /></span><span className="num">{x.n}</span><span className="muted">{ago(x.lastAt)}</span></li>; })}</ul>
            : <p className="muted">{f.state === "alive" ? "Its proof is the agent calls on its stations: each one read it." : s.hint}</p>}
        </section>
        <section className="fm-box">
          <h3 className="br-sub">Loose ends</h3>
          {f.loose.length ? <ul className="fm-loose">{f.loose.map((x) => <li key={x}>{x}</li>)}</ul> : <p className="fm-clean">Nothing loose: it has a complete record, it is connected, and it has run.</p>}
          <h3 className="br-sub fm-gap">Shared data</h3>
          <p className="fm-kv"><span className="muted">Writes</span>{f.writes.length ? f.writes.map((x) => <span key={x} className="br-chip">{x}</span>) : <span className="muted">no events</span>}</p>
          <p className="fm-kv"><span className="muted">Reads</span>{f.reads.length ? f.reads.map((x) => <span key={x} className="br-chip">{x}</span>) : <span className="muted">no events by name</span>}</p>
          <p className="fm-kv"><span className="muted">Tables</span>{f.tables.length ? f.tables.map((x) => <span key={x} className="br-chip">{x}</span>) : <span className="muted">none of its own</span>}</p>
          <p className="fm-kv"><span className="muted">API</span>{f.api.length ? f.api.map((x) => <span key={x} className="br-chip">{x}</span>) : <span className="muted">none</span>}</p>
        </section>
      </div>

      <details className="fm-code">
        <summary>Code: {f.code.files.length} files, {f.code.lines.toLocaleString()} lines</summary>
        <ul>{f.code.files.map((x) => <li key={x.path}><span className="mono">{short(x.path)}</span><span className="num muted">{x.lines}</span></li>)}</ul>
      </details>
      {all.length > 0 && f.updatedAt && <p className="muted fm-meta">Record last changed {ago(f.updatedAt)} by {f.by}.</p>}
    </article>
  );
}

/** What depends on it (left), the feature (centre), what it depends on (right), with a line per connection. */
function Wires({ f, go }: { f: Feature; go: (id?: string) => void }) {
  const left = f.usedBy.slice(0, 12), right = f.uses.slice(0, 12);
  const rows = Math.max(left.length, right.length, 1);
  const rowH = 44, h = rows * rowH + 16, w = 1000, colW = 300, mid = w / 2;
  const y = (i: number, n: number) => 8 + (rows - n) * rowH / 2 + i * rowH + rowH / 2;
  if (!left.length && !right.length) return <p className="muted fm-nowire">{f.code.files.length ? "No other feature imports it, reads its events, calls its API or queries its tables, and it uses none either." : "It has no code yet, so there is nothing to wire."}</p>;
  return (
    <div className="fm-wires">
      <div className="fm-wire-heads muted"><span>Depends on it ({f.usedBy.length})</span><span /><span>It depends on ({f.uses.length})</span></div>
      <div className="fm-wire-stage" style={{ height: h }}>
        <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
          {left.map((l, i) => <path key={l.feature} className="fm-wire" d={`M ${colW} ${y(i, left.length)} C ${colW + 80} ${y(i, left.length)}, ${mid - 170} ${h / 2}, ${mid - 90} ${h / 2}`} />)}
          {right.map((l, i) => <path key={l.feature} className="fm-wire" d={`M ${mid + 90} ${h / 2} C ${mid + 170} ${h / 2}, ${w - colW - 80} ${y(i, right.length)}, ${w - colW} ${y(i, right.length)}`} />)}
        </svg>
        <div className="fm-wire-col l">{left.map((l, i) => <WireNode key={l.feature} l={l} top={y(i, left.length)} go={go} />)}</div>
        <div className="fm-wire-me" style={{ top: h / 2 }}>{f.name}</div>
        <div className="fm-wire-col r">{right.map((l, i) => <WireNode key={l.feature} l={l} top={y(i, right.length)} go={go} />)}</div>
      </div>
      {(f.usedBy.length > 12 || f.uses.length > 12) && <p className="muted">Showing the 12 strongest on each side.</p>}
    </div>
  );
}

function WireNode({ l, top, go }: { l: Link; top: number; go: (id?: string) => void }) {
  const tip = [l.code ? `${l.code} imports` : "", l.events.length ? `events: ${l.events.join(", ")}` : "", l.api.length ? `API: ${l.api.join(", ")}` : "", l.tables.length ? `tables: ${l.tables.join(", ")}` : ""].filter(Boolean).join("\n");
  return <button className="fm-wire-node" style={{ top }} onClick={() => go(l.feature)} title={tip}><b>{l.name}</b><span className="muted">{via(l)}</span></button>;
}

function RecordForm({ f, groups, onSave, onCancel }: { f?: Feature; groups: string[]; onSave: (b: Record<string, unknown>) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(f?.name ?? "");
  const [group, setGroup] = useState(f?.group ?? "Library");
  const [purpose, setPurpose] = useState(f?.purpose ?? "");
  const [spec, setSpec] = useState((f?.spec ?? []).join("\n"));
  const [flow, setFlow] = useState((f?.flow ?? []).join("\n"));
  const [design, setDesign] = useState(f?.design ?? "");
  const [screens, setScreens] = useState((f?.screens ?? []).join("\n"));
  const [docs, setDocs] = useState((f?.docs ?? []).join("\n"));
  const [stations, setStations] = useState<string[]>(f?.stations ?? []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <form className="br-card br-form fm-form" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr(null);
      try { await onSave({ name, group, purpose, spec, flow, design, screens, docs, stations }); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
    }}>
      <h3>{f ? `Edit the record of ${f.name}` : "Add a feature"}</h3>
      {!f && <p className="muted">A feature added here is a plan: it has a record but no code yet. When it is built, its code is tied to the record and it shows as alive once it runs.</p>}
      <div className="fm-form-row">
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="What the feature is called" required /></label>
        <label>Group<select value={group} onChange={(e) => setGroup(e.target.value)}>{groups.map((g) => <option key={g}>{g}</option>)}</select></label>
      </div>
      <label>Purpose<textarea rows={2} value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Why it exists, in a sentence or two" required /></label>
      <div className="fm-form-row">
        <label>Spec: what it must do, one per line<textarea rows={6} value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="One requirement per line" /></label>
        <label>Flow: the steps, one per line<textarea rows={6} value={flow} onChange={(e) => setFlow(e.target.value)} placeholder="One step per line, in order" /></label>
      </div>
      <label>Design: where it lives in the app<textarea rows={2} value={design} onChange={(e) => setDesign(e.target.value)} placeholder="Which screen, and how it shows itself" /></label>
      <div className="fm-form-row">
        <label>Screens, one per line<textarea rows={2} value={screens} onChange={(e) => setScreens(e.target.value)} placeholder="/brain" /></label>
        <label>Documents, one per line<textarea rows={2} value={docs} onChange={(e) => setDocs(e.target.value)} placeholder="docs/apps.md" /></label>
      </div>
      <fieldset className="br-pick">
        <legend>Agents that work in it</legend>
        {STATIONS.map((s) => <label key={s} className="br-check"><input type="checkbox" checked={stations.includes(s)} onChange={(e) => setStations(e.target.checked ? [...stations, s] : stations.filter((x) => x !== s))} /> {STATION_NAMES[s]}</label>)}
      </fieldset>
      {f?.builtin && <p className="muted">The files and API areas it owns come from the code and are kept true by the test run, so they are not edited here.</p>}
      {err && <p className="error" role="alert">{err}</p>}
      <div className="br-actions">
        <button className="sm gate" type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        <button className="sm ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
