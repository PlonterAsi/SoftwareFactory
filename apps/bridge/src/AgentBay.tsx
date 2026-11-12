import { useEffect, useMemo, useRef, useState } from "react";
import { SLOTS, SLOT_LABEL, bayApi, type AgentDef, type AgentStats, type AgentView, type BayLibrary, type BayState, type BayTest, type Slot } from "./api";

/**
 * The Agent Bay: every worker is a crew card (avatar, state, current task, cost).
 * Drag a card onto a station seat to put it to work; open it to edit (every save
 * is a version), test it on a sample task, compare versions and roll back.
 */
export function AgentBay({ bay }: { bay: BayState }) {
  const [sel, setSel] = useState<string>("planner");
  const [err, setErr] = useState<string | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const agents = bay.agents.filter((a) => showRetired || !a.retired);
  const selected = bay.agents.find((a) => a.def.id === sel) ?? bay.agents[0];
  const total = Object.values(bay.stats).reduce((s, x) => s + x.costUsd, 0);
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); } catch (e) { setErr((e as Error).message); } };
  return (
    <section className="pane bay" aria-label="Agents">
      <header className="pane-head">
        <span>Agents</span>
        <span className="muted mono">{bay.agents.filter((a) => !a.retired).length} agents · {Object.values(bay.stats).reduce((s, x) => s + x.calls, 0)} calls · ${total.toFixed(4)}</span>
      </header>
      <NewAgent onMade={(a) => setSel(a.def.id)} onError={setErr} />
      {err && <div className="bay-err err" role="alert">{err} <button className="link" onClick={() => setErr(null)}>dismiss</button></div>}
      <div className="bay-body">
        <div className="bay-left">
          <StationBoard bay={bay} onSelect={setSel} onAssign={(slot, ids) => run(() => bayApi.assign(slot, ids))} />
          <div className="crew-head">
            <span className="b-sub muted">Crew · drag a card onto a station seat</span>
            <label className="muted tiny-label"><input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} /> retired</label>
          </div>
          <div className="crew-grid">
            {agents.map((a) => <CrewCard key={a.def.id} a={a} st={bay.stats[a.def.id]} on={a.def.id === selected?.def.id} slots={bay.slots} onClick={() => setSel(a.def.id)} />)}
          </div>
        </div>
        <div className="bay-right">
          {selected ? <AgentPanel key={selected.def.id + ":" + selected.version} a={selected} bay={bay} onSelect={setSel} onError={setErr} onAssign={(slot, ids) => run(() => bayApi.assign(slot, ids))} /> : <div className="empty">Loading the crew…</div>}
        </div>
      </div>
    </section>
  );
}

function stationsOf(id: string, slots: Record<Slot, string[]>): Slot[] {
  return SLOTS.filter((s) => slots[s]?.includes(id));
}

function Avatar({ a, st, size = 34 }: { a: AgentDef; st?: AgentStats; size?: number }) {
  const r = size / 2 - 2;
  const rate = st?.passRate;
  const c = 2 * Math.PI * (r - 1);
  return (
    <svg className={`avatar s-${st?.state ?? "idle"}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle className="av-bg" cx={size / 2} cy={size / 2} r={r} />
      {/* The ring is the verifier pass rate. */}
      {rate != null && <circle className="av-rate" cx={size / 2} cy={size / 2} r={r - 1} strokeDasharray={`${c * rate} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />}
      <text x="50%" y="54%" dominantBaseline="middle" textAnchor="middle" fontSize={size * 0.45}>{a.avatar}</text>
    </svg>
  );
}

function CrewCard({ a, st, on, slots, onClick }: { a: AgentView; st?: AgentStats; on: boolean; slots: Record<Slot, string[]>; onClick: () => void }) {
  const working = stationsOf(a.def.id, slots);
  const state = st?.state ?? "idle";
  return (
    <button className={`crew-card${on ? " on" : ""}${a.retired ? " retired" : ""}`} draggable={!a.retired} onClick={onClick}
      onDragStart={(e) => { e.dataTransfer.setData("text/agent", a.def.id); e.dataTransfer.effectAllowed = "copy"; }}
      title={`${a.def.name} v${a.version}: ${a.def.description}\n${loadoutNames(a.def)}`} aria-pressed={on}>
      <Avatar a={a.def} st={st} />
      <span className="cc-main">
        <span className="cc-name">{a.def.name} <span className="mono muted">v{a.version}</span></span>
        <span className="cc-sub mono"><span className={`model m-${a.def.model}`}>{a.def.model}</span> {working.length ? working.map((s) => SLOT_LABEL[s]).join(", ") : <span className="muted">bench</span>}</span>
        <span className={`cc-state st-${state}`}>{state === "thinking" ? `thinking · ${st?.current ?? ""}` : state === "blocked" ? "blocked · last call failed" : a.retired ? "retired" : "idle"}<span className="cc-kit muted"> · {kitShort(a.def)}</span></span>
      </span>
      <span className="cc-cost mono">${(st?.costUsd ?? 0).toFixed(4)}<br /><span className="muted">{st?.passRate != null ? `${Math.round(st.passRate * 100)}% pass` : "no runs"}</span></span>
    </button>
  );
}

function StationBoard({ bay, onSelect, onAssign }: { bay: BayState; onSelect: (id: string) => void; onAssign: (slot: Slot, ids: string[]) => void }) {
  const [over, setOver] = useState<string | null>(null);
  const byId = new Map(bay.agents.map((a) => [a.def.id, a]));
  const live = bay.agents.filter((a) => !a.retired);
  const put = (slot: Slot, seat: number, id: string) => {
    const cur = [...(bay.slots[slot] ?? [])];
    // Emptying a seat: only while another agent still sits on the station.
    if (!id) { if (cur.length > 1) onAssign(slot, cur.filter((_, i) => i !== seat)); return; }
    const without = cur.filter((x) => x !== id);
    const next = seat < cur.length ? cur.map((x, i) => (i === seat ? id : x)) : [...without, id];
    onAssign(slot, [...new Set(next)].slice(0, bay.seats[slot] ?? 1));
  };
  return (
    <div className="board" role="list" aria-label="Stations">
      {SLOTS.map((slot) => {
        const seats = bay.seats[slot] ?? 1;
        const ids = bay.slots[slot] ?? [];
        return (
          <div key={slot} className="slot" role="listitem">
            <span className="slot-name">{SLOT_LABEL[slot]}</span>
            <span className="seats">
              {Array.from({ length: seats }, (_, i) => {
                const a = ids[i] ? byId.get(ids[i]) : undefined;
                const key = `${slot}:${i}`;
                return (
                  <span key={key} className={`seat${a ? "" : " empty-seat"}${over === key ? " over" : ""}`}
                    onDragOver={(e) => { e.preventDefault(); setOver(key); }} onDragLeave={() => setOver(null)}
                    onDrop={(e) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData("text/agent"); if (id) put(slot, i, id); }}>
                    {a ? <button className="seat-agent" onClick={() => onSelect(a.def.id)} title={`${a.def.name} v${a.version} · ${a.def.model}`}><span className="seat-av">{a.def.avatar}</span>{a.def.name}</button> : <span className="muted">drop here</span>}
                    <select className="seat-pick" title="Choose who sits here" aria-label={`${SLOT_LABEL[slot]} seat ${i + 1}`} value={a?.def.id ?? ""} onChange={(e) => put(slot, i, e.target.value)}>
                      {(!a || ids.length > 1) && <option value="">{a ? "empty this seat" : "choose…"}</option>}
                      {live.map((x) => <option key={x.def.id} value={x.def.id}>{x.def.name}</option>)}
                    </select>
                  </span>
                );
              })}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function NewAgent({ onMade, onError }: { onMade: (a: AgentView) => void; onError: (e: string) => void }) {
  const [line, setLine] = useState("");
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const go = async (fn: () => Promise<AgentView>) => {
    setBusy(true);
    try { onMade(await fn()); setLine(""); } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <form className="new-agent" onSubmit={(e) => { e.preventDefault(); if (line.trim()) go(() => bayApi.draft(line)); }}>
      <input value={line} onChange={(e) => setLine(e.target.value)} placeholder='Describe a new agent in one line, e.g. "a careful reviewer called Hawk that checks for security holes"' aria-label="Describe a new agent" />
      <button disabled={busy || !line.trim()}>{busy ? "Drafting…" : "Draft agent"}</button>
      <button type="button" className="ghost" disabled={busy} onClick={() => file.current?.click()} title="Import an agent file (ours or a Claude Code subagent .md)">Import .md</button>
      <input ref={file} type="file" accept=".md,.markdown,text/markdown,text/plain" hidden onChange={async (e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (f) go(async () => bayApi.importFile(await f.text()));
      }} />
    </form>
  );
}

type Tab = "edit" | "versions" | "tests" | "stats";

function AgentPanel({ a, bay, onSelect, onError, onAssign }: { a: AgentView; bay: BayState; onSelect: (id: string) => void; onError: (e: string) => void; onAssign: (slot: Slot, ids: string[]) => void }) {
  const [tab, setTab] = useState<Tab>("edit");
  const st = bay.stats[a.def.id];
  const tests = bay.tests.filter((t) => t.agent === a.def.id);
  const working = stationsOf(a.def.id, bay.slots);
  // Made for a station but not working one: one press seats it (a free seat, or the station's only seat).
  const home = a.def.station !== "none" && !a.retired && !working.includes(a.def.station as Slot) ? (a.def.station as Slot) : null;
  const homeIds = home ? bay.slots[home] ?? [] : [];
  const homeSeats = home ? bay.seats[home] ?? 1 : 0;
  return (
    <div className="agent-panel">
      <div className="ap-head">
        <Avatar a={a.def} st={st} size={46} />
        <div className="ap-title">
          <div className="ap-name">{a.def.name} <span className="mono muted">v{a.version}{a.builtin ? " · built-in" : ""}{a.retired ? " · retired" : ""}</span></div>
          <div className="muted ap-desc">{a.def.description || "No description yet."}</div>
          <div className="mono ap-meta"><span className={`model m-${a.def.model}`}>{a.def.model}</span> cap ${a.def.budgetUsd.toFixed(2)}/call · {loadout(a.def)} · {working.length ? `on ${working.map((s) => SLOT_LABEL[s]).join(", ")}` : "on the bench"}</div>
          {home && (homeIds.length < homeSeats
            ? <button className="sm" onClick={() => onAssign(home, [...homeIds, a.def.id])}>Seat it on {SLOT_LABEL[home]}</button>
            : <span className="muted">{SLOT_LABEL[home]} is full ({homeSeats} seat{homeSeats > 1 ? "s" : ""}): pick a seat on the station board to swap it in.</span>)}
        </div>
      </div>
      <div className="tabs ap-tabs" role="tablist">
        {([["edit", "Edit"], ["versions", `Versions · ${a.versions.length}`], ["tests", `Tests${tests.length ? ` · ${tests.filter((t) => t.pass).length}/${tests.filter((t) => t.state === "done").length}` : ""}`], ["stats", "Stats"]] as [Tab, string][]).map(([id, label]) =>
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "tab on" : "tab"} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      <div className="ap-body">
        {tab === "edit" && <Editor a={a} models={bay.models} lib={bay.library} onSelect={onSelect} onError={onError} />}
        {tab === "versions" && <Versions a={a} onError={onError} />}
        {tab === "tests" && <Tests a={a} tests={tests} onError={onError} />}
        {tab === "stats" && <Stats a={a} st={st} />}
      </div>
    </div>
  );
}

const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

/** What an agent loads, in one line: lean, or its skills, tools, MCP servers and plugins. */
function loadout(d: AgentDef): string {
  const n = (k: number, one: string) => `${k} ${one}${k > 1 ? "s" : ""}`;
  const parts = [d.skills.length && n(d.skills.length, "skill"), d.tools.length && n(d.tools.length, "tool"), d.mcp?.length && n(d.mcp.length, "MCP server"), d.plugins.length && n(d.plugins.length, "plugin")].filter(Boolean);
  return parts.length ? `loads ${parts.join(", ")}` : "lean (loads nothing extra)";
}

/** "3 skills · 4 tools · 1 MCP", or "lean": what this agent loads, for its card. */
function kitShort(d: AgentDef): string {
  const parts = [d.skills.length && `${d.skills.length} skill${d.skills.length > 1 ? "s" : ""}`, d.tools.length && `${d.tools.length} tool${d.tools.length > 1 ? "s" : ""}`, d.mcp?.length && `${d.mcp.length} MCP`, d.plugins.length && `${d.plugins.length} plugin${d.plugins.length > 1 ? "s" : ""}`].filter(Boolean);
  return parts.length ? parts.join(" · ") : "lean";
}

/** The names, for a tooltip. */
function loadoutNames(d: AgentDef): string {
  const line = (label: string, xs: string[] | undefined) => (xs?.length ? `${label}: ${xs.join(", ")}` : "");
  return [line("Skills", d.skills), line("Tools", d.tools), line("MCP", d.mcp), line("Plugins", d.plugins)].filter(Boolean).join("\n") || "Lean: loads nothing extra";
}

/**
 * One list of an agent's loadout: what THIS agent loads, as chips you can remove, then the rest of the
 * library behind "Add". The library is shared; what each agent ticks is its own.
 */
function Picks({ label, hint, chosen, options, onChange }: { label: string; hint: string; chosen: string[]; options: { name: string; note: string }[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const noteOf = (n: string) => options.find((o) => o.name === n)?.note ?? "not in the library: it will be left out";
  const rest = options.filter((o) => !chosen.includes(o.name));
  return (
    <fieldset className="picks">
      <legend>{label} <span className="muted">{hint}</span></legend>
      <div className="pick-row">
        {chosen.length === 0 && <span className="muted">none</span>}
        {chosen.map((n) => (
          <span key={n} className={`pick-chip${options.some((o) => o.name === n) ? "" : " missing"}`} title={noteOf(n)}>
            <span className="mono">{n}</span>
            <button type="button" className="ghost" aria-label={`Remove ${n}`} onClick={() => onChange(chosen.filter((x) => x !== n))}>×</button>
          </span>
        ))}
        {rest.length > 0 && <button type="button" className="ghost pick-add" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Done" : `+ Add (${rest.length} more in the library)`}</button>}
      </div>
      {open && (
        <div className="pick-row pick-lib">
          {rest.map((o) => (
            <button type="button" key={o.name} className="pick-opt" title={o.note} onClick={() => onChange([...chosen, o.name])}>
              <span className="mono">+ {o.name}</span> <span className="muted">{o.note}</span>
            </button>
          ))}
        </div>
      )}
    </fieldset>
  );
}

function Editor({ a, models, lib, onSelect, onError }: { a: AgentView; models: string[]; lib?: BayLibrary; onSelect: (id: string) => void; onError: (e: string) => void }) {
  const [d, setD] = useState<AgentDef>({ ...a.def, mcp: a.def.mcp ?? [] });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(d) !== JSON.stringify({ ...a.def, mcp: a.def.mcp ?? [] });
  const set = <K extends keyof AgentDef>(k: K, v: AgentDef[K]) => setD((x) => ({ ...x, [k]: v }));
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); } catch (e) { onError((e as Error).message); } finally { setBusy(false); } };
  return (
    <form className="editor" onSubmit={(e) => { e.preventDefault(); act(() => bayApi.save(a.def.id, d, a.version, note)); }}>
      <div className="ed-row">
        <label>Name<input value={d.name} onChange={(e) => set("name", e.target.value)} /></label>
        <label className="ed-av">Avatar<input value={d.avatar} maxLength={4} onChange={(e) => set("avatar", e.target.value)} /></label>
        <label>Model<select value={d.model} onChange={(e) => set("model", e.target.value)}>{[...new Set([...models, d.model])].map((m) => <option key={m}>{m}</option>)}</select></label>
        <label className="ed-num">Cap $/call<input type="number" min={0.01} max={5} step={0.01} value={d.budgetUsd} onChange={(e) => set("budgetUsd", Number(e.target.value))} /></label>
        <label>Made for<select value={d.station} onChange={(e) => set("station", e.target.value as AgentDef["station"])}>{[...SLOTS, "none" as const].map((s) => <option key={s} value={s}>{s === "none" ? "no station" : SLOT_LABEL[s]}</option>)}</select></label>
      </div>
      <label>Description<input value={d.description} onChange={(e) => set("description", e.target.value)} /></label>
      <label>Prompt <span className="muted">(who it is and how it works; the station's output contract is added by the core)</span>
        <textarea rows={6} value={d.prompt} onChange={(e) => set("prompt", e.target.value)} />
      </label>
      <div className="loadout">
        <div className="muted">What <b>this agent</b> loads on every call. The library under "Add" is shared by all agents; each one picks its own. More adds cost, so add what its job needs. <b className="mono">{loadout(d)}</b></div>
        <Picks label="Skills" hint="(it reads one when the task calls for it)" chosen={d.skills} options={(lib?.skills ?? []).map((s) => ({ name: s.name, note: `${s.source === "yours" ? "yours · " : ""}${s.description}` }))} onChange={(v) => set("skills", v)} />
        <Picks label="Tools" hint="(none: it answers in text, the cheapest and safest)" chosen={d.tools} options={lib?.tools ?? []} onChange={(v) => set("tools", v)} />
        <Picks label="MCP servers" hint={lib?.mcpFile ? `(set them up in ${lib.mcpFile})` : ""} chosen={d.mcp ?? []} options={(lib?.mcp ?? []).map((m) => ({ name: m.name, note: m.note || m.command }))} onChange={(v) => set("mcp", v)} />
        <label>Plugins <span className="muted">(Claude Code plugin folders, loaded whole: prefer single skills)</span><input value={d.plugins.join(", ")} placeholder="none" onChange={(e) => set("plugins", list(e.target.value))} /></label>
      </div>
      <label>Sample task <span className="muted">(used by Test)</span><input value={d.sample} onChange={(e) => set("sample", e.target.value)} /></label>
      <div className="ed-actions">
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="what changed (optional)" aria-label="Version note" />
        <button disabled={busy || !dirty}>Save as v{a.version + 1}</button>
        {dirty && <button type="button" className="ghost" onClick={() => setD(a.def)}>Discard</button>}
        <button type="button" className="ghost" disabled={busy} onClick={() => act(async () => onSelect((await bayApi.clone(a.def.id)).def.id))}>Clone</button>
        <a className="btn-ghost" href={bayApi.fileUrl(a.def.id)} download={`${a.def.id}.agent.md`}>Download .md</a>
        {!a.builtin && <button type="button" className="ghost" disabled={busy} onClick={() => act(() => bayApi.retire(a.def.id, !a.retired))}>{a.retired ? "Bring back" : "Retire"}</button>}
      </div>
    </form>
  );
}

/** Lines that differ between two prompts (longest common subsequence). */
function lineDiff(a: string, b: string) {
  const x = a.split("\n"), y = b.split("\n");
  const t = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out: { op: "same" | "del" | "add"; text: string }[] = [];
  let i = 0, j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { out.push({ op: "same", text: x[i] }); i++; j++; }
    else if (t[i + 1][j] >= t[i][j + 1]) out.push({ op: "del", text: x[i++] });
    else out.push({ op: "add", text: y[j++] });
  }
  while (i < x.length) out.push({ op: "del", text: x[i++] });
  while (j < y.length) out.push({ op: "add", text: y[j++] });
  return out;
}

function Versions({ a, onError }: { a: AgentView; onError: (e: string) => void }) {
  const [pick, setPick] = useState<number>(Math.max(1, a.version - 1));
  const [old, setOld] = useState<AgentDef | null>(null);
  useEffect(() => { let stop = false; bayApi.version(a.def.id, pick).then((v) => !stop && setOld(v.def)).catch(() => {}); return () => { stop = true; }; }, [a.def.id, pick]);
  const fields = old ? (Object.keys(a.def) as (keyof AgentDef)[]).filter((k) => k !== "prompt" && JSON.stringify(old[k]) !== JSON.stringify(a.def[k])) : [];
  const diff = useMemo(() => (old ? lineDiff(old.prompt, a.def.prompt) : []), [old, a.def.prompt]);
  return (
    <div className="versions">
      <ol className="v-line" aria-label="Version history">
        {[...a.versions].reverse().map((v) => (
          <li key={v.version} className={v.version === a.version ? "cur" : v.version === pick ? "pick" : ""}>
            <button className="link" onClick={() => setPick(v.version)} disabled={v.version === a.version}>v{v.version}</button>
            <span className="muted">{v.note}</span>
            <span className="mono muted">{new Date(v.ts).toLocaleString()} · {v.by}</span>
          </li>
        ))}
      </ol>
      {a.version > 1 && old && (
        <div className="v-diff">
          <div className="v-diff-head">
            <span>v{pick} → v{a.version} (current)</span>
            <button className="tiny" onClick={() => bayApi.rollback(a.def.id, pick).catch((e) => onError(e.message))}>Roll back to v{pick}</button>
          </div>
          {fields.map((k) => <div key={k} className="mono diff-field">{k}: <del>{JSON.stringify(old[k])}</del> → <ins>{JSON.stringify(a.def[k])}</ins></div>)}
          <pre className="diff">{diff.map((l, i) => <div key={i} className={`d-${l.op}`}>{l.op === "add" ? "+ " : l.op === "del" ? "- " : "  "}{l.text}</div>)}</pre>
        </div>
      )}
      {a.version === 1 && <div className="empty">One version so far. Every save adds one; any can be restored.</div>}
    </div>
  );
}

function Tests({ a, tests, onError }: { a: AgentView; tests: BayTest[]; onError: (e: string) => void }) {
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const running = busy || tests.some((t) => t.state === "running");
  return (
    <div className="bay-tests">
      <form className="test-form" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await bayApi.test(a.def.id, task.trim() || undefined); } catch (er) { onError((er as Error).message); } finally { setBusy(false); } }}>
        <input value={task} onChange={(e) => setTask(e.target.value)} placeholder={a.def.sample ? `sample: ${a.def.sample}` : "a task to try it on"} aria-label="Test task" />
        <button disabled={running}>{running ? "Testing…" : `Test v${a.version}`}</button>
      </form>
      <p className="muted small">A test runs one capped call and checks the answer with the verifier of {a.def.station === "none" ? "a plain answer" : `the ${SLOT_LABEL[a.def.station]} station`}.</p>
      {!tests.length && <div className="empty">No test runs yet.</div>}
      <ul className="test-list">
        {[...tests].reverse().map((t) => (
          <li key={t.id} className={t.state === "running" ? "running" : t.pass ? "pass" : "fail"}>
            <div className="t-head">
              <span className="mono">{t.state === "running" ? "RUNNING" : t.pass ? "PASS" : "FAIL"} · v{t.version}</span>
              <span className="muted t-task" title={t.task}>{t.task}</span>
              <span className="mono muted">{t.costUsd != null ? `$${t.costUsd.toFixed(4)}` : ""}</span>
            </div>
            {t.checks && <div className="t-checks">{t.checks.map((c, i) => <span key={i} className={c.pass ? "chk ok" : "chk bad"}>{c.pass ? "✓" : "✗"} {c.label}</span>)}</div>}
            {t.error && <div className="err">{t.error}</div>}
            {t.output && <details><summary className="muted">answer</summary><pre className="t-out">{t.output}</pre></details>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Stats({ a, st }: { a: AgentView; st?: AgentStats }) {
  if (!st || (!st.calls && !st.verdicts.total)) return <div className="empty">{a.def.name} has not worked yet. Put it on a station or test it.</div>;
  const vs = Object.entries(st.byVersion).map(([v, x]) => ({ v: Number(v), ...x })).sort((p, q) => p.v - q.v);
  const maxCost = Math.max(1e-6, ...vs.map((v) => v.costUsd));
  const tiles: [string, string][] = [
    ["calls", String(st.calls)], ["failed calls", String(st.failed)], ["pass rate", st.passRate != null ? `${Math.round(st.passRate * 100)}%` : "–"],
    ["verdicts", `${st.verdicts.pass}/${st.verdicts.total}`], ["factory runs", String(st.runs)], ["rounds per run", st.avgRounds != null ? String(st.avgRounds) : "–"],
    ["cost", `$${st.costUsd.toFixed(4)}`], ["per call", `$${st.avgUsd.toFixed(4)}`],
  ];
  return (
    <div className="stats-view">
      <div className="tiles">{tiles.map(([k, v]) => <div key={k} className="tile"><span className="tile-v mono">{v}</span><span className="muted">{k}</span></div>)}</div>
      <div className="b-sub muted">By version: pass rate at the verifier (bar) and cost</div>
      <div className="by-version" role="table" aria-label="Stats by version">
        {vs.map((v) => (
          <div key={v.v} className="bv-row" role="row">
            <span className="mono" role="cell">v{v.v}</span>
            <span className="bv-bar" role="cell" title={v.total ? `${v.pass}/${v.total} verdicts passed` : "no verdicts yet"}><span className="bv-pass" style={{ width: v.total ? `${(v.pass / v.total) * 100}%` : 0 }} /></span>
            <span className="mono muted" role="cell">{v.total ? `${Math.round((v.pass / v.total) * 100)}%` : "–"}</span>
            <span className="bv-bar cost" role="cell"><span style={{ width: `${(v.costUsd / maxCost) * 100}%` }} /></span>
            <span className="mono muted" role="cell">{v.calls} · ${v.costUsd.toFixed(4)}</span>
          </div>
        ))}
      </div>
      {st.lastAt && <div className="muted small">Last call {new Date(st.lastAt).toLocaleString()}</div>}
    </div>
  );
}
