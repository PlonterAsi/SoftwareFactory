# The engine: a real agentic loop

SoftwareFactory's goal is a complete, working product from one prompt. This page says how the engine gets there, and why it was rebuilt on 2026-11-12.

## Why it was rebuilt

Run 2366 (Game Mastery, 2026-11-12) showed every weakness at once. All ten tests passed, but a stray line in the locked test file threw `game is not defined` once the tests were over, so `node --test` failed the whole file. Five things went wrong after that:

1. **Errors were lost.** SF's test reader dropped Node's diagnostics, so the Fixer was only told "test failed".
2. **The agents were blind.** The Builder and Fixer wrote whole files as text and never ran anything. The Fixer said so twice ("I can't run node --test here… please paste the output") and was paid $0.39 to change nothing.
3. **There was no memory of attempts.** Retry sent the same prompt again.
4. **There was no way to question a locked test,** even when the test itself was broken.
5. **"Done" only meant the unit tests were green.** Nothing ever ran the app's own page code, so a cut-off `web/app.js` shipped in run 2099.

## How it works now

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
5. Each session's cap is its share of 55% of the run's budget, never under $0.15 or over the Builder's own cap. A retried build picks up at the first feature not built.

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

## Engine cycles: the same prompt, side by side

A benchmark run tests the engine, not the product. When the same prompt has been built more than once, the
**Engine cycles** page (sidebar, `#/factory/cycles`, `GET /api/factory/cycles`) puts the runs in columns: the app
version that built each, the design loop's best scores, the product judge's last look, money, minutes, and the
engine review (what the engine did badly and well, and each agent's record). It is worked out from the log
(`packages/core/src/factory/cycles.ts`) with no agent call and nothing written, so runs from before reviews were
logged get theirs too. Read across the row to see whether an engine change helped.

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
