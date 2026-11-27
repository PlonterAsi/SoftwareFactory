import { randomBytes } from "node:crypto";
import type { ExecResult, RoomExec } from "./fencetest.js";
import type { FenceSettings } from "./room.js";

/**
 * A run's cell (docs/fence.md, "Two runs at once").
 *
 * With one run at a time, ending a run means ending everything of the worker's in the room. With two, that would
 * end the other run too. A cell is a group of processes the room's kernel keeps (a cgroup made by root): every
 * step of one run is moved into its cell before it does anything, whatever it starts stays in the cell (the worker
 * cannot move a process out, tried on the real room), and ending the cell ends exactly that run.
 */
export interface Cell {
  /** "the room" or the cell's name, for the record. */
  name: string;
  /** Make it ready. False: it could not be made, and no step may run. */
  open(): Promise<boolean>;
  /** One step as the worker, inside the cell. */
  run(script: string, timeoutMs: number, onLine?: (l: string) => void): Promise<ExecResult>;
  /** End everything in it. True when nothing is left running. */
  kill(): Promise<boolean>;
  /** Take it away. Only after kill. */
  close(): Promise<void>;
}

/** One run at a time: the cell is the whole room, as it always was. */
export function wholeRoom(exec: RoomExec, s: FenceSettings): Cell {
  return {
    name: "the room",
    open: async () => true,
    run: (script, timeoutMs, onLine) => exec("worker", script, timeoutMs, onLine),
    kill: async () => {
      const r = await exec("root", `pkill -KILL -u ${s.worker} >/dev/null 2>&1; sleep 0.2; pgrep -u ${s.worker} >/dev/null 2>&1 && echo still-running || echo nothing-running`, 30_000).catch(() => null);
      return !!r && /nothing-running/.test(r.stdout);
    },
    close: async () => undefined,
  };
}

/** A cell of its own for one run. `run` is a plain name (the door checks it). */
export function ownCell(exec: RoomExec, s: FenceSettings, run: string): Cell {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(run)) throw new Error(`cell: "${run}" is not a plain name`);
  const name = `sf-run-${run}`, dir = `/sys/fs/cgroup/${name}`;
  // The kernel's own word on whether anything lives in the cell. (The list file always reads as size 0.)
  const lives = `grep -q '^populated 1' ${dir}/cgroup.events 2>/dev/null`;
  // Once ended, a cell stays ended until it is opened again: a step that was still on its way in is ended too.
  let killed = false;
  const killNow = async (): Promise<boolean> => {
    const r = await exec("root", `[ -d ${dir} ] || { echo nothing-running; exit 0; }
echo 1 > ${dir}/cgroup.kill 2>/dev/null
for i in $(seq 1 30); do ${lives} || break; sleep 0.1; done
${lives} && echo still-running || echo nothing-running`, 30_000).catch(() => null);
    return !!r && /nothing-running/.test(r.stdout);
  };
  const kill = (): Promise<boolean> => { killed = true; return killNow(); };
  return {
    name,
    open: async () => {
      // A cell left by an earlier start under the same name is ended first; then it must be there, empty, and killable.
      await killNow();
      const r = await exec("root", `mkdir -p ${dir} && [ -w ${dir}/cgroup.kill ] && ! ${lives} && echo cell-ready`, 30_000).catch(() => null);
      const ready = !!r && /cell-ready/.test(r.stdout);
      if (ready) killed = false;
      return ready;
    },
    run: async (script, timeoutMs, onLine) => {
      if (killed) return { code: null, stdout: "", stderr: "the run's cell was ended, so the step did not start", timedOut: false };
      const tag = randomBytes(6).toString("hex");
      let moved: Promise<boolean> | null = null;
      // The step says who it is (its process number and the moment it was born) and waits. Root moves exactly that
      // process into the cell, and only from the room's own top group; only then does the step go on. Everything it
      // starts afterwards is born in the cell. A step that was not moved in time does nothing and ends.
      const r = await exec("worker", `echo "SFCELL-${tag} $$ $(cut -d' ' -f22 /proc/$$/stat)"
for i in $(seq 1 150); do grep -qx "0::/${name}" /proc/self/cgroup && break; sleep 0.1; done
grep -qx "0::/${name}" /proc/self/cgroup || { echo "SFCELL-MISSED-${tag}"; exit 98; }
${script}`, timeoutMs, (line) => {
        const m = new RegExp(`^SFCELL-${tag} (\\d{1,9}) (\\d{1,20})$`).exec(line);
        if (m && !moved) {
          const [, pid, born] = m;
          // Only that very process (same birth, so not a reused number), only the worker's, only from the top group.
          moved = exec("root", `[ "$(stat -c %U /proc/${pid} 2>/dev/null)" = "${s.worker}" ] && [ "$(cut -d' ' -f22 /proc/${pid}/stat 2>/dev/null)" = "${born}" ] && grep -qx "0::/" /proc/${pid}/cgroup && echo ${pid} > ${dir}/cgroup.procs && echo moved`, 30_000)
            .then((x) => /moved/.test(x.stdout), () => false)
            // Stop was pressed while the step was on its way in: it is ended now that it is inside.
            .then(async (ok) => { if (killed) await killNow(); return ok; });
          return;
        }
        if (line.startsWith("SFCELL-")) return;
        onLine?.(line);
      });
      if (moved) await moved;
      return r;
    },
    kill,
    close: async () => { await exec("root", `for i in $(seq 1 30); do rmdir ${dir} 2>/dev/null && break; [ -d ${dir} ] || break; sleep 0.1; done; true`, 30_000).catch(() => undefined); },
  };
}

/**
 * The room's door for a helper that is not a run (the gate's reader, the fence test's agent) while more than one
 * run may work: each of its steps as the worker gets a short cell of its own, ended and taken away when the step
 * is over, so nothing it started stays beside the runs.
 */
export function celled(exec: RoomExec, s: FenceSettings, label: string): RoomExec {
  return async (user, script, timeoutMs, onLine) => {
    if (user !== "worker") return exec(user, script, timeoutMs, onLine);
    const cell = ownCell(exec, s, `${label}-${randomBytes(4).toString("hex")}`);
    if (!(await cell.open())) throw new Error("a cell for this step could not be made in the room");
    try { return await cell.run(script, timeoutMs, onLine); }
    finally { await cell.kill(); await cell.close(); }
  };
}
