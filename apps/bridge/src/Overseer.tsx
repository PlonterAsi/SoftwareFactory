import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from "react";
import { GateActions, STEP } from "./GateActions";
import { askOverseer, captureSignal, setupApi, splitBuild, startFactoryRun, type AgentRunView, type CrewMode, type FactoryRunView, type OrderState, type Signal, type SinceView } from "./api";

type Item = { key: string; ts: string; kind: "signal" | "reply" | "error" | "factory" | "briefing" | "filed" | "gate"; text: string; meta?: string; build?: string; run?: number; open?: boolean };

/** The one voice you talk to. Every message is saved as a Signal first; asking also runs the Overseer agent. */
export function Overseer({ signals, runs, factoryRuns, briefings, ingests, onRunStarted, mode, since, onDismissSince, onSetup, onShowRun, projectId, projectName }: {
  signals: Signal[]; runs: AgentRunView[]; factoryRuns: FactoryRunView[]; briefings: OrderState["briefings"]; ingests: OrderState["ingests"]; onRunStarted: (run: number) => void;
  mode: CrewMode | null; since: SinceView | null; onDismissSince: () => void; onSetup: () => void; onShowRun: (run: number) => void;
  /** Inside a project's workspace: builds start in that project. */
  projectId?: number; projectName?: string;
}) {
  const [text, setText] = useState("");
  const [model, setModel] = useState("haiku");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  const items: Item[] = [
    ...signals.filter((s) => s.source !== "factory").map((s) => ({ key: "s" + s.id, ts: s.ts, kind: "signal" as const, text: s.text, meta: s.source === "drop" ? "from the drop folder" : undefined })),
    ...factoryRuns.map((r) => ({ key: "f" + r.run, ts: r.startedAt, kind: "signal" as const, text: r.idea, meta: `factory run #${r.run}` })),
    ...factoryRuns.filter((r) => r.finished).map((r) => ({
      key: "fd" + r.run, ts: r.startedAt + "~", kind: (r.finished!.outcome === "shipped" ? "factory" : "error") as Item["kind"],
      text: r.finished!.reason, meta: r.finished!.totalUsd != null ? `run #${r.run} · $${r.finished!.totalUsd.toFixed(4)} · ${r.finished!.agentCalls ?? 0} agent calls · ${r.fixRounds} fix rounds` : undefined,
      run: r.run, open: r.finished!.outcome === "shipped",
    })),
    // A gate waiting for you is said here too, so you never have to hunt for it.
    ...factoryRuns.filter((r) => r.waiting && !r.finished).map((r) => ({ key: "g" + r.run, ts: "~", kind: "gate" as const, text: r.waiting!.question, meta: `run #${r.run} waits for you`, run: r.run })),
    // After Retry, the chat says the step is running again until it passes or fails anew.
    ...factoryRuns.filter((r) => r.retrying && !r.waiting && !r.finished).map((r) => ({ key: "rt" + r.run, ts: "~", kind: "factory" as const, text: `↻ Retrying ${STEP[r.retrying!.station] ?? r.retrying!.station} (attempt ${r.retrying!.attempt})…`, meta: `run #${r.run}`, run: r.run })),
    // The Order Engine's daily briefing: everything non-urgent, batched into one message.
    ...briefings.map((b) => ({ key: "b" + b.id, ts: b.ts, kind: "briefing" as const, text: b.lines.map((l) => "• " + l.text).join("\n"), meta: "Order Engine briefing" })),
    // A quiet receipt under each Signal: how it was filed.
    ...ingests.filter((r) => r.state === "done").map((r) => ({ key: "i" + r.signalId, ts: (signals.find((s) => s.id === r.signalId)?.ts ?? r.ts) + "~", kind: "filed" as const,
      text: `${r.fragments.length} fragment${r.fragments.length === 1 ? "" : "s"} filed by the ${r.mode === "agent" ? "Archivist" : "heuristics"}${r.costUsd ? ` · $${r.costUsd.toFixed(4)}` : ""}${r.note ? ` · ${r.note}` : ""}` })),
    ...runs.filter((r) => r.state !== "running" && !r.factoryRun && !r.bayTest && (r.station === "overseer" || (!r.station && r.agent === "overseer"))).map((r) => ({
      key: "r" + r.runId,
      ts: r.startedAt,
      kind: r.state === "failed" ? ("error" as const) : ("reply" as const),
      ...(r.state === "failed" ? { text: r.error ?? "The Overseer could not answer." } : splitBuild(r.text ?? "")),
      meta: r.state === "done" ? (r.models?.[0] ?? "") + " · $" + (r.costUsd ?? 0).toFixed(4) : undefined,
    })),
  ].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0) || a.key.localeCompare(b.key));

  // Keep the newest message in view.
  useEffect(() => { feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight }); }, [items.length]);

  async function build(e: MouseEvent, idea?: string) {
    e.preventDefault();
    const t = (idea ?? text).trim();
    if (!t || busy) return;
    setBusy(true);
    setErr(null);
    try {
      onRunStarted(await startFactoryRun(t, undefined, projectId));
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
      await captureSignal(t);
      setText("");
      if (ask) await askOverseer(t, model);
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="pane overseer" aria-label="Overseer channel">
      <header className="pane-head"><span>Overseer</span><span className="muted">{busy ? "thinking…" : projectName ? `builds go to ${projectName}` : "online"}</span></header>
      {since && since.lines.length > 0 && (
        <div className="msg since pinned" role="status">
          <div className="since-head"><span>Since you left{since.awayMinutes ? ` · ${away(since.awayMinutes)}` : ""}</span><button className="link" onClick={onDismissSince}>Got it</button></div>
          <ul>{since.lines.map((l, i) => <li key={i} className={"since-" + l.kind}>{l.text}{(l.kind === "gate" || l.kind === "shipped" || l.kind === "failed") && l.ref ? <> <button className="link" onClick={() => onShowRun(l.ref!)}>show</button></> : null}</li>)}</ul>
        </div>
      )}
      <div className="feed" ref={feedRef}>
        {!signals.length && !factoryRuns.length && <Welcome mode={mode} onSetup={onSetup} onTry={(t) => setText(t)} />}
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
          placeholder="One line or a whole messy brain dump…"
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
