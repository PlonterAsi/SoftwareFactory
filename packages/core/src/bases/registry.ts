import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, parse as parsePath, resolve } from "node:path";
import { homedir } from "node:os";

/**
 * Bases: several factories hosted by one SoftwareFactory, like save files in a game.
 *
 * A base is a folder that holds a whole factory: its own factory.db (event log,
 * projects, tickets, agents, settings, crew mode), projects/, imports/, plugins/
 * and extensions/. One base is open at a time. The list of bases lives in
 * `bases.db` in the app's home folder (next to the first base's factory.db), as
 * an append-only `base_events` log with a `bases` table kept current from it.
 *
 * The factory the app had before bases existed is the default base: its folder is
 * the home folder itself, so nothing moves and nothing is lost.
 * Nothing here ever deletes a folder: archiving only hides a base from the list.
 */
export type BaseStatus = "active" | "archived";

export interface Base {
  id: number;
  name: string;
  /** The folder the factory lives in (holds factory.db). */
  folder: string;
  status: BaseStatus;
  /** The base the app had before bases existed: its folder is the home folder. */
  isDefault: boolean;
  createdAt: string;
  lastOpenedAt: string | null;
}

/** A base with a peek inside its database, for the Bases screen (like a save slot's summary). */
export interface BaseCard extends Base {
  current: boolean;
  /** False when the folder or its factory.db is gone (a removed drive, a moved folder). */
  reachable: boolean;
  stats: { projects: number; runs: number; signals: number; events: number; spentUsd: number; lastActivity: string | null } | null;
}

const NAME_MAX = 60;

export class BaseRegistry {
  readonly db: DatabaseSync;

  constructor(readonly home: string) {
    mkdirSync(home, { recursive: true });
    this.db = new DatabaseSync(join(home, "bases.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS base_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bases (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'active',
        is_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_opened_at TEXT
      );`);
    this.ensureDefault();
  }

  close() { try { this.db.close(); } catch { /* already closed */ } }

  /** The factory that was here before bases existed becomes "Main factory", in place. */
  private ensureDefault() {
    const any = this.db.prepare("SELECT 1 FROM bases LIMIT 1").get();
    if (any) return;
    this.append("base.created", { name: "Main factory", folder: same(this.home), isDefault: true });
  }

  /** Append one event and apply it to `bases` in the same transaction. Returns the event id. */
  private append(type: string, payload: Record<string, unknown>): number {
    const ts = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      const id = Number(this.db.prepare("INSERT INTO base_events (ts, type, payload) VALUES (?, ?, ?)").run(ts, type, JSON.stringify(payload)).lastInsertRowid);
      const p = payload as { id?: number; name?: string; folder?: string; isDefault?: boolean; status?: BaseStatus };
      if (type === "base.created") this.db.prepare("INSERT INTO bases (id, name, folder, is_default, created_at) VALUES (?, ?, ?, ?, ?)").run(id, p.name!, p.folder!, p.isDefault ? 1 : 0, ts);
      else if (type === "base.renamed") this.db.prepare("UPDATE bases SET name = ? WHERE id = ?").run(p.name!, p.id!);
      else if (type === "base.archived") this.db.prepare("UPDATE bases SET status = ? WHERE id = ?").run(p.status!, p.id!);
      else if (type === "base.opened") this.db.prepare("UPDATE bases SET last_opened_at = ? WHERE id = ?").run(ts, p.id!);
      this.db.exec("COMMIT");
      return id;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  list(): Base[] {
    return (this.db.prepare("SELECT * FROM bases ORDER BY is_default DESC, id").all() as unknown as Row[]).map(toBase);
  }

  get(id: number): Base | null {
    const r = this.db.prepare("SELECT * FROM bases WHERE id = ?").get(id) as unknown as Row | undefined;
    return r ? toBase(r) : null;
  }

  /** The base the app opens: the last one opened, else the default. */
  current(): Base {
    const last = this.db.prepare("SELECT payload FROM base_events WHERE type = 'base.opened' ORDER BY id DESC LIMIT 1").get() as { payload: string } | undefined;
    const id = last ? Number(JSON.parse(last.payload).id) : NaN;
    const b = Number.isFinite(id) ? this.get(id) : null;
    if (b && b.status === "active") return b;
    return this.list().find((x) => x.isDefault) ?? this.list()[0];
  }

  /** Where a new base goes unless you pick a folder: <home>/bases/<name>, made unique. */
  suggestFolder(name: string): string {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "base";
    const root = join(this.home, "bases");
    let dir = join(root, slug);
    for (let i = 2; this.byFolder(dir) || nonEmptyNonBase(dir); i++) dir = join(root, `${slug}-${i}`);
    return dir;
  }

  private byFolder(folder: string): Base | null {
    const f = key(folder);
    return this.list().find((b) => key(b.folder) === f) ?? null;
  }

  /**
   * Make a base. A folder that already holds a factory.db (a base copied from another
   * computer, or one made before) is adopted as it is; otherwise the folder is created.
   */
  create(input: { name: string; folder?: string }): { base: Base; adopted: boolean } {
    const name = cleanName(input.name);
    const folder = input.folder?.trim() ? same(input.folder.trim()) : this.suggestFolder(name);
    if (!isAbsolute(folder)) throw new Error("Pick a full folder path, like C:\\Factories\\Games.");
    const taken = this.byFolder(folder);
    if (taken) throw new Error(`That folder is already the base "${taken.name}".`);
    const adopted = existsSync(join(folder, "factory.db"));
    if (!adopted && nonEmptyNonBase(folder)) throw new Error("That folder already has other files in it. Pick an empty folder, or a new one, so the base's files stay on their own.");
    mkdirSync(folder, { recursive: true });
    const id = this.append("base.created", { name, folder });
    return { base: this.get(id)!, adopted };
  }

  rename(id: number, name: string): Base {
    const b = this.must(id);
    this.append("base.renamed", { id: b.id, name: cleanName(name) });
    return this.get(id)!;
  }

  /** Hide a base from the list (or bring it back). Its folder is never touched. */
  archive(id: number, archived: boolean, currentId: number): Base {
    const b = this.must(id);
    if (archived && b.id === currentId) throw new Error("This base is open. Open another base first, then archive this one.");
    if (archived && b.isDefault) throw new Error("Main factory is the base the app falls back to, so it stays. Rename it if you like.");
    this.append("base.archived", { id: b.id, status: archived ? "archived" : "active" });
    return this.get(id)!;
  }

  opened(id: number) { this.append("base.opened", { id: this.must(id).id }); }

  private must(id: number): Base {
    const b = this.get(id);
    if (!b) throw new Error(`No base #${id}`);
    return b;
  }

  /** Every base with a quick, read-only look inside its database. */
  cards(currentId: number): BaseCard[] {
    return this.list().map((b) => ({ ...b, current: b.id === currentId, ...peek(b.folder) }));
  }
}

/** Folders for the folder picker: subfolders of `path` (or the starting places when absent). */
export function browse(path: string | undefined, registry: BaseRegistry): { path: string | null; parent: string | null; dirs: { name: string; path: string; base: string | null }[]; places: { name: string; path: string }[] } {
  // SoftwareFactory's own folder for bases always exists, so the picker can start there.
  mkdirSync(join(registry.home, "bases"), { recursive: true });
  const places = [{ name: "Home", path: homedir() }, { name: "SoftwareFactory bases", path: join(registry.home, "bases") }];
  if (process.platform === "win32") { for (const d of "CDEFGH") if (existsSync(`${d}:\\`)) places.push({ name: `${d}:`, path: `${d}:\\` }); }
  else places.push({ name: "/", path: "/" });
  if (!path) return { path: null, parent: null, dirs: [], places };
  const dir = same(path);
  if (!isAbsolute(dir) || !existsSync(dir)) throw new Error("That folder does not exist yet. It will be made when you create the base.");
  const bases = new Map(registry.list().map((b) => [key(b.folder), b.name]));
  let dirs: { name: string; path: string; base: string | null }[] = [];
  try {
    dirs = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("$"))
      .map((d) => { const p = join(dir, d.name); return { name: d.name, path: p, base: bases.get(key(p)) ?? (existsSync(join(p, "factory.db")) ? "a base not in your list" : null) }; })
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 500);
  } catch (e) { throw new Error(`Could not read that folder: ${(e as Error).message}`); }
  const up = dirname(dir);
  return { path: dir, parent: up === dir ? null : up, dirs, places };
}

interface Row { id: number; name: string; folder: string; status: BaseStatus; is_default: number; created_at: string; last_opened_at: string | null }
const toBase = (r: Row): Base => ({ id: r.id, name: r.name, folder: r.folder, status: r.status, isDefault: !!r.is_default, createdAt: r.created_at, lastOpenedAt: r.last_opened_at });

function cleanName(name: unknown): string {
  const n = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
  if (!n) throw new Error("Give the base a name.");
  return n;
}

/** One spelling per folder, so C:\X and c:\x\ are the same base on Windows. */
function same(p: string): string {
  let n = normalize(resolve(p));
  const root = parsePath(n).root;
  if (n.length > root.length) n = n.replace(/[\\/]+$/, "");
  return n;
}
/** The key two folders are compared by: Windows paths ignore case. */
const key = (p: string) => (process.platform === "win32" ? same(p).toLowerCase() : same(p));

/** A folder with files in it that is not a base (no factory.db): not a safe home for a new base. */
function nonEmptyNonBase(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return true;
    if (existsSync(join(dir, "factory.db"))) return false;
    return readdirSync(dir).filter((f) => !f.startsWith(".")).length > 0;
  } catch { return false; }
}

function peek(folder: string): Pick<BaseCard, "reachable" | "stats"> {
  const file = join(folder, "factory.db");
  if (!existsSync(file)) return { reachable: existsSync(folder), stats: existsSync(folder) ? { projects: 0, runs: 0, signals: 0, events: 0, spentUsd: 0, lastActivity: null } : null };
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const n = (sql: string): number => { try { return Number((db!.prepare(sql).get() as { n: number } | undefined)?.n ?? 0); } catch { return 0; } };
    const last = (() => { try { return (db!.prepare("SELECT ts FROM events ORDER BY id DESC LIMIT 1").get() as { ts: string } | undefined)?.ts ?? null; } catch { return null; } })();
    return {
      reachable: true,
      stats: {
        projects: n("SELECT count(*) AS n FROM projects WHERE status != 'archived'"),
        runs: n("SELECT count(*) AS n FROM factory_runs"),
        signals: n("SELECT count(*) AS n FROM signals"),
        events: n("SELECT count(*) AS n FROM events"),
        spentUsd: Math.round(n("SELECT coalesce(sum(cost_usd), 0) * 10000 AS n FROM agent_runs")) / 10000,
        lastActivity: last,
      },
    };
  } catch { return { reachable: true, stats: null }; } finally { try { db?.close(); } catch { /* ignore */ } }
}
