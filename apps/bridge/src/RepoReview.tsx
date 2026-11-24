import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ReactFlow, Background, Handle, Position, MarkerType, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { API, type SfEvent } from "./api";
import { registerProjectPanel } from "./projects/panels";

/**
 * The deep review of an imported repo (docs/review.md; core: packages/core/src/imports/review.ts).
 *
 * One page that answers, in order: what is this app, does it work, should I keep it, and what next.
 * Everything on it is drawn from what the crew measured and read; every point has a "Not right?" so the
 * person can correct it, and Interview me asks the questions only they can answer.
 */
type Scored = { score: number; why: string };
interface Step { id: string; name: string; kind: "page" | "action" | "api" | "job" | "external"; route?: string; what: string; state: "seen" | "code-only" | "broken" }
interface Understanding {
  purpose: string; users: string; usage: string; stack: string;
  features: { id: string; name: string; what: string; where: string[]; state: "works" | "partial" | "broken" | "unknown" }[];
  flow: { steps: Step[]; links: { from: string; to: string; label?: string }[] };
  data: { name: string; what: string; where: string }[];
  integrations: { name: string; what: string; state: string }[];
  unsure: string[];
}
interface NextStep { title: string; body: string; kind: string; lens: string; severity: "critical" | "high" | "medium" | "low"; effort: string; files: string[]; suggestionId?: string }
interface Question { id: string; question: string; why: string; guess: string }
interface Verdict {
  headline: string;
  scores: { codeHealth: Scored; goalFit: Scored; costToFix: Scored };
  recommendation: { call: "keep" | "refactor" | "rewrite"; confidence: string; why: string; ifKeep: string; ifRewrite: string };
  stack: { call: "keep" | "change"; advice: string; suite: string };
  gaps: { title: string; detail: string; level: "high" | "medium" | "low" }[];
  strengths: string[]; nextSteps: NextStep[]; questions: Question[];
}
interface Evidence {
  head: string | null; stack: string[];
  install: { ok: boolean; notes: string[] };
  tests: { ran: boolean; passed: number; failed: number; failing: string[]; note: string };
  site: { started: boolean; note: string; command: string | null; pages: { route: string; text: string; controls: string[] }[] };
  endpoints: { method: string; path: string; file: string; line: number; framework: string; status?: number | null }[];
  integrations: { id: string; name: string; kind: string; evidence: string[] }[];
  envVars: string[]; hosts: string[];
  risks: { id: string; level: "critical" | "high" | "medium" | "low"; text: string; file: string; line: number }[];
  dependencies: { reports: { tool: string; ran: boolean; note: string; vulnerable: { name: string; severity: string; detail: string }[] }[]; unpinned: string[]; total: number };
}
type StationState = "active" | "pass" | "fail" | "skipped";
interface Review {
  id: number; ts: string; trigger: "import" | "manual" | "update"; mode: "agent" | "heuristic"; status: "running" | "done" | "failed"; capUsd: number; spentUsd: number; head: string | null;
  stations: { station: string; state: StationState; note: string | null; spentUsd: number | null }[];
  evidence: Evidence | null; understanding: Understanding | null; understoodBy: string | null; verdict: Verdict | null; verdictBy: string | null; brief: string | null; error: string | null;
}
interface Note { id: number; kind: "answer" | "correction"; about: string; question: string; text: string; ts: string; applied: number | null }
interface StepRow { id: string; title: string; status: string; proposalId: number | null }
interface Detail {
  import: { projectId: number; source: string; local: boolean; status: string };
  current: Review | null; shown: Review | null;
  history: { id: number; ts: string; trigger: string; mode: string; status: string; spentUsd: number; capUsd: number; call: string | null; head: string | null }[];
  notes: Note[]; pending: number; steps: StepRow[]; briefPath: string;
  briefSaved: { branch: string; where: string; url: string | null } | null;
  busy: boolean; mode: "agent" | "heuristic";
  settings: { maxUsd: number; updateUsd: number; auto: boolean; homeStack: string; minUsd: number; limitUsd: number };
}

const j = async <T,>(r: Response): Promise<T> => { const b = await r.json(); if (!r.ok) throw new Error(b.error ?? r.statusText); return b as T; };
const send = (path: string, body: unknown = {}, method = "POST") => fetch(`${API}${path}`, { method, headers: { "content-type": "application/json" }, body: method === "DELETE" ? undefined : JSON.stringify(body) });
const api = {
  detail: (id: number) => fetch(`${API}/api/imports/${id}/review`).then((r) => j<Detail>(r)),
  review: (id: number) => send(`/api/imports/${id}/review`).then((r) => j<unknown>(r)),
  update: (id: number) => send(`/api/imports/${id}/review/update`).then((r) => j<unknown>(r)),
  answer: (id: number, questionId: string, answer: string) => send(`/api/imports/${id}/review/answers`, { answers: [{ questionId, answer }] }).then((r) => j<unknown>(r)),
  correct: (id: number, about: string, was: string, text: string) => send(`/api/imports/${id}/review/corrections`, { about, was, text }).then((r) => j<unknown>(r)),
  removeNote: (id: number, note: number) => send(`/api/imports/${id}/review/notes/${note}`, {}, "DELETE").then((r) => j<unknown>(r)),
  saveBrief: (id: number) => send(`/api/imports/${id}/review/brief`).then((r) => j<{ branch: string; where: string; url: string | null }>(r)),
  settings: (body: { maxUsd?: number; auto?: boolean; homeStack?: string }) => send("/api/imports/review/settings", body).then((r) => j<Detail["settings"]>(r)),
  decide: (id: number, suggestion: string, decision: "accepted" | "rejected") => send(`/api/imports/${id}/suggestions/${encodeURIComponent(suggestion)}/decide`, { decision }).then((r) => j<unknown>(r)),
};

const usd = (n: number) => (n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const STATIONS: { id: string; label: string; sub: string }[] = [
  { id: "copy", label: "Copy", sub: "a copy of its own" },
  { id: "read", label: "Read", sub: "routes, services, risks" },
  { id: "install", label: "Install", sub: "what it needs" },
  { id: "tests", label: "Tests", sub: "its own tests" },
  { id: "site", label: "Run", sub: "start it, open pages" },
  { id: "deps", label: "Packages", sub: "known vulnerabilities" },
  { id: "inspect", label: "Inspect", sub: "Inspector" },
  { id: "verdict", label: "Verdict", sub: "Assessor" },
  { id: "brief", label: "Brief", sub: "file and next steps" },
];
const CALL_WORD = { keep: "Keep it", refactor: "Keep and refactor", rewrite: "Rewrite it" } as const;
const CALL_SUB = { keep: "Fix the short list and build on it.", refactor: "Keep the app and its stack; rework the weak parts first.", rewrite: "Start over and carry the features across." } as const;

function useReview(projectId: number, events: SfEvent[]) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const tick = events.filter((e) => e.type.startsWith("repo.review.") || e.type === "repo.suggestion" || e.type.startsWith("improve.proposal") || (e.type === "settings.changed" && String((e.payload as { key?: string } | undefined)?.key ?? "").startsWith("import"))).at(-1)?.id ?? 0;
  const [bump, setBump] = useState(0);
  useEffect(() => {
    let stop = false;
    const t = setTimeout(() => api.detail(projectId).then((d) => { if (!stop) { setDetail(d); setErr(null); } }).catch((e) => !stop && setErr((e as Error).message)), 150);
    return () => { stop = true; clearTimeout(t); };
  }, [tick, bump, projectId]);
  return { detail, err, reload: () => setBump((n) => n + 1) };
}

/** A score as a ring. `inverse`: a high number is the bad end (cost to fix). */
function Dial({ label, s, inverse }: { label: string; s: Scored; inverse?: boolean }) {
  const good = inverse ? 100 - s.score : s.score;
  const c = good >= 70 ? "var(--good)" : good >= 45 ? "var(--gate)" : "var(--bad)";
  const word = inverse ? (s.score >= 67 ? "high" : s.score >= 34 ? "medium" : "low") : null;
  return (
    <div className="rv-dial" title={s.why}>
      <svg viewBox="0 0 72 72" width="72" height="72" role="img" aria-label={`${label}: ${s.score} of 100`}>
        <circle cx="36" cy="36" r="30" fill="none" stroke="var(--line)" strokeWidth="7" />
        <circle cx="36" cy="36" r="30" fill="none" stroke={c} strokeWidth="7" strokeLinecap="round" strokeDasharray={`${(s.score / 100) * 188.5} 188.5`} transform="rotate(-90 36 36)" />
        <text x="36" y="41" textAnchor="middle" className="rv-dial-n">{s.score}</text>
      </svg>
      <div className="rv-dial-text"><b>{label}{word ? <span className="muted"> · {word}</span> : null}</b><span className="small muted">{s.why}</span></div>
    </div>
  );
}

/** "Not right?" under a point: the person says what is right, and it waits for the next update of the verdict. */
function Fix({ projectId, about, was, onSaved }: { projectId: number; about: string; was: string; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  if (!open) return <button className="link small rv-fix" onClick={() => setOpen(true)}>Not right?</button>;
  const save = () => api.correct(projectId, about, was, text).then(() => { setOpen(false); setText(""); setErr(null); onSaved(); }).catch((e) => setErr((e as Error).message));
  return (
    <form className="rv-fix-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <textarea autoFocus rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Say what is right, in your own words" aria-label={`Correct: ${about}`} />
      <div className="rv-row"><button type="submit" className="sm" disabled={!text.trim()}>Save the correction</button><button type="button" className="ghost sm" onClick={() => setOpen(false)}>Cancel</button>{err && <span className="rv-err small" role="alert">{err}</span>}</div>
    </form>
  );
}

type StepData = { s: Step };
function StepNode({ data }: NodeProps<Node<StepData>>) {
  const { s } = data;
  return (
    <div className={`rv-step k-${s.kind} st-${s.state}`} title={s.what}>
      <Handle type="target" position={Position.Left} />
      <div className="rv-step-top"><span className="rv-kind">{s.kind}</span><span className={`rv-state st-${s.state}`}>{s.state === "seen" ? "✓ seen working" : s.state === "broken" ? "✗ broken" : "in the code"}</span></div>
      <div className="rv-step-name">{s.name}</div>
      {s.route && <div className="mono rv-step-route">{s.route}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { step: StepNode };

/** Steps in columns by how far they are from where a person starts; steps nothing leads to fill the first column. */
function flowLayout(u: Understanding) {
  const steps = u.flow.steps;
  const level = new Map(steps.map((s) => [s.id, 0]));
  for (let i = 0; i < steps.length; i++) {
    let moved = false;
    for (const l of u.flow.links) if (level.has(l.from) && level.has(l.to) && level.get(l.from)! + 1 > level.get(l.to)! && level.get(l.from)! < steps.length) { level.set(l.to, level.get(l.from)! + 1); moved = true; }
    if (!moved) break;
  }
  const rows = new Map<number, number>();
  const nodes: Node<StepData>[] = steps.map((s) => {
    const col = Math.min(level.get(s.id)!, 6);
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    return { id: s.id, type: "step", position: { x: col * 250, y: row * 96 }, data: { s } };
  });
  const edges: Edge[] = u.flow.links.map((l, i) => ({ id: `${l.from}>${l.to}-${i}`, source: l.from, target: l.to, label: l.label, labelStyle: { fill: "#9aa2ad", fontSize: 11 }, labelBgStyle: { fill: "#14181d" }, style: { stroke: "#3a4658", strokeWidth: 1.4 }, markerEnd: { type: MarkerType.ArrowClosed, color: "#3a4658" } }));
  return { nodes, edges, height: Math.max(220, Math.min(560, Math.max(...[...rows.values(), 1]) * 96 + 60)) };
}

function Section({ title, count, children, aside }: { title: string; count?: number | string; children: ReactNode; aside?: ReactNode }) {
  return <section className="rv-sec"><h3><span>{title}{count != null ? <span className="muted"> · {count}</span> : null}</span>{aside}</h3>{children}</section>;
}

const Mark = ({ ok, skipped }: { ok: boolean; skipped?: boolean }) => <span className={`rv-mark ${skipped ? "skip" : ok ? "ok" : "bad"}`} aria-hidden>{skipped ? "–" : ok ? "✓" : "✗"}</span>;

export function RepoReviewPanel({ projectId, events, go }: { projectId: number; events: SfEvent[]; go: (panel: string) => void }) {
  const { detail, err, reload } = useReview(projectId, events);
  const [msg, setMsg] = useState<string | null>(null);
  const [interview, setInterview] = useState(false);
  const [showBrief, setShowBrief] = useState(false);
  const [showAllRoutes, setShowAllRoutes] = useState(false);
  const say = (e: unknown) => setMsg(e instanceof Error ? e.message : String(e));
  const act = (p: Promise<unknown>, done?: string) => p.then(() => { setMsg(done ?? null); reload(); }).catch(say);

  const shown = detail?.shown ?? null;
  const cur = detail?.current ?? null;
  const u = shown?.understanding ?? null;
  const v = shown?.verdict ?? null;
  const ev = shown?.evidence ?? null;
  const flow = useMemo(() => (u && u.flow.steps.length ? flowLayout(u) : null), [u]);
  const running = !!detail?.busy || cur?.status === "running";

  if (err && !detail) return <section className="rv"><div className="empty">Could not read the review: {err}</div></section>;
  if (!detail) return <section className="rv"><div className="empty">Reading the review…</div></section>;

  const st = new Map((cur?.stations ?? []).map((s) => [s.station, s]));
  const real = detail.mode === "agent";
  const cost = real ? `up to ${usd(detail.settings.maxUsd)}` : "free on the practice crew";
  const updateCost = real ? `up to ${usd(detail.settings.updateUsd)}` : "free on the practice crew";
  const pendingNotes = detail.notes.filter((n) => n.applied == null);
  const stepRow = new Map(detail.steps.map((s) => [s.id, s]));
  const openQuestions = (v?.questions ?? []).filter((q) => !pendingNotes.some((n) => n.kind === "answer" && n.about === q.id));
  const routes = ev?.endpoints ?? [];

  return (
    <section className="rv">
      {msg && <div className="rv-msg small" role="status">{msg} <button className="link small" onClick={() => setMsg(null)}>dismiss</button></div>}

      <div className="cm-strip rv-strip">
        {STATIONS.map((s, i) => {
          const x = st.get(s.id);
          return <div key={s.id} className={`cm-station s-${x?.state ?? "idle"}`} title={x?.note ?? s.sub}>{i > 0 && <span className="cm-arrow" aria-hidden>→</span>}<b>{s.label}</b><span className="muted">{x?.note ? x.note.slice(0, 64) : s.sub}</span></div>;
        })}
        <div className="cm-meter" title="Spent on this review, against its limit">
          <div className="cm-meter-bar"><span className="spent" style={{ width: `${Math.min(100, ((cur?.spentUsd ?? 0) / Math.max(cur?.capUsd || detail.settings.maxUsd, 0.0001)) * 100)}%` }} /></div>
          <span className="mono small">{usd(cur?.spentUsd ?? 0)} spent · limit {usd(cur?.capUsd || detail.settings.maxUsd)}</span>
        </div>
        <span className="muted small cm-mode">{real ? "real crew" : "practice crew: measured, not reasoned"}</span>
        <button className={cur ? "ghost sm" : "sm"} disabled={running} onClick={() => act(api.review(projectId))} title={`Copies the repo, installs and runs it, reads the code and judges it again: ${cost}.`}>{running ? "Reviewing…" : cur ? `Review again · ${cost}` : `Review this repo · ${cost}`}</button>
      </div>
      {cur?.status === "failed" && <div className="cm-error">The last review stopped: {cur.error}</div>}

      {!v && !running && (
        <div className="rv-empty">
          <h2>This repo has not been reviewed yet</h2>
          <p className="muted">The crew copies it, installs and runs it, opens its pages, runs its tests and scans it, then reads the code to say what the app is and whether to keep it. You are not asked anything first. Nothing in your repo changes.</p>
          <button onClick={() => act(api.review(projectId))}>Review this repo · {cost}</button>
        </div>
      )}
      {!v && running && <div className="rv-empty"><h2>The crew is working through the repo</h2><p className="muted">Follow the strip above. The verdict appears here when the Assessor is done; you can leave this page.</p></div>}

      {v && u && ev && shown && (
        <>
          {/* ---- the verdict ---- */}
          <div className={`rv-hero call-${v.recommendation.call}`}>
            <div className="rv-call">
              <span className="rv-eyebrow">The crew recommends</span>
              <h2>{CALL_WORD[v.recommendation.call]}</h2>
              <span className="muted small">{CALL_SUB[v.recommendation.call]} Confidence: {v.recommendation.confidence}.</span>
              <p className="rv-headline">{v.headline}</p>
              <p className="rv-why">{v.recommendation.why}</p>
              <div className="rv-two">
                {v.recommendation.ifKeep && <div><b>If you keep it</b><span>{v.recommendation.ifKeep}</span></div>}
                {v.recommendation.ifRewrite && <div><b>If you rewrite it</b><span>{v.recommendation.ifRewrite}</span></div>}
              </div>
              <div className="rv-row"><span className="muted small">The final call is yours. {shown.verdictBy === "heuristic" ? "This verdict was scored from measurements by the practice crew; the real crew reads the code and reasons." : `By the Inspector and the Assessor${shown.head ? `, from commit ${shown.head.slice(0, 7)}` : ""}.`}</span><Fix projectId={projectId} about="recommendation" was={`${v.recommendation.call}: ${v.headline}`} onSaved={reload} /></div>
            </div>
            <div className="rv-dials">
              <Dial label="Code health" s={v.scores.codeHealth} />
              <Dial label="Fit with its purpose" s={v.scores.goalFit} />
              <Dial label="Cost to fix" s={v.scores.costToFix} inverse />
            </div>
          </div>

          {/* ---- what the person said, waiting ---- */}
          {(pendingNotes.length > 0 || openQuestions.length > 0) && (
            <div className={`rv-bar${pendingNotes.length ? " needs" : ""}`}>
              {pendingNotes.length > 0
                ? <><span><b>{pendingNotes.length} thing{pendingNotes.length === 1 ? "" : "s"} you said</b> {pendingNotes.length === 1 ? "is" : "are"} not in the verdict yet.</span><button className="sm gate" disabled={running} onClick={() => act(api.update(projectId))} title="The Assessor rewrites what the app is and the verdict with what you said. Nothing is installed or run again.">{running ? "Updating…" : `Update the verdict · ${updateCost}`}</button></>
                : <span>The crew has <b>{openQuestions.length} question{openQuestions.length === 1 ? "" : "s"}</b> only you can answer. Answering sharpens the verdict.</span>}
              {openQuestions.length > 0 && <button className="ghost sm" onClick={() => setInterview(true)}>Interview me · {openQuestions.length} question{openQuestions.length === 1 ? "" : "s"}</button>}
            </div>
          )}
          {interview && <Interview projectId={projectId} questions={openQuestions} onClose={() => { setInterview(false); reload(); }} />}

          <div className="rv-grid">
            <Section title="What this app is">
              {([["purpose", "What it is for", u.purpose], ["users", "Who uses it", u.users], ["usage", "How it is used", u.usage], ["stack", "Built with", u.stack]] as const).map(([k, label, text]) => (
                <div key={k} className="rv-fact"><b>{label}</b><span>{text || <i className="muted">Not known from the code.</i>}</span><Fix projectId={projectId} about={k} was={text} onSaved={reload} /></div>
              ))}
              {u.unsure.length > 0 && <div className="rv-unsure small"><b>Not settled from the code</b><ul>{u.unsure.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
            </Section>

            <Section title="Stack advice" aside={<span className={`chip rv-chip ${v.stack.call === "keep" ? "ok" : "warn"}`}>{v.stack.call === "keep" ? "keep the stack" : "change the stack"}</span>}>
              <p>{v.stack.advice}</p>
              {v.stack.suite && <p><b>Fit with your other work.</b> {v.stack.suite}</p>}
              {v.strengths.length > 0 && <div className="small"><b>Worth keeping</b><ul>{v.strengths.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
              <Fix projectId={projectId} about="stack advice" was={v.stack.advice} onSaved={reload} />
            </Section>
          </div>

          <Section title="App flow" count={`${u.flow.steps.length} steps`} aside={<span className="muted small">green: seen working when it ran · grey: found in the code · red: broken</span>}>
            {flow ? (
              <div className="rv-flow" style={{ height: flow.height }}>
                <ReactFlow key={`${projectId}-${shown.id}`} nodes={flow.nodes} edges={flow.edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.1, maxZoom: 1 }} proOptions={{ hideAttribution: true }} nodesConnectable={false} nodesDraggable={false} minZoom={0.3} zoomOnScroll={false} preventScrolling={false}>
                  <Background color="#161b22" gap={22} />
                </ReactFlow>
              </div>
            ) : <div className="muted small">No flow could be read: the code has no routes or pages the crew recognised.</div>}
            {v.gaps.length > 0 && (
              <div className="rv-gaps">
                <b>Where the flow falls short of the purpose</b>
                {v.gaps.map((g, i) => <div key={i} className={`rv-gap lv-${g.level}`}><span className={`chip sv-${g.level === "low" ? "low" : g.level === "medium" ? "medium" : "high"}`}>{g.level}</span><div><b>{g.title}</b><span className="small">{g.detail}</span></div><Fix projectId={projectId} about={`gap: ${g.title}`} was={g.detail} onSaved={reload} /></div>)}
              </div>
            )}
          </Section>

          <Section title="Next steps" count={v.nextSteps.length} aside={<span className="muted small">Nothing starts until you approve it. An approved step becomes a ticket.</span>}>
            {v.nextSteps.length === 0 && <div className="muted small">The crew found nothing to do first.</div>}
            <div className="rv-steps">
              {v.nextSteps.map((n) => {
                const row = n.suggestionId ? stepRow.get(n.suggestionId) : undefined;
                const status = row?.status ?? "pending";
                return (
                  <div key={n.title} className={`rv-next sv-${n.severity}${status === "accepted" ? " done" : status === "rejected" ? " off" : ""}`}>
                    <div className="rv-next-head"><span className={`chip sv-${n.severity}`}>{n.severity}</span><b>{n.title}</b></div>
                    <div className="small">{n.body}</div>
                    <div className="muted small mono">{n.kind} · {n.lens} · {n.effort} effort{n.files.length ? ` · ${n.files.slice(0, 3).join(", ")}` : ""}</div>
                    <div className="rv-row">
                      {status === "accepted" ? <><span className="rv-ok small">✓ Approved: it is a ticket now.</span><button className="link small" onClick={() => go("tickets")}>open tickets</button></>
                        : status === "rejected" ? <span className="muted small">Dismissed.</span>
                          : row ? <><button className="sm" onClick={() => act(api.decide(projectId, row.id, "accepted"), `"${n.title}" is a ticket now.`)}>Approve</button><button className="ghost sm" onClick={() => act(api.decide(projectId, row.id, "rejected"))}>Dismiss</button></>
                            : <span className="muted small">Not saved as a suggestion.</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </Section>

          <div className="rv-grid">
            <Section title="Features" count={u.features.length}>
              {u.features.length === 0 && <div className="muted small">None read from the code.</div>}
              <div className="rv-table">
                {u.features.map((f) => (
                  <div key={f.id} className="rv-tr">
                    <span className={`rv-state st-${f.state}`}>{f.state === "works" ? "✓ works" : f.state === "broken" ? "✗ broken" : f.state === "partial" ? "◐ partial" : "? not seen"}</span>
                    <div><b>{f.name}</b><span className="small">{f.what}</span>{f.where.length > 0 && <span className="mono small muted">{f.where.slice(0, 3).join(", ")}</span>}</div>
                    <Fix projectId={projectId} about={`feature: ${f.name}`} was={`${f.state}: ${f.what}`} onSaved={reload} />
                  </div>
                ))}
              </div>
            </Section>

            <Section title="What running it showed">
              <div className="rv-run"><Mark ok={ev.install.ok} /><div><b>Install</b><span className="small">{ev.install.ok ? `Worked${ev.stack.length ? ` (${ev.stack.join(", ")})` : ""}.` : ev.install.notes.join("; ")}</span></div></div>
              <div className="rv-run"><Mark ok={ev.tests.ran && !ev.tests.failed} skipped={!ev.tests.ran} /><div><b>Its own tests</b><span className="small">{ev.tests.note}</span>{ev.tests.failing.length > 0 && <ul className="mono small">{ev.tests.failing.slice(0, 6).map((t) => <li key={t}>{t}</li>)}</ul>}</div></div>
              <div className="rv-run"><Mark ok={ev.site.started && !routes.some((e) => (e.status ?? 0) >= 500)} skipped={!ev.site.started && /only read|no site/.test(ev.site.note)} /><div><b>Running it</b><span className="small">{ev.site.command ? <span className="mono">{ev.site.command}: </span> : null}{ev.site.note}</span>{ev.site.pages.length > 0 && <span className="small muted">Pages opened: {ev.site.pages.map((p) => p.route).join(", ")}</span>}</div></div>
              {ev.dependencies.reports.map((r) => <div key={r.tool} className="rv-run"><Mark ok={r.ran && !r.vulnerable.length} skipped={!r.ran} /><div><b>Packages ({r.tool})</b><span className="small">{r.note}</span>{r.vulnerable.length > 0 && <ul className="small">{r.vulnerable.slice(0, 6).map((x) => <li key={x.name}><span className="mono">{x.name}</span> {x.detail || x.severity}</li>)}</ul>}</div></div>)}
              {ev.dependencies.reports.length === 0 && <div className="rv-run"><Mark ok skipped /><div><b>Packages</b><span className="small">No package list to check.</span></div></div>}
              <div className="rv-run"><Mark ok={!ev.risks.some((r) => r.level === "critical" || r.level === "high")} /><div><b>Risky lines</b><span className="small">{ev.risks.length ? `${ev.risks.length} found.` : "None found."}</span>{ev.risks.length > 0 && <ul className="small rv-risks">{ev.risks.slice(0, 8).map((r, i) => <li key={i}><span className={`chip sv-${r.level}`}>{r.level}</span> {r.text} <span className="mono muted">{r.file}:{r.line}</span></li>)}</ul>}</div></div>
            </Section>
          </div>

          <div className="rv-grid">
            <Section title="Routes" count={routes.length} aside={routes.length > 12 ? <button className="link small" onClick={() => setShowAllRoutes(!showAllRoutes)}>{showAllRoutes ? "show fewer" : "show all"}</button> : undefined}>
              {routes.length === 0 && <div className="muted small">No routes found in the code.</div>}
              <div className="rv-routes mono small">
                {(showAllRoutes ? routes : routes.slice(0, 12)).map((e) => (
                  <div key={`${e.method} ${e.path}`} className="rv-route"><span className={`rv-method m-${e.method.toLowerCase()}`}>{e.method}</span><span className="rv-path">{e.path}</span><span className="muted">{e.file}:{e.line}</span><span className={`rv-status ${e.status == null ? "" : e.status >= 500 ? "bad" : e.status >= 400 ? "warn" : "ok"}`} title={e.status == null ? "not asked while it ran" : `answered ${e.status} when asked`}>{e.status ?? ""}</span></div>
                ))}
              </div>
            </Section>

            <Section title="Outside services and data" count={(u.integrations.length || ev.integrations.length) + u.data.length}>
              {(u.integrations.length ? u.integrations.map((i) => ({ name: i.name, tag: i.state, text: i.what })) : ev.integrations.map((i) => ({ name: i.name, tag: i.kind, text: i.evidence.join("; ") }))).map((i) => (
                <div key={i.name} className="rv-tr"><span className="chip rv-chip">{i.tag}</span><div><b>{i.name}</b><span className="small">{i.text}</span></div><Fix projectId={projectId} about={`service: ${i.name}`} was={i.text} onSaved={reload} /></div>
              ))}
              {u.data.map((d) => <div key={d.name} className="rv-tr"><span className="chip rv-chip">data</span><div><b>{d.name}</b><span className="small">{d.what}</span>{d.where && <span className="mono small muted">{d.where}</span>}</div><Fix projectId={projectId} about={`data: ${d.name}`} was={d.what} onSaved={reload} /></div>)}
              {u.integrations.length + ev.integrations.length + u.data.length === 0 && <div className="muted small">It talks to nothing outside itself, as far as the code shows.</div>}
              {ev.envVars.length > 0 && <div className="small"><b>Settings it needs</b> <span className="mono">{ev.envVars.join(", ")}</span></div>}
            </Section>
          </div>

          <div className="rv-grid">
            <Section title="What you said" count={detail.notes.length} aside={openQuestions.length > 0 ? <button className="ghost sm" onClick={() => setInterview(true)}>Interview me</button> : undefined}>
              {detail.notes.length === 0 && <div className="muted small">Nothing yet. Press Interview me, or Not right? next to any point.</div>}
              {detail.notes.map((n) => (
                <div key={n.id} className={`rv-note${n.applied == null ? " pending" : ""}`}>
                  <div><b>{n.kind === "answer" ? n.question : `About ${n.about}`}</b><span>{n.text}</span><span className="muted small">{n.applied == null ? "waiting for the next update of the verdict" : "read by the verdict"}</span></div>
                  <button className="link small" onClick={() => act(api.removeNote(projectId, n.id))} title="Take this back">remove</button>
                </div>
              ))}
            </Section>

            <Section title="The brief" aside={<span className="mono small muted">{detail.briefPath}</span>}>
              <p className="small">The whole review as one file: the starting point for the crew's tickets and engine runs here, and for outside tools such as Claude Code once it is in the repo.</p>
              <div className="rv-row">
                <button className="ghost sm" onClick={() => setShowBrief(!showBrief)}>{showBrief ? "Hide the brief" : "Read the brief"}</button>
                <button className="ghost sm" onClick={() => navigator.clipboard.writeText(shown.brief ?? "").then(() => setMsg("The brief is on the clipboard."), say)}>Copy it</button>
                <button className="sm" onClick={() => act(api.saveBrief(projectId).then((r) => setMsg(r.url ? `The brief is on branch ${r.branch}: ${r.url}` : `Branch ${r.branch} with the brief is now in ${r.where}. Your files there did not change.`)))} title={detail.import.local ? "Adds a branch with the one file to your folder. Your files and your current branch do not move." : "Sends a branch with the one file to GitHub as a draft pull request. Never the main line."}>{detail.import.local ? "Add it to my folder" : "Send it to GitHub"}</button>
              </div>
              {detail.briefSaved && <div className="small muted">Last saved on branch <span className="mono">{detail.briefSaved.branch}</span>{detail.briefSaved.url ? <> · <a href={detail.briefSaved.url} target="_blank" rel="noreferrer">{detail.briefSaved.url}</a></> : ` in ${detail.briefSaved.where}`}</div>}
              {showBrief && <pre className="rv-brief">{shown.brief}</pre>}
            </Section>
          </div>
        </>
      )}

      <div className="rv-grid">
        <ReviewSettings s={detail.settings} onSaved={reload} say={say} />
        <Section title="Earlier reviews" count={detail.history.length}>
          {detail.history.length === 0 && <div className="muted small">None yet.</div>}
          {detail.history.map((h) => <div key={h.id} className="rv-hist small"><span className="mono">{h.ts.slice(0, 16).replace("T", " ")}</span><span>{h.trigger === "import" ? "on import" : h.trigger === "update" ? "update with what you said" : "pressed"}</span><span>{h.status === "failed" ? "stopped" : h.call ? CALL_WORD[h.call as keyof typeof CALL_WORD] : h.status}</span><span className="mono muted">{usd(h.spentUsd)} of {usd(h.capUsd)} · {h.mode === "agent" ? "real crew" : "practice"}</span></div>)}
        </Section>
      </div>
    </section>
  );
}

/** The interview: one hard question at a time, with why it matters and what the crew assumed meanwhile. */
function Interview({ projectId, questions, onClose }: { projectId: number; questions: Question[]; onClose: () => void }) {
  const [list] = useState(questions);
  const [i, setI] = useState(0);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const q = list[i];
  const next = () => { setText(""); setErr(null); setI(i + 1); };
  const save = () => (text.trim() ? api.answer(projectId, q.id, text.trim()).then(() => { setSaved(saved + 1); next(); }).catch((e) => setErr((e as Error).message)) : next());
  return (
    <div className="rv-interview" role="dialog" aria-label="Interview">
      {q ? (
        <form onSubmit={(e) => { e.preventDefault(); save(); }}>
          <div className="rv-row"><span className="rv-eyebrow">Question {i + 1} of {list.length}</span><button type="button" className="link small" onClick={onClose}>close</button></div>
          <h3>{q.question}</h3>
          {q.why && <p className="small"><b>Why it matters.</b> {q.why}</p>}
          {q.guess && <p className="small muted"><b>Assumed until you say.</b> {q.guess}</p>}
          <textarea autoFocus rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Your answer, in your own words. Leave it empty to skip." aria-label="Your answer" />
          <div className="rv-row"><button type="submit" className="sm">{text.trim() ? "Save and next" : "Skip"}</button>{q.guess && <button type="button" className="ghost sm" onClick={() => api.answer(projectId, q.id, `Yes, as assumed: ${q.guess}`).then(() => { setSaved(saved + 1); next(); }).catch((e) => setErr((e as Error).message))}>The assumption is right</button>}{err && <span className="rv-err small" role="alert">{err}</span>}</div>
        </form>
      ) : (
        <div><h3>{saved ? `${saved} answer${saved === 1 ? "" : "s"} saved` : "No answers given"}</h3><p className="small muted">{saved ? "Press Update the verdict above and the Assessor rewrites the review with them." : "You can come back to the questions any time."}</p><button className="sm" onClick={onClose}>Done</button></div>
      )}
    </div>
  );
}

function ReviewSettings({ s, onSaved, say }: { s: Detail["settings"]; onSaved: () => void; say: (e: unknown) => void }) {
  const [max, setMax] = useState(String(s.maxUsd));
  const [home, setHome] = useState(s.homeStack);
  useEffect(() => { setMax(String(s.maxUsd)); setHome(s.homeStack); }, [s.maxUsd, s.homeStack]);
  const n = Number(max);
  const valid = Number.isFinite(n) && n >= s.minUsd && n <= s.limitUsd;
  return (
    <Section title="Review settings" aside={<span className="muted small">for every imported repo</span>}>
      <label className="rv-set"><span><b>Limit for one review</b><span className="small muted">What the Inspector and the Assessor may spend together. An update with what you said may use up to {usd(s.updateUsd)}.</span></span>
        <span className="rv-row"><span className="mono">$</span><input type="number" min={s.minUsd} max={s.limitUsd} step={0.1} value={max} onChange={(e) => setMax(e.target.value)} aria-label="Limit for one review, in dollars" /><button className="ghost sm" disabled={!valid || n === s.maxUsd} onClick={() => api.settings({ maxUsd: n }).then(onSaved).catch(say)}>Save</button></span></label>
      {!valid && <div className="rv-err small">Between {usd(s.minUsd)} and {usd(s.limitUsd)}.</div>}
      <label className="rv-set rv-check"><input type="checkbox" checked={s.auto} onChange={(e) => api.settings({ auto: e.target.checked }).then(onSaved).catch(say)} /><span><b>Review a repo by itself when it is first imported</b><span className="small muted">After that a review runs again only when you press it.</span></span></label>
      <label className="rv-set"><span><b>Your main stack</b><span className="small muted">The Assessor judges a repo's stack against this and against your other imported repos.</span></span>
        <span className="rv-row"><input type="text" value={home} onChange={(e) => setHome(e.target.value)} placeholder="for example: TypeScript, React, Tauri, SQLite" aria-label="Your main stack" /><button className="ghost sm" disabled={home.trim() === s.homeStack} onClick={() => api.settings({ homeStack: home }).then(onSaved).catch(say)}>Save</button></span></label>
    </Section>
  );
}

registerProjectPanel({
  id: "review", section: "know", title: "Review", order: 14,
  appliesTo: (p) => (p.rollup.linked.repo ?? 0) > 0,
  badge: (c) => { const r = (c.project.facets as Record<string, any>).code?.review; return !r ? "new" : r.status === "running" ? "reviewing" : r.pending ? `${r.pending} to apply` : r.call ?? null; },
  alert: (c) => { const r = (c.project.facets as Record<string, any>).code?.review; return !!r && (r.status === "failed" || r.pending > 0); },
  render: (c) => <RepoReviewPanel projectId={c.project.id} events={c.events} go={c.go} />,
});
