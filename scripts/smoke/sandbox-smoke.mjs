#!/usr/bin/env node
// Runs the Windows smoke test (windows-smoke.mjs) inside a disposable Windows Sandbox.
//
// Why: the smoke test installs and uninstalls SoftwareFactory, moves its data folder aside and
// uses the app's own port. On GitHub's machines that is harmless. On a runner on your own PC it
// would break the SoftwareFactory you use. A Windows Sandbox is a clean, throwaway Windows with
// its own files, registry and network ports, so the test runs there and the PC is never touched.
//
// How: everything the test needs goes into one shared folder (the installers, the scripts,
// Node.js), Git is shared read-only from the PC, and the sandbox runs the test at sign-in.
// The test's output comes back through the shared folder; this script waits for it, prints it,
// closes the sandbox and exits with the test's own exit code.
//
// Needs Windows 10/11 Pro with the Windows Sandbox feature on, and a signed-in desktop (the
// sandbox opens a window). One sandbox runs at a time.
//
// Usage: the same arguments as windows-smoke.mjs, plus --timeout-min (default 25):
//   node scripts/smoke/sandbox-smoke.mjs --installer out/SoftwareFactory-setup.exe --portable out/SoftwareFactory-portable.zip \
//     [--old-installer ... --update-sig ... --version 0.2.41] --out smoke-out

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]?.startsWith("--") ? "1" : all[i + 1] ?? "1"]] : acc), []));
const OUT = resolve(args.out ?? "smoke-out");
const TIMEOUT_MS = Number(args["timeout-min"] ?? 25) * 60_000;
const SANDBOX_EXE = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsSandbox.exe");
const log = (...a) => console.log(`[sandbox ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (script) => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
const fail = (msg) => { console.error(`::error title=Sandbox smoke test::${msg}`); process.exit(1); };

/** Files the test is given, by its own argument names. Each is copied into the share and passed on by its new path. */
const FILE_ARGS = ["installer", "portable", "old-installer", "update-sig"];

/** The .wsb file: what the sandbox shares with the PC and what it runs at sign-in. Exported for the test. */
export function wsbConfig({ share, git }) {
  const folder = (host, inside, readOnly) => `    <MappedFolder><HostFolder>${host}</HostFolder><SandboxFolder>${inside}</SandboxFolder><ReadOnly>${readOnly}</ReadOnly></MappedFolder>`;
  return [
    "<Configuration>",
    "  <MappedFolders>",
    folder(share, "C:\\sf", false),
    ...(git ? [folder(git, "C:\\git", true)] : []),
    "  </MappedFolders>",
    // Nothing of the PC's is offered to code under test beyond the two folders above.
    // No network: the test needs none (its update server is inside the sandbox), and the app under test must
    // not find a real newer version and update itself mid-test. Code under test cannot reach the PC's network either.
    "  <Networking>Disable</Networking>",
    "  <ClipboardRedirection>Disable</ClipboardRedirection>",
    "  <PrinterRedirection>Disable</PrinterRedirection>",
    "  <AudioInput>Disable</AudioInput>",
    "  <VideoInput>Disable</VideoInput>",
    "  <LogonCommand><Command>cmd.exe /d /c C:\\sf\\run.cmd</Command></LogonCommand>",
    "</Configuration>",
    "",
  ].join("\r\n");
}

/** What runs inside: copy the installers to the sandbox's own disk, run the test, leave its exit code where the PC can read it. Exported for the test. */
export function runCmd(smokeArgs) {
  return [
    "@echo off",
    "set PATH=C:\\sf\\node;C:\\git\\cmd;C:\\git\\bin;%PATH%",
    "set CI=1",
    "mkdir C:\\work",
    "robocopy C:\\sf\\in C:\\work\\in /E /NFL /NDL /NJH /NJS /NP >nul",
    "robocopy C:\\sf\\scripts C:\\work\\scripts /E /NFL /NDL /NJH /NJS /NP >nul",
    "cd /d C:\\work",
    // The test writes on the sandbox's own disk (it watches folders there); only its console goes straight to the PC.
    `node scripts\\smoke\\windows-smoke.mjs ${smokeArgs.join(" ")} --out C:\\work\\out > C:\\sf\\out\\console.log 2>&1`,
    "set SMOKE_CODE=%ERRORLEVEL%",
    "robocopy C:\\work\\out C:\\sf\\out /E /NFL /NDL /NJH /NJS /NP /XD drop >nul",
    "echo %SMOKE_CODE% > C:\\sf\\out\\exit-code.tmp",
    "move /y C:\\sf\\out\\exit-code.tmp C:\\sf\\out\\exit-code >nul",
    "",
  ].join("\r\n");
}

function sandboxRunning() {
  const r = ps("@(Get-Process -Name WindowsSandboxRemoteSession,WindowsSandboxClient,WindowsSandbox -ErrorAction SilentlyContinue).Count");
  return Number(String(r.stdout).trim()) > 0;
}
function closeSandbox() {
  ps("Get-Process -Name WindowsSandboxRemoteSession,WindowsSandboxClient,WindowsSandbox -ErrorAction SilentlyContinue | Stop-Process -Force");
}
function gitDir() {
  const r = spawnSync("where", ["git"], { encoding: "utf8" });
  const first = String(r.stdout ?? "").split(/\r?\n/).find((l) => l.trim());
  // ...\Git\cmd\git.exe -> ...\Git
  return r.status === 0 && first ? dirname(dirname(first.trim())) : null;
}

async function main() {
  if (process.platform !== "win32") fail("The sandbox smoke test runs on Windows only.");
  if (!existsSync(SANDBOX_EXE)) fail("Windows Sandbox is not turned on on this PC (Windows features, Windows Sandbox). The smoke test never runs outside a sandbox on a PC with real work.");
  for (const k of ["installer", "portable"]) if (!args[k] || !existsSync(args[k])) fail(`--${k} is missing or not a file: ${args[k] ?? ""}`);
  const git = gitDir();
  if (!git) fail("Git was not found on this PC; the test builds a git repository inside the sandbox.");
  if (sandboxRunning()) fail("A Windows Sandbox is already open on this PC, and only one can run at a time. Close it and run the job again.");

  // The share: a new folder per run, next to the output.
  const share = resolve(args.share ?? join(process.env.RUNNER_TEMP ?? dirname(OUT), `sf-sandbox-${Date.now()}`));
  for (const d of ["in", "out", "node", "scripts"]) mkdirSync(join(share, d), { recursive: true });
  const smokeArgs = [];
  for (const [k, v] of Object.entries(args)) {
    if (["out", "share", "timeout-min", "keep-share"].includes(k)) continue;
    if (FILE_ARGS.includes(k)) {
      copyFileSync(v, join(share, "in", basename(v)));
      smokeArgs.push(`--${k}`, `in\\${basename(v)}`);
    } else smokeArgs.push(`--${k}`, String(v));
  }
  const here = dirname(fileURLToPath(import.meta.url));
  cpSync(resolve(here, ".."), join(share, "scripts"), { recursive: true });
  copyFileSync(process.execPath, join(share, "node", "node.exe"));
  writeFileSync(join(share, "run.cmd"), runCmd(smokeArgs));
  const wsb = join(share, "smoke.wsb");
  writeFileSync(wsb, wsbConfig({ share, git }));
  log(`share ${share}; Git from ${git} (read-only); node ${process.version}`);

  const started = Date.now();
  log("opening a Windows Sandbox (a window appears on the desktop; nothing in it needs a click)");
  spawn(SANDBOX_EXE, [wsb], { detached: true, stdio: "ignore" }).unref();

  // Follow the test's console as it grows, until its exit code appears.
  const consoleFile = join(share, "out", "console.log");
  const codeFile = join(share, "out", "exit-code");
  let read = 0;
  const pump = () => {
    try {
      const size = statSync(consoleFile).size;
      if (size <= read) return;
      const fd = openSync(consoleFile, "r");
      const buf = Buffer.alloc(size - read);
      readSync(fd, buf, 0, buf.length, read);
      closeSync(fd);
      read = size;
      process.stdout.write(buf.toString("utf8"));
    } catch { /* not written yet */ }
  };
  let code = null;
  let seenSandbox = false;
  try {
    while (Date.now() - started < TIMEOUT_MS) {
      await sleep(2000);
      pump();
      if (existsSync(codeFile)) { code = Number(readFileSync(codeFile, "utf8").trim()); break; }
      const up = sandboxRunning();
      seenSandbox ||= up;
      // Closed by hand, or it never came up.
      if (seenSandbox && !up) { await sleep(3000); pump(); if (existsSync(codeFile)) code = Number(readFileSync(codeFile, "utf8").trim()); break; }
      if (!seenSandbox && Date.now() - started > 240_000) break;
    }
  } finally {
    pump();
    closeSandbox();
    log(`sandbox closed after ${Math.round((Date.now() - started) / 1000)} s`);
  }

  // The report, logs and screenshots, where the workflow expects them.
  mkdirSync(OUT, { recursive: true });
  for (const f of readdirSync(join(share, "out"))) {
    try { cpSync(join(share, "out", f), join(OUT, f), { recursive: true }); } catch { /* a file still held open */ }
  }
  if (process.env.GITHUB_STEP_SUMMARY && existsSync(join(OUT, "report.md"))) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Ran inside a Windows Sandbox on this PC.\n\n${readFileSync(join(OUT, "report.md"), "utf8")}\n`);
  }
  if (!args["keep-share"]) { try { rmSync(share, { recursive: true, force: true }); } catch { /* the sandbox may hold it a moment longer */ } }

  if (code === null) fail(seenSandbox ? `The test did not finish inside the sandbox within ${Math.round(TIMEOUT_MS / 60_000)} minutes, or the sandbox was closed. Its console so far is above.` : "The Windows Sandbox did not start within 4 minutes. Is someone signed in at this PC's desktop?");
  log(`the smoke test ended with code ${code}`);
  process.exit(code === 0 ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
