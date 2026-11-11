import { useState } from "react";
import { EmptyState, GateBar, StatusGlyph, StatusTag, type Status } from "./ui";

/**
 * #/_kit: every shared component in every state, on one page. The UI tour screenshots it, so a
 * change to a component shows up in the before/after contact sheet even if no screen uses that
 * state right now. Not linked from the app.
 */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SWATCHES: [string, string][] = [
  ["--bg", "Base"], ["--shell", "Shell"], ["--panel", "Panel"], ["--panel-2", "Raised"], ["--hover", "Hover"],
  ["--accent", "Working"], ["--gate", "Needs you"], ["--good", "Done"], ["--bad", "Failed"], ["--agent", "Agents"],
];
const STATES: Status[] = ["working", "needs", "done", "failed", "idle", "agent"];

export function KitPage() {
  const [log, setLog] = useState("Press a button on a bar above.");
  const decide = (label: string, fail = false) => async (approve: boolean, note?: string) => {
    await wait(700);
    if (fail) throw new Error("The core did not answer. Is it running?");
    setLog(`${label}: ${approve ? "approved" : "stopped"}${note ? ` with note “${note}”` : ""}. (A real bar is replaced by what happens next.)`);
  };
  return (
    <section className="pane kit" aria-label="Component kit">
      <h1>Component kit</h1>
      <p>The shared pieces every screen is built from. Colours and type come from <code>docs/design.md</code>.</p>

      <h2>Colour roles</h2>
      <div className="kit-row">
        {SWATCHES.map(([v, n]) => <div key={v} className="kit-swatch"><span style={{ background: `var(${v})` }} />{n}<code className="muted">{v}</code></div>)}
      </div>

      <h2>Status glyphs</h2>
      <div className="kit-row kit-card">
        {STATES.map((s) => <StatusGlyph key={s} status={s} size={18} />)}
        <span style={{ width: 16 }} />
        {STATES.map((s) => <StatusTag key={s} status={s} />)}
      </div>

      <h2>Approval bar</h2>
      <GateBar question="The plan for “Habit tracker with streaks” is ready: 6 tasks, about $0.40. Go ahead?" onDecide={decide("Plan")} />
      <GateBar question="Retry" failed="Build" attempt={2} same kind="escalation" yes="Retry"
        error={"npm test exited with code 1\n  ✗ streaks reset at midnight (expected 3, got 0)\n  at test/streaks.test.ts:41"} onDecide={decide("Retry")} />
      <GateBar question="This one fails to send, to show the error state." onDecide={decide("Broken", true)} />
      <div className="kit-card"><GateBar compact question="Compact, for chat: approve the build?" onDecide={decide("Compact")} /></div>
      <p className="muted" role="status">{log}</p>

      <h2>Empty states</h2>
      <div className="kit-row">
        <div className="kit-card" style={{ flex: 1, minWidth: 320 }}>
          <EmptyState title="No builds yet" action={<button>Build an idea</button>}>Type an idea to the Assistant and press Build it. Each build shows here, station by station.</EmptyState>
        </div>
        <div className="kit-card" style={{ flex: 1, minWidth: 320 }}>
          <EmptyState compact title="Nothing needs you">Approvals and failed steps land here first.</EmptyState>
        </div>
      </div>

      <h2>Buttons and fields</h2>
      <div className="kit-row kit-card">
        <button>Primary</button><button className="ghost">Ghost</button><button className="ghost sm">Small</button><button disabled>Disabled</button>
        <input placeholder="A text field" style={{ minWidth: 220 }} />
      </div>
    </section>
  );
}
