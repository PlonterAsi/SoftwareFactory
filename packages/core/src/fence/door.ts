import { randomBytes } from "node:crypto";
import type { ExecResult, RoomExec, RoomFiles } from "./fencetest.js";
import { type Cell, ownCell, wholeRoom } from "./cell.js";
import { AGENT_ENV, AGENT_FLAGS, AGENT_TOOLS, type FenceSettings, fenceSettings, looksLikeLimit } from "./room.js";
export { AGENT_FLAGS, looksLikeLimit } from "./room.js";
import type { RunEnd, TheRecord } from "./record.js";

/**
 * The one door (build step 1, slice 2): how a ticket's work goes into the room and comes back.
 *
 * In: a copy of the project as one git bundle file, and the person's sentence. Out: events while the run
 * works, and at the end one git bundle with the new commits. Both ways it is data. SoftwareFactory never
 * runs anything that came out of the room, and the room never holds the GitHub pass.
 *
 * Inside the room there are two kinds of work, and each has its own box:
 *  - the agent, under Claude Code's sandbox and the managed rules (it may reach the listed addresses);
 *  - everything SoftwareFactory itself starts on the copy (git, and the project's checks), under a plain
 *    bubblewrap box with no network at all and the worker's home hidden. The copy was just written by an
 *    agent, so a git hook, a git setting or a build script in it is treated as the agent's code, not ours.
 *
 * SoftwareFactory's own files for a run (check scripts, their logs, the bundle going out) live in a scratch
 * folder beside the copy that no box can write: the agent's sandbox writes only in the copy, and our own
 * box sees the scratch folder read-only. So nothing an agent planted can redirect what we write or read.
 */

export interface RunRequest {
  /** Stamps for the record. Plain names: letters, digits, dot, dash, underscore. */
  run: string;
  ticket: string;
  project: string;
  /** The person's own words. */
  sentence: string;
  /** The project as a git bundle that holds `base`. */
  bundle: Buffer;
  base: string;
  /** The branch the work is committed on. */
  branch: string;
  model: string;
  maxTurns: number;
  timeLimitMs: number;
  /** The project's own checks, run by SoftwareFactory after the agent, without network. */
  checks: string[];
  /** Commands that fetch what the checks need (packages, modules). The agent runs them first, while it still has the listed addresses. */
  prepare?: string[];
  /** Set when the checks were found in the project itself (and not written in Settings): where each came from. */
  checksFound?: string[];
  /** The test of done, written at the ready gate before the run. The run is told it and cannot change it. */
  done?: string[];
  /** More than one run may work at once: this run gets a cell of its own, and ending it touches no other run. */
  ownCell?: boolean;
  signal?: AbortSignal;
}

export interface CheckResult { command: string; ok: boolean; exit: number | null; tail: string }

export interface RunResult {
  end: RunEnd;
  reason: string;
  /** The new commits as a git bundle, when the run passed. */
  bundle: Buffer | null;
  baseSha: string | null;
  headSha: string | null;
  costUsd: number;
  summary: string;
  checks: CheckResult[];
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/;

/** What the agent is told. The sentence is the person's; the rest is fixed. */
export function runPrompt(r: Pick<RunRequest, "sentence" | "checks" | "prepare" | "done">): string {
  return [
    "You are working on a copy of a real project. Do what the owner asks below, completely and with care, and nothing beyond it.",
    "",
    "The owner's request:",
    r.sentence.trim(),
    ...(r.done?.length ? ["", "SoftwareFactory's reading of when this is finished, written down before you started. It is a reading of the request above, not more than it: where the two differ, the owner's request wins.", ...r.done.map((x) => `- ${x}`)] : []),
    "",
    "How to work:",
    ...(r.prepare?.length ? [
      "- FIRST, before anything else, run each of these commands exactly as written, one per call, from the project's top folder. They fetch what the project needs; later there is no network, so nothing can be fetched then:",
      ...r.prepare.map((c) => `    ${c}`),
    ] : []),
    "- Read the project's own instructions (CLAUDE.md, README) first and follow them.",
    "- Make the change with the project's own style and tests. Do not commit; your files are collected when you finish.",
    "- Your shell commands run in a sandbox and nobody is there to approve anything. If a shell command is refused, do not give up on the shell: run it again as plain single commands, one per call (for example first `npm ci --prefix web`, then the next), without pipes, `;`, redirects or `cd ... &&`. Use the Read tool for looking at a file, the Edit tool to change one, and plain `ls` and `grep -rn` commands to find files and search inside them. There is no tool for writing a new file: make one with a shell command.",
    "- You can reach only a short list of network addresses (the package registries and GitHub). If something is refused, do not look for a way around it; say so in your final answer.",
    ...(r.checks.length ? [
      "- When you are done, these checks will be run on your work WITHOUT any network, so install whatever they need now (for example `npm ci`) and make sure each one passes:",
      ...r.checks.map((c) => `    ${c}`),
    ] : []),
    "- End with a short plain summary for the owner: what you changed, and anything you could not do.",
  ].join("\n");
}

/** The shell functions every script of ours in the room starts with. */
export function roomPrelude(s: FenceSettings, run: string): string {
  const copy = `${s.copies}/run-${run}`;
  const scratch = `${s.copies}/run-${run}.sf`;
  const cache = `${copy}/.sf-cache`;
  const env = `GOPATH=${cache}/go GOMODCACHE=${cache}/go/pkg/mod GOCACHE=${cache}/gocache GOTOOLCHAIN=local npm_config_cache=${cache}/npm npm_config_update_notifier=false CI=1`;
  return `
copy=${copy}
scratch=${scratch}
cache=${cache}
# Ours on the copy: no network, the worker's home hidden, only the copy writable, our scratch folder read-only,
# and nothing on stdin (stdin is this very script).
fenced() {
  bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --tmpfs /home/${s.worker} --bind "$copy" "$copy" --ro-bind "$scratch" "$scratch" \\
    --unshare-all --die-with-parent --new-session --chdir "$copy" \\
    /usr/bin/env -i HOME=${cache}/home USER=${s.worker} PATH=/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 \\
    ${env} GOPROXY=off npm_config_offline=true GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 "$@" </dev/null
}
# git as ours: our name, no hooks, no signing, whatever the copy's own settings say.
ourgit() { fenced git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c commit.gpgsign=false -c user.name="SoftwareFactory worker" -c user.email=worker@softwarefactory.invalid "$@"; }
# The agent sees no tools from the owner's own account (mail, files, documents): the switch is off here, and the run is ended if any shows anyway.
agent_env() { export ${env}; export PATH=/usr/local/go/bin:$PATH; ${AGENT_ENV}; }
`;
}


interface AgentEnd { isError: boolean; outOfTurns: boolean; text: string; costUsd: number; turns: number }

/** One line of Claude Code's stream becomes at most one line of the record. Content only: the stamps are ours. */
export function stepOf(line: string): { data: Record<string, unknown>; end?: AgentEnd; outside?: string[]; started?: boolean } | null {
  let j: any;
  try { j = JSON.parse(line); } catch { return null; }
  if (!j || typeof j !== "object") return null;
  const cut = (v: unknown, n: number) => { const t = typeof v === "string" ? v : JSON.stringify(v ?? ""); return t.length > n ? `${t.slice(0, n)}...` : t; };
  if (j.type === "assistant" && Array.isArray(j.message?.content)) {
    const says = j.message.content.filter((c: any) => c.type === "text" && c.text?.trim()).map((c: any) => c.text.trim()).join("\n");
    const tools = j.message.content.filter((c: any) => c.type === "tool_use").map((c: any) => ({ tool: String(c.name), input: cut(c.input, 400) }));
    if (!says && !tools.length) return null;
    // A tool from outside the room in the agent's hands, even one that was not listed at the start.
    const reached = tools.map((x: { tool: string }) => x.tool).filter((n: string) => n.startsWith("mcp__"));
    return { data: { ...(says ? { says: cut(says, 2000) } : {}), ...(tools.length ? { tools } : {}) }, ...(reached.length ? { outside: reached } : {}) };
  }
  if (j.type === "user" && Array.isArray(j.message?.content)) {
    const errors = j.message.content.filter((c: any) => c.type === "tool_result" && c.is_error).map((c: any) => cut(c.content, 1500));
    return errors.length ? { data: { toolErrors: errors } } : null;
  }
  if (j.type === "system" && j.subtype === "init") {
    // Tools from outside the room (mail, files, documents of the signed-in account) must not be there at all.
    // A first line that does not list its tools proves nothing, so it does not count as seen.
    if (!Array.isArray(j.tools)) return null;
    const tools: string[] = j.tools.map((x: unknown) => String(x));
    // Every listed server counts, whatever its state: one that connects late brings its tools after this line.
    const servers: string[] = Array.isArray(j.mcp_servers) ? j.mcp_servers.map((m: any) => String(m?.name ?? m)) : [];
    const outside = [...new Set([...tools.filter((n) => n.startsWith("mcp__")), ...servers.map((n) => `server ${n}`)])];
    const extra = tools.filter((n) => !n.startsWith("mcp__") && !(AGENT_TOOLS as readonly string[]).includes(n));
    return { data: { did: "agent started", toolCount: tools.length, ...(extra.length ? { otherTools: extra.slice(0, 30) } : {}), ...(outside.length ? { outsideTools: outside.slice(0, 20) } : {}) }, started: true, ...(outside.length ? { outside } : {}) };
  }
  if (j.type === "result") {
    const sub = typeof j.subtype === "string" ? j.subtype : "";
    const end: AgentEnd = { isError: !!j.is_error || (!!sub && sub !== "success"), outOfTurns: sub === "error_max_turns", text: cut(j.result ?? sub, 4000), costUsd: Number(j.total_cost_usd ?? 0) || 0, turns: Number(j.num_turns ?? 0) || 0 };
    return { data: { finished: true, turns: end.turns, denials: Array.isArray(j.permission_denials) ? j.permission_denials.length : 0 }, end };
  }
  return null;
}


/**
 * Work one ticket inside the room. The fence test must have passed first; this function does not run it.
 * Everything that happens is appended to the record with this run's stamps.
 */
export async function runInRoom(exec: RoomExec, files: RoomFiles, record: TheRecord, req: RunRequest, over: Partial<FenceSettings> = {}): Promise<RunResult> {
  const s = fenceSettings(over);
  for (const [k, v] of [["run", req.run], ["ticket", req.ticket]] as const) if (!NAME.test(v)) throw new Error(`door: ${k} must be a plain name, got "${v}"`);
  for (const [k, v] of [["base", req.base], ["branch", req.branch]] as const) if (!BRANCH.test(v) || v.includes("..")) throw new Error(`door: ${k} is not a plain branch name: "${v}"`);
  if (!/^[a-z0-9][a-z0-9.-]{0,60}$/.test(req.model)) throw new Error(`door: "${req.model}" is not a model name`);
  if (!req.sentence.trim()) throw new Error("door: the ticket has no sentence");
  const stamp = { run: req.run, ticket: req.ticket, project: req.project };
  const note = (kind: "run.step" | "run.checked", data: Record<string, unknown>, who = "SF itself") => record.append({ kind, who, ...stamp, data });
  const pre = roomPrelude(s, req.run);
  const copyDir = `${s.copies}/run-${req.run}`, scratchDir = `${copyDir}.sf`;
  const inFile = `${scratchDir}/in.bundle`, outFile = `${scratchDir}/out.bundle`;
  const tag = randomBytes(6).toString("hex");
  const checks: CheckResult[] = [];
  let costUsd = 0, summary = "", baseSha: string | null = null, headSha: string | null = null;

  // Stop always works: whatever the run is doing, everything of the worker's is killed inside the room.
  // With one run at a time that is the whole room; with more, the run's own cell, and no other run is touched.
  const cell: Cell = req.ownCell ? ownCell(exec, s, req.run) : wholeRoom(exec, s);
  const killAll = (): Promise<boolean> => cell.kill();
  const stopped = () => !!req.signal?.aborted;
  const onAbort = () => { void killAll(); };
  req.signal?.addEventListener("abort", onAbort, { once: true });

  const finish = async (end: RunEnd, reason: string, bundle: Buffer | null = null): Promise<RunResult> => {
    req.signal?.removeEventListener("abort", onAbort);
    const clear = await killAll();
    // The copy does not stay: a later run must not find an earlier one's files, and the disk must not fill.
    // Go writes its package folders read-only, so they are made writable first or they would stay behind.
    await exec("worker", `chmod -R u+rwX ${copyDir} ${scratchDir} 2>/dev/null; rm -rf ${copyDir} ${scratchDir}`, s.stepTimeoutMs).catch(() => undefined);
    await cell.close();
    record.append({ kind: "run.ended", who: "SF itself", ...stamp, costUsd: null, data: { end, reason, costUsd, nothingLeftRunning: clear, ...(end === "parked" && /^the plan limit was reached/.test(reason) ? { parkedFor: "limit" } : {}) } });
    return { end, reason, bundle, baseSha, headSha, costUsd, summary, checks };
  };
  const step = async (user: "worker" | "root", script: string, timeoutMs = s.stepTimeoutMs, onLine?: (l: string) => void): Promise<ExecResult> => (user === "worker" ? cell.run(script, timeoutMs, onLine) : exec(user, script, timeoutMs, onLine));

  record.append({ kind: "run.started", who: "SF itself", ...stamp, data: { branch: req.branch, base: req.base, model: req.model, ...(req.ownCell ? { cell: `sf-run-${req.run}` } : {}), timeLimitMinutes: Math.round(req.timeLimitMs / 60_000), checks: req.checks, prepare: req.prepare ?? [], ...(req.checksFound ? { checksFound: req.checksFound } : {}), ...(req.done?.length ? { done: req.done } : {}) } });
  // Tools from outside the room seen in this run. Once any is seen, that is how the run ends, whatever else happened.
  let outside: string[] = [];
  const OUTSIDE = (names: string[]) => `the run was ended: it had tools from outside the room (${names.slice(0, 5).join(", ")}), which must never be there`;
  try {
    if (stopped()) return await finish("stopped", "you pressed stop");
    // 1. The copy goes in as data and is unpacked by git inside the no-network box.
    await killAll();
    if (!(await cell.open())) return await finish("crashed", "the run's own cell could not be made in the room, so no step ran");
    const clear = await step("worker", `chmod -R u+rwX ${copyDir} ${scratchDir} 2>/dev/null; rm -rf ${copyDir} ${scratchDir} && mkdir -p ${copyDir} ${scratchDir} && chmod 0700 ${scratchDir} && echo cleared`);
    if (!/cleared/.test(clear.stdout)) return await finish("crashed", `the room could not be prepared: ${clear.stderr.slice(0, 200)}`);
    await files.put(inFile, req.bundle, s.stepTimeoutMs);
    const unpack = await step("worker", `${pre}
fenced git clone -q -b ${req.base} ${inFile} "$copy/.sf-unpack" || exit 2
# git clone wants an empty folder, so it clones beside and the pieces move up.
( cd "$copy" && fenced /bin/sh -c 'mv .sf-unpack/.git . && rm -rf .sf-unpack && git reset -q --hard' ) || exit 3
rm -f ${inFile}
ourgit checkout -q -b ${req.branch} || exit 4
echo "SFBASE $(ourgit rev-parse HEAD)"
`);
    baseSha = /^SFBASE ([0-9a-f]{40})$/m.exec(unpack.stdout)?.[1] ?? null;
    if (!baseSha) return await finish("crashed", `the copy could not be unpacked (exit ${unpack.code}): ${unpack.stderr.slice(0, 300)}`);
    note("run.step", { did: "copy unpacked in the room", baseSha });
    if (stopped()) return await finish("stopped", "you pressed stop");

    // 2. The agent works, under Claude Code's sandbox and the managed rules. Each of its lines is stamped by us.
    let agentEnd: AgentEnd | null = null;
    let sawStart = false;
    const agent = await step("worker", `${pre}
cd "$copy" || exit 97
agent_env
unset ANTHROPIC_API_KEY
claude -p --output-format stream-json --verbose --model ${req.model} --max-turns ${Math.max(1, Math.floor(req.maxTurns))} ${AGENT_FLAGS} --permission-mode dontAsk <<'SF_PROMPT_${tag}'
${runPrompt(req).split(`SF_PROMPT_${tag}`).join("")}
SF_PROMPT_${tag}
`, req.timeLimitMs, (line) => {
      const st = stepOf(line);
      if (!st) return;
      // An outside tool in the agent's hands ends the run. The start flags are what keeps such tools away; this is
      // the alarm for the day they do not, and nothing of such a run is kept.
      if (st.started) sawStart = true;
      if (st.outside?.length && !outside.length) { outside = st.outside; void killAll(); }
      if (st.end) { agentEnd = st.end; costUsd = st.end.costUsd; summary = st.end.text; }
      record.append({ kind: "run.step", who: "worker", ...stamp, costUsd: st.end ? st.end.costUsd : null, data: st.data });
    });
    // Whatever the agent left running is ended now: nothing of its may work on while we commit and check.
    const quiet = await killAll();
    const done = agentEnd as AgentEnd | null;
    if (outside.length) return await finish("crashed", OUTSIDE(outside));
    if (stopped()) return await finish("stopped", "you pressed stop");
    if (!quiet) return await finish("crashed", "something the run started could not be ended, so its work is not trusted");
    if (agent.timedOut) return await finish("parked", `the time limit of ${Math.round(req.timeLimitMs / 60_000)} minutes was reached`);
    if (!done) return await finish(looksLikeLimit(agent.stdout + agent.stderr) ? "parked" : "crashed", looksLikeLimit(agent.stdout + agent.stderr) ? "the plan limit was reached" : `the agent ended without an answer (exit ${agent.code}): ${(agent.stderr || agent.stdout).slice(-300)}`);
    if (done.outOfTurns) return await finish("parked", `the run used all its ${req.maxTurns} turns before finishing`);
    if (done.isError) return await finish(looksLikeLimit(done.text) ? "parked" : "crashed", looksLikeLimit(done.text) ? `the plan limit was reached: ${done.text.slice(0, 200)}` : `the agent stopped with an error: ${done.text.slice(0, 300)}`);
    // Nothing is kept of a run whose first line never told which tools it had.
    if (!sawStart) return await finish("crashed", "the agent never said which tools it had, so its work is not trusted");

    // 3. Ours again. Git's own files in the copy are made ours first (settings, hooks, hidden-file lists), then
    //    the work is committed from a fresh list of files, so nothing can be kept out of the commit quietly.
    const commit = await step("worker", `${pre}
cat > "$scratch/msg" <<'SF_MSG_${tag}'
${req.ticket}: ${req.sentence.trim().split("\n")[0]!.slice(0, 100).split(`SF_MSG_${tag}`).join("")}

Worked by SoftwareFactory inside the fence. Run ${req.run}.
SF_MSG_${tag}
fenced /bin/sh -c 'rm -rf .git/hooks .git/info .git/index .git/config.worktree .git/modules && mkdir -p .git/info && printf ".sf-cache/\\n" > .git/info/exclude && printf "[core]\\n\\trepositoryformatversion = 0\\n\\tfilemode = true\\n\\tbare = false\\n" > .git/config' || exit 1
ourgit add -A || exit 1
if ourgit diff --cached --quiet; then echo SFNOCHANGE; else
  ourgit commit -q --no-verify -F "$scratch/msg" || exit 2
  echo "SFHEAD $(ourgit rev-parse HEAD)"
fi
`);
    if (/SFNOCHANGE/.test(commit.stdout)) return await finish("parked", "the run changed nothing in the project");
    headSha = /^SFHEAD ([0-9a-f]{40})$/m.exec(commit.stdout)?.[1] ?? null;
    if (!headSha) return await finish("crashed", `the work could not be committed (exit ${commit.code}): ${commit.stderr.slice(0, 300)}`);
    note("run.step", { did: "work committed in the room", headSha });

    // 4. The project's own checks, run by us without network. The script and its log are in our scratch folder;
    //    the exit code is read by us, on a line the check itself cannot write (its output goes to the log).
    for (const [i, command] of req.checks.entries()) {
      if (stopped()) return await finish("stopped", "you pressed stop");
      const r = await step("worker", `${pre}
cat > "$scratch/check-${i}.sh" <<'SF_CHECK_${tag}'
set -e
${command.split(`SF_CHECK_${tag}`).join("")}
SF_CHECK_${tag}
fenced /bin/bash "$scratch/check-${i}.sh" > "$scratch/check-${i}.log" 2>&1
echo "SFEXIT-${tag} $?"
tail -c 1500 "$scratch/check-${i}.log"
`, req.timeLimitMs);
      const exit = new RegExp(`^SFEXIT-${tag} (\\d+)$`, "m").exec(r.stdout)?.[1];
      const c: CheckResult = { command, ok: exit === "0", exit: exit === undefined ? null : Number(exit), tail: r.stdout.replace(new RegExp(`^SFEXIT-${tag} \\d+\\n?`, "m"), "").slice(-1500) };
      checks.push(c);
      note("run.checked", { command, ok: c.ok, exit: c.exit, tail: c.tail });
      await killAll();
      if (!c.ok) return await finish(r.timedOut ? "parked" : "failed its checks", r.timedOut ? `a check ran past the time limit: ${command}` : `a check failed: ${command}`);
    }
    if (stopped()) return await finish("stopped", "you pressed stop");

    // 5. The result leaves as one bundle of the new commits, written by git in the box to our scratch folder.
    //    What leaves must be what was checked: no file the project keeps may differ from the commit by now.
    const pack = await step("worker", `${pre}
# Only files the project keeps count: a build's own output (a new folder nobody tracks) is not a change to the work.
changed=$(ourgit status --porcelain --untracked-files=no) || echo "SFDIRTY-${tag}"
[ -z "$changed" ] || echo "SFDIRTY-${tag}"
ourgit bundle create - ${baseSha}..${req.branch} > ${outFile} 2>/dev/null && echo "SFPACKED-${tag} $(ourgit rev-parse ${req.branch})"
`);
    const packed = new RegExp(`^SFPACKED-${tag} ([0-9a-f]{40})$`, "m").exec(pack.stdout)?.[1];
    if (!packed) return await finish("crashed", `the result could not be packed (exit ${pack.code}): ${pack.stderr.slice(0, 300)}`);
    if (packed !== headSha || pack.stdout.includes(`SFDIRTY-${tag}`)) return await finish("failed its checks", "the project's files changed while the checks ran, so what was checked is not what would leave");
    const bundle = await files.get(outFile, s.stepTimeoutMs);
    if (stopped()) return await finish("stopped", "you pressed stop");
    return await finish("passed", "the work is done and its checks passed", bundle);
  } catch (e) {
    if (outside.length) return await finish("crashed", OUTSIDE(outside));
    return await finish(stopped() ? "stopped" : "crashed", stopped() ? "you pressed stop" : (e as Error).message.slice(0, 300));
  }
}
