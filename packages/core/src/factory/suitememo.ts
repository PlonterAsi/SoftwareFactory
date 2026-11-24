import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The working tree's fingerprint: a git tree hash of every file git would see (tracked, new, not ignored), built in a
 * throwaway index so the clone's own index is never touched. Null when git cannot say.
 *
 * Run 9398 (23 Nov) ran SoftwareFactory's 10-minute suite again on files nothing had changed: right after the build
 * had just run it, after a review that wrote nothing, and after a Fixer that "changed nothing". Same tree, same tests.
 */
export function treeHash(dir: string): string | null {
  const tmp = mkdtempSync(join(tmpdir(), "sf-tree-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(tmp, "index") };
    const add = spawnSync("git", ["add", "-A", "."], { cwd: dir, env, encoding: "utf8", windowsHide: true });
    if (add.status !== 0) return null;
    const w = spawnSync("git", ["write-tree"], { cwd: dir, env, encoding: "utf8", windowsHide: true });
    return w.status === 0 ? w.stdout.trim() || null : null;
  } catch { return null; } finally { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }
}

/** One remembered suite result per tree: the same files give back the same result (a copy) instead of a second run. */
export class SuiteMemo<T> {
  private last: { hash: string; result: T } | null = null;
  /** Runs `run` unless the tree is the one last run; `fresh` always runs (a flaky re-check must really run again). */
  async get(dir: string, run: () => Promise<T>, fresh = false): Promise<{ result: T; reused: boolean }> {
    const hash = treeHash(dir);
    if (!fresh && hash && this.last?.hash === hash) return { result: structuredClone(this.last.result), reused: true };
    const result = await run();
    if (hash) this.last = { hash, result: structuredClone(result) };
    return { result, reused: false };
  }
}
