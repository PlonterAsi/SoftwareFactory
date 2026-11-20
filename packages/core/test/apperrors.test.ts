import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { EventLog, MockRuntime, createCore, createProject, installKit } from "../src/index.js";
import { faultInOutput, runFault } from "../src/launch/faults.js";

/** SF-40: every project's errors are kept and become bugs in that project, not lines in a console nobody reads. */

const stops: (() => void)[] = [];
afterAll(() => stops.forEach((s) => s()));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timed out"); await sleep(60); }
}

describe("faultInOutput / runFault", () => {
  it("finds a Node error and its stack, a Python traceback's error, and a Rust panic", () => {
    const node = ["Listening on 3000", "file:///app/server.js:4", "TypeError: Cannot read properties of undefined (reading 'x')", "    at handler (file:///app/server.js:4:9)", "    at Server.emit (node:events:519:28)", "", "Node.js v22"];
    expect(faultInOutput(node)).toEqual({ message: "TypeError: Cannot read properties of undefined (reading 'x')", stack: node.slice(2, 5).join("\n") });
    const py = ["Traceback (most recent call last):", '  File "app.py", line 3, in <module>', "    main()", "KeyError: 'name'"];
    expect(faultInOutput(py)!.message).toBe("KeyError: 'name'");
    expect(faultInOutput(["thread 'main' panicked at src/main.rs:2:5:", "boom"])!.message).toMatch(/panicked/);
    expect(faultInOutput(["all good", "done"])).toBeNull();
  });
  it("is a fault only when the program ended by itself badly", () => {
    expect(runFault(1, "stopped", ["Error: x"])).toBeNull();
    expect(runFault(0, "exited", ["Error: x"])).toBeNull();
    expect(runFault(2, "exited", ["nothing useful"])).toEqual({ message: "It exited with code 2." });
    expect(runFault(null, "failed", ["Could not start: spawn nope ENOENT"])!.message).toMatch(/Could not start/);
  });
});

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "sf-apperr-"));
  const log = new EventLog(":memory:");
  const core = createCore({ log, runtime: new MockRuntime({ delayMs: 0 }), projectsDir: join(dir, "projects"), order: { mode: "heuristic" } });
  const server: Server = createServer(core);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  stops.push(() => { core.launcher.stopAll(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown) => (await fetch(base + path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  const bugs = (pid: number) => log.db.prepare("SELECT id, title, body, project FROM tickets WHERE kind = 'bug' AND project = ?").all(pid) as { id: number; title: string; body: string }[];
  return { log, core, base, call, bugs };
}

describe("a project's program that dies becomes a bug in that project", () => {
  it("files the error it printed, with its last output; a clean exit files nothing", async () => {
    const { log, call, bugs } = await boot();
    const dir = mkdtempSync(join(tmpdir(), "sf-apperr-cli-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module", scripts: { start: "node main.js" } }));
    writeFileSync(join(dir, "main.js"), "console.log('starting');\nconst cfg = undefined;\nconsole.log(cfg.port);\n");
    const pid = createProject(log, { name: "Crashy" });
    await call(`/api/launch/projects/${pid}/folder`, { dir });
    const info = await call(`/api/launch/projects/${pid}`);
    const s = await call(`/api/launch/projects/${pid}/start`, { profileId: info.profiles[0].id });
    await until(async () => (await call(`/api/launch/sessions/${s.id}`)).session.state === "exited");
    const [bug] = await until(() => bugs(pid).length && bugs(pid));
    expect(bug.title).toMatch(/TypeError: Cannot read properties of undefined/);
    expect(bug.body).toMatch(/This project's program hit an error in Run:/);
    expect(bug.body).toMatch(/starting/);
  });
});

describe("apps SF builds keep a log and report their errors", () => {
  function app() {
    const dir = mkdtempSync(join(tmpdir(), "sf-apperr-app-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "schema.js"), `export const app = { name: "Notes", slug: "notes" };
export const entities = [{ name: "note", label: "Notes", singular: "Note", title: "name", fields: [{ name: "name", type: "text", required: true }], seed: [{ name: "One" }] }];
export const flows = []; export const features = [];`);
    writeFileSync(join(dir, "api.js"), `export async function handle(req, res, url, ctx) {
  if (url.pathname === "/api/boom") throw new RangeError("bad range in boom");
  if (url.pathname === "/api/later") { setTimeout(() => { throw new Error("late failure"); }, 5); ctx.send(res, 200, { ok: true }); return true; }
  return false;
}`);
    installKit(dir);
    return dir;
  }
  const start = (dir: string, env: Record<string, string>) => new Promise<string>((resolve, reject) => {
    const p = spawn(process.execPath, ["server.js"], { cwd: dir, env: { ...process.env, PORT: "0", APP_DATA_DIR: join(dir, "data"), ...env } });
    stops.push(() => p.kill());
    p.stdout.on("data", (d) => { const m = String(d).match(/Ready on (\S+)/); if (m) resolve(m[1]); });
    p.on("exit", (c) => reject(new Error("server exited " + c)));
  });

  it("logs server errors, crashes and page errors, keeps serving, and files each as a bug in its project", async () => {
    const { log, base, bugs } = await boot();
    const pid = createProject(log, { name: "Notes" });
    const dir = app();
    const url = await start(dir, { SF_CORE_URL: base, SF_PROJECT_ID: String(pid) });
    expect((await fetch(url + "api/boom")).status).toBe(500);
    expect((await fetch(url + "api/later")).status).toBe(200);
    await fetch(url + "api/_error", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ where: "script #/home", message: "ReferenceError: chart is not defined", stack: "at draw (web/app.js:12:3)" }) });
    // Still serving after the crash in a timer.
    await sleep(100);
    expect((await fetch(url + "api/note")).status).toBe(200);
    const titles = (await until(() => bugs(pid).length >= 3 && bugs(pid))).map((b) => b.title).join("\n");
    expect(titles).toMatch(/bad range in boom/);
    expect(titles).toMatch(/late failure/);
    expect(titles).toMatch(/chart is not defined/);
    const shown = await (await fetch(url + "api/_log")).json();
    expect(shown.file).toMatch(/app\.log$/);
    expect(shown.lines.join("\n")).toMatch(/ERROR GET \/api\/boom: RangeError: bad range in boom/);
    expect(readFileSync(join(dir, "data", "app.log"), "utf8")).toMatch(/late failure/);
  });

  it("without a project (the factory's own app check) it only logs, and the core refuses a report with no project", async () => {
    const { base } = await boot();
    const dir = app();
    const url = await start(dir, { SF_CORE_URL: base, SF_PROJECT_ID: "" });
    expect((await fetch(url + "api/boom")).status).toBe(500);
    await until(async () => ((await (await fetch(url + "api/_log")).json()).lines.length ? true : false));
    const r = await fetch(base + "/api/apps/error", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: 999, message: "x" }) });
    expect(r.status).toBe(400);
  });
});
