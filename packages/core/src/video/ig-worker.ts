/**
 * The Instagram mailbox: a tiny Cloudflare Worker (free, on your own Cloudflare account) that SoftwareFactory deploys
 * for you (docs/videos.md, "Instagram by DM").
 *
 * You share a reel by DM to a second Instagram account you own (a free professional account). Meta's official
 * Instagram Messaging API calls this Worker's /ig webhook with the shared reel's media link; the Worker checks Meta's
 * signature, fetches the video at once (the link expires) and keeps it for up to 14 days. SoftwareFactory, on your PC,
 * pulls what waits every minute (with a secret only it knows), drops it into the Watch folder and deletes it here.
 * Nothing on your PC is opened to the internet, and the reel arrives even while the PC is off.
 *
 *   GET  /ig?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…   Meta's one-time check
 *   POST /ig                                                         Meta's message events (signed with the app secret)
 *   GET  /pull                     (Bearer PULL_SECRET)               what waits: [{ key, title, type, sender, at, size }]
 *   GET  /pull/<key>  /  DELETE    (Bearer PULL_SECRET)               one video's bytes / forget it
 *   GET  /pull-log                 (Bearer PULL_SECRET)               the last events (received, skipped, failed), for help
 *
 * Bindings: KV (a KV namespace), VERIFY_TOKEN, APP_SECRET, PULL_SECRET (secrets).
 */
export const IG_WORKER_NAME = "sf-instagram";

export const IG_WORKER_JS = String.raw`
const HOSTS = /(^|\.)(fbsbx\.com|cdninstagram\.com|fbcdn\.net|instagram\.com)$/i;
const TYPES = new Set(["ig_reel", "reel", "video", "ig_post", "share"]);
const MAX = 24 * 1024 * 1024;
const text = (b, status = 200) => new Response(b, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function hmac(secret, body) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, body));
}
function same(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
async function note(env, what) {
  const at = new Date().toISOString();
  await env.KV.put("log:" + at + ":" + Math.random().toString(36).slice(2, 6), JSON.stringify({ at, ...what }), { expirationTtl: 3 * 86400 });
}
async function keep(env, a, m, i) {
  const p = a.payload || {};
  let host = "";
  try { host = new URL(p.url).hostname; } catch {}
  if (!HOSTS.test(host)) return note(env, { event: "skipped", why: "not an Instagram media link", type: a.type });
  const id = String(p.reel_video_id || p.ig_post_media_id || (m.message.mid || "m") + "-" + i).replace(/[^A-Za-z0-9_-]/g, "").slice(-60);
  const key = "v:" + id;
  if (await env.KV.get(key, { type: "stream" }) !== null) return note(env, { event: "skipped", why: "already waiting", key });
  const r = await fetch(p.url, { redirect: "follow" });
  const type = r.headers.get("content-type") || "";
  if (!r.ok) return note(env, { event: "failed", why: "Instagram answered " + r.status, key });
  if (!type.startsWith("video/")) return note(env, { event: "skipped", why: "not a video (" + type.slice(0, 40) + "), a photo post?", key });
  const buf = await r.arrayBuffer();
  if (buf.byteLength > MAX) return note(env, { event: "skipped", why: "larger than 24 MB", key });
  const meta = { title: String(p.title || "").slice(0, 300), type: a.type, sender: String(m.sender && m.sender.id || ""), at: new Date().toISOString(), size: buf.byteLength, mime: type.split(";")[0] };
  await env.KV.put(key, buf, { metadata: meta, expirationTtl: 14 * 86400 });
  return note(env, { event: "received", key, title: meta.title.slice(0, 80), type: a.type });
}
export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url);
    if (u.pathname === "/ig" && req.method === "GET") {
      const ok = u.searchParams.get("hub.mode") === "subscribe" && env.VERIFY_TOKEN && u.searchParams.get("hub.verify_token") === env.VERIFY_TOKEN;
      return ok ? text(u.searchParams.get("hub.challenge") || "") : text("forbidden", 403);
    }
    if (u.pathname === "/ig" && req.method === "POST") {
      const raw = await req.arrayBuffer();
      if (!env.APP_SECRET) return text("the Meta app secret is not set yet", 503);
      const sig = (req.headers.get("x-hub-signature-256") || "").replace(/^sha256=/, "");
      if (!sig || !same(sig, await hmac(env.APP_SECRET, raw))) return text("bad signature", 401);
      let body;
      try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { return text("bad json", 400); }
      const jobs = [];
      for (const e of body.entry || []) for (const m of e.messaging || []) {
        if (!m.message || m.message.is_echo) continue;
        (m.message.attachments || []).forEach((a, i) => { if (TYPES.has(a.type) && a.payload && a.payload.url) jobs.push(keep(env, a, m, i).catch((err) => note(env, { event: "failed", why: String(err && err.message || err).slice(0, 200) }))); });
      }
      ctx.waitUntil(Promise.all(jobs));
      return text("EVENT_RECEIVED");
    }
    if (u.pathname === "/pull" || u.pathname.startsWith("/pull/") || u.pathname === "/pull-log") {
      const auth = req.headers.get("authorization") || "";
      if (!env.PULL_SECRET || !same(auth, "Bearer " + env.PULL_SECRET)) return text("forbidden", 403);
      if (u.pathname === "/pull-log") {
        const l = await env.KV.list({ prefix: "log:", limit: 1000 });
        const keys = l.keys.slice(-30);
        return json(await Promise.all(keys.map(async (k) => JSON.parse(await env.KV.get(k.name) || "{}"))));
      }
      if (u.pathname === "/pull") {
        const l = await env.KV.list({ prefix: "v:", limit: 100 });
        return json(l.keys.map((k) => ({ key: k.name, ...(k.metadata || {}) })));
      }
      const key = decodeURIComponent(u.pathname.slice(6));
      if (!key.startsWith("v:")) return text("not found", 404);
      if (req.method === "DELETE") { await env.KV.delete(key); return text("deleted"); }
      const v = await env.KV.getWithMetadata(key, { type: "arrayBuffer" });
      if (v.value === null) return text("not found", 404);
      return new Response(v.value, { headers: { "content-type": (v.metadata && v.metadata.mime) || "video/mp4" } });
    }
    return text("SoftwareFactory's Instagram mailbox", 404);
  },
};
`;
