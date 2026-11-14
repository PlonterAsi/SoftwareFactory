# Developing SoftwareFactory

For a person or an agent about to change SF: how to set up, run, test and release, the recipes for the common kinds of change, and the working rules. Read [architecture.md](architecture.md) first for the shape of the code.

## Set up

Needs Node.js 22.5 or newer and Git. For the desktop app also Rust and the [Tauri prerequisites](https://tauri.app/start/prerequisites/). For real agents, the Claude Code CLI, signed in.

```bash
npm install
```

The repository is an npm workspace: `packages/core` (`@sf/core`) and `apps/bridge` (`@sf/bridge`), with the Tauri shell in `src-tauri`.

## Run

| Goal | Command |
|---|---|
| Core and Bridge in a browser | `npm run dev -w @sf/core` and `npm run dev -w @sf/bridge`, then open `http://127.0.0.1:5173` |
| The same with real agents | `SF_RUNTIME=claude-code npm run dev -w @sf/core` |
| The desktop app | `npm run app` |
| A factory run with no UI | `SF_RUNTIME=claude-code npm run factory -- "<idea>" --max-usd 1.5` (gates approve themselves; add `--council always` to seat the Council) |
| File a conversation through the Order Engine | `npm run order -- examples/order/messy-chat.json --mode agent --max-usd 0.2 --db .sf-data/demo.db` |
| Your branch's Bridge against the installed app's core | `npm run dev -w @sf/bridge` on the PC where SF runs: Vite proxies `/api` to port 4317 ([dogfood.md](dogfood.md)) |

From source the default runtime is `mock`: the practice crew, free, always building a word counter with a planted bug so the fix loop shows. Development data lives in `.sf-data/` (ignored by git).

## Check

| Check | Command | Notes |
|---|---|---|
| Core tests | `npm test` | Vitest, `packages/core/test/`. The real-browser and link checks are off in the suite; `engine.test.ts` runs the browser check on its own |
| Types | `npm run typecheck` | Core and Bridge |
| Build | `npm run build` | |
| UI tour | `npm run ui:tour -- --out before` | Screenshots every page with a throwaway practice core and fails on a console error or an empty screen ([ui-tour.md](ui-tour.md)). Run it before and after any visual change |
| Windows smoke test | CI only | Installs the built app, upgrades an old database, launches, runs a practice build, kills and resumes it, updates from an older version (`scripts/smoke/windows-smoke.mjs`) |

There is no Bridge unit-test suite. The UI is guarded by types, the UI tour and the smoke test.

Known flake: `launch.test.ts` "stops a project's apps when it is archived" can time out on the Windows runner.

## Release

Nothing is released by hand.

1. A pull request runs the Windows build and the smoke test (`.github/workflows/windows-build.yml`).
2. A merge to `main` runs them again and, only when the smoke test passes, publishes the rolling `latest` release: installer, MSI, portable zip and the signed `latest.json`.
3. Installed apps update themselves within minutes, waiting for running builds ([updates.md](updates.md)).

Every build is version `0.2.<CI run number>`. The updater key is a repository secret; the key file itself is never committed.

## Recipes

### Add a table

Register a projection in the module that owns the data (`packages/core/src/<module>/tables.ts`): a name, a version, `migrate` to create the tables, `apply` to update them from events. Export it from `index.ts`. It is backfilled from the log on the next start. To change a table's shape, bump the projection's `version`: it is dropped and refilled. Full example in [storage.md](storage.md). Then add the table to [reference.md](reference.md).

### Add an event

Add the type to the union in `packages/core/src/events.ts`, append it with `log.append(type, payload)`, and fold it wherever it is needed: a projection in the core, a hook in `apps/bridge/src/api.ts`. Events are never changed after the fact, so add fields, do not rename them. Then add it to [reference.md](reference.md).

### Add an API route

Put it in the module's `routes.ts` (a function that returns `[status, body]` or `null`) and, for a new module, call that function from the handler in `server.ts`. Write the route as a line in the comment at the top of the file, as the other modules do. A write should append an event so the Bridge sees it on the stream. Then add it to [reference.md](reference.md).

### Add a page

Add the page to the `Route` type, `parse` and `href` in `apps/bridge/src/projects/router.ts`, render it in `App.tsx`, and add it to the sidebar (`shell/Sidebar.tsx`), the Helm's page list (`shell/Helm.tsx`) and, if it deserves one, a shortcut (`shell/Shortcuts.tsx`). Use the shared components in `ui/` and the tokens in `styles.css` ([design.md](design.md)). Then add it to [app.md](app.md); the UI tour picks it up from the sidebar.

### Add a tab to every project

```ts
registerProjectPanel({
  id: "notes", title: "Notes", section: "know", order: 70,
  badge: (ctx) => ctx.project.rollup.linked.note ?? null,
  render: (ctx) => <Notes projectId={ctx.project.id} />,
});
```

Register at module load and import the module once from `App.tsx`. `section` is one of `brief`, `build`, `ship` (shown in the tab row) or `improve`, `know` (under More). Link your things to the project with a `project.linked` event so the rollup counts them ([projects.md](projects.md)).

### Add a station or a check to the engine

1. A check that costs nothing (a scan, a test, a browser look) belongs in the core, in its own file under `factory/`, called from `loop.ts`. Make its result an event, and make a failure something the Fixer or the Builder can act on: say the file, the evidence and what to do.
2. A station that calls an agent needs a slot (`bay/agentfile.ts`), a default agent and an output contract (`bay/builtin.ts`), a call in `Run.go()` in `loop.ts` wrapped in `this.station(...)`, and a place in `restoreState()` so a resumed run knows it is done.
3. Give it a budget rule: a share of the run, a least amount below which it is skipped, and what happens when the money is not there. A run must always reach the build gate with what it has.
4. Show it: the stop on the Mission track (`projects/mission/model.ts`), a tab in the run deck (`RunDeck.tsx`), and a line in the engine review (`factory/retro.ts`).
5. Test it in `packages/core/test/engine.test.ts` with the mock runtime.
6. Write it into [engine.md](engine.md): the top section if it changes the pipeline, and a dated note saying which run showed the need.

The rule behind every engine change: an agent's mistake is a missing tool, document or check. Fix the engine so that kind of mistake cannot happen again; never fix the built app by hand.

### Add or change a built-in agent

Edit `packages/core/src/bay/builtin.ts`: the agent's own prompt says who it is; the station's contract says what format to answer in. Keep them apart, because the core parses the contract and people edit the prompt in the app. Skills an agent may load live in `packages/core/agent-skills/`; MCP servers offered to agents are in `packages/core/agent-mcp.json` and follow [mcp-safety.md](mcp-safety.md).

### Change the app kit

`packages/core/kit/` is the source. `npm run kit -w @sf/core` writes it into `factory/kitFiles.ts`, which is what a build installs. Every app built afterwards gets the new kit; shipped apps keep theirs until their next version.

### Add an add-on

No change to SF's code is needed: a folder with a `plugin.json` ([plugins.md](plugins.md)). Examples that ship with the app are in `packages/core/plugin-examples/`.

## Working rules

These come from Assaf's standing decisions for the project.

**How work reaches `main`**

- Work on SF goes through SF: file it as a ticket in SF's own project and let the crew return a branch or a draft pull request. Where SF cannot do a step yet, do the step directly and file a ticket for the gap.
- Never push to `main`. Every change is a pull request with green CI. Merges are done by the merging thread, not by Assaf.
- Use a separate clone for your work, never the checkout the installed app runs from.

**Judging the work**

- "Done" means usable in the installed Windows app, not green CI. Check your change in the installed app, or with your branch's Bridge against its core ([dogfood.md](dogfood.md)).
- A benchmark run tests the engine, not the app it builds. Report in engine terms: what each station and agent did well and badly, and which engine change follows.

**Money and data**

- A paid run needs the person's own words for it. Caps: $0.60 a ticket run, $3 a day, unless he names another amount for a named run.
- Never delete user data. Tests and tours use their own temporary data.
- Anything that changes the person's live data (archiving, merging projects, starting a paid run) waits for his go-ahead.

**What must not enter the repository**

- Code from Assaf's other, private apps.
- Keys and tokens: the updater key, GitHub tokens, API keys.
- A model's name in commit messages, pull request text or code comments.

**Writing**

- Text in the app and in documents is plain and concrete: say what happens and what to do. No raw JSON, argument conventions or internal ids asked of the person.
- A change in behaviour updates its document in the same pull request ([README.md](README.md) lists them).

## Where things are

| Path | What |
|---|---|
| `packages/core/src/` | The core, one folder per module |
| `packages/core/test/` | Core tests, one file per module; `engine.test.ts` for the run loop |
| `packages/core/kit/` | The app kit source |
| `packages/core/agent-skills/` | Skills agents may load |
| `packages/core/plugin-examples/` | Add-ons that ship with the app |
| `apps/bridge/src/` | The UI |
| `src-tauri/` | The desktop shell, installer hooks, updater |
| `scripts/` | The UI tour, the Windows smoke test, update manifest tools, the window screenshot for dogfooding |
| `examples/` | A sample conversation for the Order Engine; one app the factory built |
| `skills/visualize-everything/` | The visualizeEverything skill as a Claude Code skill |
| `docs/` | This folder |

## Adding a feature: its record comes with it

Every source file and API area belongs to a feature record in `packages/core/src/featuremap/records.ts`, and `npm test` fails when one does not. After adding or moving code: add or extend the record, run `npm run wiring -w @sf/core`, then `npm test`. Details: [feature-map.md](feature-map.md).
