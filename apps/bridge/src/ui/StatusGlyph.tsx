/**
 * One small mark per state, read by shape as well as colour (so it still works for colour-blind
 * eyes and in a screenshot): working = spinning ring, needs you = amber diamond, done = check,
 * failed = cross, waiting/idle = dashed ring, agent = violet dot.
 */
export type Status = "working" | "needs" | "done" | "failed" | "idle" | "agent";

export const STATUS_WORD: Record<Status, string> = {
  working: "Working", needs: "Needs you", done: "Done", failed: "Failed", idle: "Not started", agent: "Agent",
};

export function StatusGlyph({ status, size = 14, label }: { status: Status; size?: number; label?: string }) {
  const s = size;
  const common = { width: s, height: s, viewBox: "0 0 16 16", className: `glyph g-${status}`, role: "img", "aria-label": label ?? STATUS_WORD[status] } as const;
  switch (status) {
    case "working": return <svg {...common}><circle cx="8" cy="8" r="6" className="g-track" /><path d="M8 2a6 6 0 0 1 6 6" className="g-arc" /></svg>;
    case "needs": return <svg {...common}><path d="M8 1.8 14.2 8 8 14.2 1.8 8Z" className="g-fill" /><path d="M8 5v3.6M8 10.6v.4" className="g-cut" /></svg>;
    case "done": return <svg {...common}><circle cx="8" cy="8" r="7" className="g-fill" /><path d="m4.8 8.2 2.2 2.2 4.2-4.6" className="g-cut" /></svg>;
    case "failed": return <svg {...common}><circle cx="8" cy="8" r="7" className="g-fill" /><path d="m5.5 5.5 5 5m0-5-5 5" className="g-cut" /></svg>;
    case "agent": return <svg {...common}><circle cx="8" cy="8" r="4" className="g-fill" /><circle cx="8" cy="8" r="7" className="g-track" /></svg>;
    default: return <svg {...common}><circle cx="8" cy="8" r="6" className="g-dash" /></svg>;
  }
}

/** Glyph plus word, for lists and headers. */
export function StatusTag({ status, children }: { status: Status; children?: React.ReactNode }) {
  return <span className={`status-tag t-${status}`}><StatusGlyph status={status} size={13} label="" />{children ?? STATUS_WORD[status]}</span>;
}
