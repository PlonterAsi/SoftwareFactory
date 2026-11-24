# Reference

The lists a developer or an agent looks things up in: API routes, events, tables, settings and limits. Collected from the code on `main` on 2026-11-14. When a list here and the code disagree, the code is right and this page needs a fix.

How to regenerate each list is at the end.

## 1. HTTP API

The core serves on `http://127.0.0.1:4317` (`SF_PORT`). Bodies and answers are JSON. Every write is also an event, so the Bridge sees it on the stream. Calls from a sandboxed plugin page (origin `null`) are refused.

Routing is in `packages/core/src/server.ts` and the `routes.ts` file of each module.

### Core, setup and stream

| Method and path | Does |
|---|---|
| `GET /api/health` | Runtime, crew mode, process id, Node version, schema version, app version, active runs, connected clients |
| `GET /api/events?since=<id>` | Server-sent events: every event after `since`, then live |
| `GET /api/cost` | Spend summary |
| `GET /api/setup` (`?fresh=1`) | Checks for Node.js, Claude Code, Git; crew mode; paths |
| `POST /api/setup/mode` | `{ mode: "practice" \| "real" }` |
| `POST /api/open` | Open a known folder (projects, drop, data, a run's folder) in the file manager |
| `GET /api/since` | The "since you left" lines |
| `POST /api/presence` | Mark how far the person has seen |
| `GET /api/updates`, `POST /api/updates` | Update status; record an update step reported by the shell |
| `GET /api/store` | The three storage tiers in one report (the installed-app smoke test reads it) |
| `POST /api/store/rebuild` | `{ name? }` rebuild one projection or all from the log |

### Signals, chat and the Assistant

| Method and path | Does |
|---|---|
| `GET /api/signals?q=` | List or search Signals |
| `POST /api/signals` | `{ text, source?, projectId? }` capture a Signal (free) |
| `GET /api/chat/routes` | Which chat each run, Signal and ticket belongs to |
| `POST /api/apps/agent` | A built app asks one of the person's agents. Local callers only |

### Factory runs

| Method and path | Does |
|---|---|
| `POST /api/factory/runs` | `{ idea, maxUsd?, autoApprove?, models?, council?, projectId?, again? }` start a run. `409` with `duplicateOf` when the idea repeats one |
| `GET /api/factory/runs/:id` | The run's row and current station |
| `POST /api/factory/runs/:id/gate` | `{ gate, approve, note? }` answer gate A, gate B or an escalation |
| `POST /api/factory/runs/:id/resume` | Resume a stopped run |

### Projects

| Method and path | Does |
|---|---|
| `GET /api/projects` | Every project with its rollup |
| `POST /api/projects` | `{ name, kind?, summary? }`. `409` when the name is taken, with a suggestion |
| `GET /api/projects/of?kind=&ref=` | Which project owns a thing |
| `GET /api/projects/:id`, `POST /api/projects/:id` | Detail; edit name, kind, summary, status |
| `POST /api/projects/:id/links` \| `unlink` | `{ kind, ref }` |
| `POST /api/projects/:id/runs` | `{ idea, maxUsd?, again?, … }` start a run in this project, or its next version on top of what shipped |
| `POST /api/projects/:id/screen` | Turn a shipped script into an app |
| `POST /api/projects/:id/merge` | `{ into }` |
| `GET /api/projects/:id/budget`, `POST /api/projects/:id/budget` | Money limits and spend per version |

### Agents (the Bay) and the Brain

| Method and path | Does |
|---|---|
| `GET /api/bay/state` | Agents, versions, slots, stats |
| `POST /api/bay/agents` \| `import` \| `draft` | Create; import an agent file; draft one from a line |
| `GET /api/bay/agents/:id/file?version=` | Download as `.agent.md` |
| `GET /api/bay/agents/:id/versions/:n` | One version |
| `POST /api/bay/agents/:id/save` \| `clone` \| `rollback` \| `retire` \| `test` | |
| `POST /api/bay/slots/:slot` | `{ agents: [ids] }` assign a station's seats |
| `GET /api/brain` | Principles, stations, who works each |
| `GET /api/brain/prompt?station=` | The exact system prompt that station's agent runs with now |
| `POST /api/brain`, `PUT /api/brain/:id`, `POST /api/brain/:id/reset` | Add, edit, reset a principle |
| `GET /api/feature-map` | Every feature: its record, its wiring from the code, its proof of life, and what is connected to nothing |
| `POST /api/feature-map`, `PUT /api/feature-map/:id`, `POST /api/feature-map/:id/reset` | Add a planned feature, edit a record, reset or remove it |

### Order Engine

| Method and path | Does |
|---|---|
| `GET /api/order/state` | Nodes, fragments, Canon, conflicts, briefings |
| `POST /api/order/nodes` | `{ kind, title, parentId? }` |
| `POST /api/order/sweep`, `POST /api/order/briefing` | Run the sweep; write the briefing |
| `POST /api/order/fragments/:id/move` \| `pin` | |
| `POST /api/order/conflicts/:id/resolve` | `{ winner }` |
| `POST /api/order/sweeps/:id/undo` \| `accept` | |

### Tickets

| Method and path | Does |
|---|---|
| `GET /api/tickets?project=&view=&kind=&status=&q=&parent=` | List with counts |
| `GET /api/tickets/meta` \| `queue` \| `waiting` \| `self` | Forms and words; the ready queue; what waits on you; SF's own project id |
| `GET /api/tickets/key/:key` | By key, for example `SF-42` |
| `GET /api/tickets/:id`, `GET /api/tickets/:id/document` | The ticket; its work document as Markdown |
| `POST /api/tickets` | Open a ticket |
| `POST /api/tickets/:id/edit` \| `say` \| `link` \| `line` \| `spawn` \| `work` \| `ask` | Edit a field; add to the thread (with a status move); link; reorder an epic line; new ticket from this one; work it; ask an agent |
| `POST /api/tickets/capture` | An error the Bridge or the shell caught, filed as a bug ticket |
| `POST /api/tickets/intake` | Before an idea becomes a project: is this text an ask about a project that exists? |
| `POST /api/tickets/from-project/:id` | Turn a mistaken project into a ticket |
| `GET /api/tickets/github`, `POST /api/tickets/github` | Whether the crew's write token is set; set or clear it |
| `GET /api/tickets/auto`, `POST /api/tickets/auto` | `{ on, maxUsd, dailyUsd, wip }` the ready queue's switch and caps |

### Imports, launch, finished apps, add-ons

| Method and path | Does |
|---|---|
| `GET /api/imports`, `POST /api/imports` | List; import `{ source, name?, maxUsd? }` |
| `GET /api/imports/:projectId`, `POST /api/imports/:projectId/explore` | Detail with code map; explore again |
| `POST /api/imports/:projectId/suggestions/:id/decide` | `{ decision: "accepted" \| "rejected" }`: a yes opens a task ticket on the project, a no drops the suggestion |
| `POST /api/imports/follow` | `{ on }`: keep imported repos current by themselves. Every 12 hours each source is asked for its newest commit (free); when it moved, the repo is explored again (at most $0.15 a time, $0.50 a day in all). On by default; setting `importsFollow` |
| `GET /api/launch/projects/:id` | How this project can be run |
| `POST /api/launch/projects/:id/start` \| `go` \| `folder` \| `terminal` \| `files` \| `samples` | Start a way of running it; one-press start; use a folder of yours; open a terminal; save, rename or delete a data file; make sample inputs |
| `GET /api/launch/projects/:id/files?dir=&path=` | Its data files |
| `GET /api/launch/sessions/:sid` \| `/stream`, `POST …/stop` \| `/input` | A running session: output, live stream, stop, typed input |
| `POST /api/launch/open`, `GET /api/launch/browse?path=` | Open a local address in the browser; folder and file picker |
| `GET /preview/:id/…` | A project's plain pages while its preview is on |
| `GET /api/integrations`, `POST /api/integrations` | Finished apps and requests; ask to add one |
| `GET /api/integrations/assess/:projectId` | Readiness checks and possible forms |
| `GET /api/integrations/:id`, `POST …/decide` \| `remove` \| `run` | Detail; approve or reject; remove; run an installed tool |
| `GET /ext/:id/…` | An installed panel's files |
| `GET /api/plugins`, `POST /api/plugins/install` | Installed and bundled add-ons; install `{ dir }` or `{ example }` |
| `GET /api/plugins/:id`, `GET …/log` \| `data` \| `events` | |
| `POST /api/plugins/:id/enable` \| `disable` \| `remove` \| `call` | |
| `GET /plugins/:id/…`, `GET /plugins/_sdk/sf.js` \| `sf.css` | An enabled add-on's pages; the page SDK |

## 2. Events

Every row of the log is `{ id, ts, type, payload }`. A run's id is the id of its `factory.run.started` event; a project's id is also an event id ([projects.md](projects.md)).

| Family | Types |
|---|---|
| Signals | `signal.captured` |
| Agent calls | `agent.run.started`, `agent.run.completed`, `agent.run.failed`, `agent.run.retried`, `agent.verdict` |
| Run life | `factory.run.started`, `factory.run.resumed`, `factory.run.finished`, `factory.station`, `factory.gate`, `factory.budget`, `factory.continued`, `factory.sentback.resumed` |
| Council and design | `factory.council`, `factory.recall`, `factory.research`, `factory.discovery` |
| Plan | `factory.plan`, `factory.plan.gaps` |
| Tests | `factory.tests`, `factory.tests.dryrun`, `factory.tests.locked`, `factory.tests.disputed` |
| Build | `factory.files`, `factory.feature`, `factory.fastgate`, `factory.ui`, `factory.screens`, `factory.screen.look`, `factory.links`, `factory.links.blanked` |
| Fix | `factory.attempt`, `factory.ladder` |
| Review and judge | `factory.review`, `factory.review.open`, `factory.evaluation`, `factory.repair`, `factory.repair.stopped` |
| Engine in a repo | `factory.repo` (the clone, its branch, its stack, how its tests and site run), `factory.branch` (the branch handed over: its pull request, or why it stayed in the clone) |
| Engine review | `factory.retro`, `factory.visual` |
| Order Engine | `order.ingest`, `order.node`, `order.fragment`, `order.fragment.moved`, `order.fragment.pinned`, `order.conflict`, `order.conflict.resolved`, `order.sweep`, `order.sweep.undone`, `order.briefing`, `order.visual` |
| Projects | `project.created`, `project.updated`, `project.linked`, `project.unlinked`, `project.budget` |
| Tickets | `ticket.opened`, `ticket.requested`, `ticket.keyed`, `ticket.edited`, `ticket.noted`, `ticket.linked`, `ticket.line.moved`, `ticket.step`, `ticket.run`, `ticket.branch`, `ticket.pushed`, `ticket.pr` |
| Agent Bay | `bay.agent.saved`, `bay.agent.retired`, `bay.assign`, `bay.test`, `bay.visual` |
| Brain | `brain.principle.saved`, `brain.principle.reset`, `brain.suggestion.dismissed` |
| Feature map | `featuremap.record.saved`, `featuremap.record.reset` |
| Improvement | `improve.session`, `improve.seat`, `improve.proposal`, `improve.proposal.accepted`, `improve.proposal.decided`, `improve.proposal.linked`, `improve.visual` |
| Imports | `repo.import.started`, `repo.imported`, `repo.import.failed`, `repo.explore.started`, `repo.explore.station`, `repo.explore.finished`, `repo.moved`, `repo.mapped`, `repo.module.understood`, `repo.suggestion` |
| Launch | `launch.started`, `launch.url`, `launch.stopped`, `launch.exited` |
| Finished apps | `integration.requested`, `integration.briefed`, `integration.decided`, `integration.installed`, `integration.failed`, `integration.removed`, `integration.used` |
| Add-ons | `plugin.installed`, `plugin.enabled`, `plugin.disabled`, `plugin.failed`, `plugin.removed`, `plugin.data`, `plugin.log`, `plugin.emitted` |
| App | `settings.changed`, `bridge.seen`, `app.updated`, `store.migrated`, `store.rebuilt` |

### Station states

`factory.station { run, station, state, round?, note?, spentUsd, maxUsd }`

| Field | Values |
|---|---|
| `station` | `intake`, `council`, `discover`, `plan`, `gateA`, `tests`, `build`, `test`, `fix`, `review`, `evaluate`, `gateB`, `ship` |
| `state` | `active`, `pass`, `fail`, `incomplete`, `waiting`, `skipped` |

`factory.gate { run, gate, state, question?, by?, note? }` with `gate` one of `gateA`, `gateB`, `escalation`. An escalation carries its `kind`: `retry`, `council`, `rounds` or `budget`.

`factory.run.finished { run, outcome, reason, resumable? }` with `outcome` one of `shipped`, `stopped`, `failed`.

## 3. Tables

Each group is one projection, rebuilt from the log on demand ([storage.md](storage.md)).

| Tables | Hold |
|---|---|
| `events`, `signal_fts` | The log and its full-text index (not projections) |
| `signals` | What was said or dropped |
| `agent_runs` | Every agent call with model, station, cost, tokens, error |
| `factory_runs`, `artifacts` | Runs; files they wrote with size and hash |
| `council_sessions`, `council_seats`, `reviews` | Council rounds and seats; review results |
| `bay_agents`, `bay_agent_versions`, `bay_slots`, `bay_tests`, `agent_verdicts` | The Agent Bay |
| `brain_principles` | The Brain |
| `feature_records` | The Feature map: records the person edited or added |
| `recall_fts` | The person's own words, searchable by agents |
| `order_nodes`, `order_fragments`, `order_conflicts` | The Order Engine |
| `projects`, `project_links` | Projects and what belongs to each |
| `tickets`, `ticket_notes`, `ticket_links`, `ticket_keys` | Tickets |
| `repo_imports`, `code_maps`, `code_modules`, `code_suggestions` | Imported repositories |
| `launch_sessions` | Apps started from the Use tab |
| `integrations` | Finished apps installed into SF |
| `plugins`, `plugin_data` | Add-ons and their stored data |
| `settings`, `drops`, `app_versions` | Settings changed in the app; drop-folder files read; update history |
| `schema_migrations`, `projections` | Schema steps; each projection's version and health |

## 4. Environment variables

The installed app sets what it needs itself. These matter in development, tests and CI.

| Variable | Default | Does |
|---|---|---|
| `SF_RUNTIME` | `mock` from source; the shell picks `claude-code` when it finds the CLI | `mock`, `claude-code` (lean), `claude-code:full` (every installed plugin) |
| `SF_PORT` | `4317` | The core's port |
| `SF_DB` | `.sf-data/factory.db` in development | The Main factory's database |
| `SF_PROJECTS` | `projects/` next to the database | Where builds are written |
| `SF_AUTO_RESUME` | on | `0` stops unfinished runs from resuming at start |
| `SF_SCREEN_CHECK` | on | `off` skips opening screens in a browser |
| `SF_LINK_CHECK` | on | `off` skips opening links |
| `SF_AGENT_TIMEOUT_MS` | `600000` | Time limit of one agent call |
| `SF_SIGNIN_RETRY_MS` | `1500` | Wait before the one retry after a sign-in failure |
| `SF_MOCK_DELAY_MS` | `700` | How long a practice-crew call pretends to take |
| `SF_ORDER_MODE` | `agent` on a real runtime, `heuristic` on the mock | Which Archivist files Signals |
| `SF_ORDER_MAX_USD` | `0.50` | The Archivist's daily cap |
| `SF_IMPORT_MAX_USD` | `0.50` | Cap for exploring one imported repository |
| `SF_SELF_REPO` | `PlonterAsi/SoftwareFactory` | The repository SF's own tickets work in |
| `SF_PLUGINS_DIR` | none | Where an agent's plugin names resolve |
| `SF_CLAUDE_BIN`, `SF_CLAUDE_JS` | found by the shell | Where the Claude Code CLI is |
| `SF_NODE`, `SF_CORE_ENTRY` | found by the shell | Which Node.js runs the core; where the compiled core is |
| `SF_PARENT_PID`, `SF_APP_VERSION` | set by the shell | The core exits when this process is gone; the version shown in the app |
| `SF_CORE_URL` | set by the launcher | Given to a built app so it can reach the core |

## 5. Limits and thresholds in code

| What | Value | Constant, file under `packages/core/src/` |
|---|---|---|
| Run cap when none is given | $1.50 | `DEFAULT_FIRST_USD`, `DEFAULT_NEXT_USD` in `projects/budget.ts` |
| Smallest build | $0.25 | `MIN_BUILD_USD` |
| Fix rounds | 5 (4 for a screen run) | `factory/loop.ts` |
| Automatic resumes | 3 | `MAX_AUTO_RESUMES` |
| Council rounds | 2 | `MAX_COUNCIL_ROUNDS` in `factory/council.ts` |
| Design: pass score, rounds, budget share | 4, 3, 35% | `PASS_SCORE`, `MAX_DISCOVERY_ROUNDS`, `DISCOVERY_BUDGET_SHARE` in `factory/discovery.ts` |
| Views kept in a plan | 6 | `MAX_VIEWS` in `factory/runkit.ts` |
| Feature loop: starts at, budget share, least per feature | $3, 55%, $0.15 | `FEATURE_LOOP_MIN_USD`, `BUILD_BUDGET_SHARE`, `FEATURE_MIN_USD` in `factory/features.ts` |
| Plan fits the money (SF-64): a feature session needs, one session per feature | $0.45, $0.27 | `FEATURE_FIT_USD`, `ONE_SESSION_FEATURE_USD`, `buildFit` in `factory/features.ts` |
| Auto-work limits: ready bug or task, asked-for work, per day, at once | $1.50, $3, $10, 2 | `AUTO_WORK_DEFAULT` in `tickets/shapes.ts`; Limits in the Tickets header |
| Engine run in a repo: least it needs (below it the work takes one Builder session) | $1.50 | `REPO_ENGINE_MIN_USD` in `factory/reporun.ts` |
| Judge: pass score, looks, per-screen look | 4, 2, $0.15 | `PRODUCT_PASS_SCORE`, `MAX_EVALUATION_ROUNDS`, `SCREEN_LOOK_USD` in `factory/evaluate.ts` |
| Repair: budget share, per feature, least to start | 25%, $0.40, $0.30 | `REPAIR_BUDGET_SHARE`, `REPAIR_FEATURE_USD`, `REPAIR_FEATURE_MIN_USD` |
| Run time | 30 min up to $2, in proportion above, 240 min at most | `factory/stoprules.ts` |
| Stronger model needs | opus $0.40, sonnet $0.15 left | `modelFloorUsd` in `factory/runkit.ts` |
| Tickets: per ticket, per day, at once | $0.60, $3, 2 | `AUTO_WORK_DEFAULT` in `tickets/` |

### The built-in crew

Defaults from `bay/builtin.ts`. Every one can be edited or replaced in the Agent Bay.

| Agent | Station | Model | Cap per call |
|---|---|---|---|
| Overseer | overseer (the Assistant) | haiku | $0.25 |
| Archivist | order | haiku | $0.03 |
| Visionary, Architect, Skeptic | council | haiku | $0.12 each |
| Designer | design | sonnet | $0.40 |
| Critic | critique | sonnet | $0.20 |
| Planner | plan | haiku | $0.20 |
| Tester | tests | haiku | $0.30 |
| Builder | build | sonnet | $0.60 |
| Fixer | fix | sonnet | $0.50 |
| Reviewer | review | haiku | $0.20 |
| Product Judge | evaluate | sonnet | $0.40 |
| Cartographer, Surveyor | map, survey (imports) | haiku | $0.08, $0.15 |
| Researcher | none (answers built apps) | haiku | $0.15 |
| Improvement lenses | improve | haiku | $0.03 each |

Inside a run the core may give a call more or less than the agent's own cap: never more than the run has left, and by the station's share of the run's budget.

## 6. Regenerating these lists

```bash
# Routes
grep -nE 'req\.method|pathname|path ===|path\.match' packages/core/src/server.ts packages/core/src/*/routes.ts packages/core/src/bases/host.ts
# Event types
grep -rhoE '(append|emit)\(\s*"[a-z_]+(\.[a-zA-Z_]+)+"' packages/core/src | grep -oE '"[^"]+"' | sort -u
# Tables
grep -rhoE 'tables: \[[^]]*\]' packages/core/src | sort -u
# Environment variables
grep -rhoE 'process\.env\.SF_[A-Z_]+' packages/core/src | sort -u; grep -rhoE '"SF_[A-Z_]+"' src-tauri/src | sort -u
```
