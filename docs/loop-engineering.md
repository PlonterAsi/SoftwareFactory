# Loop engineering, harnesses and agentic engineering: what they really are, and what SF's engine is missing

Written 2026-11-13 for Assaf. Sources are at the bottom; every claim about SF below was checked in the code on `main` plus PR #71.

## The short answer

SF's engine has a good *inner* loop (test, fix, retry, escalate) and almost no *outer* loop. The teams that get a real product out of one prompt do three things SF does not do:

1. **They turn the one line into product documents first, in a loop of its own**, with a critic, before any plan exists. SF goes from one line to one JSON plan in a single call to its cheapest model.
2. **They build one feature at a time from a list on disk**, each in a fresh session that ends in a commit. SF asks one Builder call to write the whole app.
3. **They have a separate, sceptical agent use the running app like a person** and grade it against product criteria with hard thresholds. SF's Reviewer checks the build against the plan, so a wrong plan passes.

That is why Game Mastery comes out "nice but designed wrong": nothing in the engine ever designs it, and nothing ever judges the design.

## What the three terms mean

**Agentic engineering** is building software with agents that can run code. An agent is "tools in a loop to achieve a goal" (Willison). The defining ability is that the agent runs what it wrote, sees the result and corrects itself. SF got this on 2026-11-12 (the workbench); before that its agents wrote files as text and never ran anything.

**Loop engineering** is designing the cycle the agent runs in, so nobody has to prompt each step. Every loop has four parts: a **goal** with a measurable stop condition, an **action**, an **observation** by something other than the agent's own opinion, and an **adjustment** before the next round. A loop also needs a **spine**: state on disk (a feature list, a progress file, git) so each round starts from what the last one learned. A loop without a measurable goal spins; a loop without an outside observation agrees with itself.

**Harness engineering** is everything around the model that makes the loop reliable: the documents it reads, the tools it has, the checks that reject bad work ("backpressure": tests, types, lint, a real browser), the limits, and the memory between sessions. OpenAI's rule for it: "Every agent mistake is a harness bug." When an agent fails you do not fix the output, you ask what tool, document or check was missing and add it so that kind of failure cannot happen again.

**How they fit together:** the harness is the workshop, the loop is the routine run inside it, and agentic engineering is the craft of using both. A product from one prompt needs *nested* loops, each with its own goal, observer and spine:

| Loop | Goal (stop when) | Observer | Spine on disk |
|---|---|---|---|
| Discovery | the product documents cover the idea and pass a critic's rubric | a sceptical critic agent | brief, journeys, screens, requirements |
| Plan | every requirement maps to a feature with a testable "done" | coverage check against the documents | feature list, all marked failing |
| Build (per feature) | this feature's checks pass and nothing else broke | tests, types, a real browser | git commit, progress file |
| Evaluate | every product criterion scores above its threshold | a separate agent using the running app | scored report, failing items go back to Build |
| Improve the factory | the same failure never repeats | the person, and run records | a new check or rule in the engine |

## The examples worth copying

**Anthropic, long-running harness (Nov 2025).** Even their best model, looped, could not build a production-quality app from one prompt. Two failures: it tried to one-shot the whole app and ran out mid-way, and later sessions looked around and declared it finished. Fix: an *initializer* session turns the prompt into a JSON list of 200+ end-to-end features, all marked failing; every later session takes one feature, tests it in a real browser "as a human user would", commits, and writes a progress note. Agents may only flip a feature to passing, never edit the list.

**Anthropic, planner / generator / evaluator (Mar 2026).** A *planner* expands 1 to 4 sentences into a full product spec. A *generator* builds. A separate *evaluator* clicks through the live app with Playwright and grades design quality, originality, craft and function; any score under its threshold fails the round. Their finding: agents praise their own work, and making a separate judge sceptical is far easier than making a builder self-critical. Before each chunk the builder and judge agree on a contract for what "done" means. A solo run cost $9 and produced a broken game; the full harness cost $200 over 6 hours and produced a working one.

**OpenAI, harness engineering (Feb 2026).** About a million lines, no hand-written code. The repo's documents are the system of record (a short map file pointing to design docs, plans and quality grades). Architecture rules are enforced by linters whose error messages tell the agent the fix. Agents can see the running UI, logs and metrics. Background agents clean up drift. "The bottleneck was the environment, not the model."

**Ralph (Huntley).** Three phases: talk the idea through into one spec file per topic; a planning loop that compares specs to code and writes a task list; a build loop where each round is a fresh session doing one task, running the checks, committing. The plan is disposable and regenerated whenever it drifts. The person "sits on the loop, not in it."

**BMAD and Spec Kit.** A chain of roles, each producing a document the next one reads: brief, product requirements, UX spec, architecture, then self-contained stories for the builder. Known weakness: a mistake early in the chain flows down unless something checks each document.

## SF's engine held up against that

| What the research says | What SF does today | Verdict |
|---|---|---|
| Expand the prompt into product docs, in a loop with a critic | Council seats vote build or drop; the Planner writes one JSON plan in one call | **Missing.** This is the stage Assaf described. |
| The strongest thinking goes into the design | Council and Planner run on the cheapest model with $0.12 to $0.20 each | **Backwards.** Design is the cheapest step and the one everything inherits. |
| Research feeds the design | Only two Council seats can search the web; the Planner cannot | **Missing.** Game Mastery is a research product. |
| A feature list on disk, all failing at the start | Acceptance criteria in the plan; tests written once and locked | Partly there. |
| One feature per fresh session, commit each | One Builder call writes the whole app (auto-continue when it dies at its cap) | **Missing.** This is Anthropic's failure mode number one. |
| Backpressure: tests, real browser | Locked tests, dry run, screen check, link check | Good. |
| Memory between attempts | Attempt memory and escalation ladder | Good. |
| A separate sceptical evaluator uses the app and scores product quality | Reviewer verifies the plan's criteria; the screen check only proves screens draw | **Weak.** Nobody judges whether it is a good product. |
| Every failure becomes a permanent check | Done by hand by me after each run | Works, but not yet a loop inside SF. |

## The engine SF should have

```
one line
  └─ DISCOVERY LOOP (new)      research → product brief → journeys and flows → screen design → requirements
        critic scores it; the designer revises until it passes or 3 rounds
        output: docs/product/*.md in the project, shown at the plan gate
  └─ PLAN                      from the documents, not from the one line: a feature list, each with "done means"
  └─ BUILD LOOP (changed)      one feature per fresh session → checks → commit → progress note → next
  └─ EVALUATE LOOP (new)       a sceptical agent uses the running app, scores it against the documents;
                               anything under threshold goes back to the build loop as a feature
  └─ ship
```

Order of work, each a PR with engine tests:

1. **Discovery loop** (started now). Designer and Critic agents, product documents written into the project, the Planner reads them, the plan gate shows them.
2. **Feature-by-feature build loop** with a feature list and progress file as the spine.
3. **Evaluator that uses the app** and scores product quality with thresholds.

## The honest part about money

The published harnesses that deliver a real product from one prompt spend **$125 to $200 and 4 to 6 hours** per product on the strongest models. SF's benchmark run is capped at **$1.50**. Better loops will make each dollar go much further, and a kit-based app is far cheaper than a from-scratch one, but no loop design closes a gap of a hundred times. After the three changes above I expect a good Game Mastery to need a run somewhere between $5 and $30. That is a decision for Assaf; nothing above the current caps will be spent without his words.

## Sources

- Anthropic, Effective harnesses for long-running agents: https://anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Anthropic, Harness design for long-running application development: https://anthropic.com/engineering/harness-design-long-running-apps
- OpenAI harness engineering, as reported by InfoQ: https://www.infoq.com/news/2026/02/openai-harness-engineering-codex and notes at https://zby.github.io/commonplace/sources/harness-engineering-leveraging-codex-agent-first-world
- Simon Willison, What is agentic engineering: https://simonwillison.net/guides/agentic-engineering-patterns/what-is-agentic-engineering
- The Ralph Playbook: https://claytonfarr.github.io/ralph-playbook
- IBM, What is loop engineering: https://www.ibm.com/think/topics/loop-engineering
- BMAD explained (written by a competitor, read with care): https://codemyspec.com/blog/bmad-method-explained
