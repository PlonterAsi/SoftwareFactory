import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fenceSettings, setupScript, type FenceSettings } from "./fence/room.js";
import { fenceReportText, runFenceTest, wslExec, type WindowsMark } from "./fence/fencetest.js";

/**
 * The fence from the command line, on the Windows side:
 *   fence test            run the nine tries against the room and print the nine lines (exit 1 unless all hold)
 *   fence setup           write the rules into an existing room, as root, and restart the room
 *   fence setup-script    print the script `setup` runs, to read before running it
 * Settings come from SF_FENCE (JSON, any of the FenceSettings fields). The Claude sign-in for the test's one
 * call comes from CLAUDE_CODE_OAUTH_TOKEN when set; otherwise the room's own sign-in is used.
 */
function settings(): FenceSettings {
  const raw = process.env.SF_FENCE;
  return fenceSettings(raw ? (JSON.parse(raw) as Partial<FenceSettings>) : {});
}

/** `wsl.exe -l -q` answers in UTF-16; node reads it as bytes. */
export function roomExists(room: string, list: Buffer): boolean {
  const text = list.includes(0) ? list.toString("utf16le") : list.toString("utf8");
  return text.split(/\r?\n/).map((l) => l.replace(/\0/g, "").trim()).includes(room);
}

/** Line 3 really tries: cmd.exe is handed in and told to leave a small file in the Public folder. No file, no hole. */
export function windowsProbe(): { windowsProgram?: Buffer; windowsMark?: WindowsMark } {
  const cmdExe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
  const markFile = join(process.env.PUBLIC ?? "C:\\Users\\Public", `sf-fence-mark-${process.pid}.txt`);
  if (!existsSync(cmdExe) || !/^[A-Za-z]:[\\/][A-Za-z0-9\\/._-]+$/.test(markFile)) return {};
  return { windowsProgram: readFileSync(cmdExe), windowsMark: { path: markFile.replace(/\\/g, "/"), exists: () => existsSync(markFile), remove: () => rmSync(markFile, { force: true }) } };
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const s = settings();
  if (cmd === "setup-script") { process.stdout.write(setupScript(s)); return; }
  if (cmd !== "test" && cmd !== "setup") { console.error("usage: fence test | setup | setup-script"); process.exit(2); }
  const list = spawnSync("wsl.exe", ["-l", "-q"], { windowsHide: true });
  if (list.error || !roomExists(s.room, list.stdout ?? Buffer.alloc(0))) {
    console.error(`The room "${s.room}" does not exist on this computer yet. No run starts.`);
    process.exit(1);
  }
  const exec = wslExec(s);
  if (cmd === "setup") {
    const r = await exec("root", setupScript(s), 15 * 60_000);
    process.stdout.write(r.stdout); process.stderr.write(r.stderr);
    if (r.code !== 0 || !/room ready/.test(r.stdout)) process.exit(1);
    // wsl.conf is read when the room starts, so the room is stopped; the next call starts it with the new rules.
    spawnSync("wsl.exe", ["--terminate", s.room], { windowsHide: true });
    return;
  }
  const report = await runFenceTest(exec, s, { ...(process.env.CLAUDE_CODE_OAUTH_TOKEN ? { token: process.env.CLAUDE_CODE_OAUTH_TOKEN } : {}), ...windowsProbe() });
  console.log(fenceReportText(report));
  // `fence test --details` adds the fact behind every line, also the ones that passed.
  if (process.argv.includes("--details")) for (const l of report.lines) console.log(`   ${l.n}. ${l.verdict}: ${l.detail}`);
  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && /fence-cli\.(ts|js)$/.test(process.argv[1])) void main();
