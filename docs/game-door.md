# Game door: three practice demos

Assaf asked (2026-11-11) for a second way into SoftwareFactory that feels like a game but moves real work: a side door, a plugin over the same backend and tables, focused on doing. A creativity council ran three rounds (20 pitches from independent seats, a critique round, a firming round). Three concepts survived. Each ships here as a playable practice demo so the choice can be made by playing.

Concept page: https://claude.ai/artifact/SNHTW1bAizfhErbGWYbQZH

| Demo | Plugin | Core verb | Real work it stands for |
|---|---|---|---|
| The Dock | `game-dock` | clear a belt of items, one key each | sort ideas, approve gates, accept proposals, park with a reason, merge duplicates |
| The Sector | `game-sector` | command a strategy map | plant projects, send agents to tickets, defend against bugs, clear decisions, draw campaigns |
| The Workshop | `game-workshop` | rewire a loop and replay last week | agents per station, caps (fuse), retry limits (governor), gate placement, plugin cartridges |

All three are page-only plugins (Plugins page, Examples, Add, Turn on). The Dock and the Workshop ask for no permissions (Sector asks to read records since v0.3, see below); they have no backend, load nothing from outside, and say on screen that nothing is written to SoftwareFactory. Their data is practice data built into the page.

Shared rules the real version keeps:

- Every game action is a real SF action; the game stores at most layout and drafts.
- Anything that spends money shows its price and needs a hold to confirm. The day's cap is the fuel bar.
- A session ends with a receipt of what changed and what it cost. No points, streaks or badges.
- Flat 2D, redraw on change, pause when hidden. No GPU needed.

## Engine choice

No game engine for now. Plain DOM plus Canvas 2D is enough for these demos (each page is one self-contained file of 30 to 50 KB), and it fits two hard limits:

- Plugin pages run under `default-src 'self'`, so any library has to be copied into each plugin folder.
- Assaf's rule: minimal graphics that run without a strong or mid GPU. PixiJS 8 and Kaplay render through WebGL. Phaser can fall back to Canvas but adds about 1 MB per plugin.

If a later version needs tilemaps, pathfinding or many sprites, Phaser in Canvas mode, copied into the plugin folder, is the fallback.

## What the real version needs

Plugins can read events and post timeline notes today, but cannot take actions. The game door needs an `actions` permission: a short list of verbs (sort, approve, ticket, split, park, plant, deploy, commit), each calling the same core command the normal screens call, tagged with where it came from so the game can be measured against the normal screens.

## Sector v2 (2026-11-11)

Assaf picked the Sector direction and asked for a real strategy game. The design doc is the Claude Doc "Sector: game design". The example plugin `game-sector` is now v0.2: a real-time base builder.

- Command Center (SoftwareFactory) in the middle. Build a Refinery (Order Engine), Barracks (Agent Bay), Reactor (agent slots), Apps (projects), and later Test Turrets, Features, Archive (project rules) and a Plugin Dock.
- Conduits (C) are dependencies. Only buildings connected to the Command Center get power and work; connecting extends the lit build area.
- Agents: Scout (Haiku, carries loose ideas), Constructor (builds spec → build → test), Warden (fixes bugs, repairs breaches), Judge (review, smaller release wave). Agent ranks come from jobs done.
- Resources: Budget (daily cap, hold to spend), agent slots, Blueprints (tickets), Data (research), Renown (only from real outcomes).
- Threats: bugs grow and crawl along conduits; breaches stop a building; rule conflicts block research; each App ships only after its release wave.
- Missions, five Commander ranks with unlocks, research. Practice data only; the base menu mirrors the bases model in docs/bases.md.

Done (2026-11-14): the plugin `actions` permission and `records:read` (docs/plugins.md, "Actions"), with the `field-desk` example as proof. Done (2026-11-14): Sector v0.3 reads real records. It asks for `records:read`; each App you place is one of your real projects (most open work first, with its open tickets, bugs and what waits for your look in the selection panel), and the loose ideas Scouts carry are your open tickets. It still writes nothing. Outside SoftwareFactory, or without the permission, it falls back to practice names and says so.

Done (2026-11-14): Sector v0.4 gives orders from the map. It asks for `actions` with one verb, `ticket.open`. Select an App that stands for a real project, press **Give an order**, write one line and pick request, bug or task: a real ticket opens in that project, opened by `plugin:game-sector`. An order never spends; working the ticket stays a choice made in SoftwareFactory. Orders show in the feed and on the end receipt.

In the app, a plugin's own page now comes first on its Add-ons page, with a **Full view** button; what it may do, what it adds and its log fold away under it.

Next: actions that spend money (work a ticket) behind a price and a hold to confirm, and a note on an existing ticket from the map.
