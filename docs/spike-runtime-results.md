# Runtime spike results (2026-11-10)

Prompt: "In one sentence: what is the first thing a software factory should do with a one-line idea?" with the Overseer role. Costs are list prices reported by Claude Code (total_cost_usd); what you are billed depends on your plan.

| Setup | Model | Context tokens | Cost | Time | Answer |
| --- | --- | ---: | ---: | ---: | --- |
| Claude Code, lean, Haiku | claude-haiku-5-5 | 6,385 | $0.0014 | 6.2 s | Capture the idea as a distinct entry and attach it to the right project or thread, so it can be sorted and planned befor |
| Claude Code, lean, Sonnet | claude-sonnet-5-5 | 5,827 | $0.0234 | 9.3 s | Turn it into a structured brief (goal, constraints, success criteria) and file it under the right project or thread, che |
| Claude Code, full plugins, Haiku | claude-haiku-5-5 | 48,567 | $0.0097 | 4.0 s | Capture it immediately as a raw note, attached to the right project, then have it clarified into a scoped plan before an |
| Claude Code, full plugins, default model (measured by hand, "pong" prompt) | claude-fable-5-1 | 49,353 | $0.9872 | 4.4 s | pong |
