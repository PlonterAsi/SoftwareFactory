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

**One timeline** (2026-11-17): a ticket's page shows one append-only timeline, oldest first: what people said, every status move, and what the crew did for it: each step of its runs (passed, failed, skipped), every agent call with its model, time and cost, the decisions at the gates and the questions put to you, retries and fix rounds, the run starting and ending, its branch, push and pull request. Filters show everything, only what was said, the crew at work, decisions, or branch and PR. It is derived from the event log (`ticket_notes` for the thread, `ticket_trace` for the crew's part, linked by `ticket_runs`), so it can be rebuilt and never loses a line.

**Who may close**: requests, ideas, plans and questions are taste, so only you close them. Agents and rules leave them built for your look. A closed ticket never moves by itself; a late run or agent reply only adds a line to the thread.

**Links**: related, duplicate of (closes the duplicate), derived from ("a new ticket from this one"), blocks. A link shows on both tickets.

## Keys, levels and what waits on you

- **Keys.** Each project has a short key and numbers its tickets from 1: `SF-42` is ticket 42 of SoftwareFactory's own project. SoftwareFactory is always `SF`; other projects take letters from their name ("Garden planner" is `GP`), with a digit added if taken. The key is given once (`ticket.keyed`) and stays when the project is renamed. A ticket moved to another project takes the next number there, and its thread keeps the old key. Search, links and `GET /api/tickets/key/SF-42` all take keys; `#7` still finds ticket 7 of the whole factory.
- **Three levels, never more.** An **epic** (the plan kind) holds tickets; a **ticket** may hold **subtasks**; a subtask holds nothing. Parent and child share a project. Anything bigger than an epic is a project of its own. When every ticket of an epic is built, closed or rejected, the epic moves to built for your look (an epic is taste: it never closes by itself).
- **Blocked** is a flag, not a status: a `blocks` link from a ticket that is still open. It clears when that ticket closes.
- **Waiting on you** is one list across every project, at the top of the Projects page and first on the Tickets tab: what is built (take a look), questions (answer), and ideas or requests an agent opened (build it or not). Each row carries the moves that answer it. `GET /api/tickets/waiting?project=`.

The full design, and what comes next (tickets driving the loop, SoftwareFactory building itself through PRs), is in the ticket system design doc.

## The ready queue: the crew starts work by itself

A ticket that reaches **ready** joins its project's queue, ordered by priority, then age. The crew starts the next one on its own when the rule allows, and says so on the ticket; everything else waits for your Work it press, and the ticket page says why in one sentence.

- **The rule**: a bug or task, sized S or M, not blocked, not taken by you (assignee "you"), and no hold words from you on its thread ("hold", "don't close", "needs a look"). Requests, ideas, epics and questions are taste: they never start by themselves unless you asked for them (below). Size L is split first, or started by you.
- **Work you asked for** (2026-11-18): when you ask for work, that is the approval. A ticket marked **asked for** (the "Ask the crew to do it" button on the ticket, the tick on New ticket, which is on by default for bugs, tasks and requests, or an ask said in a repo project) joins the queue as soon as it is open, goes first, and starts by itself at your **per-run limit for asked work** ($3 by default), of any kind or size: feature-sized work goes on the engine, and a plan bigger than the limit is sliced into runs that fit ([engine.md](engine.md#a-plan-is-checked-against-the-money-sf-64)). An epic's mark covers its tickets, which start one by one. Hold words, blocks and an assignee of "you" still keep it off. If its run stops or fails, the crew retries it once from where it stopped (Retry, below); after two starts of its own it leaves the next try to you. `POST /api/tickets/:id/asked { on }`.
- **Retry** (SF-65): a ticket whose run stopped or failed shows "Retry from <step> (+$x)". It picks the same run up at that step, on the same branch, keeps what was built, and adds money sized to what is left (a whole session per feature not built, plus room for the review and judge), bounded by the project's budget. `POST /api/tickets/:id/retry`, or `POST /api/factory/runs/:id/retry { addUsd? }`.
- **Size** (S, M, L) is set by whoever reads the ticket: Ask an agent now ends with a `SIZE:` line and fills it if it is empty, or you set it on the ticket page.
- **Caps, your standing limits**: at most 2 tickets worked at once per project, $0.60 per ready bug or task, $3 per run of work you asked for, and the caps of a day's own starts added up stay under the daily limit ($3 by default; the queue says "Waits for tomorrow" when the next start does not fit). Set them once with **Limits** beside the switch; within them the crew never asks for a press, a card or a typed phrase. An auto-started run approves its own gates (budget escalations still stop it), and the QA rule closes the ticket only on green locked tests.
- **Monthly budgets** (phase 6, [watchers.md](watchers.md#a-queue-that-fits-them)): on the real crew a ready ticket waits, saying "Waits for money", while its project's or the overall month has less left than one start's cap, and starts by itself when money is there again. A start you press gets no more than the month has left.
- **Watchers** ([watchers.md](watchers.md)) open tickets on a schedule, as open (not ready), so the crew leaves them until you make them ready.
- **The switch**: "Crew picks up: on/off" in the Tickets header; `GET/POST /api/tickets/auto { on, maxUsd, askedMaxUsd, dailyUsd, wip }`, saved as settings. `GET /api/tickets/queue?project=` lists each ready ticket with its place in line or the reason it waits.

## Each ticket follows a flow (2026-11-17, phase 2)

Every kind of work has its own flow in the library (`#/factory/flows`, [engine.md](engine.md#the-flow-library-2026-11-17-phase-2)). A ticket follows its kind's flow unless you pick another with the **flow** chip on the ticket page:

- **Bug fix** (bugs) and **Small change** (tasks and small asks): one Builder session in a clone of the repo, the checks with up to two fix rounds, a Reviewer, a commit and a draft PR. Bug fix tells the Builder to find the cause first and prove the fix with a test.
- **Refactor** (picked by you): the same session, told that behaviour must not change and existing tests stay as they are; the Reviewer is told too.
- **Research or question** (questions): a reader goes through a read-only copy of the repo, or the ticket and its project when there is none, and answers on the ticket with the files it read. No branch, no PR, nothing changed. Up to $0.30.
- **Feature in a repo** (requests, ideas, epics in a repo project): the whole engine on a branch. **New project**: the engine, for projects with no repo.

The ticket page says which flow it would follow and why. A flow you save for a kind (its `kinds`) takes over from the built-in one.

## The check before money (2026-11-17, phase 2)

Before a ticket costs anything, SF reads it (`tickets/precheck.ts`: plain code, free, instant) for three things and asks you first:

- **Clarity**: enough words to build from, the kind's first question answered, what right looks like for a bug.
- **Confidence**: no open words left ("maybe", "something", "not sure"), and not more than one session's work on a session flow (size L, or six listed asks).
- **Your call**: money, data that could be lost, secrets and accounts, going public, legal terms.

Work it runs the check first; the ticket page shows a **Before it costs money** box with each question, and you answer, or press Work it anyway (the caps still guard the money). The crew's own pickups skip a ticket the check holds. Answers go on the ticket's record (`answers["check.<id>"]`) and thread, and the check is on the ticket's timeline (`ticket.checked`). On Home, **Answer before money** lists every question across tickets in one sitting and starts the tickets that are then clear.

## Merging and versions (phase 3)

A crew PR whose CI passed shows on Home's Needs you as a **Merge?** card, with SF's merge review.
Merging, the per-project merge policy, outside work and versions are described in
[git.md](git.md).

## Home: the board across projects (2026-11-17, phase 2)

Home (`#/`) is every ticket across projects in four lanes: **Needs you** (questions before money, a run waiting for your OK, a build to look at, a question to answer, an idea to decide), **Running** (its flow and the step it is on), **In review** (an open draft PR) and **Done** (closed in the last two weeks). Above the lanes the flow of what runs now is drawn live: an engine run lit by its own events, a one-session ticket by its last step. The projects list moved to Projects (`#/projects`).

## SoftwareFactory builds itself: tickets come back as pull requests

SoftwareFactory's own project is linked to its GitHub repo (`github` link, `PlonterAsi/SoftwareFactory`, or `SF_SELF_REPO`), so Work it on an SF ticket works in a clone of that repo, on branch `sf/SF-12-short-title`, never in the running app. Any project with a `github` link works the same way. So does a repo imported from GitHub: it is worked from the copy the import made on this computer (no sign-in needed to start), and its branches go to GitHub as pull requests or on your press.

- **A draft PR, never main.** When the Builder changed something, the crew pushes that one branch and opens a draft PR titled `SF-12: …`; the ticket shows it and waits for your look. The crew never pushes to main, master, production or release branches, whatever it is asked. Windows CI runs on the PR as on any other.
- **Only the real crew, only with access.** The practice crew never opens a PR, and without a token the branch stays on this PC until you press **Send to GitHub** on the ticket: that pushes only that branch with this PC's own Git sign-in and gives the link that starts the pull request (with a token, the same press opens the draft PR). `POST /api/tickets/:id/send`. The token is a fine-grained GitHub token (Contents and Pull requests, read and write) pasted in Systems, Crew pull requests. It is kept in `github-token` in the data folder, sent only to github.com as a header, and never written to the database, the log, a ticket or a prompt. `GET/POST /api/tickets/github`.
- **A merge moves the ticket on.** The core checks the crew's open PRs at start and every 5 minutes: merged closes a bug or task (it ships with the next version) and leaves a request or epic built for your look; closed without merging reopens the ticket.
- **Work merged elsewhere counts too.** A merged pull request whose title or branch names a ticket (`SF-13`, `SF-16, 17, 18`, `sf/SF-24-...`) is linked to it and moves it the same way, once per PR, so a ticket you reopen stays open. This read needs no token on a public repo. A ticket page also has "Done in a pull request elsewhere?": give the PR number or address (`POST /api/tickets/:id/pr {pr}`) and it is followed like the crew's own.
- **A project that lives in its own repo** (SoftwareFactory itself) opens on its work, not on the idea track: tickets waiting for your look, in work, ready next and merged lately, each with its PR.

## Agents and the loop

- **Work it with the crew**: the ticket's work document becomes a factory run (Council, plan, locked tests, build, review, fix, ship). The ticket moves to in progress; gate waits, the ship and failures land on its thread; when the run ships, it moves to built.
- **Work it in the repo**: when the ticket's project was imported from an existing git repo (or has a `repo` link to a folder on this computer), "Work it" works there instead of building a new repo. The Builder gets the work document and file tools (Read, Edit, Write, Glob, Grep; no shell) inside a clone of that repo in the factory's own `ticket-work/ticket-<id>` folder, on a new branch `sf/<key>-<slug>` (for example `sf/SF-12-dark-theme`). The original repo is never written to and nothing is pushed: the ticket's thread says which files changed, and **Add to my folder** on the ticket adds that branch to your own folder (your files and current branch there do not change), so taking it is your call and never a command to type. The ticket moves to built for your look and never closes by the QA rule, since no locked tests ran. Working it again reuses the same clone and branch. Capped at $0.60 a pass by default (the Builder's own cap if lower).
- **Work it on the engine**: a feature in a repo is more than one session's work. In a project that lives in a repo the ticket page suggests a route and says why: one Builder session for a bug, a task, a question or anything sized S; the whole engine for a request sized M, anything sized L, or an unsized ask longer than a small job. Both buttons are there, so the choice is yours. An epic that holds tickets gets neither: it is worked through its tickets, one branch each, and says so. On the engine the change is designed and criticised, planned for your approval, built on the ticket's branch in a clone (feature by feature for larger runs, with the repo's own tests after each), reviewed by running it and judged on the running site; then the branch comes back to the ticket as a draft pull request, or waits on this computer for the same **Send to GitHub** or **Add to my folder** press as any ticket branch (the run's page has the button too). It spends up to the project's limit for a next version ($1.50 unless you set one) and needs at least $1.50; the crew's own pickups, capped at $0.60, always take one session. See [engine.md](engine.md), "Imported repos run on the same engine".
- **One build of an idea a day**: "Work it" goes through the factory's duplicate check. Reworking the ticket's own shipped run after you reopen it is fine; when the same idea is already building, resumable, or was built today by another run, the ticket page says which run and offers "Open run" or "Work it again anyway" (`again: true`).
- **The QA rule**: a bug or task whose run shipped with every locked test green closes by itself, because the one who checks is not the one who builds. Writing "needs a look", "don't close" or "keep open" on the thread pulls the hand brake.
- **Ask an agent**: the assignee (or the Overseer) reads the work document and replies on the thread in one short, capped call (at most $0.10). If it says the ticket can be built as written, an open ticket moves to ready.
- **Tickets open themselves**: a factory run that fails on its own opens a bug; a task or question the Order Engine files from what you say opens a ticket under its project; an accepted Improvement Council proposal opens an idea (a code suggestion from an imported repo opens a task). A `fingerprint` makes each of these idempotent: seen again adds a note, never a second ticket.
- **Any other module** can ask for a ticket by appending `ticket.requested { title, kind?, body?, project?, priority?, severity?, source, by?, fingerprint?, ref? }`; the ticket service opens it and its `ticket.opened` carries `request` and `ref`.

## An ask is not a project

Not every idea is a project. "UI/UX improvement of SoftwareFactory" or "Error handling and logs for all projects" are asks about things that exist, so they belong on a ticket there.

- **SoftwareFactory has a project of its own** (linked `self:softwarefactory`), made at the first start. Asks about the app itself land there, and so do the errors it catches.
- **The intake reads an idea before it becomes a project.** "Create project" on the Projects page and "Build it" in the General chat ask the core first (`POST /api/tickets/intake`). The check is a word check, so it is free and instant. When the idea names a project you have, or is about SoftwareFactory or "all projects", or reads like a change to something that exists rather than a new thing to build, a card offers "File as a request on X" (the kind can be changed) next to "Start a new project anyway". It only offers; you choose. A project's own chat never asks: Build it there builds in that project.
- **Turn into ticket.** A project whose name reads like an ask shows a banner on its Overview, and every project but SoftwareFactory's has Settings › Turn into a ticket. The ticket gets the project's name, description, notes and runs. The project's idea node folds into the other project's home node (one body on the star map), and its runs, tickets and chats move along. The project is archived, with "Turned into ticket #N on X" as its description. "Keep it a project" hides the banner for good on that computer.

## The doors before the route: a question, another round (2026-11-18)

An ask said in a project (its idea box, the Assistant) is read for its door before any route, by its words (`intakeDoor` in `factory/route.ts`, free):

- **A question** ("Why does the login fail?", "Find out which pages are slow", "Is the form sending mail?") becomes a **question ticket** a reader answers on the thread, from a read-only copy of the repo, or from the ticket and its project when there is no repo. Nothing changes and no app is built, even in a project made from scratch. "Can you add…?" is work, not a question.
- **Another round** ("another round on the landing page", "re-loop this project", "improve it again") becomes an **epic of the round**: a reader goes through a read-only copy of the repo and lists 3 to 6 findings, each filed as a ready bug or task with its size under that epic. The crew works them like any ticket (asked for when you asked, so they start within your limit), and the epic moves on by itself when they are done. Repo projects only.
- **Anything else** is work: a request ticket on the light or engine route, as before. A route you choose always means work.

## Errors become bugs

Nothing that goes wrong is lost in a log nobody reads, and nothing is sent to an outside service.

- **In the core**: a route that throws a fault (a `TypeError`, a `RangeError`, anything that is not a plain sentence for you) answers 500 and files a bug; a plain `Error` such as "A ticket needs a title" stays a 400. A promise nobody caught, a failed Order Engine filing and a failed Council tick are filed too. An uncaught exception is filed as a *blocking* bug before the core stops, so the ticket is there when the app starts again.
- **In the Bridge**: an error on a screen, or a promise nobody caught, is posted to `POST /api/tickets/capture`. A screen that breaks shows what broke and which bug it was filed as, with Reload, instead of a blank window; the rest of the window keeps working.
- **One bug per error, not per occurrence**: the fingerprint is where it came from (core, bridge), the message with its numbers and quoted values blanked, and the first stack frame without its line, so the same fault after an edit is still one bug. A repeat adds "Seen again" to the thread, at most once in ten minutes, with the count in between.
- **After you close it**: a repeat opens a new bug, linked to the closed one ("This happened before as #N"), because a closed ticket never moves by itself. A rejected one stays rejected.
- **Never a flood**: at most 20 new error bugs an hour; the rest are counted and the count is said on the next one.
- **Secrets never reach a ticket**: GitHub and Slack tokens, `sk-` keys, Bearer/Basic values, `password=`/`token:`-style values and credentials in URLs are replaced before anything is written.
- **Report a bug** (the Bug button at the top): what happened and what you expected; the screen, the window size and the last errors are attached unless you untick it. The bug lands under the project you are looking at.

## Storage

Events `ticket.opened`, `ticket.edited`, `ticket.noted`, `ticket.linked`, `ticket.run`, `ticket.branch`, `ticket.pushed`, `ticket.line.moved`, `ticket.requested`; tables `tickets`, `ticket_notes`, `ticket_links`, owned by the `tickets` projection (rebuildable from the log like every table, see [storage.md](storage.md)). Each ticket is also linked to its project (`project.linked { kind: "ticket" }`), and every project's detail carries a `tickets` facet (open, for your look, newest five).

```sql
-- What waits for your look
SELECT id, kind, title FROM tickets WHERE status = 'built' ORDER BY updated_at;
-- What the crew spent answering tickets
SELECT agent, count(*), round(sum(cost_usd), 4) FROM agent_runs WHERE station = 'ticket' GROUP BY agent;
```

## API

```
GET  /api/tickets?project=&view=open|look|agents|plans|closed|all&kind=&q=   list + counts
GET  /api/tickets/waiting?project=     what waits on you: look, answer, decide, with the moves that answer it
GET  /api/tickets/board?project=       Home: lanes needs, running, review, done; each card with its flow and step
GET  /api/tickets/checks?project=      every ticket the check before money holds, with its questions
POST /api/tickets/checks               { answers: [{ id, q, text }], run? }   answers in one batch; run starts the tickets that are then clear
GET  /api/tickets/:id/check            the check before money for one ticket { verdict, questions, answered }
GET  /api/tickets/key/:key             a ticket by its key (SF-42) or #id
GET  /api/tickets/meta                 kinds with their questions, statuses, priorities, severities, relations
GET  /api/tickets/:id                  ticket, thread, timeline, links, plan lines, next moves, work document, its run
GET  /api/tickets/:id/document         the work document as Markdown
POST /api/tickets                      { kind, title?, body?, answers?, project?, priority?, severity?, assignee?, parent?, tags? }
POST /api/tickets/:id/edit             { field, value, key? }   one field; field "answer" with key for a question
POST /api/tickets/:id/say              { text, status? }        a note, and optionally a status move
POST /api/tickets/:id/link             { to, relation, removed? }
POST /api/tickets/:id/line             { dir: "up" | "down" }   reorder a plan line
POST /api/tickets/:id/spawn            { kind, title, ... }     a new ticket, linked derived from
POST /api/tickets/:id/work             { maxUsd?, where?: "auto" | "repo" | "new", again?, route?: "light" | "engine", anyway? }   runs the check before money first (409 { check } when it asks; anyway skips it);   in the project's repo when it has one (one session or the whole engine: route, else the ticket's kind and size decide; the reply says which and why), else a factory run (409 { duplicateOf, state } when that idea is built or building)
POST /api/tickets/:id/ask              { agent? }               one capped agent reply on the thread
POST /api/tickets/intake               { text, exclude? }       is it a new project, or an ask about one you have? { verdict, projectId, projectName, kind, why, confidence }
GET  /api/tickets/self                 SoftwareFactory's own project id (made when first needed)
POST /api/tickets/from-project/:id     { to?, kind? }           turn a project into a ticket on another (default SoftwareFactory)
POST /api/tickets/capture              { message, stack?, where, from?: "bridge" | "shell", context?, project? }   file an error as a bug (or "Seen again")
```
