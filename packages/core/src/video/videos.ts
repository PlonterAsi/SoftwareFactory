import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { EventLog } from "../events.js";
import { ftsQuery } from "../plugins/store.js";
import { canonicalUrl, Gemini, GeminiError, GEMINI_MODELS, isYouTube, videoMime, type WatchClip } from "./gemini.js";

/**
 * Videos: SoftwareFactory watches a video and keeps what it learned (docs/videos.md).
 *
 *   watch   a YouTube link (Google fetches it) or a video file you have (uploaded, watched, deleted there)
 *           → timestamped notes, kept in video_notes with a full-text index
 *   again   the same video with the same question is answered from the notes, free, unless you ask to refresh
 *   search  every note ever taken, by words
 *
 * The Gemini key lives in one place, ~/.config/watch/.env (GEMINI_API_KEY), the same file Claude Code's /watch
 * plugin reads, so pasting it once in Systems serves both. It is never logged and never sent back to a screen.
 *
 * Only YouTube links are fetched. TikTok, Instagram and X forbid automated downloading in their terms, so clips from
 * there come in as files you saved yourself.
 */
export const VIDEO_LIMITS = { dailyDefault: 40, dailyMax: 1000, concurrent: 2, questionChars: 4000, notesChars: 200_000 };

export interface VideoNote {
  id: number;
  source: string;
  kind: "youtube" | "file";
  title: string | null;
  question: string | null;
  clip: WatchClip;
  notes: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  paidUsd: number;
  by: string;
  at: string;
  snippet?: string;
}
export interface WatchRequest { url?: string; file?: string; question?: string | null; start?: number | null; end?: number | null; fps?: number | null; refresh?: boolean }
export interface VideoSettings { dailyMax: number; models: string[] }
export interface VideoStatus {
  hasKey: boolean;
  keySource: "env" | "file" | null;
  keyHint: string | null;
  keyFile: string;
  settings: VideoSettings;
  today: number;
  notes: number;
}

type Row = Record<string, any>;
const today = (now = new Date()) => now.toISOString().slice(0, 10);
const KEY_RE = /^[A-Za-z0-9_.\-]{30,200}$/;

export class Videos {
  private busy = 0;
  constructor(private log: EventLog, private o: { homeDir?: string; env?: NodeJS.ProcessEnv; fetch?: typeof fetch; api?: string; pollMs?: number } = {}) {
    log.db.exec(`CREATE TABLE IF NOT EXISTS video_notes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ckey       TEXT NOT NULL UNIQUE,
      source     TEXT NOT NULL,
      kind       TEXT NOT NULL,
      title      TEXT,
      question   TEXT,
      clip       TEXT NOT NULL DEFAULT '{}',
      notes      TEXT NOT NULL,
      model      TEXT NOT NULL,
      tokens_in  INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      paid_usd   REAL NOT NULL DEFAULT 0,
      by_who     TEXT NOT NULL,
      at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS video_notes_source ON video_notes(source);
    CREATE VIRTUAL TABLE IF NOT EXISTS video_notes_fts USING fts5(text, tokenize='porter unicode61');`);
  }

  // ---- the key ----------------------------------------------------------------------------

  /** ~/.config/watch/.env: shared with Claude Code's /watch plugin. */
  get keyFile() { return join(this.o.homeDir ?? homedir(), ".config", "watch", ".env"); }
  private envFile(): Record<string, string> {
    try {
      const out: Record<string, string> = {};
      for (const line of readFileSync(this.keyFile, "utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
      }
      return out;
    } catch { return {}; }
  }
  private key(): { key: string; source: "env" | "file" } | null {
    const env = (this.o.env ?? process.env).GEMINI_API_KEY?.trim();
    if (env) return { key: env, source: "env" };
    const f = this.envFile().GEMINI_API_KEY?.trim();
    return f ? { key: f, source: "file" } : null;
  }

  /** Save the key (or remove it with null) in the shared file, keeping every other line there. */
  setKey(key: string | null, by = "you"): VideoStatus {
    const k = key == null ? "" : String(key).trim();
    if (k && !KEY_RE.test(k)) throw new Error("That does not look like a Gemini API key. Copy it from aistudio.google.com/apikey.");
    const file = this.keyFile;
    const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/).filter((l) => !/^\s*(?:export\s+)?GEMINI_API_KEY\s*=/.test(l)) : [];
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (k) lines.push(`GEMINI_API_KEY=${k}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, lines.length ? lines.join("\n") + "\n" : "", { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* Windows keeps it in the user's own folder */ }
    this.log.append("video.key", { set: !!k, hint: k ? k.slice(-4) : null, by });
    return this.status();
  }

  // ---- settings -----------------------------------------------------------------------------

  settings(): VideoSettings {
    const r = this.log.db.prepare("SELECT payload FROM events WHERE type = 'video.settings' ORDER BY id DESC LIMIT 1").get() as { payload: string } | undefined;
    const p = r ? JSON.parse(r.payload) : {};
    const dailyMax = Number.isInteger(p.dailyMax) && p.dailyMax >= 0 ? p.dailyMax : VIDEO_LIMITS.dailyDefault;
    const models = Array.isArray(p.models) && p.models.length ? p.models.map(String) : [...GEMINI_MODELS];
    return { dailyMax, models };
  }
  setSettings(b: { dailyMax?: unknown; models?: unknown }, by = "you"): VideoStatus {
    const cur = this.settings();
    const next = { ...cur };
    if (b.dailyMax !== undefined) {
      const n = Number(b.dailyMax);
      if (!Number.isInteger(n) || n < 0 || n > VIDEO_LIMITS.dailyMax) throw new Error(`Videos a day is a whole number from 0 to ${VIDEO_LIMITS.dailyMax}`);
      next.dailyMax = n;
    }
    if (b.models !== undefined) {
      const m = (Array.isArray(b.models) ? b.models : String(b.models).split(",")).map((x) => String(x).trim()).filter((x) => /^[a-z0-9][a-z0-9.\-]{2,60}$/.test(x)).slice(0, 5);
      if (!m.length) throw new Error("Name at least one Gemini model, like gemini-3.8-flash");
      next.models = m;
    }
    this.log.append("video.settings", { ...next, by });
    return this.status();
  }

  todayCount(now = new Date()): number {
    const r = this.log.db.prepare("SELECT count(*) AS n FROM events WHERE type = 'video.watched' AND json_extract(payload, '$.cached') = 0 AND ts >= ?").get(`${today(now)}T00:00:00`) as { n: number };
    return Number(r.n);
  }

  status(): VideoStatus {
    const k = this.key();
    const n = (this.log.db.prepare("SELECT count(*) AS n FROM video_notes").get() as { n: number }).n;
    return { hasKey: !!k, keySource: k?.source ?? null, keyHint: k ? `…${k.key.slice(-4)}` : null, keyFile: this.keyFile, settings: this.settings(), today: this.todayCount(), notes: Number(n) };
  }

  // ---- notes ----------------------------------------------------------------------------------

  private row(r: Row): VideoNote {
    return {
      id: r.id, source: r.source, kind: r.kind, title: r.title, question: r.question, clip: JSON.parse(r.clip || "{}"), notes: r.notes, model: r.model,
      tokensIn: r.tokens_in, tokensOut: r.tokens_out, paidUsd: r.paid_usd, by: r.by_who, at: r.at, ...(r.snippet ? { snippet: r.snippet } : {}),
    };
  }
  get(id: number): VideoNote | null {
    const r = this.log.db.prepare("SELECT * FROM video_notes WHERE id = ?").get(id) as Row | undefined;
    return r ? this.row(r) : null;
  }
  /** Notes found by words (best first), or the newest when no words are given. */
  search(text?: string | null, limit = 20): VideoNote[] {
    const lim = Math.min(Math.max(1, Number(limit) || 20), 200);
    const q = text ? ftsQuery(String(text)) : null;
    if (!q) return (this.log.db.prepare("SELECT * FROM video_notes ORDER BY id DESC LIMIT ?").all(lim) as Row[]).map((r) => this.row(r));
    const rows = this.log.db.prepare(`SELECT n.*, snippet(video_notes_fts, 0, '[', ']', '…', 18) AS snippet FROM video_notes_fts f JOIN video_notes n ON n.id = f.rowid
      WHERE video_notes_fts MATCH ? ORDER BY rank LIMIT ?`).all(q, lim) as Row[];
    return rows.map((r) => this.row(r));
  }

  // ---- watching -------------------------------------------------------------------------------

  private source(req: WatchRequest): { kind: "youtube" | "file"; source: string; stamp: string } {
    const url = String(req.url ?? "").trim();
    const file = String(req.file ?? "").trim();
    if (url && file) throw new Error("Give a YouTube link or a video file, not both");
    if (url) {
      if (isYouTube(url)) return { kind: "youtube", source: canonicalUrl(url), stamp: "" };
      if (/^https?:\/\//i.test(url)) throw new Error("Gemini watches YouTube links only. For a TikTok, Instagram or X video, save the clip from the app and give its file: those sites forbid automated downloading.");
      throw new Error("That is not a YouTube link");
    }
    if (file) {
      if (!isAbsolute(file)) throw new Error("Give the video file's full path");
      const p = resolve(file);
      let st;
      try { st = statSync(p); } catch { throw new Error(`There is no file at ${p}`); }
      if (!st.isFile()) throw new Error(`${p} is a folder, not a video file`);
      if (!videoMime(p)) throw new Error(`${p} is not a video file Gemini reads (mp4, mov, webm, mkv, avi, mpeg, wmv, 3gp, flv)`);
      return { kind: "file", source: p, stamp: `${st.size}:${Math.floor(st.mtimeMs)}` };
    }
    throw new Error("Give a YouTube link or a video file to watch");
  }

  private clip(req: WatchRequest): WatchClip {
    const num = (v: unknown, name: string, max: number) => {
      if (v == null || v === "") return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`${name} must be a number from 0 to ${max}`);
      return n || null;
    };
    const c = { start: num(req.start, "start (seconds)", 86_400), end: num(req.end, "end (seconds)", 86_400), fps: num(req.fps, "fps", 24) };
    if (c.start != null && c.end != null && c.end <= c.start) throw new Error("end must come after start");
    return c;
  }

  /** Watch a video, or answer from the notes when this exact ask was answered before. */
  async watch(req: WatchRequest, by = "you"): Promise<VideoNote & { cached: boolean }> {
    const src = this.source(req);
    const clip = this.clip(req);
    const question = String(req.question ?? "").trim().slice(0, VIDEO_LIMITS.questionChars) || null;
    const ckey = createHash("sha256").update(JSON.stringify([src.source, src.stamp, question?.toLowerCase() ?? "", clip.start, clip.end, clip.fps])).digest("hex");
    const prev = this.log.db.prepare("SELECT * FROM video_notes WHERE ckey = ?").get(ckey) as Row | undefined;
    if (prev && !req.refresh) {
      const n = this.row(prev);
      this.log.append("video.watched", { id: n.id, source: n.source, title: n.title, model: n.model, tokensIn: 0, tokensOut: 0, paidUsd: 0, cached: 1, by });
      return { ...n, cached: true };
    }
    const k = this.key();
    if (!k) throw new Error("No Gemini key yet. Get a free one at aistudio.google.com/apikey and paste it in Systems, Videos.");
    const s = this.settings();
    const done = this.todayCount();
    if (done >= s.dailyMax) throw new Error(`SoftwareFactory already watched ${done} videos today, its daily limit. Raise it in Systems, Videos, or try tomorrow.`);
    if (this.busy >= VIDEO_LIMITS.concurrent) throw new Error(`${this.busy} videos are being watched already; wait for one to finish`);
    this.busy++;
    const g = new Gemini({ key: k.key, fetch: this.o.fetch, api: this.o.api, models: s.models, pollMs: this.o.pollMs });
    let uploaded: string | null = null;
    try {
      let a;
      try {
        if (src.kind === "youtube") a = await g.watch({ youtube: src.source }, question, clip);
        else {
          const f = await g.upload(src.source);
          uploaded = f.name;
          a = await g.watch({ fileUri: f.uri, mime: f.mime }, question, clip);
        }
      } catch (e) {
        const msg = e instanceof GeminiError ? e.message : (e as Error).message;
        this.log.append("video.failed", { source: src.source, kind: e instanceof GeminiError ? e.kind : "error", error: msg.slice(0, 500), by });
        throw new Error(msg);
      }
      const at = new Date().toISOString();
      const notes = a.text.slice(0, VIDEO_LIMITS.notesChars);
      const db = this.log.db;
      if (prev) {
        db.prepare("DELETE FROM video_notes_fts WHERE rowid = ?").run(prev.id);
        db.prepare("DELETE FROM video_notes WHERE id = ?").run(prev.id);
      }
      const r = db.prepare(`INSERT INTO video_notes (ckey, source, kind, title, question, clip, notes, model, tokens_in, tokens_out, paid_usd, by_who, at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ckey, src.source, src.kind, a.title, question, JSON.stringify(clip), notes, a.model, a.tokensIn, a.tokensOut, a.paidUsd, by, at);
      const id = Number(r.lastInsertRowid);
      db.prepare("INSERT INTO video_notes_fts(rowid, text) VALUES (?, ?)").run(id, `${a.title ?? ""}\n${question ?? ""}\n${notes}`);
      this.log.append("video.watched", { id, source: src.source, title: a.title, model: a.model, tokensIn: a.tokensIn, tokensOut: a.tokensOut, paidUsd: a.paidUsd, cached: 0, by });
      return { ...(this.get(id) as VideoNote), cached: false };
    } finally {
      this.busy--;
      if (uploaded) await g.remove(uploaded);
    }
  }
}
