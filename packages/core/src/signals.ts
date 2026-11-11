import type { EventLog, SfEvent } from "./events.js";

/** A Signal is anything the person says or pastes, stored raw and never edited. */
export interface Signal {
  id: number;
  ts: string;
  text: string;
  source: string;
  /** The project chat it was said in; absent: the General chat. */
  projectId?: number;
}

export function captureSignal(log: EventLog, text: string, source = "bridge", projectId?: number): Signal {
  const clean = text.replace(/\r\n/g, "\n");
  if (!clean.trim()) throw new Error("A Signal needs some text");
  const e = log.append("signal.captured", { text: clean, source, ...(projectId != null && Number.isFinite(projectId) ? { projectId } : {}) });
  return toSignal(e);
}

/** Every Signal, oldest first, read from the organized `signals` table. */
export function listSignals(log: EventLog, limit = 1000): Signal[] {
  return (log.db.prepare("SELECT id, ts, source, text FROM signals ORDER BY id ASC LIMIT ?").all(limit) as { id: number; ts: string; source: string; text: string }[])
    .map((r) => ({ id: Number(r.id), ts: r.ts, text: r.text, source: r.source }));
}

function toSignal(e: SfEvent): Signal {
  const p = e.payload as { text: string; source: string; projectId?: number };
  return { id: e.id, ts: e.ts, text: p.text, source: p.source, ...(p.projectId != null ? { projectId: p.projectId } : {}) };
}
