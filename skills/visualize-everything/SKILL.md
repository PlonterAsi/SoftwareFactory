---
name: visualize-everything
description: Run at the end of every SoftwareFactory station, and whenever an agent produces something new, to make sure every step, process, computation, worker, agent and project has a live visual on the Bridge.
---

# visualizeEverything

SoftwareFactory rule: **nothing exists only as text.** If it runs, thinks, costs or changes, it has a picture someone can understand at a glance. A station is not done until this skill passes.

## When it runs

- As the last step of every station in every loop (the loop engine calls it before a station can be marked done).
- When any agent creates a new kind of thing: a project, an idea, a plan, a worker, a file, a test, a rule.

## Where it is enforced

In the factory loop the check is code: `packages/core/src/factory/visualize.ts` runs after every station and appends a `factory.visual` event. A station with a missing visual is marked incomplete and escalates; the Bridge's run deck lists every check.

In the Order Engine the same check runs for every Signal it files (`packages/core/src/order/engine.ts`, `visualCheck`): each new node has a body on the star map, each filed fragment a particle to its node, each tray fragment an asteroid, each touched Canon a constellation, each conflict a red link and a card. It appends an `order.visual` event; the Order deck's Visuals tab lists them.

In the Agent Bay the check runs after every change (`packages/core/src/bay/bay.ts`): each agent has a crew card (avatar, model, state, cost), each station its seats on the board, each test run a result card. It appends a `bay.visual` event. The Council and Review stations are checked like every factory station: the seats' takes around the table, the review's verdict card.

## What to check

For each thing the station produced, confirm a visual exists and is fed from the event log, so it stays live:

| Thing | Required visual |
| --- | --- |
| Project, idea, thread | A body on the star map (system, planet, moon), sized by activity, brightness by importance, dimming when stale |
| Signal, fragment | A star in the Unsorted belt, or a particle on its way to the node it was filed under |
| Rule, decision, conflict | A point in the node's Canon constellation; a conflict is a red link between two rules |
| Loop, station | A box on the factory floor with round count, pass or fail, and budget as a draining bar |
| Agent (worker) | A crew card: avatar, current task, state (idle, thinking, blocked), cost so far |
| Computation (agent call, tool run) | A pulse on the computation timeline: model, time, tokens, cost |
| Plan, spec | A task graph or flow diagram, not only a document |
| Code, tests | Changed files as a heat map; tests as a pass and fail grid |
| A finished project | Its own screen: `index.html` at the project root that the Run tab previews, held by the page check (`packages/core/src/factory/uicheck.ts`) like a failing test. A CLI comes only next to the page. |

## What to do when a visual is missing

1. Emit the event the Bridge needs (with the fields in the table above), so the existing view picks it up.
2. If no view exists for this kind of thing yet, produce a diagram (Mermaid or SVG) or a status card and attach it to the station's output.
3. If neither is possible, mark the station **incomplete: missing visual** and say what is missing. Do not pass silently.

## Output

A short checklist in the station's result:

```
visualizeEverything: PASS
- project "photo-renamer": star map body ✓
- plan: task graph ✓ (7 tasks)
- 3 agent calls: timeline pulses ✓
```

or `visualizeEverything: FAIL` with each missing item.

## How agents describe their own work

Every agent ends its output with a `visual` block the Bridge can draw: what it did (one line), state, inputs and outputs as nodes, and cost. Keep it small; the Bridge does the drawing.
