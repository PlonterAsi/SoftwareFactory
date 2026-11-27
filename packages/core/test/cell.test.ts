import { describe, expect, it } from "vitest";
import { celled, ownCell, wholeRoom } from "../src/fence/cell.js";
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
      onLine?.(`SFCELL-${tag} 4242 987654`); onLine?.("SFBASE abc"); onLine?.("SFCELL-forged 1 1");
      return ok("");
    };
    const c = ownCell(exec, s, "T1-ab12");
    expect(c.name).toBe("sf-run-T1-ab12");
    expect(await c.open()).toBe(true);
    await c.run("echo work", 1000, (l) => seen.push(l));
    // The step waits until it is in the cell, and does nothing if it never gets there.
    expect(workerScript).toMatch(/grep -qx "0::\/sf-run-T1-ab12" \/proc\/self\/cgroup \|\| \{ echo "SFCELL-MISSED-[0-9a-f]+"; exit 98; \}\necho work$/);
    // Root moves exactly the step's own process, and only if it is the worker's.
    expect(root.filter((x) => /echo moved/.test(x))).toEqual([`[ "$(stat -c %U /proc/4242 2>/dev/null)" = "worker" ] && [ "$(cut -d' ' -f22 /proc/4242/stat 2>/dev/null)" = "987654" ] && grep -qx "0::/" /proc/4242/cgroup && echo 4242 > /sys/fs/cgroup/sf-run-T1-ab12/cgroup.procs && echo moved`]);
    // The handshake's own lines never reach the caller; a forged one moves nothing.
    expect(seen).toEqual(["SFBASE abc"]);
    expect(await c.kill()).toBe(true);
    expect(root.at(-1)).toContain("echo 1 > /sys/fs/cgroup/sf-run-T1-ab12/cgroup.kill");
    expect(root.join("\n")).not.toContain("pkill");
    expect(root.at(-1)).toContain("grep -q '^populated 1' /sys/fs/cgroup/sf-run-T1-ab12/cgroup.events");
    // An ended cell runs nothing more until it is opened again.
    const n = root.length;
    expect(await c.run("echo late", 1000)).toMatchObject({ code: null, stderr: expect.stringContaining("was ended") });
    expect(root.length).toBe(n);
    await c.close();
    expect(root.at(-1)).toContain("rmdir /sys/fs/cgroup/sf-run-T1-ab12");
    expect(() => ownCell(exec, s, "../x")).toThrow();
  });

  it("ends a step that was still on its way in when Stop came, and gives a helper a short cell of its own", async () => {
    const root: string[] = [];
    let c: ReturnType<typeof ownCell>;
    const exec: RoomExec = async (user, script, _t, onLine) => {
      if (user === "root") { root.push(script); return ok(/echo moved/.test(script) ? "moved" : /cell-ready/.test(script) ? "cell-ready" : "nothing-running"); }
      const tag = /SFCELL-([0-9a-f]+) /.exec(script)![1];
      await c?.kill(); // Stop lands before the move
      onLine?.(`SFCELL-${tag} 77 5`);
      return ok("");
    };
    c = ownCell(exec, s, "T2-cd34");
    await c.open();
    await c.run("echo work", 1000);
    const at = root.findIndex((x) => /echo moved/.test(x));
    expect(root.slice(at + 1).some((x) => x.includes("cgroup.kill"))).toBe(true);
    // A helper's step: opened, run, ended and taken away, every time.
    root.length = 0;
    const plain: RoomExec = async (user, script, _t, onLine) => { if (user === "root") { root.push(script); return ok(/echo moved/.test(script) ? "moved" : /cell-ready/.test(script) ? "cell-ready" : "nothing-running"); } onLine?.(`SFCELL-${/SFCELL-([0-9a-f]+) /.exec(script)![1]} 9 9`); return ok("said"); };
    expect((await celled(plain, s, "gate")("worker", "echo read", 1000)).stdout).toBe("said");
    expect(root.some((x) => /mkdir -p \/sys\/fs\/cgroup\/sf-run-gate-[0-9a-f]{8}/.test(x))).toBe(true);
    expect(root.at(-1)).toMatch(/rmdir \/sys\/fs\/cgroup\/sf-run-gate-/);
  });
});
