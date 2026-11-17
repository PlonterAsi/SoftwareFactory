import type { CiState } from "../tickets/github.js";

/**
 * The confidence review before a merge (SF behavior brief 1.5 and phase 3): plain code over what is known
 * about a pull request, free and instant. Each line says what it looked at and whether it passed. A merge
 * is confident only when every line passes; SF merges by itself only on a confident review, and only in a
 * project whose merge policy is "auto". Otherwise the PR waits on Needs you with these lines beside it.
 */
export interface MergeReason { key: string; ok: boolean; text: string }
export interface MergeReview { confident: boolean; score: number; reasons: MergeReason[] }

export interface MergeInput {
  ci: CiState;
  /** The harness steps of the ticket's last pass (review, tests, gates…), by name and how they ended. */
  steps: { step: string; state: string }[];
  files: string[];
  lines: number;
  /** The ticket's kind: requests, ideas and epics are taste and wait for a person's look. */
  kind: string;
  /** Decisions only the person makes that the check before money found on the ticket (money, data, …). */
  decisions: string[];
  /** The PR's branch was made by SoftwareFactory's crew. */
  crew: boolean;
}

export const MERGE_LIMITS = { files: 15, lines: 400 };
const TASTE = ["request", "idea", "plan"];
/** Paths where a wrong change hurts more than it shows: CI, secrets, migrations, release and install files. */
const SENSITIVE = /(^|\/)(\.github\/|\.env|secrets?\b|migrations?\/|Dockerfile|docker-compose|tauri\.conf\.json|\.npmrc|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|Cargo\.lock|.*\.pem$|.*\.key$)/i;

export function sensitiveFiles(files: string[]): string[] { return files.filter((f) => SENSITIVE.test(f)); }

export function reviewMerge(i: MergeInput): MergeReview {
  const step = (name: string) => i.steps.find((s) => s.step === name)?.state;
  const sens = sensitiveFiles(i.files);
  const reasons: MergeReason[] = [
    { key: "ci", ok: i.ci.state === "green", text: i.ci.state === "green" ? `CI passed (${i.ci.total} check${i.ci.total === 1 ? "" : "s"})` : i.ci.state === "red" ? `CI failed: ${i.ci.failed.slice(0, 3).join(", ")}` : i.ci.state === "running" ? "CI is still running" : "The repo has no CI on this PR" },
    { key: "crew", ok: i.crew, text: i.crew ? "Made by SF's crew on its own branch" : "Made outside SF, so SF did not review it" },
    { key: "review", ok: step("review") === "passed", text: step("review") === "passed" ? "SF's Reviewer passed it" : step("review") ? `SF's Reviewer ${step("review")}` : "SF's Reviewer did not look at it" },
    { key: "tests", ok: step("tests") === "passed" || step("tests") === "skipped" && step("gates") === "passed", text: step("tests") === "passed" ? "Tests passed on SF's side" : step("tests") === "skipped" ? "No tests touch it; the gates passed" : "Tests did not pass on SF's side" },
    { key: "size", ok: i.files.length <= MERGE_LIMITS.files && i.lines <= MERGE_LIMITS.lines, text: `${i.files.length} file${i.files.length === 1 ? "" : "s"}, ${i.lines} line${i.lines === 1 ? "" : "s"} changed${i.files.length > MERGE_LIMITS.files || i.lines > MERGE_LIMITS.lines ? ` (more than ${MERGE_LIMITS.files} files or ${MERGE_LIMITS.lines} lines)` : ""}` },
    { key: "sensitive", ok: !sens.length, text: sens.length ? `Touches ${sens.slice(0, 3).join(", ")}` : "No CI, secret, migration or install files" },
    { key: "decisions", ok: !i.decisions.length, text: i.decisions.length ? `Your call on ${i.decisions.join(", ")}` : "No decision only you make" },
    { key: "taste", ok: !TASTE.includes(i.kind), text: TASTE.includes(i.kind) ? `${i.kind === "plan" ? "An epic" : i.kind === "idea" ? "An idea" : "A request"} waits for your look` : "A fix or a task, not a matter of taste" },
  ];
  const passed = reasons.filter((r) => r.ok).length;
  return { confident: passed === reasons.length, score: Math.round((passed / reasons.length) * 100), reasons };
}
