# The crew advisor

SoftwareFactory's crew uses Anthropic's [advisor tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool).
An agent works on its own model (usually haiku or sonnet), and may stop mid-task to ask a stronger model,
the advisor, for a plan or a second look. The advisor reads the whole conversation so far and answers in a few
hundred words; the agent then carries on. You get close to the stronger model's judgment on the hard moments, at
close to the cheaper model's price for the rest.

## How it runs

The crew runs Claude Code headless (`claude -p`, `runtime.ts`). Claude Code has the advisor built in: SF passes
`--advisor <model>` and sets `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL=1` on that call (some accounts still
have the switch behind that gate). The runtime first asks the CLI once whether it knows `--advisor`
(`cliHasAdvisor`); an older CLI simply runs without it. Nothing else is installed, and no API key is needed: the
calls bill the same sign-in as the rest of the crew.

Every paid call goes through `runAgent` (`agents.ts`), which applies the rule in one place (`advisor.ts`):

- **Setting** (Systems, "Crew advisor"): Off, Sonnet or Opus. Default: Opus (or `SF_ADVISOR` until you pick one).
- **Only stronger advisors.** An agent gets an advisor only if the advisor ranks above its own model
  (haiku < sonnet < opus < fable). An opus agent works alone; with the Sonnet setting a sonnet agent does too.
- **Working sessions and bigger calls.** An agent editing a folder (Builder, Fixer, a ticket's repo work) always
  gets one: long multi-step turns are where a plan check up front and a review before "done" pay back. Other calls
  get one only with a cap of at least `minBudgetUsd` (default $0.25): a consultation could use up a small cap and
  fail the call, and one-shot answers gain little from a plan.
- **Spend stays capped.** The advisor's tokens are billed at its own model's price and count inside the call's own
  `--max-budget-usd`. No run can cost more than its limit because of the advisor.
- **Never blocks a run.** If the CLI refuses the advisor (an old Claude Code, a pairing it does not accept) and the
  call cost nothing, the call runs again without it and the log says so (`agent.run.retried`).
- A call can name its own advisor (`advisor: "opus"`) or turn it off (`advisor: null`) in its `AgentRequest`.

Each `agent.run.started` event records the advisor it ran with, and `agent.run.completed` carries `advisor` too, so
Cycles and the run log show which calls had one.

## API

- `GET /api/crew/advisor` returns `{ model: "opus" | "sonnet" | null, minBudgetUsd }`.
- `POST /api/crew/advisor` with any of `{ model: "off" | "sonnet" | "opus", minBudgetUsd: 0..5 }`.
