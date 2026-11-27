# The fence

Build step 1, slice 1. The plan in pictures: https://claude.ai/artifact/WaFJeQbnVFFmEZhjfucVV4

A run never works on Windows. It works in **the room**, and the room proves itself before every run.

## Two walls

| Wall | What it is | What it stops |
|---|---|---|
| 1. The room | A WSL2 distribution of its own (`sf-room`). `/etc/wsl.conf`: no Windows drives, no Windows programs, no Windows PATH. A `worker` account with no sudo and no password; root is locked. | Reaching your folders, sign-ins, live data and Windows programs. |
| 2. Sandbox and rules | Claude Code's sandbox for commands, and `/etc/claude-code/managed-settings.json` for the file tools, hooks, MCP servers and web tools. Root owns the file; the worker cannot change it. | Writing outside the project copy, reading outside it, reaching an address that is not on the net list. |

SoftwareFactory stays on the Windows side. It is the only one that goes in as root (`wsl.exe -d sf-room -u root`), and it does so only to write the rules and to prepare and judge the test.

## The test: nine lines

`npm run fence -- test` runs from the Windows side and prints nine lines. Seven tries must be refused; two things must work. Any other answer and no run starts.

1. attach your C: drive
2. become the room's admin
3. start a Windows program
4. reach a program on the Windows side
5. reach an address that is not on the list
6. write outside the project copy
7. read a file outside the copy with Claude's own file tool
8. reach an address that is on the list (must work)
9. write inside the project copy (must work)

Lines 1 to 4 are tried straight as the worker, with no sandbox in the way, so the room has to hold alone. Lines 5 to 9 go through one small Claude Code call inside the room, and are judged from outside by what is on disk afterwards and by two secret words, never by what the agent says. Lines 8 and 9 also prove the tries ran, and line 7 only counts when the file tool demonstrably read a file inside the copy: a test in which nothing ran fails.

## Settings

All in `FenceSettings` (`packages/core/src/fence/room.ts`), passed as JSON in `SF_FENCE` until the settings screen exists: `room`, `worker`, `copies`, `netList`, `hostPorts`, `testModel`, `stepTimeoutMs`. After a change, `npm run fence -- setup` writes the rules into the room again.

## One ticket through the door (slice 2)

`npm run step1 -- work "<your sentence>"` works one ticket, and `npm run step1 -- story T1` tells it back. Settings come from `SF_STEP1` (project, starting branch, checks, model, turns, time limit, work folder) and `SF_FENCE`.

1. The sentence is written to the record. The record only grows; it lives on the Windows side, outside the room.
2. The fence test runs. One line off, and nothing starts.
3. The project comes from GitHub and goes into the room as one file of data. The room never gets the GitHub pass.
4. The agent works under wall 2. When it ends, everything it left running is ended.
5. SoftwareFactory's own steps on the copy (commit, the project's checks, packing) run in a box with no network at all. The agent's git hooks, git settings and hidden-file lists are thrown away first.
6. The result comes back as one file of data. On Windows it is looked at, never opened as files and never run. It is held, and stays on this computer, when it touches `.github/`, `.gitmodules` or `.gitattributes`, when a secret is found in it, or when a file the project keeps changed while the checks ran.
7. Otherwise it leaves as a branch and a draft pull request. The base branch is never written.

## The home screen (slice 3)

Double-click `SoftwareFactory-Step1.cmd`, or run `npm run step1 -- home`. One page opens in your browser, on this computer only (`127.0.0.1:4517`). Closing the black window closes SoftwareFactory and stops a run that is working.

- You type a sentence and press Start. One run at a time for now.
- While it works you see its latest line, and Stop ends everything the run started inside the room.
- Each ticket shows where it stands, what it cost, and its story line by line. All of it is drawn from the record.
- Accept puts the proposal into the project: exactly the commit SoftwareFactory checked. If the proposal changed on GitHub since, or was closed, accept refuses and says so.
- Settings (project, starting branch, model, turns, time limit, prepare commands, checks) are changed on the page, kept in `settings.json` beside the record, and each change is a line in the record. The fence's own settings are not changed from the page.
- The page answers only to its own address, and its buttons work only with a key that the page itself carries, so another site open in your browser cannot press them.
- Before you confirm an accept, the page reads what GitHub's own checks say about the proposal and tells you, also when they failed or never ran. The choice stays yours.
- The address SoftwareFactory opens carries a pass, made new at every start and good for one opening. Without it there is no page, no state and no button, so another account on the computer gets nothing. The page's port is also added to the ports the fence test tries from the room: if a run could reach the page, no run starts.
- Accept refuses a proposal that no longer fits on the project as it is today. If the project moved on but the proposal still fits, GitHub puts the checked commit on top of today's project; the checks were run on the project as it was when the run started.
- While SoftwareFactory talks to GitHub (fetching the project, pushing the proposal) the page waits, up to five minutes at the worst. Stop is taken as soon as that step ends.

## Stop and undo (slice 4)

- Stop is on the home screen while a run works. It ends everything the run started inside the room, the ticket ends as "stopped", and nothing leaves the computer. Closing SoftwareFactory's window does the same.
- Undo is on every accepted ticket. SoftwareFactory makes a new change that takes back exactly what the accept put in, on top of the project as it is today, and puts it into the project. Nothing is erased: the project's history and the record keep both steps. Later work elsewhere in the project stays.
- When later work was built on the very lines the change touched, undo refuses and says so. That case needs your hand, or a new ticket.

## The watchdog and the phone line (slice 5)

`SoftwareFactory-Step1.cmd` starts two things: SoftwareFactory, and beside it a small watchdog in its own minimised window. SoftwareFactory writes a sign of life every five seconds; the watchdog only reads it.

- SoftwareFactory went away in the middle of a run (it crashed, or was killed): the watchdog ends everything the run left working in the room, and says one line.
- A run wrote nothing for longer than "call a run silent after": the watchdog says one line, once. The run goes on; Stop is yours.
- SoftwareFactory itself says one line when the fence did not hold, and when a ticket was parked because a limit was reached.
- Every line is written in the record and shown on top of the home screen. With a phone set, it also goes to your phone.
- The phone: the free ntfy app, no account. In Settings choose "The ntfy app", give the channel a long random name, save, subscribe to the same name in the app, and press "Send a test line". A line to the phone names the ticket and what happened; it never carries your sentence, the project's name or code. Whoever knows the channel name can read the lines, which is why it is long and random.
- Closing SoftwareFactory on purpose sends the watchdog home quietly.

## Known limits, said plainly

- The watchdog lives on the same computer. When the laptop is off or asleep, it is silent too.
- Seen on the laptop (27 Nov 2026): inside its own sandbox the agent could not use what its own `npm ci` had just installed (`tsc: not found`), while SoftwareFactory's check seconds later found it and built. Not understood yet. Until it is, a run cannot test a web build itself; SoftwareFactory's checks still do.
- Checks run in the order they are set, in the same copy. RoadToMill's Go check needs the web build's output, so the web check must come first.
- Some long chained shell commands are refused inside the room without a reason given. The run is told to fall back to plain single commands.

- The checks prove what the project's own scripts prove. An agent writes those scripts too, so the checks are a help for your review and not a replacement for it.
- Go and Node are downloaded from go.dev and nodejs.org over HTTPS when the room is set up. Both downloads are compared with their makers' published checksums (`goSha256`, `nodeSha256`). Change a version and its checksum together.
- The record refuses rewriting through SoftwareFactory itself. A program on Windows that opens the file directly could still change it; nothing in the room can reach it.

- Microsoft does not call WSL2 a security boundary. Claude Code's sandbox covers commands only; its file tools are held by permission rules. That is why the fence is tested every time instead of trusted.
- A run needs a Claude sign-in. SoftwareFactory hands it in for the run; it is not on the room's disk, but the run's own process holds it.
- The setting names in the rules file were read on code.claude.com/docs on 27 Nov 2026. The test, not the reading, decides whether they hold.
- A run's commands can read the room's own system files, and can write in the room's temp folder. The room holds nothing of yours, which is the point of wall 1.
- Line 1 also fails when WSL's window and clipboard sharing is on, because the clipboard is a door to what you copy on Windows. Turning it off is a setting for all of WSL on the computer.
- The switch that lets WSL start Windows programs is shared by every WSL distribution on the computer, so it can read "on" inside the room although the room's own setting is off (seen on the laptop, 27 Nov 2026). Line 3 therefore does not read the switch: SoftwareFactory hands in a harmless Windows program (`whoami.exe`) and the worker really tries to start it, through every door WSL has.
- Line 3 on the laptop (27 Nov 2026): both tries ended in a timeout on the room's side and no mark appeared on Windows. There is no positive control yet, a run where the mark does appear from a distribution that is allowed to start Windows programs, so "no mark" rests on cmd.exe being able to write to the Public folder when it does run.
- `npm run fence -- test` through the root script can end with exit code 0 even when the test fails. Read the last line, or call `runFenceTest` in code; never gate on that exit code.
- Not tried yet on a real laptop: creating the room itself. `fence setup` expects the room to exist.

## The home screen inside the installed app

The installed SoftwareFactory app opens the home screen in its own window. There is no console window and no
starter file (`SoftwareFactory-Step1.cmd` stays for a checkout without an installed app).

- The shell (`src-tauri/src/home.rs`) starts `step1-cli.js watchdog` and `step1-cli.js home --no-open` as hidden
  processes on the bundled Node.js. The window first shows a small starting page, then the home screen.
- The home screen prints its address with the one-use pass on its output. The shell reads that line and opens it in
  the window; the pass is not written to `home.log`. The window's page gets no access to the shell's commands.
- The shell holds a pipe to the home screen (`SF_SHELL=1`). Closing the window, or the shell going away for any
  reason, ends the pipe, and the home screen says goodbye exactly as on Ctrl+C: `closed` is written for the watchdog
  and a run in the room is stopped.
- If the home screen stops by itself, the shell starts it again once (a start that held five minutes earns a new
  restart). A second stop is shown in the window with the last lines of `home.log`.
- Logs are in the app's data folder: `home.log`, `home.prev.log`, `watchdog.log`. The record and the settings stay
  where they were (`%LOCALAPPDATA%\SoftwareFactoryStep1`).
- Updates: the home screen has no update page. At start the app looks once and installs a newer signed build by
  itself, never while a ticket is being worked. The setting `autoUpdate` (Settings, Updates) turns that off.
- `SF_WINDOW=bridge` (or the word `bridge` in the file `window-mode` in the app's data folder, when the variable
  is not set) starts the older Bridge and its core instead. Nothing starts the older core beside the home
  screen.

The Windows smoke test (part 7c of `scripts/smoke/windows-smoke.mjs`) proves this path on every build: the home
screen answers, refuses a visitor without the pass, the window opens it, closing the window writes the goodbye,
and killing the app alone leaves nothing on port 4517.

## The project tells its own checks

With no checks written in Settings, SoftwareFactory finds them in the project (`fence/projectchecks.ts`): it reads
the file list of the starting point, before the run touched anything, so a run cannot weaken its own checks. It
looks at the top folder and the folders right under it. A `package.json` with a `typecheck` or `build` script gives
`npm ci` to prepare and those scripts as checks; a `go.mod` gives `go mod download`, then `go vet` and `go build`.
Node comes before Go. Tests are not taken: they often need a database or a key, and come in when a project is
brought in and proven in the room. Folder names that are not plain letters, digits, dot, dash or underscore are
never put into a command. The story of the ticket says what was found; checks written in Settings always win.

## Tickets and the queue

A sentence opens a ticket; it does not have to wait for the run before it. Tickets are worked one at a time, the one
that waited longest first, and a queue that still held tickets when SoftwareFactory was closed goes on at the next
start. Everything is drawn from the record, so the queue is not a second list that could disagree with it.

- **Kinds:** request, bug, task, idea, plan, question. A run works requests, bugs and tasks. An idea, a plan and a
  question are kept on the list (the idea bank and plans give them their road later).
- **Create:** `POST /api/step1/work` `{ sentence, kind? }`. **See:** the list with each ticket's state, place in the
  queue and story. **Edit:** `ticket/edit` changes the words or the kind while the ticket still waits; after a run
  its words are frozen. **Delete:** `ticket/remove` takes it off the list; the record keeps its story and
  `ticket/restore` puts it back. A ticket that is being worked cannot be removed: stop it first.
- **Again:** `ticket/again` sends a ticket that ended with nothing to accept (failed its checks, parked, stopped,
  crashed, not started, interrupted, held) back to the queue under the same name.
- **Stop** ends the run that is working; the next ticket takes its turn. **Hold the queue** (the setting `hold`)
  keeps waiting tickets waiting until it is let go; a run that is working goes on.
- New lines in the record: `ticket.edited`, `ticket.queued`, `ticket.removed`, `ticket.restored`. A go that left no
  line at all is given the end `crashed`, so the queue can never start the same ticket without end.

## The ready gate

Before a ticket is worked, a reader (`fence/gate.ts`) reads the owner's sentence and the project's file names and
writes the **test of done**: one to four things a person could look at when the work is finished. The run is told
them and cannot change them; they are in the story and in the proposal on GitHub. The reader also names the kind
(bug, task, request) of a ticket whose kind the owner did not choose, and lists what it assumed as guesses.

- When the sentence can be read in two clearly different ways, the gate asks **one question** instead of starting.
  The ticket shows "A question for you" with an answer box and holds nobody up: the next ticket takes its turn.
  After the answer the gate passes; it never asks about the same words twice. Changing the ticket's words starts
  the gate afresh.
- The reader is an agent like any other: inside the room, in an empty folder, with no tools and one turn. The
  owner's words and the file names are handed to it as data.
- A reader that cannot be asked (the room is down, the plan limit, an answer that cannot be read) never holds a
  ticket up: the ticket passes without a test of done and the story says why.
- A ticket sent to be worked again keeps the test of done it has.
- Settings: `gate` (on by default) and `gateModel` (`haiku`). Record lines: `gate.asked`, `gate.answered`,
  `gate.passed`.

## What the agent is started with

Every agent in the room (the run, the fence test's, the gate's reader) is started with the same line from `room.ts`: `--tools "Bash,Read,Edit" --disable-slash-commands --setting-sources user --strict-mcp-config`, and with `ENABLE_CLAUDEAI_MCP_SERVERS=false`. Three tools and no more (the room's managed rules do not allow Write, so a new file is made with the shell): no sub-agents, no scheduling, no messages, no skills.

- The project's own Claude settings (`.claude/settings.json` in the copy) do not count inside the room. They could deny reads (which hid `node_modules` from the run) and name hooks and plugins; only the room's managed rules and the worker's sign-in apply.
- The room is signed in with the owner's account, so that account's connectors (mail, files, documents) would otherwise be offered to the run as tools, and those do not pass the room's network list. They are switched off, and SF reads the first line of the agent's stream: if any `mcp__` tool or server is listed, or one is used later, the run is ended and nothing of it is kept. A run whose first line never lists its tools is not kept either. The flags are the wall; this is the alarm.
- The ready gate's reader is started the same way, with no tools at all.

## The story in steps

Each worked ticket shows a fixed road: Asked, Ready, Fence held, Worked, Checked, Proposed, Accepted (and Undone when it happened). `fence/story.ts` reads it from the record each time; nothing about it is stored.

- Every step says its state (done, failed, now, skipped, not reached), one sentence of proof, the facts behind it (each line of the test of done, each of the nine fence lines, each check, each changed file, the commit) and the numbers of the record lines it was read from.
- A step that failed stops the road: what follows is "not reached", never guessed.
- A ticket sent again shows its latest go; the count of goes is a fact on the first step.
- On the home screen the road is one line of marks per ticket and opens into the steps. Every line of the record stays below it. `npm run step1 -- story T1` prints the steps first, then every line.

## Parked, and back by itself

A run that meets the plan limit is parked with `parkedFor: "limit"` in its end line. Two things follow, both read from the record, so they survive a restart.

- **The queue rests.** The next run would only meet the same limit, so nothing new starts for `parkedWaitMinutes` (default 30). The screen says until when. The rest ends early when you press Work it again on any ticket.
- **The ticket comes back.** After the wait SoftwareFactory writes `ticket.queued` in its own name and the ticket waits its turn again, behind tickets that waited longer. Its test of done stays as it was written. One ticket comes back at most `parkedReturns` times (default 2; 0 means it waits for you); after that it stays parked and says so.

Parked for another reason (the time limit, all its turns, nothing changed) does not come back by itself: the same run would end the same way. Those wait for Work it again. The work of a parked run is not kept yet; that comes with the two limits in step 3.

## GitHub issues

Off by default (`issues: "off"`). Settings turn it to `in` or `both`; `issuesLabel` (default `sf`) and `issuesEveryMinutes` (default 5) go with it, and "Look at GitHub now" on the screen looks at once.

- **In.** An open issue of the project with the label becomes a ticket, once. Only the owner's own issues: written by the sign-in in use, or marked by GitHub as the owner's. An issue is text from outside and a ticket is worked by a run, so anyone else's issue is counted and left alone. A `bug` label makes the ticket a bug.
- **Out** (`both`). A ticket that still waits gets an issue (never an old, already worked one) with the label and a hidden mark. If the link was lost before it was written, the mark finds the issue again; it is never made twice.
- **The link** is one line in the record (`issue.linked`). The ticket shows it, and the proposal says `Closes #N`, so accepting closes the issue on GitHub by GitHub's own rule.
- **Closed on GitHub** while the ticket still waits: the ticket leaves the list (it can be put back). A ticket that was already worked keeps its place.

Not yet: words changed on one side after the link do not travel to the other, and nothing is written on an issue beyond opening it.

## Sleep is not run time

`fence/awake.ts` counts time in small steps, and a step that took far longer than it should is a sleep. A run's time limit is counted in awake time, so a laptop that slept four hours did not use four hours of a run. The watchdog writes down the sleeps it saw and takes them out of every age it judges: a sign of life from before the sleep is not "SoftwareFactory went away", and a run that was quiet only because the computer slept is not "silent".

A ticket whose go was cut off in the middle (SoftwareFactory was closed, the computer restarted, the watchdog ended the run) comes back to the queue by itself, `cutOffReturns` times (default 1), and only when it was cut off within `cutOffWithinHours` (default 24): an old cut-off ticket waits for you. The run starts again from the project as it is: nothing of a cut-off run is kept.

The plan limit can also be met before a run, by the gate's reader or by the fence test's own agent. Both park the ticket for the limit, the same as a run that met it: the queue rests and the ticket comes back. Neither is written down as a hole in the fence.

## Two runs at once

`slots` in Settings (default 1, up to 4) says how many runs may work at once. With 1 nothing changes: ending a run ends everything of the worker's in the room, the way that is proven.

With more, each run gets a cell of its own (`fence/cell.ts`): a cgroup made by root in the room, named after the run. Every step of the run says its process number and waits; root moves it into the cell; only then does it go on, so whatever it starts is born in the cell. Tried on the real room (27 Nov 2026): the worker cannot move a process out or make a cell of its own, a child started with `setsid`, `nohup` or a double fork stays in, bubblewrap with `--unshare-all` stays in, and `cgroup.kill` leaves nothing. Stop, the time limit and the end of a run end the cell and nothing else; "nothing left running" is the cell's empty list.

- Root moves exactly the process that asked (same number and same birth time), only when it is the worker's and still in the room's top group. A step that was on its way in when Stop came is ended once it is inside.
- Whether anything is left is the kernel's own word (`cgroup.events`, populated).
- The fence test before a run does not end the worker's processes while another run works. Its agent and the gate's reader each get a short cell of their own, ended when they are done.
- The rest after the plan limit is not ended by another run starting.
- Two copies do not see each other: the agent's shell sees only its own copy, and the Read and Edit tools refuse the other (tried the same day).
- What two runs still share: the one worker account, its home and `/tmp`, and the one sign-in. SoftwareFactory's own steps run as that account too.
- The home screen shows every run that works, with a Stop for each. The watchdog still ends the whole room when SoftwareFactory itself goes away.

## The stop list

Inside the fence a run is free. Five kinds of change still wait for your own look before they leave this
computer, whatever the checks said (`packages/core/src/fence/stoplist.ts`):

| Family | What holds a result |
| --- | --- |
| security | settings for AI agents and editors (`.claude`, `.cursor`, `.vscode`, `.mcp.json`), `CLAUDE.md` and its like, `.env` files, key files, `.npmrc` and its like, `CODEOWNERS`, any name with a word for sign-in, rights or secrets, and any link or project placed inside the project |
| leaves the computer | Dockerfile, compose files, hosting files (Vercel, Netlify, Fly, Render, Wrangler and others), deploy scripts, Terraform, deploy and infra folders |
| live data and money | migrations, `.sql` files, any name with a word for payments, payouts, billing, checkout, a wallet or a ledger |
| runs by itself | git hook folders, other CI files, Makefile and its like, a package.json script that npm runs by itself (`postinstall`, `prepare` and others) |
| new package | a new or moved package in package.json, anything new in go.mod, every lockfile, vendored packages, and the package lists of other languages |

Names are matched whatever their case, and by whole words: `PaymentForm.tsx` is held, `StripedTable.tsx` is not.
A file that is there and cannot be read is held, never taken for a deleted one. The list errs on the side of
holding: `.env.example` and a test of the sign-in code wait for your look too.

How it behaves:

- The stop blocks that one result, not the factory. The run ends, the ticket shows **Held here** with each
  file and its reason, and the queue goes on with the next ticket.
- The result stays whole in SoftwareFactory's own history. The record line (`result.proposed`, `held`, `stop`)
  keeps the branch, the two commits, the title and the words of the proposal.
- Only you let it go: **I looked: let it go to GitHub**, then **Yes**. The result is checked for secrets once
  more, sent as the same draft pull request, and the record says you released it (`released`, who: you). It still
  needs your accept like any other.
- A hold for a secret, for `.github/`, or for a check the result rewrote is not on this list and is never let go
  from the screen. Work it again instead.
- The list is closed. Settings can add paths (**More on the stop list**, `stopPaths`, plain text matched anywhere
  in a file's path) and can never take one away. Nothing of the result is run to decide any of this.

## Two limits

SoftwareFactory counts what runs use, in the dollars Claude Code reports for each run, from the record alone
(`packages/core/src/fence/limits.ts`). With a plan sign-in these are not a bill; they are the measure.

| Limit | What counts under it | Setting |
| --- | --- | --- |
| Limit 1 | work you sent: a ticket you opened (an issue of yours counts) or sent again | `limitYou`, 100 a month |
| Limit 2 | what SoftwareFactory does by itself: a ticket it brought back, and its own work | `limitAlone`, 50 a month |
| Own share | the most of limit 2 SoftwareFactory's own work may use | `ownSharePercent`, 20 |
| One run | the most a single run may use | `runLimit`, 5 |
| Floor | a run is not started with less than this left of its limit | `runFloor`, 0.5 |

The period is a day, a week (from Sunday) or a month (`limitPeriod`), by this computer's calendar.

At a limit nothing is asked for:

- Work of a kind whose limit is used up does not start. The ticket stays waiting and says until when. The other
  kind goes on.
- Each run is started with its own ceiling (`--max-budget-usd`): the run limit, or what is left of its limit if
  that is less. A run at work holds its ceiling back from the limit, so two runs cannot spend the same room.
- A run that meets its ceiling, its turns or its time limit is parked and **its work is kept**: committed in the
  room, brought out as data, and held as a branch in SoftwareFactory's own history. It was not checked and is
  sent nowhere. The next run of that ticket starts with those changes already in its files, and the result is
  checked whole as always. If the kept work no longer fits the project, the run starts clean and says so.
- The plan limit met in the middle of work keeps the work the same way.
- Only the ticket's latest run counts. A later run that failed, crashed or was stopped ends the kept work, and so
  does **Start clean** on the ticket. Kept work from another starting branch is not used.
- A run that was cut off, stopped or timed out never says what it used. It is counted at its ceiling
  (`costAssumed` on its last line), so the limits cannot be passed by runs that end without a word.
- Kept branches stay in SoftwareFactory's own history; nothing removes them yet.
- Claude Code counts the ceiling by its own estimate and may pass it a little.

Nothing uses the own share yet: no work of SoftwareFactory's own exists before step 5. The share is counted so
that work has its ceiling from its first day.

