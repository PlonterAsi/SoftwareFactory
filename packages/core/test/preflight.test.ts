import { describe, it, expect } from "vitest";
import { EventLog } from "../src/index.js";
import { PREFLIGHT_MIN_FREE_BYTES, SIGNIN_HOLD_MS, freeBytesAt, lastAgentCall, preflight } from "../src/safety/preflight.js";

const ok = { mode: "real" as const, git: { found: true }, claude: { found: true, version: "2.1.328" }, freeBytes: 50 * 1024 ** 3 };

describe("preflight: free checks before anything costs money", () => {
  it("passes a ready PC and says what each check saw", () => {
    const r = preflight(ok);
    expect(r.ok).toBe(true);
    expect(r.problem).toBeNull();
    expect(r.items.map((x) => x.id)).toEqual(["git", "claude", "signin", "disk"]);
    expect(r.items[1].text).toContain("2.1.328");
  });

  it("names the first thing to fix: Git, then Claude Code, then disk", () => {
    expect(preflight({ ...ok, git: { found: false } }).problem).toMatch(/Git is not installed/);
    expect(preflight({ ...ok, claude: { found: false } }).problem).toMatch(/Claude Code is not installed/);
    expect(preflight({ ...ok, freeBytes: PREFLIGHT_MIN_FREE_BYTES / 2 }).problem).toMatch(/Only 0\.5 GB free/);
    // Unknown free space is not a stop.
    expect(preflight({ ...ok, freeBytes: null }).ok).toBe(true);
  });

  it("the practice crew needs no Claude Code", () => {
    const r = preflight({ ...ok, mode: "practice", claude: { found: false } });
    expect(r.ok).toBe(true);
    expect(r.items.map((x) => x.id)).toEqual(["git", "disk"]);
  });

  it("a sign-in failure holds auto-work for 30 minutes, never a person's press", () => {
    const now = Date.parse("2026-11-20T08:00:00Z");
    const lastCall = { failed: true, raw: "Invalid API key · Please run /login", at: "2026-11-20T07:50:00Z" };
    expect(preflight({ ...ok, lastCall, now }).problem).toMatch(/not signed in/);
    expect(preflight({ ...ok, lastCall, now, manual: true }).ok).toBe(true);
    expect(preflight({ ...ok, lastCall, now: now + SIGNIN_HOLD_MS }).ok).toBe(true);
    // Another failure, or a success after it, does not hold.
    expect(preflight({ ...ok, lastCall: { ...lastCall, raw: "rate limit" }, now }).ok).toBe(true);
    expect(preflight({ ...ok, lastCall: { failed: false, at: lastCall.at }, now }).ok).toBe(true);
  });

  it("reads the newest agent call from the log, and free space from the disk", () => {
    const log = new EventLog(":memory:");
    expect(lastAgentCall(log)).toBeNull();
    log.append("agent.run.failed", { runId: 1, agent: "builder", error: "x", raw: "Not logged in" });
    expect(lastAgentCall(log)).toMatchObject({ failed: true, raw: "Not logged in" });
    log.append("agent.run.completed", { runId: 2, agent: "builder" });
    expect(lastAgentCall(log)).toMatchObject({ failed: false });
    expect(freeBytesAt(process.cwd())).toBeGreaterThan(0);
    expect(freeBytesAt("/no/such/folder/anywhere")).toBeNull();
  });
});
