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

## Known limits, said plainly

- Microsoft does not call WSL2 a security boundary. Claude Code's sandbox covers commands only; its file tools are held by permission rules. That is why the fence is tested every time instead of trusted.
- A run needs a Claude sign-in. SoftwareFactory hands it in for the run; it is not on the room's disk, but the run's own process holds it.
- The setting names in the rules file were read on code.claude.com/docs on 27 Nov 2026. The test, not the reading, decides whether they hold.
- A run's commands can read the room's own system files, and can write in the room's temp folder. The room holds nothing of yours, which is the point of wall 1.
- Line 1 also fails when WSL's window and clipboard sharing is on, because the clipboard is a door to what you copy on Windows. Turning it off is a setting for all of WSL on the computer.
- The switch that lets WSL start Windows programs is shared by every WSL distribution on the computer, so it can read "on" inside the room although the room's own setting is off (seen on the laptop, 27 Nov 2026). Line 3 therefore does not read the switch: SoftwareFactory hands in a harmless Windows program (`whoami.exe`) and the worker really tries to start it, through every door WSL has.
- Line 3 on the laptop (27 Nov 2026): both tries ended in a timeout on the room's side and no mark appeared on Windows. There is no positive control yet, a run where the mark does appear from a distribution that is allowed to start Windows programs, so "no mark" rests on cmd.exe being able to write to the Public folder when it does run.
- `npm run fence -- test` through the root script can end with exit code 0 even when the test fails. Read the last line, or call `runFenceTest` in code; never gate on that exit code.
- Not tried yet on a real laptop: creating the room itself. `fence setup` expects the room to exist.
