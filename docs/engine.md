# The engine: a real agentic loop

SoftwareFactory's goal is a complete, working product from one prompt. This page says how the engine gets there, and why it was rebuilt on 2026-11-12.

The first section is the engine as it is today. The sections after it are the record of why each part exists, in the order it was added, each tied to the run that showed the need. The research behind the design is in [loop-engineering.md](loop-engineering.md); the same pipeline drawn as a flow chart is in [flows.md](flows.md).

## The pipeline today

```
one line
  └─ intake              the idea is stored as a Signal
  └─ COUNCIL LOOP        3 to 6 seats vote build / reshape / drop, up to 2 rounds (skipped for a small job)
  └─ DESIGN LOOP         research → Designer writes brief, journeys, screens, requirements, rules
                         → Critic scores → revise, up to 3 rounds
  └─ plan                from the documents; the Critic lists gaps, the Planner adds them once
  └─ GATE A              you approve the plan
  └─ tests               acceptance and journey tests, dry run, then locked
  └─ BUILD LOOP          one feature per fresh session → tests, schema, links, real browser,
                         judge looks at the screen → commit → next feature
  └─ TEST ⇄ FIX LOOP     fast checks and the whole suite → Fixer at the workbench → ladder when it stalls
  └─ REVIEW              the Reviewer verifies each acceptance criterion by running the product
  └─ JUDGE LOOP          the Product Judge reads every screen and scores the product;
                         what is not met is built as repair features, then judged once more
  └─ GATE B              you accept the build (the question names what is still open)
  └─ ship                commit, tag, and the engine's review of its own run
```

The code is `Run.go()` in `packages/core/src/factory/run.ts`. Station ids, in order: `intake`, `council`, `discover`, `plan`, `gateA`, `tests`, `build`, `test`, `fix`, `review`, `evaluate`, `gateB`, `ship`.

### The pipeline is a flow (2026-11-17)

The pipeline above is no longer fixed code. It is the built-in **New project** flow, stored as data in `packages/core/src/flows/flow.ts`: each step names its kind (step, loop or gate), the engine action that carries it out, the crew slots that work it, its loop rule (goal, observer, passes when, stops anyway, round limit), when it is skipped, the milestone that skips it on a resume, the stop on the project track it belongs to, and where the canvas draws it. Imported repositories follow the built-in **Feature in a repo** flow, the same steps with the repo's own intake, tests and hand-over.

- `Run.go()` reads the flow the run started with and carries out its steps in order, one engine action each (`intake`, `council`, `discover`, `plan`, `tests`, `build`, `testFix`, `review`, `evaluate`, `accept`, `ship`). Gate A and the Fixer are drawn as their own boxes but carried out inside the plan loop and the test loop (`within`).
- Every run copies its flow onto its `factory.run.started` event, so an edit never changes a run already going and a resume follows the same flow. Runs from before flows follow the built-in of their kind.
- Flows are saved as `flow.saved` events (every version kept, `flows` table). A flow is checked before it is saved or run: known actions, each once, required ones present (intake, plan, tests, build, test and fix, your OK on the build, ship) and in an order that works, agents that are crew slots, loop limits from 1 to 6. The council, design, review and judge steps can be left out.
- The engine reads the round limits of the council, design and judge loops from the flow.
- The factory floor, the project's Mission track and the Flows page (`#/factory/flows`) draw the flow. API: `GET /api/flows`, `GET /api/flows/:id`, `PUT /api/flows/:id`, `POST /api/flows/:id/reset`, `POST /api/flows/check`.
- Proof of no change: the four practice-crew runs (default, council always, no planted bug, Agent Bay crew) write the same events, in the same order, before and after; every existing test passes.

### The flow library (2026-11-17, phase 2)

One flow per kind of work, each saying who carries it out (`runner`):

| Flow | Runner | Takes | What it does |
|---|---|---|---|
| New project | engine | projects with no repo | the pipeline above |
| Feature in a repo | engine | requests, ideas, epics in a repo project | the pipeline on a branch of a clone |
| Bug fix | session | bugs | one Builder session: read the repo, build, checks with fix rounds (2), Reviewer with fix rounds (1), commit, draft PR; told to find the cause and prove it with a test |
| Small change | session | tasks, small asks | the same session, exactly what the light route always did |
| Refactor | session | picked by you | the same session, told behaviour must not change |
| Research or question | answer | questions | a reader answers on the ticket from a read-only copy; nothing changes |
| Import a repo, Improve loop, Release | door | their own screens | drawn so every kind of work is on one map; their screens follow the boxes once they read flows |

- Session flows have their own actions (`orient`, `build`, `checks`, `review`, `commit`, `handover`) and answer flows theirs (`orient`, `answer`); the check before save refuses an action the runner cannot do, a missing required one, or a change of runner. A door flow cannot be saved until its screen reads flows.
- `workInRepo` (tickets/repowork.ts) carries out a session flow step by step and reads its fix round limits and its `brief` (words added to the Builder's and the Reviewer's instructions). With the built-in Small change flow it takes exactly the steps it took before flows.
- Which flow a ticket follows: `tickets/flowpick.ts` (yours, else its kind's via each flow's `kinds`, else by route). The check before money and Home are in [tickets.md](tickets.md).

### Each loop: goal, observer, stop

A loop needs a goal that can be measured, an observer other than the agent that did the work, and state on disk so each round starts from what the last one learned.

| Loop | Worker | Observer | Passes when | Stops anyway when | State on disk |
|---|---|---|---|---|---|
| Council | Visionary, Architect, Skeptic (haiku) | Each seat reads the others in round 2; plain code merges the takes | A majority votes build or reshape | 2 rounds. A majority "drop" asks you once | The brief, in the log |
| Design | Designer (sonnet), with a research call first | Critic (sonnet), who sees only your words and the documents | All 5 scores are 4 or more: coverage, journey, screens, originality, buildable | 3 rounds, or 35% of the run's budget. The best-scored documents go on | `docs/product/BRIEF.md`, `JOURNEYS.md`, `SCREENS.md`, `REQUIREMENTS.md` |
| Plan | Planner (haiku) | Critic lists requirements the plan does not cover; the core puts back designed screens | You approve at gate A | You reject without a note | `SPEC.md`, the plan in the log, a commit |
| Tests | Tester (haiku) | A dry run against stubs before locking | The test files load and fail only on assertions | | `test/`, locked by hash |
| Build | Builder (sonnet), one fresh session per feature | The core: locked tests, schema, links, the screen in a real browser; then the judge on that one screen | Nothing regressed, the screen draws, the judge finds what the design says it shows | One retry per feature; a screen still hollow ends "broken". 55% of the budget | `features.json`, `PROGRESS.md`, a commit per feature |
| Test ⇄ fix | Fixer (sonnet) at the workbench | The core runs the suite and the fast checks (syntax, types, lint, secrets) | Every locked test is green | 5 rounds, or a stall: then the ladder (question the test, stronger model, you) | The attempt record, in the log |
| Review | Reviewer (haiku) at the workbench | It runs the product for each criterion; the core reads its verdict | Every criterion seen working | High-severity findings go to the Fixer once; the rest ride to gate B | The review, in the log |
| Judge | Product Judge (sonnet), who sees no code | The core reads every screen's text and controls, and decides against the thresholds | Every must-have requirement seen working and function, design, content at 4 or more | 2 looks. Repairs get 25% of the budget, in groups of 5 requirements | The evaluation, in the log |
| The factory itself | The core, no agent | You, on the Engine tab | | | `factory.retro` |

### What changes the route

| Case | Difference |
|---|---|
| Practice crew | Canned agents; the whole route runs free and always builds a word counter |
| A run under $3 (a ticket at $0.60) | The Builder writes the app in one call; the judge's findings go to one fix round instead of repair features |
| The next version of a shipped app | No design loop: it keeps its product design, and works on top of the shipped folder and its locked tests |
| No browser on the computer | The screen check and the judge are skipped and say so; they never count as a pass |
| `autoApprove` (headless runs, tickets the crew starts itself) | Gates A and B approve themselves. A budget escalation still stops the run |
| The app closes mid-run | The run resumes from the log at the first station not finished ([storage.md](storage.md)) |

### Money inside a run

Every call has a cap: the lowest of the agent's own cap, what the run has left, and the station's share. The shares: design 35%, build 55%, repair 25% (they overlap on purpose: each is a ceiling, not a reservation). A failed call still counts. When the run's cap is reached, the run asks you for more and never raises it by itself; with a project total set, it cannot go beyond what the project has left. A repair or a second look is skipped when the money for it is not there, so the run always reaches gate B with what it built. All the numbers are in [reference.md](reference.md).

### What is not built yet

- The judge reads screens; it does not click through a journey.
- Turning a line of the engine review into an engine change is done by people, not by a loop inside SF.
- Known open items after cycle 5: designs that assume data the research cannot return, Builders inventing links, the last part of screen detail, and an update installing while a run waits at a gate.

## Why it was rebuilt

Run 2366 (Game Mastery, 2026-11-12) showed every weakness at once. All ten tests passed, but a stray line in the locked test file threw `game is not defined` once the tests were over, so `node --test` failed the whole file. Five things went wrong after that:

1. **Errors were lost.** SF's test reader dropped Node's diagnostics, so the Fixer was only told "test failed".
2. **The agents were blind.** The Builder and Fixer wrote whole files as text and never ran anything. The Fixer said so twice ("I can't run node --test here… please paste the output") and was paid $0.39 to change nothing.
3. **There was no memory of attempts.** Retry sent the same prompt again.
4. **There was no way to question a locked test,** even when the test itself was broken.
5. **"Done" only meant the unit tests were green.** Nothing ever ran the app's own page code, so a cut-off `web/app.js` shipped in run 2099.

## How it works now (2026-11-12)

```
plan → locked tests → build ⟲ → core checks → fix ⟲ (ladder) → verify ⟲ → you accept → ship
```

- **The workbench** (`factory/workbench.ts`). A real crew's Builder and Fixer work in the project folder with file tools and a shell limited to the commands they need (`node`, `npm test`, `npx tsc`, read-only `git`, and a few file viewers). They make the change, run the tests, read the failure, fix it, and run again, all inside one call. Afterwards the core puts back anything the agent may not change (the locked tests, the kit), then runs every check itself. The agent's own runs are how it finds the problem, and the core's runs are the verdict. The ticket loop's Builder gets the same workbench.
- **The tests are tried before they are locked.** Once a test is locked, no Fixer may change it, so a test that can never pass wastes the whole run. Before locking, the core copies the project to a temp folder, puts a stub in place of every module the tests import, and runs them. Assertions fail, as they must with no code, but a test file that breaks on its own lines (a ReferenceError or SyntaxError outside any test, like run 2366's stray line) goes back to the Tester with the error. It costs nothing.
- **Nothing is lost.** The test reader keeps Node's diagnostics and stderr. A file that failed as a whole carries the real error.
- **Attempt memory (H5).** Each fix round is recorded: who did it, which model, which files changed, failing before and after, and what the agent said. The next round reads that record and is told not to repeat an approach that failed. A round that changed nothing is an attempt with a reason, not a crash.
- **The escalation ladder (H6).** When the stop rules see a stall (the same tests failing, the count not falling, or files going in circles), the run climbs before it asks anyone:
  0. **Triage first.** When the evidence points at a locked test (a Fixer's `TEST_WRONG` line, or a test file that fails as a whole while tests in it passed), the test is questioned at once, before any stronger model. If the Tester keeps the test, its reason goes to the next Fixer.
  1. **Deeper fix.** One step up in model (haiku to sonnet to opus), with orders to write down hypotheses and test each by running code. The stronger model is used only when the run has enough budget left for it (opus needs $0.40, sonnet $0.15); otherwise the same model tries the deeper round.
  2. **Question the locked test.** This happens when a Fixer ends with `TEST_WRONG: <file>: <evidence>`, or when a test file fails as a whole even though tests in it passed. The Tester then judges the evidence. A corrected file is locked again on the record (`factory.tests.locked` with `relocked` and the reason). This can happen at most once per run.
  3. **You.** The question says what was tried. The wall-clock limit is never waived.
- **Every screen in a real browser (H8)** (`factory/screencheck.ts`). While the app is up, the core opens its home screen in the browser already on the computer (Edge on Windows), follows every link in the navigation plus each entity's "new" form, and fails any screen that shows the kit's error box, draws nothing or logs an uncaught error. It costs nothing. With no browser installed, the check is skipped and never counted as a pass. Set `SF_SCREEN_CHECK=off` to turn it off. The browser starts without `__COMPAT_LAYER`: Windows' app-health shim puts that variable on the SF app, and with it Edge exits at once with no output, which is why the check was always skipped inside the app until 2026-11-13.
- **The done-claim check (H8).** At the workbench, the Reviewer also verifies each acceptance criterion by running the product: it calls functions with node, starts the server and fetches from it. It answers each criterion with pass or fail and evidence. A criterion the product does not meet goes back to the Fixer with that evidence, and the build gate names any criterion that still isn't met.

- **A call that runs out of budget mid-work goes on by itself.** When a Builder or Fixer at the workbench hits its own cap with files already written, a fresh call reads what is there and finishes it (at most twice, while the run has budget left), instead of stopping for a person to press Retry (run 2623).
- **A lost verdict is asked for again.** If the Reviewer's last message has no JSON verdict (run 2623: a background server it started timed out and its last word was a note about that), the core asks once more in the same session, with no tools, for the verdict it reached. The Reviewer is also told to stop any process it starts and to end with the JSON.
- **The plan keeps what you asked for.** After the Planner writes the plan, a second agent lists every requirement in your prompt that the plan does not cover, and the Planner adds them once before the plan gate (run 2623's plan dropped the skill tree, practice plan, session log and genre shapes). The gaps are logged as `factory.plan.gaps`.
- **Every link in the app opens.** While the app is checked, every link in its own files is opened for real: YouTube through oEmbed, others with a plain request. A link that does not exist fails a cell in the test grid and goes to the Fixer (run 2623 shipped 14 made-up YouTube links). A site that refuses scripts is not counted against the app. Set `SF_LINK_CHECK=off` to turn it off.
- **Each build is designed fresh, experience first.** The Planner and Council recall only the person's own words (notes, tickets), never past plans or Council decisions: those anchored every rebuild of Game Mastery to its first, weakest version. The Planner designs from the person's moments (first time, every day, every week) into views of their own, and the app kit's navigation leads with those views; the entity lists sit under "Manage".
- **Every call is paid for on the record.** A call that fails (for example at its budget cap) still costs money, and that cost now counts toward the run's spend and shows on the agent's failed run.

## Why run 2366 failed again on 2026-11-13

The Fixer at the workbench found the stray test line and said so (`TEST_WRONG`). But the ladder climbed to a stronger model instead of questioning the test, and opus started with $0.18 left. It hit the cap in 6 seconds, twice, and those calls were not counted. The four changes above close each of those gaps, and the dry run means the stray line is now caught before the tests are locked.

## Discovery: the idea is designed before it is planned (2026-11-13)

The engine had a good inner loop (test, fix, retry) and no outer loop: one line went straight to a code plan in a single call on the cheapest model, so nothing designed the product and nothing judged the design. The research behind this is in [loop-engineering.md](loop-engineering.md).

Discovery is a station between the Council and the Plan, and it is a loop of its own (`packages/core/src/factory/discovery.ts`):

1. The **Designer** (station `design`) researches how people really do the thing, then writes the product documents: a brief (who, problem, promise, what it is not), the journeys step by step, 2 to 6 screens in navigation order, and the requirements (the person's own asks first, never merged or weakened).
2. The **Critic** (station `critique`), a separate agent that sees only the person's words and the documents, scores them 1 to 5 on five lines: coverage, journey, screens, originality, buildable.
3. The core decides, not the Critic: every score must reach 4. Under the bar, the Designer gets its own documents back with the Critic's problems and revises.
4. It stops when the documents pass, after 3 rounds, or when discovery has used 35% of the run's budget. The best-scored documents go on, and the log says why it settled (`factory.discovery` with `settled`).

Then the Planner plans from the documents (one view per screen, one flow per journey, criteria for every must-have requirement), the Critic checks the plan against them (`factory.plan.gaps`), and the documents are written into the project as `docs/product/BRIEF.md`, `JOURNEYS.md`, `SCREENS.md` and `REQUIREMENTS.md`. The next version of a shipped app skips discovery: it keeps its design.

In the app: a "Product design" box on the factory floor, a Design station on the Bridge, and a Product tab on every run with each round's scores and documents.

### What the first real run changed (run 2898, 2026-11-13)

- **Research is a call of its own.** Offered six searches, the Designer answered in one turn with none. With a real crew the Designer now makes a research-only call first (`factory.research`); the core counts findings that carry a web address and asks once more when there are none. The design call gets the findings and may not search.
- **The core never cuts what the Critic judges.** Requirements were cut at 300 characters and the Critic failed the design for text "cut off mid-sentence". The limits are generous, named (`DOC_LIMITS`) and written into the design contract.
- **Documents have `rules`**: how the product ranks, picks, counts and removes, each exact enough to test.
- **Every designed screen is a view of the plan.** The plan kept only 4 views; it now keeps 6, and the core adds any designed screen the Planner left out (`withDesignedScreens`).
- **A sign-in failure at start is retried once** (`agent.run.retried`): six CLIs starting together tripped three Council seats.
- **A screen feature is built when its screen draws.** Six build sessions reported 82 of 82 tests and the home screen threw in the browser. After each screen feature the core opens the app in a real browser; a screen that does not draw goes back to the session that wrote it, once (feature state `broken`).
- **The link check reads the code, not the data store.** `data/` is seeded on first start and never committed; stale copies of removed links there cost two fix rounds and a climb to a stronger model. Each dead link now reaches the Fixer with the file it is in, and the Fixer is told to search for the real page before it may remove one.
- **The judge's findings are built as features.** One fix round was handed 25 unmet requirements at once. With a real crew and a product budget, unmet requirements go back to the build loop in groups of five, each in a fresh session (`repairFeatures`, features `J1`, `J2`..., event `factory.repair`), inside a quarter of the run's budget; then the checks run and the judge looks again.
- **The time limit grows with the budget.** The 30-minute setting is for a run of up to $2; a $10 run gets 150 minutes (`runMinutes`), and time spent waiting for the person at a gate no longer counts. Run 2898 was stopped by the clock with $5.33 unspent.

## The build loop: one feature per fresh session (2026-11-13)

One Builder call used to write the whole app. That is the first failure of every long-running harness: the call runs out half way and the conversation it carries grows with every file (run 2623: 407k tokens of context to write 3 files).

Now, for a real crew on a product-sized run (`maxUsd` of $3 or more), the build is a loop (`packages/core/src/factory/features.ts`):

1. The core turns the approved plan into a feature list, with no agent call: the model and shell, the domain logic the locked tests pin down, then one feature per screen (with that screen's purpose, contents and actions from the product documents).
2. Each feature gets its own fresh Builder session. It is told its one feature and where the spine is (`SPEC.md`, `docs/product/`, `features.json`, `PROGRESS.md`); it reads only what it needs.
3. After each session the core runs the locked tests for free. A test that passed before and fails now sends the feature back once, with that evidence. A screen feature is also opened in a real browser, its schema and links are checked, and then the product judge looks at that one screen (at most $0.15) against what the design says it shows and lets the person do. What the judge did not find goes back to the same session once, as the list of missing items (`factory.screen.look`), and after that retry the judge looks again: a screen still missing items ends "broken", never "built" on the Builder's word. A view is matched to its designed screen by id, then by name. Run 3185 showed why: every check passed per feature, and the judge only saw a hollow product at the very end, when most of the money was gone.
4. The core commits (`Feature F3: Screen: Today`), appends the session's closing note to `PROGRESS.md` for the next session, and updates `features.json`. Only the core writes those two files.
5. Each session's cap is its share of the build pool (55% of the run's budget, and never more than 80% of what is left), never under what a feature needs ($0.45, SF-64) or over the Builder's own cap. When the pool runs short, the features in front are built whole and the rest stay to do, instead of all of them stopping half way. A retried build picks up at the first feature not built.

Whatever still fails at the end goes to the test and fix loop as before. Small runs (a ticket at $0.60) and the practice crew still build in one call. In the app: a Build tab on every run with a row per feature and the locked tests passing after it (`factory.feature`).

## The engine review: every run ends by judging the factory (2026-11-13)

A benchmark run is a test of the engine, not of the product it builds (Assaf, 2026-11-13). When a run ends, however it ends, the core writes a review of its own work from the run's events, with no agent call (`packages/core/src/factory/retro.ts`, event `factory.retro`, the run's **Engine** tab):

- what the engine did badly, each line with its evidence: a design that never passed, research with no sources, screens the Planner dropped, a feature reported done while its screen did not draw, made-up links, fix rounds that changed nothing, a climb up the ladder, what the judge did not see, money left unspent when the run stopped;
- what it did well: loops that converged, checks that caught something;
- where the money and time went, by station and by agent, with each agent's verdicts.

The "did badly" list is the work list for the next engine change. A cycle is: the same prompt, the same cap, one run, this review, engine changes, the next run.

## The product judge: the running app is judged as a product (2026-11-13)

Passing tests prove the code matches the plan, not that the product does its job. Run 2623 passed 58 of 58 checks, drew all 13 screens, and scored 3 of 10 on what was asked for.

After the review, a new station judges the product (`packages/core/src/factory/evaluate.ts`):

1. The core starts the app and reads every screen in a real browser: the text of its main area and the labels of its controls (`readScreens` in `screencheck.ts`). This costs nothing.
2. The **Product Judge** (station `evaluate`), a separate agent that sees no code, gets the person's words, the product design and those screens. For each must-have requirement it says whether it saw it working, with what it saw; then it scores function, design and content from 1 to 5.
3. The core decides: every must-have requirement seen working and every score at 4 or more. A requirement the judge did not answer for counts as not met.
4. What fails goes to the fix loop as concrete work ("Requirement R2 is not met: ... What the judge saw: ..."), and the app is judged once more. What is still open after that is named in the build gate's question.

It never guesses: with no browser on the computer the station is skipped and says so. Its limit today: it reads what screens show and which controls they have, but it does not click through a journey. In the app: a Judge station on the Bridge and a Judge tab on every run (`factory.evaluation`).

## Where to see it

On the Bridge, in the Run deck:
- The **Loop** tab shows every attempt (failing before and after, the files changed, what the agent said) and every step up the ladder.
- The **Review** tab lists each acceptance criterion as "seen working" or "not met", with its evidence.
- The **Tests** grid has a cell for "every screen draws in a real browser".

## Safety

The shell is an allowlist. Any other command is refused, because the agent runs headless with no one to approve it. `node` runs the project's own code, which the core already does on every test round, so it adds no new kind of risk. Agents may not install packages, change git, or reach the network through the shell. The core reverts locked files after every call, whatever the agent did.

## Engine cycles (removed 24 Nov 2026)

The Engine cycles page, which laid runs of the same prompt side by side, was removed in the 24 Nov audit: no benchmark series had run since 17 Nov. Each run's engine review (`factory.retro`) is still on its Engine tab.

## What cycle 3 changed (run 3185)

- **Names the app kit accepts.** The Planner named fields in snake_case, the kit refuses those, the app could not
  start, and all eight features still reported "built". The core now puts the plan's entity and field names into
  lowerCamelCase (`kitName`), and the Planner and the Builder are told the rule.
- **Each feature is checked for what broke run 3185, by the session that wrote it.** After any feature: the schema
  must be one the kit accepts, and every link the feature wrote is opened (the retry lists the addresses the
  research found). After a screen feature: an app that does not start now fails the screen check instead of
  counting as "nothing to check". One retry, then the check after the build takes over, as before.

## What cycle 4 changed (run 3609)

- **The judge looks again after the retry.** In run 3609 all five screens the judge looked at were hollow on the first look (Game Home showed 0 of 11 designed items). Each went back once and was then taken as built on the Builder's word. Now a second look decides, and a screen still missing items ends "broken". A view whose id the Planner renamed is matched to its designed screen by name.
- **Journey tests through the app's own data layer.** Run 3609 had 8 locked test files and 186 passing tests, and the Reviewer still found 9 of 12 acceptance criteria unmet when it used the app ("Add game" failed for three games because their starter items broke the schema). The app kit now goes into the folder before the tests, and for an app the Tester also writes `test/journeys.test.js`: each action criterion as a journey from `seedDb(schema)` through the kit's `createRecord` and `updateRecord` (the same functions the server runs), plus a test that every sample record passes the kit's validation.
- **The money endgame.** Run 3609 spent its last $0.42 on three calls of one repair feature at $0.15 and $0.11, each dying at its cap, and ended "failed" with $10.00 spent and nothing at the build gate. Now a repair feature starts only when at least $0.30 is left for it (`REPAIR_FEATURE_MIN_USD`), a repair that fails puts the folder back to the last built feature and never fails the run (`factory.repair.stopped`), and the judge's second look is skipped when the money for it is not there. The person always gets the build gate with what is built.
- **Values need a real origin.** The Critic held "buildable" at 3 in cycles 2, 3 and 4, last for a design that assumed the in-app research returns vote counts, video timestamps and dates. The design contract now says what an AI agent's web search can return, and that every value a screen shows needs an origin that can supply it (the person, the research, an agent's answer, or a stated rule). The Critic's "buildable" checks exactly that.

## What cycle 5 changed (run 4004)

- **The link check reads the app, not the notes.** Two of run 4004's "dead" links were the Researcher's own sources in `docs/product/BRIEF.md` (pages that refuse a script). `docs/`, `PROGRESS.md` and `features.json` are now skipped like `data/`.
- **A made-up link does not survive a second try.** The Builder was told twice and still left invented video links in the seed. After a feature's second try the core empties every link that still does not open (`factory.links.blanked`): an empty link is right, a made-up one is a defect.
- **The person's data lives in the app's store.** Run 4004 kept the weekly plan, added topics and the research cap in the browser's localStorage, so they never reached the app's data file and every check of the store missed them. A feature whose files use localStorage or sessionStorage now goes back to its session with that finding (`stored`).
- **Journeys assert the spec's numbers.** 64 green tests and the Reviewer still found 8 of 13 criteria wrong when it ran the spec's own examples. The Tester is now told to assert exactly the numbers, examples and limits the criteria give.
- **A send-back at the build gate is carried out, and carries what was found.** In run 4004 the person sent the build back with "Need to address the issues found on this loop"; the app updated 30 seconds later, and the resume asked the build gate again without the note, so nothing was fixed. A restart now carries out an unanswered send-back first (`factory.sentback.resumed`), and the judge's last verdict is restored so the gate still says what is open. A send-back itself no longer hands only the note to one fix round: with a real crew it becomes repair features in fresh sessions (the person's note first, then what the Reviewer and the judge still found), followed by one more look by the judge before the gate asks again.

## After the benchmark: what was still unfinished (2026-11-14)

The one-prompt benchmark ended with run 4004 (35 of 40 requirements seen working). These are the engine's own weak spots that run left, fixed for any project, not for one app.

- **A screen item still missing after the second try is not forgotten.** 5 of 6 screens in run 4004 still lacked designed items after the Builder's second try, and the build moved on with nothing holding the list. Each open item now joins the judge's requirements for the whole app (`withScreenItems`, ids `SC1`, `SC2`, ...): it is looked for again when everything is built, goes into the repair features if it is still missing, and shows at the build gate until a judge has seen it. The Judge tab now prints what every requirement asks for, not only its id.
- **What the Reviewer saw fail is repaired and run again.** A review still at "fix" used to reach the repair work only when the judge also failed the screens, and the build gate kept the old count however the repair went. The repair now runs even when the judge passes, and afterwards the Reviewer runs only the criteria that failed (`recheckReview`, logged as a `factory.review` with `recheck: true`), so the gate says what is true now. A restart keeps the review's criteria.
- **Real links are found by an agent that can search, and opened by the core.** The Builder has no web search at its workbench, yet its retry told it to "search for the real page"; it invented again. Dead links in a feature's files now go once to an agent with web search, with the lines each link sits on (`findLinksPrompt`). The core opens every address it answers and puts the ones that exist in place (`factory.links.found`); what no search finds is emptied at once, with no second Builder call spent on it. Only when nobody can search does the Builder get its one retry.
- **The Critic checks what it asked for.** "buildable" stayed at 3 for four runs "for new reasons" each round: the Designer fixed what was listed and the Critic, starting blank, found something else. On a later round the Critic now sees its own last scores and problems, checks those first, and may add a new problem only when the revision brought it in or it would stop a real user. On the last round the Designer is told to settle what it cannot fix by making the design smaller (cut the value, let the person enter it, or write a fixed set into a rule), never by leaving it open, and never by dropping what the person asked for by name.
- **A designed screen comes before a view the Planner made up.** `withDesignedScreens` added a dropped screen only while the plan had room. Run 4004's plan was full (6 views), one of them the Planner's own, so the designed Skill tree stayed out. The last view that builds no designed screen now makes way.
- **A larger budget buys larger build sessions.** Run 4004 had $20 and spent $10.65: every build call was held to the Builder's fixed $0.60, two died at it and were picked up by fresh calls that read everything again. The feature cap now grows with the run, up to twice the Builder's own (`featureCapUsd`: $0.60 up to $10, $0.90 at $15, $1.20 from $20).

## The next version runs on the same engine (2026-11-14)

A shipped product is changed far more often than it is started. That path was the old engine: the ask went straight to the Planner with no design, one Builder call got the whole shipped code pasted into its prompt, and the product judge was skipped ("No product design to judge this build against"). Everything the benchmark runs taught the engine applied to first versions only.

- **The design travels with the app.** A next version starts from the product documents the app shipped with (`shippedDesign` walks back through the versions to the nearest one that has any, and to the first idea).
- **The ask is designed in.** With a real crew and a product-sized budget (from $3) the Designer gets the shipped documents and the ask and returns them changed only where the ask needs it; the Critic judges that, knowing both the first idea and the ask; at most two rounds, no research. Nothing that shipped can fall out: `mergeNextDocs` keeps every shipped requirement with its words and puts back a screen or rule the answer left out. A smaller run keeps the documents as they are and adds the ask as one more requirement of the person's (`withAsk`, ids `N1`, `N2`, ...). Either way the documents are logged (`factory.discovery`) and written to `docs/product/`, so the version after this one starts from them.
- **The Planner is told what is new.** It sees the documents with "New in this version" listed, keeps the shipped views, and writes acceptance criteria only for what is new.
- **Built by feature.** From $3 the version is a list of features like a first build (`nextFeaturesOf`): what it adds to the model and the logic, then one feature per view that is new or that the version changes, each in a fresh session with the screen check, the link check and the judge's look. Ids carry the version's tag (`v0.3.0-1`), so they never meet the shipped list's. The tests that passed when the app shipped are the baseline: a shipped test the first feature breaks sends it back.
- **Judged on what it adds.** The product judge now runs on next versions, against the requirements this version added (the rest was judged when it shipped, and its tests are locked). What it does not see goes to the repair features or the fix loop as on a first build.
- **No pasted code at the workbench.** A Builder with a workbench reads the shipped code from its folder; the whole app is no longer pasted into its prompt and paid for on every step.

## Imported repos run on the same engine (2026-11-14)

Until now which engine you got depended on where the code came from, not on what you asked for. An app the factory built went through everything above. A repo you imported got one Builder call per ticket (`tickets/repowork.ts`): right for a fix, and all there was for a feature. A feature for LandingPage was built without a design, a plan, features or a judge.

**Two routes, chosen by the work.** Work comes in through many doors (a ticket, the idea box of a project, the Assistant's Build it, the top bar) and not all of it needs the whole pipeline. An intake step, `routeWork` in `factory/route.ts`, sends work in a repo down the route that fits it:

| Route | For | What runs | Cost |
|---|---|---|---|
| light | a bug, a task, a question, anything sized S, a short single ask | one Builder session in a clone, the checks, a Reviewer on the diff | up to $0.60 |
| engine | a request sized M, anything sized L, an unsized ask longer than a small job | the whole engine in a clone | the project's limit for a next version ($1.50 unless you set one) |

It is a word and size check: free, instant, and said out loud. The ticket page shows the suggested route with its reason, and both buttons, so you can always send the work the other way. A spending limit under $1.50 always gives the light route, so what the crew picks up on its own ($0.60) never starts an engine run. Asked for by name with too little money, the engine refuses in words instead of quietly doing less.

**The engine route is the same engine** (`factory/reporun.ts`, `RepoRun extends Run`), with what an existing codebase changes:

- **A clone, a branch, never the main line.** The run works in `repo-work/run-<id>`, a clone of the repo on branch `sf/<KEY>-<title>` (or `sf/run-<id>-<ask>`). Your working copy and the repo's main line are never written to. SoftwareFactory's own notes (the plan, the design of the change, the feature list, the Python environment) live under `.sf/` in the clone, which the clone's `.git/info/exclude` leaves out: none of it reaches the branch.
- **Its own tools.** `factory/repoenv.ts` reads the folder: Node packages are installed from the lock file; a Python repo gets an environment under `.sf/venv` with its `requirements*.txt`; its tests are found (npm test, pytest, unittest); its site is started the way the Use tab would. What cannot be set up is said on the run, never passed over. The agents' shell gets the repo's own Python first on the PATH and may run `pytest`, `python` and `flask` beside the usual commands.
- **The change is designed, not a product.** The Designer gets the ask and the code map (and can read the code) and writes the documents of the change: who it is for, the journeys through the real pages, the places it adds or changes, requirements, rules. The Critic judges them as a change to this product. No web research.
- **A plan of features, in the repo's own stack.** The Planner names real files, splits the change into 1 to 6 features and says how it is tested here. Nothing the person asked for may fall out (the same gaps check). You approve it at the plan gate.
- **The repo's tests are the baseline.** There are no locked tests to write. The repo's own tests run once before anything changes (`factory.tests.locked` with `kept: "repo"`, `baseline`, `failingBefore`): what passed must pass after every feature, and what already failed is never held against the run. Types and lint get the same first look; if they already failed, they cannot judge the change and are left out, said on the run.
- **Built by feature, on the branch.** From $3 each feature is a fresh session, then the repo's tests; a feature that breaks a test that passed goes back once with that evidence; each is committed on the branch. A smaller run builds the change in one session. Every round also checks that no secret is in a changed file and that no test was deleted, moved or skipped.
- **Reviewed by running it, judged on the running site.** The Reviewer reads the diff against where the branch started and runs each acceptance criterion. The product judge reads the pages of the running site (home and what it links to) and marks each requirement of the change seen or not. A site that cannot be started here skips the judge and says why; the Reviewer's check then stands.
- **Handed over, not shipped.** After your OK at the build gate the branch is pushed and a draft pull request opened, when the repo is on GitHub, a write token is set and the real crew ran. Otherwise the branch waits in the clone, and one press takes it: **Send to GitHub** or **Add to my folder**, on the ticket and on the run (`Tickets.send`, see [tickets.md](tickets.md)). A repo imported from GitHub counts as a GitHub repo here even though it is worked from its copy on this computer. `factory.branch` records which, and the ticket gets its branch and its pull request and waits for your look. It never closes by the QA rule: the change is not in your repo until its branch is merged.

Every ask in a repo project becomes a ticket first (`Tickets.askInRepo`), whichever door it came through, so all work in a repo has a thread, a branch and a pull request to follow. `POST /api/projects/:id/runs` and `POST /api/factory/runs` with a `projectId` answer `{ inRepo, ticket, run, branch, route }` there; `newApp: true` still builds a new app from scratch.

Runs of this kind carry `kind: "repo"` and `repo: { source, name, branch, projectId, ticket? }` on `factory.run.started`. Other kinds of run can be added the same way: `Factory.kinds` maps a kind to the class that runs it, and a resume builds the right one again.

In the app: the ticket page (the suggested route, Work it on the engine, One session instead), the repo's home tab (Features on the engine, with the approval in place), and the run itself on Mission and the run deck, which say which repo and branch it works in and where the branch went.

## A plan is checked against the money (SF-64)

Run 5669 (2026-11-18) split $3 over six features: 55% of the limit divided by six gave each Builder call $0.27 or less, down to the $0.15 floor, and every one of them stopped half way. $2.05 spent, nothing built, and the plan gate never said the plan could not fit.

Now, before the plan gate, the core counts what the build loop can afford (`buildFit` in `factory/features.ts`, free, no agent call): the build pool after what design and the plan already spent, divided by what a feature session needs ($0.45 each in the feature loop, $0.27 when one session builds everything). The numbers go on the record as `factory.plan.fit`.

- **In a repo** (the engine route), a plan that does not fit is **sliced**: the features in front are kept for this run, the rest are written to `.sf/SPEC.md` as "left to the next slice" and become a ticket of their own (`factory.plan.sliced`), under the same epic, blocked by this ticket until it is done, and asked for when this one was, so the crew starts it by itself once slice 1 is merged. The plan gate says it in words ("this run builds F1, F2, F3 and F4, F5, F6 wait for the next slice; all in one run would need about $5.75"), and the Reviewer passes criteria only the later slice can meet with the evidence "next slice". A doomed run is never started.
- **A new app** shows the same numbers at its plan gate, and its build loop builds the features in front whole.

## Retry picks up where the run stopped (SF-65)

Retry used to repeat the failed step with what was left of the old limit, so a build starved of money died the same way again.

- **Inside a run**, a step that ran out of money inside one call is retried with a bigger cap for that call (double its last cap, at least a whole feature session), never the same one, and the question says what it adds to the run to afford it ("Retry it with $0.90 for that call, adding $0.40 to the run?"). An unattended run never repeats a failure nothing changed, and never adds money by itself.
- **After a run stopped or failed**, `Factory.retry` picks it up at the step it stopped at (`factory.run.retried`): same folder, same branch, what was built stays built, with fresh money sized to what is left (`retryAddUsd`), bounded by the project's budget. The run page and the ticket page both have the button.

## Stop ends a run, whatever it is doing (SF-115)

On 2026-11-22 a second build of the same ticket (run 8917) sat at its plan gate, and the only way to end it was to reject the plan by hand. **Stop run** (on the run's floor and its mission card; two presses) and `POST /api/factory/runs/:id/stop` (`{ by?, reason? }`) end a run in any state:

- **Parked at a gate:** the wait ends at once with a stop; no gate name is needed.
- **At work:** the agent call in flight is cut (the run's `AbortSignal` kills the CLI), and the run checks before each step, agent call and gate, so nothing new starts.
- **Stopped and resumable** (the app closed under it, also one that waited at a gate): it is closed for good, so the next start does not resume it.

Each stop writes `factory.run.stop` (who, why, the gate it waited at, whether it was at work), and the run ends `stopped` and not resumable; Retry can still pick it up on purpose. A run that already ended answers 409. Closing a ticket (closed, rejected, or closed as a duplicate) stops every run started on it the same way, and the ticket's thread says which (`tickets/stopruns.ts`).

## A sliced run still hands over a branch that works (2026-11-18)

Run 5669 also showed two ways a run with several features ended with nothing usable: F1 broke 9 to 15 of the repo's passing tests, was committed anyway, and every later feature built on a broken branch; and a run that ran dry mid-build stopped at the budget question, so the features it had built were never handed over.

- A feature that breaks tests that passed before, on both of its attempts, is **taken back off the branch** (the clone goes back to the last good commit) and left for the next slice. Later features build on code that works.
- Before each feature the build checks the money: when what is left, minus room for the review and the judge, cannot pay for another feature session, it **stops building** (`factory.build.stopped`) and goes on to review and hand over what it built.
- What was not built is recorded (`factory.features.left`, with why), becomes a follow-up ticket like a slice (blocked by this one, asked for like it), is listed in the pull request under "Left for the next slice", and the Reviewer and Fixer are told not to build it now.
