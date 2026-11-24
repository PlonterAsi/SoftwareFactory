# Flows

How a person moves through SoftwareFactory, and how the app moves work through itself. Every flow here is built and was read from the code; where a flow has a planned extension it says **Planned**. Screen names are the ones in [app.md](app.md); engine detail is in [engine.md](engine.md).

Contents: [1. First launch](#1-first-launch) · [2. One line to a shipped app](#2-one-line-to-a-shipped-app) · [3. Inside the engine](#3-inside-the-engine) · [4. Where the engine stops for you](#4-where-the-engine-stops-for-you) · [5. A note becomes order](#5-a-note-becomes-order) · [6. A ticket becomes a pull request](#6-a-ticket-becomes-a-pull-request) · [7. Using a finished app](#7-using-a-finished-app) · [8. The next version](#8-the-next-version-of-a-shipped-app) · [9. Import a repository](#9-import-a-repository) · [10. Stop, crash and resume](#10-stop-crash-and-resume) · [11. Updates](#11-updates) · [12. Engine cycle](#12-an-engine-cycle)

## 1. First launch

```mermaid
flowchart TD
  a["Install SoftwareFactory-setup.exe"] --> b["Start the app"]
  b --> c{"Shell finds Node and the core?"}
  c -->|"no"| c1["Core down screen:<br/>why, log, Restart the core"]
  c -->|"yes"| d["Core opens the Main factory base<br/>migrates the database, backs it up first"]
  d --> e{"Claude Code installed and signed in?"}
  e -->|"no"| f["Practice crew: free canned agents<br/>always build a sample word counter"]
  e -->|"yes"| g["Real crew: Claude Code, capped"]
  f --> h["Welcome in the Assistant:<br/>Capture · Ask · Build it"]
  g --> h
  h --> i["Systems drawer shows what is missing:<br/>Node.js, Claude Code, Git, each with one thing to do"]
```

Git is needed before anything can be built, because every build is a git repository. Without it *Build it* answers with the install link.

## 2. One line to a shipped app

What the person does. Two taps are required; everything else runs by itself.

```mermaid
flowchart TD
  idea["Type one line<br/>Assistant, Helm, or a project's Mission tab"] --> build["Press Build it"]
  build --> dup{"Same idea already building,<br/>resumable, or shipped in 24 h?"}
  dup -->|"yes"| dupmsg["Show run N · Build again anyway"]
  dup -->|"no"| run["A run starts.<br/>Without a project it becomes a project of its own"]
  run --> mission["Mission tab: the track moves left to right"]
  mission --> g1{{"Your OK 1: approve the plan"}}
  g1 -->|"Type what to change"| replan["Planner writes the plan again"]
  replan --> g1
  g1 -->|"Stop"| stopped["Run stopped"]
  g1 -->|"Approve"| work["Build, test, fix, review, judge"]
  work --> g2{{"Your OK 2: accept the build<br/>the question names what is still open"}}
  g2 -->|"Type what to change"| repair["Repair features in fresh sessions,<br/>then the judge looks again"]
  repair --> g2
  g2 -->|"Stop"| stopped
  g2 -->|"Approve"| ship["Shipped: commit, tag v0.1.0"]
  ship --> use["Use tab: start the app with one press"]
```

## 3. Inside the engine

What the app does between the two taps. Each box is a station; each loop has its own goal, observer and stop rule.

```mermaid
flowchart TD
  intake["Intake<br/>the idea is stored as a Signal"] --> council{"Small job?"}
  council -->|"yes"| design
  council -->|"no"| seats["Council: 3 to 6 seats vote<br/>build / reshape / drop, up to 2 rounds"]
  seats -->|"majority drop"| esc1{{"Escalation: build anyway?"}}
  seats --> design
  esc1 -->|"yes"| design

  subgraph discovery["Design loop: up to 3 rounds, 35% of the budget"]
    design["Designer: research, then brief,<br/>journeys, screens, requirements"] --> critic["Critic scores 1 to 5:<br/>coverage, journey, screens, originality, buildable"]
    critic -->|"any score under 4"| design
  end
  critic -->|"all 4 or more, or rounds or money used:<br/>best documents go on"| plan

  plan["Planner: plan from the documents.<br/>Critic lists gaps, Planner adds them once"] --> gateA{{"Gate A"}}
  gateA --> tests["Tester writes acceptance and journey tests.<br/>Dry run, then locked"]

  subgraph buildloop["Build loop: 55% of the budget"]
    tests --> feat["Builder: one feature per fresh session"]
    feat --> chk["Core: locked tests, schema, links,<br/>screen draws in a real browser,<br/>judge looks at the screen"]
    chk -->|"regressed or hollow, once"| feat
    chk -->|"next feature"| feat
  end

  chk --> suite["Core runs the whole suite + fast checks"]
  suite -->|"failing"| fix["Fixer at the workbench<br/>attempt memory"]
  fix --> suite
  suite -->|"stalled"| ladder["Ladder: question the test,<br/>stronger model, then you"]
  ladder --> suite
  suite -->|"green"| review["Reviewer verifies each acceptance<br/>criterion by running the product"]
  review -->|"high-severity finding, once"| fix
  review --> judge["Product Judge reads every screen,<br/>scores function, design, content"]
  judge -->|"requirement not seen or score under 4, once"| repairf["Repair features, groups of 5,<br/>25% of the budget"]
  repairf --> judge
  judge --> gateB{{"Gate B"}}
  gateB --> ship["Ship: commit, tag, engine review"]
```

Three things change the route:

- **Practice crew, or a run under $3** (a ticket at $0.60, for example): the Builder writes the app in one call instead of feature by feature, and the judge's findings go to one fix round instead of repair features.
- **The next version of a shipped app** skips the design loop: it keeps its product design (flow 8).
- **No browser on the computer**: the screen check and the judge are skipped and say so. They are never counted as a pass.

## 4. Where the engine stops for you

Only these. Each shows on *Needs you*, in the sidebar badge, in the Assistant and on the project's Mission tab.

| Stop | When | Your choices |
|---|---|---|
| **Gate A** | The plan is written | Approve · type what to change (it is planned again) · Stop |
| **Gate B** | Built, tested, reviewed, judged | Approve (ships) · type what to change (repaired, judged again) · Stop |
| **Council says drop** | A majority of seats voted drop | Build anyway · stop |
| **A station failed** | An agent call or a check failed | Retry (with an optional hint) · Stop |
| **Fix loop stalled** | The ladder is used up: test questioned, stronger model tried | 2 more fix rounds · stop |
| **Budget spent** | The run's cap is reached | Add more (never automatic) · stop |
| **Time limit** | The wall clock for the run is over (30 minutes for a run up to $2, more in proportion to the budget, 4 hours at most; time waiting for you does not count) | The run stops and says what was tried |

Runs started with `autoApprove` (headless runs, and tickets the crew picks up by itself) approve gates A and B on their own. A budget escalation still stops them.

## 5. A note becomes order

```mermaid
flowchart LR
  say["Capture in the Assistant,<br/>or Enter in the Helm"] --> sig["Signal<br/>stored raw"]
  sig --> arch["Archivist<br/>split · classify · route"]
  arch --> frag["Fragments under<br/>project ▸ idea ▸ thread"]
  frag --> canon["Rules and decisions<br/>enter the Canon"]
  frag --> noise["Noise is hidden"]
  frag -->|"under 50% sure"| unsorted["Unsorted tray:<br/>drag it where it belongs"]
  canon --> check{"Conflicts with the Canon?"}
  check -->|"decided by precedence"| done["Filed"]
  check -->|"still tied"| card{{"Conflict card: pick the one that wins"}}
  frag -->|"a task or a question"| ticket["Opens a ticket in that project"]
```

Said in a project's chat, a note is filed under that project unless its words point elsewhere. A daily sweep fades stale notes, raises old questions and proposes merges, all in one briefing with undo. The Archivist is a cheap agent with a daily cap; free heuristics take over on the practice crew, when the cap is spent, or when its answer is unusable.

## 6. A ticket becomes a pull request

```mermaid
flowchart TD
  open["A ticket is opened<br/>by you, by a failed run, by an error,<br/>by the Order Engine, by an accepted proposal"] --> ready{"Ready?"}
  ready -->|"you mark it, or Ask an agent says it can be built"| queue["Ready queue of its project"]
  queue --> rule{"Bug or task, size S or M,<br/>not blocked, not yours, no hold words,<br/>caps allow, Crew picks up is on"}
  rule -->|"yes"| auto["The crew starts it by itself"]
  rule -->|"no"| press["Waits for your Work it press.<br/>The page says why"]
  auto --> where{"Project has a repo?"}
  press --> where
  where -->|"no"| run["Factory run from the ticket's work document"]
  where -->|"yes"| clone["Builder works in a clone,<br/>on branch sf/KEY-title"]
  clone --> pr{"Real crew and a GitHub token?"}
  pr -->|"yes"| draft["Draft pull request. Never main"]
  pr -->|"no"| local["Branch stays on this PC,<br/>until you press Send to GitHub"]
  run --> built["Built: waits for your look"]
  draft --> built
  local --> built
  built --> close{"Bug or task, shipped,<br/>every locked test green?"}
  close -->|"yes"| closed["Closes by itself"]
  close -->|"no"| look{{"You: Close, or Reopen"}}
  draft -->|"merged later"| closed
```

SoftwareFactory's own project is linked to its own GitHub repository, so SF tickets come back as draft pull requests on SF. Caps: $0.60 a ticket, $3 a day, 2 at once per project. See [tickets.md](tickets.md).

## 7. Using a finished app

```mermaid
flowchart LR
  shipped["A shipped project"] --> use["Use tab"]
  use --> start["One Start press:<br/>the core finds how to run it"]
  start --> page["Its page opens inside SF<br/>or its output streams in"]
  use --> data["Data files edited as forms"]
  use --> tools["Tools run without knowing arguments"]
  shipped --> integ["Integrate tab: readiness checks"]
  integ --> ask["Ask for a form:<br/>tool, panel, plugin, or into the source"]
  ask --> approve{{"Your approval"}}
  approve --> inst["A frozen copy is installed.<br/>It appears under Finished apps"]
  inst --> upd["Ships again: update goes through on its own"]
```

Apps the core starts are stopped when the project is archived, when you press Stop, and when SF closes. See [run.md](run.md) and [integrations.md](integrations.md).

## 8. The next version of a shipped app

On the Mission tab of a project that already shipped, the box reads *Add to this app*. The run works on top of the shipped folder: same data, same locked tests, new tests added. It skips the design loop (the app keeps its design), plans what the ask adds, builds, and ships a new tag. A project that shipped as a script can be turned into an app the same way (*Add a screen*, [screens.md](screens.md)). Tick *as a new app* to start fresh instead.

## 9. Import a repository

```mermaid
flowchart LR
  src["Code map tab:<br/>URL, owner/repo, or a folder"] --> clone["Cloned into imports/<br/>read-only for the agents"]
  clone --> scan["Free scan: files, modules, links"]
  scan --> map["Cartographer maps each module"]
  map --> survey["Surveyor suggests improvements"]
  survey --> sug["Suggestions on the map and<br/>in the project's Improvements queue"]
  sug -->|"you accept one"| ticket["A task ticket"]
  ticket --> flow6["Flow 6: branch or draft pull request"]
```

One import has a money cap (`SF_IMPORT_MAX_USD`). The original repository is never written to.

A repository imported for the first time is then reviewed by itself ([review.md](review.md)):

```mermaid
flowchart LR
  map["Mapped"] --> copy["A copy of its own"]
  copy --> run["Free: read routes and services,<br/>install, run tests, start it, check packages"]
  run --> inspect["Inspector: what the app is"]
  inspect --> verdict["Assessor: scores, keep / refactor / rewrite,<br/>stack advice, gaps, next steps, questions"]
  verdict --> page["Review tab and the brief file"]
  page -->|"you approve a next step"| ticket["A ticket"]
  page -->|"Interview me, or Not right?"| said["What you said"]
  said -->|"Update the verdict"| verdict
```

## 10. Stop, crash and resume

A run has no state outside the event log.

```mermaid
flowchart TD
  cut["The app closes, crashes or updates mid-run"] --> start["Next start: the core marks the run<br/>stopped and resumable"]
  start --> auto{"Resumed by itself fewer than 3 times?"}
  auto -->|"yes"| restore["Read the run's events back:<br/>spend, plan, folder, locked-test hash, brief, review, verdicts"]
  auto -->|"no"| button["Mission tab: Resume from where it stopped"]
  button --> restore
  restore --> reset["Half-written files go back to the last commit"]
  reset --> cont["Continue at the first station not finished.<br/>A run at a gate waits there again.<br/>An unanswered send-back is carried out first"]
```

## 11. Updates

```mermaid
flowchart LR
  merge["A merge to main"] --> ci["Windows build + smoke test on the installed app"]
  ci -->|"passed"| rel["Rolling release: installer + signed latest.json"]
  rel --> app["Installed app checks for updates"]
  app --> idle{"A build running?"}
  idle -->|"no"| count["15 s strip: Update now · Not now"]
  idle -->|"yes"| wait["Waits for the build, or Install now:<br/>the run resumes after"]
  count --> inst["Installs, restarts, records the version"]
```

Each build is version `0.2.<CI run number>`. See [updates.md](updates.md).

## 12. An engine cycle

How the engine itself is improved. This is a working method, partly inside the app.

```mermaid
flowchart LR
  prompt["The same prompt, the same cap"] --> run["One run"]
  run --> retro["Engine review, written by the core:<br/>what it did badly, well, where money went"]
  retro --> change["An engine change for each failure,<br/>so it cannot happen again"]
  change --> prompt
```

The review and the comparison are built. Turning a "did badly" line into an engine change is done by people and threads today; doing it inside SF is **Planned**.
