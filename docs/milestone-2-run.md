# Milestone 2: first real factory run (2026-11-10)

**Idea:** "a CLI that renames photos by the date they were taken"

**Result:** shipped. The repo is a tagged `v0.1.0` git repo with 31 passing acceptance tests on the first build and no fix rounds needed. A copy is in [examples/photo-date-renamer](../examples/photo-date-renamer).

Runtime: headless Claude Code, lean profile (no tools, no MCP). Gates were auto-approved by `npm run factory`.

| Station | Agent | Model | Time | Cost |
| --- | --- | --- | ---: | ---: |
| Spec and plan | Planner | Haiku | 24.8 s | $0.0029 |
| Acceptance tests (31 tests in 4 files, locked) | Tester | Haiku | 75.2 s | $0.0108 |
| Build (7 files) | Builder | Sonnet | 39.6 s | $0.1205 |
| Test | node --test | none | 0.3 s | $0 |
| **Total** | 3 agent calls | | about 2.5 min | **$0.1341** |

Prices are the list prices that Claude Code reports. What you actually pay depends on your plan.

## What the first two tries taught the factory ($0.236)

1. **Run 1 ($0.220):** Haiku closed its file blocks with `</FILE>>>`, so every locked test file ended in a stray `</`. That made all 4 suites fail to load. The Fixer correctly refused to touch the locked tests and wrote nothing, which the factory caught as a missing visual. Fixes: the parser now accepts any closing-tag variant. Test files must also pass a syntax check as ES modules before they are locked. If they fail, the Tester gets one quiet retry with the error. And a Fixer that changes nothing now escalates by name.
2. **Run 2 ($0.016):** Haiku closed its blocks with `>>>FILE`. The parser now also ends a block at the next opening tag or at the end of the answer. Both earlier Tester outputs were re-checked offline and now parse cleanly.

The money spent across all three tries was $0.37.

## Cost notes

- Almost all of the spend is the Builder on Sonnet ($0.12). A Haiku Builder would cost about one tenth as much. That's worth trying once there is a quality bar to compare against: `npm run factory -- "<idea>" --model haiku`.
- Each call's fixed context is about 7k tokens in the lean profile, which costs fractions of a cent. The output is what costs money.
