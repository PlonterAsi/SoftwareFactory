import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { EventLog } from "../events.js";
import { captureSignal } from "../signals.js";

/**
 * The drop folder: capture ideas away from the desk. Save a .txt or .md note
 * into the folder (point it at a OneDrive or Google Drive folder and your phone
 * can do it) and it becomes a Signal, filed by the Order Engine like anything
 * you type. The note is then moved to `filed/` next to it, so nothing is lost
 * and nothing is read twice.
 */
export const DROP_EXTS = [".txt", ".md", ".markdown", ".text"];
const MAX_BYTES = 200_000;
/** A file younger than this may still be being written (a sync client, an editor). */
const SETTLE_MS = 1500;

export interface DropResult { file: string; status: "filed" | "skipped"; signalId?: number; note?: string }

export class DropFolder {
  private timer: NodeJS.Timeout | null = null;
  private skipped = new Set<string>();
  constructor(private log: EventLog, public dir: string, private now = () => Date.now()) {}

  /** Look once. Returns what happened to each new note. */
  scan(): DropResult[] {
    const out: DropResult[] = [];
    let names: string[];
    try {
      mkdirSync(this.dir, { recursive: true });
      names = readdirSync(this.dir);
    } catch (e) {
      return out;
    }
    const known = new Set((this.log.db.prepare("SELECT sha256 FROM drops WHERE status = 'filed'").all() as { sha256: string }[]).map((r) => r.sha256));
    for (const name of names.sort()) {
      const path = join(this.dir, name);
      let st;
      try { st = statSync(path); } catch { continue; }
      if (!st.isFile() || name.startsWith(".") || name.startsWith("~$")) continue;
      const key = `${name}:${st.size}:${st.mtimeMs}`;
      if (this.skipped.has(key)) continue;
      if (this.now() - st.mtimeMs < SETTLE_MS) continue;
      if (!DROP_EXTS.includes(extname(name).toLowerCase())) {
        this.skipped.add(key);
        this.log.append("drop.skipped", { file: name, bytes: st.size, sha256: "", note: `Only ${DROP_EXTS.join(", ")} notes are read; this file was left where it is.` });
        out.push({ file: name, status: "skipped" });
        continue;
      }
      if (st.size > MAX_BYTES) {
        this.skipped.add(key);
        this.log.append("drop.skipped", { file: name, bytes: st.size, sha256: "", note: `Larger than ${MAX_BYTES / 1000} KB; left where it is.` });
        out.push({ file: name, status: "skipped" });
        continue;
      }
      const buf = readFileSync(path);
      const sha256 = createHash("sha256").update(buf).digest("hex");
      const text = buf.toString("utf8").replace(/^﻿/, "").trim();
      const movedTo = this.moveAside(path, name);
      if (known.has(sha256) || !text) {
        const note = !text ? "Empty note, nothing to capture." : "Same note as one already captured; not read twice.";
        this.log.append("drop.skipped", { file: name, bytes: st.size, sha256, movedTo, note });
        out.push({ file: name, status: "skipped", note });
        continue;
      }
      const sig = captureSignal(this.log, text, "drop");
      this.log.append("drop.filed", { file: name, bytes: st.size, sha256, signalId: sig.id, movedTo });
      known.add(sha256);
      out.push({ file: name, status: "filed", signalId: sig.id });
    }
    return out;
  }

  /** Move a read note into filed/, stamped with the date, never overwriting. */
  private moveAside(path: string, name: string): string | null {
    const filed = join(this.dir, "filed");
    try {
      mkdirSync(filed, { recursive: true });
      const stamp = new Date(this.now()).toISOString().slice(0, 10);
      let target = join(filed, `${stamp} ${name}`);
      for (let i = 2; existsQuiet(target); i++) target = join(filed, `${stamp} (${i}) ${name}`);
      renameSync(path, target);
      return target;
    } catch {
      return null;
    }
  }

  start(everyMs = 5000) {
    this.stop();
    this.scan();
    this.timer = setInterval(() => { try { this.scan(); } catch (e) { console.error("drop folder:", e); } }, everyMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Recent drops for the Bridge, newest first. */
  recent(limit = 20) {
    return (this.log.db.prepare("SELECT id, ts, file, bytes, signal_id AS signalId, status, note FROM drops ORDER BY id DESC LIMIT ?").all(limit) as Record<string, unknown>[])
      .map((r) => ({ ...r, id: Number(r.id), bytes: Number(r.bytes), signalId: r.signalId == null ? null : Number(r.signalId) }));
  }
}

function existsQuiet(p: string) {
  try { statSync(p); return true; } catch { return false; }
}
