import { useEffect, useState } from "react";
import { API } from "./api";

interface Status { hasKey: boolean; keySource: "env" | "file" | null; keyHint: string | null; keyFile: string; settings: { dailyMax: number; models: string[]; inbox: string }; today: number; notes: number; waiting: number; folders: string[] }
interface IgStatus { ready: boolean; webhookUrl: string | null; verifyToken: string | null; hasCloudflareToken: boolean; hasAppSecret: boolean; lastPull: { at: string; got: number; error: string | null } | null }
interface Note { id: number; source: string; kind: "youtube" | "file"; title: string | null; question: string | null; notes: string; model: string; tokensIn: number; tokensOut: number; paidUsd: number; by: string; at: string; snippet?: string; cached?: boolean }

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? "Could not reach the core");
  return j as T;
}

/**
 * Videos (docs/videos.md): Gemini watches a YouTube link or a clip you saved, and SoftwareFactory keeps the notes.
 * The key is the same one Claude Code's /watch plugin uses, kept in ~/.config/watch/.env, and never shown again.
 */
export function Videos() {
  const [s, setS] = useState<Status | null>(null);
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [src, setSrc] = useState("");
  const [question, setQuestion] = useState("");
  const [q, setQ] = useState("");
  const [notes, setNotes] = useState<Note[]>([]);
  const [open, setOpen] = useState<Note | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ig, setIg] = useState<IgStatus | null>(null);
  const [cfToken, setCfToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [igEvents, setIgEvents] = useState<{ at: string; event: string; why?: string; title?: string }[] | null>(null);

  const run = async <T,>(what: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(what); setErr(null);
    try { return await fn(); } catch (e) { setErr((e as Error).message); return null; } finally { setBusy(null); }
  };
  const load = () => run("loading", async () => { setS(await call<Status>("/api/videos")); setIg(await call<IgStatus>("/api/videos/instagram").catch(() => null)); setNotes((await call<{ notes: Note[] }>(`/api/videos/notes?limit=8${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`)).notes); });
  useEffect(() => { load(); }, []);
  if (!s) return err ? <p className="setup-blocker">{err}</p> : null;

  const watch = () => run("watching", async () => {
    const v = src.trim();
    const body = /^https?:\/\//i.test(v) ? { url: v } : { file: v.replace(/^"(.*)"$/, "$1") };
    const n = await call<Note>("/api/videos/watch", { ...body, question: question.trim() || null });
    setOpen(n); setSrc(""); setQuestion("");
    setS(await call<Status>("/api/videos"));
    setNotes((await call<{ notes: Note[] }>("/api/videos/notes?limit=8")).notes);
  });
  const state = !s.hasKey
    ? "no Gemini key yet: nothing can be watched"
    : `Gemini key ${s.keyHint}${s.keySource === "env" ? " (from GEMINI_API_KEY)" : ""} · ${s.today} of ${s.settings.dailyMax} watched today · ${s.notes} notes kept`;

  return (
    <section className="setup-sec">
      <h3>Videos</h3>
      <div className="place">
        <div className="place-top">
          <span className="place-label">Watch and learn</span>
          <span className={`mono ${s.hasKey ? "" : "muted"}`}>{busy === "watching" ? "watching… (a long video takes a minute or two)" : busy === "saving" ? "saving…" : state}</span>
          <span className="place-actions">
            <button className="ghost sm" onClick={() => setEditing(!editing)}>{editing ? "Cancel" : s.hasKey ? "Replace key" : "Add key"}</button>
            {s.keySource === "file" && !editing && <button className="ghost sm" disabled={!!busy} onClick={() => run("saving", async () => setS(await call<Status>("/api/videos/key", { key: null })))}>Remove key</button>}
          </span>
        </div>
        {editing && <>
          <div className="place-hint">
            Get a free key at aistudio.google.com/apikey (sign in with Google, Create API key). The free tier needs no card and watches YouTube links, up to about 20 videos a day on the best model;
            Google may use free-tier requests to improve its products, so send only public videos and clips you are fine sharing. The key is saved in {s.keyFile}, which Claude Code's /watch uses too, and goes only to Google.
          </div>
          <div className="place-edit">
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="AIza…" aria-label="Gemini API key" />
            <button className="sm" disabled={!key.trim() || !!busy} onClick={async () => { const r = await run("saving", () => call<Status>("/api/videos/key", { key })); if (r) { setS(r); setEditing(false); setKey(""); } }}>Save key</button>
          </div>
        </>}
        <div className="place-hint">
          A YouTube link is watched by Google directly, with nothing downloaded. TikTok, Instagram and X forbid automated downloading, so save the clip from the app
          (Instagram: Share, Download, or a screen recording) into the Watch folder below. Anything saved there is watched within a minute and moved to Watched; a .txt file with the same name is the question.
          Make a folder called "SF Watch" in Google Drive from your phone: once it syncs to this PC it is watched too, and a reel is one share away. The same video and question again is answered from the notes, free.
        </div>
        <div className="place-edit">
          <label className="muted">Watch folder{s.waiting ? ` (${s.waiting} waiting)` : ""}
            <input defaultValue={s.settings.inbox} key={s.settings.inbox} aria-label="Watch folder"
              onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== s.settings.inbox) run("saving", async () => setS(await call<Status>("/api/videos/settings", { inbox: v }))); }} />
          </label>
        </div>
        {s.folders.length > 1 && <div className="place-hint">Also watching: {s.folders.filter((f) => f !== s.settings.inbox).join(", ")} (an "SF Watch" folder in Google Drive or OneDrive, found by itself).</div>}
        <div className="place-edit">
          <input value={src} onChange={(e) => setSrc(e.target.value)} placeholder="https://www.youtube.com/watch?v=…  or  C:\Users\…\clip.mp4" aria-label="YouTube link or video file" />
          <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="What to learn from it (optional)" aria-label="Question about the video" />
          <button className="sm" disabled={!s.hasKey || !src.trim() || !!busy} onClick={watch}>Watch</button>
        </div>
        <div className="place-edit">
          <label className="muted">Videos a day, at most
            <input type="number" min={0} max={1000} step={1} defaultValue={s.settings.dailyMax} key={s.settings.dailyMax} aria-label="Most videos watched a day"
              onBlur={(e) => { const v = Number(e.target.value); if (Number.isInteger(v) && v !== s.settings.dailyMax) run("saving", async () => setS(await call<Status>("/api/videos/settings", { dailyMax: v }))); }} />
          </label>
          <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") load(); }} placeholder="Search the notes" aria-label="Search video notes" />
          <button className="ghost sm" disabled={!!busy} onClick={load}>Search</button>
        </div>
        {notes.length > 0 && (
          <ul className="drops">
            {notes.map((n) => (
              <li key={n.id} className="filed">
                <button className="ghost sm" onClick={() => setOpen(open?.id === n.id ? null : n)}>{open?.id === n.id ? "Hide" : "Read"}</button>{" "}
                <span className="mono">{new Date(n.at).toLocaleDateString()}</span> {n.title ?? n.source}{" "}
                <span className="muted">· {n.kind === "youtube" ? "YouTube" : "file"}{n.question ? ` · ${n.question.slice(0, 60)}` : ""}{n.snippet ? ` · ${n.snippet}` : ""}</span>
              </li>
            ))}
          </ul>
        )}
        {open && (
          <div className="place-hint" style={{ whiteSpace: "pre-wrap" }}>
            <strong>{open.title ?? open.source}</strong>{open.cached ? " (from the notes, free)" : ""}{"\n"}
            <span className="muted">{open.source} · {open.model} · {open.tokensIn + open.tokensOut} tokens · ${open.paidUsd.toFixed(3)} on a paid key, nothing on the free tier</span>{"\n\n"}
            {open.notes}
          </div>
        )}
        {ig && <>
          <div className="place-top">
            <span className="place-label">Instagram by DM</span>
            <span className={`mono ${ig.ready ? "" : "muted"}`}>{ig.ready ? (ig.hasAppSecret ? `mailbox ready${ig.lastPull ? ` · last pull ${new Date(ig.lastPull.at).toLocaleTimeString()}${ig.lastPull.got ? `, ${ig.lastPull.got} reel${ig.lastPull.got > 1 ? "s" : ""}` : ""}${ig.lastPull.error ? ` · ${ig.lastPull.error}` : ""}` : ""}` : "mailbox up, waiting for the Meta app secret") : "not set up"}</span>
            {ig.ready && <span className="place-actions">
              <button className="ghost sm" disabled={!!busy} onClick={() => run("saving", async () => setIg(await call<IgStatus>("/api/videos/instagram/pull", {})))}>Pull now</button>
              <button className="ghost sm" disabled={!!busy} onClick={() => run("loading", async () => setIgEvents((await call<{ events: { at: string; event: string; why?: string; title?: string }[] }>("/api/videos/instagram/events")).events))}>Last events</button>
            </span>}
          </div>
          <div className="place-hint">
            Share a reel by DM to a second Instagram account you own (a free professional account). Instagram's own Messaging API sends it to your mailbox, a small
            Cloudflare Worker on your free Cloudflare account that SoftwareFactory sets up, and it lands in the Watch folder within a minute, even if this PC was off.
            Nothing here is opened to the internet. Paste a Cloudflare API token ("Edit Cloudflare Workers" template), then the Meta app's secret; then put the
            address and verify token below into the Meta app's webhook (field: messages).
          </div>
          <div className="place-edit">
            <input type="password" value={cfToken} onChange={(e) => setCfToken(e.target.value)} placeholder={ig.hasCloudflareToken ? "Cloudflare token saved" : "Cloudflare API token"} aria-label="Cloudflare API token" />
            <input type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder={ig.hasAppSecret ? "Meta app secret saved" : "Meta app secret (App settings, Basic)"} aria-label="Meta app secret" />
            <button className="sm" disabled={(!cfToken.trim() && !appSecret.trim() && ig.ready) || (!cfToken.trim() && !ig.hasCloudflareToken) || !!busy}
              onClick={async () => { const r = await run("saving", () => call<IgStatus>("/api/videos/instagram", { cloudflareToken: cfToken || undefined, appSecret: appSecret || undefined })); if (r) { setIg(r); setCfToken(""); setAppSecret(""); } }}>{ig.ready ? "Update mailbox" : "Set up mailbox"}</button>
          </div>
          {ig.webhookUrl && <div className="place-hint mono">Callback URL: {ig.webhookUrl}{"\n"}Verify token: {ig.verifyToken}</div>}
          {igEvents && <ul className="drops">{igEvents.length ? igEvents.slice().reverse().map((e, i) => <li key={i} className="filed"><span className="mono">{new Date(e.at).toLocaleString()}</span> {e.event}{e.title ? ` · ${e.title}` : ""}{e.why ? ` · ${e.why}` : ""}</li>) : <li className="muted">Nothing has reached the mailbox yet.</li>}</ul>}
        </>}
        {err && <p className="setup-blocker">{err}</p>}
      </div>
    </section>
  );
}
