import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, Videos, IG_WORKER_JS } from "../src/index.js";

/** Instagram by DM (docs/videos.md): the mailbox Worker, its deployment, and the pull into the Watch folder. */
const tmp = () => mkdtempSync(join(tmpdir(), "sf-ig-"));
const APP_SECRET = "0123456789abcdef0123456789abcdef";

/** An in-memory stand-in for Cloudflare KV. */
function fakeKv() {
  const m = new Map<string, { value: ArrayBuffer | string; metadata?: unknown }>();
  return {
    m,
    async put(k: string, value: ArrayBuffer | string, o: { metadata?: unknown } = {}) { m.set(k, { value, metadata: o.metadata }); },
    async get(k: string) { const v = m.get(k); return v ? (typeof v.value === "string" ? v.value : new Uint8Array(v.value)) : null; },
    async getWithMetadata(k: string) { const v = m.get(k); return v ? { value: v.value, metadata: v.metadata } : { value: null, metadata: null }; },
    async delete(k: string) { m.delete(k); },
    async list({ prefix }: { prefix: string }) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name, metadata: m.get(name)!.metadata })) }; },
  };
}

async function loadWorker() {
  const mod = await import(`data:text/javascript;base64,${Buffer.from(IG_WORKER_JS).toString("base64")}`);
  return mod.default as { fetch: (req: Request, env: any, ctx: any) => Promise<Response> };
}

const reelEvent = (url = "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1&signature=x") => ({
  object: "instagram",
  entry: [{ id: "1784", time: 1, messaging: [{ sender: { id: "555" }, recipient: { id: "1784" }, timestamp: 1, message: { mid: "aWdfZAm1", attachments: [{ type: "ig_reel", payload: { url, title: "70 saved reels into skills", reel_video_id: "1801234" } }] } }] }],
});

describe("the Instagram mailbox (Cloudflare Worker)", () => {
  it("answers Meta's check, keeps a signed reel's video, refuses unsigned events, and hands it over only with the pull secret", async () => {
    const worker = await loadWorker();
    const KV = fakeKv();
    const env = { KV, VERIFY_TOKEN: "sf-verify", APP_SECRET, PULL_SECRET: "pull-secret" };
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) };
    const realFetch = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = (async (u: string) => { fetched.push(String(u)); return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": "video/mp4" } }); }) as typeof fetch;
    try {
      const ok = await worker.fetch(new Request("https://w.dev/ig?hub.mode=subscribe&hub.verify_token=sf-verify&hub.challenge=42"), env, ctx);
      expect(await ok.text()).toBe("42");
      expect((await worker.fetch(new Request("https://w.dev/ig?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42"), env, ctx)).status).toBe(403);

      const body = JSON.stringify(reelEvent());
      const unsigned = await worker.fetch(new Request("https://w.dev/ig", { method: "POST", body }), env, ctx);
      expect(unsigned.status).toBe(401);
      const forged = await worker.fetch(new Request("https://w.dev/ig", { method: "POST", body, headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", "wrong").update(body).digest("hex")}` } }), env, ctx);
      expect(forged.status).toBe(401);

      const sig = `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`;
      const r = await worker.fetch(new Request("https://w.dev/ig", { method: "POST", body, headers: { "x-hub-signature-256": sig } }), env, ctx);
      expect(r.status).toBe(200);
      await Promise.all(waits);
      expect(fetched).toEqual(["https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1&signature=x"]);

      expect((await worker.fetch(new Request("https://w.dev/pull"), env, ctx)).status).toBe(403);
      const auth = { authorization: "Bearer pull-secret" };
      const list = await (await worker.fetch(new Request("https://w.dev/pull", { headers: auth }), env, ctx)).json() as any[];
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ key: "v:1801234", title: "70 saved reels into skills", type: "ig_reel", sender: "555", size: 4, mime: "video/mp4" });
      const bytes = new Uint8Array(await (await worker.fetch(new Request("https://w.dev/pull/v%3A1801234", { headers: auth }), env, ctx)).arrayBuffer());
      expect([...bytes]).toEqual([1, 2, 3, 4]);
      await worker.fetch(new Request("https://w.dev/pull/v%3A1801234", { method: "DELETE", headers: auth }), env, ctx);
      expect(await (await worker.fetch(new Request("https://w.dev/pull", { headers: auth }), env, ctx)).json()).toEqual([]);
      const log = await (await worker.fetch(new Request("https://w.dev/pull-log", { headers: auth }), env, ctx)).json() as any[];
      expect(log.map((l) => l.event)).toContain("received");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("never fetches a link that is not Instagram's own media", async () => {
    const worker = await loadWorker();
    const KV = fakeKv();
    const env = { KV, VERIFY_TOKEN: "v", APP_SECRET, PULL_SECRET: "p" };
    const waits: Promise<unknown>[] = [];
    const realFetch = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (async () => { called++; return new Response("x"); }) as unknown as typeof fetch;
    try {
      const body = JSON.stringify(reelEvent("http://169.254.169.254/latest/meta-data"));
      const sig = `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`;
      await worker.fetch(new Request("https://w.dev/ig", { method: "POST", body, headers: { "x-hub-signature-256": sig } }), env, { waitUntil: (p: Promise<unknown>) => waits.push(p) });
      await Promise.all(waits);
      expect(called).toBe(0);
      expect([...KV.m.keys()].filter((k) => k.startsWith("v:"))).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("Instagram by DM in SoftwareFactory", () => {
  it("deploys the mailbox with your Cloudflare token, keeps the secrets in the .env file only, and pulls reels into the Watch folder", async () => {
    const home = tmp();
    const calls: { method: string; url: string; body: any }[] = [];
    const worker = await loadWorker();
    const KV = fakeKv();
    await KV.put("v:1801234", new Uint8Array([9, 9, 9]).buffer, { metadata: { title: "70 saved reels: skills?", mime: "video/mp4" } });
    let workerEnv: any = null;
    const f = (async (url: string, init: RequestInit = {}) => {
      const method = String(init.method ?? "GET");
      const u = String(url);
      if (u.startsWith("https://cf.test")) {
        let body: any = init.body;
        if (body instanceof FormData) {
          const meta = JSON.parse(await (body.get("metadata") as Blob).text());
          workerEnv = { KV, ...Object.fromEntries(meta.bindings.filter((b: any) => b.type === "secret_text").map((b: any) => [b.name, b.text])) };
          body = { bindings: meta.bindings.map((b: any) => b.name), main: meta.main_module, script: (body.get("worker.js") as Blob).size };
        } else if (typeof body === "string") body = JSON.parse(body);
        calls.push({ method, url: u.slice("https://cf.test".length), body });
        const path = u.slice("https://cf.test".length);
        const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result }));
        if (path.startsWith("/accounts?")) return ok([{ id: "acc1" }]);
        if (path.includes("/storage/kv/namespaces") && method === "GET") return ok([]);
        if (path.includes("/storage/kv/namespaces") && method === "POST") return ok({ id: "ns1" });
        if (path.endsWith("/workers/subdomain") && method === "GET") return ok({ subdomain: "assaf" });
        return ok({});
      }
      // The deployed Worker itself, at its workers.dev address.
      return worker.fetch(new Request(u, { method, headers: init.headers as HeadersInit }), workerEnv, { waitUntil: () => {} });
    }) as unknown as typeof fetch;
    const v = new Videos(new EventLog(":memory:"), { homeDir: home, env: {}, fetch: f, cloudFolders: () => [] });
    (v.instagram as any).o.api = "https://cf.test";

    await expect(v.instagram.setup({})).rejects.toThrow(/Cloudflare API token/);
    await expect(v.instagram.setup({ cloudflareToken: "abcDEF0123456789abcDEF0123456789abcdef", appSecret: "nope" })).rejects.toThrow(/Meta app secret/);
    const st = await v.instagram.setup({ cloudflareToken: "abcDEF0123456789abcDEF0123456789abcdef", appSecret: APP_SECRET });
    expect(st.ready).toBe(true);
    expect(st.webhookUrl).toBe("https://sf-instagram.assaf.workers.dev/ig");
    expect(st.verifyToken).toMatch(/^sf-[a-f0-9]{24}$/);
    expect(JSON.stringify(st)).not.toContain("abcDEF0123456789");
    expect(JSON.stringify(st)).not.toContain(APP_SECRET);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /accounts?per_page=5", "GET /accounts/acc1/storage/kv/namespaces?per_page=100", "POST /accounts/acc1/storage/kv/namespaces",
      "PUT /accounts/acc1/workers/scripts/sf-instagram", "GET /accounts/acc1/workers/subdomain", "POST /accounts/acc1/workers/scripts/sf-instagram/subdomain",
    ]);
    expect(calls[3].body).toMatchObject({ bindings: ["KV", "PULL_SECRET", "VERIFY_TOKEN", "APP_SECRET"], main: "worker.js" });
    const envText = readFileSync(join(home, ".config", "watch", ".env"), "utf8");
    expect(envText).toContain(`SF_IG_APP_SECRET=${APP_SECRET}`);
    expect(envText).toContain("SF_IG_URL=https://sf-instagram.assaf.workers.dev");
    // Nothing secret goes into the event log.
    const logged = JSON.stringify((v as any).log.db.prepare("SELECT payload FROM events").all());
    expect(logged).not.toContain(APP_SECRET);
    expect(logged).not.toContain("abcDEF0123456789");

    expect(await v.instagram.pull()).toBe(1);
    const inbox = join(home, "SoftwareFactory", "Watch");
    expect(readdirSync(inbox)).toEqual(["IG 70 saved reels skills 1801234.mp4"]);
    expect([...readFileSync(join(inbox, "IG 70 saved reels skills 1801234.mp4"))]).toEqual([9, 9, 9]);
    expect([...KV.m.keys()].filter((k) => k.startsWith("v:"))).toEqual([]);
    expect(v.instagram.status().lastPull).toMatchObject({ got: 1, error: null });

    // Updating keeps the secrets made the first time, so the address and Meta's verify token stay the same.
    const again = await v.instagram.setup({});
    expect(again.verifyToken).toBe(st.verifyToken);
    expect(v.instagram.forget().ready).toBe(false);
  });
});
