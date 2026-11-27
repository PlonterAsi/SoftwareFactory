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
