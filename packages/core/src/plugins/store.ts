import type { DatabaseSync } from "node:sqlite";

/**
 * An add-on's searchable catalog (the `store` permission, docs/plugins.md "Store").
 *
 * Each add-on keeps documents in named collections. A document is any JSON object (up to 256 KB) with the text
 * the add-on wants found by search; that text goes into a full-text index (SQLite FTS5, English stemming), so a
 * search for "skill" also finds "skills". Fields of the document can be filtered and sorted on.
 *
 * Unlike an add-on's small key → value data (plugin_data, kept in the event log), the catalog lives in tables of
 * its own: it can hold tens of thousands of documents without growing the log. It is in the same database file,
 * so it is backed up and moved with everything else, and removing the add-on removes its catalog.
 */
export const STORE_LIMITS = { docBytes: 256_000, textChars: 20_000, docsPerPlugin: 200_000, queryMax: 500 };

export interface StoreDoc { id: string; doc: Record<string, unknown>; updatedAt: string; rank?: number; snippet?: string }
export interface StoreQuery {
  coll: string;
  /** Words to find (any order; the last word also matches as a prefix, so "skil" finds "skills"). */
  text?: string;
  /** Field filters on the document: { category: "mcp" }, { score: { gte: 3 } }, { verdict: { in: ["use", "adapt"] } }. */
  where?: Record<string, unknown>;
  /** A field to sort by ("score", "-score" for descending); with text and no sort, the best matches come first. */
  sort?: string;
  limit?: number;
  offset?: number;
}

const COLL = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,39}(\.[A-Za-z_][A-Za-z0-9_]{0,39}){0,3}$/;

/** Turn what a person typed into a safe FTS5 query: each word quoted, the last also as a prefix. */
export function ftsQuery(text: string): string | null {
  const words = text.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}][\p{L}\p{N}_+#.-]*/gu)?.map((w) => w.replace(/[.-]+$/, "")).filter(Boolean).slice(0, 12) ?? [];
  if (!words.length) return null;
  const q = (w: string) => `"${w.replace(/"/g, "")}"`;
  return words.map((w, i) => (i === words.length - 1 && w.length >= 2 ? `(${q(w)} OR ${q(w)}*)` : q(w))).join(" AND ");
}

export class PluginStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS plugin_docs (
      rid        INTEGER PRIMARY KEY AUTOINCREMENT,
      plugin_id  TEXT NOT NULL,
      coll       TEXT NOT NULL,
      id         TEXT NOT NULL,
      doc        TEXT NOT NULL,
      text       TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      UNIQUE (plugin_id, coll, id)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS plugin_docs_fts USING fts5(text, content='plugin_docs', content_rowid='rid', tokenize='porter unicode61');
    CREATE TRIGGER IF NOT EXISTS plugin_docs_ai AFTER INSERT ON plugin_docs BEGIN
      INSERT INTO plugin_docs_fts(rowid, text) VALUES (new.rid, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS plugin_docs_ad AFTER DELETE ON plugin_docs BEGIN
      INSERT INTO plugin_docs_fts(plugin_docs_fts, rowid, text) VALUES ('delete', old.rid, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS plugin_docs_au AFTER UPDATE ON plugin_docs BEGIN
      INSERT INTO plugin_docs_fts(plugin_docs_fts, rowid, text) VALUES ('delete', old.rid, old.text);
      INSERT INTO plugin_docs_fts(rowid, text) VALUES (new.rid, new.text);
    END;`);
  }

  private coll(c: unknown): string {
    const s = String(c ?? "");
    if (!COLL.test(s)) throw new Error(`A collection name is 1 to 40 lowercase letters, digits, - or _ (got "${s.slice(0, 40)}")`);
    return s;
  }
  private docId(id: unknown): string {
    const s = String(id ?? "").trim();
    if (!s || s.length > 200) throw new Error("A document id is 1 to 200 characters");
    return s;
  }

  put(plugin: string, coll: unknown, id: unknown, doc: unknown, text?: unknown): StoreDoc {
    const c = this.coll(coll);
    const i = this.docId(id);
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("A document is a JSON object");
    const json = JSON.stringify(doc);
    if (json.length > STORE_LIMITS.docBytes) throw new Error(`The document is ${json.length} bytes, over the ${STORE_LIMITS.docBytes} limit`);
    const t = String(text ?? "").slice(0, STORE_LIMITS.textChars);
    const ts = new Date().toISOString();
    const exists = this.db.prepare("SELECT 1 FROM plugin_docs WHERE plugin_id = ? AND coll = ? AND id = ?").get(plugin, c, i);
    if (!exists && this.count(plugin) >= STORE_LIMITS.docsPerPlugin) throw new Error(`The catalog is full (${STORE_LIMITS.docsPerPlugin} documents)`);
    this.db.prepare(`INSERT INTO plugin_docs (plugin_id, coll, id, doc, text, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(plugin_id, coll, id) DO UPDATE SET doc = excluded.doc, text = excluded.text, updated_at = excluded.updated_at`).run(plugin, c, i, json, t, ts);
    return { id: i, doc: JSON.parse(json), updatedAt: ts };
  }

  get(plugin: string, coll: unknown, id: unknown): StoreDoc | null {
    const r = this.db.prepare("SELECT id, doc, updated_at FROM plugin_docs WHERE plugin_id = ? AND coll = ? AND id = ?").get(plugin, this.coll(coll), this.docId(id)) as { id: string; doc: string; updated_at: string } | undefined;
    return r ? { id: r.id, doc: JSON.parse(r.doc), updatedAt: r.updated_at } : null;
  }

  delete(plugin: string, coll: unknown, id: unknown): boolean {
    return Number(this.db.prepare("DELETE FROM plugin_docs WHERE plugin_id = ? AND coll = ? AND id = ?").run(plugin, this.coll(coll), this.docId(id)).changes) > 0;
  }

  count(plugin: string, coll?: unknown): number {
    const r = coll == null
      ? this.db.prepare("SELECT count(*) AS n FROM plugin_docs WHERE plugin_id = ?").get(plugin)
      : this.db.prepare("SELECT count(*) AS n FROM plugin_docs WHERE plugin_id = ? AND coll = ?").get(plugin, this.coll(coll));
    return Number((r as { n: number }).n);
  }

  /** Remove everything an add-on kept (when it is removed). */
  clear(plugin: string): void {
    this.db.prepare("DELETE FROM plugin_docs WHERE plugin_id = ?").run(plugin);
  }

  query(plugin: string, q: StoreQuery): { items: StoreDoc[]; total: number } {
    const c = this.coll(q.coll);
    const where: string[] = ["d.plugin_id = ?", "d.coll = ?"];
    const args: (string | number | null)[] = [plugin, c];
    const match = q.text ? ftsQuery(String(q.text)) : null;
    if (q.text && !match) return { items: [], total: 0 };
    if (match) { where.push("plugin_docs_fts MATCH ?"); args.push(match); }
    for (const [field, cond] of Object.entries(q.where ?? {})) {
      if (!FIELD.test(field)) throw new Error(`Cannot filter on "${field.slice(0, 40)}"`);
      const path = `json_extract(d.doc, '$.${field}')`;
      const val = (v: unknown) => (typeof v === "boolean" ? (v ? 1 : 0) : v == null ? null : typeof v === "number" ? v : String(v));
      if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
        const o = cond as Record<string, unknown>;
        if ("eq" in o) { where.push(`${path} = ?`); args.push(val(o.eq)); }
        if ("ne" in o) { where.push(`(${path} IS NULL OR ${path} != ?)`); args.push(val(o.ne)); }
        if ("gte" in o) { where.push(`${path} >= ?`); args.push(val(o.gte)); }
        if ("lte" in o) { where.push(`${path} <= ?`); args.push(val(o.lte)); }
        if ("gt" in o) { where.push(`${path} > ?`); args.push(val(o.gt)); }
        if ("lt" in o) { where.push(`${path} < ?`); args.push(val(o.lt)); }
        if ("exists" in o) where.push(o.exists ? `${path} IS NOT NULL` : `${path} IS NULL`);
        if ("in" in o && Array.isArray(o.in)) {
          const list = (o.in as unknown[]).slice(0, 50);
          if (!list.length) return { items: [], total: 0 };
          where.push(`${path} IN (${list.map(() => "?").join(",")})`);
          args.push(...list.map(val));
        }
      } else if (cond === null) where.push(`${path} IS NULL`);
      else { where.push(`${path} = ?`); args.push(val(cond)); }
    }
    const from = match ? "plugin_docs d JOIN plugin_docs_fts ON plugin_docs_fts.rowid = d.rid" : "plugin_docs d";
    const cond = where.join(" AND ");
    const total = Number((this.db.prepare(`SELECT count(*) AS n FROM ${from} WHERE ${cond}`).get(...args) as { n: number }).n);
    let order = "d.updated_at DESC";
    if (q.sort && q.sort !== "rank") {
      const desc = q.sort.startsWith("-");
      const f = q.sort.replace(/^[-+]/, "");
      if (f === "updatedAt") order = `d.updated_at ${desc ? "DESC" : "ASC"}`;
      else {
        if (!FIELD.test(f)) throw new Error(`Cannot sort by "${f.slice(0, 40)}"`);
        order = `json_extract(d.doc, '$.${f}') IS NULL, json_extract(d.doc, '$.${f}') ${desc ? "DESC" : "ASC"}, d.updated_at DESC`;
      }
    } else if (match) order = "bm25(plugin_docs_fts)";
    const limit = Math.min(Math.max(1, Number(q.limit) || 50), STORE_LIMITS.queryMax);
    const offset = Math.max(0, Number(q.offset) || 0);
    const cols = match ? ", bm25(plugin_docs_fts) AS rank, snippet(plugin_docs_fts, 0, '[', ']', ' … ', 14) AS snip" : "";
    const rows = this.db.prepare(`SELECT d.id, d.doc, d.updated_at${cols} FROM ${from} WHERE ${cond} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset) as { id: string; doc: string; updated_at: string; rank?: number; snip?: string }[];
    return {
      total,
      items: rows.map((r) => ({ id: r.id, doc: JSON.parse(r.doc), updatedAt: r.updated_at, ...(r.rank != null ? { rank: Number(r.rank) } : {}), ...(r.snip ? { snippet: r.snip } : {}) })),
    };
  }
}
