import { readTree } from "./workspace.js";

/**
 * Every link in what the app ships, opened for real (run 2623): all 14 YouTube links and the Reddit
 * threads in Game Mastery's seed data were invented by the model, and nothing caught it, because the
 * tests only checked that each looked like a URL. A coach that sends you to dead videos is not a product.
 *
 * YouTube links are checked through YouTube's oEmbed (a video that does not exist answers 400 or 404);
 * other links with a plain GET. A site that refuses scripts (401, 403, 429) or does not answer in time
 * proves nothing either way and is not counted against the app. Free: no AI call.
 */

export interface LinkResult { url: string; ok: boolean | null; status?: number; note?: string; /** The file the link was found in. */ file?: string }
export interface LinkCheck { pass: boolean; skipped?: string; checked: number; dead: LinkResult[]; unknown: number }

const URL_RE = /https?:\/\/[^\s"'`<>)\]\\]+/g;
const SKIP_HOST = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|example\.(com|org|net)|.*\.example\.(com|org|net)|.*\.test|.*\.localhost)$/i;
/** Hosts whose links are code, licences or schemas, not content the person is sent to. */
const NOT_CONTENT = /^(www\.w3\.org|json-schema\.org|schema\.org|registry\.npmjs\.org|nodejs\.org|developer\.mozilla\.org|fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com)$/i;

/** The links the app's own files carry (its data, seeds and pages), not its tests, kit or dependencies. */
export function linksIn(dir: string, isExcluded: (p: string) => boolean): string[] {
  return Object.keys(linkFiles(dir, isExcluded));
}

/**
 * Each link and the first file it is in, so a dead link can be handed to the Fixer with its place. The app's
 * own data store (data/) is not the app: it is seeded on first start and never committed. In run 2898 the
 * Fixer removed six made-up links from the seed, the store kept the old copies, and the check failed twice
 * more on links that were no longer in the code.
 */
export function linkFiles(dir: string, isExcluded: (p: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [p, content] of Object.entries(readTree(dir))) {
    if (isExcluded(p) || !/\.(js|mjs|json|html|md|csv)$/i.test(p) || /^(node_modules|\.git|data|docs)\//.test(p) || p === "SPEC.md" || p === "README.md" || p === "PROGRESS.md" || p === "features.json") continue;
    for (const m of content.matchAll(URL_RE)) {
      const url = m[0].replace(/[.,;:!?]+$/, "");
      try {
        const u = new URL(url);
        if (SKIP_HOST.test(u.hostname) || NOT_CONTENT.test(u.hostname) || url.includes("${")) continue;
        out[url] ??= p;
      } catch { /* not a URL */ }
    }
  }
  return out;
}

const youtubeId = (url: string): string | null => {
  try {
    const u = new URL(url);
    if (/(^|\.)youtube\.com$/i.test(u.hostname)) return u.searchParams.get("v") ?? u.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]+)/)?.[1] ?? null;
    if (/^youtu\.be$/i.test(u.hostname)) return u.pathname.slice(1).split("/")[0] || null;
  } catch { /* not a URL */ }
  return null;
};

/** Open one link. true: it opens; false: it does not exist; null: the site would not say. */
export async function checkLink(url: string, timeoutMs = 8000, fetcher: typeof fetch = fetch): Promise<LinkResult> {
  const id = youtubeId(url);
  const target = id ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}` : url;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetcher(target, { method: "GET", redirect: "follow", signal: ctl.signal, headers: { "user-agent": "Mozilla/5.0 (link check)" } });
    try { await r.body?.cancel(); } catch { /* nothing to drop */ }
    if (r.ok) return { url, ok: true, status: r.status };
    if ([401, 403, 405, 429].includes(r.status) || r.status >= 500) return { url, ok: null, status: r.status, note: "the site would not say" };
    return { url, ok: false, status: r.status, note: id ? "no such YouTube video" : `answered ${r.status}` };
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    // A host that does not exist is a made-up link; a timeout or a network refusal proves nothing.
    if (/ENOTFOUND|EAI_AGAIN.*NOTFOUND|getaddrinfo ENOTFOUND/i.test(msg + String((e as { cause?: unknown }).cause ?? ""))) return { url, ok: false, note: "no such host" };
    return { url, ok: null, note: /abort/i.test(msg) ? "timed out" : "could not reach it" };
  } finally { clearTimeout(t); }
}

const cache = new Map<string, LinkResult>();

/** Check every link (at most `max`, a few at a time). No network at all skips the check instead of failing it. */
export async function checkLinks(urls: string[], o: { max?: number; fetcher?: typeof fetch; concurrency?: number } = {}): Promise<LinkCheck> {
  const list = urls.slice(0, o.max ?? 60);
  if (!list.length) return { pass: true, checked: 0, dead: [], unknown: 0 };
  const results: LinkResult[] = [];
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const url = list[i++];
      const hit = !o.fetcher ? cache.get(url) : undefined;
      const r = hit ?? await checkLink(url, 8000, o.fetcher);
      if (!o.fetcher && r.ok !== null) cache.set(url, r);
      results.push(r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.concurrency ?? 8, list.length) }, worker));
  const dead = results.filter((r) => r.ok === false);
  const unknown = results.filter((r) => r.ok === null).length;
  if (!dead.length && results.every((r) => r.ok === null && /could not reach|timed out/.test(r.note ?? ""))) return { pass: true, skipped: "no network: no link could be reached", checked: results.length, dead: [], unknown };
  return { pass: !dead.length, checked: results.length, dead, unknown };
}

/** The check as one cell in the test grid, fixed like a failing test. */
export function linkCase(c: LinkCheck) {
  return {
    name: `every link in the app opens (${c.checked - c.dead.length - c.unknown} open, ${c.dead.length} dead, ${c.unknown} unknown)`,
    file: "src/",
    pass: c.pass,
    error: c.pass ? undefined : `These links do not exist (made up?). The product needs the real ones: search the web for the page or video each was meant to be and put in the address a search returned. Remove a link only when a search finds no real page for it, and never write an address from memory:\n${c.dead.map((d) => `- ${d.url}${d.file ? ` (in ${d.file})` : ""}: ${d.note ?? d.status}`).join("\n")}`.slice(0, 2500),
    durationMs: 0,
  };
}

/**
 * Finding the real page for a made-up link (run 4004: 7 dead links at the first check, and the Builder,
 * which has no web search at its workbench, was told twice to "search for the real one" before the core
 * emptied them). An agent that can search is asked once, with the lines each link sits on; the core opens
 * every address it returns and puts the ones that exist in the dead link's place. What it cannot find is emptied.
 */
export const FIND_LINKS_USD = 0.25;
export const FIND_LINKS_MAX = 12;

/** The lines around a link in its file: what the link was meant to be (a record's title, its topic). */
export function linkContext(content: string, url: string, max = 420): string {
  const lines = content.split("\n");
  const at = lines.findIndex((l) => l.includes(url));
  if (at < 0) return "";
  return lines.slice(Math.max(0, at - 4), at + 2).map((l) => l.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, max);
}

export function findLinksPrompt(product: string, dead: { url: string; file: string; context: string }[]): string {
  return [
    "This time you only find pages. Do not design anything and do not write product documents.",
    `The app "${product}" is being built, and these web addresses in its sample content do not exist: they were written from memory. Each is listed with the lines it sits on, which say what the link was meant to be.`,
    dead.map((d, i) => `${i + 1}. ${d.url}\n   in ${d.file}: ${d.context || "(no context)"}`).join("\n"),
    `Use your web search tool now, at most ${dead.length + 2} searches. For each address find the real page or video that was meant, and give the address exactly as a search returned it on this call. When no search finds a real one, answer null for it: an empty link is right, a second made-up one is a defect.`,
    'Answer with ONE fenced json block and nothing else: {"links": [{"dead": "the address as listed", "real": "https://the-page-a-search-returned" or null}]}.',
  ].join("\n\n");
}

/** The finder's answer: for each dead link it was asked about, the address it found (never the same one, never a non-address). */
export function validateFoundLinks(j: unknown, dead: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const list = (j as { links?: unknown })?.links;
  for (const x of Array.isArray(list) ? list : []) {
    const d = String((x as { dead?: unknown })?.dead ?? "").trim();
    const real = String((x as { real?: unknown })?.real ?? "").trim().replace(/[.,;:!?]+$/, "");
    if (!dead.includes(d) || !/^https?:\/\/[^\s"'`<>\\]+\.[^\s"'`<>\\]+$/.test(real) || real === d || dead.includes(real)) continue;
    out[d] = real;
  }
  return out;
}
