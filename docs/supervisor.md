# The supervisor: work goes on without anyone watching

On 24 Nov 2026 run #10486 (Gig Station, RoadToMill) built 5 of 6 features in 35 minutes, then the PC slept from
10:27 to 14:19. On waking, the Builder's 25-minute timer fired at once, the run (tests green, review passed) was
stopped as "longer than 90 minutes", and nothing picked it up again. Four hours of sleep had counted as work, and no
part of SoftwareFactory was responsible for continuing.

## What changed

| Layer | Before | Now |
|---|---|---|
| PC sleep | the PC slept mid-run | while a run or a ticket's Builder works, Windows is asked not to sleep on idle (`SetThreadExecutionState`, a hidden PowerShell that ends within 30 s of the core). A closed lid still wins. `SF_KEEP_AWAKE=off` turns it off. |
| Clocks | wall clock | awake time: a tick every 5 s notices clock jumps over 60 s and every work clock leaves them out (`factory/awake.ts`) |
| Agent call | killed at 25 min (Builder/Fixer) or 10 min | the CLI streams (`--output-format stream-json`); **no output for 10 min = stuck, cut now**; still talking at its limit = goes on, up to 3x. `SF_AGENT_IDLE_MS`, `SF_AGENT_STREAM=0` |
| Run limit | stopped at the minute | at the limit, a run whose last round made progress (fewer failures, or green tests with a review note) gets the limit again, at most twice (`factory.run.extended`) |
| Stuck run | waited for its timer | the supervisor cuts a run with no progress for 30 awake minutes (`SF_STUCK_MINUTES`) |
| Stopped run | waited for Retry | tried again from its step, at most 2 times by itself, then it waits for you (said on its ticket) |
| Queue | moved only when an event woke the dispatcher | the supervisor asks the dispatcher every minute |

## The supervisor's look (`factory/supervisor.ts`, once a minute, free)

1. Keep-awake on while anything works.
2. Stuck: a run in flight, not waiting at a gate, with no heartbeat for 30 minutes is stopped by `supervisor`.
   The heartbeat is any event of the run plus every line its agent streams.
3. If auto-work is on and preflight is clear: one stopped or failed run of the last 48 hours is tried again, unless
   it was stopped by you, refused money, rejected at a gate by you, waits for your answer, or failed the same way twice.
   Money: `retryAddUsd`, at most the asked-work cap, inside the project's budget and today's auto-work limit
   (a ticket's try is written as a dispatcher start; a ticket-less try counts through `factory.supervisor`).
   After 2 automatic tries (the dispatcher's count too) it escalates once: `factory.supervisor {action:"escalated"}`
   and a note on its ticket.
4. `tickets.dispatch()` so the next ready ticket starts.

`GET /api/supervisor` feeds the Supervisor card on All builds.
