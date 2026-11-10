/**
 * The cache tier: views computed from the database and kept in memory.
 *
 * Every entry is keyed by the id of the newest event it has seen, so a new event
 * makes it stale by construction, and dropping the whole cache is always safe:
 * the next read recomputes it from the database. Hits, misses and compute time
 * are counted so the Bridge can draw the cache.
 */
export interface CacheEntryStats {
  name: string;
  /** Newest event id the cached value reflects. */
  key: number;
  hits: number;
  misses: number;
  /** Time the last recompute took, ms. */
  lastComputeMs: number;
  builtAt: string | null;
}

export class ViewCache {
  private entries = new Map<string, CacheEntryStats & { value?: unknown; valid: boolean }>();

  get<T>(name: string, key: number, compute: () => T): T {
    let e = this.entries.get(name);
    if (!e) { e = { name, key: -1, hits: 0, misses: 0, lastComputeMs: 0, builtAt: null, valid: false }; this.entries.set(name, e); }
    if (e.valid && e.key === key) { e.hits++; return e.value as T; }
    e.misses++;
    const t0 = performance.now();
    const value = compute();
    e.lastComputeMs = Number((performance.now() - t0).toFixed(2));
    Object.assign(e, { value, key, valid: true, builtAt: new Date().toISOString() });
    return value;
  }

  /** Drop one view, or every view. Values are recomputed on the next read. */
  clear(name?: string) {
    for (const e of this.entries.values()) if (!name || e.name === name) { e.valid = false; e.value = undefined; }
  }

  stats(): CacheEntryStats[] {
    return [...this.entries.values()].map(({ name, key, hits, misses, lastComputeMs, builtAt, valid }) => ({ name, key: valid ? key : -1, hits, misses, lastComputeMs, builtAt: valid ? builtAt : null }));
  }
}
