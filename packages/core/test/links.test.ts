import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, Videos, linksIn, linkBase } from "../src/index.js";

/** Link drop (docs/videos.md): a reel link saved in the Watch folder is fetched logged out and watched. */
const tmp = () => mkdtempSync(join(tmpdir(), "sf-links-"));
const KEY = "AIzaSyTESTKEY000000000000000000000000000";
const old = (p: string) => { const t = new Date(Date.now() - 60_000); utimesSync(p, t, t); };

function world(o: { scrape?: boolean; ytdlp?: boolean } = {}) {
  const home = tmp();
  const inbox = join(home, "SoftwareFactory", "Watch");
  mkdirSync(inbox, { recursive: true });
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const runs: string[][] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const u = String(url);
    calls.push({ url: u, headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])) });
    if (u.startsWith("https://api.scrapecreators.com/v1/instagram/post")) return new Response(JSON.stringify({ success: true, credits_charged: 1, data: { xdt_shortcode_media: { video_url: "https://scontent.cdninstagram.com/v/reel.mp4?sig=1", edge_media_to_caption: { edges: [{ node: { text: "70 saved reels into skills" } }] } } } }));
    if (u.startsWith("https://scontent.cdninstagram.com/")) return new Response(new Uint8Array([7, 7, 7]), { headers: { "content-type": "video/mp4" } });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "TITLE: Doomscroll\\n0:06 It's called Doomscroll." }] } }], usageMetadata: { promptTokenCount: 3600, candidatesTokenCount: 900 } }));
  }) as unknown as typeof fetch;
  const run = async (cmd: string, args: string[]) => {
    runs.push([cmd, ...args]);
    if (!o.ytdlp) return { code: -1, stdout: "", stderr: "not found" };
    if (args[0] === "--version") return { code: 0, stdout: "2026.10.01", stderr: "" };
    const out = args[args.indexOf("-o") + 1].replace("%(ext)s", "mp4");
    writeFileSync(out, Buffer.from([5, 5]));
    return { code: 0, stdout: `${out}\n`, stderr: "" };
  };
  const v = new Videos(new EventLog(":memory:"), { homeDir: home, env: o.scrape ? { SCRAPECREATORS_API_KEY: "sc_test_key_0123456789" } : {}, fetch: f, pollMs: 1, cloudFolders: () => [], run });
  v.setKey(KEY);
  return { v, home, inbox, calls, runs };
}

describe("link drop", () => {
  it("reads the links in a dropped .txt or .url file, and keeps the rest as the question", () => {
    expect(linksIn("https://www.instagram.com/reel/DF5s0duxDts/?igsh=abc\nWhat tools do they use?")).toEqual({ links: ["https://www.instagram.com/reel/DF5s0duxDts/?igsh=abc"], rest: "What tools do they use?" });
    expect(linksIn("[InternetShortcut]\nURL=https://www.tiktok.com/@a/video/7463250363559218474").links).toEqual(["https://www.tiktok.com/@a/video/7463250363559218474"]);
    expect(linksIn("see https://example.com/x and https://vimeo.com/1").links).toEqual([]);
    expect(linkBase("https://www.instagram.com/reel/DF5s0duxDts/?igsh=abc")).toBe("IG DF5s0duxDts");
  });

  it("fetches a dropped Instagram link with Scrape Creators, then it is watched like a saved clip and the link file moves to Watched", async () => {
    const { v, inbox, calls, runs } = world({ scrape: true });
    const drop = join(inbox, "reel.txt");
    writeFileSync(drop, "https://www.instagram.com/reel/DF5s0duxDts/?igsh=abc");
    old(drop);
    expect(await v.scanLinks()).toBe(1);
    expect(calls[0].url).toBe("https://api.scrapecreators.com/v1/instagram/post?url=https%3A%2F%2Fwww.instagram.com%2Freel%2FDF5s0duxDts%2F%3Figsh%3Dabc");
    expect(calls[0].headers["x-api-key"]).toBe("sc_test_key_0123456789");
    expect(calls[0].headers.cookie).toBeUndefined();
    expect(runs.filter((r) => r[1] !== "--version")).toEqual([]);
    expect(readFileSync(join(inbox, "IG DF5s0duxDts.mp4"))).toEqual(Buffer.from([7, 7, 7]));
    expect(existsSync(drop)).toBe(false);
    expect(readdirSync(join(inbox, "Watched"))).toEqual(["reel.txt"]);
    // The same link dropped again is not fetched (or paid for) twice.
    writeFileSync(join(inbox, "again.txt"), "https://www.instagram.com/reel/DF5s0duxDts/?igsh=abc");
    old(join(inbox, "again.txt"));
    expect(await v.scanLinks()).toBe(0);
    expect(calls.filter((c) => c.url.includes("scrapecreators"))).toHaveLength(1);
    expect(v.linkLog()[0]).toMatchObject({ ok: true, via: "scrapecreators" });
  });

  it("falls back to yt-dlp run logged out, and a question beside the link becomes the video's question file", async () => {
    const { v, inbox, runs } = world({ ytdlp: true });
    writeFileSync(join(inbox, "tt.txt"), "https://www.tiktok.com/@a/video/7463250363559218474\nWhich editor do they use?");
    old(join(inbox, "tt.txt"));
    expect(await v.scanLinks()).toBe(1);
    const dl = runs.find((r) => r.includes("--no-cookies"))!;
    expect(dl).toEqual(expect.arrayContaining(["--ignore-config", "--no-cookies", "--no-cookies-from-browser", "--", "https://www.tiktok.com/@a/video/7463250363559218474"]));
    expect(dl.some((a) => /cookies-from-browser$/.test(a) && a !== "--no-cookies-from-browser")).toBe(false);
    expect(readFileSync(join(inbox, "TikTok 7463250363559218474.txt"), "utf8")).toBe("Which editor do they use?");
    expect(existsSync(join(inbox, "tt.txt"))).toBe(true); // it holds a question too, so it stays
  });

  it("a link that cannot be fetched is logged with the reason and not tried again until the file changes", async () => {
    const { v, inbox } = world({});
    writeFileSync(join(inbox, "x.txt"), "https://x.com/someone/status/1890000000000000000");
    old(join(inbox, "x.txt"));
    expect(await v.scanLinks()).toBe(0);
    expect(v.linkLog()[0]).toMatchObject({ ok: false });
    expect(v.linkLog()[0].error).toMatch(/yt-dlp is not installed/);
    await v.scanLinks();
    expect(v.linkLog()).toHaveLength(1);
  });

  it("the watch box takes an Instagram link too: fetched into Watched/, then watched once", async () => {
    const { v, inbox } = world({ scrape: true });
    // The fake Google here does not take uploads, so the watch itself fails after the fetch; the fetch is what is checked.
    await v.watch({ url: "https://www.instagram.com/reel/DF5s0duxDts/" }).catch(() => null);
    expect(readFileSync(join(inbox, "Watched", "IG DF5s0duxDts.mp4"))).toEqual(Buffer.from([7, 7, 7]));
    expect(v.linkLog()[0]).toMatchObject({ ok: true, via: "scrapecreators" });
    expect(readdirSync(inbox).filter((n) => n.endsWith(".mp4"))).toEqual([]);
  });
});
