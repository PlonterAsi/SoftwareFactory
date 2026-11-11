import { useEffect, useMemo, useState } from "react";
import { API, post, type AgentView, type SfEvent } from "./api";

/** Mirror of the core's ImproveState (packages/core/src/improve/council.ts). */
type Impact = "high" | "medium" | "low";
type Effort = "small" | "medium" | "large";
type Status = "inbox" | "accepted" | "rejected" | "parked";
export interface Target { kind: "project" | "idea" | "run" | "factory"; id: number | null; title: string }
export interface Proposal {
  id: number; ts: string; session: number | null; target: Target; title: string; why: string; change: string; impact: Impact; effort: Effort;
  lenses: string[]; agents: string[]; score: number; status: Status; decidedAt?: string; note?: string; ticketId?: number; signalId?: number;
  source?: { kind: string; suggestionId?: string | number }; files?: string[];
}
interface Seat { agent: string; name: string; version: number; state: "thinking" | "done" | "failed"; count?: number; costUsd?: number; error?: string }
interface Session { id: number; ts: string; trigger: "auto" | "manual"; target: Target; why: string; seats: Seat[]; state: "running" | "done" | "failed"; costUsd: number; proposals: number[]; suppressed: { title: string; because: string }[]; note?: string }
interface Candidate { target: Target; lastChange: string | null; lastReviewed: string | null; due: boolean; why: string }
export interface ImproveState {
  sessions: Session[]; proposals: Proposal[]; candidates: Candidate[];
  budget: { spentTodayUsd: number; maxUsd: number; perCallUsd: number; totalUsd: number };
  auto: { on: boolean; everyHours: number; maxInbox: number; nextAt: string | null; blocked: string | null };
  busy: boolean;
}

const EMPTY: ImproveState = { sessions: [], proposals: [], candidates: [], budget: { spentTodayUsd: 0, maxUsd: 0, perCallUsd: 0, totalUsd: 0 }, auto: { on: false, everyHours: 6, maxInbox: 12, nextAt: null, blocked: null }, busy: false };

export const improveApi = {
  run: (target?: Target) => post(`/api/improve/run`, { target }),
  decide: (id: number, decision: Status, note?: string) => post(`/api/improve/proposals/${id}/decide`, { decision, note }) as Promise<Proposal>,
  build: (id: number) => post(`/api/improve/proposals/${id}/build`) as Promise<{ run: number }>,
  settings: (s: { auto?: boolean; maxUsd?: number; everyHours?: number }) => post(`/api/improve/settings`, s) as Promise<ImproveState>,
};

/** Refetch whenever an improve event or a lens call lands, so the wheel and the meter stay live. */
export function useImprove(events: SfEvent[]) {
  const [state, setState] = useState<ImproveState>(EMPTY);
  const lastId = events.filter((e) => e.type.startsWith("improve.") || (e.type.startsWith("agent.run") && e.payload?.station === "improve") || e.type === "settings.changed").at(-1)?.id ?? 0;
  useEffect(() => {
    let stop = false;
    const t = setTimeout(() => {
      fetch(`${API}/api/improve/state`).then((r) => r.json()).then((s: ImproveState) => { if (!stop && s.proposals) setState(s); }).catch(() => {});
    }, 150);
    return () => { stop = true; clearTimeout(t); };
  }, [lastId]);
  return state;
}

const KIND: Record<Target["kind"], string> = { project: "project", idea: "idea", run: "shipped app", factory: "the factory" };
const tkey = (t: Target) => `${t.kind}:${t.id ?? ""}`;
const ago = (ts: string) => { const m = Math.round((Date.now() - Date.parse(ts)) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

/**
 * The Improvement Council deck: six lenses look again at what already exists and
 * propose how to make it better. The lens wheel shows who is thinking, the meter
 * what today cost, the queue what waits for one tap.
 * Pass projectId to show only one project's proposals (the project view's panel).
 */
export function ImproveDeck({ improve, crew, projectId, onRunStarted }: { improve: ImproveState; crew: AgentView[]; projectId?: number; onRunStarted?: (run: number) => void }) {
  const [tab, setTab] = useState<Status>("inbox");
  const [pick, setPick] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | "run" | null>(null);
  const mine = (t: Target) => projectId == null || (t.kind === "project" && t.id === projectId);
  const proposals = improve.proposals.filter((p) => mine(p.target));
  const counts = { inbox: 0, accepted: 0, parked: 0, rejected: 0 } as Record<Status, number>;
  for (const p of proposals) counts[p.status]++;
  const shown = proposals.filter((p) => p.status === tab).sort((a, b) => (tab === "inbox" ? b.score - a.score || b.id - a.id : Date.parse(b.decidedAt ?? b.ts) - Date.parse(a.decidedAt ?? a.ts)));
  const live = improve.sessions.filter((s) => mine(s.target)).at(-1);
  const candidates = improve.candidates.filter((c) => mine(c.target) && c.lastChange);
  const act = async (key: number | "run", fn: () => Promise<unknown>) => { setErr(null); setBusy(key); try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); } };
  const lookNow = () => act("run", () => {
    const c = candidates.find((x) => tkey(x.target) === pick) ?? (projectId != null ? candidates[0] : undefined);
    return improveApi.run(c?.target);
  });
  return (
    <section className="pane improve" aria-label="Improvement Council">
      <header className="pane-head">
        <span>Improvement Council</span>
        <span className="muted mono">{counts.inbox} waiting · {counts.accepted} accepted · ${improve.budget.totalUsd.toFixed(4)} all time</span>
      </header>
      {err && <div className="bay-err err" role="alert">{err} <button className="link" onClick={() => setErr(null)}>dismiss</button></div>}
      <div className="imp-top">
        <LensWheel session={live} crew={crew} proposals={proposals} />
        <div className="imp-ctl">
          <div className="imp-now">
            {live?.state === "running"
              ? <><span className="imp-pulse" aria-hidden /> Looking at {KIND[live.target.kind]} <b>{live.target.title}</b> ({live.why})</>
              : live ? <span className="muted">Last look: {KIND[live.target.kind]} <b>{live.target.title}</b>, {ago(live.ts)}. {live.note}</span>
                : <span className="muted">The council has not looked at anything yet.</span>}
          </div>
          <div className="imp-run">
            <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="What to look at">
              <option value="">{projectId != null ? "This project" : "Next due (the council picks)"}</option>
              {candidates.map((c) => <option key={tkey(c.target)} value={tkey(c.target)}>{KIND[c.target.kind]}: {c.target.title}{c.due ? ` · ${c.why}` : ""}</option>)}
            </select>
            <button onClick={lookNow} disabled={improve.busy || busy === "run"}>{improve.busy ? "In session…" : "Look now"}</button>
          </div>
          <CostMeter b={improve.budget} />
          <div className="imp-auto">
            <label><input type="checkbox" checked={improve.auto.on} onChange={(e) => act("run", () => improveApi.settings({ auto: e.target.checked }))} /> Look on its own</label>
            <label>every <select value={improve.auto.everyHours} onChange={(e) => act("run", () => improveApi.settings({ everyHours: Number(e.target.value) }))}>
              {[1, 3, 6, 12, 24, 72, 168].map((h) => <option key={h} value={h}>{h < 24 ? `${h} h` : `${h / 24} d`}</option>)}
            </select></label>
            <label>cap $<select value={improve.budget.maxUsd} onChange={(e) => act("run", () => improveApi.settings({ maxUsd: Number(e.target.value) }))}>
              {[...new Set([0.05, 0.1, 0.2, 0.5, 1, improve.budget.maxUsd])].sort((a, b) => a - b).map((v) => <option key={v} value={v}>{v.toFixed(2)}</option>)}
            </select> a day</label>
            {improve.auto.on && improve.auto.blocked && <span className="muted imp-why">Waiting: {improve.auto.blocked}.</span>}
          </div>
        </div>
      </div>
      <nav className="viewbar imp-tabs" role="tablist" aria-label="Proposals">
        {(["inbox", "accepted", "parked", "rejected"] as Status[]).map((s) => (
          <button key={s} role="tab" aria-selected={tab === s} className={tab === s ? "tab on" : "tab"} onClick={() => setTab(s)}>{s === "inbox" ? "Waiting" : s[0].toUpperCase() + s.slice(1)} · {counts[s]}</button>
        ))}
      </nav>
      <div className="imp-list">
        {!shown.length && <div className="empty">{tab === "inbox" ? "Nothing waits for you. Press Look now, or let the council look on its own when something changes." : `Nothing ${tab} yet.`}</div>}
        {shown.map((p) => <Card key={p.id} p={p} busy={busy === p.id} showTarget={projectId == null}
          onDecide={(d) => act(p.id, () => improveApi.decide(p.id, d))}
          onBuild={() => act(p.id, async () => { const r = await improveApi.build(p.id); onRunStarted?.(r.run); })} />)}
      </div>
      <SessionLog sessions={improve.sessions.filter((s) => mine(s.target))} />
    </section>
  );
}

const LENS_ORDER = ["integrator", "automator", "simplifier", "enricher", "ux-lens", "flow-lens"];

/** visualizeEverything: each lens is a spoke; it lights while thinking, and its ring counts what it proposed and what you accepted. */
function LensWheel({ session, crew, proposals }: { session?: Session; crew: AgentView[]; proposals: Proposal[] }) {
  const seats = useMemo(() => {
    const fromSession = session?.seats ?? [];
    const ids = fromSession.length ? fromSession.map((s) => s.agent) : LENS_ORDER.filter((id) => crew.some((a) => a.def.id === id));
    return ids.map((id) => ({ id, seat: fromSession.find((s) => s.agent === id), agent: crew.find((a) => a.def.id === id) }));
  }, [session, crew]);
  const R = 70, C = 100;
  const running = session?.state === "running";
  return (
    <svg className={`lens-wheel${running ? " running" : ""}`} viewBox="0 0 200 200" role="img" aria-label={`Lens wheel: ${seats.map((s) => `${s.agent?.def.name ?? s.id} ${s.seat?.state ?? "idle"}`).join(", ")}`}>
      <circle className="lw-orbit" cx={C} cy={C} r={R} />
      {seats.map(({ id, seat, agent }, i) => {
        const a = (i / Math.max(seats.length, 1)) * 2 * Math.PI - Math.PI / 2;
        const x = C + R * Math.cos(a), y = C + R * Math.sin(a);
        const name = agent?.def.name ?? seat?.name ?? id;
        const mine = proposals.filter((p) => p.agents.includes(id));
        const acc = mine.filter((p) => p.status === "accepted").length;
        const st = running ? seat?.state ?? "thinking" : "idle";
        return (
          <g key={id} className={`lw-seat s-${st}`}>
            <line className="lw-spoke" x1={C} y1={C} x2={x} y2={y} />
            <circle className="lw-node" cx={x} cy={y} r={15} />
            <text className="lw-av" x={x} y={y + 1} textAnchor="middle" dominantBaseline="middle">{agent?.def.avatar ?? "◆"}</text>
            <text className="lw-name" x={x} y={y + (y > C ? 25 : -20)} textAnchor="middle">{name}</text>
            {mine.length > 0 && <text className="lw-count" x={x + 13} y={y - 10} textAnchor="middle">{acc}/{mine.length}</text>}
            <title>{`${name}: ${mine.length} proposed, ${acc} accepted${seat?.error ? `. Last look: ${seat.error}` : ""}`}</title>
          </g>
        );
      })}
      <circle className="lw-core" cx={C} cy={C} r={22} />
      <text className="lw-core-t" x={C} y={C + 1} textAnchor="middle" dominantBaseline="middle">{running ? "…" : "✧"}</text>
    </svg>
  );
}

function CostMeter({ b }: { b: ImproveState["budget"] }) {
  const pct = b.maxUsd > 0 ? Math.min(100, (b.spentTodayUsd / b.maxUsd) * 100) : 100;
  return (
    <div className="imp-meter" title="Spend of the lens seats in the last 24 hours against the daily cap">
      <div className="mono muted">today ${b.spentTodayUsd.toFixed(4)} of ${b.maxUsd.toFixed(2)} · up to ${b.perCallUsd.toFixed(2)} a lens call</div>
      <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={b.maxUsd} aria-valuenow={b.spentTodayUsd}><span style={{ width: `${pct}%` }} className={pct >= 90 ? "hot" : ""} /></div>
    </div>
  );
}

function Card({ p, busy, showTarget, onDecide, onBuild }: { p: Proposal; busy: boolean; showTarget: boolean; onDecide: (d: Status) => void; onBuild: () => void }) {
  return (
    <article className={`imp-card st-${p.status}`}>
      <div className="imp-card-head">
        <b>{p.title}</b>
        <span className={`pill imp-${p.impact}`} title="impact">{p.impact} impact</span>
        <span className="pill" title="effort">{p.effort}</span>
      </div>
      <div className="imp-meta mono muted">
        {showTarget && <span className="imp-target">{KIND[p.target.kind]}: {p.target.title}</span>}
        {p.lenses.map((l) => <span key={l} className="imp-lens">{l}</span>)}
        {p.lenses.length > 1 && <span title="Said by more than one lens">agreed</span>}
      </div>
      {p.why && <p className="imp-why-line">{p.why}</p>}
      <p className="imp-change">{p.change}</p>
      {p.files?.length ? <div className="mono muted imp-files">{p.files.join(" · ")}</div> : null}
      <div className="imp-actions">
        {p.status === "inbox" ? <>
          <button className="sm" disabled={busy} onClick={() => onDecide("accepted")}>Accept</button>
          <button className="sm ghost" disabled={busy} onClick={() => onDecide("parked")}>Park</button>
          <button className="sm ghost" disabled={busy} onClick={() => onDecide("rejected")}>Reject</button>
        </> : <>
          <span className="muted">{p.status} {p.decidedAt ? ago(p.decidedAt) : ""}{p.ticketId != null ? ` · ticket #${p.ticketId}` : p.signalId != null ? " · filed as a task" : ""}</span>
          {p.status === "accepted" && <button className="sm ghost" disabled={busy} onClick={onBuild} title="Start a factory run for it; you approve the plan as usual">Build it</button>}
          {p.status !== "accepted" && <button className="sm ghost" disabled={busy} onClick={() => onDecide("inbox")}>Back to waiting</button>}
        </>}
      </div>
    </article>
  );
}

function SessionLog({ sessions }: { sessions: Session[] }) {
  if (!sessions.length) return null;
  return (
    <details className="imp-log">
      <summary className="muted">Sessions · {sessions.length}</summary>
      {sessions.slice().reverse().slice(0, 12).map((s) => (
        <div key={s.id} className="imp-log-row mono">
          <span className={`dot ${s.state === "done" ? "on" : ""}`} /> {ago(s.ts)} · {s.trigger} · {KIND[s.target.kind]} {s.target.title} · {s.seats.filter((x) => x.state === "done").length}/{s.seats.length} lenses · ${s.costUsd.toFixed(4)} · {s.note ?? s.state}
        </div>
      ))}
    </details>
  );
}
