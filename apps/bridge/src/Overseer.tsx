import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from "react";
import { GateActions, STEP } from "./GateActions";
import { AskNotProject, checkIntake, type IntakeVerdict } from "./Intake";
import { showTicket } from "./BugReport";
import { askOverseer, captureSignal, setupApi, splitBuild, startFactoryRun, type AgentRunView, type ChatRoutes, type CrewMode, type FactoryRunView, type OrderState, type ProjectSummary, type Signal, type SinceView } from "./api";

type Item = {
  key: string; ts: string; kind: "signal" | "reply" | "error" | "factory" | "briefing" | "filed" | "gate"; text: string; meta?: string; build?: string; run?: number; open?: boolean;
  /** The chat it was said in or belongs to: a project id, or null for General. */
  home: number | null;
  /** Other project chats it also shows in (the Order Engine filed it there). */
  also?: number[];
  /** General shows a project's headlines only: what shipped, failed, or waits for you. */
  headline?: boolean;
};
/** A chat: "general", or a project id. */
export type Channel = "general" | number;

/** Everything said and done, each placed in the chat it belongs to. */
/** "Working SF-4: Dark and light theme" for a run started from a ticket, else null. */
function ticketLine(idea: string): string | null {
  const m = idea.split("\n")[0].match(/^(.*?)\s*\(ticket ((?:[A-Z][A-Z0-9]*-|#)\d+)\)\s*$/);
  return m ? `Working ticket ${m[2]}: ${m[1].replace(/:\s.*$/, "")}` : null;
}

function chatItems({ signals, runs, factoryRuns, briefings, ingests, routes }: {
  signals: Signal[]; runs: AgentRunView[]; factoryRuns: FactoryRunView[]; briefings: OrderState["briefings"]; ingests: OrderState["ingests"]; routes: ChatRoutes;
}): Item[] {
  const runHome = (run: number) => routes.factoryRuns[run] ?? null;
  // A factory run's own idea is shown as the run, not as a Signal, so its filing receipt is not shown either.
  const factorySignals = new Set(signals.filter((s) => s.source === "factory").map((s) => s.id));
  const sigHome = new Map(signals.map((s) => [s.id, { home: s.projectId ?? null, also: (routes.filed[s.id] ?? []).filter((p) => p !== (s.projectId ?? null)) }]));
  return [
    ...signals.filter((s) => s.source !== "factory").map((s) => ({ key: "s" + s.id, ts: s.ts, kind: "signal" as const, text: s.text, meta: s.source === "drop" ? "from the drop folder" : undefined, ...sigHome.get(s.id)! })),
    // A build started from General made a project of its own (same id as the run): say so in both chats.
    // A run from a ticket says which ticket in one line; the ticket holds the rest of its work document.
    ...factoryRuns.map((r) => ({ key: "f" + r.run, ts: r.startedAt, kind: "signal" as const, text: ticketLine(r.idea) ?? r.idea, meta: `factory run #${r.run}`, home: runHome(r.run), headline: runHome(r.run) === r.run || runHome(r.run) == null })),
    ...factoryRuns.filter((r) => r.finished).map((r) => ({
      key: "fd" + r.run, ts: r.startedAt + "~", kind: (r.finished!.outcome === "shipped" ? "factory" : "error") as Item["kind"],
      text: r.finished!.reason, meta: r.finished!.totalUsd != null ? `run #${r.run} · $${r.finished!.totalUsd.toFixed(4)} · ${r.finished!.agentCalls ?? 0} agent calls · ${r.fixRounds} fix rounds` : undefined,
      run: r.run, open: r.finished!.outcome === "shipped", home: runHome(r.run), headline: true,
    })),
    // A gate waiting for you is said here too, so you never have to hunt for it.
    ...factoryRuns.filter((r) => r.waiting && !r.finished).map((r) => ({ key: "g" + r.run, ts: "~", kind: "gate" as const, text: r.waiting!.question, meta: `run #${r.run} waits for you`, run: r.run, home: runHome(r.run), headline: true })),
    // After Retry, the chat says the step is running again until it passes or fails anew.
    ...factoryRuns.filter((r) => r.retrying && !r.waiting && !r.finished).map((r) => ({ key: "rt" + r.run, ts: "~", kind: "factory" as const, text: `↻ Retrying ${STEP[r.retrying!.station] ?? r.retrying!.station} (attempt ${r.retrying!.attempt})…`, meta: `run #${r.run}`, run: r.run, home: runHome(r.run), headline: true })),
    // The Order Engine's daily briefing: everything non-urgent, batched into one message. It spans projects, so it lives in General.
    ...briefings.map((b) => ({ key: "b" + b.id, ts: b.ts, kind: "briefing" as const, text: b.lines.map((l) => "• " + l.text).join("\n"), meta: "Order Engine briefing", home: null })),
    // A quiet receipt under each Signal: how it was filed. It follows its Signal.
    ...ingests.filter((r) => r.state === "done" && sigHome.has(r.signalId) && !factorySignals.has(r.signalId)).map((r) => ({ key: "i" + r.signalId, ts: (signals.find((s) => s.id === r.signalId)?.ts ?? r.ts) + "~", kind: "filed" as const,
      text: `${r.fragments.length} fragment${r.fragments.length === 1 ? "" : "s"} filed by the ${r.mode === "agent" ? "Archivist" : "heuristics"}${r.costUsd ? ` · $${r.costUsd.toFixed(4)}` : ""}${r.note ? ` · ${r.note}` : ""}`, ...sigHome.get(r.signalId)! })),
    ...runs.filter((r) => r.state !== "running" && !r.factoryRun && !r.bayTest && (r.station === "overseer" || (!r.station && r.agent === "overseer"))).map((r) => ({
      key: "r" + r.runId,
      ts: r.startedAt,
      kind: r.state === "failed" ? ("error" as const) : ("reply" as const),
      ...(r.state === "failed" ? { text: r.error ?? "The Overseer could not answer." } : splitBuild(r.text ?? "")),
      meta: r.state === "done" ? (r.models?.[0] ?? "") + " · $" + (r.costUsd ?? 0).toFixed(4) : undefined,
      home: r.projectId ?? null,
    })),
  ].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0) || a.key.localeCompare(b.key));
}

/** Does this item show in this chat? Project chats show their own; General shows its own plus each project's headlines. */
function inChat(i: Item, ch: Channel): boolean {
  if (ch === "general") return i.home == null || !!i.headline;
  return i.home === ch || !!i.also?.includes(ch);
}

/**
 * The one voice you talk to, in one chat per project plus a General chat. Every message is
 * saved as a Signal first (in the chat it was said in); asking also runs the Overseer agent.
 */
export function Overseer({ signals, runs, factoryRuns, briefings, ingests, onRunStarted, mode, since, onDismissSince, onSetup, onShowRun, projectId, projectName, projects, routes }: {
  signals: Signal[]; runs: AgentRunView[]; factoryRuns: FactoryRunView[]; briefings: OrderState["briefings"]; ingests: OrderState["ingests"]; onRunStarted: (run: number, projectId?: number) => void;
  mode: CrewMode | null; since: SinceView | null; onDismissSince: () => void; onSetup: () => void; onShowRun: (run: number) => void;
  /** Inside a project's workspace: its chat opens, and builds start in that project. */
  projectId?: number; projectName?: string;
  projects: ProjectSummary[] | null; routes: ChatRoutes;
}) {
  const [text, setText] = useState("");
  const [model, setModel] = useState("haiku");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ask, setAsk] = useState<{ text: string; v: IntakeVerdict } | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  // The chat follows the page you are on (a project's page opens its chat); you can switch by hand.
  const [picked, setPicked] = useState<Channel | null>(null);
  useEffect(() => setPicked(null), [projectId]);
  const names = useMemo(() => new Map((projects ?? []).map((p) => [p.id, p.name])), [projects]);
  const wanted: Channel = picked ?? projectId ?? "general";
  // A chat whose project is gone (archived away, merged) falls back to General.
  const channel: Channel = wanted === "general" || names.has(wanted) || wanted === projectId ? wanted : "general";
  const channelName = channel === "general" ? "General" : names.get(channel) ?? projectName ?? `#${channel}`;
  const chatProject = channel === "general" ? undefined : channel;

  const all = useMemo(() => chatItems({ signals, runs, factoryRuns, briefings, ingests, routes }), [signals, runs, factoryRuns, briefings, ingests, routes]);
  const nameOf = (id: number | null) => (id == null ? "General" : names.get(id) ?? `project #${id}`);
  const items = all.filter((i) => inChat(i, channel)).map((i) => {
    // Say where a message came from when it is shown away from its own chat.
    if (channel === "general" && i.home != null) return { ...i, meta: [nameOf(i.home), i.meta].filter(Boolean).join(" · ") };
    if (channel !== "general" && i.home !== channel && i.kind !== "filed") return { ...i, meta: [`from ${i.home == null ? "General" : `${nameOf(i.home)}'s chat`}`, i.meta].filter(Boolean).join(" · ") };
    return i;
  });
  // Per chat: how many messages, and how many wait for you. Busiest and most recent first.
  const chats = useMemo(() => {
    const m = new Map<number, { count: number; gates: number; last: string }>();
    for (const i of all) for (const p of [i.home, ...(i.also ?? [])]) {
      if (p == null || !names.has(p)) continue;
      const c = m.get(p) ?? { count: 0, gates: 0, last: "" };
      c.count++;
      if (i.kind === "gate") c.gates++;
      if (i.ts > c.last && i.ts !== "~") c.last = i.ts;
      m.set(p, c);
    }
    return m;
  }, [all, names]);
  const generalGates = all.filter((i) => i.kind === "gate").length;
  const others = (projects ?? []).filter((p) => p.status !== "archived" && p.id !== channel && p.id !== projectId)
    .sort((a, b) => (chats.get(b.id)?.last ?? b.rollup.lastActive).localeCompare(chats.get(a.id)?.last ?? a.rollup.lastActive));

  // Keep the newest message in view.
  useEffect(() => { feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight }); }, [items.length, channel]);

  async function build(e: MouseEvent, idea?: string, askChecked = false) {
    e.preventDefault();
    const t = (idea ?? text).trim();
    if (!t || busy) return;
    // In General, a new build is a new project: when it reads like an ask about one you have, offer a ticket there first.
    if (chatProject == null && !askChecked) {
      const v = await checkIntake(t);
      if (v) { setAsk({ text: t, v }); return; }
    }
    setAsk(null);
    setBusy(true);
    setErr(null);
    try {
      onRunStarted(await startFactoryRun(t, undefined, chatProject), chatProject);
      if (!idea) setText("");
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: FormEvent | KeyboardEvent | MouseEvent, ask: boolean) {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await captureSignal(t, chatProject);
      setText("");
      if (ask) await askOverseer(t, model, chatProject);
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="pane overseer" aria-label="Overseer channel">
      <header className="pane-head"><span>Overseer</span><span className="muted">{busy ? "thinking…" : channel === "general" ? "general chat" : `${channelName}'s chat`}</span></header>
      <nav className="chat-tabs" aria-label="Chats">
        <button className={channel === "general" ? "chat-tab on" : "chat-tab"} aria-pressed={channel === "general"} onClick={() => setPicked("general")}
          title="Cross-project talk, the daily briefing, and each project's headlines (what shipped, failed, or waits for you)">
          General{generalGates ? <span className="chat-badge gate">{generalGates}</span> : null}
        </button>
        {projectId != null && (
          <button className={channel === projectId ? "chat-tab on" : "chat-tab"} aria-pressed={channel === projectId} onClick={() => setPicked(projectId)} title="Only this project: what was said here, what the Order Engine filed here, its builds and answers">
            {names.get(projectId) ?? projectName ?? "This project"}{chats.get(projectId)?.gates ? <span className="chat-badge gate">{chats.get(projectId)!.gates}</span> : null}
          </button>
        )}
        {channel !== "general" && channel !== projectId && (
          <button className="chat-tab on" aria-pressed>{channelName}</button>
        )}
        {others.length > 0 && (
          <select className="chat-pick" value="" aria-label="Open another project's chat" onChange={(e) => { if (e.target.value) setPicked(Number(e.target.value)); }}>
            <option value="">Other chats…</option>
            {others.map((p) => { const c = chats.get(p.id); return <option key={p.id} value={p.id}>{p.name}{c?.gates ? ` · ${c.gates} waiting` : c?.count ? ` · ${c.count}` : ""}</option>; })}
          </select>
        )}
      </nav>
      {since && since.lines.length > 0 && (
        <div className="msg since pinned" role="status">
          <div className="since-head"><span>Since you left{since.awayMinutes ? ` · ${away(since.awayMinutes)}` : ""}</span><button className="link" onClick={onDismissSince}>Got it</button></div>
          <ul>{since.lines.map((l, i) => <li key={i} className={"since-" + l.kind}>{l.text}{(l.kind === "gate" || l.kind === "shipped" || l.kind === "failed") && l.ref ? <> <button className="link" onClick={() => onShowRun(l.ref!)}>show</button></> : null}</li>)}</ul>
        </div>
      )}
      <div className="feed" ref={feedRef}>
        {!signals.length && !factoryRuns.length && <Welcome mode={mode} onSetup={onSetup} onTry={(t) => setText(t)} />}
        {(signals.length > 0 || factoryRuns.length > 0) && !items.length && (
          channel === "general"
            ? <p className="chat-empty">Nothing in General yet. Talk here about more than one project or nothing in particular; each project's own talk stays in its chat.</p>
            : <p className="chat-empty">This is <strong>{channelName}</strong>'s chat. What you say here is filed under this project, the Overseer answers about it, and Build it starts runs in it. Notes from General that the Order Engine files here show up too.</p>
        )}
        {items.map((i) => (
          <div key={i.key} className={"msg " + i.kind}>
            {i.kind === "gate" && i.run && factoryRuns.find((r) => r.run === i.run)?.waiting
              ? <GateActions run={factoryRuns.find((r) => r.run === i.run)!} compact />
              : <div className="msg-text">{i.text}</div>}
            {i.meta && <div className="mono muted msg-meta">{i.meta}</div>}
            {(i.build || i.open || (i.kind === "gate" && i.run)) && (
              <div className="msg-actions">
                {i.build && <button className="sm" disabled={busy} onClick={(e) => build(e, i.build)} title={i.build}>Build: {i.build.length > 48 ? i.build.slice(0, 46) + "…" : i.build}</button>}
                {i.open && i.run && <button className="ghost sm" onClick={() => setupApi.open("run", i.run).catch((x) => setErr((x as Error).message))}>Open folder</button>}
                {i.kind === "gate" && i.run && <button className="ghost sm" onClick={() => onShowRun(i.run!)}>Show me</button>}
              </div>
            )}
          </div>
        ))}
      </div>
      <form className="composer" onSubmit={(e) => submit(e, true)}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={channel === "general" ? "One line or a whole messy brain dump…" : `Anything about ${channelName}…`}
          rows={3}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e, true); }}
        />
        <div className="composer-row">
          <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Overseer model" title="Model the Overseer answers with">
            <option value="haiku">Haiku</option>
            <option value="sonnet">Sonnet</option>
            <option value="opus">Opus</option>
          </select>
          <span className="grow" />
          <button type="button" className="ghost" disabled={busy || !text.trim()} onClick={(e) => submit(e, false)} title="Save it as a note; the Order Engine files it. No answer, no cost.">Capture</button>
          <button type="submit" className="ghost" disabled={busy || !text.trim()} title="Save it and ask the Overseer (Ctrl+Enter)">Ask</button>
          <button type="button" disabled={busy || !text.trim()} onClick={(e) => build(e)} title="Run the factory loop: plan, tests, build, fix, with two approval taps">Build it</button>
        </div>
        {mode === "practice" && <div className="composer-note">Practice crew: Build it makes a sample word counter, free. <button type="button" className="link" onClick={onSetup}>Use real agents</button></div>}
        {err && <div className="err">{err}</div>}
        {ask && <AskNotProject text={ask.text} verdict={ask.v} onCancel={() => setAsk(null)}
          onProject={() => { const t = ask.text; setAsk(null); void build({ preventDefault() {} } as MouseEvent, t, true).then(() => setText("")); }}
          onFiled={(id, project) => { setAsk(null); setText(""); showTicket(id, project); }} />}
      </form>
    </section>
  );
}

function away(min: number) {
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h`;
  return `${Math.round(min / 1440)} days`;
}

/** First launch: what this is and the three things to try. */
function Welcome({ mode, onSetup, onTry }: { mode: CrewMode | null; onSetup: () => void; onTry: (t: string) => void }) {
  return (
    <div className="welcome">
      <div className="setup-kicker mono">OVERSEER ONLINE</div>
      <h3>Give me one line. I'll run the crew.</h3>
      <ol>
        <li><strong>Build it</strong>: type an app idea in one line. The crew plans, writes locked tests, codes, reviews and fixes; you tap twice (approve the plan, accept the build) and get a git repo. <button className="link" onClick={() => onTry("a CLI that renames photos by the date they were taken")}>try an example</button></li>
        <li><strong>Capture</strong>: dump any thought, rule or half-idea. The Order Engine files it onto the star map and flags rules that clash. <button className="link" onClick={() => onTry("Project: Garden planner. Rule: it must work offline. Idea: remind me when to water.")}>try one</button></li>
        <li><strong>Ask</strong>: talk to me about what is running, what is waiting for you, or what to build next.</li>
      </ol>
      {mode === "practice"
        ? <p className="welcome-note">You are on the <strong>practice crew</strong>: free canned agents that always build a sample word counter, so you can learn the loop. <button className="link" onClick={onSetup}>Switch to real agents</button></p>
        : mode === "real" ? <p className="welcome-note">You are on the <strong>real crew</strong> (Claude Code, every run capped at $1.50). <button className="link" onClick={onSetup}>Settings and folders</button></p> : null}
    </div>
  );
}
