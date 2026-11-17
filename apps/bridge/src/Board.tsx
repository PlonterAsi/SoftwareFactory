import { useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, Background, type Node, type ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { API, type AgentRunView, type FactoryRunView, type FlowView } from "./api";
import { Station, edgesFor, nodesFor, type CrewIndex, type StationData } from "./FactoryFloor";
import { loadFlow, useRunFlow } from "./flowData";
import { showTicket } from "./BugReport";
import { CHECK_WORD, RUNNER_WORD, ticketsApi, type TicketCheck, type TicketView } from "./Tickets";
import { EmptyState } from "./ui";

/**
 * Home: every ticket across projects on one board (SF behavior brief 4.1). Four lanes, Needs you first:
 * questions before money, a run waiting for your OK, a build to look at, a question to answer. Beside it, the
 * flow of whatever runs right now, drawn live: the step it is on lit, the steps behind it done.
 */
type Lane = "needs" | "running" | "review" | "done";
interface BoardCard {
  id: number; key: string; title: string; kind: string; status: string; project: number | null; projectName: string | null;
  flow: { id: string; name: string; runner: string } | null; run: number | null; pr: { number: number; url: string; state: string } | null; updatedAt: string;
  need?: "check" | "gate" | "look" | "answer" | "decide"; say?: string; questions?: number; step?: string | null; stepName?: string | null; live?: boolean;
}
interface BoardView { lanes: Record<Lane, BoardCard[]>; counts: Record<Lane, number> }

const LANES: { id: Lane; label: string; empty: string }[] = [
  { id: "needs", label: "Needs you", empty: "Nothing waits on you." },
  { id: "running", label: "Running", empty: "No crew at work." },
  { id: "review", label: "In review", empty: "No pull request open." },
  { id: "done", label: "Done", empty: "Nothing closed in the last two weeks." },
];
const NEED_WORD: Record<NonNullable<BoardCard["need"]>, string> = { check: "Before money", gate: "Your OK", look: "Take a look", answer: "Answer", decide: "Decide" };

const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

export function Board({ last, factoryRuns, runs, crew, onShowRun }: { last: number; factoryRuns: FactoryRunView[]; runs: AgentRunView[]; crew: CrewIndex; onShowRun: (run: number) => void }) {
  const [b, setB] = useState<BoardView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  const [batch, setBatch] = useState(false);
  // Read again as events arrive, at most about once a second (a burst of events reads once, after it).
  const lastAt = useRef(0);
  useEffect(() => {
    const wait = Math.max(0, lastAt.current + 1000 - Date.now());
    const t = setTimeout(() => {
      lastAt.current = Date.now();
      fetch(`${API}/api/tickets/board`).then((r) => r.json()).then((j) => { if (j.lanes) { setB(j); setErr(null); } else setErr(j.error ?? "could not read the board"); }).catch((e) => setErr(String(e.message ?? e)));
    }, wait);
    return () => clearTimeout(t);
  }, [last]);

  // Runs waiting for your OK that no ticket carries (an idea typed to the Assistant) still need you.
  const loose = useMemo(() => {
    const carried = new Set((b ? [...b.lanes.needs, ...b.lanes.running] : []).map((c) => c.run).filter((r) => r != null));
    return factoryRuns.filter((r) => r.waiting && !r.finished && !carried.has(r.run));
  }, [b, factoryRuns]);
  const liveCards = b ? [...b.lanes.running, ...b.lanes.needs.filter((c) => c.need === "gate")] : [];
  const selected = liveCards.find((c) => c.id === pick) ?? liveCards.find((c) => c.live) ?? liveCards[0] ?? null;
  const checks = b?.lanes.needs.filter((c) => c.need === "check") ?? [];

  return (
    <section className="pane board" aria-label="Home">
      <header className="page-head board-head">
        <h1>Home</h1>
        <p>{b ? `${b.counts.needs + loose.length} need you · ${b.counts.running} running · ${b.counts.review} in review · ${b.counts.done} done in two weeks` : "Every ticket across your projects, Needs you first."}</p>
        {checks.length > 0 && <button className="sm" onClick={() => setBatch((x) => !x)} aria-expanded={batch}>{batch ? "Close the questions" : `Answer before money: ${checks.reduce((n, c) => n + (c.questions ?? 1), 0)} question${checks.length === 1 && (checks[0].questions ?? 1) === 1 ? "" : "s"}`}</button>}
      </header>
      {err && <div className="err" role="alert">{err}</div>}
      {batch && <CheckBatch onDone={() => setBatch(false)} />}
      <LiveFlow card={selected} factoryRuns={factoryRuns} runs={runs} crew={crew} onShowRun={onShowRun} />
      {!b && !err && <div className="muted pad">Loading the board…</div>}
      {b && (
        <div className="board-lanes">
          {LANES.map((l) => {
            const cards = b.lanes[l.id];
            const n = cards.length + (l.id === "needs" ? loose.length : 0);
            return (
              <section key={l.id} className={`board-lane lane-${l.id}`} aria-label={l.label}>
                <h2>{l.label} <span className="mono muted">{n}</span></h2>
                {n === 0 && <p className="muted small">{l.empty}</p>}
                <ol>
                  {l.id === "needs" && loose.map((r) => (
                    <li key={`run-${r.run}`} className="board-card need-gate">
                      <button className="board-card-main" onClick={() => onShowRun(r.run)}>
                        <span className="board-need">Your OK</span>
                        <b className="board-title">{r.plan?.name ?? r.idea.slice(0, 80)}</b>
                        <span className="muted small">Run #{r.run} waits at {r.waiting!.gate === "gateA" ? "the plan" : "the build"}</span>
                      </button>
                    </li>
                  ))}
                  {cards.map((c) => (
                    <li key={c.id} className={`board-card${c.need ? ` need-${c.need}` : ""}${selected?.id === c.id ? " on" : ""}`}>
                      <button className="board-card-main" onClick={() => (l.id === "running" || c.need === "gate" ? setPick(c.id) : showTicket(c.id, c.project))}
                        title={l.id === "running" || c.need === "gate" ? "Show its flow live above" : "Open the ticket"}>
                        {c.need && <span className="board-need">{NEED_WORD[c.need]}</span>}
                        <span className="board-line"><span className="mono muted">{c.key}</span>{c.projectName && <span className="muted small"> · {c.projectName}</span>}<span className="muted small board-ago">{ago(c.updatedAt)}</span></span>
                        <b className="board-title">{c.title}</b>
                        {c.say && <span className="small board-say">{c.say}</span>}
                        <span className="board-flow small">
                          {c.flow && <span className="board-flowname" title={RUNNER_WORD[c.flow.runner]}>{c.flow.name}</span>}
                          {l.id === "running" && <span className={c.live ? "board-live" : "muted"}>{c.live ? "● " : ""}{c.stepName ?? c.step ?? "starting"}</span>}
                          {c.pr && <a className="link" href={c.pr.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>PR #{c.pr.number}</a>}
                        </span>
                      </button>
                      {(l.id === "running" || c.need === "gate") && <button className="link tiny board-open" onClick={() => showTicket(c.id, c.project)}>Open ticket</button>}
                    </li>
                  ))}
                </ol>
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** The flow of the selected running ticket: an engine run lit by its own events, a session lit by its last step. */
function LiveFlow({ card, factoryRuns, runs, crew, onShowRun }: { card: BoardCard | null; factoryRuns: FactoryRunView[]; runs: AgentRunView[]; crew: CrewIndex; onShowRun: (run: number) => void }) {
  const run = card?.run != null ? factoryRuns.find((r) => r.run === card.run) : undefined;
  const runFlow = useRunFlow(run);
  const [own, setOwn] = useState<FlowView | null>(null);
  useEffect(() => {
    setOwn(null);
    if (!card?.flow || run) return;
    let live = true;
    loadFlow(card.flow.id).then((f) => { if (live) setOwn(f); }).catch(() => {});
    return () => { live = false; };
  }, [card?.flow?.id, run?.run]); // eslint-disable-line react-hooks/exhaustive-deps
  const flow = run ? runFlow : own;
  const nodes = useMemo<Node<StationData>[]>(() => {
    if (!flow) return [];
    if (run) return nodesFor(flow, run, runs, crew);
    // A session or a reader: the steps before the current one are done, the current one is lit.
    const order = flow.steps.filter((s) => !s.within).map((s) => s.id);
    const at = card?.step ? order.indexOf(card.step) : -1;
    return nodesFor(flow).map((n) => {
      const i = order.indexOf(n.id);
      const state = at < 0 || i < 0 ? n.data.state : i < at ? "pass" : i === at ? (card?.live ? "active" : "waiting") : n.data.state;
      return { ...n, data: { ...n.data, state } as StationData };
    });
  }, [flow, run, runs, crew, card?.step, card?.live]);
  const edges = useMemo(() => edgesFor(flow, run), [flow, run]);
  const rf = useRef<ReactFlowInstance<Node<StationData>> | null>(null);
  useEffect(() => { requestAnimationFrame(() => rf.current?.fitView({ padding: 0.08 })); }, [flow?.id, card?.id]);
  if (!card) return <div className="board-live-flow empty"><EmptyState title="Nothing running">When the crew works a ticket, its flow is drawn here, live.</EmptyState></div>;
  return (
    <div className="board-live-flow" aria-label={`Live: ${card.key} ${card.title}`}>
      <div className="board-live-head">
        <span><span className={card.live ? "board-live" : "muted"}>{card.live ? "● Live" : "Paused"}</span> · <span className="mono">{card.key}</span> {card.title}</span>
        <span className="muted small">{card.flow ? `${card.flow.name} flow` : ""}{card.stepName || card.step ? ` · at ${flow?.steps.find((x) => x.id === card.step || x.stations?.includes(card.step ?? ""))?.label ?? card.stepName ?? card.step}` : ""}{card.run != null && <> · <button className="link tiny" onClick={() => onShowRun(card.run!)}>run #{card.run}</button></>}</span>
      </div>
      <div className="board-canvas">
        {flow && <ReactFlow onInit={(i) => { rf.current = i; }} nodes={nodes} edges={edges} nodeTypes={{ station: Station }} fitView fitViewOptions={{ padding: 0.08 }}
          proOptions={{ hideAttribution: true }} nodesConnectable={false} nodesDraggable={false} elementsSelectable={false} panOnDrag zoomOnScroll={false}>
          <Background gap={24} size={1} color="var(--grid)" />
        </ReactFlow>}
      </div>
    </div>
  );
}

/** Every question the check before money asks, across tickets, answered in one sitting. */
function CheckBatch({ onDone }: { onDone: () => void }) {
  const [items, setItems] = useState<{ ticket: TicketView; projectName: string | null; flow: { id: string; name: string } | null; check: TicketCheck }[] | null>(null);
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => { ticketsApi.checks().then((j) => setItems(j.items)).catch((e) => setSaid(String((e as Error).message))); }, []);
  const send = async (run: boolean) => {
    const answers = Object.entries(replies).filter(([, v]) => v.trim()).map(([k, text]) => { const [id, q] = k.split(":"); return { id: Number(id), q, text }; });
    setBusy(true);
    try {
      const r = await ticketsApi.answerChecks(answers, run);
      setSaid(`${r.answered} answer${r.answered === 1 ? "" : "s"} saved.${run ? ` ${r.started.length} ticket${r.started.length === 1 ? "" : "s"} started.${r.held.length ? ` ${r.held.length} still need${r.held.length === 1 ? "s" : ""} something.` : ""}` : ""}`);
      setReplies({});
      const j = await ticketsApi.checks();
      setItems(j.items);
      if (!j.items.length) onDone();
    } catch (e) { setSaid((e as Error).message); } finally { setBusy(false); }
  };
  const filled = Object.values(replies).filter((v) => v.trim()).length;
  return (
    <section className="board-batch" aria-label="Before money: all questions">
      <p className="muted small">SF read each ticket before it costs anything. Answer what you can; a ticket whose questions are all answered can start right away. The caps still guard every run.</p>
      {!items && <div className="muted">Loading…</div>}
      {items?.map((it) => (
        <div key={it.ticket.id} className="board-batch-ticket">
          <div><span className="mono muted">{it.ticket.key}</span> <b>{it.ticket.title}</b>{it.projectName && <span className="muted small"> · {it.projectName}</span>}{it.flow && <span className="muted small"> · {it.flow.name}</span>}</div>
          {it.check.questions.map((q) => (
            <label key={q.id} className={`tk-check-q c-${q.kind}`}>
              <span className="tk-check-kind">{CHECK_WORD[q.kind]}</span>
              <span className="tk-check-ask">{q.ask} <span className="muted small">({q.why})</span></span>
              <textarea rows={2} value={replies[`${it.ticket.id}:${q.id}`] ?? ""} onChange={(e) => setReplies((r) => ({ ...r, [`${it.ticket.id}:${q.id}`]: e.target.value }))} aria-label={`${it.ticket.key}: ${q.ask}`} />
            </label>
          ))}
        </div>
      ))}
      <div className="tk-check-actions">
        <button disabled={busy || !filled} onClick={() => void send(true)}>{busy ? "Saving…" : "Save and start the clear ones"}</button>
        <button className="ghost" disabled={busy || !filled} onClick={() => void send(false)}>Save answers only</button>
        {said && <span className="muted small" role="status">{said}</span>}
      </div>
    </section>
  );
}
