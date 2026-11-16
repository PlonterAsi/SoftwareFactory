# Deep review of an imported repo

When you import a repo, SoftwareFactory does not ask you what it is. You may not know either. The crew
runs it, reads it and tells you: what the app is, whether it works, whether to keep it, and what to do
next. The Review tab of the project shows all of it.

## What happens

A repo imported for the first time is mapped (the Code map), then reviewed by itself:

| Station | What it does | Cost |
| --- | --- | --- |
| Copy | Makes a copy of the repo of SoftwareFactory's own. Installing and running happen there, so the import and your folder are never touched. | free |
| Read | Reads every route the code serves, the outside services it talks to, the settings it needs and the risky lines a reviewer would circle. | free |
| Install | Installs what the app needs (Node packages from the lock file, Python packages into an environment under `.sf/`). | free |
| Tests | Runs the repo's own tests. | free |
| Run | Starts the app, opens its pages, and asks every plain GET route once. A route that answers with a server error is a broken step. | free |
| Packages | Looks the packages up for known vulnerabilities (`npm audit`, `pip-audit`). | free |
| Inspect | The Inspector reads the code and says what the app is for, who uses it, its features, its flow step by step, what it stores and what it talks to. | paid |
| Verdict | The Assessor scores it, recommends, advises on the stack, lists gaps and next steps, and writes its questions. | paid |
| Brief | The whole review is written as one Markdown file, and each next step enters the Council's queue. | free |

Whatever could not be done is said in words on the strip ("the site could not be started here: ..."),
never passed over.

After the first review, a review runs again only when you press **Review again**. Exploring the repo
again, or SoftwareFactory following its new commits, never starts one.

## The verdict

- **Three scores**, each with the reason behind the number. Code health and fit with its purpose: higher
  is better. Cost to fix: higher is more work.
- **Keep, refactor or rewrite**, with the reasons, what keeping it takes first, and what a rewrite would
  have to carry over. The final call is yours.
- **Stack advice**: keep or change, and how it fits your other work. The Assessor compares with your
  other imported repos and with "Your main stack" in the review settings.
- **App flow**: the app as a person meets it, drawn step by step. Green was seen working when it ran,
  grey is in the code only, red is broken. Below it, where the flow falls short of the purpose.
- **Next steps**: ready tickets. Nothing starts until you press Approve on one; then it is a ticket in
  the project and the crew works it on a branch like any other.

## Interview me, and Not right?

The Assessor writes the hard questions only you can answer (who uses it, is it live, what you want
next). **Interview me** asks them one at a time, with why each matters and what was assumed meanwhile.

Every point of the review has **Not right?** beside it. Say what is right in your own words.

Answers and corrections are saved at once and shown under "What you said". **Update the verdict** then
has the Assessor rewrite what the app is and the verdict with them. Nothing is installed, run or read
again, so an update costs a fraction of a review. What you said stays fact for every later review.

## The brief

The review is also one file, `docs/softwarefactory/REVIEW.md`. The crew's tickets and engine runs in
the project start from it automatically. For outside tools such as Claude Code, press **Send it to
GitHub** (a draft pull request that adds the one file) or **Add it to my folder** (a branch
`sf/review-brief` in your folder; your files and your current branch do not move). It never goes to
the main line by itself.

## Money

One review may spend up to $1.50 on the real crew (change it under Review settings, $0.20 to $10): the
Inspector up to 60% of it, the Assessor the rest. An update with what you said may spend up to 30% of
the limit. The practice crew reviews for free: everything is measured, but the understanding and the
verdict come from rules, not from reading the code, and the page says so.

Importing through the API: `POST /api/imports` takes `review: false` to skip the automatic review and
`reviewMaxUsd` to cap it.

## For developers

- Core: `packages/core/src/imports/evidence.ts` (the free facts), `reviewcrew.ts` (prompts, parsers, the
  practice stand-ins, the brief), `review.ts` (`RepoReviewer`), `reviewTables.ts` (tables `repo_reviews`,
  `repo_review_notes`). Agents: Inspector (station `inspect`) and Assessor (station `verdict`) in the Bay.
- Events: `repo.review.started`, `.station`, `.evidence`, `.understood`, `.verdict`, `.finished`,
  `.answered`, `.corrected`, `.note.removed`, `.brief.saved`. Next steps are ordinary `repo.suggestion` events.
- API: see the header of `packages/core/src/imports/routes.ts`.
- Bridge: `apps/bridge/src/RepoReview.tsx`. Tests: `packages/core/test/review.test.ts`.
