import { useEffect, useMemo, useState, type DragEvent } from "react";
import { API, flowsApi, type FlowSummaryView, type SfEvent } from "./api";
import { peekPendingTicket, takePendingTicket } from "./BugReport";

/**
 * Tickets: every unit of work on a project, in one place. A list or a board,
 * and the ticket page as the work document: one-field edits, the kind's
 * questions, the thread, the status as the next move, and two ways to hand
 * it to the crew (ask an agent, or work it through the factory loop).
 *
 * Works globally, or as a project's panel with `projectId`.
 */

export type TicketKind = "bug" | "request" | "task" | "idea" | "plan" | "question";
export type TicketStatus = "open" | "ready" | "in_progress" | "built" | "closed" | "rejected";
export interface TicketView {
  id: number; key: string; number: number | null; level: "epic" | "ticket" | "subtask"; blocked: boolean; children: { total: number; done: number }; kind: TicketKind; title: string; body: string; answers: Record<string, string>; project: number | null; status: TicketStatus;
  priority: string | null; severity: string | null; size: "S" | "M" | "L" | null; flow?: string | null; assignee: string | null; parentId: number | null; lineOrder: number | null; tags: string[];
  source: string; openedBy: string; run: number | null; pr: { repo: string; number: number; url: string; state: "open" | "merged" | "closed" } | null; branch: string | null; branchDir: string | null; pushedUrl?: string | null; createdAt: string; updatedAt: string; closedAt: string | null; lastNote: string | null;
}
interface NoteView { eventId: number; ts: string; by: string; kind: "note" | "reply" | "status" | "event"; text: string; status: TicketStatus | null; costUsd: number | null }
type TimelineCat = "said" | "status" | "step" | "agent" | "decision" | "retry" | "run" | "git" | "event";
interface TimelineEntry { eventId: number; ts: string; by: string; cat: TimelineCat; text: string; costUsd: number | null; status: TicketStatus | null; run: number | null }
interface LinkView { to: number; relation: string; title?: string; status?: TicketStatus; key?: string }
interface Detail {
  ticket: TicketView; notes: NoteView[]; timeline?: TimelineEntry[]; links: LinkView[]; lines: TicketView[]; parent: TicketView | null; moves: { to: TicketStatus; label: string }[]; document: string;
  run: { id: number; outcome: string | null; station: string | null; state: string | null; spentUsd: number | null } | null;
  repo: { source: string; dir: string; branch: string | null; github?: { owner: string; name: string } } | null;
  working: boolean;
  /** In a project that lives in a repo: the route Work it takes when you do not choose, and why. */
  route?: { route: "light" | "engine"; why: string } | null;
  steps?: { step: string; state: "running" | "passed" | "failed" | "skipped"; note: string; at: string }[];
  /** The flow it follows if worked now, and why (you picked it, or its kind's). */
  flow?: { id: string; name: string; runner: string; why: string; chosen: boolean } | null;
  queue: { position: number | null; why: string | null } | null;
}
interface AutoWork { on: boolean; maxUsd: number; dailyUsd: number; wip: number }
interface Question { key: string; label: string; short?: boolean; required?: boolean; choices?: string[] }
interface Meta { kinds: { code: TicketKind; label: string; questions: Question[] }[]; statuses: { code: TicketStatus; label: string; closed?: boolean; wantsLook?: boolean }[]; priorities: { code: string; label: string }[]; severities: string[]; relations: string[] }
interface Counts { byStatus: Record<string, number>; byKind: Record<string, number>; open: number; look: number; you: number; total: number; oldest: { id: number; title: string; createdAt: string } | null }
type View = "you" | "open" | "look" | "agents" | "plans" | "closed" | "all";

export type CheckKind = "clarity" | "confidence" | "decision";
export interface CheckQuestion { id: string; kind: CheckKind; ask: string; why: string }
export interface TicketCheck { verdict: "go" | "ask"; questions: CheckQuestion[]; answered: number }
export const CHECK_WORD: Record<CheckKind, string> = { clarity: "Clarity", confidence: "Confidence", decision: "Your call" };
export const RUNNER_WORD: Record<string, string> = { engine: "the whole engine", session: "one Builder session", answer: "a reader answers, nothing changes", door: "its own screen" };

export interface WaitingItem { ticket: TicketView; projectName: string | null; need: "look" | "answer" | "decide"; say: string; moves: { to: TicketStatus; label: string }[] }

export const KIND_GLYPH: Record<TicketKind, string> = { bug: "✖", request: "➜", task: "▢", idea: "✶", plan: "☰", question: "?" };
const STATUS_LABEL: Record<TicketStatus, string> = { open: "Open", ready: "Ready", in_progress: "In progress", built: "For your look", closed: "Closed", rejected: "Rejected" };
const BOARD: TicketStatus[] = ["open", "ready", "in_progress", "built", "closed"];
const VIEWS: { id: View; label: string }[] = [
  { id: "you", label: "Waiting on you" }, { id: "open", label: "Open" }, { id: "agents", label: "Crew working" }, { id: "plans", label: "Epics" }, { id: "closed", label: "Closed" }, { id: "all", label: "All" },
];

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error ?? `${method} ${path} failed`), { body: j });
  return j as T;
}

export const ticketsApi = {
  meta: () => call<Meta>("GET", "/api/tickets/meta"),
  list: (q: { project?: number | null; view?: View; q?: string; kind?: string }) => {
    const s = new URLSearchParams();
    if (q.project != null) s.set("project", String(q.project));
    if (q.view) s.set("view", q.view);
    if (q.q) s.set("q", q.q);
    if (q.kind) s.set("kind", q.kind);
    return call<{ tickets: TicketView[]; counts: Counts }>("GET", `/api/tickets?${s}`);
  },
  get: (id: number) => call<Detail>("GET", `/api/tickets/${id}`),
  auto: (patch?: Partial<AutoWork>) => call<AutoWork>(patch ? "POST" : "GET", "/api/tickets/auto", patch),
  waiting: (project?: number | null) => call<{ items: WaitingItem[] }>("GET", `/api/tickets/waiting${project != null ? `?project=${project}` : ""}`),
  open: (t: Partial<TicketView> & { answers?: Record<string, string>; parent?: number | null }) => call<TicketView>("POST", "/api/tickets", t),
  edit: (id: number, field: string, value: unknown, key?: string) => call<TicketView>("POST", `/api/tickets/${id}/edit`, { field, value, key }),
  say: (id: number, text: string, status?: TicketStatus) => call<TicketView>("POST", `/api/tickets/${id}/say`, { text, status }),
  link: (id: number, to: number | string, relation: string) => call<TicketView>("POST", `/api/tickets/${id}/link`, { to, relation }),
  send: (id: number) => call<TicketView>("POST", `/api/tickets/${id}/send`, {}),
  linkPr: (id: number, pr: string) => call<TicketView>("POST", `/api/tickets/${id}/pr`, { pr }),
  line: (id: number, dir: "up" | "down") => call<TicketView[]>("POST", `/api/tickets/${id}/line`, { dir }),
  work: (id: number, where: "auto" | "repo" | "new" = "auto", maxUsd?: number, again?: boolean, route?: "light" | "engine", anyway?: boolean) => call<{ run: number | null; branch?: string; route?: { route: "light" | "engine"; why: string } }>("POST", `/api/tickets/${id}/work`, { maxUsd, where, again, route, anyway }),
  check: (id: number) => call<TicketCheck>("GET", `/api/tickets/${id}/check`),
  checks: (project?: number | null) => call<{ items: { ticket: TicketView; projectName: string | null; flow: { id: string; name: string } | null; check: TicketCheck }[] }>("GET", `/api/tickets/checks${project != null ? `?project=${project}` : ""}`),
  answerChecks: (answers: { id: number; q: string; text: string }[], run: boolean) => call<{ answered: number; started: { id: number; run: number | null; flow?: string }[]; held: { id: number; error: string }[] }>("POST", "/api/tickets/checks", { answers, run }),
  ask: (id: number, agent?: string) => call<{ reply?: string; error?: string }>("POST", `/api/tickets/${id}/ask`, { agent }),
};

/** Ticket counts for a badge (the tab, a project card): refetched when a ticket event lands. */
export function useTicketCounts(events: SfEvent[], project?: number | null) {
  const [c, setC] = useState<Counts | null>(null);
  const last = events.filter((e) => e.type.startsWith("ticket.")).at(-1)?.id ?? 0;
  useEffect(() => { ticketsApi.list({ project, view: "open" }).then((r) => setC(r.counts)).catch(() => {}); }, [last, project]);
  return c;
}

/** Projects to file a ticket under, from the projects model (refetched when a project changes). */
function useProjectList(events: SfEvent[]) {
  const [list, setList] = useState<{ id: number; title: string }[]>([]);
  const last = events.filter((e) => e.type.startsWith("project.") || e.type === "factory.run.started" || e.type === "order.node").at(-1)?.id ?? 0;
  useEffect(() => {
    fetch(`${API}/api/projects`).then((r) => r.json()).then((j) => {
      const rows = (Array.isArray(j) ? j : j.projects ?? []) as { id: number; name: string; status?: string }[];
      setList(rows.filter((p) => p.status !== "archived").map((p) => ({ id: p.id, title: p.name })));
    }).catch(() => {});
  }, [last]);
  return list;
}

export interface CrewRef { id: string; name: string; avatar: string }

export function Tickets({ events, projectId = null, crew = [], onShowRun }: {
  events: SfEvent[]; projectId?: number | null; crew?: CrewRef[]; onShowRun?: (run: number) => void;
}) {
  const projects = useProjectList(events);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [view, setView] = useState<View>("open");
  const [picked, setPicked] = useState(false);
  const [mode, setMode] = useState<"list" | "board">("list");
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<TicketKind | "">("");
  const [data, setData] = useState<{ tickets: TicketView[]; counts: Counts } | null>(null);
  const [sel, setSel] = useState<number | null>(() => peekPendingTicket());
  useEffect(() => {
    takePendingTicket();
    // Report a bug and a broken screen open their bug here.
    const on = (e: Event) => { setSel((e as CustomEvent<number>).detail); takePendingTicket(); };
    window.addEventListener("sf:ticket", on);
    return () => window.removeEventListener("sf:ticket", on);
  }, []);
  const [err, setErr] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  // Anything that can change a ticket: its own events, and the runs that write back onto tickets.
  const last = events.filter((e) => e.type.startsWith("ticket.") || e.type === "factory.run.finished" || e.type === "factory.station" || e.type === "factory.gate").at(-1)?.id ?? 0;
  useEffect(() => { ticketsApi.meta().then(setMeta).catch(() => {}); }, []);
  useEffect(() => {
    let stop = false;
    const t = setTimeout(() => {
      ticketsApi.list({ project: projectId, view: mode === "board" ? "all" : view, q: q.trim() || undefined, kind: kind || undefined })
        .then((r) => { if (!stop) setData(r); }).catch((e) => !stop && setErr((e as Error).message));
    }, 120);
    return () => { stop = true; clearTimeout(t); };
  }, [last, projectId, view, q, kind, mode]);
  // Opens on what needs you when something does; otherwise on the open list.
  useEffect(() => { if (!picked && data?.counts.you && view === "open") { setView("you"); setPicked(true); } }, [data?.counts.you]);
  const tickets = data?.tickets ?? [];
  const counts = data?.counts;
  const crewById = useMemo(() => Object.fromEntries(crew.map((c) => [c.id, c])), [crew]);
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); } catch (e) { setErr((e as Error).message); } };

  return (
    <section className="pane tickets" aria-label="Tickets">
      <header className="pane-head">
        <span>Tickets</span>
        <span className="muted mono">
          {counts ? <>{counts.open} open{counts.you ? <> · <b className="look-count">{counts.you} waiting on you</b></> : null} · {counts.total} in all</> : "…"}
        </span>
      </header>
      <div className="tk-bar">
        <div className="tabs" role="tablist" aria-label="Ticket views">
          {VIEWS.map((v) => (
            <button key={v.id} role="tab" aria-selected={view === v.id && mode === "list"} className={view === v.id && mode === "list" ? "tab on" : "tab"} onClick={() => { setView(v.id); setMode("list"); setPicked(true); }}>
              {v.label}{v.id === "you" && counts?.you ? ` · ${counts.you}` : ""}
            </button>
          ))}
          <button role="tab" aria-selected={mode === "board"} className={mode === "board" ? "tab on" : "tab"} onClick={() => setMode("board")}>Board</button>
        </div>
        <div className="tk-tools">
          <input className="tk-search" placeholder="Search words, answers, the thread, or SF-12" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search tickets" />
          <select value={kind} onChange={(e) => setKind(e.target.value as TicketKind | "")} aria-label="Kind">
            <option value="">every kind</option>
            {meta?.kinds.map((k) => <option key={k.code} value={k.code}>{k.label}{counts?.byKind[k.code] ? ` (${counts.byKind[k.code]})` : ""}</option>)}
          </select>
          <AutoToggle last={last} onError={setErr} />
          <button className="sm" onClick={() => setMaking((m) => !m)}>{making ? "Cancel" : "+ New ticket"}</button>
        </div>
      </div>
      {making && meta && <NewTicket meta={meta} projectId={projectId} projects={projects} onDone={(t) => { setMaking(false); setSel(t.id); }} onError={setErr} />}
      {err && <div className="err tk-err" role="alert">{err} <button className="link" onClick={() => setErr(null)}>dismiss</button></div>}
      <div className={`tk-body ${sel != null ? "with-page" : ""}`}>
        <div className="tk-main">
          {mode === "board"
            ? <Board tickets={tickets} sel={sel} onSelect={setSel} crew={crewById} onMove={(id, to) => run(() => ticketsApi.say(id, "", to))} />
            : view === "you" ? <Waiting events={events} projectId={projectId} sel={sel} onSelect={setSel} onError={setErr} showProject={projectId == null} />
            : <List tickets={tickets} view={view} sel={sel} onSelect={setSel} crew={crewById} counts={counts} />}
        </div>
        {sel != null && meta && <TicketPage key={sel} id={sel} meta={meta} last={last} crew={crew} projects={projects} onClose={() => setSel(null)} onSelect={setSel} onShowRun={onShowRun} onError={setErr} />}
      </div>
    </section>
  );
}

function Who({ id, crew }: { id: string | null; crew: Record<string, CrewRef> }) {
  if (!id) return <span className="muted">nobody</span>;
  const c = crew[id];
  return <span className="tk-who" title={c?.name ?? id}>{c ? <span className="tk-av" aria-hidden>{c.avatar}</span> : null}{c?.name ?? id}</span>;
}

function List({ tickets, view, sel, onSelect, crew, counts }: { tickets: TicketView[]; view: View; sel: number | null; onSelect: (id: number) => void; crew: Record<string, CrewRef>; counts?: Counts }) {
  if (!tickets.length) {
    return <div className="empty">{view === "look" ? "Nothing waits for your look." : view === "agents" ? "No agent is working a ticket right now." : "No tickets here yet. Open one with + New ticket, or say a task to the Overseer and the Order Engine files it."}</div>;
  }
  return (
    <>
      {counts?.oldest && view === "open" && <div className="tk-summary muted">Oldest open: <button className="link" onClick={() => onSelect(counts.oldest!.id)}>{counts.oldest.title}</button> · opened {ago(counts.oldest.createdAt)}</div>}
      <ul className="tk-list" role="listbox" aria-label="Tickets">
        {tickets.map((t) => (
          <li key={t.id} role="option" aria-selected={t.id === sel} className={`tk-row s-${t.status} ${t.id === sel ? "on" : ""} ${view === "plans" ? `lv-${t.level}` : ""}`} onClick={() => onSelect(t.id)}>
            <span className={`tk-kind k-${t.kind}`} title={t.kind === "plan" ? "epic" : t.kind} aria-hidden>{KIND_GLYPH[t.kind]}</span>
            <span className="tk-num mono">{t.key}</span>
            <span className="tk-title">
              <span className="tk-title-t">{t.title}</span>
              <span className="tk-sub">
                <span className={`tk-status st-${t.status}`}>{STATUS_LABEL[t.status]}</span>
                {t.priority && <span className={`tk-pri p-${t.priority}`}>{t.priority.replace("_", " ")}</span>}
                {t.pr && <span className={`tk-prchip pr-${t.pr.state}`} title={`PR #${t.pr.number} ${t.pr.state}`}>PR #{t.pr.number}</span>}
                {t.size && <span className="tk-size mono" title={`Size ${t.size}`}>{t.size}</span>}
                {t.blocked && <span className="tk-blocked" title="Another ticket that is still open blocks this one">blocked</span>}
                {t.children.total > 0 && <Progress c={t.children} label={t.kind === "plan" ? "tickets" : "subtasks"} />}
                <span className="tk-meta muted">{t.run != null ? <span className="tk-run mono">run #{t.run}</span> : t.assignee ? <Who id={t.assignee} crew={crew} /> : t.source !== "you" ? `from ${t.source}` : ""}</span>
                {t.lastNote && <span className="tk-last muted">{t.lastNote}</span>}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Columns by status. Drag a card to the next column to move it; the core refuses moves that are not allowed. */
function Board({ tickets, sel, onSelect, crew, onMove }: { tickets: TicketView[]; sel: number | null; onSelect: (id: number) => void; crew: Record<string, CrewRef>; onMove: (id: number, to: TicketStatus) => void }) {
  const [over, setOver] = useState<TicketStatus | null>(null);
  const drop = (to: TicketStatus) => (e: DragEvent) => {
    e.preventDefault(); setOver(null);
    const id = Number(e.dataTransfer.getData("text/ticket"));
    const t = tickets.find((x) => x.id === id);
    if (t && t.status !== to) onMove(id, to);
  };
  return (
    <div className="tk-board">
      {BOARD.map((s) => {
        const col = tickets.filter((t) => (s === "closed" ? t.status === "closed" || t.status === "rejected" : t.status === s));
        return (
          <div key={s} className={`tk-col st-${s} ${over === s ? "over" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(s); }} onDragLeave={() => setOver(null)} onDrop={drop(s)} aria-label={STATUS_LABEL[s]}>
            <div className="tk-col-head"><span>{STATUS_LABEL[s]}</span><span className="mono muted">{col.length}</span></div>
            {col.slice(0, 60).map((t) => (
              <button key={t.id} draggable onDragStart={(e) => e.dataTransfer.setData("text/ticket", String(t.id))} className={`tk-card ${t.id === sel ? "on" : ""}`} onClick={() => onSelect(t.id)}>
                <span className="tk-card-top"><span className={`tk-kind k-${t.kind}`} aria-hidden>{KIND_GLYPH[t.kind]}</span><span className="mono muted">{t.key}</span>{t.priority === "now" && <span className="tk-pri p-now">now</span>}{t.blocked && <span className="tk-blocked">blocked</span>}</span>
                <span className="tk-card-title">{t.title}</span>
                <span className="tk-card-foot muted">{t.run != null ? <span className="tk-run mono">run #{t.run}</span> : <Who id={t.assignee} crew={crew} />}</span>
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function NewTicket({ meta, projectId, projects, onDone, onError }: { meta: Meta; projectId: number | null; projects: { id: number; title: string }[]; onDone: (t: TicketView) => void; onError: (m: string) => void }) {
  const [kind, setKind] = useState<TicketKind>("task");
  const [title, setTitle] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [priority, setPriority] = useState("");
  const [project, setProject] = useState<number | null>(projectId);
  const qs = meta.kinds.find((k) => k.code === kind)?.questions.filter((q) => q.short) ?? [];
  const submit = async () => {
    try { onDone(await ticketsApi.open({ kind, title, answers, priority: priority || null, project })); } catch (e) { onError((e as Error).message); }
  };
  return (
    <form className="tk-new" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <div className="tk-kinds" role="radiogroup" aria-label="Kind">
        {meta.kinds.map((k) => (
          <button type="button" key={k.code} role="radio" aria-checked={kind === k.code} className={`tk-kindbtn ${kind === k.code ? "on" : ""}`} onClick={() => setKind(k.code)}>
            <span className={`tk-kind k-${k.code}`} aria-hidden>{KIND_GLYPH[k.code]}</span> {k.label}
          </button>
        ))}
      </div>
      <input className="tk-input" placeholder="Title, in a few words" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus aria-label="Title" />
      {qs.map((q) => (
        <label key={q.key} className="tk-q">
          <span className="muted">{q.label}{q.required ? "" : " (optional)"}</span>
          <textarea rows={2} value={answers[q.key] ?? ""} onChange={(e) => setAnswers({ ...answers, [q.key]: e.target.value })} />
        </label>
      ))}
      <div className="composer-row">
        <select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority">
          <option value="">no priority</option>
          {meta.priorities.map((p) => <option key={p.code} value={p.code}>{p.label}</option>)}
        </select>
        {projectId == null && projects.length > 0 && (
          <select value={project ?? ""} onChange={(e) => setProject(e.target.value ? Number(e.target.value) : null)} aria-label="Project">
            <option value="">no project</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
        )}
        <button type="submit" disabled={!title.trim() && !Object.values(answers).some((v) => v.trim())}>Open ticket</button>
      </div>
    </form>
  );
}

const STATION_ORDER = ["intake", "council", "discover", "plan", "gateA", "tests", "build", "test", "fix", "review", "evaluate", "gateB", "ship"];

/** The ticket page: the work document, edited one field at a time, with its thread and the crew hand-off. */
function TicketPage({ id, meta, last, crew, projects, onClose, onSelect, onShowRun, onError }: {
  id: number; meta: Meta; last: number; crew: CrewRef[]; projects: { id: number; title: string }[];
  onClose: () => void; onSelect: (id: number) => void; onShowRun?: (run: number) => void; onError: (m: string) => void;
}) {
  const [d, setD] = useState<Detail | null>(null);
  const [say, setSay] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [linkTo, setLinkTo] = useState("");
  const [showDoc, setShowDoc] = useState(false);
  const [prRef, setPrRef] = useState("");
  // A Work it the factory held back because that idea is built or building (hooks stay above the early return).
  const [dup, setDup] = useState<{ run: number; error: string } | null>(null);
  // The check before money: its open questions, your answers so far, and the flows a ticket may pick.
  const [check, setCheck] = useState<TicketCheck | null>(null);
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [flows, setFlows] = useState<FlowSummaryView[]>([]);
  useEffect(() => { ticketsApi.get(id).then(setD).catch((e) => onError((e as Error).message)); }, [id, last]);
  useEffect(() => { ticketsApi.check(id).then(setCheck).catch(() => setCheck(null)); }, [id, last]);
  useEffect(() => { setReplies({}); }, [id]);
  useEffect(() => { flowsApi.list().then((j) => setFlows(j.flows.filter((f) => f.runner !== "door"))).catch(() => {}); }, []);
  if (!d) return <aside className="tk-page"><div className="empty">Loading…</div></aside>;
  const t = d.ticket;
  const questions = meta.kinds.find((k) => k.code === t.kind)?.questions ?? [];
  const crewById = Object.fromEntries(crew.map((c) => [c.id, c]));
  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try { await fn(); setD(await ticketsApi.get(id)); } catch (e) { onError((e as Error).message); } finally { setBusy(null); }
  };
  const edit = (field: string, value: unknown, key?: string) => act("edit", () => ticketsApi.edit(id, field, value, key));
  // The factory builds one idea once a day: when this one is already built or building, say so and offer both ways on.
  const work = async (where: "auto" | "repo" = "auto", again = false, route?: "light" | "engine", anyway = false) => {
    setBusy("work"); setDup(null);
    try { await ticketsApi.work(id, where, undefined, again, route, anyway); setD(await ticketsApi.get(id)); }
    catch (e) {
      const b = (e as { body?: { duplicateOf?: number; check?: TicketCheck } }).body;
      if (b?.duplicateOf != null) setDup({ run: b.duplicateOf, error: (e as Error).message });
      else if (b?.check) setCheck(b.check);
      else onError((e as Error).message);
    } finally { setBusy(null); }
  };
  // Your answers go on the ticket; with go, the ticket starts once nothing is left to ask.
  const answer = async (go: boolean) => {
    const answers = Object.entries(replies).filter(([, v]) => v.trim()).map(([q, text]) => ({ id, q, text }));
    setBusy("check");
    try {
      const r = await ticketsApi.answerChecks(answers, go);
      setReplies({});
      if (r.held.length) onError(r.held[0].error);
      setD(await ticketsApi.get(id)); setCheck(await ticketsApi.check(id));
    } catch (e) { onError((e as Error).message); } finally { setBusy(null); }
  };
  const asking = !!check && check.verdict === "ask" && (t.status === "open" || t.status === "ready") && !d.working;
  const closed = t.status === "closed" || t.status === "rejected";
  const engineFirst = d.route?.route === "engine";
  // In a repo an epic that holds tickets is worked through them, one branch each (the core refuses a run over the whole epic).
  const epicOfTickets = !!d.repo && t.kind === "plan" && t.children.total > 0;
  const stationAt = d.run?.station ? STATION_ORDER.indexOf(d.run.station) : -1;
  return (
    <aside className="tk-page" aria-label={`Ticket ${t.key}`}>
      <div className="tk-page-head">
        <span className={`tk-kind k-${t.kind}`} aria-hidden>{KIND_GLYPH[t.kind]}</span>
        <span className="mono muted" title={`Ticket ${t.key}${t.key !== `#${t.id}` ? ` (#${t.id} in the whole factory)` : ""}`}>{t.key}</span>
        <InlineText value={t.title} className="tk-page-title" onSave={(v) => edit("title", v)} label="Title" />
        <button className="ghost sm" onClick={onClose} aria-label="Close the ticket page">✕</button>
      </div>
      <div className="tk-chips">
        <ChipSelect label="kind" value={t.kind} options={meta.kinds.map((k) => [k.code, k.label])} onChange={(v) => edit("kind", v)} />
        <span className={`tk-status st-${t.status}`}>{STATUS_LABEL[t.status]}</span>
        {t.blocked && <span className="tk-blocked" title="Another ticket that is still open blocks this one: see Links">blocked</span>}
        <ChipSelect label="priority" value={t.priority ?? ""} options={[["", "+ priority"], ...meta.priorities.map((p) => [p.code, p.label] as [string, string])]} onChange={(v) => edit("priority", v || null)} />
        <ChipSelect label="size" value={t.size ?? ""} options={[["", "+ size"], ["S", "size S"], ["M", "size M"], ["L", "size L"]]} onChange={(v) => edit("size", v || null)} />
        {flows.length > 0 && <ChipSelect label="flow" value={t.flow ?? ""} options={[["", `flow: ${d.flow && !d.flow.chosen ? d.flow.name : "its kind's own"}`], ...flows.map((f) => [f.id, `flow: ${f.name}`] as [string, string])]} onChange={(v) => edit("flow", v || null)} />}
        {t.kind === "bug" && <ChipSelect label="severity" value={t.severity ?? ""} options={[["", "+ severity"], ...meta.severities.map((s) => [s, s] as [string, string])]} onChange={(v) => edit("severity", v || null)} />}
        <ChipSelect label="assignee" value={t.assignee ?? ""} options={[["", "+ assignee"], ["you", "you"], ...crew.map((c) => [c.id, `${c.avatar} ${c.name}`] as [string, string])]} onChange={(v) => edit("assignee", v || null)} />
        {projects.length > 0 && <ChipSelect label="project" value={t.project != null ? String(t.project) : ""} options={[["", "+ project"], ...projects.map((p) => [String(p.id), p.title] as [string, string])]} onChange={(v) => edit("project", v ? Number(v) : null)} />}
        <InlineText value={t.tags.join(", ")} placeholder="+ tags" className="tk-chip" onSave={(v) => edit("tags", v)} label="Tags" />
      </div>
      {d.parent && <div className="muted tk-parent">{t.level === "subtask" ? "Subtask of" : "Part of epic"} <button className="link" onClick={() => onSelect(d.parent!.id)}>{d.parent.key} {d.parent.title}</button></div>}

      <div className="tk-crew">
        {epicOfTickets ? null : d.flow?.runner === "answer" ? (
          <button disabled={closed || busy != null || d.working} onClick={() => void work(d.repo ? "repo" : "auto")} title={`${d.flow.name}: a reader goes through ${d.repo ? `a read-only copy of ${d.repo.source}` : "the ticket and its project"} and answers here, with the files it read. Nothing is changed. Up to $0.30.`}>
            {busy === "work" ? "Starting…" : d.working ? "Reading…" : t.status === "built" ? "Answer it again" : "Find the answer"}
          </button>
        ) : d.repo ? (() => {
          // Two routes in a repo: one Builder session, or the whole engine. The suggested one is the main button; the other is one press away.
          const running = !!d.run && !d.run.outcome;
          const off = closed || busy != null || d.working || running;
          const light = (
            <button key="light" className={engineFirst ? "ghost" : undefined} disabled={off} onClick={() => work("repo", false, "light")}
              title={`One Builder session on a new branch of a clone of ${d.repo.source}, then the checks and a Reviewer on the diff. Up to $0.60. The original repo is not touched.`}>
              {busy === "work" ? "Starting…" : d.working ? "Builder at work in the repo" : engineFirst ? "One session instead" : t.branch ? "Work it again in the repo" : "Work it in the repo"}
            </button>
          );
          const engine = d.route ? (
            <button key="engine" className={engineFirst ? undefined : "ghost"} disabled={off} onClick={() => work("repo", false, "engine")}
              title={`The whole engine on a new branch of a clone of ${d.repo.source}: the change is designed and criticised, planned for your approval, built feature by feature, reviewed and judged on the running site. Up to this project's limit for a next version ($1.50 unless you set one). The original repo is not touched.`}>
              {busy === "work" ? "Starting…" : running ? "Engine at work" : engineFirst ? (t.branch ? "Work it again on the engine" : "Work it on the engine") : "On the engine instead"}
            </button>
          ) : null;
          return engineFirst ? [engine, light] : [light, engine];
        })() : (
          <button disabled={closed || busy != null} onClick={() => work()} title="The factory loop builds it: Council, plan, locked tests, build, review, fix, ship. The run writes back here.">
            {busy === "work" ? "Starting…" : d.run && !d.run.outcome ? "Crew at work" : "Work it with the crew"}
          </button>
        )}
        <button className="ghost" disabled={busy != null} onClick={() => act("ask", () => ticketsApi.ask(id))} title="One short, capped call: the assignee (or the Overseer) reads the ticket and replies on the thread.">
          {busy === "ask" ? "Asking…" : `Ask ${t.assignee && crewById[t.assignee] ? crewById[t.assignee].name : "the Overseer"}`}
        </button>
        <button className="ghost" onClick={() => setShowDoc((s) => !s)}>{showDoc ? "Hide" : "Work document"}</button>
      </div>
      {epicOfTickets && !closed && (
        <div className="tk-queue tk-route" role="note">
          This epic is worked through its tickets ({t.children.done} of {t.children.total} done): open one and press Work it. Each gets its own branch.
        </div>
      )}
      {d.flow && (t.status === "open" || t.status === "ready") && !d.working && !(d.run && !d.run.outcome) && (
        <div className="tk-queue tk-route" role="note">
          Follows the <a href="#/factory/flows" className="link">{d.flow.name}</a> flow: {RUNNER_WORD[d.flow.runner] ?? d.flow.runner}. Why: {d.flow.chosen ? d.flow.why : d.repo && d.route && d.flow.runner !== "answer" ? d.route.why : d.flow.why}.
        </div>
      )}
      {asking && (
        <section className="tk-check" aria-label="Before it costs money">
          <div className="tk-check-head"><b>Before it costs money</b> <span className="muted small">SF read the ticket and needs {check!.questions.length === 1 ? "one answer" : `${check!.questions.length} answers`} from you first. Each goes on the ticket.</span></div>
          {check!.questions.map((q) => (
            <label key={q.id} className={`tk-check-q c-${q.kind}`}>
              <span className="tk-check-kind">{CHECK_WORD[q.kind]}</span>
              <span className="tk-check-ask">{q.ask} <span className="muted small">({q.why})</span></span>
              <textarea rows={2} value={replies[q.id] ?? ""} onChange={(e) => setReplies((r) => ({ ...r, [q.id]: e.target.value }))} aria-label={q.ask} />
            </label>
          ))}
          <div className="tk-check-actions">
            <button disabled={busy != null || !check!.questions.every((q) => (replies[q.id] ?? "").trim())} onClick={() => void answer(true)}>{busy === "check" ? "Saving…" : "Answer and work it"}</button>
            <button className="ghost" disabled={busy != null || !Object.values(replies).some((v) => v.trim())} onClick={() => void answer(false)}>Save answers</button>
            <button className="ghost" disabled={busy != null || closed} onClick={() => void work(d.repo ? "repo" : "auto", false, undefined, true)} title="Run it as it is. The caps still guard the money.">Work it anyway</button>
          </div>
        </section>
      )}
      {d.queue && (
        <div className={`tk-queue ${d.queue.position != null ? "in-line" : ""}`} role="status">
          {d.queue.position != null
            ? d.queue.position === 1 ? "Next in line: the crew starts it as soon as a slot is free." : `Number ${d.queue.position} in line for the crew.`
            : d.queue.why}
        </div>
      )}
      {dup && (
        <div className="tk-dup" role="alert">
          <span>{dup.error}</span>
          {onShowRun && <button className="sm" onClick={() => onShowRun(dup.run)}>Open run #{dup.run}</button>}
          <button className="sm ghost" onClick={() => work("auto", true)}>Work it again anyway</button>
        </div>
      )}
      {d.run && (
        <div className="tk-runstrip" aria-label={`Factory run ${d.run.id}`}>
          <button className="link mono" onClick={() => onShowRun?.(d.run!.id)}>run #{d.run.id}</button>
          <div className="tk-stations" aria-hidden>
            {STATION_ORDER.map((s, i) => <span key={s} title={s} className={`tk-st ${d.run!.outcome === "shipped" || i < stationAt ? "done" : i === stationAt ? `now ${d.run!.state ?? ""}` : ""}`} />)}
          </div>
          <span className="muted mono">{d.run.outcome ?? `${d.run.station ?? "starting"} ${d.run.state ?? ""}`}{d.run.spentUsd != null ? ` · $${Number(d.run.spentUsd).toFixed(4)}` : ""}</span>
        </div>
      )}
      {!!d.steps?.length && (
        <div className="tk-runstrip tk-steps" aria-label="Harness steps of the latest pass">
          <span className="muted">Steps</span>
          {d.steps.map((x) => <span key={x.step} className={`tk-step s-${x.state}`} title={x.note || x.state}>{x.state === "passed" ? "✓" : x.state === "failed" ? "✕" : x.state === "skipped" ? "–" : "●"} {x.step}</span>)}
        </div>
      )}
      {t.pr && (
        <div className={`tk-runstrip tk-pr pr-${t.pr.state}`} aria-label="Pull request">
          <span className="mono">⇄ PR #{t.pr.number}</span>
          <span className="muted">{t.pr.state === "open" ? "open as a draft · CI runs on it · a merge moves this ticket on" : t.pr.state === "merged" ? "merged" : "closed without merging"}</span>
          <a className="ghost tiny" href={t.pr.url} target="_blank" rel="noreferrer">Open on GitHub</a>
        </div>
      )}
      {!t.pr && d.repo?.github && (
        <form className="tk-runstrip tk-prlink" aria-label="Link a pull request" onSubmit={(e) => { e.preventDefault(); if (prRef.trim()) void act("pr", () => ticketsApi.linkPr(id, prRef.trim()).then(() => setPrRef(""))); }}>
          <span className="mono">⇄</span>
          <span className="muted">Done in a pull request elsewhere?</span>
          <input value={prRef} onChange={(e) => setPrRef(e.target.value)} placeholder="PR number or address" aria-label="Pull request number or address" />
          <button className="ghost tiny" disabled={!prRef.trim() || busy === "pr"}>{busy === "pr" ? "Linking…" : "Link it"}</button>
        </form>
      )}
      {t.branch && !t.pr && (
        <div className="tk-runstrip tk-branch" aria-label="Branch">
          <span className="mono">⑂ {t.branch}</span>
          <span className="muted mono tk-branch-dir" title={t.branchDir ?? ""}>{t.branchDir}</span>
          {d.repo?.github && !t.pushedUrl && <button className="primary tiny" disabled={busy === "send"} onClick={() => void act("send", () => ticketsApi.send(id))} title="Sends only this branch, never main. Uses your GitHub token, or this computer's own Git sign-in.">{busy === "send" ? "Sending…" : "Send to GitHub"}</button>}
          {d.repo?.github && t.pushedUrl && <><span className="muted">on GitHub</span><a className="ghost tiny" href={t.pushedUrl} target="_blank" rel="noreferrer">Open the pull request</a></>}
          {!d.repo?.github && d.repo && !t.pushedUrl && <button className="primary tiny" disabled={busy === "send"} onClick={() => void act("send", () => ticketsApi.send(id))} title="Adds only this branch to your own folder. Your files and your current branch there do not change.">{busy === "send" ? "Adding…" : "Add to my folder"}</button>}
          {!d.repo?.github && t.pushedUrl && <span className="muted">in your folder as this branch</span>}
        </div>
      )}
      {showDoc && <pre className="tk-doc">{d.document}</pre>}

      <div className="tk-sections">
        <Section label="What it is about" value={t.body} onSave={(v) => edit("body", v)} />
        {questions.map((q) => (
          <Section key={q.key} label={q.label} value={t.answers[q.key] ?? ""} choices={q.choices} onSave={(v) => edit("answer", v, q.key)} />
        ))}
      </div>

      {t.level !== "subtask" && (t.kind === "plan" || d.lines.length > 0 || !closed) && (
        <div className="tk-lines">
          <div className="b-sub muted">{t.kind === "plan" ? "Tickets of this epic" : "Subtasks"}{d.lines.length ? ` · ${t.children.done}/${t.children.total} done` : ""}</div>
          {d.lines.length > 0 && <div className="tk-progress" aria-hidden><span style={{ width: `${(100 * t.children.done) / Math.max(1, t.children.total)}%` }} /></div>}
          {d.lines.map((l, i) => (
            <div key={l.id} className="tk-line">
              <button className="ghost tiny" disabled={i === 0} onClick={() => act("line", () => ticketsApi.line(l.id, "up"))} aria-label="Move up">▲</button>
              <button className="ghost tiny" disabled={i === d.lines.length - 1} onClick={() => act("line", () => ticketsApi.line(l.id, "down"))} aria-label="Move down">▼</button>
              <button className="link" onClick={() => onSelect(l.id)}><span className="mono muted">{l.key}</span> {l.title}</button>
              {l.blocked && <span className="tk-blocked">blocked</span>}
              {l.children.total > 0 && <Progress c={l.children} label="subtasks" />}
              <span className={`tk-status st-${l.status}`}>{STATUS_LABEL[l.status]}</span>
            </div>
          ))}
          {!closed && <AddLine placeholder={t.kind === "plan" ? "+ a ticket of this epic" : "+ a subtask"} onAdd={(title) => act("line", () => ticketsApi.open({ kind: "task", title, parent: t.id, project: t.project }))} />}
        </div>
      )}

      <div className="tk-links">
        <div className="b-sub muted">Links</div>
        {d.links.map((l) => (
          <div key={`${l.relation}-${l.to}`} className="tk-link"><span className="muted">{l.relation.replace(/_/g, " ")}</span> <button className="link" onClick={() => onSelect(l.to)}><span className="mono muted">{l.key ?? `#${l.to}`}</span> {l.title}</button>{l.status && <span className={`tk-status st-${l.status}`}>{STATUS_LABEL[l.status]}</span>}</div>
        ))}
        <form className="tk-linkform" onSubmit={(e) => { e.preventDefault(); const [rel, num] = linkTo.split(":"); if (num) act("link", () => ticketsApi.link(id, num.trim(), rel)).then(() => setLinkTo("")); }}>
          <select value={linkTo.split(":")[0] || "related"} onChange={(e) => setLinkTo(`${e.target.value}:${linkTo.split(":")[1] ?? ""}`)} aria-label="Link kind">
            {meta.relations.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
          </select>
          <input placeholder="SF-4" className="tk-num-input" value={linkTo.split(":")[1] ?? ""} onChange={(e) => setLinkTo(`${linkTo.split(":")[0] || "related"}:${e.target.value}`)} aria-label="Ticket number" />
          <button className="ghost tiny" type="submit">Link</button>
        </form>
      </div>

      {d.timeline ? <TicketTimeline rows={d.timeline} onShowRun={onShowRun} /> : (
        <ol className="tk-thread" aria-label="Thread">
          {d.notes.map((n) => (
            <li key={n.eventId} className={`tk-note n-${n.kind}`}>
              <span className="tk-note-head mono muted">{n.by} · {ago(n.ts)}{n.costUsd ? ` · $${n.costUsd.toFixed(4)}` : ""}{n.status ? ` · → ${STATUS_LABEL[n.status]}` : ""}</span>
              <span className="tk-note-text">{n.text}</span>
            </li>
          ))}
        </ol>
      )}
      <form className="tk-composer" onSubmit={(e) => { e.preventDefault(); if (say.trim()) act("say", () => ticketsApi.say(id, say)).then(() => setSay("")); }}>
        <textarea rows={2} placeholder={'Say something on the thread. "Needs a look" or "don\'t close" stops the QA rule from closing it.'} value={say} onChange={(e) => setSay(e.target.value)} aria-label="Note" />
        <div className="composer-row">
          {d.moves.map((m) => (
            <button key={m.to} type="button" className={m.to === "closed" ? "sm" : "ghost sm"} disabled={busy != null} onClick={() => act("move", () => ticketsApi.say(id, say, m.to)).then(() => setSay(""))}>{m.label}</button>
          ))}
          <button type="submit" className="ghost sm" disabled={!say.trim() || busy != null}>Note</button>
        </div>
      </form>
    </aside>
  );
}

function ChipSelect({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <select className={`tk-chip ${value ? "" : "empty-chip"}`} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

function InlineText({ value, onSave, className, placeholder, label }: { value: string; onSave: (v: string) => void; className?: string; placeholder?: string; label: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <input className={`tk-inline ${className ?? ""}`} value={v} placeholder={placeholder} aria-label={label} onChange={(e) => setV(e.target.value)} onBlur={() => { if (v !== value) onSave(v); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />;
}

/** One question of the kind: its answer as text, a pencil to edit; an empty one shows as a place to add it. */
function Section({ label, value, choices, onSave }: { label: string; value: string; choices?: string[]; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  if (choices && !value) {
    return <div className="tk-sec"><div className="tk-sec-h muted">{label}</div><div className="tk-choices">{choices.map((c) => <button key={c} className="ghost tiny" onClick={() => onSave(c)}>{c}</button>)}</div></div>;
  }
  if (!editing) {
    return (
      <div className="tk-sec">
        <div className="tk-sec-h muted">{label} <button className="link tiny-link" onClick={() => setEditing(true)} aria-label={`Edit ${label}`}>✎</button></div>
        {value ? <div className="tk-sec-v">{value}</div> : <button className="link tk-add" onClick={() => setEditing(true)}>+ {label.toLowerCase()}</button>}
      </div>
    );
  }
  return (
    <div className="tk-sec">
      <div className="tk-sec-h muted">{label}</div>
      <textarea rows={3} value={v} onChange={(e) => setV(e.target.value)} autoFocus />
      <div className="composer-row"><button className="ghost sm" onClick={() => { setV(value); setEditing(false); }}>Cancel</button><button className="sm" onClick={() => { onSave(v); setEditing(false); }}>Save</button></div>
    </div>
  );
}

function AddLine({ onAdd, placeholder }: { onAdd: (title: string) => void; placeholder: string }) {
  const [v, setV] = useState("");
  return (
    <form className="tk-addline" onSubmit={(e) => { e.preventDefault(); if (v.trim()) { onAdd(v.trim()); setV(""); } }}>
      <input placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)} aria-label={placeholder.replace("+ ", "New ")} />
    </form>
  );
}

function ago(ts: string): string {
  const m = Math.round((Date.now() - Date.parse(ts)) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** "2/5 subtasks", with a thin bar: how much of what a ticket holds is done. */
function Progress({ c, label }: { c: { total: number; done: number }; label: string }) {
  return (
    <span className="tk-prog" title={`${c.done} of ${c.total} ${label} done`}>
      <span className="tk-prog-bar" aria-hidden><span style={{ width: `${(100 * c.done) / Math.max(1, c.total)}%` }} /></span>
      <span className="mono">{c.done}/{c.total}</span>
    </span>
  );
}

const NEED_LABEL: Record<WaitingItem["need"], string> = { look: "Take a look", answer: "Answer", decide: "Decide" };

/**
 * Waiting on you: what needs your look, your answer or your yes, across every
 * project (or one). Each row carries the moves that answer it, so most take
 * one tap; anything longer opens the ticket.
 */
export function Waiting({ events, projectId = null, sel = null, onSelect, onError, showProject = true, limit }: {
  events: SfEvent[]; projectId?: number | null; sel?: number | null; onSelect: (id: number, project: number | null) => void; onError?: (m: string) => void; showProject?: boolean; limit?: number;
}) {
  const [items, setItems] = useState<WaitingItem[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const last = events.filter((e) => e.type.startsWith("ticket.")).at(-1)?.id ?? 0;
  const load = () => ticketsApi.waiting(projectId).then((r) => setItems(r.items)).catch((e) => onError?.((e as Error).message));
  useEffect(() => { load(); }, [last, projectId]);
  if (!items) return <div className="empty">Reading…</div>;
  if (!items.length) return <div className="empty">Nothing waits on you. The crew has what it needs.</div>;
  const move = async (t: TicketView, to: TicketStatus) => {
    setBusy(t.id);
    try { await ticketsApi.say(t.id, "", to); await load(); } catch (e) { onError?.((e as Error).message); } finally { setBusy(null); }
  };
  const shown = limit ? items.slice(0, limit) : items;
  return (
    <ul className="tk-waiting" aria-label="Waiting on you">
      {shown.map(({ ticket: t, projectName, need, say, moves }) => (
        <li key={t.id} className={`tk-wait need-${need} ${t.id === sel ? "on" : ""}`}>
          <span className={`tk-need need-${need}`}>{NEED_LABEL[need]}</span>
          <button className="tk-wait-main" onClick={() => onSelect(t.id, t.project)}>
            <span className="tk-wait-title"><span className="mono muted">{t.key}</span> {t.title}</span>
            <span className="tk-wait-say muted">{say}{showProject && projectName ? ` · ${projectName}` : ""}</span>
          </button>
          <span className="tk-wait-acts">
            {moves.map((m) => (
              <button key={m.to} className={m.to === "closed" || m.to === "ready" ? "sm" : "ghost sm"} disabled={busy != null} onClick={() => move(t, m.to)}>{m.label}</button>
            ))}
            {need === "answer" && <button className="sm" onClick={() => onSelect(t.id, t.project)}>Answer</button>}
          </span>
        </li>
      ))}
      {limit && items.length > limit && <li className="muted tk-wait-more">and {items.length - limit} more on the Tickets tab</li>}
    </ul>
  );
}

/**
 * The auto-work rule, as one switch in the Tickets header: when on, the crew
 * starts ready bugs and tasks of size S or M by itself, within the caps.
 */
function AutoToggle({ last, onError }: { last: number; onError: (m: string) => void }) {
  const [rule, setRule] = useState<AutoWork | null>(null);
  useEffect(() => { ticketsApi.auto().then(setRule).catch(() => {}); }, [last]);
  if (!rule) return null;
  const flip = () => ticketsApi.auto({ on: !rule.on }).then(setRule).catch((e) => onError((e as Error).message));
  return (
    <button type="button" className={`ghost sm tk-auto ${rule.on ? "on" : ""}`} aria-pressed={rule.on} onClick={flip}
      title={rule.on
        ? `The crew starts ready bugs and tasks of size S or M by itself: at most ${rule.wip} per project at once, $${rule.maxUsd.toFixed(2)} each, $${rule.dailyUsd.toFixed(2)} a day in all. Press to stop.`
        : "The crew only starts a ticket when you press Work it. Press to let it pick up ready bugs and tasks by itself."}>
      <span className="tk-auto-dot" aria-hidden /> Crew picks up: {rule.on ? "on" : "off"}
    </button>
  );
}

const CAT_GLYPH: Record<TimelineCat, string> = { said: "✎", status: "→", step: "▸", agent: "◆", decision: "◇", retry: "↻", run: "●", git: "⑂", event: "·" };
const TIMELINE_FILTERS: [string, string, TimelineCat[] | null][] = [
  ["all", "Everything", null],
  ["talk", "Said", ["said", "status"]],
  ["crew", "Crew at work", ["step", "agent", "retry", "run"]],
  ["decisions", "Decisions", ["decision"]],
  ["git", "Branch and PR", ["git"]],
];

/**
 * The ticket's one timeline, oldest first: what people said and every status move, and what the crew did
 * for it (each step of its runs, agent calls, decisions at the gates, retries, the branch and its PR).
 */
function TicketTimeline({ rows, onShowRun }: { rows: TimelineEntry[]; onShowRun?: (run: number) => void }) {
  const [filter, setFilter] = useState("all");
  const cats = TIMELINE_FILTERS.find(([k]) => k === filter)?.[2] ?? null;
  const shown = cats ? rows.filter((r) => cats.includes(r.cat)) : rows;
  const count = (c: TimelineCat[] | null) => (c ? rows.filter((r) => c.includes(r.cat)).length : rows.length);
  return (
    <section className="tk-timeline" aria-label="Timeline">
      <div className="tk-tl-filters" role="tablist" aria-label="Show on the timeline">
        {TIMELINE_FILTERS.map(([k, label, c]) => (
          <button key={k} type="button" role="tab" aria-selected={filter === k} className={`tk-tl-filter${filter === k ? " on" : ""}`} onClick={() => setFilter(k)}>{label} <span className="mono muted">{count(c)}</span></button>
        ))}
      </div>
      <ol className="tk-thread" aria-label="Thread">
        {shown.map((n) => (
          <li key={n.eventId} className={`tk-note c-${n.cat}${n.cat === "said" ? " n-note" : ""}`}>
            <span className="tk-note-head mono muted"><span className="tk-cat" title={n.cat} aria-label={n.cat}>{CAT_GLYPH[n.cat] ?? "·"}</span> {n.by} · {ago(n.ts)}{n.costUsd ? ` · $${n.costUsd.toFixed(4)}` : ""}{n.status ? ` · → ${STATUS_LABEL[n.status]}` : ""}{n.run != null && onShowRun ? <> · <button type="button" className="link tiny" onClick={() => onShowRun(n.run as number)}>run #{n.run}</button></> : null}</span>
            <span className="tk-note-text">{n.text}</span>
          </li>
        ))}
        {shown.length === 0 && <li className="tk-note muted">Nothing of this kind yet.</li>}
      </ol>
    </section>
  );
}
