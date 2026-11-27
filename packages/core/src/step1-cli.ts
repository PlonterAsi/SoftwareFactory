import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { GitHub, ghCliToken, parseGitHubRepo } from "./tickets/github.js";
import { fenceReportText, runFenceTest, wslExec, wslFiles } from "./fence/fencetest.js";
import { fenceSettings, type FenceSettings } from "./fence/room.js";
import { TheRecord } from "./fence/record.js";
import { history, plainGit, storyText, workTicket, type TicketSettings } from "./fence/ticketrun.js";
import { askGate } from "./fence/gate.js";
import { windowsProbe } from "./fence-cli.js";
import { createHome, settingsFileIn } from "./fence/home.js";
import { undoTicket } from "./fence/undo.js";
import { cleanWatch, readAlive, runWatchdog, speak, writeAlive } from "./fence/watchdog.js";

/**
 * Build step 1 from the command line, on the Windows side, until the home screen exists (slice 3):
 *   step1 work "<one sentence>"     one ticket: fence test, a run in the room, a proposal on GitHub
 *   step1 story <ticket>            the story of a ticket from the record
 *   step1 home [--port N] [--no-open]   the home screen, on this computer only (127.0.0.1)
 *   step1 watchdog                  the watcher beside SoftwareFactory: speaks when it went away mid-run or a run fell silent
 * Settings: SF_STEP1 (JSON: repo "owner/name", base, checks, prepare, model, maxTurns, timeLimitMinutes, workDir)
 * and SF_FENCE (JSON, the fence settings).
 */
const DEFAULTS = { base: "", checks: [] as string[], prepare: [] as string[], model: "sonnet", maxTurns: 80, timeLimitMinutes: 45 };

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  const raw = JSON.parse(process.env.SF_STEP1 ?? "{}") as Partial<Omit<TicketSettings, "repo">> & { repo?: string };
  const workDir = raw.workDir ?? join(process.env.LOCALAPPDATA ?? homedir(), "SoftwareFactoryStep1");
  mkdirSync(workDir, { recursive: true });
  const record = new TheRecord(join(workDir, "record.db"));
  if (cmd === "story" && arg) { console.log(storyText(record, arg)); return; }
  if (cmd === "watchdog") {
    const fence: FenceSettings = fenceSettings(JSON.parse(process.env.SF_FENCE ?? "{}") as Partial<FenceSettings>);
    const exec = wslExec(fence);
    const settings = settingsFileIn(workDir);
    // One watchdog at a time: a second one would say everything twice.
    // The one that watches renews its mark at every look; a mark that is not renewed belongs to nobody, whatever
    // process number it carries. A watchdog that is just going home gets a few seconds to leave before this one gives way.
    const lock = join(workDir, "watchdog.pid");
    const taken = () => { try { return existsSync(lock) && Number(readFileSync(lock, "utf8")) !== process.pid && Date.now() - statSync(lock).mtimeMs < 12_000; } catch { return false; } };
    for (let i = 0; i < 8 && taken(); i++) await new Promise((ok) => setTimeout(ok, 2500));
    if (taken()) { console.log("A watchdog is watching already."); return; }
    const mark = () => writeFileSync(lock, String(process.pid));
    mark();
    console.log("SoftwareFactory's watchdog is watching. It closes by itself when SoftwareFactory is closed.");
    await runWatchdog({
      record, workDir, settings: () => cleanWatch(settings.read()),
      endRoom: async () => { await exec("root", `pkill -KILL -u ${fence.worker} >/dev/null 2>&1; true`, 30_000); },
      tick: mark,
    });
    try { if (Number(readFileSync(lock, "utf8")) === process.pid) rmSync(lock, { force: true }); } catch { /* an unrenewed mark counts for nothing anyway */ }
    return;
  }
  if (cmd === "home") {
    const args = process.argv.slice(3);
    const port = Number(args[args.indexOf("--port") + 1]) > 0 && args.includes("--port") ? Number(args[args.indexOf("--port") + 1]) : 4517;
    const asked: FenceSettings = fenceSettings(JSON.parse(process.env.SF_FENCE ?? "{}") as Partial<FenceSettings>);
    // The home screen's own port joins the ports the fence test tries from the room: if a run could reach
    // this page, the test fails and no run starts.
    const fence: FenceSettings = { ...asked, hostPorts: [...new Set([...asked.hostPorts, port])] };
    const exec = wslExec(fence), files = wslFiles(fence);
    const github = new GitHub({ dataDir: workDir, cli: ghCliToken });
    const { repo: _r, workDir: _w, ...start } = raw;
    let cleared: Promise<void> = Promise.resolve();
    const home = createHome({
      record, github, settings: settingsFileIn(workDir, { ...start, ...(raw.repo ? { repo: raw.repo } : {}) }),
      hosts: [`127.0.0.1:${port}`, `localhost:${port}`], fence: { room: fence.room, netList: fence.netList },
      undo: (ticket) => undoTicket({ record, github, workDir }, ticket),
      // The reader at the gate sees the sentence and the project's file names, and works in the room like every agent.
      gate: async (q) => { await cleared; const h = history({ github }, { repo: q.repo, base: q.base, workDir }); const files = plainGit(h.dir, "ls-tree", "-r", "--name-only", "-z", `refs/heads/${h.base}`).split("\0").filter(Boolean); return askGate(exec, fence, { sentence: q.sentence, files, asked: q.asked ?? undefined, model: q.model }); },
      // A run of this start waits until the room was cleared of an earlier start's leftovers.
      work: async (st, ticket, sentence, signal) => (await cleared, workTicket({ exec, files, record, fence, signal, github, fenceTest: () => runFenceTest(exec, fence, windowsProbe()) }, { ...st, workDir }, sentence, ticket)),
    });
    home.watchIssues();
    // The two things SoftwareFactory itself says out loud.
    let beat: ReturnType<typeof setInterval> | null = null, ours = false;
    const say = (line: string, ticket: string | null, why: string) => void speak({ record, settings: () => cleanWatch(home.state().settings) }, { line, ticket, why });
    record.onLine((l) => {
      const d = l.data as Record<string, any>;
      if (l.kind === "fence.tested" && d.ok === false) say(`The fence did not hold, so ${l.ticket ?? "the ticket"} was not started.`, l.ticket, "fence");
      if (l.kind === "run.ended" && d.end === "parked" && /limit/i.test(String(d.reason ?? ""))) say(`${l.ticket ?? "A ticket"} is parked: ${/plan limit/i.test(String(d.reason)) ? "the plan limit was reached" : "a limit of the run was reached"}.`, l.ticket, "limit");
    });
    // Another SoftwareFactory that is open right now keeps its room, its run and its sign of life: this start
    // touches none of them and steps back.
    const before = readAlive(workDir);
    // A sign of life whose process is gone (a crash a moment ago) is nobody's: this start goes on and takes over.
    const lives = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
    const otherIsOpen = !!before && !before.closed && before.pid !== process.pid && Date.now() - new Date(before.at).getTime() < 15_000 && lives(before.pid);
    if (otherIsOpen) { console.error("SoftwareFactory is open already. Use its window, or close it first."); process.exit(1); }
    const server = createServer((req, res) => { void home.handler(req, res); });
    server.once("error", (e) => { console.error((e as NodeJS.ErrnoException).code === "EADDRINUSE" ? `Port ${port} is taken, so SoftwareFactory did not start. Nothing was touched.` : `SoftwareFactory did not start: ${(e as Error).message}`); process.exit(1); });
    server.listen(port, "127.0.0.1", () => {
      // Only now is this start the one: the port is ours.
      ours = true;
      // A fresh start owns no run. Whatever an earlier SoftwareFactory left working in the room is ended, and when
      // that earlier one went away in the middle of a ticket and nobody said so yet, it is said: after the clearing,
      // and truthfully when the room could not be reached.
      let reached = true;
      cleared = exec("root", `pkill -KILL -u ${fence.worker} >/dev/null 2>&1; echo cleared`, 30_000).then((r) => { reached = /cleared/.test(r.stdout); }, () => { reached = false; });
      if (before?.running && !before.closed) {
        const t = before.running.ticket;
        void cleared.then(() => {
          const said = t ? record.story(t).some((l) => l.kind === "watchdog.spoke" && (l.data as Record<string, unknown>).why === "gone") : false;
          if (!said || !reached) say(reached ? `SoftwareFactory went away while ${t ?? "a ticket"} was being worked. The run was ended; nothing left the computer.` : `SoftwareFactory went away while ${t ?? "a ticket"} was being worked, and the room could not be reached to end the run. Restart the computer's WSL, or look into the room.`, t, reached ? "gone" : "room unreachable");
        });
      }
      beat = setInterval(() => { try { writeAlive(workDir, home.alive()); } catch { /* the next beat tries again */ } }, 5000);
      beat.unref();
      writeAlive(workDir, home.alive());
      // Tickets that still waited when SoftwareFactory was closed take their turn again.
      void cleared.then(() => home.pump());
      const url = `http://127.0.0.1:${port}/?pass=${home.pass}`;
      console.log(`SoftwareFactory home screen: ${url}${process.env.SF_SHELL === "1" ? "" : "\nClose this window to close SoftwareFactory."}`);
      if (process.platform === "win32" && !args.includes("--no-open")) spawn("cmd.exe", ["/c", "start", "", url], { stdio: "ignore", windowsHide: true, detached: true }).unref();
    });
    // Closing the window while a run works is a stop: nothing is left running in the room.
    // (Windows sends SIGHUP when the console window is closed, and gives a few seconds.)
    // Said first, before anything slow: Windows gives a closing window only a few seconds.
    const closed = () => { try { writeAlive(workDir, { ...home.alive(), closed: true }); } catch { /* the watchdog then speaks, which is the safe side */ } };
    let leaving = false;
    const bye = () => { if (leaving) return; leaving = true; if (!ours) process.exit(0); if (beat) clearInterval(beat); closed(); home.close(); if (home.isRunning()) { home.stop(); setTimeout(() => process.exit(0), 4000); } else process.exit(0); };
    for (const sig of ["SIGINT", "SIGHUP", "SIGBREAK", "SIGTERM"] as const) process.once(sig, bye);
    // Inside the installed app there is no console to close. The app holds a pipe to this process instead, and the
    // pipe ends when the app's window is closed or the app is gone for any reason: that is the same goodbye.
    if (process.env.SF_SHELL === "1") { process.stdin.on("end", bye); process.stdin.on("close", bye); process.stdin.on("error", bye); process.stdin.resume(); }
    return;
  }
  if (cmd !== "work" || !arg?.trim()) { console.error('usage: step1 work "<one sentence>" | step1 story <ticket> | step1 home | step1 watchdog'); process.exit(2); }
  const repo = parseGitHubRepo(raw.repo ?? "");
  if (!repo) { console.error('SF_STEP1 must name the project, for example {"repo":"owner/name"}'); process.exit(2); }
  const fence: FenceSettings = fenceSettings(JSON.parse(process.env.SF_FENCE ?? "{}") as Partial<FenceSettings>);
  const st: TicketSettings = { ...DEFAULTS, ...raw, repo, workDir };
  const exec = wslExec(fence), files = wslFiles(fence);
  const stop = new AbortController();
  // Ctrl+C is the stop button until there is a screen: the run is killed inside the room, the record says so.
  process.once("SIGINT", () => { record.append({ kind: "stop.pressed", who: "you", data: {} }); stop.abort(); });
  record.onLine((l) => { if (l.ticket) console.log(storyText(record, l.ticket).split("\n").at(-1)); });
  const outcome = await workTicket({
    exec, files, record, fence, signal: stop.signal,
    github: new GitHub({ dataDir: workDir, cli: ghCliToken }),
    fenceTest: async () => { const r = await runFenceTest(exec, fence, windowsProbe()); console.log(fenceReportText(r)); return r; },
  }, st, arg);
  console.log(`\n${outcome.ticket}: ${outcome.end}. ${outcome.reason}${outcome.url ? `\n${outcome.url}` : ""}\nCost of the run: $${outcome.costUsd.toFixed(2)}`);
  process.exit(outcome.end === "passed" ? 0 : 1);
}

if (process.argv[1] && /step1-cli\.(ts|js)$/.test(process.argv[1])) void main();
