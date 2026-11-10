# Milestone 1 spike: which agent runtime?

**Decision proposed: drive Claude Code headless (`claude -p`) through the `ClaudeCodeRuntime` adapter, in the lean profile by default, loading only the plugins a given agent needs with `--plugin-dir`.**

## What was measured (2026-11-10)

Raw numbers are in [spike-runtime-results.md](spike-runtime-results.md) (re-run with `npm run spike`). Costs are list prices reported by Claude Code; what is actually billed depends on the plan used.

| Setup | Context loaded per call | Cost per short Overseer call |
| --- | ---: | ---: |
| Full profile (every installed plugin, skill and MCP server), default model | ~49,000 tokens | ~$0.99 |
| Full profile, Haiku | ~48,600 tokens | ~$0.0097 |
| Lean profile, Sonnet | ~5,800 tokens | ~$0.023 |
| Lean profile, Haiku | ~6,400 tokens | ~$0.0014 |

## What it means

1. **Loading every installed plugin costs about 43,000 tokens of context on every call.** That is fine for one chat, but expensive for a factory that makes hundreds of agent calls a run.
2. **Model choice matters most.** The same short call is about 700x cheaper on Haiku in the lean profile than on the default model with everything loaded.
3. So each agent in the Agent Bay will declare its **model** and **only the plugins and skills it needs**. The runtime loads exactly those. The Archivist and Overseer default to Haiku; the Builder and Reviewer can use stronger models.
4. Claude Code headless already uses your Claude Code sign-in and your plugins, so the factory can use the plugins you installed in claude.ai (the ask from the project chat) without re-implementing them.
5. The Claude Agent SDK runs the same engine underneath, so it stays the fallback if we need finer control than the CLI's flags. The `AgentRuntime` interface makes that swap a single new adapter.

## Guardrails already in the code

- Every call carries `--max-budget-usd` (default $0.25 per Overseer call).
- Every call is recorded as `agent.run.started` and `agent.run.completed` or `agent.run.failed` events with model, time, context tokens and cost, and shown live on the Bridge's computation timeline.

## Found along the way

- Agents inherit project context from the folder they run in: in the test, the Overseer already knew this project's plan. Milestone 2 will run each agent in an explicit working folder (the project's worktree) so its context is exactly what we intend.
