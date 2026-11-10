# The Improvement Council

A standing loop that looks again at what already exists and proposes how to make it better. The build Council reviews a *new* idea before it is planned; the Improvement Council reviews *old* ones: projects, ideas with notes, shipped apps, and SoftwareFactory itself.

```
pick a subject: changed since its last review, or not looked at for 14 days
  → read it from the database: rules, notes, ideas under it, its runs (spec, review findings,
    Council concerns), the person's other projects, and everything already proposed
  → six lens seats answer in parallel, at most 2 proposals each (Haiku, $0.03 cap a call)
  → plain code merges alike proposals (two lenses agreeing ranks higher), drops anything
    already proposed for that subject or rejected anywhere, keeps the top 5
  → the Improve tab: Accept, Park or Reject with one tap
  → accepted: a ticket when the ticket system is loaded, otherwise a task Signal filed under
    its project; "Build it" starts a factory run (you approve its plan as usual)
```

## Lenses

Six built-in agents on the `improve` station (Agent Bay, Improvement Council row). Each is an ordinary agent: edit its prompt, swap it out, put your own agent on a seat.

| Seat | Lens | Looks for |
|---|---|---|
| Integrator ⇄ | integrate | parts two projects should share, data one should pass to another |
| Automator ⟳ | automate | steps a person still does by hand that a loop or agent could take |
| Simplifier ◌ | simplify | steps, options and concepts to cut |
| Enricher ✚ | enrich | where more depth would pay off |
| UX Lens ◐ | ux | what the person sees and taps |
| Flow Lens ⇢ | flow | order of steps, handoffs, loops, waits |

## Money

- Haiku by default, $0.03 cap per lens call, **$0.20 a day** for the whole council (changeable in the tab, or `SF_IMPROVE_MAX_USD`). Each seat reserves its cap before it calls, so parallel seats can never overshoot the day's cap together.
- **On its own** it looks every 6 hours (`SF_IMPROVE_EVERY_H`, or the tab), only on the real crew, only when something changed, and pauses while 12 proposals wait for you. The practice crew answers only when you press *Look now*.
- It never starts a build: accepting files work; building takes a second tap.

## Memory

Every proposal and your answer stays in the log. Lenses read what was already proposed for the subject (and what you rejected elsewhere) and are told never to repeat it; plain code drops anything alike anyway. Notes the council itself filed do not count as a change, so it never reviews its own answers.

## Interfaces for other modules

- `improve.proposal.accepted` `{ id, title, body, lens, lenses, target: { kind, id, title }, impact, effort, source? }`: the ticket system opens a ticket and appends `improve.proposal.linked { id, ticketId }` in the same tick; when nobody links it, the council files a task Signal.
- `repo.suggestion` `{ projectId, suggestionId, title, body, lens, severity, effort?, files }`: filed into the queue through the same dedupe, with `source: { kind: "repo.suggestion", eventId, suggestionId }`.
- `registerImproveContext(name, (log, target) => string | null)`: add text to what every lens reads (for example a code map of an imported repo).
- Project detail facet `improvements`: proposal counts by status.

## Storage

`improve_sessions` (one row per session: subject, trigger, seats, cost, counts) and `improve_proposals` (one row per proposal with lenses, score, your answer, ticket or Signal), derived from `improve.*` events by the `improve` projection.

API: `GET /api/improve/state`, `POST /api/improve/run { target? }`, `POST /api/improve/proposals/:id/decide { decision }`, `POST /api/improve/proposals/:id/build`, `POST /api/improve/settings { auto?, maxUsd?, everyHours? }`.
