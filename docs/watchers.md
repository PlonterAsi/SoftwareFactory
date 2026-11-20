# Watchers and monthly budgets

Phase 6 of the SF behavior brief (2026-11-17). The code is in `packages/core/src/watch/`: `watchers.ts`
(the four watchers and their schedule), `spend.ts` (monthly budgets and the burn rate) and `routes.ts`.
The screens are the **Watchers** tab and the top of the **Money** tab on each project, and a strip on **Home**
for all projects.

## Watchers

A watcher looks at a project on a schedule and only opens tickets. It never changes code, never starts the
crew, and never spends money: every look is plain code.

| Watcher | Looks at | Opens a ticket for | As shipped |
| --- | --- | --- | --- |
| Code debt | the project's folder | each source file over 1,000 lines; 30 or more TODO/FIXME markers | weekly |
| Security | the project's folder | secrets and risky code (debug mode, eval, shell commands built from text), by kind; a `.env` that `.gitignore` does not ignore | daily |
| Dependencies | the project's folder | packages `npm audit` (or `pip-audit`, when installed) calls vulnerable; Python packages without `==` | weekly |
| Flaky tests | the project's builds | a test that passed and then failed again inside one build, in two or more builds | daily |

- The folder is the project's first folder that exists on this computer (your folder, the imported repo, or
  its own build). A project with none: the folder watchers say so and wait; Flaky tests still reads the records.
- **Filed once.** Each finding has a fingerprint (`watch:<project>:<watcher>:<finding>`). A finding that
  already has a ticket, open or closed, is not filed again. A finding that changes (more markers, another
  vulnerable package) is a new finding.
- **Gone, closed.** When a look runs to the end and no longer finds what a watcher ticket names, that ticket
  closes by itself with a note, as long as nobody has started on it (open or ready). The code was fixed, or the
  finding changed and has a ticket of its own. A ticket in progress or built stays as it is, and a dependency
  tool that could not run this time leaves its earlier tickets alone.
- **No floods.** One look opens at most five tickets; the rest wait for the next look.
- **Open, not ready.** A watcher's ticket is open, tagged `watcher`, so the crew does not pick it up until you
  make it ready.
- A secret's value is never copied into a ticket, only where it is.

Each watcher has a switch, a schedule (every 6 hours, daily, weekly or monthly) and **Look now**. The core
checks for looks that are due every 30 minutes.

## Monthly budgets

A monthly budget can be set for each project and for everything together. A month is the calendar month on
this computer's clock, and the budget renews on the 1st.

Spend is read from the agent calls in the log, so it cannot drift from what was paid. A call is charged to a
project when it was made for one: its ticket's project, its build's project, or the project it names. The rest
(the Archivist, the council, a chat) counts toward the overall month only.

- **Burn rate**: the average spend per day over the last seven days.
- **Month ends near**: what is spent plus the burn rate times the days left.
- **Runs out**: the day the budget runs out at that rate, when that is before the month ends.

These sit beside the limits that were already there: a cap per agent call, a cap per run, and a project's total
and per-version amounts (docs/projects.md).

## A queue that fits them

On the real crew (the practice crew costs nothing, so budgets do not hold it):

- A ready ticket waits in the queue while its month (the project's or the overall, whichever has less left)
  has less left than one start may spend (the auto-work cap, $0.60 by default). Its place in the queue says
  "Waits for money" and why. It starts by itself when money is there again: a higher budget, or the new month.
- A start you press gets no more than the month has left, and is refused when less than $0.05 is left.

## Events and API

| Event | Payload |
| --- | --- |
| `watcher.set` | `{ projectId, kind, on, everyHours }` |
| `watcher.ran` | `{ projectId, kind, found, opened: ticketIds[], note, error? }` |
| `budget.monthly` | `{ projectId: number \| null, usd: number \| null }` |

```
GET  /api/watchers?project=ID                    the project's watchers: settings, last look, next look
POST /api/watchers/:project/:kind     { on?, everyHours? }
POST /api/watchers/:project/:kind/run           look now
GET  /api/budget/month[?project=ID]              this month: budget, spent, burn rate, where it ends
POST /api/budget/month                { projectId: number | null, usd: number | null }
```
