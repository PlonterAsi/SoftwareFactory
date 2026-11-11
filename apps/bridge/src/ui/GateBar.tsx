import { useEffect, useState, type ReactNode } from "react";

/**
 * The one approval bar. Everywhere the app asks you for an OK (the project's Build view, the
 * Assistant chat, the factory floor, and later Needs you and the game's Dock) uses this bar, so
 * an approval always looks and answers the same.
 *
 * It knows nothing about runs or the API: give it the question and an onDecide that returns a
 * promise. While that promise is pending the pressed button says it is sending; if it rejects,
 * the message shows under the bar and the buttons come back. When it resolves the bar stays in
 * its sending state, because whatever happens next replaces it.
 */
export type GateBarProps = {
  question: ReactNode;
  /** Failed-step mode: the station that failed, shown as "<failed> failed". */
  failed?: string;
  /** Full error text, folded under a summary line. */
  error?: string;
  attempt?: number;
  /** The last try failed with the same error. */
  same?: boolean;
  /** Word on the main button. Default "Approve". */
  yes?: string;
  /** Escalations take an optional hint; approvals take "what to change" and send back with it. */
  kind?: "approve" | "escalation";
  compact?: boolean;
  /** Flash once to show a new attempt arrived. */
  fresh?: boolean;
  onDecide: (approve: boolean, note?: string) => Promise<unknown>;
  /** Turn a raw rejection message into words for people. */
  explain?: (message: string) => string;
};

export function GateBar({ question, failed, error, attempt = 1, same, yes = "Approve", kind = "approve", compact, fresh: freshIn, onDecide, explain }: GateBarProps) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<null | "yes" | "no">(null);
  const [err, setErr] = useState<string | null>(null);
  const [fresh, setFresh] = useState(!!freshIn);
  useEffect(() => { if (!fresh) return; const t = setTimeout(() => setFresh(false), 2400); return () => clearTimeout(t); }, [fresh]);
  const esc = kind === "escalation";
  const cut = compact ? 140 : 220;
  async function go(approve: boolean) {
    setBusy(approve ? "yes" : "no"); setErr(null);
    try { await onDecide(approve, note.trim() || undefined); }
    catch (e) { const m = (e as Error).message; setErr(explain ? explain(m) : m); setBusy(null); }
  }
  return (
    <div className={`gatebar${esc ? " escalation" : ""}${compact ? " compact" : ""}${fresh ? " fresh" : ""}`} role="group" aria-label="Your OK is needed">
      {failed ? (
        <div className="gate-q">
          {failed} failed{attempt > 1 ? <span className="gate-attempt mono"> · attempt {attempt}</span> : null}
          {same && <div className="gate-same">Same error as the last try. Retrying as is will likely fail again: add a hint below, or check Systems first.</div>}
          <details className="gate-err"><summary>{(error ?? String(question)).slice(0, cut)}{(error ?? "").length > cut ? "…" : ""}</summary><pre>{error ?? question}</pre></details>
        </div>
      ) : <span className="gate-q">{question}</span>}
      <input value={note} disabled={!!busy} onChange={(e) => setNote(e.target.value)}
        placeholder={esc ? (failed ? "Optional hint for the retry" : "Optional note") : "Optional: what to change (sends it back)"} aria-label={esc ? "Note" : "What to change"} />
      <div className="gate-btns">
        <button disabled={!!busy} onClick={() => go(true)}>{busy === "yes" ? (yes === "Retry" ? "Retrying…" : "Sending…") : yes}</button>
        <button className="ghost" disabled={!!busy} onClick={() => go(false)}>{busy === "no" ? "Stopping…" : note.trim() && !esc ? "Send back" : "Stop"}</button>
      </div>
      {err && <span className="err">{err}</span>}
    </div>
  );
}
