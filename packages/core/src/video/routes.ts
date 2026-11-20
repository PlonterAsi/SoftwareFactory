import type { IncomingMessage } from "node:http";
import type { Videos } from "./videos.js";

/**
 * Videos (docs/videos.md).
 *
 *   GET  /api/videos                       key set?, settings, watched today, notes kept
 *   POST /api/videos/key                   { key }  saves it in ~/.config/watch/.env (shared with /watch); { key: null } removes it
 *   POST /api/videos/settings              { dailyMax?, models? }
 *   POST /api/videos/watch                 { url | file, question?, start?, end?, fps?, refresh? }  → the notes
 *   GET  /api/videos/notes?q=&limit=       notes found by words, or the newest
 *   GET  /api/videos/notes/:id             one note in full
 *   GET  /api/videos/instagram             Instagram by DM: mailbox ready?, what to paste into Meta, last pull
 *   POST /api/videos/instagram             { cloudflareToken?, appSecret? }  deploys or updates the mailbox
 *   POST /api/videos/instagram/forget      forget the mailbox here
 *   POST /api/videos/instagram/pull        pull what waits now
 *   GET  /api/videos/instagram/events      the mailbox's last events
 */
export async function videosRoute(ctx: { videos: Videos; readJson: (req: IncomingMessage) => Promise<Record<string, unknown>> }, req: IncomingMessage, url: URL): Promise<[number, unknown] | null> {
  const { videos } = ctx;
  const path = url.pathname;
  try {
    if (req.method === "GET" && path === "/api/videos") return [200, videos.status()];
    if (req.method === "POST" && path === "/api/videos/key") {
      const b = await ctx.readJson(req);
      return [200, videos.setKey(typeof b.key === "string" && b.key.trim() ? b.key : null)];
    }
    if (req.method === "POST" && path === "/api/videos/settings") return [200, videos.setSettings(await ctx.readJson(req))];
    if (req.method === "POST" && path === "/api/videos/watch") {
      const b = await ctx.readJson(req);
      return [200, await videos.watch({
        url: b.url == null ? undefined : String(b.url), file: b.file == null ? undefined : String(b.file), question: b.question == null ? null : String(b.question),
        start: b.start as number, end: b.end as number, fps: b.fps as number, refresh: b.refresh === true,
      })];
    }
    if (path === "/api/videos/instagram" && req.method === "GET") return [200, videos.instagram.status()];
    if (path === "/api/videos/instagram" && req.method === "POST") return [200, await videos.instagram.setup(await ctx.readJson(req))];
    if (path === "/api/videos/instagram/forget" && req.method === "POST") return [200, videos.instagram.forget()];
    if (path === "/api/videos/instagram/pull" && req.method === "POST") { const got = await videos.instagram.pull(); return [200, { got, ...videos.instagram.status() }]; }
    if (path === "/api/videos/instagram/events" && req.method === "GET") return [200, { events: await videos.instagram.events() }];
    if (req.method === "GET" && path === "/api/videos/notes") return [200, { notes: videos.search(url.searchParams.get("q"), Number(url.searchParams.get("limit")) || 20) }];
    const one = path.match(/^\/api\/videos\/notes\/(\d+)$/);
    if (req.method === "GET" && one) {
      const n = videos.get(Number(one[1]));
      return n ? [200, n] : [404, { error: `No video note ${one[1]}` }];
    }
  } catch (e) {
    return [400, { error: (e as Error).message }];
  }
  return null;
}
