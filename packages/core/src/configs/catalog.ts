import type { EventLog } from "../events.js";
import { isClosed } from "../tickets/model.js";
import type { Tickets } from "../tickets/tickets.js";
import type { ProfileSetting } from "./profiles.js";

/**
 * The catalog (docs/configuration.md, part 3 of the brief of 22 Nov 2026): every technique, tool or workflow you
 * picked (from Scout or by hand) as one entry that says where it came from, what it would touch, and where it stands.
 *
 *   proposed   picked, nothing runs; its build ticket (if any) waits, tagged "catalog", and the crew leaves it alone
 *   building   you said build it: the ticket goes back in line for the crew
 *   ready      built; it can join a profile (its settings, if it has any, apply through the profile)
 *   trial / promoted / dropped   decided by trials (part 4), or by you
 *
 * A ticket tagged "catalog" is never started by the crew on its own (tickets/model.ts autoWorkRefusal); Work it still
 * starts it, because your press is your ask. Events: catalog.entry.saved, catalog.entry.state.
 */
export const CATALOG_STATES = ["proposed", "building", "ready", "trial", "promoted", "dropped"] as const;
export type CatalogState = (typeof CATALOG_STATES)[number];
export const CATALOG_TAG = "catalog";

export interface CatalogEntry {
  id: string;
  title: string;
  what: string;
  kind: "tool" | "workflow" | "technique" | "idea" | "skill" | "setting";
  source: { kind: "scout" | "you" | "add-on"; label: string; link?: string; video?: string; at?: string };
  /** What it would change, in plain words ("review gate", "council size"). Two entries in one profile may not share one. */
  touches: string[];
  /** Settings it applies through a profile, when it is only settings. */
  settings?: ProfileSetting[];
  /** The ticket that builds it, and tickets merged into it as duplicates. */
  ticket?: number | null;
  merged?: number[];
  state: CatalogState;
  note?: string;
  addedAt?: string;
  stateAt?: string;
}

const KINDS = ["tool", "workflow", "technique", "idea", "skill", "setting"] as const;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "entry";

export function listCatalog(log: EventLog): CatalogEntry[] {
  const rows = log.db.prepare("SELECT ts, type, payload FROM events WHERE type IN ('catalog.entry.saved', 'catalog.entry.state') ORDER BY id").all() as unknown as { ts: string; type: string; payload: string }[];
  const m = new Map<string, CatalogEntry>();
  for (const r of rows) {
    const p = JSON.parse(r.payload);
    if (r.type === "catalog.entry.saved") { const prev = m.get(p.entry.id); m.set(p.entry.id, { ...p.entry, addedAt: prev?.addedAt ?? r.ts, stateAt: prev?.stateAt ?? r.ts }); }
    else { const e = m.get(p.id); if (e) m.set(p.id, { ...e, state: p.state, ...(p.note ? { note: p.note } : {}), stateAt: r.ts }); }
  }
  return [...m.values()];
}

export function getEntry(log: EventLog, id: string): CatalogEntry | null {
  return listCatalog(log).find((e) => e.id === id) ?? null;
}

/** Add or update an entry. A new id is made from the title; an existing id keeps its state unless one is given. */
export function saveEntry(log: EventLog, raw: Partial<CatalogEntry>, by = "you"): CatalogEntry {
  const title = String(raw.title ?? "").trim().slice(0, 200);
  if (!title) throw new Error("A catalog entry needs a title.");
  const existing = raw.id ? getEntry(log, raw.id) : null;
  let id = existing?.id ?? slug(raw.id || title);
  if (!existing) { const taken = new Set(listCatalog(log).map((e) => e.id)); let n = 2; const base = id; while (taken.has(id)) id = `${base}-${n++}`; }
  const entry: CatalogEntry = {
    id, title, what: String(raw.what ?? existing?.what ?? "").slice(0, 4000),
    kind: KINDS.find((k) => k === raw.kind) ?? existing?.kind ?? "idea",
    source: raw.source ?? existing?.source ?? { kind: "you", label: "Added by you" },
    touches: [...new Set((raw.touches ?? existing?.touches ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))],
    ...(raw.settings ?? existing?.settings ? { settings: raw.settings ?? existing?.settings } : {}),
    ticket: raw.ticket ?? existing?.ticket ?? null,
    merged: raw.merged ?? existing?.merged ?? [],
    state: CATALOG_STATES.find((s) => s === raw.state) ?? existing?.state ?? "proposed",
    ...(existing?.note ? { note: existing.note } : {}),
  };
  log.append("catalog.entry.saved", { entry, by });
  return getEntry(log, id)!;
}

/** Move an entry. Building puts its ticket back in line; any other state keeps the crew off it. */
export function setEntryState(log: EventLog, tickets: Tickets | null, id: string, state: CatalogState, by = "you", note?: string): CatalogEntry {
  const e = getEntry(log, id);
  if (!e) throw new Error("No catalog entry with that id.");
  if (!CATALOG_STATES.includes(state)) throw new Error(`State is one of ${CATALOG_STATES.join(", ")}.`);
  log.append("catalog.entry.state", { id, state, by, ...(note ? { note } : {}) });
  // Built with no settings of its own: it is the switch feature.<id>, so it can join a profile or go on trial.
  if (state === "ready" && !e.settings?.length) saveEntry(log, { ...e, state: "ready", settings: [{ path: `feature.${e.id}`, value: true }] }, by);
  if (tickets && e.ticket != null && tickets.get(e.ticket)) {
    const t = tickets.get(e.ticket)!;
    const tags = (t.tags ?? []).filter((x) => x !== CATALOG_TAG);
    if (state === "building") {
      tickets.edit(t.id, "tags", tags, by);
      tickets.say(t.id, `Catalog: you chose to build "${e.title}". Back in line for the crew. Build it behind the switch feature.${e.id} (featureOn in configs/profiles.ts), so it can go on trial and be turned on or off per profile.`, { by: "configuration", kind: "event" });
    } else if (!(t.tags ?? []).includes(CATALOG_TAG)) {
      tickets.edit(t.id, "tags", [...tags, CATALOG_TAG], by);
    }
  }
  return getEntry(log, id)!;
}

/** Brand-like names in a title (SkillSpector, NVIDIA), used to spot several tickets about one thing. */
export function brandsOf(title: string): string[] {
  const words = title.match(/[A-Za-z][A-Za-z0-9]+/g) ?? [];
  return [...new Set(words.filter((w) => /[a-z][A-Z]/.test(w) || (/^[A-Z0-9]{3,}$/.test(w) && !/^(MCP|SDK|API|CLI|URL|PR|LLM|AI|UI|UX|SF)$/.test(w))).map((w) => w.toLowerCase()))];
}

interface TicketLite { id: number; key: string; title: string; body: string; status: string; openedBy: string | null; tags?: string[] }

/**
 * Once: every open ticket Scout filed becomes a catalog entry, held. Tickets about the same named thing (a brand
 * in both titles) merge into one entry; the extra tickets are closed as duplicates of the first. Runs at start;
 * a second run finds the done marker and does nothing.
 */
export function adoptScoutTickets(log: EventLog, tickets: Tickets): { entries: string[]; merged: number[] } {
  const done = log.db.prepare("SELECT 1 FROM events WHERE type = 'catalog.adopted' LIMIT 1").get();
  if (done) return { entries: [], merged: [] };
  const open = (tickets.list({ view: "all", limit: 2000 }) as unknown as TicketLite[]).filter((t) => t.openedBy === "plugin:scout" && !isClosed(t.status as never));
  const known = new Set(listCatalog(log).flatMap((e) => [e.ticket, ...(e.merged ?? [])]).filter((x): x is number => x != null));
  const groups: TicketLite[][] = [];
  for (const t of open.filter((x) => !known.has(x.id)).sort((a, b) => a.id - b.id)) {
    const b = brandsOf(t.title);
    const g = b.length ? groups.find((gr) => gr.some((x) => brandsOf(x.title).some((y) => b.includes(y)))) : undefined;
    if (g) g.push(t); else groups.push([t]);
  }
  const entries: string[] = [];
  const merged: number[] = [];
  for (const g of groups) {
    const [first, ...rest] = g;
    const body = tickets.get(first.id) as unknown as TicketLite;
    const video = body.body.match(/^From the video "(.+?)" at ([0-9:]+): (\S+)/);
    const found = body.body.match(/^Scout found this tool: (\S+)/);
    const kind = (first.title.match(/^(Tool|Workflow|Technique|Idea) from a video/i)?.[1].toLowerCase() as CatalogEntry["kind"] | undefined) ?? (found ? "tool" : "idea");
    const title = first.title.replace(/^(Tool|Workflow|Technique|Idea) from a video:\s*/i, "").replace(/^(Adopt|Adapt|Build):\s*/i, "").trim();
    const e = saveEntry(log, {
      title, kind,
      what: body.body.split("\n\n").slice(1, 2).join("").slice(0, 1200),
      source: { kind: "scout", label: video ? `Scout, from the video "${video[1]}" at ${video[2]}` : found ? "Scout find" : "Scout", ...(video ? { link: video[3], video: video[1], at: video[2] } : found ? { link: found[1] } : {}) },
      touches: [], ticket: first.id, merged: rest.map((r) => r.id), state: "proposed",
    }, "configuration");
    entries.push(e.id);
    const t = tickets.get(first.id)!;
    if (!(t.tags ?? []).includes(CATALOG_TAG)) tickets.edit(first.id, "tags", [...(t.tags ?? []), CATALOG_TAG], "configuration");
    tickets.say(first.id, `Moved to the catalog as "${e.title}"${rest.length ? `, with ${rest.map((r) => r.key).join(", ")} merged in` : ""}. The crew leaves it alone until you choose Build it on the Configuration page (or press Work it).`, { by: "configuration", kind: "event" });
    for (const r of rest) { tickets.link(r.id, first.id, "duplicate_of", "configuration"); merged.push(r.id); }
  }
  log.append("catalog.adopted", { entries, merged });
  return { entries, merged };
}
