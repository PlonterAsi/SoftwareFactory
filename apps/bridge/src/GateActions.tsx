import { useEffect, useState } from "react";
import { decideGate, type FactoryRunView } from "./api";

export const STEP: Record<string, string> = { intake: "Intake", council: "Council", plan: "Plan", gateA: "the plan gate", tests: "Acceptance tests", build: "Build", test: "Test", fix: "Fix", review: "Review", gateB: "the build gate", ship: "Ship" };

/**
 * The answer buttons for a gate a run waits at, on the factory floor and in the Overseer chat.
 * Pressing one always shows something: the button says it is sending, and a failed step that
 * fails again comes back as a new notice that says which attempt it was and whether the error
 * was the same, so a Retry never looks like it did nothing.
 */
export function GateActions({ run, compact, label = STEP }: { run: FactoryRunView; compact?: boolean; label?: Record<string, string> }) {
  const w = run.waiting!;
  return <GateForm key={`${run.run}:${w.at}`} run={run} compact={compact} label={label} />;
}

function GateForm({ run, compact, label }: { run: FactoryRunView; compact?: boolean; label: Record<string, string> }) {
  const w = run.waiting!;
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<null | "yes" | "no">(null);
  const [err, setErr] = useState<string | null>(null);
  const [fresh, setFresh] = useState((w.attempt ?? 1) > 1);
  useEffect(() => { if (!fresh) return; const t = setTimeout(() => setFresh(false), 2400); return () => clearTimeout(t); }, [fresh]);
  const esc = w.gate === "escalation";
  const yes = w.action ?? (esc ? "Retry" : "Approve");
  const failed = w.kind === "retry" && w.station;
  async function go(approve: boolean) {
    setBusy(approve ? "yes" : "no"); setErr(null);
    try {
      await decideGate(run.run, w.gate, approve, note.trim() || undefined);
      // Stay "sending" until the run moves on; this form is replaced by what happens next.
    } catch (e) {
      const m = (e as Error).message;
      setErr(/not waiting/.test(m) ? "The run is no longer waiting here (the app may have restarted it). Look at the run for a Resume button." : m);
      setBusy(null);
    }
  }
  return (
    <div className={`gatebar ${w.gate}${compact ? " compact" : ""}${fresh ? " fresh" : ""}`} role="group" aria-label="Approval needed">
      {failed ? (
        <div className="gate-q">
          {label[w.station!] ?? w.station} failed{(w.attempt ?? 1) > 1 ? <span className="gate-attempt mono"> · attempt {w.attempt}</span> : null}
          {w.same && <div className="gate-same">Same error as the last try. Retrying as is will likely fail again: add a hint below, or check Systems first.</div>}
          <details className="gate-err"><summary>{(w.error ?? w.question).slice(0, compact ? 140 : 220)}{(w.error ?? "").length > (compact ? 140 : 220) ? "…" : ""}</summary><pre>{w.error ?? w.question}</pre></details>
        </div>
      ) : <span className="gate-q">{w.question}</span>}
      <input value={note} disabled={!!busy} onChange={(e) => setNote(e.target.value)} placeholder={esc ? (failed ? "optional hint for the retry" : "optional note") : "optional: what to change (rejecting with a note sends it back)"} />
      <button disabled={!!busy} onClick={() => go(true)}>{busy === "yes" ? (esc && yes === "Retry" ? "Retrying…" : "Sending…") : yes}</button>
      <button className="ghost" disabled={!!busy} onClick={() => go(false)}>{busy === "no" ? "Stopping…" : note.trim() && !esc ? "Send back" : "Stop"}</button>
      {err && <span className="err">{err}</span>}
    </div>
  );
}
