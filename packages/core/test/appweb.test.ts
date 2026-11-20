import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installKit } from "../src/index.js";
import { APP_SHAPE } from "../src/bay/builtin.js";

/** SF-2: a built app reads the internet through its own server (GET /api/_fetch), never this computer or the home network. */

function app() {
  const dir = mkdtempSync(join(tmpdir(), "sf-webapp-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "schema.js"), `export const app = { name: "Feeds", slug: "feeds" };
export const entities = [{ name: "feed", label: "Feeds", singular: "Feed", title: "name", fields: [{ name: "name", type: "text", required: true }], seed: [{ name: "News" }] }];
export const flows = []; export const features = [];`);
  installKit(dir);
  return dir;
}

const stops: (() => void)[] = [];
afterAll(() => stops.forEach((s) => s()));

function start(dir: string, env: Record<string, string> = {}) {
  return new Promise<string>((resolve, reject) => {
    const p = spawn(process.execPath, ["server.js"], { cwd: dir, env: { ...process.env, PORT: "0", APP_DATA_DIR: join(dir, "data"), ...env } });
    stops.push(() => p.kill());
    p.stdout.on("data", (d) => { const m = String(d).match(/Ready on (\S+)/); if (m) resolve(m[1]); });
    p.on("exit", (c) => reject(new Error("server exited " + c)));
  });
}

async function site(): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    if (req.url === "/data.json") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ items: [1, 2, 3] })); return; }
    if (req.url === "/gone") { res.writeHead(404, { "content-type": "text/plain" }); res.end("nope"); return; }
    if (req.url === "/hop") { res.writeHead(302, { location: "/data.json" }); res.end(); return; }
    if (req.url === "/big") { res.writeHead(200, { "content-type": "text/plain" }); res.end("x".repeat(5_000_001)); return; }
    res.writeHead(200, { "content-type": "text/html" }); res.end("<script>alert(1)</script>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  stops.push(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server };
}

const read = (appUrl: string, target: string, headers: Record<string, string> = {}) => fetch(`${appUrl}api/_fetch?url=${encodeURIComponent(target)}`, { headers });

describe("built apps read the internet (SF-2)", () => {
  it("passes an answer through as it came, follows a redirect, and marks it so it never runs as a page", async () => {
    const s = await site();
    const a = await start(app(), { APP_WEB_ALLOW_LOCAL: "1" });
    const r = await read(a, `${s.url}/data.json`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ items: [1, 2, 3] });
    expect((await read(a, `${s.url}/hop`)).status).toBe(200);
    const page = await read(a, `${s.url}/`);
    expect(page.headers.get("content-security-policy")).toBe("sandbox");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    const gone = await read(a, `${s.url}/gone`);
    expect(gone.status).toBe(404);
    expect(gone.headers.get("x-fetched-status")).toBe("404");
    expect((await read(a, `${s.url}/big`)).status).toBe(413);
  });

  it("refuses this computer, the local network, other schemes, and pages from other sites", async () => {
    const s = await site();
    const a = await start(app());
    expect((await read(a, `${s.url}/data.json`)).status).toBe(403);
    expect((await read(a, "http://192.168.1.1/")).status).toBe(403);
    expect((await read(a, "http://[::1]:4317/api/tickets")).status).toBe(403);
    expect((await read(a, "http://localhost:4317/")).status).toBe(403);
    expect((await read(a, "file:///etc/passwd")).status).toBe(400);
    expect((await read(a, "not a url")).status).toBe(400);
    expect((await read(a, "https://example.com/", { "sec-fetch-site": "cross-site" })).status).toBe(403);
  });

  it("the Builder is told how: ctx.web for data, never code from the internet", () => {
    const role = APP_SHAPE;
    expect(role).toMatch(/ctx\.web\("https:/);
    expect(role).toMatch(/Code and styles never come from the internet/);
  });
});
