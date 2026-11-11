import type { DuplicateRun } from "./api";

const SAID: Record<DuplicateRun["state"], string> = {
  running: "is already building this idea",
  stopped: "already started this idea and can resume",
  shipped: "already built this idea today",
};

/**
 * Shown instead of starting a copy when Build would repeat a run: the run that already does it,
 * one tap to open it, and one tap to build again anyway (a fresh attempt is sometimes the point).
 */
export function DuplicateNotice({ dup, onShow, onAgain, onDismiss, busy }: {
  dup: DuplicateRun; onShow: (run: number) => void; onAgain: () => void; onDismiss: () => void; busy?: boolean;
}) {
  return (
    <div className="dup-notice" role="status">
      <span>Run <b>#{dup.duplicateOf}</b> {SAID[dup.state]}, so nothing new was started.</span>
      <span className="dup-actions">
        <button className="sm" onClick={() => { onShow(dup.duplicateOf); onDismiss(); }}>Show run #{dup.duplicateOf}</button>
        <button className="sm ghost" disabled={busy} onClick={onAgain} title="Start another run of the same idea; it builds a separate copy">Build again anyway</button>
        <button className="link" onClick={onDismiss}>dismiss</button>
      </span>
    </div>
  );
}
