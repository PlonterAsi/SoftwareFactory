import { Component, useEffect, useState, type ReactNode } from "react";
import { API } from "./api";
import { ticketsApi } from "./Tickets";

/**
 * Errors become bugs by themselves, and a bug is one press away.
 *
 *   - the catcher: an error on a screen or a promise nobody caught is posted
 *     to the core, which files it as a bug ticket (once per error, "Seen
 *     again" after that); nothing goes to an outside service;
 *   - the boundary: a screen that breaks says which bug it was filed as and
 *     offers a reload, instead of a blank window;
 *   - Report a bug: what went wrong and what you expected, with the screen and
 *     the last errors attached so nobody has to ask.
 */

const recent: { at: string; message: string }[] = [];
const sent = new Map<string, number>();
let installed = false;

/** Noise that is not a bug of ours. */
const NOISE = /ResizeObserver loop|Script error\.?$|chrome-extension:|moz-extension:/;

export function screenContext() {
  return {
    screen: location.hash || "#/",
    window: `${window.innerWidth}x${window.innerHeight}`,
    agent: navigator.userAgent.replace(/\s*\(.*?\)\s*/g, " ").slice(0, 120),
    recentErrors: recent.slice(-5),
  };
}

const projectOnScreen = () => { const m = location.hash.match(/^#\/p\/(\d+)/); return m ? Number(m[1]) : null; };

/** Send one error to the core. The same message more than once a minute is sent once. */
export async function reportError(e: unknown, where?: string): Promise<number | null> {
  const err = e instanceof Error ? e : new Error(typeof e === "string" ? e : JSON.stringify(e) ?? "Unknown error");
  const message = `${err.name && err.name !== "Error" ? `${err.name}: ` : ""}${err.message}`;
  if (NOISE.test(message) || NOISE.test(err.stack ?? "")) return null;
  recent.push({ at: new Date().toISOString(), message: message.slice(0, 200) });
  if (recent.length > 20) recent.shift();
  const last = sent.get(message);
  if (last && Date.now() - last < 60_000) return null;
  sent.set(message, Date.now());
  try {
    const r = await fetch(`${API}/api/tickets/capture`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, stack: err.stack, where: where ?? `bridge ${location.hash || "#/"}`, from: "bridge", context: screenContext(), project: projectOnScreen() }),
    });
    return ((await r.json()) as { ticket: number | null }).ticket;
  } catch { return null; } // the core is down: CoreDown already says so
}

export function installErrorCatcher() {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (ev) => { void reportError(ev.error ?? ev.message); });
  window.addEventListener("unhandledrejection", (ev) => { void reportError(ev.reason); });
}

/** Ask the Tickets screen to open one ticket, now or when it mounts. */
let pending: number | null = null;
export function showTicket(id: number) {
  pending = id;
  location.hash = "#/factory/tickets";
  window.dispatchEvent(new CustomEvent("sf:ticket", { detail: id }));
}
export function takePendingTicket() { const p = pending; pending = null; return p; }

/** A screen that throws says what happened and that it is filed, instead of going blank. */
export class ErrorBoundary extends Component<{ children: ReactNode; where?: string }, { error: Error | null; ticket: number | null }> {
  state = { error: null as Error | null, ticket: null as number | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    const e = new Error(error.message);
    e.name = error.name;
    e.stack = `${error.stack ?? ""}\nComponents:${info.componentStack ?? ""}`.slice(0, 6000);
    reportError(e, this.props.where).then((ticket) => this.setState({ ticket }));
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="broke" role="alert">
        <h2>This screen broke</h2>
        <p className="mono">{this.state.error.message}</p>
        <p>{this.state.ticket != null ? <>It is filed as bug #{this.state.ticket}, with what was on screen.</> : "Filing it as a bug…"}</p>
        <div className="row">
          <button onClick={() => location.reload()}>Reload</button>
          {this.state.ticket != null && <button className="ghost" onClick={() => { this.setState({ error: null }); showTicket(this.state.ticket!); }}>Open the bug</button>}
        </div>
      </div>
    );
  }
}

/** The Report a bug drawer. */
export function BugReport({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [what, setWhat] = useState("");
  const [expected, setExpected] = useState("");
  const [attach, setAttach] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [filed, setFiled] = useState<number | null>(null);
  useEffect(() => { if (open) { setFiled(null); setErr(null); } }, [open]);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);
  if (!open) return null;
  const ctx = screenContext();
  const send = async () => {
    setBusy(true); setErr(null);
    try {
      const body = [what.trim(), attach ? ["", "On screen when reported:", `screen: ${ctx.screen}`, `window: ${ctx.window}`, `browser: ${ctx.agent}`, ...(ctx.recentErrors.length ? ["recent errors:", ...ctx.recentErrors.map((r) => `  - ${r.at.slice(11, 19)}  ${r.message}`)] : [])].join("\n") : ""].filter(Boolean).join("\n");
      const t = await ticketsApi.open({ kind: "bug", title: what.trim().split("\n")[0], body, answers: { expected: expected.trim() }, project: projectOnScreen(), tags: ["reported"] });
      setFiled(t.id); setWhat(""); setExpected("");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="scrim" onClick={onClose}>
      <aside className="setup bug-report" role="dialog" aria-modal="true" aria-label="Report a bug" onClick={(e) => e.stopPropagation()}>
        <header className="setup-head">
          <div>
            <div className="setup-kicker mono">REPORT A BUG</div>
            <h2>What went wrong?</h2>
          </div>
          <button className="ghost" onClick={onClose} aria-label="Close">Close</button>
        </header>
        {filed != null ? (
          <section className="setup-sec">
            <p>Filed as bug #{filed}. The crew can work it from the ticket.</p>
            <div className="row">
              <button onClick={() => { onClose(); showTicket(filed); }}>Open bug #{filed}</button>
              <button className="ghost" onClick={() => setFiled(null)}>Report another</button>
            </div>
          </section>
        ) : (
          <section className="setup-sec bug-form">
            <label>What happened
              <textarea className="tk-input" rows={4} autoFocus value={what} onChange={(e) => setWhat(e.target.value)} placeholder="I pressed Work it and nothing happened" />
            </label>
            <label>What you expected
              <textarea className="tk-input" rows={2} value={expected} onChange={(e) => setExpected(e.target.value)} placeholder="A run to start" />
            </label>
            <label className="check">
              <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} />
              Attach what is on screen: {ctx.screen}{ctx.recentErrors.length ? `, and the last ${ctx.recentErrors.length} error${ctx.recentErrors.length === 1 ? "" : "s"}` : ""}
            </label>
            {err && <p className="alert-text">{err}</p>}
            <div className="row">
              <button disabled={busy || !what.trim()} onClick={send}>{busy ? "Filing…" : "File the bug"}</button>
            </div>
          </section>
        )}
      </aside>
    </div>
  );
}
