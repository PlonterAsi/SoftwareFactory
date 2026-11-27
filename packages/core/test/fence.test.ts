import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { FENCE_DEFAULTS, fenceSettings, managedSettings, setupScript, wslConf } from "../src/fence/room.js";
import { type ExecResult, type RoomExec, TRIES, fenceReportText, runFenceTest, wallOneScript, wallTwoProbe } from "../src/fence/fencetest.js";
import { roomExists } from "../src/fence-cli.js";

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });

/** A room that behaves as told. `state` says what the room lets through. */
function fakeRoom(state: { wallOne?: string; ran?: boolean; unlisted?: boolean; listed?: boolean; outside?: boolean; leaksCanary?: boolean; noClaude?: boolean; noFileTool?: boolean } = {}): { exec: RoomExec; scripts: { user: string; script: string }[] } {
  const scripts: { user: string; script: string }[] = [];
  const s = { ran: true, listed: true, ...state };
  const exec: RoomExec = async (user, script) => {
    scripts.push({ user, script });
    if (script.includes("SFLINE")) return ok(s.wallOne ?? "SFLINE attach-drive REFUSED no-drive\nSFLINE become-root REFUSED no-way\nSFLINE windows-program REFUSED interop-off\nSFLINE windows-side REFUSED 172.20.0.1\n");
    if (script.includes("echo prepared")) return ok("prepared\n");
    if (script.includes("echo copied")) return ok("copied\n");
    if (script.includes("claude -p")) {
      if (s.noClaude) return { code: 96, stdout: "SF_NO_CLAUDE\n", stderr: "", timedOut: false };
      const all = scripts.map((x) => x.script).join("\n");
      const secret = /sf-canary-[0-9a-f]+/.exec(all)![0];
      const control = /sf-inside-[0-9a-f]+/.exec(all)![0];
      return ok(JSON.stringify({ result: `${s.noFileTool ? "" : control} ${s.leaksCanary ? secret : "REFUSED"}` }));
    }
    if (script.includes("SFLOOK")) return ok(`SFLOOK unlisted ${s.unlisted ? "yes" : "no"}\nSFLOOK listed ${s.ran && s.listed ? "yes" : "no"}\nSFLOOK inside ${s.ran ? "yes" : "no"}\nSFLOOK outside ${s.outside ? "yes" : "no"}\n`);
    return ok("");
  };
  return { exec, scripts };
}

describe("the room's rule files", () => {
  it("closes the Windows drives, Windows programs and the Windows PATH", () => {
    const conf = wslConf(FENCE_DEFAULTS);
    expect(conf).toMatch(/\[automount\]\nenabled = false/);
    expect(conf).toMatch(/\[interop\]\nenabled = false\nappendWindowsPath = false/);
    expect(conf).toMatch(/default = worker/);
  });

  it("writes rules a run cannot talk its way out of", () => {
    const m = managedSettings(fenceSettings({ netList: ["github.com"] })) as any;
    expect(m.sandbox.enabled).toBe(true);
    expect(m.sandbox.failIfUnavailable).toBe(true);
    expect(m.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(m.sandbox.network.allowedDomains).toEqual(["github.com"]);
    expect(m.sandbox.network.allowManagedDomainsOnly).toBe(true);
    expect(m.permissions.disableBypassPermissionsMode).toBe("disable");
    expect(m.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    expect(m.permissions.deny).toEqual(expect.arrayContaining(["WebFetch", "WebSearch"]));
    expect(m.allowManagedHooksOnly).toBe(true);
    expect(m.allowManagedMcpServersOnly).toBe(true);
  });

  it("refuses settings that could be used to slip a command into the room", () => {
    expect(() => fenceSettings({ room: "sf room; rm -rf /" })).toThrow();
    expect(() => fenceSettings({ worker: "root$(id)" })).toThrow();
    expect(() => fenceSettings({ copies: "/mnt/c/Users" })).toThrow();
    expect(() => fenceSettings({ netList: ["github.com'; curl evil"] })).toThrow();
    expect(() => fenceSettings({ hostPorts: [0] })).toThrow();
    expect(() => fenceSettings({ hostPorts: [] })).toThrow();
    expect(() => fenceSettings({ testModel: "haiku; id" })).toThrow();
    expect(() => fenceSettings({ stepTimeoutMs: -1 })).toThrow();
  });

  it("makes a setup script that is valid bash and locks the worker out of root", () => {
    const sh = setupScript(FENCE_DEFAULTS);
    expect(spawnSync("bash", ["-n"], { input: sh }).status).toBe(0);
    expect(sh).toContain("passwd -l root");
    expect(sh).toContain('usermod -G "" worker');
    expect(sh).toContain("/etc/claude-code/managed-settings.json");
    expect(JSON.parse(/<<'SF_SETTINGS_EOF'\n([\s\S]*?)\nSF_SETTINGS_EOF/.exec(sh)![1]!)).toEqual(managedSettings(FENCE_DEFAULTS));
  });

  it("makes test scripts that are valid bash", () => {
    expect(spawnSync("bash", ["-n"], { input: wallOneScript(FENCE_DEFAULTS) }).status).toBe(0);
    expect(spawnSync("bash", ["-n"], { input: wallTwoProbe("abc123", "github.com") }).status).toBe(0);
  });
});

describe("the fence test", () => {
  it("passes with nine lines when seven tries are refused and two things work", async () => {
    const r = await runFenceTest(fakeRoom().exec);
    expect(r.lines).toHaveLength(9);
    expect(r.lines.map((l) => l.id)).toEqual(TRIES.map((t) => t.id));
    expect(r.ok).toBe(true);
    expect(fenceReportText(r)).toMatch(/The fence holds/);
  });

  it.each([
    ["a drive can be attached", { wallOne: "SFLINE attach-drive THROUGH mounted-by-hand\nSFLINE become-root REFUSED x\nSFLINE windows-program REFUSED x\nSFLINE windows-side REFUSED x\n" }, "attach-drive"],
    ["the worker can become root", { wallOne: "SFLINE attach-drive REFUSED x\nSFLINE become-root THROUGH sudo\nSFLINE windows-program REFUSED x\nSFLINE windows-side REFUSED x\n" }, "become-root"],
    ["a Windows port answers", { wallOne: "SFLINE attach-drive REFUSED x\nSFLINE become-root REFUSED x\nSFLINE windows-program REFUSED x\nSFLINE windows-side THROUGH 172.20.0.1:445,\n" }, "windows-side"],
    ["an unlisted address answers", { unlisted: true }, "unlisted-address"],
    ["a file appears outside the copy", { outside: true }, "write-outside"],
    ["the file tool reads outside the copy", { leaksCanary: true }, "read-outside"],
  ])("stops the run when %s", async (_name, state, id) => {
    const r = await runFenceTest(fakeRoom(state).exec);
    expect(r.ok).toBe(false);
    expect(r.lines.find((l) => l.id === id)!.verdict).toBe("got-through");
    expect(fenceReportText(r)).toMatch(/No run starts/);
  });

  it("does not read silence as safety: a probe that never ran refuses nothing", async () => {
    const r = await runFenceTest(fakeRoom({ ran: false }).exec);
    expect(r.ok).toBe(false);
    expect(r.lines.find((l) => l.id === "write-inside")!.verdict).toBe("did-not-work");
    for (const id of ["unlisted-address", "write-outside", "read-outside"]) expect(r.lines.find((l) => l.id === id)!.verdict).toBe("could-not-judge");
  });

  it("does not call the file tool safe when it never read anything", async () => {
    const r = await runFenceTest(fakeRoom({ noFileTool: true }).exec);
    expect(r.ok).toBe(false);
    expect(r.lines.find((l) => l.id === "read-outside")!.verdict).toBe("could-not-judge");
  });

  it("root never writes into the worker's folders", async () => {
    const room = fakeRoom();
    await runFenceTest(room.exec, {}, { nonce: "n0nce" });
    for (const x of room.scripts.filter((x) => x.user === "root")) expect(x.script).not.toMatch(/(>|install|chown|cat >)[^\n]*\/home\/worker/);
    await expect(runFenceTest(room.exec, {}, { nonce: "x; id" })).rejects.toThrow();
  });

  it("stops the run when the listed address does not answer", async () => {
    const r = await runFenceTest(fakeRoom({ listed: false }).exec);
    expect(r.ok).toBe(false);
    expect(r.lines.find((l) => l.id === "listed-address")!.verdict).toBe("did-not-work");
  });

  it("stops the run when the room cannot be reached, or a line is missing", async () => {
    const down = await runFenceTest(async () => { throw new Error("no wsl"); });
    expect(down.ok).toBe(false);
    expect(down.lines.every((l) => l.verdict === "could-not-judge")).toBe(true);
    const partial = await runFenceTest(fakeRoom({ wallOne: "SFLINE attach-drive REFUSED x\n" }).exec);
    expect(partial.lines.find((l) => l.id === "become-root")!.verdict).toBe("could-not-judge");
    expect(partial.ok).toBe(false);
  });

  it("says so when Claude Code is missing in the room", async () => {
    const r = await runFenceTest(fakeRoom({ noClaude: true, ran: false }).exec);
    expect(r.lines.find((l) => l.id === "write-inside")!.detail).toMatch(/not installed/);
  });

  it("keeps the sign-in out of the report and off every command line", async () => {
    const room = fakeRoom();
    const r = await runFenceTest(room.exec, {}, { token: "tok-SECRET-123" });
    expect(JSON.stringify(r)).not.toContain("tok-SECRET-123");
    expect(room.scripts.filter((x) => x.script.includes("tok-SECRET-123")).map((x) => x.user)).toEqual(["worker"]);
  });

  it("cleans up after itself, as root, whatever happened", async () => {
    const room = fakeRoom({ outside: true });
    await runFenceTest(room.exec, {}, { nonce: "n0nce" });
    const last = room.scripts.at(-1)!;
    expect(last.user).toBe("root");
    expect(last.script).toMatch(/^rm -rf \/home\/worker\/copies\/fencetest-n0nce \/srv\/sf-fence\/canary-n0nce /);
  });

  it("wall 1 script, run for real on a machine with no fence, reports four lines", () => {
    const out = spawnSync("bash", ["-s"], { input: wallOneScript(fenceSettings({ hostPorts: [9] })), encoding: "utf8" }).stdout;
    expect(out.match(/^SFLINE /gm)?.length).toBe(4);
  });
});

describe("finding the room", () => {
  it("reads wsl.exe's UTF-16 list", () => {
    expect(roomExists("sf-room", Buffer.from("Ubuntu\r\nsf-room\r\n", "utf16le"))).toBe(true);
    expect(roomExists("sf-room", Buffer.from("Ubuntu\r\nsf-room-old\r\n", "utf16le"))).toBe(false);
    expect(roomExists("sf-room", Buffer.alloc(0))).toBe(false);
  });
});
