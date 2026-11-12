# Design system: Foundry Glass

Approved by Assaf on 2026-11-11 after a UI and UX council. Proposal, mockups and live prototype: https://claude.ai/artifact/BUevHm6B2yRRUC7f837Dze

Tokens live at the top of `apps/bridge/src/styles.css`. Use them; do not add raw colours.

## Colour
- Surfaces, nearer is lighter: `--bg` #0b0d10, `--shell` #0f1216, `--panel` #14181d, `--panel-2` #1a1f26, `--hover` #20262e.
- Borders: `--line` (8.5% white), `--line-2` (14%), `--line-3` (24%, hover and focus).
- Text: `--ink` #f2f0eb (15.7:1), `--ink-2` #c4c9d1 (10.7:1), `--muted` #9aa2ad (6.9:1).
- Roles, one meaning each, always with a glyph or a word too: `--accent` teal = working or primary action; `--gate` amber = needs you, and nothing else; `--good` green = done; `--bad` red = failed or conflict; `--agent` violet = an agent.

## Type
- Geist Sans for everything, Geist Mono only for ids, money, paths, keys and code. Both are bundled (`@fontsource`), so the app looks the same offline.
- Base 15px. Nothing under 13px except mono tags (12.5px). No uppercase labels.

## Motion
- 120 to 260 ms, `--ease`, transform and opacity only. No blur, no animated shadows.
- Hover on everything clickable, `scale(0.98)` on press, a 2px focus ring.
- Reduced motion turns every loop and transition off.

## Rollout
0. UI tour and bundled fonts (done, PR #32). 1. Tokens, type and hover on the current layout. 2. Shared components and plain words. 3. New shell behind a Systems switch. 4. Project cards, short names, five sections. 5. Approval screen, motion, shortcuts. 6. Retire Whole factory and the old shell.

## Shared components (phase 2)

All in `apps/bridge/src/ui/`, shown in every state at `#/_kit` (not linked; the UI tour shoots it).

- **GateBar**: the one approval bar. Knows nothing about runs: give it `question` and `onDecide(approve, note) => Promise`. Failed-step mode with `failed`, `error`, `attempt`, `same`. `GateActions` wires it to a factory run. The game's Dock should use `GateBar` directly.
- **StatusGlyph / StatusTag**: one mark per state, readable by shape alone: working (spinning ring), needs (amber diamond), done (check), failed (cross), idle (dashed ring), agent (violet dot).
- **EmptyState**: title, one or two lines on what will appear, and optionally the one action that gets there.

Words people see: Assistant (not Overseer), note (not Signal), Loose ideas (not Unsorted), Project rules (not Canon), Your OK: plan / Your OK: build (not gate A/B), Budget (not fuel), Agents (not Agent Bay), Systems (not Ship's systems). Code names stay as they are.

## Foundry Glass shell (phase 3, preview)

Switch it on in **Systems → Layout → Foundry Glass** (kept per computer in `localStorage["sf.layout"]`; Classic stays the default until phase 6). Code in `apps/bridge/src/shell/`.

- **Sidebar** (248px): Needs you (amber count only when something waits), Projects, six most recent projects with a status glyph, Agents, Whole factory, Finished apps, Add-ons, Brain; Systems, online, spend, crew and version at the foot. Command (the game door) joins when the game thread ships it.
- **Needs you** (`#/needs`): every waiting approval answered in place with GateBar, plus finished apps to approve and rule conflicts.
- **Helm** (Ctrl K): Enter files what you typed as a note (in the open project), Ctrl Enter builds it, arrows and Enter jump to a project or page.
- **Assistant** (Ctrl J): the chat as a right column you can hide; remembered per computer.
- The UI tour shoots the new shell as `fg-*` screens.

## Approval screen, motion, keys (phase 5)

- **ApprovalCard** (`shell/ApprovalCard.tsx`, used by Needs you): what you approve laid out beside the question. Plan OK shows the summary, tasks, "done means" checks and budget. Build OK shows the last test round, the review and the files. The GateBar is sticky at the card's foot.
- **Motion**: pages in the new shell fade up 4px over 180ms; helm and Assistant slide in; all off under reduced motion.
- **Keys** (`shell/Shortcuts.tsx`, new shell only, never while typing): `?` lists them; `G` then N/P/A/F/L/O/B goes to Needs you, Projects, Agents, Whole factory, Finished apps, Add-ons, Brain.

## Cards, short names, five sections (phase 4)

- **Sections**: `registerProjectPanel` takes an optional `section` (`brief | build | ship | improve | know`, default `know`). The project rail groups tabs under Brief (Overview, Ideas), Build (Builds, Tickets, Agents), Ship (Use, Integrate), Improve (Improvements), Know (Code map, History, Settings, add-on tabs). Panel ids and links are unchanged.
- **Short names** (`projects/shortName.ts`): drop the article and the "with…/that…/for…" tail ("A word counter app with history" → "Word counter app"). Used in cards, the sidebar, the helm and the project header; the full name stays as subtitle and tooltip.
- **Cards**: in Foundry Glass, Projects is a grid of cards: status mark and line, short name, full name or summary, build bar, counts, last active; Use appears on hover for shipped projects.
- Needs you also counts tickets waiting on you; Tickets has its own sidebar item.

## One shell (phase 6)

- The classic top bar and the Systems → Layout switch are gone; Foundry Glass is the only shell.
- The Whole factory screen is dissolved. Each part is its own page with a sidebar item: All builds (`#/factory`), Agents (`#/factory/bay`), Tickets (`#/factory/tickets`), Rules and ideas (`#/factory/order`, star map beside project rules, loose ideas and conflicts), Improve (`#/factory/improve`), Data vault (`#/factory/data`). Old links keep working.
- Sidebar counts are neutral; only "needs you" counts (Needs you, conflicts) are amber.
- Light theme stays a later step.

## Factory Bridge (dashboard)

Assaf asked for a next-generation dashboard (2026-11-12). A council produced three concepts (prototype: https://claude.ai/artifact/NsFb5giEUuWyYwCAKaa4U5); he chose all three as modes of one page, Signal Loom first. Code in `apps/bridge/src/bridge/`, route `#/bridge[/mode]`, sidebar item **Factory Bridge**, key `G` then `D`.

- **Status strip** on every mode: what waits for you (amber, links to Needs you), agents working, builds running, spent today.
- **Signal Loom** (`loom`): the factory floor for every build at once. One lane per build (all unfinished, then the latest finished, up to 8) through the eleven stations; station lamps light where an agent works with its glyph; a knot per fix round; the two Your OK signals and the lane turn amber while a build waits, and tapping the lane opens the shared approval bar in place. A departure board below sorts waiting builds first; any other row opens the run in its project. Drawn at the pane's real width (scrolls below 720px), redrawn only on events; elapsed times tick every 5 s.
- **Partitura** (`score`): one staff per agent, one note per agent call (length = time, brightness = cost, red = failed, teal = working now); each build keeps its own thin line inside a staff. Windows: Work sessions (default: the latest burst of work, where calls less than 20 minutes apart belong together; Earlier and Later step through sessions), last hour, 24 hours, all. **Timetable** redraws the calls per build down the agent stations, so fix loops show as a sawtooth. Hover a note for agent, build and cost; click opens the build.
- **Lantern Quarter** (`quarter`): one district per project (most recently active first): a street of 11 station lots for its latest build, a house per open ticket (taller = sooner, red = bug), builds and spend, working agents' glyphs, and a porch light that turns amber while the project waits for you. Agents as moons filled by their share of spend, violet rim while working; a click opens the Agents page.
