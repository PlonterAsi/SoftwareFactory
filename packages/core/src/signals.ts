import type { EventLog, SfEvent } from "./events.js";

/** A Signal is anything the person says or pastes, stored raw and never edited. */
export interface Signal {
  id: number;
  ts: string;
  text: string;
  source: string;
}

export function captureSignal(log: EventLog, text: string, source = "bridge"): Signal {
  const clean = text.replace(/\r\n/g, "\n");
  if (!clean.trim()) throw new Error("A Signal needs some text");
  const e = log.append("signal.captured", { text: clean, source });
  return toSignal(e);
}

export function listSignals(log: EventLog): Signal[] {
  return log.list({ type: "signal.captured" }).map(toSignal);
}

function toSignal(e: SfEvent): Signal {
  const p = e.payload as { text: string; source: string };
  return { id: e.id, ts: e.ts, text: p.text, source: p.source };
}
