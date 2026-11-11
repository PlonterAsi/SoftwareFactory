import type { IncomingMessage, ServerResponse } from "node:http";
import { BaseRegistry, browse, type Base } from "./registry.js";

/** One open factory: its HTTP handler, how busy it is, and how to shut it down cleanly. */
export interface BootedBase {
  handler: (req: IncomingMessage, res: ServerResponse) => unknown;
  /** Factory runs working right now. A base with runs in flight is not switched away from. */
  activeRuns: () => number;
  /** Stop timers, plugins, launched apps and the drop folder, then close the database. */
  dispose: () => void;
}

export type BootBase = (base: Base) => BootedBase;

/**
 * Hosts one base at a time on the same port. `/api/bases*` is answered here; every
 * other request goes to the open base's core. Switching closes the open base (its
 * event streams end, so the Bridge reloads) and boots the other one in the same process.
 */
export class BaseHost {
  private open: { base: Base; booted: BootedBase };
  private streams = new Set<ServerResponse>();

  constructor(readonly registry: BaseRegistry, private boot: BootBase, private reveal: (dir: string) => void = () => {}) {
    const base = registry.current();
    this.open = { base, booted: boot(base) };
    registry.opened(base.id);
  }

  get current(): Base { return this.open.base; }
  get booted(): BootedBase { return this.open.booted; }

  /** Open another base. Refuses while runs are working, so no run is cut off half way. */
  switchTo(id: number): Base {
    const next = this.registry.get(id);
    if (!next) throw new Error(`No base #${id}`);
    if (next.status === "archived") throw new Error(`"${next.name}" is archived. Bring it back first.`);
    if (next.id === this.open.base.id) return next;
    const busy = this.open.booted.activeRuns();
    if (busy) throw Object.assign(new Error(`${busy} factory run${busy > 1 ? "s are" : " is"} still working in "${this.open.base.name}". Wait for ${busy > 1 ? "them" : "it"} to finish or stop, then switch.`), { status: 409 });
    for (const s of this.streams) { try { s.end(); } catch { /* gone */ } }
    this.streams.clear();
    this.open.booted.dispose();
    let booted: BootedBase;
    try { booted = this.boot(next); } catch (e) {
      // The other base would not open: go back to the one that was open, so the app keeps working.
      this.open = { base: this.open.base, booted: this.boot(this.open.base) };
      throw new Error(`Could not open "${next.name}": ${(e as Error).message}`);
    }
    this.open = { base: next, booted };
    this.registry.opened(next.id);
    return next;
  }

  dispose() { this.open.booted.dispose(); this.registry.close(); }

  report() {
    return { current: this.open.base.id, home: this.registry.home, bases: this.registry.cards(this.open.base.id), activeRuns: this.open.booted.activeRuns() };
  }

  readonly handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/bases" || url.pathname.startsWith("/api/bases/")) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "content-type");
      if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
      if (req.headers.origin === "null") return json(res, 403, { error: "Plugin pages cannot change bases" });
      try {
        const [status, body] = await this.route(req, url);
        return json(res, status, body);
      } catch (e) {
        return json(res, (e as { status?: number }).status ?? 400, { error: (e as Error).message });
      }
    }
    if (url.pathname === "/api/events") {
      this.streams.add(res);
      res.on("close", () => this.streams.delete(res));
    }
    return this.open.booted.handler(req, res);
  };

  private async route(req: IncomingMessage, url: URL): Promise<[number, unknown]> {
    const path = url.pathname;
    if (req.method === "GET" && path === "/api/bases") return [200, this.report()];
    if (req.method === "GET" && path === "/api/bases/browse") return [200, browse(url.searchParams.get("path") || undefined, this.registry)];
    if (req.method === "GET" && path === "/api/bases/suggest") return [200, { folder: this.registry.suggestFolder(url.searchParams.get("name") || "New base") }];
    if (req.method !== "POST") return [404, { error: "not found" }];
    const body = await readJson(req);
    if (path === "/api/bases") {
      const { base, adopted } = this.registry.create({ name: String(body.name ?? ""), folder: body.folder ? String(body.folder) : undefined });
      if (body.open) this.switchTo(base.id);
      return [201, { base, adopted, ...this.report() }];
    }
    const m = path.match(/^\/api\/bases\/(\d+)(?:\/(open|archive|reveal))?$/);
    if (!m) return [404, { error: "not found" }];
    const id = Number(m[1]);
    if (m[2] === "open") { this.switchTo(id); return [200, this.report()]; }
    if (m[2] === "archive") { this.registry.archive(id, body.archived !== false, this.open.base.id); return [200, this.report()]; }
    if (m[2] === "reveal") {
      const b = this.registry.get(id);
      if (!b) return [404, { error: `No base #${id}` }];
      this.reveal(b.folder);
      return [200, { ok: true }];
    }
    if (body.name != null) this.registry.rename(id, String(body.name));
    return [200, this.report()];
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 100_000) throw new Error("body too large"); }
  return raw ? JSON.parse(raw) : {};
}
