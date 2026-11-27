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
  const kill = async (): Promise<boolean> => {
    const r = await exec("root", `[ -d ${dir} ] || { echo nothing-running; exit 0; }
echo 1 > ${dir}/cgroup.kill 2>/dev/null
for i in 1 2 3 4 5 6 7 8 9 10; do [ -s ${dir}/cgroup.procs ] || break; sleep 0.1; done
[ -s ${dir}/cgroup.procs ] && echo still-running || echo nothing-running`, 30_000).catch(() => null);
    return !!r && /nothing-running/.test(r.stdout);
  };
  return {
    name,
    open: async () => {
      // A cell left by an earlier start under the same name is ended first; then it must be there, empty, and killable.
      await kill();
      const r = await exec("root", `mkdir -p ${dir} && [ -w ${dir}/cgroup.kill ] && [ ! -s ${dir}/cgroup.procs ] && echo cell-ready`, 30_000).catch(() => null);
      return !!r && /cell-ready/.test(r.stdout);
    },
    run: async (script, timeoutMs, onLine) => {
      const tag = randomBytes(6).toString("hex");
      let moved: Promise<boolean> | null = null;
      // The step says who it is and waits. Root moves it into the cell; only then does it go on. Everything it
      // starts afterwards is born in the cell. A step that was not moved in time does nothing and ends.
      const r = await exec("worker", `echo "SFCELL-${tag} $$"
for i in $(seq 1 150); do grep -qx "0::/${name}" /proc/self/cgroup && break; sleep 0.1; done
grep -qx "0::/${name}" /proc/self/cgroup || { echo "SFCELL-MISSED-${tag}"; exit 98; }
${script}`, timeoutMs, (line) => {
        const pid = new RegExp(`^SFCELL-${tag} (\\d{1,9})$`).exec(line)?.[1];
        if (pid && !moved) {
          // Only a process of the worker's, and only into this run's cell.
          moved = exec("root", `[ "$(stat -c %U /proc/${pid} 2>/dev/null)" = "${s.worker}" ] && echo ${pid} > ${dir}/cgroup.procs && echo moved`, 30_000).then((m) => /moved/.test(m.stdout), () => false);
          return;
        }
        if (line.startsWith("SFCELL-")) return;
        onLine?.(line);
      });
      if (moved) await moved;
      return r;
    },
    kill,
    close: async () => { await exec("root", `rmdir ${dir} 2>/dev/null; true`, 30_000).catch(() => undefined); },
  };
}
