import { readFileSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename, extname } from "node:path";

/**
 * Gemini watches a video for SoftwareFactory (docs/videos.md).
 *
 * A YouTube link goes to Google as it is: Google fetches the video itself, so nothing is downloaded on this computer,
 * which keeps within YouTube's terms. A video file you have (a clip saved from TikTok, Instagram or X, a screen
 * recording) is uploaded to Gemini's Files API, watched, then deleted there.
 *
 * Gemini samples 1 frame a second and the sound, about 100 tokens a second of video at low resolution, so a
 * 10-minute video is roughly 60,000 tokens. On the free tier that costs nothing (Google may use free-tier requests to
 * improve its products); on a paid key it is about $0.05 on Gemini 3.8 Flash.
 *
 * Standard fetch only. The key travels in the x-goog-api-key header and is scrubbed from every error.
 */
export const GEMINI_API = "https://generativelanguage.googleapis.com";

/** Tried in order: the best free Flash model first, then the one with the larger free daily allowance. */
export const GEMINI_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash-lite"] as const;

/** USD per million tokens on a paid key (input, output), for the "would cost" figure. Free-tier calls cost nothing. */
export const GEMINI_RATES: Record<string, { in: number; out: number }> = {
  "gemini-3.8-flash": { in: 0.75, out: 3.75 },
  "gemini-3.7-flash": { in: 0.75, out: 3.75 },
  "gemini-3.5-flash-lite": { in: 0.3, out: 2.5 },
};

export const YOUTUBE_RE = /^https?:\/\/(?:(?:www\.|m\.|music\.)?youtube\.com\/(?:watch\?\S*\bv=[\w-]{6,}|shorts\/[\w-]{6,}|live\/[\w-]{6,})|youtu\.be\/[\w-]{6,})\S*$/i;
export const isYouTube = (s: string) => YOUTUBE_RE.test(String(s ?? "").trim());

/** One stable address per YouTube video (watch?v=ID), so the same video under another link is found in the notes. */
export function youtubeId(url: string): string | null {
  const m = String(url).match(/(?:[?&]v=|youtu\.be\/|\/shorts\/|\/live\/)([\w-]{6,})/);
  return m ? m[1] : null;
}
export const canonicalUrl = (url: string) => { const id = youtubeId(url); return id ? `https://www.youtube.com/watch?v=${id}` : String(url).trim(); };

export const DEFAULT_QUESTION =
  "Give thorough notes on this video so someone who has not seen it can learn from it: what it teaches, every step, tool, " +
  "command, setting or number it shows or says, any on-screen text or code, and the main takeaways. Chronological order.";
const PROMPT_SUFFIX =
  "\n\nCite an MM:SS (or H:MM:SS) timestamp for every claim about a specific moment. Separate what is seen from what is heard " +
  "when it matters. If the video does not show or say something needed to answer, say so plainly instead of guessing. " +
  "Start with one line: TITLE: <the video's title or a short name for it>.";

export interface WatchClip { start?: number | null; end?: number | null; fps?: number | null }
export interface GeminiAnswer {
  text: string;
  title: string | null;
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** What the call would cost on a paid key (free-tier calls cost nothing). */
  paidUsd: number;
}

export class GeminiError extends Error {
  constructor(public kind: "auth" | "quota" | "rejected" | "service" | "network" | "response" | "upload", message: string, public status?: number) { super(message); }
}

const HINT: Record<GeminiError["kind"], string> = {
  auth: "the Gemini key was refused; paste a new one from aistudio.google.com/apikey",
  quota: "the key is out of its free allowance for now (it resets daily, at midnight Pacific time)",
  rejected: "Gemini refused this video; it may be private, unlisted, age-restricted or too long",
  service: "Gemini had a server error; try again shortly",
  network: "could not reach Google's Gemini API",
  response: "Gemini answered with something SoftwareFactory cannot read",
  upload: "the video file could not be uploaded to Gemini",
};

const MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo", ".mpeg": "video/mpeg", ".mpg": "video/mpeg", ".wmv": "video/x-ms-wmv", ".3gp": "video/3gpp", ".flv": "video/x-flv",
};
export const videoMime = (path: string) => MIME[extname(path).toLowerCase()] ?? null;
/** Files bigger than this are not read into memory; Gemini's own limit is 2 GB on the free tier. */
export const MAX_FILE_BYTES = 1_000_000_000;

export function paidCost(model: string, tokensIn: number, tokensOut: number): number {
  const r = GEMINI_RATES[model] ?? GEMINI_RATES["gemini-3.8-flash"];
  return Math.round(((tokensIn * r.in + tokensOut * r.out) / 1_000_000) * 10_000) / 10_000;
}

export interface GeminiOptions { key: string; fetch?: typeof fetch; api?: string; models?: readonly string[]; timeoutMs?: number; pollMs?: number }

export class Gemini {
  constructor(private o: GeminiOptions) {}
  private get api() { return this.o.api ?? GEMINI_API; }
  private get http() { return this.o.fetch ?? longFetch; }
  private scrub(s: string) { return this.o.key ? s.split(this.o.key).join("[key]") : s; }

  private async call(method: string, url: string, init: { body?: BodyInit; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<{ status: number; headers: Headers; json: any }> {
    let r: Response;
    try {
      r = await this.http(url, {
        method, body: init.body, headers: { "x-goog-api-key": this.o.key, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(init.timeoutMs ?? this.o.timeoutMs ?? 10 * 60_000),
      });
    } catch (e) {
      const err = e as Error;
      if (err.name === "TimeoutError" || err.name === "AbortError") throw new GeminiError("network", `Gemini did not answer within ${Math.round((init.timeoutMs ?? this.o.timeoutMs ?? 10 * 60_000) / 60_000)} minutes; it will be tried again later`);
      throw new GeminiError("network", this.scrub(`${HINT.network} (${err.message})`));
    }
    const text = await r.text().catch(() => "");
    let json: any = null;
    try { json = text ? JSON.parse(text) : {}; } catch { json = null; }
    if (!r.ok) {
      const err = Array.isArray(json) ? json[0]?.error : json?.error;
      const msg = String(err?.message ?? text ?? "").slice(0, 400);
      const kind: GeminiError["kind"] = r.status === 401 || r.status === 403 || /api key/i.test(msg) ? "auth"
        : r.status === 429 || err?.status === "RESOURCE_EXHAUSTED" ? "quota" : r.status >= 500 ? "service" : "rejected";
      throw new GeminiError(kind, this.scrub(`${HINT[kind]}. Google said ${r.status}${msg ? `: ${msg}` : ""}`), r.status);
    }
    if (json == null) throw new GeminiError("response", HINT.response);
    return { status: r.status, headers: r.headers, json };
  }

  /** Watch a public YouTube link, or a file Gemini already holds (from upload()). Tries each model until one answers. */
  async watch(video: { youtube: string } | { fileUri: string; mime: string }, question?: string | null, clip: WatchClip = {}): Promise<GeminiAnswer> {
    const meta: Record<string, unknown> = {};
    if (clip.start != null && clip.start > 0) meta.start_offset = `${Math.floor(clip.start)}s`;
    if (clip.end != null && clip.end > 0) meta.end_offset = `${Math.ceil(clip.end)}s`;
    if (clip.fps != null && clip.fps > 0) meta.fps = Math.min(24, clip.fps);
    const file = "youtube" in video ? { file_uri: canonicalUrl(video.youtube) } : { file_uri: video.fileUri, mime_type: video.mime };
    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ file_data: file, ...(Object.keys(meta).length ? { video_metadata: meta } : {}) }, { text: ((question ?? "").trim() || DEFAULT_QUESTION) + PROMPT_SUFFIX }] }],
      generationConfig: { mediaResolution: "MEDIA_RESOLUTION_LOW", maxOutputTokens: 16_000 },
    });
    const models = this.o.models?.length ? this.o.models : GEMINI_MODELS;
    let last: GeminiError | null = null;
    for (const model of models) {
      try {
        const { json } = await this.call("POST", `${this.api}/v1beta/models/${encodeURIComponent(model)}:generateContent`, { body, headers: { "content-type": "application/json" } });
        const cand = json?.candidates?.[0];
        const text = (cand?.content?.parts ?? []).map((p: any) => (typeof p?.text === "string" && !p.thought ? p.text : "")).join("").trim();
        if (!text) {
          const why = json?.promptFeedback?.blockReason ?? cand?.finishReason ?? "no text";
          throw new GeminiError("rejected", `${HINT.rejected} (${why})`);
        }
        const u = json.usageMetadata ?? {};
        const tokensIn = Number(u.promptTokenCount) || 0;
        const tokensOut = (Number(u.candidatesTokenCount) || 0) + (Number(u.thoughtsTokenCount) || 0);
        const t = text.match(/^\s*TITLE:\s*(.+)$/im);
        return {
          text: t ? text.replace(t[0], "").trim() : text, title: t ? t[1].trim().slice(0, 200) : null,
          model, tokensIn, tokensOut, paidUsd: paidCost(model, tokensIn, tokensOut),
        };
      } catch (e) {
        if (!(e instanceof GeminiError)) throw e;
        last = e;
        // Out of free allowance on this model, overloaded ("high demand", 5xx), or not offered to this key: the next model may still answer.
        if (!(e.kind === "quota" || e.kind === "service" || (e.kind === "rejected" && e.status === 404))) throw e;
      }
    }
    throw last ?? new GeminiError("response", HINT.response);
  }

  /** Upload a video file to the Files API and wait until Gemini can watch it. Returns its uri, mime and name (to delete). */
  async upload(path: string): Promise<{ uri: string; mime: string; name: string }> {
    const mime = videoMime(path);
    if (!mime) throw new GeminiError("upload", `${basename(path)} is not a video file Gemini reads (mp4, mov, webm, mkv, avi, mpeg, wmv, 3gp, flv)`);
    const size = statSync(path).size;
    if (size > MAX_FILE_BYTES) throw new GeminiError("upload", `${basename(path)} is ${(size / 1e9).toFixed(1)} GB; the most SoftwareFactory sends is 1 GB. Cut it shorter first.`);
    const start = await this.http(`${this.api}/upload/v1beta/files`, {
      method: "POST",
      headers: {
        "x-goog-api-key": this.o.key, "content-type": "application/json", "x-goog-upload-protocol": "resumable", "x-goog-upload-command": "start",
        "x-goog-upload-header-content-length": String(size), "x-goog-upload-header-content-type": mime,
      },
      body: JSON.stringify({ file: { display_name: basename(path).slice(0, 120) } }),
    }).catch((e) => { throw new GeminiError("network", this.scrub(`${HINT.network} (${(e as Error).message})`)); });
    const to = start.headers.get("x-goog-upload-url");
    if (!start.ok || !to) throw new GeminiError(start.status === 401 || start.status === 403 ? "auth" : "upload", this.scrub(`${HINT.upload} (Google said ${start.status})`), start.status);
    const { json } = await this.call("POST", to, {
      body: readFileSync(path), headers: { "content-length": String(size), "x-goog-upload-offset": "0", "x-goog-upload-command": "upload, finalize" },
    });
    let f = json?.file;
    if (!f?.name || !f?.uri) throw new GeminiError("upload", HINT.upload);
    const until = Date.now() + 10 * 60_000;
    while (f.state === "PROCESSING" && Date.now() < until) {
      await new Promise((r) => setTimeout(r, this.o.pollMs ?? 3000));
      f = (await this.call("GET", `${this.api}/v1beta/${f.name}`)).json;
    }
    if (f.state && f.state !== "ACTIVE") {
      await this.remove(f.name);
      throw new GeminiError("upload", `${HINT.upload} (Gemini could not process it: ${f.state})`);
    }
    return { uri: String(f.uri), mime: String(f.mimeType ?? mime), name: String(f.name) };
  }

  /** Delete an uploaded file from Gemini. Never fails: Gemini deletes files by itself after 48 hours anyway. */
  async remove(name: string): Promise<void> {
    try { await this.call("DELETE", `${this.api}/v1beta/${name}`, { timeoutMs: 30_000 }); } catch { /* it expires on its own */ }
  }
}

/**
 * fetch over node:https without Node's built-in 5-minute wait for an answer's first byte (undici's headersTimeout):
 * Gemini can think about a video for longer than that before it answers, which showed up as a bare "fetch failed".
 * The caller's AbortSignal (10 minutes by default) is the only limit.
 */
export const longFetch = ((input: string | URL, init: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
  const u = new URL(String(input));
  const headers: Record<string, string> = {};
  new Headers(init.headers as HeadersInit | undefined).forEach((v, k) => { headers[k] = v; });
  const body = init.body == null ? null : typeof init.body === "string" ? Buffer.from(init.body) : Buffer.isBuffer(init.body) ? init.body : init.body instanceof Uint8Array ? Buffer.from(init.body) : null;
  if (init.body != null && !body) return reject(new Error("longFetch sends text or bytes only"));
  if (body && !Object.keys(headers).some((k) => k.toLowerCase() === "content-length")) headers["content-length"] = String(body.length);
  const req = (u.protocol === "http:" ? httpRequest : httpsRequest)(u, { method: init.method ?? "GET", headers }, (res) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => {
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v != null) h.set(k, Array.isArray(v) ? v.join(", ") : String(v));
      const status = res.statusCode ?? 0;
      resolve(new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks), { status, headers: h }));
    });
    res.on("error", reject);
  });
  req.on("error", reject);
  const signal = init.signal;
  if (signal) {
    if (signal.aborted) { req.destroy(); return reject(signal.reason ?? Object.assign(new Error("aborted"), { name: "AbortError" })); }
    signal.addEventListener("abort", () => { req.destroy(); reject(signal.reason ?? Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
  }
  if (body) req.write(body);
  req.end();
})) as unknown as typeof fetch;
