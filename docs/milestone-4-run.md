# Milestone 4: first real run with the Council sitting

Date: 2026-11-10. Runtime: Claude Code headless, lean profile (no plugins, no tools). Cap: $1.00.

```
npm run factory -- "a CLI that turns a CSV of expenses into a monthly summary per category, with totals, averages and the biggest expense" --max-usd 1.0 --council always
```

**Result: shipped, $0.29 in 7 agent calls, 47 of 47 locked acceptance tests green on the first build, 0 fix rounds.**

| Station | Agent (model) | Time | Cost |
|---|---|---|---|
| Council, 3 seats in parallel | Visionary, Architect, Skeptic (Haiku) | 9 s | $0.0025 |
| Spec and plan | Planner (Haiku) | 32 s | $0.0041 |
| Acceptance tests (locked) | Tester (Haiku) | 137 s | $0.0193 |
| Build | Builder (Sonnet) | 134 s | $0.2603 |
| Review | Reviewer (Haiku) | 23 s | $0.0057 |

## What the Council did

Votes: Visionary build, Architect build, Skeptic reshape. Majority build, so one round was enough.

- **Agreed by two seats:** bank CSVs vary in date format, delimiter and sign convention; store amounts as integer cents to avoid float drift in totals.
- **Concerns the Planner designed around:** refunds and negative amounts, rows with a missing amount or category, averages for empty months, decimal commas and DD/MM dates. These became acceptance criteria (8 in the spec) and tests, before any code existed.

For under a cent, the brief moved the spec from "sum a CSV" to money handled in cents and every input row accounted for.

## What the first attempt found

The same idea, run once before this one, stopped at the Fix station: the Tester wrote fixture files (`test/fixtures/*.csv`) and the core only let it write `test/*.js`, so the CLI tests could never find their fixtures, and the Fixer was (rightly) refused when it tried to add them. Fixed in this milestone: the Tester may write anything under `test/`, and fixtures are locked with the tests. The Reviewer's first note on the second run (a source file "cut off") also came from the core trimming files for the review prompt; it now sends whole files up to 12,000 characters.

## Agent Bay

Every call above is on its agent's crew card: calls, cost, verifier pass rate (tests green on the first build, plan approved, take usable) and rounds per run, kept per version. The same numbers are in the `agent_verdicts`, `bay_agents` and `council_sessions` tables of the database (see [storage.md](storage.md)).
