import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { GitHub, ghCliToken, parseGitHubRepo } from "./tickets/github.js";
import { fenceReportText, runFenceTest, wslExec, wslFiles } from "./fence/fencetest.js";
import { fenceSettings, type FenceSettings } from "./fence/room.js";
import { TheRecord } from "./fence/record.js";
import { storyText, workTicket, type TicketSettings } from "./fence/ticketrun.js";
import { windowsProbe } from "./fence-cli.js";
import { createHome, settingsFileIn } from "./fence/home.js";

/**
 * Build step 1 from the command line, on the Windows side, until the home screen exists (slice 3):
 *   step1 work "<one sentence>"     one ticket: fence test, a run in the room, a proposal on GitHub
 *   step1 story <ticket>            the story of a ticket from the record
 *   step1 home [--port N] [--no-open]   the home screen, on this computer only (127.0.0.1)
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
    const home = createHome({
      record, github, settings: settingsFileIn(workDir, { ...start, ...(raw.repo ? { repo: raw.repo } : {}) }),
      hosts: [`127.0.0.1:${port}`, `localhost:${port}`], fence: { room: fence.room, netList: fence.netList },
      work: (st, sentence, signal) => workTicket({ exec, files, record, fence, signal, github, fenceTest: () => runFenceTest(exec, fence, windowsProbe()) }, { ...st, workDir }, sentence),
    });
    const server = createServer((req, res) => { void home.handler(req, res); });
    server.listen(port, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${port}/?pass=${home.pass}`;
      console.log(`SoftwareFactory home screen: ${url}\nClose this window to close SoftwareFactory.`);
      if (process.platform === "win32" && !args.includes("--no-open")) spawn("cmd.exe", ["/c", "start", "", url], { stdio: "ignore", windowsHide: true, detached: true }).unref();
    });
    // Closing the window while a run works is a stop: nothing is left running in the room.
    // (Windows sends SIGHUP when the console window is closed, and gives a few seconds.)
    const bye = () => { if (home.isRunning()) { home.stop(); setTimeout(() => process.exit(0), 4000); } else process.exit(0); };
    for (const sig of ["SIGINT", "SIGHUP", "SIGBREAK", "SIGTERM"] as const) process.once(sig, bye);
    return;
  }
  if (cmd !== "work" || !arg?.trim()) { console.error('usage: step1 work "<one sentence>" | step1 story <ticket> | step1 home'); process.exit(2); }
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
