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

- **Every call is paid for on the record.** A call that fails (for example at its budget cap) still costs money, and that cost now counts toward the run's spend and shows on the agent's failed run.

## Why run 2366 failed again on 2026-11-13

The Fixer at the workbench found the stray test line and said so (`TEST_WRONG`). But the ladder climbed to a stronger model instead of questioning the test, and opus started with $0.18 left. It hit the cap in 6 seconds, twice, and those calls were not counted. The four changes above close each of those gaps, and the dry run means the stray line is now caught before the tests are locked.

## Where to see it

On the Bridge, in the Run deck:
- The **Loop** tab shows every attempt (failing before and after, the files changed, what the agent said) and every step up the ladder.
- The **Review** tab lists each acceptance criterion as "seen working" or "not met", with its evidence.
- The **Tests** grid has a cell for "every screen draws in a real browser".

## Safety

The shell is an allowlist. Any other command is refused, because the agent runs headless with no one to approve it. `node` runs the project's own code, which the core already does on every test round, so it adds no new kind of risk. Agents may not install packages, change git, or reach the network through the shell. The core reverts locked files after every call, whatever the agent did.
