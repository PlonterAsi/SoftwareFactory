import { describe, expect, it } from "vitest";
import { ownCell, wholeRoom } from "../src/fence/cell.js";
import type { ExecResult, RoomExec } from "../src/fence/fencetest.js";
import { fenceSettings } from "../src/fence/room.js";

const s = fenceSettings();
const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });

describe("a run's cell", () => {
  it("with one run at a time it is the whole room, as before", async () => {
    const calls: string[] = [];
    const exec: RoomExec = async (user, script) => { calls.push(`${user}: ${script}`); return ok("nothing-running"); };
    const c = wholeRoom(exec, s);
    expect(await c.open()).toBe(true);
    await c.run("echo hi", 1000);
    expect(await c.kill()).toBe(true);
    expect(calls[0]).toBe("worker: echo hi");
    expect(calls[1]).toMatch(/^root: pkill -KILL -u worker/);
  });

  it("moves each step into the run's own cell before it does anything, and ends only that cell", async () => {
    const root: string[] = [];
    let workerScript = "";
    const seen: string[] = [];
    const exec: RoomExec = async (user, script, _t, onLine) => {
      if (user === "root") { root.push(script); return ok(/cgroup.procs && echo moved/.test(script) ? "moved" : /cell-ready/.test(script) ? "cell-ready" : "nothing-running"); }
      workerScript = script;
      const tag = /SFCELL-([0-9a-f]+) /.exec(script)![1];
      onLine?.(`SFCELL-${tag} 4242`); onLine?.("SFBASE abc"); onLine?.("SFCELL-forged 1");
      return ok("");
    };
    const c = ownCell(exec, s, "T1-ab12");
    expect(c.name).toBe("sf-run-T1-ab12");
    expect(await c.open()).toBe(true);
    await c.run("echo work", 1000, (l) => seen.push(l));
    // The step waits until it is in the cell, and does nothing if it never gets there.
    expect(workerScript).toMatch(/grep -qx "0::\/sf-run-T1-ab12" \/proc\/self\/cgroup \|\| \{ echo "SFCELL-MISSED-[0-9a-f]+"; exit 98; \}\necho work$/);
    // Root moves exactly the step's own process, and only if it is the worker's.
    expect(root.filter((x) => /echo moved/.test(x))).toEqual(['[ "$(stat -c %U /proc/4242 2>/dev/null)" = "worker" ] && echo 4242 > /sys/fs/cgroup/sf-run-T1-ab12/cgroup.procs && echo moved']);
    // The handshake's own lines never reach the caller; a forged one moves nothing.
    expect(seen).toEqual(["SFBASE abc"]);
    expect(await c.kill()).toBe(true);
    expect(root.at(-1)).toContain("echo 1 > /sys/fs/cgroup/sf-run-T1-ab12/cgroup.kill");
    expect(root.join("\n")).not.toContain("pkill");
    await c.close();
    expect(root.at(-1)).toContain("rmdir /sys/fs/cgroup/sf-run-T1-ab12");
    expect(() => ownCell(exec, s, "../x")).toThrow();
  });
});
