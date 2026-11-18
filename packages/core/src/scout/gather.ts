/**
 * Scout's gathering (docs/scout.md): plain code that reads public sources for new finds. It costs nothing:
 * no agent reads anything here. Each source kind is one small reader over a public address:
 *
 *   github   GitHub's repository search (new repos with stars, by topic or words)
 *   hn       Hacker News stories through the Algolia search API
 *   reddit   a subreddit's top posts of the day (its public .json)
 *   feed     any RSS or Atom feed: a blog, a newsletter, a YouTube channel's feed
 *   awesome  an "awesome list" README on GitHub: only links added since the last read count
 *
 * Instagram, Facebook and much of X need a sign-in to read, so they have no reader: their links come in
 * through the link inbox. Every reader takes `fetch` from its caller, so tests never touch the network.
 */
export type SourceKind = "github" | "hn" | "reddit" | "feed" | "awesome";
export const SOURCE_KINDS: SourceKind[] = ["github", "hn", "reddit", "feed", "awesome"];
export const SCOUT_SOURCE_WORD: Record<SourceKind | "inbox", string> = { github: "GitHub search", hn: "Hacker News", reddit: "Reddit", feed: "Feed", awesome: "Awesome list", inbox: "Link inbox" };

export interface Source {
  id: string;
  kind: SourceKind;
  /** github / hn: the search words. reddit: the subreddit. feed: the feed address. awesome: owner/repo. */
  value: string;
  on: boolean;
  /** For a feed added from the follow list: who it is. */
  label?: string;
}

export interface Item {
  url: string;
  key: string;
  title: string;
  source: SourceKind | "inbox";
  snippet?: string;
  meta: { stars?: number; points?: number; comments?: number; published?: string; author?: string; repo?: string; language?: string | null; createdAt?: string; pushedAt?: string; archived?: boolean; from?: string };
  /** How strongly it asks to be read first (stars, points, words that fit). */
  signal: number;
}

export type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export const DEFAULT_SOURCES: Source[] = [
  { id: "gh-claude-code", kind: "github", value: "topic:claude-code", on: true },
  { id: "gh-claude-skills", kind: "github", value: "claude skills in:name,description,readme", on: true },
  { id: "gh-mcp", kind: "github", value: "topic:mcp-server", on: true },
  { id: "gh-agents", kind: "github", value: "\"coding agent\" in:description", on: true },
  { id: "gh-prompts", kind: "github", value: "\"system prompt\" OR \"prompt library\" in:description", on: true },
  { id: "hn-claude", kind: "hn", value: "claude code", on: true },
  { id: "hn-mcp", kind: "hn", value: "MCP", on: true },
  { id: "hn-agents", kind: "hn", value: "coding agent", on: true },
  { id: "rd-claudeai", kind: "reddit", value: "ClaudeAI", on: true },
  { id: "rd-claudecode", kind: "reddit", value: "ClaudeCode", on: true },
  { id: "rd-mcp", kind: "reddit", value: "mcp", on: true },
  { id: "rd-prompt", kind: "reddit", value: "PromptEngineering", on: true },
  { id: "aw-claude-code", kind: "awesome", value: "hesreallyhim/awesome-claude-code", on: true },
  { id: "aw-mcp", kind: "awesome", value: "punkpeye/awesome-mcp-servers", on: true },
  { id: "aw-skills", kind: "awesome", value: "anthropics/skills", on: true },
  { id: "fd-simonw", kind: "feed", value: "https://simonwillison.net/atom/everything/", on: true, label: "Simon Willison" },
  { id: "fd-latent", kind: "feed", value: "https://www.latent.space/feed", on: true, label: "Latent Space" },
];

const UA = { "user-agent": "SoftwareFactory-Scout/1.0 (+https://github.com/PlonterAsi/SoftwareFactory)" };
const FIT = /\b(claude|anthropic|mcp|skills?|plugins?|agents?|agentic|prompts?|hooks?|subagents?|cursor|codex|copilot|llm|rag|evals?|tokens?|context)\b/gi;

/** The same thing found twice has one key: host and path, lower case, no www, no tracking, a GitHub repo by owner/name. */
export function keyOf(raw: string): string {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return raw.trim().toLowerCase().slice(0, 300); }
  const host = u.hostname.toLowerCase().replace(/^www\.|^m\.|^old\./, "");
  let path = u.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
  if (host === "github.com") path = path.split("/").slice(0, 3).join("/").toLowerCase();
  if (host === "youtu.be") return `youtube.com/watch?v=${path.slice(1)}`;
  if (host === "youtube.com" && u.searchParams.get("v")) return `youtube.com/watch?v=${u.searchParams.get("v")}`;
  return `${host}${path}`.slice(0, 300);
}

const fit = (s: string) => Math.min(5, (s.match(FIT) ?? []).length);
const strip = (s: string) => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/\s+/g, " ").trim();
const days = (n: number, now: number) => new Date(now - n * 86_400_000);

async function getText(fetch: Fetch, url: string, headers: Record<string, string> = {}): Promise<string> {
  const r = await fetch(url, { headers: { ...UA, ...headers } });
  if (!r.ok) throw new Error(`${new URL(url).hostname} answered ${r.status}`);
  return r.text();
}

export async function readGithub(fetch: Fetch, s: Source, o: { since: Date; token?: string | null }): Promise<Item[]> {
  const q = `${s.value} created:>${o.since.toISOString().slice(0, 10)}`;
  const j = JSON.parse(await getText(fetch, `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=15`,
    { accept: "application/vnd.github+json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) })) as { items?: any[] };
  return (j.items ?? []).filter((r) => !r.fork && r.stargazers_count >= 3).map((r) => ({
    url: r.html_url, key: keyOf(r.html_url), title: `${r.full_name}${r.description ? `: ${String(r.description).slice(0, 160)}` : ""}`, source: "github" as const,
    snippet: String(r.description ?? "").slice(0, 400),
    meta: { stars: r.stargazers_count, repo: r.full_name, author: r.owner?.login, language: r.language ?? null, createdAt: r.created_at, pushedAt: r.pushed_at, archived: !!r.archived, from: s.value },
    signal: Math.log10(1 + r.stargazers_count) * 2 + fit(`${r.full_name} ${r.description ?? ""} ${(r.topics ?? []).join(" ")}`) * 0.5,
  }));
}

export async function readHn(fetch: Fetch, s: Source, o: { since: Date }): Promise<Item[]> {
  const j = JSON.parse(await getText(fetch, `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(s.value)}&tags=story&hitsPerPage=15&numericFilters=${encodeURIComponent(`created_at_i>${Math.floor(o.since.getTime() / 1000)},points>=15`)}`)) as { hits?: any[] };
  return (j.hits ?? []).map((h) => {
    const url = h.url || `https://news.ycombinator.com/item?id=${h.objectID}`;
    return { url, key: keyOf(url), title: String(h.title ?? url).slice(0, 300), source: "hn" as const, snippet: `${h.points} points, ${h.num_comments ?? 0} comments on Hacker News: https://news.ycombinator.com/item?id=${h.objectID}`,
      meta: { points: h.points, comments: h.num_comments ?? 0, published: h.created_at, author: h.author, from: s.value }, signal: Math.log10(1 + Number(h.points ?? 0)) * 2 + fit(String(h.title ?? "")) * 0.5 };
  });
}

export async function readReddit(fetch: Fetch, s: Source): Promise<Item[]> {
  const sub = s.value.replace(/^\/?r\//i, "").trim();
  const j = JSON.parse(await getText(fetch, `https://www.reddit.com/r/${encodeURIComponent(sub)}/top.json?t=day&limit=15`)) as { data?: { children?: { data: any }[] } };
  return (j.data?.children ?? []).map((c) => c.data).filter((d) => !d.stickied && Number(d.score) >= 10).map((d) => {
    const link = `https://www.reddit.com${d.permalink}`;
    const url = d.is_self || !d.url || /reddit\.com|redd\.it/.test(String(d.url)) ? link : String(d.url);
    return { url, key: keyOf(url), title: String(d.title).slice(0, 300), source: "reddit" as const, snippet: `${String(d.selftext ?? "").slice(0, 300)}${url !== link ? `\nDiscussion: ${link}` : ""}`.trim(),
      meta: { points: d.score, comments: d.num_comments, published: new Date(Number(d.created_utc) * 1000).toISOString(), author: d.author, from: `r/${sub}` },
      signal: Math.log10(1 + Number(d.score ?? 0)) * 2 + fit(String(d.title ?? "")) * 0.5 };
  });
}

/** Entries of an RSS or Atom feed (a YouTube channel's feed is Atom). */
export function parseFeed(xml: string): { title: string; url: string; published?: string; summary?: string }[] {
  const out: { title: string; url: string; published?: string; summary?: string }[] = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/g) ?? [];
  for (const b of blocks) {
    const title = strip(b.match(/<title\b[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? "");
    const href = b.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/)?.[1] ?? b.match(/<link\b[^>]*href=["']([^"']+)["']/)?.[1] ?? strip(b.match(/<link\b[^>]*>([\s\S]*?)<\/link>/)?.[1] ?? "");
    const published = strip(b.match(/<(pubDate|published|updated|dc:date)\b[^>]*>([\s\S]*?)<\/\1>/)?.[2] ?? "") || undefined;
    const summary = strip(b.match(/<(description|summary|media:description|content)\b[^>]*>([\s\S]*?)<\/\1>/)?.[2] ?? "").slice(0, 400) || undefined;
    if (title && /^https?:\/\//.test(href)) out.push({ title, url: href, published, summary });
  }
  return out;
}

export async function readFeed(fetch: Fetch, s: Source, o: { since: Date }): Promise<Item[]> {
  return parseFeed(await getText(fetch, s.value)).filter((e) => !e.published || !Number.isFinite(Date.parse(e.published)) || Date.parse(e.published) >= o.since.getTime()).slice(0, 15).map((e) => ({
    url: e.url, key: keyOf(e.url), title: e.title.slice(0, 300), source: "feed" as const, snippet: e.summary,
    meta: { published: e.published, author: s.label, from: s.label ?? s.value }, signal: 1.5 + fit(`${e.title} ${e.summary ?? ""}`) * 0.6,
  }));
}

/** The links of a markdown README, with the words after each. */
export function readmeLinks(md: string): { title: string; url: string; text: string }[] {
  const out: { title: string; url: string; text: string }[] = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^\s*[-*]\s+(?:\*\*)?\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)(?:\*\*)?\s*[-–—:]?\s*(.*)$/);
    if (m && !/shields\.io|badge|#/.test(m[2])) out.push({ title: strip(m[1]), url: m[2], text: strip(m[3]).slice(0, 300) });
  }
  return out;
}

/** An awesome list: its links; which of them are new is decided by the caller against what it saw last time. */
export async function readAwesome(fetch: Fetch, s: Source, o: { token?: string | null }): Promise<Item[]> {
  const repo = s.value.replace(/^https?:\/\/github\.com\//, "").replace(/\/+$/, "");
  const md = await getText(fetch, `https://raw.githubusercontent.com/${repo}/HEAD/README.md`, o.token ? { authorization: `Bearer ${o.token}` } : {});
  return readmeLinks(md).map((l) => ({ url: l.url, key: keyOf(l.url), title: `${l.title}${l.text ? `: ${l.text.slice(0, 160)}` : ""}`, source: "awesome" as const, snippet: l.text,
    meta: { from: repo }, signal: 2 + fit(`${l.title} ${l.text}`) * 0.5 }));
}

export async function readSource(fetch: Fetch, s: Source, o: { since: Date; token?: string | null }): Promise<Item[]> {
  if (s.kind === "github") return readGithub(fetch, s, o);
  if (s.kind === "hn") return readHn(fetch, s, o);
  if (s.kind === "reddit") return readReddit(fetch, s);
  if (s.kind === "feed") return readFeed(fetch, s, o);
  return readAwesome(fetch, s, o);
}

export const sinceFor = (lastAt: string | null, now: number) => (lastAt ? new Date(Math.max(Date.parse(lastAt) - 6 * 3_600_000, now - 7 * 86_400_000)) : days(7, now));
