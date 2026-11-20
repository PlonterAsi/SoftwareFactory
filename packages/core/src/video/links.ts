import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Link drop (docs/videos.md): a reel or clip link you save into the Watch folder (a .txt or .url file, from the phone
 * or the PC) is fetched here and saved beside it as a video, then watched like any saved clip.
 *
 * Instagram, TikTok and X forbid automated downloading in their terms; this is your choice, made knowingly
 * (2026-11-20), for links you saved yourself, one at a time. It never uses your login: no cookies and no accounts,
 * only what anyone logged out can see. Two ways, in order:
 *   1. Scrape Creators (scrapecreators.com), a paid API with 100 free calls, when its key is in ~/.config/watch/.env
 *      as SCRAPECREATORS_API_KEY: it returns the post's video address and caption (1 credit a link).
 *   2. yt-dlp, when it is installed, run logged out (--no-cookies, --ignore-config) and only for these hosts.
 */
export const LINK_HOSTS = /^https?:\/\/(?:[a-z0-9-]+\.)*(?:instagram\.com|tiktok\.com|x\.com|twitter\.com|facebook\.com|fb\.watch|threads\.net)\//i;
const LINK_IN_TEXT = /https?:\/\/[^\s"'<>]+/gi;

/** The links in a dropped text or .url file, and the rest of its words (the question, when there is one). */
export function linksIn(text: string): { links: string[]; rest: string } {
  const links: string[] = [];
  const rest = String(text).replace(/^\s*\[InternetShortcut\]\s*$/gim, "").replace(/^\s*URL=/gim, "").replace(LINK_IN_TEXT, (m) => {
    const u = m.replace(/[),.;!?]+$/, "");
    if (LINK_HOSTS.test(u) && !links.includes(u)) links.push(u);
    return " ";
  }).replace(/\s+/g, " ").trim();
  return { links, rest };
}

/** Run a program without a shell; resolves with its exit code and output. */
export type Runner = (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;
const run: Runner = (cmd, args, timeoutMs) => new Promise((done) => {
  execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -1) : 0;
    done({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? (err as Error | null)?.message ?? "") });
  });
});

export interface Fetched { path: string; via: "scrapecreators" | "yt-dlp"; caption: string | null }

const pick = (o: unknown, paths: string[][]): string | null => {
  for (const p of paths) {
    let v: unknown = o;
    for (const k of p) v = v == null ? v : (v as Record<string, unknown>)[k];
    if (typeof v === "string" && /^https?:\/\//.test(v)) return v;
    if (Array.isArray(v) && typeof v[0] === "string" && /^https?:\/\//.test(v[0])) return v[0];
  }
  return null;
};

export class LinkFetcher {
  private ytdlp: boolean | null = null;
  constructor(private o: { key: () => string | null; fetch?: typeof fetch; run?: Runner; api?: string }) {}
  private get f() { return this.o.fetch ?? fetch; }
  private get r() { return this.o.run ?? run; }

  /** Is yt-dlp installed (asked once)? */
  async hasYtDlp(): Promise<boolean> {
    if (this.ytdlp == null) this.ytdlp = (await this.r("yt-dlp", ["--version"], 15_000).catch(() => ({ code: -1 }))).code === 0;
    return this.ytdlp;
  }

  /** Fetch one link into dir as `${base}.mp4`. Throws with the reason when neither way can. */
  async fetchTo(url: string, dir: string, base: string): Promise<Fetched> {
    if (!LINK_HOSTS.test(url)) throw new Error("Only Instagram, TikTok, X, Facebook and Threads links are fetched");
    const why: string[] = [];
    const key = this.o.key();
    if (key && /instagram\.com|tiktok\.com/i.test(url)) {
      try { return await this.viaScrapeCreators(url, key, dir, base); } catch (e) { why.push(`Scrape Creators: ${(e as Error).message}`); }
    } else if (!key) why.push("no Scrape Creators key");
    if (await this.hasYtDlp()) {
      const out = join(dir, `${base}.%(ext)s`);
      const r = await this.r("yt-dlp", ["--ignore-config", "--no-cookies", "--no-cookies-from-browser", "--no-playlist", "--no-progress", "--max-filesize", "200M",
        "-f", "mp4/bestvideo*+bestaudio/best", "--merge-output-format", "mp4", "--print", "after_move:filepath", "-o", out, "--", url], 180_000);
      const path = r.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
      if (r.code === 0 && path) return { path, via: "yt-dlp", caption: null };
      why.push(`yt-dlp: ${(r.stderr.trim().split(/\r?\n/).filter((l) => /ERROR/i.test(l)).pop() ?? r.stderr.trim().slice(-200)) || `exit ${r.code}`}`);
    } else why.push("yt-dlp is not installed");
    throw new Error(`Could not fetch ${url} (${why.join("; ")})`);
  }

  private async viaScrapeCreators(url: string, key: string, dir: string, base: string): Promise<Fetched> {
    const api = this.o.api ?? "https://api.scrapecreators.com";
    const ig = /instagram\.com/i.test(url);
    const r = await this.f(`${api}${ig ? "/v1/instagram/post" : "/v2/tiktok/video"}?url=${encodeURIComponent(url)}`, { headers: { "x-api-key": key } });
    const j = await r.json().catch(() => ({})) as Record<string, any>;
    if (!r.ok || j.success === false) throw new Error(String(j.message ?? j.error ?? `answered ${r.status}`).slice(0, 200));
    const video = ig
      ? pick(j, [["data", "xdt_shortcode_media", "video_url"], ["data", "video_url"], ["video_url"]])
      : pick(j, [["aweme_detail", "video", "download_no_watermark_addr", "url_list"], ["aweme_detail", "video", "play_addr", "url_list"], ["aweme_detail", "video", "download_addr", "url_list"]]);
    if (!video) throw new Error(ig ? "the post has no video (a photo post?)" : "no video address in the answer");
    const caption = ig ? j?.data?.xdt_shortcode_media?.edge_media_to_caption?.edges?.[0]?.node?.text ?? null : j?.aweme_detail?.desc ?? null;
    const v = await this.f(video);
    const type = v.headers.get("content-type") ?? "";
    if (!v.ok) throw new Error(`the video answered ${v.status}`);
    if (type && !/^video\/|octet-stream/.test(type)) throw new Error(`the address gave ${type.slice(0, 40)}, not a video`);
    const buf = Buffer.from(await v.arrayBuffer());
    if (buf.length > 200 * 1024 * 1024) throw new Error("the video is larger than 200 MB");
    const path = join(dir, `${base}.mp4`);
    writeFileSync(path, buf);
    return { path, via: "scrapecreators", caption: typeof caption === "string" ? caption.slice(0, 2000) : null };
  }
}
