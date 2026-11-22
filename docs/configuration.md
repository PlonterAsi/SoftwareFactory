# Configuration

What SoftwareFactory runs with right now, where each piece came from, and which setup every run used.

Built from Assaf's brief of 22 Nov 2026. Done: the inventory, Ran with, isolation, profiles, the catalog, trials, switches.

## The three layers

| Layer | What it holds |
|---|---|
| How we work | Flows, the auto-work queue, the council, the safety gates |
| Who works | Agents (model, cap per call, station, skills, tools, MCP), the skill library, the advisor |
| Where and with what | Crew mode, isolation from your own Claude Code, MCP servers, add-ons, the run time limit, SF_* switches |

Each entry says whether it is on, what it is set to, where it came from (SoftwareFactory, Scout, a PR, you, an add-on, a switch) and since when. Provenance that is not obvious from the code is written in `PROVENANCE` (packages/core/src/configs/inventory.ts); add a line there when a Scout find or a decision turns something on.

Switches that only say how the process was started (SF_PORT, SF_DB and the like) are left out. A switch whose name says it holds a secret shows "Set (value hidden)".

## Ran with

Every paid call (`runAgent`) records the fingerprint of the setup it ran with on its `agent.run.started` event (`config`). The first time a fingerprint is seen, its whole list is kept once as a `config.snapshot` event. A run's page and a ticket show "Ran with <fingerprint>", and whether it is the same as now or what changed since.

The fingerprint covers each entry's id, on/off and setting. It does not change when only a date or a stat changes.

## Your own Claude Code stays yours

Agents run with `--setting-sources project,local`, including the Builder and Fixer when they edit a repo. Your personal skills, plugins, hooks and CLAUDE.md no longer change how the crew builds. To bring the old behaviour back for the Builder and Fixer in a person's repo, set `SF_CREW_PERSONAL_SETTINGS=1`; the Configuration page then shows the isolation entry as off.

## Profiles

A profile is a named set of settings. What a profile can set today:

| Setting | Layer | Value |
|---|---|---|
| `flow.<kind>` | How | a flow id (for example `flow.bug` = `refactor`) |
| `agent.<id>.model` | Who | haiku, sonnet, opus or fable |
| `agent.<id>.budgetUsd` | Who | a cap per call; it can lower a cap, never lift it past what the run has left |
| `advisor.model` | Who | off, sonnet or opus |
| `crew.personalSettings` | Where | on or off |

Which profiles a call runs with is a chain, broadest first: everywhere, the project, the ticket, the run. For each setting the narrowest profile that sets it wins. A flow step that names its own agent is narrower still. The profiles a call ran under are recorded on its `agent.run.started` event (`profiles`, like `["global:lean", "project:cheap"]`).

Each setting's path is what it touches. Two settings in one profile that touch the same thing are refused, so you keep one of them.

Pick profiles on the Configuration page (everywhere and per project) and on a ticket. Events: `config.profile.saved`, `config.profile.removed`, `config.assigned`.

## Catalog

Every technique, tool or workflow picked from Scout (or added by hand) is one catalog entry: title, what it is, its kind, where it came from (the video and the moment, or the find's link), what it touches, its build ticket and any tickets merged into it, and where it stands.

| State | Meaning |
|---|---|
| proposed | Picked; nothing runs. Its ticket is tagged `catalog` and the crew never starts it on its own |
| building | You chose Build it: the tag comes off and the ticket is back in line |
| ready | Built; it can join a profile, and its settings (if it has any) apply through that profile |
| trial | On trial (below) |
| promoted | Clearly better: its settings apply everywhere, under any profile |
| dropped | Worse, or dropped by you. Bring back or Put on trial again |

Work it on a held ticket still starts it: your press is your ask.

Add-ons add picks with the `catalog.add` action (Scout's Add to catalog). On its first start with this version, SF moved every open ticket Scout had filed into the catalog. Tickets about the same named thing (a brand in both titles, like SkillSpector) became one entry, and the extra tickets were closed as duplicates of the first.

A profile can list catalog entries (`entries`). Two entries in one profile that touch the same thing, or an entry and one of the profile's own settings, are refused.

## Trials

Only a ready entry with settings can go on trial. An entry built as code has none, so Mark built gives it its own switch, `feature.<id>`; code checks it with `featureOn(log, id, meta)` in `configs/profiles.ts`. The Build it note on the ticket says so.

While an entry is on trial, every second piece of work gets it: a ticket, or a factory run with no ticket, by its id (even ids get it, odd ids do not). A profile's own setting wins over a trial. Each agent call records its side in `agent.run.started` (`trial: { entry, unit, arm }`). Two trials at once may not touch the same thing.

A piece is finished when its ticket's pull request merged (pass), or it was rejected, its PR closed unmerged, or it was closed for another reason than a duplicate (fail). A factory run passes when it shipped and fails when it failed. When both sides have 5 finished pieces, SF decides:

| Result | When | What happens |
|---|---|---|
| Promote | Pass rate at least 20 points higher, and cost per piece no more than 20% higher | State promoted, applies everywhere |
| Drop | Lower pass rate, or the same pass rate for more than 20% extra | State dropped |
| Your call | Anything else | Stays on trial with a note; Promote or Drop on the Configuration page |

SF checks after a pull request changes, a ticket note, or a finished run (at most once a minute), and when the Configuration page loads. The catalog shows both sides of each trial.

## Switches

SoftwareFactory reads SF_* environment variables. The ones that change how the crew works (personal settings, the default advisor, the agent timeout, the screen and link checks, auto-resume, the import, review, Archivist and improvement caps, the sign-in retry wait, the browser) are listed in the Switches section of the Configuration page, set or not, with what each one does.

Change one there and it is kept as a `config.switch.set` event: it wins over this PC's environment and stays after a restart. Reset gives the PC's own value (or the default) back. Some switches are read on every use and apply at once; the rest apply when SoftwareFactory starts, and the page says when a change waits for a restart. With several bases, only the default base's choices apply, since they share one process.

Not editable there: secrets (shown by name only), how the process was started (port, database), and what picks the Claude Code binary or the crew mode (Systems owns those).

## API

- `GET /api/config`: the current setup by layer, with its fingerprint
- `GET /api/config/snapshots/:hash`: a recorded setup and what changed since
- `GET /api/config/ran?run=N` or `?ticket=N`: the setups a run's or ticket's calls ran with
- `GET /api/config/profiles`, `PUT|DELETE /api/config/profiles/:id`, `POST /api/config/assign`, `GET /api/config/resolve?project=&ticket=&run=`
- `GET|POST /api/config/catalog`, `POST /api/config/catalog/:id/state`
- `GET /api/config/switches`, `PUT|DELETE /api/config/switches/:name`
