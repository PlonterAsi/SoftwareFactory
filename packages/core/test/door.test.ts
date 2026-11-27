import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { GitHub } from "../src/tickets/github.js";
import type { FenceReport, RoomExec, RoomFiles } from "../src/fence/fencetest.js";
import { looksLikeLimit, roomPrelude, runPrompt, stepOf } from "../src/fence/door.js";
import { fenceSettings } from "../src/fence/room.js";
import { RECORD_KINDS, TheRecord, cleanText } from "../src/fence/record.js";
import { quiet, storyText, workTicket, type TicketSettings } from "../src/fence/ticketrun.js";

describe("the record", () => {
  it("stamps who, run, ticket and project as real fields and tells a ticket's story in order", () => {
    const r = new TheRecord();
    r.append({ kind: "ticket.opened", who: "you", ticket: "T1", project: "o/p", data: { sentence: "fix it" } });
    r.append({ kind: "run.started", who: "SF itself", run: "T1-a", ticket: "T1", project: "o/p" });
    r.append({ kind: "run.step", who: "worker", run: "T1-a", ticket: "T1", project: "o/p", costUsd: 0.25, data: { says: "done" } });
    r.append({ kind: "ticket.opened", who: "you", ticket: "T2", project: "o/p" });
    expect(r.story("T1").map((l) => l.kind)).toEqual(["ticket.opened", "run.started", "run.step"]);
    expect(r.ofRun("T1-a")).toHaveLength(2);
    expect(r.costOf("T1-a")).toBe(0.25);
    expect(r.story("T1")[2]).toMatchObject({ who: "worker", run: "T1-a", project: "o/p" });
  });

  it("can never be rewritten or emptied, not even by reaching past the code", () => {
    const r = new TheRecord();
    r.append({ kind: "ticket.opened", who: "you", ticket: "T1" });
    expect(() => r.db.exec("UPDATE record SET who = 'someone else'")).toThrow(/never rewritten/);
    expect(() => r.db.exec("DELETE FROM record")).toThrow(/never rewritten/);
    expect(() => r.db.exec("INSERT OR REPLACE INTO record (id, ts, kind, who, data) VALUES (1, 'x', 'run.step', 'someone else', '{}')")).toThrow(/never rewritten/);
    expect(r.all()).toHaveLength(1);
  });

  it("takes only kinds from the fixed list, and always a who", () => {
    const r = new TheRecord();
    expect(() => r.append({ kind: "made.up" as any, who: "you" })).toThrow();
    expect(() => r.append({ kind: "run.step", who: " " })).toThrow();
    expect(RECORD_KINDS.length).toBeLessThan(25);
  });

  it("takes secrets out before storing, keeps the line and flags it", () => {
    const r = new TheRecord();
    r.hide("my-claude-sign-in-123");
    const l = r.append({ kind: "run.step", who: "worker", data: { says: "the key is ghp_abcdefghijklmnopqrstuvwxyz0123456789 and my-claude-sign-in-123", deep: [{ x: "sk-ant-abcdefghijklmnopqrstuvwxyz" }] } });
    expect(JSON.stringify(r.all())).not.toMatch(/ghp_abc|my-claude-sign-in|sk-ant-abc/);
    expect(l.flagged).toBe(true);
    expect(cleanText("nothing here").hit).toBe(false);
  });
});

describe("the door's small parts", () => {
  it("reads Claude Code's stream into content only", () => {
    expect(stepOf("not json")).toBeNull();
    expect(stepOf(JSON.stringify({ type: "system", subtype: "init", tools: ["Bash", "Read"] }))).toEqual({ data: { did: "agent started", toolCount: 2 }, started: true });
    expect(stepOf(JSON.stringify({ type: "system", subtype: "init", tools: ["Bash", "mcp__claude_ai_Gmail__send_message"], mcp_servers: [{ name: "claude.ai Gmail", status: "connected" }, { name: "late", status: "pending" }] }))!.outside).toEqual(["mcp__claude_ai_Gmail__send_message", "server claude.ai Gmail", "server late"]);
    expect(stepOf(JSON.stringify({ type: "system", subtype: "init" }))).toBeNull();
    expect(stepOf(JSON.stringify({ type: "system", subtype: "init", tools: ["Bash", "RemoteTrigger"] }))!.data).toEqual({ did: "agent started", toolCount: 2, otherTools: ["RemoteTrigger"] });
    expect(stepOf(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__x__y", input: {} }] } }))!.outside).toEqual(["mcp__x__y"]);
    expect(stepOf(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Reading the code." }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] } }))!.data).toEqual({ says: "Reading the code.", tools: [{ tool: "Bash", input: '{"command":"ls"}' }] });
    expect(stepOf(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", is_error: true, content: "denied" }] } }))!.data).toEqual({ toolErrors: ["denied"] });
    const end = stepOf(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "All done.", total_cost_usd: 0.42, num_turns: 7 }))!.end!;
    expect(end).toEqual({ isError: false, outOfTurns: false, text: "All done.", costUsd: 0.42, turns: 7 });
    expect(stepOf(JSON.stringify({ type: "result", subtype: "error_max_turns" }))!.end!).toMatchObject({ isError: true, outOfTurns: true });
  });

  it("lets a run's words into a pull request as words only", () => {
    const q = quiet("thanks @assaf, closes #12 \u001b[31m<!-- hidden -->");
    expect(q).not.toMatch(/@assaf|#12|\u001b|<!--/);
    expect(q).toContain("thanks");
  });

  it("knows a limit from a failure", () => {
    expect(looksLikeLimit("Claude usage limit reached. Your limit will reset at 3pm")).toBe(true);
    expect(looksLikeLimit("TypeError: x is not a function")).toBe(false);
  });

  it("tells the agent the owner's sentence, the checks, and that the net is a short list", () => {
    const p = runPrompt({ sentence: "Add a footer.", checks: ["npm run build"], prepare: ["npm ci --prefix web"] });
    expect(p).toMatch(/FIRST[\s\S]*npm ci --prefix web/);
    expect(p).toContain("Add a footer.");
    expect(p).toContain("npm run build");
    expect(p).toMatch(/WITHOUT any network/);
  });

  it("runs our own work on the copy with no network and the worker's home hidden", () => {
    const pre = roomPrelude(fenceSettings(), "T1-abc");
    expect(pre).toContain("--unshare-all");
    expect(pre).toContain("--tmpfs /home/worker");
    expect(pre).toContain("GOPROXY=off");
    expect(pre).toContain('--bind "$copy" "$copy"');
    expect(pre).toContain('--ro-bind "$scratch" "$scratch"');
    expect(pre).toContain("core.hooksPath=/dev/null");
  });
});

// The whole way, with the real scripts: a real git project, a real bash, and stand-ins only for the two programs
// the cloud does not have (bubblewrap, which here just runs the command, and Claude Code, which here edits one file).
const canRun = process.platform === "linux" && userInfo().uid === 0;
describe.skipIf(!canRun)("one ticket through the door, for real", () => {
  const root = `/home/sf-doortest-${process.pid}`;
  const copies = `${root}/copies`, shim = `${root}/shim`, origin = `${root}/origin.git`, workDir = `${root}/sf`;
  const g = (dir: string, ...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  const mode = (m: string) => writeFileSync(join(shim, "mode"), m);

  const exec: RoomExec = (_user, script, timeoutMs, onLine) => new Promise((resolve) => {
    const c = spawn("bash", ["--noprofile", "--norc", "-s"], { env: { PATH: `${shim}:/usr/local/bin:/usr/bin:/bin`, HOME: root } });
    let stdout = "", stderr = "", timedOut = false;
    const t = setTimeout(() => { timedOut = true; c.kill(); }, timeoutMs);
    c.stdout.on("data", (d) => { stdout += d; });
    c.stderr.on("data", (d) => { stderr += d; });
    c.on("close", (code) => { clearTimeout(t); if (onLine) for (const l of stdout.split("\n")) onLine(l); resolve({ code, stdout, stderr, timedOut }); });
    c.stdin.end(script);
  });
  const files: RoomFiles = { put: async (p, d) => writeFileSync(p, d), get: async (p) => readFileSync(p) };
  const okFence = async (): Promise<FenceReport> => ({ ok: true, room: "test", startedAt: "", ms: 1, lines: [{ n: 1, id: "x", what: "x", expect: "refused", verdict: "refused", ok: true, detail: "" }] });
  const settings = (over: Partial<TicketSettings> = {}): TicketSettings => ({ repo: { owner: "o", name: "p" }, base: "", checks: ["test -f hello.txt"], model: "sonnet", maxTurns: 5, timeLimitMinutes: 1, workDir, ...over });
  const deps = (record: TheRecord, fenceTest = okFence) => ({ exec, files, record, fenceTest, fence: { copies }, github: new GitHub({ dataDir: mkdtempSync(join(tmpdir(), "sf-gh-")), gitUrl: () => origin }) });

  beforeAll(() => {
    mkdirSync(shim, { recursive: true }); mkdirSync(copies, { recursive: true });
    writeFileSync(join(shim, "bwrap"), `#!/bin/bash
dir=""
while [ $# -gt 0 ]; do case "$1" in
  --chdir) dir="$2"; shift 2;; --ro-bind|--bind) shift 3;; --dev|--proc|--tmpfs) shift 2;;
  --unshare-all|--die-with-parent|--new-session) shift;; *) break;; esac; done
[ -n "$dir" ] && cd "$dir"
exec "$@"
`);
    writeFileSync(join(shim, "claude"), `#!/bin/bash
cat > /dev/null
m=$(cat "$(dirname "$0")/mode")
echo "$* connectors=$ENABLE_CLAUDEAI_MCP_SERVERS" > "$(dirname "$0")/args"
say() { printf '%s\\n' "$1"; }
if [ "$m" = mail ]; then say '{"type":"system","subtype":"init","tools":["Bash","mcp__claude_ai_Gmail__send_message"]}'; elif [ "$m" = blind ]; then say '{"type":"system","subtype":"init"}'; else say '{"type":"system","subtype":"init","tools":["Bash","Read"]}'; fi
case "$m" in
  limit) say '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Claude usage limit reached. Your limit will reset at 3pm.","total_cost_usd":0,"num_turns":0}'; exit 1;;
  nothing) ;;
  script) echo '{"scripts":{"build":"exit 0"}}' > package.json; echo hi > hello.txt;;
  workflow) mkdir -p .github/workflows && echo "on: push" > .github/workflows/x.yml; echo hi > hello.txt;;
  hook) echo "hello from the room" > hello.txt; echo "you see me" > kept-out.txt; mkdir -p .git/hooks .git/info; printf '#!/bin/sh\\necho pwned > hello.txt\\n' > .git/hooks/pre-commit; chmod +x .git/hooks/pre-commit; echo kept-out.txt > .git/info/exclude;;
  late) echo hi > hello.txt; say '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__claude_ai_Google_Drive__search_files","input":{}}]}}';;
  secret) echo "token = ghp_abcdefghijklmnopqrstuvwxyz0123456789" > hello.txt;;
  *) echo "hello from the room" > hello.txt;;
esac
say '{"type":"assistant","message":{"content":[{"type":"text","text":"I added hello.txt."},{"type":"tool_use","name":"Write","input":{"file_path":"hello.txt"}}]}}'
say '{"type":"result","subtype":"success","is_error":false,"result":"Added hello.txt as asked.","total_cost_usd":0.07,"num_turns":2}'
`);
    writeFileSync(join(shim, "npm"), "#!/bin/bash\nexit 0\n"); chmodSync(join(shim, "npm"), 0o755);
    chmodSync(join(shim, "bwrap"), 0o755); chmodSync(join(shim, "claude"), 0o755);
    const seed = `${root}/seed`;
    mkdirSync(seed, { recursive: true });
    g(seed, "init", "-q", "-b", "main"); g(seed, "config", "user.email", "a@b.c"); g(seed, "config", "user.name", "Owner");
    writeFileSync(join(seed, "README.md"), "# project\n"); g(seed, "add", "-A"); g(seed, "commit", "-q", "-m", "first");
    execFileSync("git", ["clone", "-q", "--bare", seed, origin]);
  });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  it("ends as a branch on the project with the work on it, and the story says every step", async () => {
    mode("ok");
    const record = new TheRecord();
    const o = await workTicket(deps(record), settings(), "Add a hello file.");
    expect(o).toMatchObject({ ticket: "T1", end: "passed", costUsd: 0.07 });
    expect(o.branch).toMatch(/^sf\/t1-/);
    expect(g(origin, "show", `${o.branch}:hello.txt`)).toBe("hello from the room");
    expect(g(origin, "log", "-1", "--format=%s", o.branch!)).toBe("T1: Add a hello file.");
    expect(g(origin, "rev-parse", "main")).toBe(g(`${root}/seed`, "rev-parse", "main"));
    const kinds = record.story("T1").map((l) => l.kind);
    expect(kinds[0]).toBe("ticket.opened");
    expect(kinds[1]).toBe("fence.tested");
    expect(kinds).toContain("run.checked");
    expect(kinds.at(-1)).toBe("result.proposed");
    expect(kinds.indexOf("run.ended")).toBeLessThan(kinds.indexOf("result.proposed"));
    for (const l of record.story("T1").slice(2)) expect(l).toMatchObject({ run: o.run, ticket: "T1", project: "o/p" });
    expect(record.story("T1").find((l) => l.kind === "run.ended")!.data).toMatchObject({ end: "passed", nothingLeftRunning: true });
    expect(storyText(record, "T1")).toMatch(/you asked: Add a hello file\.[\s\S]*check passed: test -f hello\.txt[\s\S]*proposed on GitHub/);
  });

  it("with no checks written, asks the project itself, and says in the story what it found", async () => {
    mode("ok");
    const record = new TheRecord();
    const o = await workTicket(deps(record), settings({ checks: [] }), "Add a hello file.");
    expect(o.end).toBe("passed");
    expect(record.story("T1").find((l) => l.kind === "run.started")!.data).toMatchObject({ checks: [], checksFound: [] });
    expect(storyText(record, "T1")).toMatch(/no build or type check was found in the project/);
  });

  it("starts nothing when the fence does not hold", async () => {
    mode("ok");
    const record = new TheRecord();
    const o = await workTicket(deps(record, async () => ({ ...(await okFence()), ok: false })), settings(), "Add a hello file.");
    expect(o).toMatchObject({ end: "not started", run: null });
    expect(record.all().map((l) => l.kind)).toEqual(["ticket.opened", "fence.tested"]);
  });

  it("does not send on work whose check failed", async () => {
    mode("ok");
    const record = new TheRecord();
    const o = await workTicket(deps(record), settings({ checks: ["test -f hello.txt", "test -f missing.txt"] }), "Add a hello file.");
    expect(o.end).toBe("failed its checks");
    expect(o.url).toBeNull();
    expect(record.all().filter((l) => l.kind === "result.proposed")).toHaveLength(0);
  });

  it("parks a ticket when the plan limit is reached, and when the run changed nothing", async () => {
    mode("limit");
    const limited = new TheRecord();
    const a = await workTicket(deps(limited), settings(), "Add a hello file.");
    expect(a).toMatchObject({ end: "parked" });
    expect(a.reason).toMatch(/plan limit/);
    expect(limited.all().find((l) => l.kind === "run.ended")!.data).toMatchObject({ parkedFor: "limit" });
    mode("nothing");
    const b = await workTicket(deps(new TheRecord()), settings({ checks: [] }), "Add a hello file.");
    expect(b).toMatchObject({ end: "parked", reason: "the run changed nothing in the project" });
  });

  it("starts the agent without the project's own settings or outside tools, and ends a run that was handed one", async () => {
    mode("mail");
    const record = new TheRecord();
    const a = await workTicket(deps(record), settings(), "Add a hello file.");
    expect(a).toMatchObject({ end: "crashed" });
    expect(a.reason).toMatch(/tools from outside the room.*mcp__claude_ai_Gmail__send_message/);
    expect(a.pr ?? null).toBeNull();
    const args = readFileSync(join(shim, "args"), "utf8");
    expect(args).toMatch(/--tools Bash,Read,Edit,Write --disable-slash-commands --setting-sources user --strict-mcp-config/);
    expect(args).toMatch(/connectors=false/);
    // A tool from outside that was not listed at the start but is used later ends the run the same way.
    mode("late");
    const b = await workTicket(deps(new TheRecord()), settings(), "Add a hello file.");
    expect(b).toMatchObject({ end: "crashed" });
    expect(b.reason).toMatch(/tools from outside the room.*mcp__claude_ai_Google_Drive__search_files/);
    // A run whose first line never listed its tools is not trusted either.
    mode("blind");
    const c = await workTicket(deps(new TheRecord()), settings(), "Add a hello file.");
    expect(c).toMatchObject({ end: "crashed", reason: "the agent never said which tools it had, so its work is not trusted" });
  });

  it("ignores a hook and a hidden-file list the agent planted, and fails a check that rewrites the work", async () => {
    mode("hook");
    const record = new TheRecord();
    const o = await workTicket(deps(record), settings(), "Add a hello file.");
    expect(o.end).toBe("passed");
    expect(g(origin, "show", `${o.branch}:hello.txt`)).toBe("hello from the room");
    expect(g(origin, "show", `${o.branch}:kept-out.txt`)).toBe("you see me");
    mode("ok");
    const b = await workTicket(deps(new TheRecord()), settings({ checks: ["echo changed > README.md"] }), "Add a hello file.");
    expect(b.end).toBe("failed its checks");
    expect(b.reason).toMatch(/changed while the checks ran/);
  });

  it("does not start, and sends nothing, once stop was pressed", async () => {
    mode("ok");
    const stop = new AbortController(); stop.abort();
    const record = new TheRecord();
    const o = await workTicket({ ...deps(record), signal: stop.signal }, settings(), "Add a hello file.");
    expect(o.end).toBe("stopped");
    expect(record.all().filter((l) => l.kind === "result.proposed")).toHaveLength(0);
  });

  it("finds a project's build, and holds a result that rewrote the very command it was checked with", async () => {
    const seed2 = `${root}/seed2`, origin2 = `${root}/origin2.git`;
    mkdirSync(seed2, { recursive: true });
    g(seed2, "init", "-q", "-b", "main"); g(seed2, "config", "user.email", "a@b.c"); g(seed2, "config", "user.name", "Owner");
    writeFileSync(join(seed2, "package.json"), JSON.stringify({ scripts: { build: "true" } })); writeFileSync(join(seed2, "package-lock.json"), "{}");
    g(seed2, "add", "-A"); g(seed2, "commit", "-q", "-m", "first");
    execFileSync("git", ["clone", "-q", "--bare", seed2, origin2]);
    const d2 = (record: TheRecord) => ({ ...deps(record), github: new GitHub({ dataDir: mkdtempSync(join(tmpdir(), "sf-gh-")), gitUrl: () => origin2 }) });
    const st = settings({ checks: [], repo: { owner: "o", name: "p2" } });
    mode("ok");
    const r1 = new TheRecord();
    const a = await workTicket(d2(r1), st, "Add a hello file.");
    expect(a.end).toBe("passed");
    expect(r1.story("T1").find((l) => l.kind === "run.started")!.data).toMatchObject({ checks: ["npm run build"], prepare: ["npm ci"], checksFound: ["package.json: build"] });
    mode("script");
    const b = await workTicket(d2(new TheRecord()), st, "Add a hello file.");
    expect(b.end).toBe("parked");
    expect(b.reason).toMatch(/changes the "build" command in package\.json/);
  });

  it("holds a result that changes what runs by itself on GitHub, or carries a secret", async () => {
    mode("workflow");
    const r1 = new TheRecord();
    const a = await workTicket(deps(r1), settings(), "Add a hello file.");
    expect(a.end).toBe("parked");
    expect(a.reason).toMatch(/\.github\/workflows\/x\.yml/);
    expect(r1.all().at(-1)!.data).toMatchObject({ held: true });
    mode("secret");
    const b = await workTicket(deps(new TheRecord()), settings(), "Add a hello file.");
    expect(b.reason).toMatch(/secret/);
    expect(g(origin, "branch", "--list", "sf/*").split("\n").filter(Boolean)).toHaveLength(3);
  });
});
