# Tickets

A ticket is one unit of work on a project: a bug, a request, a task, an idea, a plan, or a question waiting on a person. You open tickets, and so do the factory's agents. The crew works them through the factory loop and writes back onto them. The Bridge shows them on the **Tickets** tab as a list, a board, and a ticket page.

The design keeps the essence of a ticket system Assaf already runs in another app of his: a ticket of a kind asks that kind's questions, the status is offered as the next move, "built" means it waits for your look, the thread is append-only, and agents reply onto the ticket instead of somewhere else.

## The record

| Kind | Asks (the first one is required, and the description answers it if you leave it empty) |
|---|---|
| bug | what you expected · how to make it happen · since when · how often (+ severity: blocking, annoying, cosmetic) |
| request | the need, and why · how it is done today · what "built" means |
| task | what to do · what "built" means |
| idea | the core in one sentence · the problem · why now · what it is not |
| plan | the goal · how we will know it worked (+ ordered lines: any ticket can be a line) |
| question | the question · the options · what we recommend · the answer |

Questions are data in `packages/core/src/tickets/model.ts` (`FORMS`): adding one is a line, no migration. Each field is edited on its own; sending one field never resets another.

**Statuses**: open → ready → in progress → built (for your look) → closed, or rejected. The page offers only the next moves: from built, "Close, I saw it, good" or "Reopen, not good yet"; from closed, "Reopen". A move carries a note in the same step.

**Who may close**: requests, ideas, plans and questions are taste, so only you close them. Agents and rules leave them built for your look. A closed ticket never moves by itself; a late run or agent reply only adds a line to the thread.

**Links**: related, duplicate of (closes the duplicate), derived from ("a new ticket from this one"), blocks. A link shows on both tickets.

## Agents and the loop

- **Work it with the crew**: the ticket's work document becomes a factory run (Council, plan, locked tests, build, review, fix, ship). The ticket moves to in progress; gate waits, the ship and failures land on its thread; when the run ships, it moves to built.
- **Work it in the repo**: when the ticket's project was imported from an existing git repo (or has a `repo` link to a folder on this computer), "Work it" works there instead of building a new repo. The Builder gets the work document and file tools (Read, Edit, Write, Glob, Grep; no shell) inside a clone of that repo in the factory's own `ticket-work/ticket-<id>` folder, on a new branch `sf/ticket-<id>-<slug>`. The original repo is never written to and nothing is pushed: the ticket's thread says which files changed and gives the `git fetch "<clone>" <branch>` that brings the branch into your repo, so taking it is your call. The ticket moves to built for your look and never closes by the QA rule, since no locked tests ran. Working it again reuses the same clone and branch. Capped at $0.60 a pass by default (the Builder's own cap if lower).
- **The QA rule**: a bug or task whose run shipped with every locked test green closes by itself, because the one who checks is not the one who builds. Writing "needs a look", "don't close" or "keep open" on the thread pulls the hand brake.
- **Ask an agent**: the assignee (or the Overseer) reads the work document and replies on the thread in one short, capped call (at most $0.10). If it says the ticket can be built as written, an open ticket moves to ready.
- **Tickets open themselves**: a factory run that fails on its own opens a bug; a task or question the Order Engine files from what you say opens a ticket under its project; an accepted Improvement Council proposal opens an idea (a code suggestion from an imported repo opens a task). A `fingerprint` makes each of these idempotent: seen again adds a note, never a second ticket.
- **Any other module** can ask for a ticket by appending `ticket.requested { title, kind?, body?, project?, priority?, severity?, source, by?, fingerprint?, ref? }`; the ticket service opens it and its `ticket.opened` carries `request` and `ref`.

## Storage

Events `ticket.opened`, `ticket.edited`, `ticket.noted`, `ticket.linked`, `ticket.run`, `ticket.branch`, `ticket.line.moved`, `ticket.requested`; tables `tickets`, `ticket_notes`, `ticket_links`, owned by the `tickets` projection (rebuildable from the log like every table, see [storage.md](storage.md)). Each ticket is also linked to its project (`project.linked { kind: "ticket" }`), and every project's detail carries a `tickets` facet (open, for your look, newest five).

```sql
-- What waits for your look
SELECT id, kind, title FROM tickets WHERE status = 'built' ORDER BY updated_at;
-- What the crew spent answering tickets
SELECT agent, count(*), round(sum(cost_usd), 4) FROM agent_runs WHERE station = 'ticket' GROUP BY agent;
```

## API

```
GET  /api/tickets?project=&view=open|look|agents|plans|closed|all&kind=&q=   list + counts
GET  /api/tickets/meta                 kinds with their questions, statuses, priorities, severities, relations
GET  /api/tickets/:id                  ticket, thread, links, plan lines, next moves, work document, its run
GET  /api/tickets/:id/document         the work document as Markdown
POST /api/tickets                      { kind, title?, body?, answers?, project?, priority?, severity?, assignee?, parent?, tags? }
POST /api/tickets/:id/edit             { field, value, key? }   one field; field "answer" with key for a question
POST /api/tickets/:id/say              { text, status? }        a note, and optionally a status move
POST /api/tickets/:id/link             { to, relation, removed? }
POST /api/tickets/:id/line             { dir: "up" | "down" }   reorder a plan line
POST /api/tickets/:id/spawn            { kind, title, ... }     a new ticket, linked derived from
POST /api/tickets/:id/work             { maxUsd?, where?: "auto" | "repo" | "new" }   in the project's repo when it has one, else a factory run
POST /api/tickets/:id/ask              { agent? }               one capped agent reply on the thread
```
