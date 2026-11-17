# Flows that improve themselves

Phase 5 of the SF behavior brief (2026-11-17) lets a flow improve over time. The code is in
`packages/core/src/flows/improve.ts` (tracing, replay, operations, SF's proposals) and
`flows/improver.ts` (proposals, the trial, decisions). The screen is **Improve this flow**, under each
flow on the Flows page (`apps/bridge/src/Flows.tsx`).

A change to a flow is never saved straight away. It goes through four steps:

1. **Proposed.** It comes from your words, from a change you make, or from SF reading the flow's past
   runs.
2. **Replayed.** It is played against the flow's past runs, from what those runs recorded. No agent is
   called and nothing is spent.
3. **Tried once (optional).** The next run of the flow follows the proposal, within that run's own
   money limit.
4. **Accepted.** It is saved as the flow's next version, so it can always be put back. A proposal can
   also be rejected.

## Changes as operations

Every change is a list of operations on the flow:

| Operation | What it does |
| --- | --- |
| `drop` | leaves out an optional step, with the steps inside its loop; the lines around it are joined |
| `restore` | brings back a step SoftwareFactory ships in that flow |
| `rounds` | sets a loop's round limit (1 to 6) |
| `crew` | names the Agent Bay agent that works a step, or gives it back to the station's crew |
| `brief` | sets the words told to the crew on every run of the flow |

A required step (plan, build, tests and the like) cannot be left out. The result must pass the same
check as any saved flow, and it may only name active agents.

**In words.** For example: "skip the council", "at most 3 rounds for the judge", "use React Builder
for build", "bring back the review", "tell the crew: keep changes small".

- On the practice crew, plain rules read the words for free.
- On the real crew, one haiku call reads them, capped at $0.05. When that call's answer is unusable,
  the plain rules' reading stands.

## Replay

The replay reads what each past run of the flow recorded:

- what each step cost (agent calls by station);
- how many rounds each loop took, and whether it passed;
- what the review and the product judge caught.

For a one-session flow it reads the tickets worked with it instead. Trial runs are never counted as
past runs.

Each kind of change is judged this way:

- **A step left out** saves what it cost. It is risky on a run where it caught a problem.
- **A lower round limit** saves the rounds above it. It is risky on a run that passed only at a later
  round.
- **A higher round limit** costs the extra rounds. It may help a run that ran out of rounds without
  passing.
- **A step brought back** costs its average from the runs that had it.
- **New words for the crew, or another agent,** cannot be priced from the past. The replay says so.
  For another agent it quotes the agent's record (calls, pass rate, average cost). The live trial
  shows the rest.

The verdict is one of: cheaper, costs more, risky, may pass more often, no change, or no past runs yet.

## SF's own proposals

SF's own proposals are plain code and free. The core reads every flow every 5 minutes, or when you
press **Ask SF for ideas**, and proposes two kinds of change:

- **One more round** for a loop that ran out of rounds without passing in at least half of the runs
  where it ran, and in at least two of them.
- **Leaving out a review or judge step** (the steps whose job is to catch problems) that ran in four or more runs, cost money, and never caught a
  problem.

A proposal that is already open is not proposed again.

## The live trial

**Try it once** arms a proposal, and a flow has one trial at a time.

- **Engine flows.** The next engine run of the flow follows it. The run's started event carries the
  copy, with `trialOf` set.
- **One-session flows.** The next ticket worked with the flow follows it.

Either way it is handed out once, and the trial's outcome and cost are recorded on the proposal. A
trial is refused when the flow was saved after the proposal was made.

## Events and API

| Event | Payload |
| --- | --- |
| `flow.proposed` | `{ flowId, baseVersion, flow, ops, why, by: "sf" \| "words" \| "you", words?, replay, costUsd }` |
| `flow.proposal` | `{ id, state: "armed" \| "taken" \| "tried" \| "accepted" \| "rejected", run?, ticket?, outcome?, totalUsd?, note? }` |

```
GET  /api/flows/:id/proposals                 the flow's proposals, newest first
POST /api/flows/:id/propose    { words }      a change in words  (or { ops, why })
POST /api/flows/:id/suggest                   SF's proposals from past runs
POST /api/flows/:id/replay     { flow }       replay a candidate without saving it
POST /api/flows/proposals/:pid/try            arm the one live trial
POST /api/flows/proposals/:pid/accept         save as the flow's next version
POST /api/flows/proposals/:pid/reject
```
