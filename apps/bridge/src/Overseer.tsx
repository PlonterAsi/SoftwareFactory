import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from "react";
import { askOverseer, captureSignal, startFactoryRun, type AgentRunView, type FactoryRunView, type OrderState, type Signal } from "./api";

type Item = { key: string; ts: string; kind: "signal" | "reply" | "error" | "factory" | "briefing" | "filed"; text: string; meta?: string };

/** The one voice you talk to. Every message is saved as a Signal first; asking also runs the Overseer agent. */
export function Overseer({ signals, runs, factoryRuns, briefings, ingests, onRunStarted }: { signals: Signal[]; runs: AgentRunView[]; factoryRuns: FactoryRunView[]; briefings: OrderState["briefings"]; ingests: OrderState["ingests"]; onRunStarted: (run: number) => void }) {
  const [text, setText] = useState("");
  const [model, setModel] = useState("haiku");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  const items: Item[] = [
    ...signals.filter((s) => s.source !== "factory").map((s) => ({ key: "s" + s.id, ts: s.ts, kind: "signal" as const, text: s.text })),
    ...factoryRuns.map((r) => ({ key: "f" + r.run, ts: r.startedAt, kind: "signal" as const, text: r.idea, meta: `factory run #${r.run}` })),
    ...factoryRuns.filter((r) => r.finished).map((r) => ({
      key: "fd" + r.run, ts: r.startedAt + "~", kind: (r.finished!.outcome === "shipped" ? "factory" : "error") as Item["kind"],
      text: r.finished!.reason, meta: r.finished!.totalUsd != null ? `run #${r.run} · $${r.finished!.totalUsd.toFixed(4)} · ${r.finished!.agentCalls ?? 0} agent calls · ${r.fixRounds} fix rounds` : undefined,
    })),
    // The Order Engine's daily briefing: everything non-urgent, batched into one message.
    ...briefings.map((b) => ({ key: "b" + b.id, ts: b.ts, kind: "briefing" as const, text: b.lines.map((l) => "• " + l.text).join("\n"), meta: "Order Engine briefing" })),
    // A quiet receipt under each Signal: how it was filed.
    ...ingests.filter((r) => r.state === "done").map((r) => ({ key: "i" + r.signalId, ts: (signals.find((s) => s.id === r.signalId)?.ts ?? r.ts) + "~", kind: "filed" as const,
      text: `${r.fragments.length} fragment${r.fragments.length === 1 ? "" : "s"} filed by the ${r.mode === "agent" ? "Archivist" : "heuristics"}${r.costUsd ? ` · $${r.costUsd.toFixed(4)}` : ""}${r.note ? ` · ${r.note}` : ""}` })),
    ...runs.filter((r) => r.state !== "running" && !r.factoryRun && !r.bayTest && (r.station === "overseer" || (!r.station && r.agent === "overseer"))).map((r) => ({
      key: "r" + r.runId,
      ts: r.startedAt,
      kind: r.state === "failed" ? ("error" as const) : ("reply" as const),
      text: r.state === "failed" ? "Run failed: " + r.error : r.text ?? "",
      meta: r.state === "done" ? (r.models?.[0] ?? "") + " · $" + (r.costUsd ?? 0).toFixed(4) : undefined,
    })),
  ].sort((a, b) => a.ts.localeCompare(b.ts) || a.key.localeCompare(b.key));

  // Keep the newest message in view.
  useEffect(() => { feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight }); }, [items.length]);

  async function build(e: MouseEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setErr(null);
    try {
      onRunStarted(await startFactoryRun(t));
      setText("");
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
      <header className="pane-head"><span>Overseer</span><span className="muted">{busy ? "thinking…" : "online"}</span></header>
      <div className="feed" ref={feedRef}>
        {!items.length && <div className="empty">Dump anything here: ideas, rules, half-thoughts. Nothing is lost.</div>}
        {items.map((i) => (
          <div key={i.key} className={"msg " + i.kind}>
            <div className="msg-text">{i.text}</div>
            {i.meta && <div className="mono muted msg-meta">{i.meta}</div>}
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
          <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">
            <option value="haiku">Haiku</option>
            <option value="sonnet">Sonnet</option>
            <option value="opus">Opus</option>
          </select>
          <button type="button" className="ghost" disabled={busy || !text.trim()} onClick={(e) => submit(e, false)}>Capture</button>
          <button type="submit" className="ghost" disabled={busy || !text.trim()}>Ask Overseer</button>
          <button type="button" disabled={busy || !text.trim()} onClick={build} title="Run the factory loop: plan, tests, build, fix, with two approval taps">Build it</button>
        </div>
        {err && <div className="err">{err}</div>}
      </form>
    </section>
  );
}
