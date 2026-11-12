import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../factory/workspace.js";

/**
 * A test integrity guard (SF-24). Compares the working tree with the base commit and reports the ways
 * an agent can game the tests instead of fixing the code. Pure git and text, no AI call.
 */

/** A test file: anything under a test/ folder, or named *.test.* / *.spec.*. */
export const isTestPath = (p: string) => /(^|\/)(test|tests|__tests__)\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
/** A test file that still runs: under test/ (or tests/) and named *.test.* */
const stillRuns = (p: string) => /(^|\/)(test|tests|__tests__)\//.test(p) && /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);

const SKIPS = /\b(?:(?:it|test|describe)\.(?:skip|only|todo)|xit|xdescribe|xtest|fit|fdescribe)\b|\b(?:skip|only|todo)\s*:\s*(?:true|["'`])/g;
const countSkips = (text: string) => (text.match(SKIPS) ?? []).length;

export interface TestIntegrityOptions {
  /** How many test cases the locked suite has. */
  locked?: number;
  /** How many test cases ran just now. Only checked when `locked` is given. */
  ran?: number;
}

/** One short line per finding; an empty list means the tests were left alone. */
export function testIntegrity(dir: string, base: string, o: TestIntegrityOptions = {}): string[] {
  const out: string[] = [];
  const parts = git(dir, "diff", "--name-status", "-z", "-M", base).split("\0").filter(Boolean);
  const changes: { status: string; from: string; to: string }[] = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i++][0];
    if (status === "R" || status === "C") { changes.push({ status, from: parts[i], to: parts[i + 1] }); i += 2; }
    else { changes.push({ status, from: parts[i], to: parts[i] }); i += 1; }
  }
  const fresh = git(dir, "ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean);
  const read = (p: string) => (existsSync(join(dir, p)) ? readFileSync(join(dir, p), "utf8") : null);
  const baseText = (p: string) => { try { return git(dir, "show", `${base}:${p}`); } catch { return null; } };

  for (const c of changes) {
    if (c.status === "D" && isTestPath(c.from)) {
      // A "deletion" whose content now sits in a new file somewhere else is a move.
      const old = baseText(c.from)?.trim();
      const moved = old ? fresh.find((f) => read(f)?.trim() === old) : undefined;
      if (moved && !stillRuns(moved)) out.push(`${c.from}: test file renamed away to ${moved}, which no longer runs as a test`);
      else if (!moved) out.push(`${c.from}: test file deleted`);
    } else if (c.status === "R" && isTestPath(c.from) && !stillRuns(c.to)) {
      out.push(`${c.from}: test file renamed away to ${c.to}, which no longer runs as a test`);
    }
  }

  // New skips: more of them in a test file now than at the base.
  const current = new Set<string>([...changes.filter((c) => c.status !== "D").map((c) => c.to), ...fresh]);
  for (const f of current) {
    if (!isTestPath(f)) continue;
    const now = read(f);
    if (now === null) continue;
    const from = changes.find((c) => c.to === f && c.status === "R")?.from ?? f;
    const added = countSkips(now) - countSkips(baseText(from) ?? "");
    if (added > 0) out.push(`${f}: ${added} new .skip/.only/.todo/xit/xdescribe added; remove ${added > 1 ? "them" : "it"} so the test runs`);
  }

  if (o.locked !== undefined && o.ran !== undefined && o.ran < o.locked) {
    out.push(`only ${o.ran} test cases ran, ${o.locked} were locked; ${o.locked - o.ran} went missing`);
  }
  return out;
}

/** The findings as feedback an agent can act on. */
export function describeIntegrity(findings: string[]): string {
  return findings.map((l) => `- ${l}`).join("\n");
}
