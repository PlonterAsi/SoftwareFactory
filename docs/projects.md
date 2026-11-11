# Projects

SoftwareFactory is organized around **projects**. A project is the thing you work on: an app, a tool, a library, research. Everything else belongs to one project: its ideas and rules in the Order Engine, its factory runs, the agent calls those runs made, the files they wrote, and whatever later parts of the app add (tickets, improvement proposals).

## Model

| Table | One row per |
|---|---|
| `projects` | project: name, kind (`app`, `tool`, `library`, `research`, `general`, or your own), status (`active`, `paused`, `shipped`, `archived`), summary, origin, times |
| `project_links` | thing that belongs to a project: `(kind, ref)` → `project_id`. One owner per thing. |

Both are a projection (`packages/core/src/projects/`), folded from the event log like every other table, so they rebuild from the log at any time.

**Ids.** A project's id is an event id (an integer):
- made by you (Bridge or `POST /api/projects`): the `project.created` event's id;
- adopted from an Order Engine root node: that node's id;
- adopted from a factory run started without a project: the run's id.

Never assume a project id equals a node id; ask `projectOf(log, { kind, ref })` or `GET /api/projects/of?kind=&ref=`.

**Events.**

```
project.created  { name, kind?, summary? }
project.updated  { projectId, name?, kind?, summary?, status? }
project.linked   { projectId, kind, ref }     move a thing into a project
project.unlinked { projectId, kind, ref }
```

**Adoption (no data migration needed).** History from before projects existed is read as it is:
- every live Order Engine root node is a project of its own;
- a factory run started without a project is a project of its own, and the root node its intake Signal grows joins it;
- a run started with `projectId` joins that project, and so does its intake node;
- a root node merged into another by the Order Engine takes its project along;
- an adopted project with nothing left in it disappears; projects you made or renamed stay.

**Links are open.** The core fills `order_node` and `factory_run`. Any other part of the app links its own things with `project.linked { kind: "ticket", ref: "T-7" }`; the project's rollup counts them by kind. The child ideas and threads of a root node belong to the same project through the node tree.

## API

```
GET  /api/projects                    every project with its rollup (runs, shipped, failed, running, agent calls, spend, nodes, fragments, important, open conflicts, linked counts, last activity)
POST /api/projects                    { name, kind?, summary? }   also gives it an Order Engine root node, so ideas can be filed there
GET  /api/projects/of?kind=&ref=      which project owns a thing
GET  /api/projects/:id                links, node tree, runs, agents, files, facets
POST /api/projects/:id                { name?, kind?, summary?, status? }
POST /api/projects/:id/links          { kind, ref }
POST /api/projects/:id/unlink         { kind, ref }
POST /api/projects/:id/runs           { idea, maxUsd? }   start a factory run inside this project
```

`POST /api/factory/runs` also takes `projectId`.

## Extension points

- **Core facets**: `registerProjectFacet({ id, compute(log, project, links) })` adds a section to every `GET /api/projects/:id` under `facets[id]`.
- **Integrations**: a finished project can be added into SoftwareFactory as a tool, a panel, or a pull-request brief; see [integrations.md](integrations.md).
- **Bridge panels**: `registerProjectPanel({ id, title, order, render })` in `apps/bridge/src/projects/panels.tsx` adds a tab to every project's workspace. `appliesTo(project)` limits it to some kinds.

## On the Bridge

The Bridge opens on **Projects**: every project, most recently active first, with a hull bar of its runs (green shipped, cyan running, grey stopped, red failed), its notes, open conflicts, linked things and spend. Name a new one at the top, or press **Build it** in the Overseer: a build started outside a project becomes a project of its own.

![Projects](img/bridge-projects-home.png)

Opening a project shows its **workspace**: a rail of panels and the chosen panel. Built in: **Overview** (what it is for, a Build box that starts runs inside the project, its numbers, latest activity), **Run** (start the finished project from its folder, see its output and its pages; see [run.md](run.md)), **Ideas** (the project's own star map and Order deck), **Runs** (the factory floor with only this project's runs), **Agents** (who worked here and what it cost), **History**, **Settings** (name, kind, status, folders). While a project is open, the Overseer's Build it starts runs in that project.

![A project's overview](img/bridge-project-overview.png)

**Whole factory** in the top bar is the cross-project view from before (star map, factory floor, Agent Bay, Order deck, Data vault).

Addresses: `#/` projects, `#/p/12/runs/57` project 12's Runs panel showing run 57, `#/factory/bay` the Agent Bay. The old `#order`, `#bay`, `#data` still work.
