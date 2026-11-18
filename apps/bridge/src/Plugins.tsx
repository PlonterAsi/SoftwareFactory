import { useEffect, useRef, useState, type FormEvent } from "react";
import { API, post, type ProjectDetail, type SfEvent } from "./api";
import { inProject, registerProjectPanel, registeredPanelIds, unregisterProjectPanel } from "./projects/panels";

/**
 * Plugins (packages/core/src/plugins/): folders with a plugin.json that add tabs, a backend
 * and agents without touching SoftwareFactory's own code.
 *
 *   Plugins page (top bar)   add one (bundled example or a folder), turn it on (the one approval:
 *                            its permissions are listed right there), off, remove; its log and pages
 *   Project tabs             every enabled plugin's "project" panels become tabs in every project
 *
 * A plugin page runs in a sandboxed frame. It cannot call the core itself; it asks this window
 * through sf.js (postMessage), and the core checks its permissions again.
 */
export type PluginPermission = "events:read" | "events:write" | "agents" | "records:read" | "actions" | "ai" | "store";
export interface PluginPanel { id: string; title: string; entry: string; where: "project" | "page" | "nav"; order: number }
export interface PluginBudget { monthlyUsd: number; spentUsd: number; leftUsd: number; calls: number; setBy: "manifest" | "you" }
export interface PluginManifest {
  id: string; name: string; version: string; description: string; permissions: PluginPermission[]; main: string | null;
  subscribe: string[]; panels: PluginPanel[]; agents: string[]; actions?: string[]; budget?: { monthlyUsd: number } | null;
}
export interface PluginView {
  id: string; name: string; version: string; description: string; dir: string; source: string | null;
  status: "installed" | "enabled" | "disabled"; manifest: PluginManifest; granted: string[]; error: string | null; crashes: number;
  installedAt: string; enabledAt: string | null; running: boolean | null; dataKeys: number; budget?: PluginBudget | null;
}
export interface PluginExample { id: string; name: string; description: string; dir: string; installed: boolean }
export interface PluginList { plugins: PluginView[]; examples: PluginExample[]; dir: string; permissions: Record<PluginPermission, string>; actions?: Record<string, string> }

const get = async <T,>(path: string): Promise<T> => {
  const r = await fetch(`${API}${path}`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? "request failed");
  return j as T;
};

export const pluginsApi = {
  list: () => get<PluginList>("/api/plugins"),
  install: (body: { dir?: string; example?: string; github?: string; ref?: string }) => post("/api/plugins/install", body) as Promise<PluginView>,
  update: (id: string) => post(`/api/plugins/${id}/update`) as Promise<PluginView & { updated: boolean }>,
  setBudget: (id: string, monthlyUsd: number) => post(`/api/plugins/${id}/budget`, { monthlyUsd }) as Promise<PluginBudget>,
  enable: (id: string) => post(`/api/plugins/${id}/enable`) as Promise<PluginView>,
  disable: (id: string) => post(`/api/plugins/${id}/disable`) as Promise<PluginView>,
  remove: (id: string) => post(`/api/plugins/${id}/remove`),
  log: (id: string) => get<{ log: { id: number; ts: string; level: string; text: string }[] }>(`/api/plugins/${id}/log`),
  data: (id: string) => get<{ data: Record<string, unknown> }>(`/api/plugins/${id}/data`),
  events: (id: string, q: { projectId?: number | null; types?: string[]; limit?: number }) => {
    const s = new URLSearchParams();
    if (q.projectId != null) s.set("projectId", String(q.projectId));
    if (q.types?.length) s.set("types", q.types.join(","));
    if (q.limit) s.set("limit", String(q.limit));
    return get<{ events: SfEvent[] }>(`/api/plugins/${id}/events?${s}`);
  },
  call: (id: string, method: string, args: unknown) => post(`/api/plugins/${id}/call`, { method, args }) as Promise<{ value: unknown }>,
  records: (id: string, q: { kind: string; projectId?: number | null; limit?: number }) => {
    const s = new URLSearchParams({ kind: q.kind });
    if (q.projectId != null) s.set("projectId", String(q.projectId));
    if (q.limit) s.set("limit", String(q.limit));
    return get<{ records: unknown[] }>(`/api/plugins/${id}/records?${s}`);
  },
  act: (id: string, verb: string, args: unknown) => post(`/api/plugins/${id}/act`, { verb, args }) as Promise<{ value: unknown }>,
  open: (id: string, url: string) => post(`/api/plugins/${id}/open`, { url }),
};

const LIFECYCLE = (t: string) => t.startsWith("plugin.") && t !== "plugin.data" && t !== "plugin.emitted";

export function usePlugins(events: SfEvent[], online: boolean) {
  const [data, setData] = useState<PluginList | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const at = events.filter((e) => LIFECYCLE(e.type) && e.type !== "plugin.log").at(-1)?.id ?? 0;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!online) return;
    let stop = false;
    const t = setTimeout(() => pluginsApi.list().then((d) => { if (!stop) { setData(d); setErr(null); } }).catch((x) => { if (!stop) setErr((x as Error).message); }), 120);
    return () => { stop = true; clearTimeout(t); };
  }, [at, online, tick]);
  return { data, err, refresh: () => setTick((n) => n + 1) };
}

/** Keep the project tabs in step with the enabled plugins (idempotent; call on every render of the app). */
export function syncPluginPanels(list: PluginView[] | undefined, events: SfEvent[]) {
  const want = new Map<string, { p: PluginView; panel: PluginPanel }>();
  for (const p of list ?? []) {
    if (p.status !== "enabled") continue;
    for (const panel of p.manifest.panels) if (panel.where === "project") want.set(`plugin:${p.id}:${panel.id}`, { p, panel });
  }
  for (const id of registeredPanelIds()) if (id.startsWith("plugin:") && !want.has(id)) unregisterProjectPanel(id);
  for (const [key, { p, panel }] of want) {
    registerProjectPanel({
      id: key, title: panel.title, order: panel.order,
      render: (ctx) => <PluginFrame key={key} plugin={p} panel={panel} project={ctx.project} events={ctx.events} />,
    });
  }
  void events;
}

// ---------------- One plugin page, in a sandboxed frame ----------------

type Ask = { sf: 1; rid: number; op: "context" | "events" | "call" | "data" | "subscribe" | "records" | "act" | "open" | "copy"; args?: Record<string, any> };

export function PluginFrame({ plugin, panel, project, events }: { plugin: PluginView; panel: PluginPanel; project: ProjectDetail | null; events: SfEvent[] }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const subscribed = useRef(false);
  const sentUpTo = useRef(events.at(-1)?.id ?? 0);
  const projectRef = useRef(project);
  projectRef.current = project;
  const canRead = plugin.granted.includes("events:read");

  useEffect(() => {
    subscribed.current = false;
    const reply = (rid: number, ok: boolean, value?: unknown, error?: string) =>
      frame.current?.contentWindow?.postMessage({ sf: 1, rid, ok, value, error }, "*");
    const onMessage = async (ev: MessageEvent) => {
      if (!frame.current || ev.source !== frame.current.contentWindow) return;
      const m = ev.data as Ask;
      if (!m || m.sf !== 1 || typeof m.rid !== "number") return;
      const a = m.args ?? {};
      const p = projectRef.current;
      try {
        if (m.op === "context") {
          return reply(m.rid, true, {
            plugin: { id: plugin.id, name: plugin.name, version: plugin.version, permissions: plugin.granted },
            project: p ? { id: p.id, name: p.name, kind: p.kind, status: p.status, summary: p.summary, runIds: p.runIds } : null,
          });
        }
        if (m.op === "events") {
          const r = await pluginsApi.events(plugin.id, { projectId: p?.id ?? null, types: Array.isArray(a.types) ? a.types.map(String) : undefined, limit: Number(a.limit) || undefined });
          return reply(m.rid, true, r.events);
        }
        if (m.op === "call") return reply(m.rid, true, (await pluginsApi.call(plugin.id, String(a.method ?? ""), a.args ?? {})).value);
        if (m.op === "records") return reply(m.rid, true, (await pluginsApi.records(plugin.id, { kind: String(a.kind ?? ""), projectId: p?.id ?? null, limit: Number(a.limit) || undefined })).records);
        if (m.op === "act") {
          // In a project's tab, what it makes lands in that project unless it names another.
          const args = { ...(a.args ?? {}) };
          if (p && args.project === undefined && a.verb !== "project.create") args.project = p.id;
          return reply(m.rid, true, (await pluginsApi.act(plugin.id, String(a.verb ?? ""), args)).value);
        }
        if (m.op === "data") return reply(m.rid, true, (await pluginsApi.data(plugin.id)).data);
        // A page cannot open windows or reach the clipboard from its sandbox: the app does it for web links and text only.
        if (m.op === "open") {
          const url = String(a.url ?? "");
          if (!/^https?:\/\//i.test(url)) return reply(m.rid, false, undefined, "Only web links (http or https) can be opened");
          // The core opens it in your default browser (the desktop window has no tabs); a plain browser tab is the fallback.
          await pluginsApi.open(plugin.id, url).catch(() => { window.open(url, "_blank", "noopener,noreferrer"); });
          return reply(m.rid, true, true);
        }
        if (m.op === "copy") { await navigator.clipboard.writeText(String(a.text ?? "").slice(0, 100_000)); return reply(m.rid, true, true); }
        if (m.op === "subscribe") {
          if (!canRead) return reply(m.rid, false, undefined, "This plugin did not ask to read events (events:read)");
          subscribed.current = true;
          return reply(m.rid, true, true);
        }
        reply(m.rid, false, undefined, `Unknown request ${String(m.op)}`);
      } catch (e) {
        reply(m.rid, false, undefined, (e as Error).message);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [plugin.id, plugin.granted.join(","), canRead]);

  // New events, as they arrive, to a page that asked for them (its project's only, inside a project).
  useEffect(() => {
    const fresh = events.filter((e) => e.id > sentUpTo.current);
    if (!fresh.length) return;
    sentUpTo.current = fresh.at(-1)!.id;
    if (!subscribed.current || !canRead) return;
    for (const e of fresh) {
      if (e.type === "plugin.data" || e.type === "plugin.log") continue;
      if (project && !(inProject(e, project) || (e.type === "plugin.emitted" && Number((e.payload as any)?.projectId) === project.id))) continue;
      frame.current?.contentWindow?.postMessage({ sf: 1, push: "event", event: e }, "*");
    }
  }, [events, project, canRead]);

  const src = `${API}/plugins/${plugin.id}/${panel.entry}${project ? `?project=${project.id}` : ""}`;
  return <iframe ref={frame} className="pl-frame" title={`${plugin.name}: ${panel.title}`} src={src} sandbox="allow-scripts allow-forms" />;
}

// ---------------- The Plugins page ----------------

const STATUS: Record<PluginView["status"], string> = { installed: "off, never turned on", enabled: "on", disabled: "off" };

export function PluginsPage({ events, list, err, refresh, id, panel }: {
  events: SfEvent[]; list: PluginList | null; err: string | null; refresh: () => void; id?: string; panel?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [dir, setDir] = useState("");
  const [gh, setGh] = useState("");
  const plugins = list?.plugins ?? [];
  const current = plugins.find((p) => p.id === id) ?? plugins[0];
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try { await fn(); setMsg(done ?? null); refresh(); } catch (x) { setMsg((x as Error).message); refresh(); } finally { setBusy(false); }
  };
  const addFolder = (e: FormEvent) => {
    e.preventDefault();
    if (!dir.trim()) return;
    act(async () => { const p = await pluginsApi.install({ dir: dir.trim() }); setDir(""); location.hash = `#/plugins/${p.id}`; }, "Added. Check what it may do, then turn it on.");
  };
  return (
    <div className="ft pl">
      <aside className="ft-rail" aria-label="Plugins">
        <h2>Plugins</h2>
        <p className="muted pl-lead">Add features as plugins instead of changing the app's code. Each one lists what it may do; turning it on is your approval.</p>
        {plugins.map((p) => (
          <a key={p.id} className={`ft-item${current?.id === p.id ? " on" : ""}`} href={`#/plugins/${p.id}`} aria-current={current?.id === p.id ? "page" : undefined}>
            <span className={`ft-glyph pl-dot s-${p.status}${p.error && p.status !== "enabled" ? " bad" : ""}`} aria-hidden>⬢</span>
            <span><b>{p.name}</b><span className="muted">{p.version} · {STATUS[p.status]}{p.running === false && p.status === "enabled" ? " · starting" : ""}</span></span>
          </a>
        ))}
        {!plugins.length && <p className="empty">{err ?? (list ? "No plugins yet. Add the example below, or a folder of your own." : "Loading…")}</p>}
        {(list?.examples.filter((x) => !x.installed).length ?? 0) > 0 && (
          <div className="pl-add">
            <h4>Examples</h4>
            {list!.examples.filter((x) => !x.installed).map((x) => (
              <div key={x.id} className="pl-example">
                <b>{x.name}</b><span className="muted">{x.description}</span>
                <button className="sm" disabled={busy} onClick={() => act(async () => { await pluginsApi.install({ example: x.id }); location.hash = `#/plugins/${x.id}`; }, "Added. Check what it may do, then turn it on.")}>Add</button>
              </div>
            ))}
          </div>
        )}
        <form className="pl-add" onSubmit={(e) => { e.preventDefault(); if (gh.trim()) act(async () => { const p = await pluginsApi.install({ github: gh.trim() }); setGh(""); location.hash = `#/plugins/${p.id}`; }, "Added. Check what it may do, then turn it on."); }}>
          <h4>Add from GitHub</h4>
          <input value={gh} onChange={(e) => setGh(e.target.value)} placeholder="owner/repo (a private one uses your GitHub access in Systems)" aria-label="GitHub repository" />
          <button className="sm" disabled={busy || !gh.trim()}>{busy ? "Adding…" : "Add"}</button>
          <span className="muted">It keeps itself up to date from there.</span>
        </form>
        <form className="pl-add" onSubmit={addFolder}>
          <h4>Add from a folder</h4>
          <input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="C:\path\to\my-plugin (has a plugin.json)" aria-label="Plugin folder" />
          <button className="sm" disabled={busy || !dir.trim()}>Add</button>
          {list && <span className="muted mono pl-dir" title="Installed copies live here">{list.dir}</span>}
        </form>
      </aside>
      <section className="ft-main">
        {msg && <p className={/^Added|is on\.$|updated\.$|up to date\.$/.test(msg) ? "muted" : "error"} role="status">{msg}</p>}
        {current ? <PluginDetail key={current.id} p={current} list={list!} events={events} busy={busy} act={act} panelId={panel} /> : <div className="empty">Pick a plugin, or add one.</div>}
      </section>
    </div>
  );
}

function PluginDetail({ p, list, events, busy, act, panelId }: {
  p: PluginView; list: PluginList; events: SfEvent[]; busy: boolean; act: (fn: () => Promise<unknown>, done?: string) => void; panelId?: string;
}) {
  const [log, setLog] = useState<{ id: number; ts: string; level: string; text: string }[]>([]);
  const logAt = events.filter((e) => e.type.startsWith("plugin.") && (e.payload as any)?.id === p.id && e.type !== "plugin.data").at(-1)?.id ?? 0;
  useEffect(() => { pluginsApi.log(p.id).then((r) => setLog(r.log)).catch(() => {}); }, [p.id, logAt]);
  const m = p.manifest;
  const pages = m.panels.filter((x) => x.where === "page");
  const tabs = m.panels.filter((x) => x.where === "project");
  const navs = m.panels.filter((x) => x.where === "nav");
  const page = pages.find((x) => x.id === panelId) ?? pages[0];
  const acts = m.actions ?? [];
  const [full, setFull] = useState(false);
  const showPage = !!page && p.status === "enabled";
  const newAsks: string[] = [...m.permissions.filter((x) => !p.granted.includes(x)), ...acts.filter((a) => !p.granted.includes(`act:${a}`)).map((a) => `act:${a}`)];
  return (
    <div className="pl-detail">
      <header className="ft-head">
        <div>
          <h3>{p.name} <span className="muted mono">{p.version}</span></h3>
          <p className="muted">{p.description || "No description."}</p>
        </div>
        <div className="ft-head-actions">
          {p.status === "enabled"
            ? <button className="sm ghost" disabled={busy} onClick={() => act(() => pluginsApi.disable(p.id))}>Turn off</button>
            : <button className="sm gate" disabled={busy} onClick={() => act(() => pluginsApi.enable(p.id), `${p.name} is on.`)}>Turn on</button>}
          {p.source?.startsWith("github:") && <button className="sm ghost" disabled={busy} title={`From ${p.source.slice(7)}`} onClick={() => act(async () => { const r = await pluginsApi.update(p.id); if (!r.updated) throw Object.assign(new Error(`${p.name} is up to date.`), { quiet: true }); }, `${p.name} updated.`)}>Check for update</button>}
          <button className="sm ghost" disabled={busy} onClick={() => { if (confirm(`Remove ${p.name}? Its copy and its stored data are deleted.`)) act(() => pluginsApi.remove(p.id).then(() => { location.hash = "#/plugins"; })); }}>Remove</button>
        </div>
      </header>

      {showPage && (
        <section className={`pl-page${full ? " full" : ""}`}>
          <nav className="pl-tabs">
            {pages.length > 1 && pages.map((x) => <a key={x.id} href={`#/plugins/${p.id}/${x.id}`} className={x.id === page!.id ? "on" : undefined}>{x.title}</a>)}
            <button className="ghost tiny pl-full" onClick={() => setFull(!full)} title={full ? "Back to the plugin's details" : "Give this page the whole window"}>{full ? "Leave full view" : "Full view"}</button>
          </nav>
          <PluginFrame plugin={p} panel={page!} project={null} events={events} />
        </section>
      )}

      <details className="pl-about" open={!showPage || newAsks.length > 0 || !!p.error}>
      <summary>{showPage ? "What it may do, what it adds and its log" : "About this plugin"}</summary>
      <ol className="ig-strip pl-strip" aria-label="Its state">
        <li className="ig-step s-pass"><b>Installed</b><span className="muted">{new Date(p.installedAt).toLocaleString()}</span></li>
        <li className={`ig-step s-${p.status === "enabled" ? "pass" : "waiting"}`}><span className="cm-arrow" aria-hidden>▸</span><b>Your approval</b><span className="muted">{p.status === "enabled" ? "given" : "turn it on below the list of what it may do"}</span></li>
        {m.main && <li className={`ig-step s-${p.running ? "pass" : p.status === "enabled" ? "warn" : "idle"}`}><span className="cm-arrow" aria-hidden>▸</span><b>Backend</b><span className="muted">{p.running ? "running in its own locked-down process" : p.status === "enabled" ? "starting" : "stopped"}</span></li>}
        <li className={`ig-step s-${p.status === "enabled" ? "pass" : "idle"}`}><span className="cm-arrow" aria-hidden>▸</span><b>In the app</b><span className="muted">{[navs.length ? `${navs.length} main menu item${navs.length > 1 ? "s" : ""}` : "", tabs.length ? `${tabs.length} project tab${tabs.length > 1 ? "s" : ""}` : "", pages.length ? `${pages.length} page${pages.length > 1 ? "s" : ""}` : "", m.agents.length ? `${m.agents.length} agent${m.agents.length > 1 ? "s" : ""}` : ""].filter(Boolean).join(", ") || "a backend only"}</span></li>
      </ol>
      {p.error && <p className="error" role="alert">{p.error}</p>}

      <section className="pl-grid">
        <div className="pl-card">
          <h4>What it may do</h4>
          <ul className="pl-perms">
            <li><b>Keep its own small data</b><span className="muted">always, in SoftwareFactory's database</span></li>
            {m.permissions.map((x) => (
              <li key={x} className={newAsks.includes(x) && p.status === "enabled" ? "new" : undefined}><b>{list.permissions[x] ?? x}</b><span className="muted mono">{x}{p.granted.includes(x) ? " · granted" : ""}</span></li>
            ))}
            {acts.map((a) => (
              <li key={a} className={newAsks.includes(`act:${a}`) && p.status === "enabled" ? "new" : undefined}><b>{list.actions?.[a] ?? a}</b><span className="muted mono">action {a}{p.granted.includes(`act:${a}`) ? " · granted" : ""}</span></li>
            ))}
          </ul>
          <p className="muted">Its backend can read only its own folder: no other files, no starting programs, no keys or tokens. Its pages cannot reach the network.</p>
        </div>
        {p.budget && <BudgetCard p={p} budget={p.budget} busy={busy} act={act} />}
        <div className="pl-card">
          <h4>What it adds</h4>
          <ul className="pl-perms">
            {navs.map((t) => <li key={t.id}><b>"{t.title}" in the main menu</b><span className="muted">{p.status === "enabled" ? <a href={`#/a/${p.id}/${t.id}`}>open it</a> : "once it is on"}</span></li>)}
            {tabs.map((t) => <li key={t.id}><b>Tab "{t.title}"</b><span className="muted">in every project</span></li>)}
            {pages.map((t) => <li key={t.id}><b>Page "{t.title}"</b><span className="muted">here, above</span></li>)}
            {m.main && <li><b>A backend</b><span className="muted mono">{m.main}{m.subscribe.length ? ` · hears ${m.subscribe.join(", ")}` : ""}</span></li>}
            {m.agents.map((a) => <li key={a}><b>Agent</b><span className="muted mono">{a} · in Agents while on</span></li>)}
          </ul>
          <p className="muted mono">{p.dir}{p.dataKeys ? ` · ${p.dataKeys} stored keys` : ""}</p>
        </div>
      </section>

      <section className="pl-log" aria-label="Log">
        <h4>Log</h4>
        {log.length ? (
          <ol className="mono">{log.slice(-60).map((l) => <li key={l.id} className={`lv-${l.level}`}><span className="muted">{new Date(l.ts).toLocaleTimeString()}</span> {l.text}</li>)}</ol>
        ) : <p className="muted">Nothing yet.</p>}
      </section>
      </details>
    </div>
  );
}

/** An add-on's monthly Claude budget: what it spent this month, and your own cap for it. */
function BudgetCard({ p, budget, busy, act }: { p: PluginView; budget: PluginBudget; busy: boolean; act: (fn: () => Promise<unknown>, done?: string) => void }) {
  const [val, setVal] = useState(String(budget.monthlyUsd));
  const pct = budget.monthlyUsd > 0 ? Math.min(100, (budget.spentUsd / budget.monthlyUsd) * 100) : 100;
  return (
    <div className="pl-card">
      <h4>Claude budget</h4>
      <p><b className="num">${budget.spentUsd.toFixed(2)}</b> <span className="muted">of ${budget.monthlyUsd.toFixed(2)} this month, {budget.calls} call{budget.calls === 1 ? "" : "s"}</span></p>
      <div className="pl-meter" role="meter" aria-valuemin={0} aria-valuemax={budget.monthlyUsd} aria-valuenow={budget.spentUsd} aria-label="Spent this month"><span style={{ width: `${pct}%` }} className={pct >= 90 ? "hot" : undefined} /></div>
      <form className="pl-budget" onSubmit={(e) => { e.preventDefault(); const n = Number(val); if (Number.isFinite(n) && n >= 0) act(() => pluginsApi.setBudget(p.id, n), `${p.name}'s budget is $${n.toFixed(2)} a month.`); }}>
        <label>Monthly budget $ <input type="number" min={0} step={1} value={val} onChange={(e) => setVal(e.target.value)} aria-label="Monthly budget in dollars" /></label>
        <button className="sm" disabled={busy || Number(val) === budget.monthlyUsd}>Save</button>
      </form>
      <p className="muted">{budget.setBy === "you" ? "Set by you." : "As the add-on asked; set your own any time."} When it is used up, its Claude calls stop until next month.</p>
    </div>
  );
}

/** An add-on that is a tool of its own: its "nav" page, the whole window, from its item in the main menu. */
export function AddonPage({ list, id, panel, events }: { list: PluginList | null; id: string; panel?: string; events: SfEvent[] }) {
  const p = list?.plugins.find((x) => x.id === id);
  if (!list) return <div className="empty">Loading…</div>;
  const navs = p?.manifest.panels.filter((x) => x.where === "nav") ?? [];
  const page = navs.find((x) => x.id === panel) ?? navs[0];
  if (!p || !page) return <div className="empty">No add-on "{id}" with a page of its own. <a href="#/plugins">Add-ons</a></div>;
  if (p.status !== "enabled") return <div className="empty">{p.name} is off. <a href={`#/plugins/${p.id}`}>Turn it on</a></div>;
  return (
    <section className="addon-page" aria-label={p.name}>
      {navs.length > 1 && <nav className="pl-tabs">{navs.map((x) => <a key={x.id} href={`#/a/${p.id}/${x.id}`} className={x.id === page.id ? "on" : undefined}>{x.title}</a>)}</nav>}
      <PluginFrame key={`${p.id}:${page.id}`} plugin={p} panel={page} project={null} events={events} />
    </section>
  );
}

/** The main menu items enabled add-ons ask for. */
export function addonNav(list: PluginList | null | undefined): { id: string; panel: string; title: string }[] {
  return (list?.plugins ?? []).filter((p) => p.status === "enabled")
    .flatMap((p) => p.manifest.panels.filter((x) => x.where === "nav").map((x) => ({ id: p.id, panel: x.id, title: x.title, order: x.order })))
    .sort((a, b) => a.order - b.order).map(({ id, panel, title }) => ({ id, panel, title }));
}
