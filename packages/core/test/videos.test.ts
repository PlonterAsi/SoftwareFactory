import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, Videos, Gemini, canonicalUrl, isYouTube, paidCost } from "../src/index.js";

/** Videos (docs/videos.md): Gemini watches a YouTube link or a saved clip, and the notes are kept. */
const tmp = () => mkdtempSync(join(tmpdir(), "sf-video-"));
const KEY = "AIzaSyTESTKEY000000000000000000000000000";

interface Seen { url: string; method: string; body: any; headers: Record<string, string> }
function fakeGoogle(answer: (url: string, seen: Seen[]) => { status: number; body: unknown; headers?: Record<string, string> } | null = () => null) {
  const seen: Seen[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    let body: any = init.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { /* raw */ } }
    seen.push({ url, method: String(init.method ?? "GET"), body, headers });
    const a = answer(url, seen) ?? {
      status: 200,
      body: { candidates: [{ content: { parts: [{ text: "TITLE: Building a CLI in Rust\n00:12 cargo new shows a fresh project." }] } }], usageMetadata: { promptTokenCount: 60000, candidatesTokenCount: 2000 } },
    };
    return new Response(typeof a.body === "string" ? a.body : JSON.stringify(a.body), { status: a.status, headers: a.headers });
  }) as unknown as typeof fetch;
  return { f, seen };
}

describe("YouTube links", () => {
  it("knows YouTube links in every shape and gives one address per video", () => {
    for (const u of ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30", "https://youtu.be/dQw4w9WgXcQ", "https://m.youtube.com/shorts/dQw4w9WgXcQ", "https://youtube.com/live/dQw4w9WgXcQ"]) {
      expect(isYouTube(u)).toBe(true);
      expect(canonicalUrl(u)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    }
    expect(isYouTube("https://www.tiktok.com/@a/video/123")).toBe(false);
    expect(isYouTube("https://www.youtube.com/")).toBe(false);
  });
  it("prices a call as it would cost on a paid key", () => {
    expect(paidCost("gemini-3.8-flash", 60000, 2000)).toBe(0.0525);
  });
});

describe("Gemini", () => {
  it("sends the link as it is, with the clip, and reads the title and tokens", async () => {
    const { f, seen } = fakeGoogle();
    const a = await new Gemini({ key: KEY, fetch: f }).watch({ youtube: "https://youtu.be/dQw4w9WgXcQ" }, "How is the project made?", { start: 60, end: 120, fps: 0.5 });
    expect(seen[0].url).toContain("/v1beta/models/gemini-3.8-flash:generateContent");
    expect(seen[0].headers["x-goog-api-key"]).toBe(KEY);
    const part = seen[0].body.contents[0].parts[0];
    expect(part.file_data.file_uri).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(part.video_metadata).toEqual({ start_offset: "60s", end_offset: "120s", fps: 0.5 });
    expect(seen[0].body.contents[0].parts[1].text).toContain("How is the project made?");
    expect(a).toMatchObject({ title: "Building a CLI in Rust", model: "gemini-3.8-flash", tokensIn: 60000, tokensOut: 2000 });
    expect(a.text).not.toContain("TITLE:");
  });
  it("moves to the next model when the free allowance runs out, and never shows the key in an error", async () => {
    const { f, seen } = fakeGoogle((url) => url.includes("3.8") ? { status: 429, body: { error: { status: "RESOURCE_EXHAUSTED", message: `quota for ${KEY}` } } } : null);
    const a = await new Gemini({ key: KEY, fetch: f }).watch({ youtube: "https://youtu.be/dQw4w9WgXcQ" });
    expect(seen.map((s) => s.url.match(/models\/([^:]+)/)?.[1])).toEqual(["gemini-3.8-flash", "gemini-3.5-flash-lite"]);
    expect(a.model).toBe("gemini-3.5-flash-lite");
    const { f: f2 } = fakeGoogle(() => ({ status: 429, body: { error: { message: `quota for ${KEY}` } } }));
    const err = await new Gemini({ key: KEY, fetch: f2 }).watch({ youtube: "https://youtu.be/dQw4w9WgXcQ" }).catch((e) => e);
    expect(err.kind).toBe("quota");
    expect(err.message).not.toContain(KEY);
  });
  it("stops at a refused key without trying other models", async () => {
    const { f, seen } = fakeGoogle(() => ({ status: 400, body: { error: { message: "API key not valid. Please pass a valid API key." } } }));
    const err = await new Gemini({ key: KEY, fetch: f }).watch({ youtube: "https://youtu.be/dQw4w9WgXcQ" }).catch((e) => e);
    expect(err.kind).toBe("auth");
    expect(seen).toHaveLength(1);
  });
});

describe("Videos", () => {
  const make = (answer?: Parameters<typeof fakeGoogle>[0]) => {
    const home = tmp();
    const g = fakeGoogle(answer);
    const v = new Videos(new EventLog(":memory:"), { homeDir: home, env: {}, fetch: g.f, pollMs: 1 });
    return { v, home, seen: g.seen };
  };

  it("keeps the key in the file /watch reads, beside the lines already there, and never logs it", () => {
    const { v, home } = make();
    expect(v.status().hasKey).toBe(false);
    const file = join(home, ".config", "watch", ".env");
    v.setKey(null);
    writeFileSync(file, "WATCH_DETAIL=balanced\nGEMINI_API_KEY=old\n");
    const s = v.setKey(KEY);
    expect(s).toMatchObject({ hasKey: true, keySource: "file", keyHint: "…0000" });
    expect(readFileSync(file, "utf8")).toBe(`WATCH_DETAIL=balanced\nGEMINI_API_KEY=${KEY}\n`);
    expect(JSON.stringify((v as any).log.db.prepare("SELECT payload FROM events").all())).not.toContain(KEY);
    expect(() => v.setKey("not a key")).toThrow(/does not look like a Gemini API key/);
    writeFileSync(file, `WATCH_DETAIL=balanced\n${KEY}\n`);
    expect(v.status()).toMatchObject({ hasKey: true, keyHint: "…0000" });
    v.setKey(null);
    expect(readFileSync(file, "utf8")).toBe("WATCH_DETAIL=balanced\n");
  });

  it("watches a YouTube link once, answers the same ask from the notes for free, and finds it by search", async () => {
    const { v, seen } = make();
    v.setKey(KEY);
    const a = await v.watch({ url: "https://youtu.be/dQw4w9WgXcQ" });
    expect(a).toMatchObject({ cached: false, kind: "youtube", source: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Building a CLI in Rust", paidUsd: 0.0525 });
    const b = await v.watch({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    expect(b.cached).toBe(true);
    expect(seen).toHaveLength(1);
    expect(v.todayCount()).toBe(1);
    await v.watch({ url: "https://youtu.be/dQw4w9WgXcQ", refresh: true });
    expect(seen).toHaveLength(2);
    expect(v.search("cargo")[0]).toMatchObject({ title: "Building a CLI in Rust" });
    expect(v.search("cargo")[0].snippet).toContain("[cargo]");
    expect(v.status().notes).toBe(1);
  });

  it("the same clip asked twice at once is watched once, and a refresh that overlaps a watch does not crash on the note", async () => {
    const { v, seen } = make();
    v.setKey(KEY);
    const [a, b] = await Promise.all([v.watch({ url: "https://youtu.be/dQw4w9WgXcQ" }), v.watch({ url: "https://youtu.be/dQw4w9WgXcQ" })]);
    expect([a.cached, b.cached]).toEqual([false, true]);
    expect(seen).toHaveLength(1);
    const [c, d] = await Promise.all([v.watch({ url: "https://youtu.be/dQw4w9WgXcQ", refresh: true }), v.watch({ url: "https://youtu.be/dQw4w9WgXcQ", refresh: true })]);
    expect(c.title).toBe("Building a CLI in Rust");
    expect(d.title).toBe("Building a CLI in Rust");
    expect(v.status().notes).toBe(1);
  });

  it("fetches only known social links, and says why when it cannot (no Scrape Creators key, no yt-dlp)", async () => {
    const home = tmp();
    const g = fakeGoogle();
    const v = new Videos(new EventLog(":memory:"), { homeDir: home, env: {}, fetch: g.f, pollMs: 1, cloudFolders: () => [], run: async () => ({ code: -1, stdout: "", stderr: "not found" }) });
    v.setKey(KEY);
    await expect(v.watch({ url: "https://vimeo.com/123" })).rejects.toThrow(/save the video into your Watch folder/);
    await expect(v.watch({ url: "https://www.tiktok.com/@a/video/123" })).rejects.toThrow(/no Scrape Creators key; yt-dlp is not installed/);
    expect(g.seen).toHaveLength(0);
  });

  it("needs a key, and stops at the daily limit", async () => {
    const { v } = make();
    await expect(v.watch({ url: "https://youtu.be/dQw4w9WgXcQ" })).rejects.toThrow(/No Gemini key yet/);
    v.setKey(KEY);
    v.setSettings({ dailyMax: 1 });
    await v.watch({ url: "https://youtu.be/dQw4w9WgXcQ" });
    await expect(v.watch({ url: "https://youtu.be/aaaaaaaaaaa" })).rejects.toThrow(/daily limit/);
  });

  it("uploads a saved clip, watches it, and deletes it from Gemini", async () => {
    const dir = tmp();
    const clip = join(dir, "reel.mp4");
    writeFileSync(clip, Buffer.alloc(1000));
    const { v, seen } = make((url, s) => {
      if (url.endsWith("/upload/v1beta/files")) return { status: 200, body: {}, headers: { "x-goog-upload-url": "https://upload.example/u1" } };
      if (url === "https://upload.example/u1") return { status: 200, body: { file: { name: "files/abc", uri: "https://g/files/abc", mimeType: "video/mp4", state: "PROCESSING" } } };
      if (url.endsWith("/v1beta/files/abc") && s[s.length - 1].method === "GET") return { status: 200, body: { name: "files/abc", uri: "https://g/files/abc", mimeType: "video/mp4", state: "ACTIVE" } };
      if (url.endsWith("/v1beta/files/abc")) return { status: 200, body: {} };
      return null;
    });
    v.setKey(KEY);
    const n = await v.watch({ file: clip, question: "What is the hook?" });
    expect(n).toMatchObject({ kind: "file", source: clip, question: "What is the hook?" });
    const gen = seen.find((s) => s.url.includes(":generateContent"))!;
    expect(gen.body.contents[0].parts[0].file_data).toEqual({ file_uri: "https://g/files/abc", mime_type: "video/mp4" });
    expect(seen[seen.length - 1]).toMatchObject({ method: "DELETE", url: expect.stringContaining("/v1beta/files/abc") });
    await expect(v.watch({ file: join(dir, "notes.txt") })).rejects.toThrow(/no file|not a video/);
  });
});

describe("the Watch folder", () => {
  it("watches a saved clip by itself, with the question from its .txt, and moves both to Watched", async () => {
    const home = tmp();
    const g = fakeGoogle((url, s) => {
      if (url.endsWith("/upload/v1beta/files")) return { status: 200, body: {}, headers: { "x-goog-upload-url": "https://upload.example/u1" } };
      if (url === "https://upload.example/u1") return { status: 200, body: { file: { name: "files/r1", uri: "https://g/files/r1", mimeType: "video/mp4", state: "ACTIVE" } } };
      if (url.endsWith("/v1beta/files/r1")) return { status: 200, body: {} };
      return null;
    });
    const v = new Videos(new EventLog(":memory:"), { homeDir: home, env: {}, fetch: g.f, pollMs: 1 });
    const dir = v.settings().inbox;
    expect(dir).toBe(join(home, "SoftwareFactory", "Watch"));
    const { mkdirSync, existsSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "reel.mp4"), Buffer.alloc(500));
    writeFileSync(join(dir, "reel.txt"), "What is the hook in the first 3 seconds?");
    writeFileSync(join(dir, "notes.md"), "not a video");
    expect(await v.scanInbox(Date.now() + 60_000)).toEqual({ watched: 0, failed: 0 }); // no key yet
    v.setKey(KEY);
    expect(v.status().waiting).toBe(1);
    expect(await v.scanInbox(Date.now())).toEqual({ watched: 0, failed: 0 }); // just saved: may still be syncing
    expect(await v.scanInbox(Date.now() + 60_000)).toEqual({ watched: 1, failed: 0 });
    expect(existsSync(join(dir, "Watched", "reel.mp4"))).toBe(true);
    expect(existsSync(join(dir, "Watched", "reel.txt"))).toBe(true);
    expect(existsSync(join(dir, "notes.md"))).toBe(true);
    expect(v.search("cargo")[0]).toMatchObject({ kind: "file", question: "What is the hook in the first 3 seconds?", by: "watch folder" });
  });

  it("also watches an \"SF Watch\" folder made in Google Drive, found by itself", async () => {
    const { mkdirSync } = await import("node:fs");
    const { cloudWatchFolders } = await import("../src/index.js");
    const home = tmp();
    expect(cloudWatchFolders(home, "linux")).toEqual([]);
    mkdirSync(join(home, "Google Drive", "My Drive", "SF Watch"), { recursive: true });
    expect(cloudWatchFolders(home, "linux")).toEqual([join(home, "Google Drive", "My Drive", "SF Watch")]);
    const v = new Videos(new EventLog(":memory:"), { homeDir: home, env: {} });
    expect(v.status().folders).toEqual([join(home, "SoftwareFactory", "Watch"), join(home, "Google Drive", "My Drive", "SF Watch")]);
  });

  it("finds an \"SF Watch\" folder one level down in Google Drive, like My Drive/Dev/SF Watch", async () => {
    const { mkdirSync } = await import("node:fs");
    const { cloudWatchFolders } = await import("../src/index.js");
    const home = tmp();
    mkdirSync(join(home, "Google Drive", "My Drive", "Dev", "SF Watch"), { recursive: true });
    mkdirSync(join(home, "Google Drive", "My Drive", "Other", "Deeper", "SF Watch"), { recursive: true });
    expect(cloudWatchFolders(home, "linux")).toEqual([join(home, "Google Drive", "My Drive", "Dev", "SF Watch")]);
  });

  it("does not try a failed clip again until the file changes", async () => {
    const home = tmp();
    const g = fakeGoogle(() => ({ status: 500, body: { error: { message: "boom" } } }));
    const v = new Videos(new EventLog(":memory:"), { homeDir: home, env: {}, fetch: g.f, pollMs: 1 });
    v.setKey(KEY);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(v.settings().inbox, { recursive: true });
    writeFileSync(join(v.settings().inbox, "bad.mov"), Buffer.alloc(10));
    expect(await v.scanInbox(Date.now() + 60_000)).toEqual({ watched: 0, failed: 1 });
    expect(await v.scanInbox(Date.now() + 60_000)).toEqual({ watched: 0, failed: 0 });
    expect(v.status().waiting).toBe(0);
  });

  it("tries a clip again later when Google was only busy, and falls back to the next model on high demand", async () => {
    const home = tmp();
    let busy = true;
    const models: string[] = [];
    const g = fakeGoogle((u: string) => {
      if (u.endsWith("/upload/v1beta/files")) return { status: 200, body: {}, headers: { "x-goog-upload-url": "https://upload.example/u9" } };
      if (u === "https://upload.example/u9") return { status: 200, body: { file: { name: "files/r9", uri: "https://g/files/r9", mimeType: "video/mp4", state: "ACTIVE" } } };
      const m = /models\/([^:]+):generateContent/.exec(u);
      if (m) models.push(decodeURIComponent(m[1]));
      return busy && m ? { status: 503, body: { error: { message: "This model is currently experiencing high demand" } } } : null;
    });
    const v = new Videos(new EventLog(":memory:"), { homeDir: home, env: {}, fetch: g.f, pollMs: 1 });
    v.setKey(KEY);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(v.settings().inbox, { recursive: true });
    writeFileSync(join(v.settings().inbox, "reel.mp4"), Buffer.alloc(10));
    const t0 = Date.now() + 60_000;
    expect(await v.scanInbox(t0)).toEqual({ watched: 0, failed: 1 });
    expect(new Set(models).size).toBeGreaterThan(1); // every model was asked before giving up for now
    expect(await v.scanInbox(t0 + 60_000)).toEqual({ watched: 0, failed: 0 }); // not yet: retried after 5 minutes
    busy = false;
    expect(await v.scanInbox(t0 + 6 * 60_000)).toEqual({ watched: 1, failed: 0 });
  });
});

describe("failures logged before retries existed", () => {
  it("tries a reel again that 0.2.385 put aside for a busy or overloaded Google, but not one Gemini refused", async () => {
    const home = tmp();
    const g = fakeGoogle((u: string) => {
      if (u.endsWith("/upload/v1beta/files")) return { status: 200, body: {}, headers: { "x-goog-upload-url": "https://upload.example/u8" } };
      if (u === "https://upload.example/u8") return { status: 200, body: { file: { name: "files/r8", uri: "https://g/files/r8", mimeType: "video/mp4", state: "ACTIVE" } } };
      return null;
    });
    const log = new EventLog(":memory:");
    const v = new Videos(log, { homeDir: home, env: {}, fetch: g.f, pollMs: 1 });
    v.setKey(KEY);
    const { mkdirSync, statSync } = await import("node:fs");
    mkdirSync(v.settings().inbox, { recursive: true });
    const stampOf = (p: string) => { const st = statSync(p); return `${st.size}:${Math.floor(st.mtimeMs)}`; };
    const ok = join(v.settings().inbox, "IG DeYBPkIsznm.mp4"), bad = join(v.settings().inbox, "bad.mp4");
    writeFileSync(ok, Buffer.alloc(10)); writeFileSync(bad, Buffer.alloc(11));
    log.append("video.failed", { source: ok, stamp: stampOf(ok), kind: "watch-folder", error: "2 videos are being watched already; wait for one to finish", by: "watch folder" });
    log.append("video.failed", { source: ok, stamp: stampOf(ok), kind: "watch-folder", error: "Google's service had a problem. Google said 503: This model is currently experiencing high demand", by: "watch folder" });
    log.append("video.failed", { source: bad, stamp: stampOf(bad), kind: "watch-folder", error: "Gemini would not watch it (SAFETY)", by: "watch folder" });
    expect(await v.scanInbox(Date.now() + 10 * 60_000)).toEqual({ watched: 1, failed: 0 });
  });
});

describe("longFetch (Gemini calls without Node's 5-minute first-byte limit)", () => {
  it("posts bytes and reads the answer, status and headers", async () => {
    const { createServer } = await import("node:http");
    const { longFetch } = await import("../src/video/gemini.js");
    const srv = createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { res.writeHead(201, { "x-goog-upload-url": "https://u/1", "content-type": "application/json" }); res.end(JSON.stringify({ got: b, method: req.method, key: req.headers["x-goog-api-key"] })); }); });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    try {
      const port = (srv.address() as { port: number }).port;
      const r = await longFetch(`http://127.0.0.1:${port}/v1beta/x`, { method: "POST", body: JSON.stringify({ a: 1 }), headers: { "x-goog-api-key": "k" } });
      expect(r.status).toBe(201);
      expect(r.headers.get("x-goog-upload-url")).toBe("https://u/1");
      expect(await r.json()).toEqual({ got: '{"a":1}', method: "POST", key: "k" });
      await expect(longFetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.abort() })).rejects.toBeTruthy();
    } finally { srv.close(); }
  });
});
