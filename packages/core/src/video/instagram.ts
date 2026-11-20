import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IG_WORKER_JS, IG_WORKER_NAME } from "./ig-worker.js";

/**
 * Instagram by DM (docs/videos.md). Share a reel by DM to a second Instagram account you own; Meta's official
 * Messaging API hands the reel's video to SoftwareFactory's mailbox, a small Cloudflare Worker on your free Cloudflare
 * account (ig-worker.ts). This side deploys that Worker with your Cloudflare API token and pulls what waits into the
 * Watch folder every minute, where it is watched like any saved clip. No scraping and nothing downloaded by hand:
 * the video comes from Instagram's own API, for a reel you sent yourself.
 *
 * Kept in ~/.config/watch/.env (mode 600, never logged or sent to the screen): SF_IG_CF_TOKEN (Cloudflare API token),
 * SF_IG_APP_SECRET (the Meta app's secret), SF_IG_PULL_SECRET (made here), SF_IG_VERIFY_TOKEN (made here; you paste it
 * into Meta), SF_IG_URL (the Worker's address).
 */
export interface InstagramStatus {
  /** The mailbox is deployed and SoftwareFactory pulls from it. */
  ready: boolean;
  /** What to paste into Meta: the webhook's callback URL and verify token. */
  webhookUrl: string | null;
  verifyToken: string | null;
  hasCloudflareToken: boolean;
  hasAppSecret: boolean;
  lastPull: { at: string; got: number; error: string | null } | null;
}

export interface IgEnv { get: () => Record<string, string>; set: (kv: Record<string, string | null>) => void }

const CF = "https://api.cloudflare.com/client/v4";
const TOKEN_RE = /^[A-Za-z0-9_\-]{30,200}$/;
const SECRET_RE = /^[a-f0-9]{32}$/i;

export class InstagramInbox {
  private last: InstagramStatus["lastPull"] = null;
  private pulling = false;
  constructor(private o: { env: IgEnv; inbox: () => string; fetch?: typeof fetch; api?: string }) {}
  private get f() { return this.o.fetch ?? fetch; }

  status(): InstagramStatus {
    const e = this.o.env.get();
    const url = e.SF_IG_URL || null;
    return {
      ready: !!(url && e.SF_IG_PULL_SECRET), webhookUrl: url ? `${url}/ig` : null, verifyToken: e.SF_IG_VERIFY_TOKEN || null,
      hasCloudflareToken: !!e.SF_IG_CF_TOKEN, hasAppSecret: !!e.SF_IG_APP_SECRET, lastPull: this.last,
    };
  }

  private async cf<T = any>(token: string, method: string, path: string, body?: unknown): Promise<T> {
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    const r = await this.f(`${this.o.api ?? CF}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, ...(body && !isForm ? { "content-type": "application/json" } : {}) },
      body: body == null ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({})) as { success?: boolean; result?: T; errors?: { code?: number; message?: string }[] };
    if (!r.ok || j.success === false) {
      const err = j.errors?.[0];
      const msg = err?.message ?? `Cloudflare answered ${r.status}`;
      const e = new Error(r.status === 401 || r.status === 403 || err?.code === 10000
        ? `Cloudflare refused the token (${msg}). Make it from the "Edit Cloudflare Workers" template.` : `Cloudflare: ${msg}`) as Error & { code?: number; status?: number };
      e.code = err?.code; e.status = r.status;
      throw e;
    }
    return j.result as T;
  }

  /**
   * Set up or update the mailbox. Your Cloudflare token (once) and the Meta app's secret (when you have it) are saved;
   * the pull secret and verify token are made here. Deploys the Worker, its storage and its workers.dev address.
   */
  async setup(b: { cloudflareToken?: unknown; appSecret?: unknown }): Promise<InstagramStatus> {
    const e = this.o.env.get();
    const token = typeof b.cloudflareToken === "string" && b.cloudflareToken.trim() ? b.cloudflareToken.trim() : e.SF_IG_CF_TOKEN;
    const appSecret = typeof b.appSecret === "string" && b.appSecret.trim() ? b.appSecret.trim() : e.SF_IG_APP_SECRET || "";
    if (!token) throw new Error("Paste a Cloudflare API token first (dash.cloudflare.com, My Profile, API Tokens, \"Edit Cloudflare Workers\" template)");
    if (!TOKEN_RE.test(token)) throw new Error("That does not look like a Cloudflare API token");
    if (appSecret && !SECRET_RE.test(appSecret)) throw new Error("That does not look like a Meta app secret (32 letters and digits, from App settings, Basic)");
    const pull = e.SF_IG_PULL_SECRET || randomBytes(24).toString("hex");
    const verify = e.SF_IG_VERIFY_TOKEN || `sf-${randomBytes(12).toString("hex")}`;

    const accounts = await this.cf<{ id: string }[]>(token, "GET", "/accounts?per_page=5");
    const account = accounts?.[0]?.id;
    if (!account) throw new Error("This Cloudflare token sees no account");
    const spaces = await this.cf<{ id: string; title: string }[]>(token, "GET", `/accounts/${account}/storage/kv/namespaces?per_page=100`);
    const ns = spaces.find((s) => s.title === IG_WORKER_NAME)?.id ?? (await this.cf<{ id: string }>(token, "POST", `/accounts/${account}/storage/kv/namespaces`, { title: IG_WORKER_NAME })).id;

    const form = new FormData();
    const bindings = [
      { type: "kv_namespace", name: "KV", namespace_id: ns },
      { type: "secret_text", name: "PULL_SECRET", text: pull },
      { type: "secret_text", name: "VERIFY_TOKEN", text: verify },
      ...(appSecret ? [{ type: "secret_text", name: "APP_SECRET", text: appSecret }] : []),
    ];
    form.append("metadata", new Blob([JSON.stringify({ main_module: "worker.js", compatibility_date: "2025-06-01", bindings })], { type: "application/json" }));
    form.append("worker.js", new Blob([IG_WORKER_JS], { type: "application/javascript+module" }), "worker.js");
    await this.cf(token, "PUT", `/accounts/${account}/workers/scripts/${IG_WORKER_NAME}`, form);

    let sub: string | undefined;
    try { sub = (await this.cf<{ subdomain: string }>(token, "GET", `/accounts/${account}/workers/subdomain`))?.subdomain; }
    catch (err) { if ((err as { status?: number }).status !== 404 && (err as { code?: number }).code !== 10007) throw err; }
    if (!sub) sub = (await this.cf<{ subdomain: string }>(token, "PUT", `/accounts/${account}/workers/subdomain`, { subdomain: `sf-${randomBytes(4).toString("hex")}` })).subdomain;
    await this.cf(token, "POST", `/accounts/${account}/workers/scripts/${IG_WORKER_NAME}/subdomain`, { enabled: true, previews_enabled: false });

    this.o.env.set({ SF_IG_CF_TOKEN: token, SF_IG_APP_SECRET: appSecret || null, SF_IG_PULL_SECRET: pull, SF_IG_VERIFY_TOKEN: verify, SF_IG_URL: `https://${IG_WORKER_NAME}.${sub}.workers.dev` });
    return this.status();
  }

  /** Forget the mailbox here (the Worker stays on your Cloudflare account until you delete it there). */
  forget(): InstagramStatus {
    this.o.env.set({ SF_IG_CF_TOKEN: null, SF_IG_APP_SECRET: null, SF_IG_PULL_SECRET: null, SF_IG_VERIFY_TOKEN: null, SF_IG_URL: null });
    this.last = null;
    return this.status();
  }

  /** The mailbox's last events (received, skipped, failed): what to look at when a shared reel does not arrive. */
  async events(): Promise<unknown[]> {
    const e = this.o.env.get();
    if (!e.SF_IG_URL || !e.SF_IG_PULL_SECRET) return [];
    const r = await this.f(`${e.SF_IG_URL}/pull-log`, { headers: { authorization: `Bearer ${e.SF_IG_PULL_SECRET}` } });
    if (!r.ok) throw new Error(`The mailbox answered ${r.status}`);
    return (await r.json()) as unknown[];
  }

  /** Move what waits in the mailbox into the Watch folder. Called every minute by the core; returns how many arrived. */
  async pull(): Promise<number> {
    const e = this.o.env.get();
    if (!e.SF_IG_URL || !e.SF_IG_PULL_SECRET || this.pulling) return 0;
    this.pulling = true;
    const auth = { authorization: `Bearer ${e.SF_IG_PULL_SECRET}` };
    let got = 0;
    try {
      const r = await this.f(`${e.SF_IG_URL}/pull`, { headers: auth });
      if (!r.ok) throw new Error(`The mailbox answered ${r.status}`);
      const items = (await r.json()) as { key: string; title?: string; mime?: string }[];
      const dir = this.o.inbox();
      mkdirSync(dir, { recursive: true });
      for (const it of items.slice(0, 10)) {
        const v = await this.f(`${e.SF_IG_URL}/pull/${encodeURIComponent(it.key)}`, { headers: auth });
        if (!v.ok) continue;
        const buf = Buffer.from(await v.arrayBuffer());
        const ext = it.mime === "video/quicktime" ? ".mov" : it.mime === "video/webm" ? ".webm" : ".mp4";
        const name = `IG ${clean(it.title) || "reel"} ${it.key.slice(2, 14)}`.trim();
        let p = join(dir, `${name}${ext}`);
        for (let i = 2; existsSync(p); i++) p = join(dir, `${name} (${i})${ext}`);
        writeFileSync(p, buf);
        await this.f(`${e.SF_IG_URL}/pull/${encodeURIComponent(it.key)}`, { method: "DELETE", headers: auth });
        got++;
      }
      this.last = { at: new Date().toISOString(), got, error: null };
    } catch (err) {
      this.last = { at: new Date().toISOString(), got, error: String((err as Error).message).slice(0, 300) };
    } finally {
      this.pulling = false;
    }
    return got;
  }
}

/** A reel's caption as a file name: the first words, nothing Windows refuses. */
function clean(t?: string): string {
  return String(t ?? "").replace(/[\u0000-\u001f<>:"/\\|?*#]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60).replace(/[. ]+$/, "");
}
