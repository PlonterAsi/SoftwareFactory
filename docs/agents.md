# Named agents

SoftwareFactory's workers are named specialists in the **Agent Bay** (SF behavior brief, phase 4,
2026-11-17). Each agent has its own skills, tools, model, cost cap and memory, and it is reused across
projects. Each flow step can name the agent that works it. The code is in `packages/core/src/bay/`
(`bay.ts`, `memory.ts`) and the screen is **Agents** (`apps/bridge/src/AgentBay.tsx`). Step picks are on
**Flows** (`apps/bridge/src/Flows.tsx`).

## Who works a step

Every flow step lists the crew slot that works it (`agents`, for example `build`). By default the
agent seated on that station in the Agent Bay works it.

A step can also name its own agents (`crew`, Agent Bay ids, in seat order). Then that specialist
works this step in this flow only. For example, a "React Builder" can work Build in Feature in a repo
while the plain Builder keeps Build everywhere else.

- **Setting it.** Pick a step on Flows, then choose who works it under **Who**. The flow is saved as
  its next version. A run follows the flow it started with, so the change applies to the next run.
- **Checks.** A flow is refused when a step names an agent the Bay does not have, when it names
  more agents than the station takes (the Council takes six, every other station one), or when it
  names agents on a step the core does with no agent.
- **Retired agents.** A named agent that is retired later does not stop a run. The station's own
  crew works the step instead.
- **Where it applies.** The engine (`factory/loop.ts`), one-session tickets (`tickets/repowork.ts`)
  and readers (`tickets/research.ts`) all honor it through `crewPick(flow, slot)` and
  `AgentBay.crewFor(slot, pick)`.

## Each agent's memory

An agent keeps short lessons from its own past work and carries them into every project. The newest
twelve go into its prompt on every call, between its own instructions and the station contract. The
lessons you taught come first, and the prompt holds at most 1,600 characters of lessons. A
one-session Reviewer, whose prompt is written for the repo, gets the same block in front.

Lessons come from four places, all free:

| Source | When |
| --- | --- |
| you taught it | you press Teach on the agent's Memory tab |
| it noted it | the agent ends an answer with a `Remember: ...` line (picked up in `agents.ts`; a Bay test run teaches nothing) |
| a review found it | a Reviewer sent its build back: the serious findings become lessons of the agent that built it (engine and one-session tickets, at most two per review) |
| cleaned | a lesson from a cleaning you accepted |

A repeat, or a lesson that shares four fifths of its words with one the agent already has, is not
noted again.

## Cleaning a memory

Cleaning works the way Claude Code's Auto Dream cleans its own memory: it merges, dedupes and prunes.

- **Tidy (free).** Removes repeats and near repeats (the newest copy stays), then the oldest lessons
  past 40. It never removes a lesson you taught. It runs by itself when a memory grows past 40.
- **Clean it up (dream).** One haiku call reads the whole memory and proposes a shorter one. Its cap
  is $0.10 unless you say otherwise, and $0.60 at most.
  - On the practice crew, or when the answer is unusable, the proposal is the free tidy. The proposal
    says which one you got.
  - The call never invents lessons. Lessons you taught stay word for word. Lessons the answer forgot
    to mention stay as they are.
- **Review before use.** A cleaning changes nothing until you accept it. The Memory tab shows each new
  lesson beside the ones it replaces, and what it would forget. Accepting replaces only the lessons
  the cleaning read; lessons noted since it started stay. Only one cleaning per agent waits at a time.

The official Dreams API comes later, with an API key. Switching billing to an API key is your
decision.

## Events and tables

| Event | Payload |
| --- | --- |
| `agent.memory.noted` | `{ agent, text, source, ref? }` (ref: `run:N`, `ticket:N`, `dream:N`) |
| `agent.memory.removed` | `{ agent, ids, why, by }` (by: you, auto, or the tidy) |
| `agent.memory.dream` | `{ agent, state: "proposed", saw, lessons, dropped, costUsd, by, error? }`, then `{ id, agent, state: "accepted" \| "rejected" }` |

These events fill the `memory` projection's tables:

- `agent_memory`: every lesson, with `removed_at` and `removed_why` once it is gone.
- `agent_dreams`: every cleaning and your decision on it.

## API

```
POST /api/bay/agents/:id/memory          { text }      teach a lesson
POST /api/bay/agents/:id/memory/forget   { ids }       forget lessons
POST /api/bay/agents/:id/memory/tidy                   the free tidy
POST /api/bay/agents/:id/memory/dream    { maxUsd? }   propose a cleaning (capped, $0.60 at most)
POST /api/bay/dreams/:id/accept | reject               decide on a cleaning
GET  /api/bay/state                                    includes memory (by agent) and dreams
PUT  /api/flows/:id                      { flow }      a step's `crew` names its agents
```
