---
name: sf-tickets
description: Use when work should go through SoftwareFactory's tickets on this PC: read what waits, open a bug or task, answer a ticket, or ask SF's crew to build something in a project.
---

# SoftwareFactory tickets

SoftwareFactory (SF) runs on this PC and keeps every piece of work as a ticket. Its crew builds tickets on branches and opens pull requests. Talk to it with the `sf` command, which reaches the running app at `http://127.0.0.1:4317` (or `SF_URL`).

Run it as `node <SoftwareFactory repo>/packages/core/bin/sf.mjs <command>` (on Assaf's PC the repo is `C:\Dev\SoftwareFactory`).

## Commands

- `inbox`: what waits for the person (look, answer, decide).
- `list [--all] [--status s] [--kind k] [--project n] [--q words]`
- `show KEY`: the ticket, its thread, its run and why it waits. Keys look like `SF-12`.
- `doc KEY`: the ticket's work document as Markdown. Read this before working a ticket yourself.
- `open "Title" --kind bug|task|request|idea|question [--body text] [--project n] [--size S|M|L] [--asked]`
- `reply KEY "text" [--status ready|built|...]`: write on the ticket's thread.
- `asked KEY [off]`: the crew starts it by itself within the person's standing money limit.
- `work KEY [--max 1.5] [--route light|engine]`: start the crew now. This spends money: only when the person asked for this work.
- `retry KEY`, `pr KEY 123`, `queue`
- `say-project ID "text"`: an ask in a project. A question is answered read-only, "another round" files tickets, anything else is work.

Add `--json` for the raw answer.

## Rules

- SF does the building. Do not build a ticket's work yourself in SF's projects unless the person tells you to; open or answer the ticket instead.
- `work`, `retry` and `asked` spend money. Use them only for work the person asked for.
- If `sf` says SF is not running, tell the person to open the app; do not start the core yourself.
