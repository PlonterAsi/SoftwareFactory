# Product specification

What SoftwareFactory is for, what it must do, and how far the code is. The status column was filled by reading the code on `main` on 2026-11-14, not from plans.

**Built** means it is in the code and reachable in the app. **Partial** means part of it works, and the row says which part. **Planned** means it was asked for or designed and is not in the code.

This document states the requirements. The audit of every idea ever discussed, one by one, is kept by its own thread and is not repeated here.

## 1. Purpose

One place for one person to develop applications, tools and software and to manage every project around them. A single line is enough to start: agents working in loops take the idea through design, plan, build, test, review and judgement to a working program, with as few human stops as possible. Everything the factory does, and everything it builds, can be seen.

The first user is Assaf, on Windows, working alone.

## 2. Principles

These hold for every feature. Each has a place in the code that enforces it.

| # | Principle | Held by |
|---|---|---|
| P1 | **Order from mess.** Parallel, branching ideas are filed to the right project, idea and thread; noise is hidden; important rules stand out; stale notes fade; conflicting rules are found and resolved. | Order Engine (`packages/core/src/order`) |
| P2 | **Visualize everything.** Every step, computation, worker, agent and project has a visual. A station may not pass until its output has the event its view draws from. | `factory/visualize.ts`, the Brain |
| P3 | **Real programs, not scripts.** What the factory builds has a screen, full create, read, update and delete for what it manages, and never asks the person to write raw data or guess arguments. | App kit, app check, the Brain ([apps.md](apps.md)) |
| P4 | **Few human stops.** Two approvals per build. Anything else stops only when the engine has used its own means. | Gates in `factory/loop.ts` |
| P5 | **A loop needs an outside observer.** Work is judged by tests, a real browser, or a separate agent; never by the agent that did it. | Locked tests, screen check, Critic, Reviewer, Product Judge |
| P6 | **Money is capped at every level.** Per call, per run, per project, per day for background agents. A budget rise is never automatic. | `runtime.ts`, `factory/loop.ts`, `projects/budget.ts` |
| P7 | **Nothing is lost.** The event log is append-only and every table can be rebuilt from it. Upgrades back up first. User data is never deleted by a test or an update. | `events.ts`, `store/` |
| P8 | **Project first.** Everything belongs to a project and each project has its own view. | `projects/` |
| P9 | **The factory improves itself.** Every run ends with a review of the engine; SF's own work goes through SF tickets and returns as pull requests. | `factory/retro.ts`, `tickets/` |
| P10 | **Private code stays out.** Code from Assaf's other apps is never committed here. | Working rule ([development.md](development.md)) |

## 3. Requirements and status

### 3.1 From an idea to a product (the engine)

| Requirement | Status | Notes |
|---|---|---|
| Start a build from one line | Built | Assistant, Helm, Mission tab, API, headless CLI |
| A Council reads the idea first | Built | 3 to 6 seats, 2 rounds; skipped for small jobs (14 words or fewer, one ask) |
| The idea is designed before it is planned, in a loop of its own | Built | Designer ⇄ Critic, 5 scores, bar 4, 3 rounds; research is its own call |
| Product documents: brief, journeys (user and app flow), screens, requirements, rules | Built | Written into the project as `docs/product/*.md` |
| The plan comes from the documents and keeps every requirement | Built | Gap check by the Critic; designed screens the Planner drops are put back |
| A new version never descends from old plans | Built | Agents recall only the person's own words |
| Tests are written first and locked | Built | Dry run before locking; journey tests through the app's data layer |
| Build feature by feature, each in a fresh session | Built | Real crew and a run of $3 or more; smaller runs build in one call |
| Agents run what they write | Built | Workbench: file tools and an allowlisted shell |
| Fix loop with memory, stop rules and an escalation ladder | Built | Question the test, stronger model, then the person |
| Every screen opens in a real browser; every link opens | Built | Uses the browser on the computer (Edge on Windows); skipped, not passed, without one |
| The running app is judged as a product | Partial | The judge reads every screen's text and controls and scores it. It does not click through a journey. |
| Send-back at a gate is carried out and survives a restart | Built | |
| A run resumes after a crash, close or update | Built | Up to 3 times by itself, then a button |
| Every run ends with an engine review | Built | Written by the core from events, no agent call |
| Same prompt compared across engine versions | Built | Engine cycles page |
| A failure in a run becomes an engine change inside SF | Planned | Done by people and threads today; the review is the work list |
| A complete, good product from one prompt | Partial | The benchmark ("Game Mastery", same prompt each time) reached 35 of 40 requirements seen working in cycle 5 for $10.65. Open engine items: designs that assume data research cannot return, invented links, the last part of screen detail. |
| A preflight step before a run spends money | Planned | From the harness plan |
| Harness evaluations (the harness tested as a product) | Planned | From the harness plan |

### 3.2 Agents

| Requirement | Status | Notes |
|---|---|---|
| Create, edit, clone, import, export and retire agents | Built | Agent Bay; files mirror Claude Code subagent files |
| Versions with diff and rollback | Built | |
| Test an agent on a sample task | Built | One capped call, judged by its station's verifier |
| Assign agents to stations | Built | Drag onto a seat; applies to the next call |
| Per-agent model, cap, plugins, skills, tools and MCP servers | Built | Each agent loads only its own kit ([mcp-safety.md](mcp-safety.md)) |
| Stats per agent and version | Built | Calls, cost, verdict pass rate, live state |
| Shared principles for all agents, editable | Built | The Brain |
| A free crew to learn the loop | Built | Practice crew |
| Built apps can ask one of the person's agents for work | Built | `POST /api/apps/agent`, local callers only, capped |

### 3.3 Order from mess

| Requirement | Status | Notes |
|---|---|---|
| File anything said, in any order | Built | Signals, Archivist, fragments |
| Capture from outside the app | Built | Drop folder: a `.txt` or `.md` file becomes a Signal |
| Rules and decisions kept as Canon with their source | Built | |
| Conflict detection and resolution | Built | Precedence in code; a card when tied |
| Unsure placements never block | Built | Unsorted tray |
| Stale notes fade; old questions are raised; undo | Built | Daily sweep and briefing |
| One chat per project plus a General chat | Built | |

### 3.4 Projects

| Requirement | Status | Notes |
|---|---|---|
| Everything belongs to a project; a view per project | Built | Tabs from a registry |
| Duplicate project names blocked; duplicate builds caught | Built | Same idea within 24 hours asks first |
| Merge, archive, rename | Built | |
| Money limits per project and per version | Built | Money tab |
| Use a finished project from inside SF | Built | Use tab: one Start press, data as forms, tools without arguments |
| Add a finished project into SF | Built | Tool, panel, plugin, or a brief for a pull request |
| Import a git repository as a project | Built | Read-only exploration, code map, suggestions, cost cap |
| Several factories (bases) in one app | Built | |
| SF closes every process it starts | Built | Launched apps and add-on backends stop with the core; an agent call that runs out of time is killed with its whole process tree; the core exits when the window is gone |

### 3.5 Tickets

| Requirement | Status | Notes |
|---|---|---|
| Kinds with their own questions, next-move statuses, append-only thread, links | Built | |
| Epics, tickets, subtasks; keys per project | Built | |
| Agents open tickets and answer on them | Built | Failed runs, errors, Order Engine, improvements |
| The crew works a ticket and writes back | Built | A factory run, or a branch in a clone of the project's repository |
| The crew starts ready tickets by itself within caps | Built | $0.60 a ticket, $3 a day, 2 at once |
| SF's own tickets return as draft pull requests | Built | Needs the real crew and a GitHub write token; never pushes to main |
| Errors become bug tickets; a Report a bug button | Built | |
| Import of tickets from Assaf's earlier systems | Planned | Needs a read-only copy of the old data |
| Files and screenshots on tickets as a gallery | Planned | A bug report attaches the screen; no general attachments |
| Sprints, estimates in points, burndown | Planned | |
| Bulk actions, sort and group options, export | Planned | |
| Several users, roles, watchers | Planned | SF is single-user and local |
| Rules engine for ticket moves | Partial | Fixed rules exist (auto-close on green tests, merged pull request moves the ticket); not editable as data |
| Tickets reachable from other devices | Planned | Would need a server or sync mode |

### 3.6 The app itself

| Requirement | Status | Notes |
|---|---|---|
| Desktop app for Windows, nothing else to install | Built | Ships its own Node.js |
| Production-grade original UI (Foundry Glass) | Built | One shell; [design.md](design.md) |
| One list of everything that waits for the person | Built | Needs you |
| A dashboard of the whole factory | Built | Factory Bridge, three views |
| In-app updates, automatic and by button | Built | Signed; waits for running builds |
| Improvement Council | Built | Lens agents, daily cap, memory of past proposals |
| Plugins | Partial | Tabs, sandboxed backend and agents are built. A network switch for backends, plugins calling agents with a cap, and a shared catalog are not. |
| Data vault with rebuild | Built | |
| Every feature has a record (purpose, spec, flow, design), its wiring is read from the code, and it shows proof it is alive | Built | Feature map; a check fails the build when a feature has no record ([feature-map.md](feature-map.md)) |
| The same record rule for features of the apps the factory builds | Built | Each feature in `src/schema.js` needs a purpose, a flow and a place; the app check refuses a build without them |
| The Brain changes from what the person and the runs say | Partial | The person's rules are offered to it with one press. Lessons from runs are not yet. |
| The factory as a game ("Sector": a real-time strategy base over SF's data) | Planned | Design approved in direction; three small demos exist as plugins ([game-door.md](game-door.md)) |
| macOS and Linux installers | Planned | Runs from source on any system with Node 22.5+; only Windows is built and tested |
| Code-signed installer | Planned | Costs money; Windows SmartScreen warns until then |
| Private repository | Planned | The app can already update from a private repository with a read token |

## 4. Limits in force

| Limit | Value | Where |
|---|---|---|
| A run without its own cap | $1.50 | `projects/budget.ts` |
| Smallest build that may start | $0.25 | `projects/budget.ts` |
| Feature-by-feature build starts at | $3.00 | `factory/features.ts` |
| Design loop share of a run | 35% | `factory/discovery.ts` |
| Build loop share of a run | 55% | `factory/features.ts` |
| Repair share of a run | 25% | `factory/evaluate.ts` |
| Fix rounds before asking | 5 | `factory/loop.ts` |
| Run time | 30 minutes up to $2, in proportion above, 4 hours at most | `factory/stoprules.ts` |
| A ticket worked by the crew | $0.60, $3 a day, 2 at once per project | `tickets/` |
| Improvement Council | $0.20 a day | [improve.md](improve.md) |
| Archivist | $0.50 a day | `SF_ORDER_MAX_USD` |

More in [reference.md](reference.md).

## 5. Not goals

- A cloud service or a multi-user product. SF is local and single-user.
- Replacing the business features of Assaf's other apps. SF builds and manages software; at most it builds their successors.
- Running agents with no cap, or raising a cap without the person.
- A game engine. The game direction, if built, is drawn with plain web graphics over SF's own data.

## 6. Technical decisions

| Decision | Choice | Date |
|---|---|---|
| Shell | Tauri 2 (Rust) | 2026-11-10 |
| Core | TypeScript on Node.js 22.5+, no framework | 2026-11-10 |
| UI | React, React Flow, Vite | 2026-11-10 |
| Data | SQLite: append-only event log plus projected tables; files only for generated repositories; an in-memory cache | 2026-11-10 |
| Agent runtime | Headless Claude Code CLI in a lean profile, behind an adapter | 2026-11-10 (spike) |
| Built apps | Plain JavaScript on the app kit, tested with `node --test` | 2026-11-11 |

The reasons are in [architecture.md](architecture.md) and [spike-runtime.md](spike-runtime.md).
