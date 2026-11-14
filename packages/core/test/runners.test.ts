import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { RunnerManager, readRunnerLine, runnerPlatform, runnerProblems, shaFromRelease, runnersRoute, ROUTE_VARIABLE, ISOLATED_VARIABLE } from "../src/index.js";

const tmp = (p = "sf-runners-") => mkdtempSync(join(tmpdir(), p));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | null | undefined | false, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await sleep(40);
  }
}

/** A stand-in for GitHub's runner program: listens, takes a job when a file appears, and can be told to end. */
const FAKE_RUNNER = `
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
console.log("Current runner version: '2.999.0'");
if (existsSync("leak-env")) writeFileSync("env.json", JSON.stringify(process.env));
if (existsSync("die")) { console.log("going down"); process.exit(3); }
console.log("2026-11-14 12:00:00Z: Listening for Jobs");
setInterval(() => {
  if (existsSync("job")) { unlinkSync("job"); console.log("2026-11-14 12:00:01Z: Running job: build"); }
  if (existsSync("done")) { unlinkSync("done"); console.log("2026-11-14 12:00:09Z: Job build completed with result: Succeeded"); }
}, 30);
`;
/** A stand-in for config.cmd: registering writes .runner, removing deletes it; the arguments are kept to look at. */
const FAKE_CONFIG = `
import { writeFileSync, unlinkSync } from "node:fs";
const a = process.argv.slice(2);
writeFileSync("config-args.json", JSON.stringify(a));
console.log("configuring with token " + a[a.indexOf("--token") + 1]);
if (a[0] === "remove") unlinkSync(".runner"); else writeFileSync(".runner", JSON.stringify({ agentName: a[a.indexOf("--name") + 1] }));
`;

interface Call { method: string; path: string; body: any; auth: string | null }
function fakeGitHub(o: { archive?: Buffer; sha?: string; variable?: string | null } = {}) {
  const calls: Call[] = [];
  const state = { variable: o.variable ?? null as string | null, isolated: null as string | null };
  const { asset, ext } = runnerPlatform();
  const name = `actions-runner-${asset}-2.999.0.${ext}`;
  const f = (async (input: any, init: any = {}) => {
    const u = new URL(String(input));
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname + u.search, body, auth: init.headers?.authorization ?? null });
    const ok = (j: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(j), { status });
    if (u.pathname === "/repos/actions/runner/releases/latest") return ok({ tag_name: "v2.999.0", body: `<!-- BEGIN SHA ${asset} -->${o.sha ?? ""}<!-- END SHA ${asset} -->`, assets: [{ name, browser_download_url: `https://dl.test/${name}` }] });
    if (u.host === "dl.test") return new Response(o.archive ?? Buffer.from("nope"), { status: 200 });
    if (u.pathname.endsWith("/actions/runners/registration-token")) return ok({ token: "REGTOKEN123" }, 201);
    if (u.pathname.endsWith("/actions/runners/remove-token")) return ok({ token: "RMTOKEN456" }, 201);
    if (u.pathname.endsWith(`/actions/variables/${ROUTE_VARIABLE}`)) {
      if (method === "GET") return state.variable == null ? ok({ message: "Not Found" }, 404) : ok({ name: ROUTE_VARIABLE, value: state.variable });
      if (method === "PATCH") { if (state.variable == null) return ok({ message: "Not Found" }, 404); state.variable = body.value; return ok({}, 204); }
      if (method === "DELETE") { state.variable = null; return ok({}, 204); }
    }
    if (u.pathname.endsWith(`/actions/variables/${ISOLATED_VARIABLE}`)) {
      if (method === "GET") return state.isolated == null ? ok({ message: "Not Found" }, 404) : ok({ name: ISOLATED_VARIABLE, value: state.isolated });
      if (method === "PATCH") { if (state.isolated == null) return ok({ message: "Not Found" }, 404); state.isolated = body.value; return ok({}, 204); }
      if (method === "DELETE") { state.isolated = null; return ok({}, 204); }
    }
    if (u.pathname.endsWith("/actions/variables") && method === "POST") { if (body.name === ISOLATED_VARIABLE) state.isolated = body.value; else state.variable = body.value; return ok({}, 201); }
    if (u.pathname.endsWith("/actions/runners")) return ok({ runners: [{ name: "sf-app", status: "online", busy: false, labels: [{ name: "self-hosted" }, { name: "sf-build" }] }] });
    if (u.pathname.endsWith("/actions/runs")) return ok({ workflow_runs: [{ id: 7, name: "Windows build", display_title: "A change", event: "push", head_branch: "main", status: "completed", conclusion: "success", created_at: "2026-11-14T12:00:00Z", html_url: "https://github.com/o/app/actions/runs/7" }] });
    if (u.pathname.endsWith("/actions/runs/7/jobs")) return ok({ jobs: [{ name: "build", status: "completed", conclusion: "success", runner_name: "sf-app", steps: [{ number: 1, name: "Set up job", status: "completed", conclusion: "success", started_at: "2026-01-01T00:00:00Z", completed_at: "2026-01-01T00:01:00Z" }] }, { name: "publish", status: "completed", conclusion: "success", runner_name: "GitHub Actions 12" }] });
    if (u.pathname.endsWith("/actions/permissions/fork-pr-contributor-approval") && method === "PUT") return ok({}, 204);
    if (/^\/repos\/[^/]+\/[^/]+$/.test(u.pathname)) return ok({ private: false });
    return ok({ message: "Not Found" }, 404);
  }) as typeof fetch;
  return { fetch: f, calls, state };
}

const made: RunnerManager[] = [];
function manager(o: { gh?: ReturnType<typeof fakeGitHub>; home?: string; token?: string | null; sandbox?: boolean } = {}) {
  const home = o.home ?? tmp();
  const m = new RunnerManager({
    home, fetch: (o.gh ?? fakeGitHub()).fetch, token: () => (o.token === undefined ? "ghp_abcdefghijklmnopqrstuvwxyz0123" : o.token),
    runCommand: () => ({ cmd: process.execPath, args: ["fake-runner.mjs"] }),
    configCommand: (_d, args) => ({ cmd: process.execPath, args: ["fake-config.mjs", ...args] }),
    backoff: { first: 60, max: 240, settled: 60_000 }, sandbox: () => o.sandbox ?? false,
  });
  made.push(m);
  return { m, home };
}
/** A folder that already holds the (fake) runner program, so set-up skips the download. */
function runnerDir(registered = false) {
  const dir = tmp("sfr-");
  writeFileSync(join(dir, "fake-runner.mjs"), FAKE_RUNNER);
  writeFileSync(join(dir, "fake-config.mjs"), FAKE_CONFIG);
  writeFileSync(join(dir, process.platform === "win32" ? "config.cmd" : "config.sh"), "");
  if (registered) writeFileSync(join(dir, ".runner"), "{}");
  return dir;
}
afterEach(() => { for (const m of made.splice(0)) m.dispose(); });

describe("build runners: reading and checking", () => {
  it("reads the jobs a runner takes from what it prints", () => {
    expect(readRunnerLine("2026-11-14 12:00:00Z: Listening for Jobs")).toEqual({ kind: "listening" });
    expect(readRunnerLine("2026-11-14 12:00:01Z: Running job: build")).toEqual({ kind: "job-start", name: "build" });
    expect(readRunnerLine("2026-11-14 12:09:00Z: Job smoke test completed with result: Failed")).toEqual({ kind: "job-end", name: "smoke test", result: "Failed" });
    expect(readRunnerLine("Current runner version: '2.338.2'")).toEqual({ kind: "version", version: "2.338.2" });
    expect(readRunnerLine("√ Connected to GitHub")).toBeNull();
  });

  it("finds GitHub's checksum for a download in the release notes", () => {
    const sha = "a".repeat(64);
    expect(shaFromRelease(`x <!-- BEGIN SHA win-x64 -->${sha}<!-- END SHA win-x64 --> y`, "win-x64")).toBe(sha);
    expect(shaFromRelease("no checksum here", "win-x64")).toBeNull();
  });

  it("refuses a runner whose folder or name would break, in a sentence", () => {
    const ok = { repo: "PlonterAsi/SoftwareFactory", name: "sf-softwarefactory", labels: ["sf-build"], dir: "C:\\sf-runners\\softwarefactory" };
    expect(runnerProblems(ok, [], "win32")).toEqual([]);
    expect(runnerProblems({ ...ok, dir: "C:\\Program Files\\runner" }, [], "win32")[0]).toMatch(/spaces/);
    expect(runnerProblems({ ...ok, dir: "C:\\a-very-long-folder-name\\that-goes-on\\and-on\\and-on-and-on-and-on\\softwarefactory" }, [], "win32")[0]).toMatch(/short/);
    expect(runnerProblems({ ...ok, repo: "not a repo" }, [], "win32")[0]).toMatch(/owner\/name/);
    expect(runnerProblems({ ...ok, labels: ["two words"] }, [], "win32")[0]).toMatch(/Labels/);
    const other = { ...ok, id: "x", on: true, createdAt: "" };
    expect(runnerProblems(ok, [other], "win32").join(" ")).toMatch(/already/);
  });
});

describe("build runners: set up, run, stop", () => {
  it("registers a runner without writing the token down, starts it, and follows its jobs", async () => {
    const gh = fakeGitHub();
    const { m, home } = manager({ gh });
    const dir = runnerDir();
    const added = m.add({ repo: "o/app", name: "sf-app", dir });
    expect(added.state).toBe("setting-up");
    await until(() => m.one("sf-app").state === "idle");
    // Registered with a one-time token asked from GitHub with the PC's sign-in.
    const reg = gh.calls.find((c) => c.path === "/repos/o/app/actions/runners/registration-token")!;
    expect(reg.method).toBe("POST");
    expect(reg.auth).toMatch(/^Bearer ghp_/);
    const args = JSON.parse(readFileSync(join(dir, "config-args.json"), "utf8")) as string[];
    expect(args).toEqual(expect.arrayContaining(["--unattended", "--url", "https://github.com/o/app", "--name", "sf-app", "--labels", "sf-build", "--replace"]));
    // The token is nowhere on disk in the app's folder, and not in what the page shows.
    const log = readFileSync(m.logPath("sf-app"), "utf8");
    expect(log).not.toContain("REGTOKEN123");
    expect(log).toContain("configuring with token ***");
    expect(readFileSync(join(home, "runners", "runners.json"), "utf8")).not.toContain("REGTOKEN123");
    expect(m.linesAfter("sf-app").map((l) => l.text).join("\n")).not.toContain("REGTOKEN123");
    expect(m.one("sf-app").version).toBe("2.999.0");
    expect(m.one("sf-app").runsOn).toContain("sf-build");

    writeFileSync(join(dir, "job"), "");
    await until(() => m.one("sf-app").state === "busy");
    expect(m.busyCount()).toBe(1);
    expect(m.one("sf-app").job).toBe("build");
    writeFileSync(join(dir, "done"), "");
    await until(() => m.one("sf-app").state === "idle");
    expect(m.recentJobs()[0]).toMatchObject({ name: "build", result: "Succeeded", runner: "sf-app", repo: "o/app" });
    expect(m.busyCount()).toBe(0);
  });

  it("stop ends the runner's process and keeps it off; a job in flight is recorded as cut off", async () => {
    const { m } = manager();
    const dir = runnerDir(true);
    m.add({ repo: "o/app", name: "sf-app", dir });
    await until(() => m.one("sf-app").state === "idle");
    const pid = m.one("sf-app").pid!;
    writeFileSync(join(dir, "job"), "");
    await until(() => m.one("sf-app").state === "busy");
    expect(m.stop("sf-app").state).toBe("off");
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    expect(m.recentJobs()[0].result).toBe("cut off");
    await sleep(300);
    expect(m.one("sf-app").state).toBe("off"); // not started again
    expect(m.one("sf-app").on).toBe(false);
  });

  it("a runner that ends by itself is started again, waiting longer each time", async () => {
    const { m } = manager();
    const dir = runnerDir(true);
    writeFileSync(join(dir, "die"), "");
    m.add({ repo: "o/app", name: "sf-app", dir });
    await until(() => m.one("sf-app").restarts >= 2);
    const v = m.one("sf-app");
    expect(["waiting", "starting"]).toContain(v.state);
    expect(m.linesAfter("sf-app").some((l) => /ended by itself \(code 3\)/.test(l.text))).toBe(true);
    // Fixed: it comes up and stays.
    spawnSync(process.execPath, ["-e", `require("fs").unlinkSync(${JSON.stringify(join(dir, "die"))})`]);
    await until(() => m.one("sf-app").state === "idle");
  });

  it("a runner gets no secrets and none of the app's own settings", async () => {
    process.env.SF_SECRET_THING = "x"; process.env.MY_API_KEY = "k"; process.env.NoDefaultCurrentDirectoryInExePath = "1";
    try {
      const { m } = manager();
      const dir = runnerDir(true);
      writeFileSync(join(dir, "leak-env"), "");
      m.add({ repo: "o/app", name: "sf-app", dir });
      await until(() => existsSync(join(dir, "env.json")));
      const env = JSON.parse(readFileSync(join(dir, "env.json"), "utf8"));
      expect(env.SF_SECRET_THING).toBeUndefined();
      expect(env.MY_API_KEY).toBeUndefined();
      expect(env.NoDefaultCurrentDirectoryInExePath).toBeUndefined();
      expect(env.PATH ?? env.Path).toBeTruthy();
    } finally { delete process.env.SF_SECRET_THING; delete process.env.MY_API_KEY; delete process.env.NoDefaultCurrentDirectoryInExePath; }
  });

  it("closing the app ends every runner; the next start brings back the ones that were on", async () => {
    const { m, home } = manager();
    const dir = runnerDir(true);
    m.add({ repo: "o/app", name: "sf-app", dir });
    await until(() => m.one("sf-app").state === "idle");
    const pid = m.one("sf-app").pid!;
    m.stopAll();
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    const again = manager({ home }).m;
    expect(again.list().map((r) => r.id)).toEqual(["sf-app"]);
    expect(again.one("sf-app").state).toBe("off");
    again.startAll();
    await until(() => again.one("sf-app").state === "idle");
  });

  it("a runner left running by a core that was killed is ended before a new one starts", async () => {
    const home = tmp();
    const dir = runnerDir(true);
    // What a killed core leaves behind: the runner still running, and its pid in the app's folder.
    const left = spawn(process.execPath, ["fake-runner.mjs"], { cwd: dir, stdio: "ignore", detached: process.platform !== "win32" });
    mkdirSync(join(home, "runners"), { recursive: true });
    writeFileSync(join(home, "runners", "sf-app.pid"), String(left.pid));
    writeFileSync(join(home, "runners", "runners.json"), JSON.stringify({ version: 1, runners: [{ id: "sf-app", repo: "o/app", name: "sf-app", labels: ["sf-build"], dir, on: true, createdAt: "" }] }));
    const gone = new Promise((r) => left.on("exit", r));
    const { m } = manager({ home });
    m.startAll();
    await gone;
    await until(() => m.one("sf-app").state === "idle");
    expect(m.one("sf-app").pid).not.toBe(left.pid);
    expect(m.linesAfter("sf-app").some((l) => /left over/.test(l.text))).toBe(true);
  });

  it("remove stops it, takes it off GitHub and keeps its folder", async () => {
    const gh = fakeGitHub();
    const { m } = manager({ gh });
    const dir = runnerDir(true);
    m.add({ repo: "o/app", name: "sf-app", dir });
    await until(() => m.one("sf-app").state === "idle");
    const r = await m.remove("sf-app");
    expect(r).toMatchObject({ removed: "sf-app", dir, unregistered: true, note: null });
    expect(gh.calls.some((c) => c.path === "/repos/o/app/actions/runners/remove-token")).toBe(true);
    expect(existsSync(dir)).toBe(true);
    expect(m.list()).toEqual([]);
  });

  it("with no GitHub sign-in, set-up stops and says what to do", async () => {
    const { m } = manager({ token: null });
    m.add({ repo: "o/app", name: "sf-app", dir: runnerDir() });
    const v = await until(() => { const x = m.one("sf-app"); return x.state === "not-set-up" && x.note ? x : null; });
    expect(v.note).toMatch(/gh auth login/);
  });
});

describe("build runners: the download", () => {
  const archive = () => {
    // A real archive of the fake runner, in the format this system's runner comes in.
    const src = runnerDir();
    const out = join(tmp(), `runner.${runnerPlatform().ext}`);
    const r = spawnSync("tar", [runnerPlatform().ext === "zip" ? "-acf" : "-czf", out, "-C", src, "."], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return readFileSync(out);
  };

  it("downloads the runner program, checks it against GitHub's checksum, and unpacks it", async () => {
    const buf = archive();
    const gh = fakeGitHub({ archive: buf, sha: createHash("sha256").update(buf).digest("hex") });
    const { m } = manager({ gh });
    const dir = join(tmp("sfr-"), "new");
    m.add({ repo: "o/app", name: "sf-app", dir });
    await until(() => m.one("sf-app").state === "idle", 20_000);
    expect(existsSync(join(dir, "fake-runner.mjs"))).toBe(true);
    expect(m.linesAfter("sf-app").some((l) => /checksum matches/.test(l.text))).toBe(true);
  });

  it("installs nothing when the download does not match the checksum", async () => {
    const gh = fakeGitHub({ archive: archive(), sha: "0".repeat(64) });
    const { m } = manager({ gh });
    const dir = join(tmp("sfr-"), "new");
    m.add({ repo: "o/app", name: "sf-app", dir });
    const v = await until(() => { const x = m.one("sf-app"); return x.state === "not-set-up" && x.note ? x : null; });
    expect(v.note).toMatch(/checksum/);
    expect(existsSync(join(dir, "fake-runner.mjs"))).toBe(false);
    expect(gh.calls.some((c) => c.path.includes("registration-token"))).toBe(false);
  });
});

describe("build runners: GitHub's side and the API", () => {
  it("says which machine each job ran on, and sends builds here or back with one variable", async () => {
    const gh = fakeGitHub();
    const { m } = manager({ gh });
    m.add({ repo: "o/app", name: "sf-app", dir: runnerDir(true) });
    const g = await m.github("o/app");
    expect(g.route.value).toBeNull();
    expect(g.runners[0]).toMatchObject({ name: "sf-app", status: "online" });
    expect(g.runs[0].jobs.map((j) => [j.name, j.here])).toEqual([["build", true], ["publish", false]]);
    const on = await m.route("sf-app", true);
    expect(JSON.parse(on.value!)).toEqual(expect.arrayContaining(["self-hosted", "sf-build"]));
    expect(gh.state.variable).toBe(on.value);
    // The repository is public: outside contributors' workflows are held for approval before anything runs here.
    expect(gh.calls.find((c) => c.path.endsWith("/fork-pr-contributor-approval"))?.body).toEqual({ approval_policy: "all_external_contributors" });
    expect(on.note).toMatch(/public/);
    expect((await m.github("o/app")).route.value).toBe(on.value);
    expect((await m.route("sf-app", false)).value).toBeNull();
    expect(gh.state.variable).toBeNull();
  });

  it("sends jobs that need an isolated Windows here only when this PC has Windows Sandbox", async () => {
    const without = fakeGitHub();
    const a = manager({ gh: without, sandbox: false }).m;
    a.add({ repo: "o/app", name: "sf-app", dir: runnerDir(true) });
    const off = await a.route("sf-app", true);
    expect(without.state.variable).toBeTruthy();
    expect(without.state.isolated).toBeNull();
    expect(off.note).toMatch(/Windows Sandbox is not turned on/);

    const withIt = fakeGitHub();
    const b = manager({ gh: withIt, sandbox: true }).m;
    b.add({ repo: "o/app", name: "sf-app", dir: runnerDir(true) });
    const on = await b.route("sf-app", true);
    expect(withIt.state.isolated).toBe(on.value);
    expect((await b.github("o/app")).route).toMatchObject({ isolated: on.value, sandbox: true });
    await b.route("sf-app", false);
    expect(withIt.state).toMatchObject({ variable: null, isolated: null });
  });

  it("does not send builds to a runner that is not set up", async () => {
    const { m } = manager({ token: null });
    m.add({ repo: "o/app", name: "sf-app", dir: runnerDir() });
    await expect(m.route("sf-app", true)).rejects.toThrow(/Set this runner up first/);
  });

  it("serves the list, the log and the actions over HTTP, and refuses plugin pages", async () => {
    const { m } = manager();
    const server: Server = createServer(async (req, res) => {
      if (!(await runnersRoute(m, req, res, new URL(req.url ?? "/", "http://localhost")))) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (p: string, body: unknown = {}, headers: Record<string, string> = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    try {
      const dir = runnerDir(true);
      const bad = await post("/api/runners", { repo: "o/app", dir: "has space/x" });
      expect(bad.status).toBe(400);
      expect((await bad.json()).error).toMatch(/spaces/);
      const add = await post("/api/runners", { repo: "o/app", name: "sf-app", dir });
      expect(add.status).toBe(201);
      await until(() => m.one("sf-app").state === "idle");
      const list = await (await fetch(`${base}/api/runners`)).json();
      expect(list.runners[0]).toMatchObject({ id: "sf-app", state: "idle", repo: "o/app" });
      const log = await (await fetch(`${base}/api/runners/sf-app/log?after=0`)).json();
      expect(log.lines.some((l: { text: string }) => /Listening for Jobs/.test(l.text))).toBe(true);
      expect((await (await post("/api/runners/sf-app/stop")).json()).runners[0].state).toBe("off");
      expect((await post("/api/runners/sf-app/start", {}, { origin: "null" })).status).toBe(403);
      expect((await post("/api/runners/nope/start")).status).toBe(404);
      expect((await (await fetch(`${base}/api/runners/suggest?repo=PlonterAsi/SoftwareFactory`)).json()).name).toBe("sf-softwarefactory");
    } finally { server.close(); }
  });
});
