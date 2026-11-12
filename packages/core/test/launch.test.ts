import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  EventLog, MockRuntime, Factory, createCore, createProject, detectProfiles, splitArgs, quoteArg, resolveInside, findLocalUrl, projectEnv, projectFolders,
  readUsage, parseSynopsis, browse,
} from "../src/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "sf-launch-"));
function folder(files: Record<string, string>) {
  const dir = tmp();
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), c); }
  return dir;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await sleep(80);
  }
}

const WEB_SERVER = `import { createServer } from "node:http";
const port = Number(process.env.PORT || 0);
const s = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<h1>hello from the app</h1>"); });
s.listen(port, "127.0.0.1", () => console.log("Listening on http://localhost:" + s.address().port + "/"));
`;
const ECHO_CLI = `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--stdin") { const t = readFileSync(0, "utf8"); console.log("words:" + t.split(/\\s+/).filter(Boolean).length); }
else console.log("args:" + JSON.stringify(args));
`;

describe("launch: finding how to run a project", () => {
  it("finds the factory's bin/ tools, a web server script, and plain pages", () => {
    const cli = folder({ "package.json": JSON.stringify({ name: "wc", type: "module", scripts: { test: "node --test" } }), "bin/wc.js": ECHO_CLI, "src/count.js": "export const x = 1;\n" });
    const d = detectProfiles(cli);
    expect(d.exists).toBe(true);
    expect(d.stack).toContain("node");
    expect(d.profiles[0]).toMatchObject({ id: "bin:wc", kind: "cli", args: true, recommended: true, command: "node bin/wc.js" });
    expect(d.profiles.find((p) => p.id === "script:test")).toMatchObject({ utility: true, label: "Run its tests" });

    const web = folder({ "package.json": JSON.stringify({ type: "module", scripts: { start: "node server.js" } }), "server.js": WEB_SERVER });
    expect(detectProfiles(web).profiles[0]).toMatchObject({ id: "script:start", kind: "web", recommended: true, args: false });

    const site = folder({ "index.html": "<h1>hi</h1>", "style.css": "h1{}" });
    expect(detectProfiles(site).profiles).toEqual([expect.objectContaining({ id: "static:.", kind: "static", root: "", recommended: true })]);

    const lone = folder({ "server.js": WEB_SERVER });
    expect(detectProfiles(lone).profiles[0]).toMatchObject({ id: "file:server.js", kind: "web" });
  });

  it("asks to install packages first, and skips a bundler's source page", () => {
    const vite = folder({
      "package.json": JSON.stringify({ scripts: { dev: "vite", build: "vite build", lint: "eslint ." }, devDependencies: { vite: "^5" } }),
      "index.html": '<div id="root"></div><script type="module" src="/src/main.tsx"></script>',
    });
    const d = detectProfiles(vite);
    const ids = d.profiles.map((p) => p.id);
    expect(ids[0]).toBe("script:dev");
    expect(d.profiles[0].kind).toBe("web");
    expect(d.profiles[0].note).toMatch(/Install packages/);
    expect(ids).toContain("install");
    expect(ids).toContain("script:build");
    expect(ids).not.toContain("script:lint");
    expect(ids).not.toContain("static:.");
    // Once built, its dist/ is a preview of its own.
    writeFileSync(join(vite, "index.html"), "x");
    mkdirSync(join(vite, "dist"));
    writeFileSync(join(vite, "dist", "index.html"), "<h1>built</h1>");
    expect(detectProfiles(vite).profiles.map((p) => p.id)).toContain("static:dist");
  });

  it("finds Python, Rust and Go projects, and says when a folder is gone", () => {
    const py = folder({ "app.py": "from flask import Flask\napp = Flask(__name__)\n", "tool.py": "print(1)" });
    expect(detectProfiles(py).profiles[0]).toMatchObject({ id: "py:app.py", kind: "web" });
    expect(detectProfiles(folder({ "Cargo.toml": "[package]" })).profiles[0]).toMatchObject({ id: "cargo:run", kind: "program" });
    expect(detectProfiles(folder({ "go.mod": "module x" })).stack).toEqual(["go"]);
    expect(detectProfiles(join(tmp(), "nope"))).toMatchObject({ exists: false, profiles: [] });
  });

  it("splits an arguments box like a shell and quotes back", () => {
    expect(splitArgs(`a "b c" 'd e' f\\g ""`)).toEqual(["a", "b c", "d e", "f\\g", ""]);
    expect(splitArgs("  ")).toEqual([]);
    expect(quoteArg("notes.txt")).toBe("notes.txt");
    expect(quoteArg("my notes.txt")).toBe('"my notes.txt"');
    expect(quoteArg("C:\\Users\\me\\my photos")).toBe('"C:\\Users\\me\\my photos"');
  });

  it("keeps preview paths inside the folder", () => {
    const root = tmp();
    expect(resolveInside(root, "/index.html")).toBe(join(root, "index.html"));
    expect(resolveInside(root, "/a/../b.css")).toBe(join(root, "b.css"));
    expect(resolveInside(root, "/../secret")).toBeNull();
    expect(resolveInside(root, "/%2e%2e/secret")).toBeNull();
    expect(resolveInside(root, "/.git/config")).toBeNull();
    expect(resolveInside(root, "/a%00b")).toBeNull();
  });

  it("catches the address a dev server prints, and keeps secrets out of the environment", () => {
    expect(findLocalUrl("  ➜  Local:   \u001b[36mhttp://localhost:5173/\u001b[39m")).toBe("http://localhost:5173/");
    expect(findLocalUrl("Running on http://0.0.0.0:8000.")).toBe("http://127.0.0.1:8000");
    expect(findLocalUrl("see https://example.com")).toBeNull();
    process.env.SF_TEST_API_KEY = "x"; process.env.GITHUB_TOKEN_TEST = "y"; process.env.SF_HARMLESS = "z";
    const env = projectEnv("/p", "/opt/node/bin/node", 4000);
    expect(env.SF_TEST_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN_TEST).toBeUndefined();
    expect(env.PORT).toBe("4000");
    expect(env.PATH!.split(process.platform === "win32" ? ";" : ":").slice(0, 2)).toEqual([join("/p", "node_modules", ".bin"), "/opt/node/bin"]);
  });
});

describe("launch: running a project from the Bridge", () => {
  const servers: Server[] = [];
  afterAll(() => { for (const s of servers) s.close(); });

  async function boot(dbPath = ":memory:") {
    const dir = tmp();
    const log = new EventLog(dbPath);
    const core = createCore({ log, runtime: new MockRuntime({ delayMs: 0 }), projectsDir: join(dir, "projects"), order: { mode: "heuristic" } });
    const server = createServer(core);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (path: string, body?: unknown) => {
      const r = await fetch(base + path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const t = await r.text();
      let j: any; try { j = JSON.parse(t); } catch { j = t; }
      return { status: r.status, body: j };
    };
    return { log, core, base, call, server };
  }

  it("runs a command-line tool with arguments and typed input, and keeps its output", async () => {
    const { log, core, call } = await boot();
    const pid = createProject(log, { name: "Echo tool" });
    const dir = folder({ "package.json": JSON.stringify({ type: "module" }), "bin/echo.js": ECHO_CLI });
    expect((await call(`/api/launch/projects/${pid}/folder`, { dir: "relative/path" })).status).toBe(400);
    expect((await call(`/api/launch/projects/${pid}/folder`, { dir })).status).toBe(200);
    const info = (await call(`/api/launch/projects/${pid}`)).body;
    expect(info.dir).toBe(dir);
    expect(info.folders[0]).toMatchObject({ source: "folder", exists: true });
    expect(info.profiles[0].id).toBe("bin:echo");

    const s = (await call(`/api/launch/projects/${pid}/start`, { profileId: "bin:echo", args: `one "two words"` })).body;
    expect(s.command).toBe(`node bin/echo.js one "two words"`);
    const done = await until(async () => { const r = (await call(`/api/launch/sessions/${s.id}`)).body; return r.session.state === "exited" && r; });
    expect(done.session.exitCode).toBe(0);
    expect(done.lines.map((l: any) => l.text)).toContain(`args:["one","two words"]`);

    // Typed input, then close it so the tool can read to the end.
    const s2 = (await call(`/api/launch/projects/${pid}/start`, { profileId: "bin:echo", args: "--stdin" })).body;
    await until(async () => (await call(`/api/launch/sessions/${s2.id}`)).body.session.state === "running");
    expect((await call(`/api/launch/sessions/${s2.id}/input`, { text: "three little words" })).status).toBe(200);
    expect((await call(`/api/launch/sessions/${s2.id}/input`, { end: true })).status).toBe(200);
    const d2 = await until(async () => { const r = (await call(`/api/launch/sessions/${s2.id}`)).body; return r.session.state === "exited" && r; });
    expect(d2.lines.map((l: any) => [l.stream, l.text])).toEqual(expect.arrayContaining([["in", "three little words"], ["out", "words:3"]]));
    expect((await call(`/api/launch/sessions/${s2.id}/input`, { text: "late" })).status).toBe(409);

    // History lives in the table, with the last lines.
    const rows = log.db.prepare("SELECT * FROM launch_sessions ORDER BY id").all() as any[];
    expect(rows.map((r) => [r.profile_id, r.exit_code, r.ended_how])).toEqual([["bin:echo", 0, "exited"], ["bin:echo", 0, "exited"]]);
    expect(rows[1].tail).toContain("words:3");
    expect((await call(`/api/projects/${pid}`)).body.facets.launch).toMatchObject({ running: 0, folder: dir });
    core.launcher.stopAll();
  }, 30_000);

  it("starts a web app on a free port, shows its address, and stops it with everything it started", async () => {
    const { log, core, call } = await boot();
    const pid = createProject(log, { name: "Web app" });
    const dir = folder({ "package.json": JSON.stringify({ type: "module", scripts: { start: "node server.js" } }), "server.js": WEB_SERVER });
    await call(`/api/launch/projects/${pid}/folder`, { dir });
    const s = (await call(`/api/launch/projects/${pid}/start`, {})).body; // the recommended profile
    expect(s.profileId).toBe("script:start");
    expect(s.port).toBeGreaterThan(0);
    const live = await until(async () => { const r = (await call(`/api/launch/sessions/${s.id}`)).body; return r.session.url && r; });
    expect(live.session.url).toBe(`http://localhost:${s.port}/`);
    expect(await (await fetch(live.session.url)).text()).toContain("hello from the app");
    // Start again while it runs: the same session, not a second copy.
    expect((await call(`/api/launch/projects/${pid}/start`, { profileId: "script:start" })).body.id).toBe(s.id);
    expect((await call(`/api/projects/${pid}`)).body.facets.launch.running).toBe(1);

    expect((await call(`/api/launch/sessions/${s.id}/stop`, {})).status).toBe(200);
    const end = await until(async () => { const r = (await call(`/api/launch/sessions/${s.id}`)).body; return r.session.state === "stopped" && r; });
    expect(end.session.endedAt).toBeTruthy();
    await expect(fetch(live.session.url)).rejects.toThrow();
    expect(log.db.prepare("SELECT url, ended_how FROM launch_sessions WHERE id = ?").get(s.id)).toMatchObject({ url: live.session.url, ended_how: "stopped" });
    core.launcher.stopAll();
  }, 30_000);

  it("previews plain pages from the project folder, and nothing outside it", async () => {
    const { log, base, call } = await boot();
    const pid = createProject(log, { name: "Site" });
    const dir = folder({ "site/index.html": "<h1>my page</h1>", "site/app.js": "console.log(1)", "secret.txt": "no" });
    await call(`/api/launch/projects/${pid}/folder`, { dir });
    expect((await fetch(`${base}/preview/${pid}/`)).status).toBe(404); // off until started
    const info = (await call(`/api/launch/projects/${pid}`)).body;
    expect(info.profiles[0]).toMatchObject({ id: "static:site" });
    const s = (await call(`/api/launch/projects/${pid}/start`, { profileId: "static:site" })).body;
    expect(s).toMatchObject({ state: "serving", url: `/preview/${pid}/` });
    const page = await fetch(`${base}/preview/${pid}/`);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(await page.text()).toBe("<h1>my page</h1>");
    expect((await fetch(`${base}/preview/${pid}/app.js`)).headers.get("content-type")).toMatch(/javascript/);
    expect((await fetch(`${base}/preview/${pid}/%2e%2e/secret.txt`)).status).toBe(404);
    await call(`/api/launch/sessions/${s.id}/stop`, {});
    expect((await fetch(`${base}/preview/${pid}/`)).status).toBe(404);
  });

  it("runs a factory build from its own folder, and marks runs the app closed on", async () => {
    const dir = tmp();
    const db = join(dir, "factory.db");
    let pid: number;
    let sid: number;
    {
      const { log, core, call, server } = await boot(db);
      const f = core.factory as Factory;
      const run = f.start("a CLI that counts words", { autoApprove: true });
      await f.wait(run);
      pid = (await call(`/api/projects/of?kind=factory_run&ref=${run}`)).body.projectId;
      const info = (await call(`/api/launch/projects/${pid}`)).body;
      expect(info.folders[0]).toMatchObject({ source: "run", ref: run, exists: true });
      expect(projectFolders(log, pid)[0].label).toMatch(/shipped/);
      // A factory build is an app: it starts with one press as a web app, no arguments.
      const app = info.profiles.find((p: any) => p.kind === "web");
      expect(app).toMatchObject({ id: "script:start", recommended: true });
      // A long-running program, so it is still running when the app "closes".
      writeFileSync(join(info.dir, "server.js"), WEB_SERVER);
      const web = (await call(`/api/launch/projects/${pid}/start`, { profileId: app.id })).body;
      sid = web.id;
      await until(async () => (await call(`/api/launch/sessions/${sid}`)).body.session.url);
      core.launcher.stopAll();
      server.close();
      log.close();
    }
    const log = new EventLog(db);
    const { createCore: cc } = await import("../src/index.js");
    cc({ log, runtime: new MockRuntime({ delayMs: 0 }), projectsDir: join(dir, "projects"), order: { mode: "heuristic" } });
    expect(log.db.prepare("SELECT ended_how FROM launch_sessions WHERE id = ?").get(sid)).toMatchObject({ ended_how: "app-closed" });
    expect(pid).toBeGreaterThan(0);
    log.close();
  }, 60_000);

  it("refuses folders that are not there and starts nothing without a folder", async () => {
    const { log, call } = await boot();
    const pid = createProject(log, { name: "Empty" });
    expect((await call(`/api/launch/projects/${pid}`)).body).toMatchObject({ folders: [], dir: null, profiles: [] });
    expect((await call(`/api/launch/projects/${pid}/start`, {})).status).toBe(404);
    expect((await call(`/api/launch/projects/${pid}/folder`, { dir: join(tmp(), "missing") })).status).toBe(400);
    expect((await call(`/api/launch/projects/${pid}/start`, { dir: "/somewhere/else" })).status).toBe(400);
    expect((await call(`/api/launch/projects/9999`)).status).toBe(404);
    expect((await call(`/api/launch/open`, { url: "https://evil.example" })).status).toBe(400);
  });
});

describe("launch: using a tool without knowing its arguments", () => {
  const RENAMER = `#!/usr/bin/env node
const USAGE = 'usage: photo-date-rename <dir> [--apply]';
const args = process.argv.slice(2);
if (args.filter((a) => !a.startsWith("--")).length !== 1) { console.error(USAGE); process.exit(2); }
console.log("plan for " + args[0] + (args.includes("--apply") ? " (applied)" : " (dry run)"));
`;
  it("reads the usage line into a form: folders, files, switches, options", () => {
    expect(parseSynopsis("<dir> [--apply] [--top <n>] [--format=<fmt>] [out-file]")).toEqual([
      expect.objectContaining({ id: "pos:0", kind: "positional", type: "folder", required: true }),
      expect.objectContaining({ id: "--apply", kind: "flag", type: "switch", required: false }),
      expect.objectContaining({ id: "--top", kind: "option", type: "number", required: false }),
      expect.objectContaining({ id: "--format", kind: "option", type: "text" }),
      expect.objectContaining({ id: "pos:1", kind: "positional", type: "file", required: false }),
    ]);
    expect(parseSynopsis("[-h] <csv-file> --month <month>").map((f) => [f.id, f.type, f.required])).toEqual([["pos:0", "file", true], ["--month", "text", true]]);
  });

  it("finds what a factory-built tool does and how to call it, from its spec and its own usage text", () => {
    const dir = folder({
      "package.json": JSON.stringify({ type: "module" }),
      "bin/photo-date-rename.js": RENAMER,
      "SPEC.md": "# Photo Date Renamer\n\n> idea\n\nRenames JPEG photos in a folder to their capture date, with a dry run by default.\n\n## Interface\n\nbin/photo-date-rename.js CLI: photo-date-rename <dir> [--apply]. The default is a dry run.\n",
    });
    const p = detectProfiles(dir).profiles[0];
    const u = readUsage(dir, p);
    expect(u.summary).toMatch(/^Renames JPEG photos/);
    expect(u.synopsis).toBe("photo-date-rename <dir> [--apply]");
    expect(u.fields.map((f) => [f.id, f.type, f.required])).toEqual([["pos:0", "folder", true], ["--apply", "switch", false]]);
    expect(u.sources).toContain("spec");
  });

  it("offers example runs: run.json first, then README command lines, then a sample from the project", () => {
    const dir = folder({
      "package.json": JSON.stringify({ type: "module", bin: { "expense-report": "bin/report.js" } }),
      "bin/report.js": "const [f] = process.argv.slice(2); console.log('report of', f);\n",
      "README.md": "# Expense report\n\nSums a CSV of expenses by category.\n\n    expense-report <csv-file> [--month <month>]\n\nMarch only:\n\n    expense-report test/fixtures/sample.csv --month 2024-03   # Report for March\n    expense-report --help\n",
      "test/fixtures/sample.csv": "date,amount\n",
      "run.json": JSON.stringify({ examples: [{ label: "Whole year", profile: "cli", args: "test/fixtures/sample.csv" }, { label: "Other tool", profile: "bin:other", args: "x" }] }),
    });
    const u = readUsage(dir, detectProfiles(dir).profiles.find((p) => p.kind === "cli")!);
    expect(u.summary).toBe("Sums a CSV of expenses by category.");
    expect(u.fields.map((f) => [f.id, f.type])).toEqual([["pos:0", "file"], ["--month", "text"]]);
    expect(u.fields[0].suggestions).toEqual([join(dir, "test/fixtures/sample.csv")]);
    expect(u.examples).toEqual([
      { label: "Whole year", argv: ["test/fixtures/sample.csv"], stdin: undefined, note: undefined },
      { label: "Report for March", argv: ["test/fixtures/sample.csv", "--month", "2024-03"] },
    ]);
    expect(u.sources[0]).toBe("run.json");
  });

  it("lets a tool that reads text be tried with typed text, with no usage written down", () => {
    const dir = folder({ "bin/wc.js": "import { readFileSync } from 'node:fs';\nconsole.log(readFileSync(process.argv[2] ?? 0, 'utf8').split(/\\s+/).filter(Boolean).length);\n", "notes.txt": "a b c" });
    const u = readUsage(dir, detectProfiles(dir).profiles[0]);
    expect(u.readsStdin).toBe(true);
    expect(u.fields).toEqual([expect.objectContaining({ id: "pos:0", type: "file", required: false, suggestions: [join(dir, "notes.txt")] })]);
    expect(u.examples.map((e) => e.label)).toEqual(["Try it on notes.txt from the project", "Try it on a sample text"]);
    expect(u.examples[1].stdin).toBeTruthy();
  });

  it("runs a tool with the form's arguments and typed text, and lists folders for the pickers", async () => {
    const log = new EventLog(":memory:");
    const core = createCore({ log, runtime: new MockRuntime({ delayMs: 0 }), projectsDir: join(tmp(), "projects"), order: { mode: "heuristic" } });
    const server = createServer(core);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (path: string, body?: unknown) => (await fetch(base + path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
    const dir = folder({ "bin/photo-date-rename.js": RENAMER, "bin/wc.js": "import { readFileSync } from 'node:fs';\nconsole.log('words:' + readFileSync(0, 'utf8').split(/\\s+/).filter(Boolean).length);\n", "my photos/a.jpg": "x" });
    const pid = createProject(log, { name: "Tools" });
    await call(`/api/launch/projects/${pid}/folder`, { dir });
    const info = await call(`/api/launch/projects/${pid}`);
    const ren = info.profiles.find((p: any) => p.id === "bin:photo-date-rename");
    expect(ren.usage.fields[0]).toMatchObject({ type: "folder", required: true });
    const s = await call(`/api/launch/projects/${pid}/start`, { profileId: ren.id, argv: [join(dir, "my photos")] });
    expect(s.command).toBe(`node bin/photo-date-rename.js "${join(dir, "my photos")}"`);
    const done = await until(async () => { const r = await call(`/api/launch/sessions/${s.id}`); return r.session.state === "exited" && r; });
    expect(done.lines.map((l: any) => l.text)).toContain(`plan for ${join(dir, "my photos")} (dry run)`);
    const w = await call(`/api/launch/projects/${pid}/start`, { profileId: "bin:wc", stdin: "one two three four" });
    const wd = await until(async () => { const r = await call(`/api/launch/sessions/${w.id}`); return r.session.state === "exited" && r; });
    expect(wd.lines.map((l: any) => [l.stream, l.text])).toEqual(expect.arrayContaining([["in", "one two three four"], ["out", "words:4"]]));
    const b = await call(`/api/launch/browse?path=${encodeURIComponent(dir)}`);
    expect(b.path).toBe(dir);
    expect(b.entries.map((e: any) => [e.name, e.dir])).toEqual([["bin", true], ["my photos", true]]);
    expect(b.parent).toBeTruthy();
    expect(browse(null).path).toBeTruthy();
    core.launcher.stopAll();
    server.close();
  }, 30_000);
});
