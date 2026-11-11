import { useEffect, useMemo, useState, type FormEvent } from "react";
import { API, post, type SfEvent } from "./api";
import { registerProjectPanel, type PanelContext } from "./projects/panels";

/**
 * Finished projects added into SoftwareFactory (packages/core/src/integrations/).
 *
 *   Integrate tab (every project)   readiness strip → pick a form → ask → the one approval → installed
 *   Features page (top bar)         every installed feature: a tool gets an arguments box and its output,
 *                                   a panel (a web page) opens inside the app
 */
export type IntegrationForm = "tool" | "panel" | "source" | "plugin";
export interface ReadinessCheck { id: string; label: string; state: "pass" | "warn" | "fail"; detail: string }
export interface FormOption { form: IntegrationForm; available: boolean; entry: string | null; why: string }
export interface Integration {
  id: number; projectId: number; form: IntegrationForm; title: string; slug: string; summary: string; sourceDir: string; sourceKind: string;
  sourceRef: number | null; sha: string | null; entry: string | null; checks: ReadinessCheck[];
  status: "awaiting" | "installing" | "installed" | "briefed" | "rejected" | "failed" | "removed" | "replaced";
  requestedAt: string; requestedBy: string; decidedAt: string | null; decidedBy: string | null; note: string | null; dir: string | null; head: string | null;
  files: number | null; bytes: number | null; brief: string | null; error: string | null; uses: number; lastUsedAt: string | null; lastOk: boolean | null;
}
export interface Assessment {
  projectId: number; name: string; slug: string; summary: string;
  source: { kind: "factory_run" | "import"; ref: number; dir: string; sha: string | null } | null;
  checks: ReadinessCheck[]; forms: FormOption[]; recommended: IntegrationForm | null; ready: boolean; history: Integration[];
}
export interface ToolRun { exitCode: number | null; stdout: string; stderr: string; ms: number; timedOut: boolean; args: string[] }

export const integrationsApi = {
  list: async () => { const r = await fetch(`${API}/api/integrations`); if (!r.ok) throw new Error("could not list features"); return (await r.json()) as { integrations: Integration[]; installed: Integration[]; dir: string }; },
  assess: async (projectId: number) => { const r = await fetch(`${API}/api/integrations/assess/${projectId}`); const j = await r.json(); if (!r.ok) throw new Error(j.error ?? "could not check"); return j as Assessment; },
  request: (projectId: number, form: IntegrationForm) => post(`/api/integrations`, { projectId, form }) as Promise<Integration>,
  decide: (id: number, approve: boolean, note?: string) => post(`/api/integrations/${id}/decide`, { approve, note }) as Promise<Integration>,
  remove: (id: number) => post(`/api/integrations/${id}/remove`) as Promise<Integration>,
  run: (id: number, args: string, stdin?: string) => post(`/api/integrations/${id}/run`, { args, stdin }) as Promise<ToolRun>,
};

/** Refetch whenever something this view shows may have changed. */
const lastAt = (events: SfEvent[], test: (t: string) => boolean) => events.filter((e) => test(e.type)).at(-1)?.id ?? 0;
const RELEVANT = (t: string) => t.startsWith("integration.") || t === "factory.run.finished" || t.startsWith("repo.") || t === "factory.tests";

export function useIntegrations(events: SfEvent[]) {
  const [data, setData] = useState<Awaited<ReturnType<typeof integrationsApi.list>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const at = lastAt(events, (t) => t.startsWith("integration."));
  useEffect(() => {
    let stop = false;
    const t = setTimeout(() => integrationsApi.list().then((d) => { if (!stop) { setData(d); setErr(null); } }).catch((x) => { if (!stop) setErr((x as Error).message); }), 120);
    return () => { stop = true; clearTimeout(t); };
  }, [at]);
  return { data, err };
}

const FORM_TEXT: Record<IntegrationForm, { name: string; line: string }> = {
  tool: { name: "Tool", line: "Run it from the Features page: an arguments box and its output." },
  panel: { name: "Panel", line: "Its web page opens inside SoftwareFactory, on the Features page." },
  plugin: { name: "Plugin", line: "Installed as a plugin: its tabs, backend and agents join the app. Your approval turns it on; manage it on the Plugins page." },
  source: { name: "Into the source", line: "A brief for a pull request that builds it into SoftwareFactory itself. Never straight to main." },
};
const STATUS_TEXT: Record<Integration["status"], string> = {
  awaiting: "waiting for your approval", installing: "installing", installed: "installed", briefed: "brief ready", rejected: "rejected",
  failed: "failed", removed: "removed", replaced: "replaced by a newer copy",
};
const kb = (n: number | null) => (n == null ? "" : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

// ---------------- The Integrate tab ----------------

function IntegratePanel({ ctx }: { ctx: PanelContext }) {
  const pid = ctx.project.id;
  const [a, setA] = useState<Assessment | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<IntegrationForm | null>(null);
  const [busy, setBusy] = useState(false);
  const at = lastAt(ctx.events, RELEVANT);
  useEffect(() => {
    let stop = false;
    integrationsApi.assess(pid).then((x) => { if (!stop) { setA(x); setErr(null); } }).catch((x) => { if (!stop) setErr((x as Error).message); });
    return () => { stop = true; };
  }, [pid, at]);
  const chosen = form ?? a?.recommended ?? null;
  const open = a?.history.find((i) => i.status === "awaiting");
  const live = a?.history.filter((i) => i.status === "installed" || i.status === "briefed") ?? [];
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); setErr(null); setA(await integrationsApi.assess(pid)); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  if (!a) return <div className="empty">{err ?? "Checking whether this project can be added…"}</div>;
  const installedForm = live.find((i) => i.form === chosen);
  // Already holding what the project last shipped: nothing to update.
  const upToDate = !!installedForm && !!a.source && installedForm.sourceRef === a.source.ref && installedForm.sha === a.source.sha && installedForm.form !== "source";
  // The strip: readiness checks, then the gate, then the result.
  const gateState = open ? "waiting" : live.length ? "pass" : "idle";
  const doneState = live.length ? "pass" : "idle";
  return (
    <div className="ig">
      <p className="ig-lead">
        Add <b>{a.name}</b> into SoftwareFactory so you can use it from here. You approve it once; updates of a feature you approved go through on their own.
      </p>
      <ol className="ig-strip" aria-label="Steps to add this project">
        {a.checks.map((c, n) => (
          <li key={c.id} className={`ig-step s-${c.state}`} title={c.detail}>
            {n > 0 && <span className="cm-arrow" aria-hidden>▸</span>}
            <b>{c.label}</b><span className="muted">{c.detail}</span>
          </li>
        ))}
        <li className={`ig-step s-${gateState}`}><span className="cm-arrow" aria-hidden>▸</span><b>Your approval</b><span className="muted">{open ? "waiting for you" : live.length ? `by ${live[0].decidedBy ?? "you"}` : "the one human step"}</span></li>
        <li className={`ig-step s-${doneState}`}><span className="cm-arrow" aria-hidden>▸</span><b>Inside SoftwareFactory</b><span className="muted">{live.length ? live.map((i) => FORM_TEXT[i.form].name).join(", ") : "not yet"}</span></li>
      </ol>

      {open ? (
        <section className="ig-gate" aria-label="Approval">
          <div>
            <b>Add {open.title} as a {FORM_TEXT[open.form].name.toLowerCase()}?</b>
            <p className="muted">{FORM_TEXT[open.form].line} {open.form === "plugin" && <>Approving also turns it on with the permissions listed below its option. </>}{open.form !== "source" && <>A frozen copy of <span className="mono">{open.sourceDir}</span>{open.sha ? <> at <span className="mono">{open.sha}</span></> : null} goes into SoftwareFactory's data folder; the project's own folder is not touched.</>}</p>
          </div>
          <div className="ig-gate-actions">
            <button className="sm gate" disabled={busy} onClick={() => act(() => integrationsApi.decide(open.id, true))}>Approve</button>
            <button className="sm ghost" disabled={busy} onClick={() => act(() => integrationsApi.decide(open.id, false))}>Reject</button>
          </div>
        </section>
      ) : (
        <section className="ig-forms" aria-label="How to add it">
          {a.forms.map((f) => (
            <button key={f.form} className={`ig-form${chosen === f.form ? " on" : ""}`} disabled={!f.available} onClick={() => setForm(f.form)} aria-pressed={chosen === f.form}>
              <b>{FORM_TEXT[f.form].name}{a.recommended === f.form ? <span className="ig-rec">suggested</span> : null}</b>
              <span>{FORM_TEXT[f.form].line}</span>
              <span className="muted mono">{f.why}</span>
            </button>
          ))}
          <div className="ig-ask">
            <button disabled={!a.ready || !chosen || busy || upToDate} onClick={() => chosen && act(() => integrationsApi.request(pid, chosen))}>
              {upToDate ? "Up to date" : installedForm ? "Update to the newest version" : chosen === "source" ? "Prepare the brief" : "Add to SoftwareFactory"}
            </button>
            {!a.ready && <span className="muted">{a.checks.find((c) => c.state === "fail")?.detail ?? "Not ready yet."}</span>}
          </div>
        </section>
      )}
      {err && <p className="error" role="alert">{err}</p>}

      {live.length > 0 && (
        <section className="ig-live">
          {live.map((i) => (
            <div key={i.id} className="ig-card">
              <div className="ig-card-head">
                <b>{FORM_TEXT[i.form].name}</b>
                <span className="muted">{STATUS_TEXT[i.status]}{i.uses ? ` · used ${i.uses}×` : ""}{i.files ? ` · ${i.files} files, ${kb(i.bytes)}` : ""}</span>
                {i.form === "plugin" ? <a className="ig-open" href={`#/plugins/${i.entry}`}>Open on the Plugins page</a> : i.form !== "source" && <a className="ig-open" href={`#/features/${i.id}`}>Open</a>}
              </div>
              {i.brief && <Brief text={i.brief} />}
            </div>
          ))}
        </section>
      )}
      {a.history.length > 0 && (
        <details className="ig-history">
          <summary>History ({a.history.length})</summary>
          <ul>
            {a.history.map((i) => (
              <li key={i.id}><span className="mono">#{i.id}</span> {FORM_TEXT[i.form].name}: {STATUS_TEXT[i.status]}{i.decidedBy ? ` (by ${i.decidedBy})` : ""}{i.error ? ` · ${i.error}` : ""} <span className="muted">{new Date(i.requestedAt).toLocaleString()}</span></li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Brief({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked: the text is selectable */ } };
  return (
    <div className="ig-brief">
      <div className="ig-brief-bar"><span className="muted">Paste this to Claude in your SoftwareFactory project, or keep it as a ticket.</span><button className="sm ghost" onClick={copy}>{copied ? "Copied" : "Copy brief"}</button></div>
      <pre className="mono">{text}</pre>
    </div>
  );
}

registerProjectPanel({
  id: "integrate",
  title: "Integrate",
  order: 80,
  badge: (c) => {
    const f = (c.project.facets as Record<string, any>).integration;
    return f?.awaiting ? "approve" : f?.installed?.length ? "in app" : null;
  },
  alert: (c) => !!(c.project.facets as Record<string, any>).integration?.awaiting,
  render: (c) => <IntegratePanel ctx={c} />,
});

// ---------------- The Features page ----------------

export function FeaturesPage({ events, id, onOpenProject }: { events: SfEvent[]; id?: number; onOpenProject: (projectId: number) => void }) {
  const { data, err } = useIntegrations(events);
  const installed = data?.installed ?? [];
  const waiting = (data?.integrations ?? []).filter((i) => i.status === "awaiting");
  const current = installed.find((i) => i.id === id) ?? installed[0];
  return (
    <div className="ft">
      <aside className="ft-rail" aria-label="Installed features">
        <h2>Features</h2>
        {waiting.length > 0 && (
          <div className="ft-waiting">
            {waiting.map((w) => <button key={w.id} className="link" onClick={() => onOpenProject(w.projectId)}>Approve {w.title} ({FORM_TEXT[w.form].name.toLowerCase()})</button>)}
          </div>
        )}
        {installed.map((i) => (
          <a key={i.id} className={`ft-item${current?.id === i.id ? " on" : ""}`} href={`#/features/${i.id}`} aria-current={current?.id === i.id ? "page" : undefined}>
            <span className={`ft-glyph f-${i.form}`} aria-hidden>{i.form === "tool" ? ">_" : "▣"}</span>
            <span><b>{i.title}</b><span className="muted">{FORM_TEXT[i.form].name}{i.uses ? ` · ${i.uses} runs` : ""}</span></span>
          </a>
        ))}
        {!installed.length && <p className="empty">{err ?? (data ? "Nothing added yet. Open a finished project and use its Integrate tab." : "Loading…")}</p>}
      </aside>
      <section className="ft-main">
        {current ? (
          <>
            <header className="ft-head">
              <div>
                <h3>{current.title}</h3>
                <p className="muted">{current.summary || FORM_TEXT[current.form].line}</p>
              </div>
              <div className="ft-head-actions">
                <button className="sm ghost" onClick={() => onOpenProject(current.projectId)}>Project</button>
                {current.form === "panel" && <a className="ft-ext" href={`${API || location.origin}/ext/${current.id}/`} target="_blank" rel="noreferrer">Open in browser</a>}
                <RemoveButton id={current.id} />
              </div>
            </header>
            {current.form === "tool" ? <ToolConsole key={current.id} feature={current} /> : <iframe key={current.id} className="ft-frame" title={current.title} src={`${API}/ext/${current.id}/`} />}
          </>
        ) : <div className="empty">Features you add from finished projects open here.</div>}
      </section>
    </div>
  );
}

function RemoveButton({ id }: { id: number }) {
  const [sure, setSure] = useState(false);
  useEffect(() => setSure(false), [id]);
  return sure
    ? <button className="sm" style={{ background: "var(--bad)" }} onClick={() => integrationsApi.remove(id).then(() => { location.hash = "#/features"; })}>Remove it</button>
    : <button className="sm ghost" onClick={() => setSure(true)} title="Removes the installed copy; the project stays">Remove</button>;
}

function ToolConsole({ feature }: { feature: Integration }) {
  const [args, setArgs] = useState("");
  const [stdin, setStdin] = useState("");
  const [showIn, setShowIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<(ToolRun & { at: string })[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const run = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    try { const r = await integrationsApi.run(feature.id, args, showIn ? stdin : undefined); setRuns((x) => [{ ...r, at: new Date().toLocaleTimeString() }, ...x].slice(0, 20)); setErr(null); }
    catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  const cmd = useMemo(() => feature.entry?.split("/").pop()?.replace(/\.(c|m)?js$/, "") ?? feature.slug, [feature]);
  return (
    <div className="ft-tool">
      <form className="ft-cmd" onSubmit={run}>
        <span className="mono ft-prompt">{cmd} ›</span>
        <input className="mono" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="arguments, for example --help" aria-label="Arguments" autoFocus />
        <button type="submit" disabled={busy}>{busy ? "Running…" : "Run"}</button>
        <button type="button" className="sm ghost" onClick={() => setShowIn((s) => !s)} aria-pressed={showIn}>Input</button>
      </form>
      {showIn && <textarea className="mono ft-stdin" rows={4} value={stdin} onChange={(e) => setStdin(e.target.value)} placeholder="Text sent to the program's standard input" aria-label="Standard input" />}
      {err && <p className="error" role="alert">{err}</p>}
      <div className="ft-out" aria-live="polite">
        {runs.length === 0 && <p className="muted">Runs from its installed copy in <span className="mono">{feature.dir}</span>. Output appears here.</p>}
        {runs.map((r, n) => (
          <div key={runs.length - n} className="ft-run">
            <div className="ft-run-head mono">
              <span>{r.at}</span><span>{cmd} {r.args.join(" ")}</span>
              <span className={r.exitCode === 0 && !r.timedOut ? "good" : "bad"}>{r.timedOut ? "timed out" : `exit ${r.exitCode}`}</span>
              <span className="muted">{r.ms} ms</span>
            </div>
            {r.stdout && <pre className="mono">{r.stdout}</pre>}
            {r.stderr && <pre className="mono ft-err">{r.stderr}</pre>}
            {!r.stdout && !r.stderr && <pre className="mono muted">(no output)</pre>}
          </div>
        ))}
      </div>
    </div>
  );
}

