# Configuration

What SoftwareFactory runs with right now, where each piece came from, and which setup every run used.

This is the first part of configuration profiles (Assaf's brief of 22 Nov 2026). Profiles, Scout picks as catalog entries, trials and editable switches come next.

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

## API

- `GET /api/config`: the current setup by layer, with its fingerprint
- `GET /api/config/snapshots/:hash`: a recorded setup and what changed since
- `GET /api/config/ran?run=N` or `?ticket=N`: the setups a run's or ticket's calls ran with
