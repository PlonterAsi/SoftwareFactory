import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseHost, BaseRegistry, bootBase, captureSignal, EventLog, listSignals } from "../src/index.js";

beforeAll(() => { process.env.SF_RUNTIME = "mock"; process.env.SF_AUTO_RESUME = "0"; });

const tmp = () => mkdtempSync(join(tmpdir(), "sf-bases-"));

describe("base registry", () => {
  it("adopts the existing factory as Main factory, in place", () => {
    const home = tmp();
    const old = new EventLog(join(home, "factory.db"));
    captureSignal(old, "made before bases existed");
    old.close();
    const reg = new BaseRegistry(home);
    const [main] = reg.list();
    expect(main).toMatchObject({ name: "Main factory", isDefault: true, status: "active" });
    expect(reg.current().id).toBe(main.id);
    const card = reg.cards(main.id)[0];
    expect(card.stats?.signals).toBe(1);
    expect(card.current).toBe(true);
    reg.close();
    // Opening again does not add a second default.
    const again = new BaseRegistry(home);
    expect(again.list()).toHaveLength(1);
    again.close();
  });

  it("creates, renames and archives bases without touching folders", () => {
    const home = tmp();
    const reg = new BaseRegistry(home);
    const main = reg.current();
    const { base: games, adopted } = reg.create({ name: "  Games   lab " });
    expect(adopted).toBe(false);
    expect(games.name).toBe("Games lab");
    expect(games.folder).toBe(join(home, "bases", "games-lab"));
    expect(existsSync(games.folder)).toBe(true);
    // Same name again gets its own folder.
    expect(reg.create({ name: "Games lab" }).base.folder).toBe(join(home, "bases", "games-lab-2"));
    expect(() => reg.create({ name: "x", folder: games.folder })).toThrow(/already the base/);
    expect(() => reg.create({ name: "" })).toThrow(/name/);
    expect(() => reg.create({ name: "rel", folder: "relative/path" })).not.toThrow(); // resolved to a full path
    expect(reg.rename(games.id, "Arcade").name).toBe("Arcade");
    expect(() => reg.archive(main.id, true, main.id)).toThrow(/open/);
    expect(reg.archive(games.id, true, main.id).status).toBe("archived");
    expect(existsSync(games.folder)).toBe(true);
    expect(reg.archive(games.id, false, main.id).status).toBe("active");
    reg.close();
  });

  it("refuses a folder full of other files, and adopts a folder that already is a base", () => {
    const home = tmp();
    const reg = new BaseRegistry(home);
    const busy = join(tmp(), "busy");
    mkdirSync(busy);
    writeFileSync(join(busy, "notes.txt"), "mine");
    expect(() => reg.create({ name: "Busy", folder: busy })).toThrow(/other files/);
    const elsewhere = tmp();
    const l = new EventLog(join(elsewhere, "factory.db")); captureSignal(l, "from another PC"); l.close();
    expect(reg.create({ name: "Copied", folder: elsewhere }).adopted).toBe(true);
    reg.close();
  });
});

describe("base host", () => {
  let server: Server | null = null;
  let host: BaseHost | null = null;
  afterEach(() => { server?.close(); server = null; host?.dispose(); host = null; });

  const start = async (home: string) => {
    host = new BaseHost(new BaseRegistry(home), (b) => bootBase(b.isDefault ? join(home, "factory.db") : join(b.folder, "factory.db"), { isDefault: b.isDefault }));
    server = createServer(host.handle);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json() as any };
    };
    return call;
  };

  it("keeps each base's data apart and switches between them", async () => {
    const home = tmp();
    const call = await start(home);
    const first = await call("GET", "/api/bases");
    expect(first.body.bases).toHaveLength(1);
    expect((await call("POST", "/api/signals", { text: "said in Main" })).status).toBe(201);

    const made = await call("POST", "/api/bases", { name: "Second", open: true });
    expect(made.status).toBe(201);
    expect(made.body.current).toBe(made.body.base.id);
    expect(existsSync(join(made.body.base.folder, "factory.db"))).toBe(true);
    // The new base starts empty: nothing said in Main shows here.
    const sigs = await call("GET", "/api/signals");
    expect(sigs.body.map((s: { text: string }) => s.text)).not.toContain("said in Main");
    await call("POST", "/api/signals", { text: "said in Second" });

    const back = await call("POST", `/api/bases/${first.body.current}/open`);
    expect(back.status).toBe(200);
    const mainSigs = (await call("GET", "/api/signals")).body.map((s: { text: string }) => s.text);
    expect(mainSigs).toContain("said in Main");
    expect(mainSigs).not.toContain("said in Second");

    // The list says what is inside each base, and which one is open.
    const list = (await call("GET", "/api/bases")).body;
    const second = list.bases.find((b: { name: string }) => b.name === "Second");
    expect(second.stats.signals).toBe(1);
    expect(list.bases.find((b: { current: boolean }) => b.current).isDefault).toBe(true);

    // Rename and archive through the API.
    expect((await call("POST", `/api/bases/${second.id}`, { name: "Arcade" })).body.bases.find((b: { id: number }) => b.id === second.id).name).toBe("Arcade");
    expect((await call("POST", `/api/bases/${second.id}/archive`, { archived: true })).status).toBe(200);
    expect((await call("POST", `/api/bases/${second.id}/open`)).status).toBe(400);
    // The folder picker lists folders and marks bases.
    const b = await call("GET", `/api/bases/browse?path=${encodeURIComponent(join(home, "bases"))}`);
    expect(b.body.dirs.map((d: { base: string | null }) => d.base)).toContain("Arcade");
  });

  it("remembers the open base across restarts", async () => {
    const home = tmp();
    const call = await start(home);
    const made = await call("POST", "/api/bases", { name: "Keep me", open: true });
    server!.close(); server = null; host!.dispose(); host = null;
    const call2 = await start(home);
    expect((await call2("GET", "/api/bases")).body.current).toBe(made.body.base.id);
    // And the main factory's data was never moved.
    const main = new EventLog(join(home, "factory.db"));
    expect(listSignals(main)).toEqual([]);
    main.close();
  });
});
