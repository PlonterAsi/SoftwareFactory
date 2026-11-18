/**
 * The feature records: one per feature of SoftwareFactory, written once, next to the code.
 *
 * A record says what the feature is for (purpose), what it must do (spec), how it moves (flow), where
 * it lives on screen (design), which documents describe it, which stations' agents use it, and which
 * source files and API areas are its own. Everything else on the Feature map (what it calls, what
 * calls it, the events and tables it shares, when it last ran) is worked out from the code and the
 * event log, never written here.
 *
 * The rule (test/featuremap.test.ts, run by `npm test` and so by every build): every source file and
 * every API area belongs to a record, and every record is complete. A new feature without its record
 * does not ship.
 */
export type FeatureGroup = "Engine" | "Agents" | "Order" | "Projects" | "Work" | "Library" | "App" | "Foundation";
export const FEATURE_GROUPS: FeatureGroup[] = ["Engine", "Agents", "Order", "Projects", "Work", "Library", "App", "Foundation"];

export interface FeatureRecord {
  id: string;
  name: string;
  group: FeatureGroup;
  /** Why it exists, in one or two sentences. */
  purpose: string;
  /** What it must do: one requirement per line. */
  spec: string[];
  /** How it moves: the steps, in order. */
  flow: string[];
  /** Where it lives in the app and how it shows itself. */
  design: string;
  /** Addresses of its screens (the part after #), empty when it has no screen of its own. */
  screens: string[];
  /** Documents that describe it, as paths in the repository. */
  docs: string[];
  /** Stations whose agents work in it or read it. */
  stations: string[];
  /** Source it owns: a folder (ending in /) or a file. The longest match owns a file. */
  files: string[];
  /** API areas it answers, like /api/brain. */
  api: string[];
}

const C = "packages/core/src/";
const B = "apps/bridge/src/";

export const DEFAULT_FEATURES: FeatureRecord[] = [
  // ───────────────────────────── Engine
  {
    id: "flows", name: "Flows (the engine as data)", group: "Engine",
    purpose: "The engine's work is a stored flow definition, not fixed code: its steps in order, which are loops and what ends them, where it stops for the person, and which crew slot works each step. Runs follow the flow they started with, and the canvas draws the same definition.",
    spec: [
      "Today's engine is the built-in New project flow; imported repositories follow the built-in Feature in a repo flow. Both do exactly what the fixed pipeline did.",
      "Every run keeps a copy of its flow on its started event, so an edit never changes a run already going, and a resume follows the same flow.",
      "A flow is checked before it is saved or run: every step names an engine action the engine has, required steps are present and in an order that works, agents are crew slots, loop limits stay in range.",
      "Every save is a new version on the record; a flow can be put back to what SoftwareFactory ships.",
      "The engine reads the round limits of the council, design and judge loops from the flow; optional steps (council, design, review, judge) can be left out.",
      "The factory floor and the project's track are drawn from the run's flow.",
      "A library, one flow per kind of work: New project and Feature in a repo run on the engine; Bug fix, Small change and Refactor are one Builder session; Research or question is answered by a reader and changes nothing; Import, Improve and Release are drawn as carried out by their own screens.",
      "A ticket follows the flow of its kind unless the person picks another on the ticket; a session flow's steps, fix round limits and brief are what the Builder session does.",
      "A step may name the Agent Bay agent that works it (a specialist for this flow only); the engine, Builder sessions and readers give that step to it, and to the station's crew when it is retired.",
    ],
    flow: ["A run starts and copies its flow onto its started event", "The engine carries out each step by its action, in the flow's order", "A resume skips the steps whose milestone the log shows", "The canvas draws the flow's steps and lines and lights them from the run's events"],
    design: "The factory floor on All builds and the track on a project's Mission tab draw the run's flow; the Flows page lists the flows and shows each one's steps, loops, gates and agents.",
    screens: ["/factory/flows"], docs: ["docs/engine.md", "docs/flows.md"], stations: [],
    files: [`${C}flows/`, `${B}Flows.tsx`, `${B}flowData.ts`], api: ["/api/flows"],
  },
  {
    id: "check-before-money", name: "Check before money", group: "Work",
    purpose: "Before a ticket costs anything, SF reads it for clarity, confidence and decisions only the person makes, and asks those questions in one batch instead of finding out half way through a paid run.",
    spec: [
      "Plain code over the ticket's words: free, instant, and each question says why it is asked.",
      "Clarity: enough words to build from, the kind's first question answered, what right looks like for a bug.",
      "Confidence: no open words left (maybe, something), and not more than one session's work on a session flow.",
      "Your call: money, data that could be lost, secrets and accounts, going public, legal terms.",
      "Work it and the crew's own pickups run the check first; the person can answer, or work it anyway. Answers go on the ticket's record and thread.",
      "Every question across tickets is answered in one sitting on Home, and the clear tickets start from there.",
    ],
    flow: ["The person presses Work it, or the crew picks up a ready ticket", "The check reads the ticket", "Questions go to Needs you and the ticket's timeline", "The person answers them in one batch", "The tickets that are clear start"],
    design: "A Before it costs money box on the ticket page, and Answer before money on Home with every question across tickets.",
    screens: ["/", "/factory/tickets"], docs: ["docs/tickets.md"], stations: [],
    files: [`${C}tickets/precheck.ts`], api: [],
  },
  {
    id: "git-manager", name: "Git manager", group: "Work",
    purpose: "SoftwareFactory runs git for every project: a new project stays on this computer until it is worth continuing, then gets a private repo; crew PRs are merged by a policy with a confidence review; work done outside SF joins tickets; merged tickets become versions with release notes.",
    spec: [
      "Local first: Continue (or Publish at any time) makes a private GitHub repo and sends the project's code there; Park pauses it and Drop archives it, each with its reasons.",
      "Every crew PR gets a free confidence review when its CI ends: CI, SF's own review and tests, size, sensitive files, decisions only the person makes, and taste.",
      "Each project starts on ask: a PR that passed CI waits on Needs you with its review. After three right merges in a row SF offers auto, where it merges a confident PR by itself. A merge marked not right puts the project back on ask.",
      "Outside work: a PR or commit that names a ticket joins it; any other becomes a ticket that says it was made outside SF. The first look at a repo only remembers where it stands.",
      "Versions: the merged tickets since the last version, release notes written from them, a GitHub release (or a tag in the local folder), and a version timeline on the project.",
    ],
    flow: ["A project is built on this computer", "The person presses Continue or Publish", "The crew opens PRs; CI ends; SF reviews each", "The person merges, or SF merges under auto", "The person cuts a version"],
    design: "A Git tab on each project (where the code lives, verdict, merge policy, versions), Merge cards on Home's Needs you, and a merge box on the ticket page.",
    screens: ["/", "/factory/tickets"], docs: ["docs/git.md"], stations: [],
    files: [`${C}git/`, `${B}projects/GitPanel.tsx`], api: ["/api/git"],
  },
  {
    id: "home-board", name: "Home board", group: "Work",
    purpose: "The first screen: every ticket across projects in four lanes (Needs you, Running, In review, Done), Needs you first, beside a live drawing of the flow of what is running now.",
    spec: [
      "Needs you holds questions before money, runs waiting for an OK, builds to look at, questions to answer and ideas to decide.",
      "Running shows each ticket's flow and the step it is on; In review holds tickets with an open draft PR; Done holds the last two weeks.",
      "The live drawing lights the selected running ticket's flow: an engine run from its own events, a one-session ticket from its last step.",
    ],
    flow: ["The person opens SoftwareFactory", "Home reads the board", "The person answers what needs them or opens a ticket", "The board updates as events arrive"],
    design: "Home (#/): a live flow canvas above four lanes; the projects list moved to Projects (#/projects).",
    screens: ["/"], docs: ["docs/tickets.md"], stations: [],
    files: [`${B}Board.tsx`], api: [],
  },
  {
    id: "engine-loop", name: "Engine run loop", group: "Engine",
    purpose: "Turns one line into a shipped, tested app by walking it through the stations in order, inside money and time limits, stopping for the person only at the two gates.",
    spec: [
      "A run starts from one line and goes intake, council, design, plan, gate A, tests, build, test and fix, review, judge, gate B, ship.",
      "Every station writes what it did to the event log, so the run can be drawn and resumed.",
      "A run stops when its budget, its time limit or a stop rule says so, and says why.",
      "A run resumes after a crash, a close or an update, up to three times by itself.",
      "A send-back at a gate is carried out and survives a restart.",
    ],
    flow: ["The person presses Build it", "The run opens a project folder with git", "Each station calls its agents through the crew", "Gate A waits for the plan's approval", "Build, test and fix loop until checks pass or a stop rule fires", "Gate B waits for acceptance", "Ship commits, tags and writes the engine review"],
    design: "Shown as the factory floor on All builds (stations lit per run), the run deck with a tab per station, the timeline of agent calls, and the approval bar at each gate.",
    screens: ["/factory"], docs: ["docs/engine.md", "docs/flows.md", "docs/loop-engineering.md"],
    stations: ["council", "design", "critique", "plan", "tests", "build", "review", "evaluate", "fix"],
    files: [`${C}factory/loop.ts`, `${C}factory/stoprules.ts`, `${C}factory/crew.ts`, `${C}factory/workspace.ts`, `${C}factory/workbench.ts`, `${C}factory/trim.ts`, `${C}factory-cli.ts`, `${B}FactoryFloor.tsx`, `${B}RunDeck.tsx`, `${B}Timeline.tsx`, `${B}DuplicateNotice.tsx`],
    api: ["/api/factory"],
  },
  {
    id: "council", name: "Council", group: "Engine",
    purpose: "Three to six seats read an idea before anything is planned and vote to build, reshape or drop it, so a weak idea is caught before money is spent on it.",
    spec: ["Seats vote build, reshape or drop, in up to two rounds.", "Round two shows each seat the others' takes.", "The takes are merged into one brief by plain code.", "A small job (14 words or fewer, one ask) skips the Council."],
    flow: ["The idea reaches the council station", "Each seat answers with a vote and a take", "Seats read each other and answer again", "The brief is written to the log", "A majority drop asks the person once"],
    design: "The Council tab of the run deck draws the round table: each seat, its vote and its take, and the brief.",
    screens: ["/factory"], docs: ["docs/engine.md"], stations: ["council"],
    files: [`${C}factory/council.ts`], api: [],
  },
  {
    id: "design-loop", name: "Design loop (discovery)", group: "Engine",
    purpose: "Turns one line into a designed product (brief, journeys, screens, requirements, rules) before anything is planned, with a Critic scoring every round.",
    spec: ["A research call gathers what the idea needs first.", "The Designer writes the product documents; the Critic scores coverage, journey, screens, originality and buildable.", "The loop passes when all five scores are 4 or more, and stops after 3 rounds or 35% of the budget.", "The documents are written into the project as docs/product/*.md."],
    flow: ["Research", "The Designer writes the documents", "The Critic scores them", "The Designer revises", "The best-scored documents go on to the plan"],
    design: "The project's Product tab and the run deck's Product tab show each round's documents and the Critic's scores.",
    screens: ["/p/ID/product"], docs: ["docs/engine.md", "docs/flows.md"], stations: ["design", "critique"],
    files: [`${C}factory/discovery.ts`], api: [],
  },
  {
    id: "build-loop", name: "Build loop (feature by feature)", group: "Engine",
    purpose: "Builds the app as a list of features, one per fresh agent session, with checks and a commit after each, so no single call has to write a whole app.",
    spec: ["The feature list is worked out from the approved plan by the core, with no agent call.", "Each feature is built in a fresh session, checked and committed.", "Only the core writes features.json and PROGRESS.md.", "Used on the real crew for runs of $3 or more; smaller runs build in one call."],
    flow: ["The plan becomes a feature list", "The Builder builds one feature", "Tests, schema, links and the screen are checked", "A commit is made", "The next feature starts from the progress note"],
    design: "The Build tab of the run deck shows one row per feature with its state and the tests passing after it.",
    screens: ["/factory"], docs: ["docs/engine.md", "docs/loop-engineering.md"], stations: ["build"],
    files: [`${C}factory/features.ts`], api: [],
  },
  {
    id: "checks", name: "Checks and harness steps", group: "Engine",
    purpose: "Free checks in plain code that hold every build to the truth: the tests load, every screen draws in a real browser, every link opens, no secret is written, locked tests are not weakened.",
    spec: ["Tests are tried in a dry run before they are locked.", "Fast checks (syntax, types, lint, secrets) run after every build or fix.", "Every screen is opened in a real browser; without a browser the check is skipped, not passed.", "Every link the app ships is opened.", "A change that weakens a locked test is reported.", "Each station's output must have a visual (visualizeEverything)."],
    flow: ["A build or fix finishes", "Fast checks run", "The whole test suite runs", "Screens and links are opened", "Failures go to the Fixer with trimmed output"],
    design: "The Tests, Loop and Visuals tabs of the run deck show each check per round; fast checks appear in the Loop tab.",
    screens: ["/factory"], docs: ["docs/engine.md", "docs/screens.md"], stations: ["tests", "fix", "review"],
    files: [`${C}factory/testcheck.ts`, `${C}factory/screencheck.ts`, `${C}factory/uicheck.ts`, `${C}factory/linkcheck.ts`, `${C}factory/visualize.ts`, `${C}safety/`],
    api: [],
  },
  {
    id: "app-kit", name: "App kit and app check", group: "Engine",
    purpose: "Makes everything the factory builds a real program: a server, a data store, navigation and full create, edit and delete for every entity, with a check that proves it.",
    spec: ["Every built app stands on the kit: server.js, a data layer, a web shell and a System view.", "The app check proves create, edit and delete on every entity, no command-line arguments and no JSON boxes.", "The app starts with one press and opens with sample records.", "Every feature of a built app has its record in src/schema.js (name, purpose, flow, where); the app check refuses one without it.", "The kit in the repository and the copy the core carries always match."],
    flow: ["The plan is marked as an app", "The kit is installed into the project", "The crew writes the schema, the logic and the views", "The app check runs at every test round"],
    design: "Seen inside each built app: its own screens first, entity lists under Manage, and a System view of entities, flows, features, activity, data and code.",
    screens: [], docs: ["docs/apps.md", "docs/screens.md"], stations: ["plan", "build", "fix", "review"],
    files: [`${C}factory/appkit.ts`, `${C}factory/kitFiles.ts`], api: [],
  },
  {
    id: "app-agents", name: "App agents", group: "Engine",
    purpose: "Lets an app the factory built ask one of the person's agents for work it cannot do itself, inside a cap.",
    spec: ["A built app can ask an agent through the core.", "Each call is capped and recorded like any other agent call."],
    flow: ["The built app asks", "The core picks the agent and runs the call", "The answer returns to the app"],
    design: "No screen of its own; the calls appear in the timeline of agent calls.",
    screens: [], docs: ["docs/apps.md"], stations: [],
    files: [`${C}factory/appagent.ts`], api: ["/api/apps"],
  },
  {
    id: "judge", name: "Product judge", group: "Engine",
    purpose: "A separate agent looks at the running app the way its user would and scores it against the requirements, so a build that passes its tests but misses the product is caught.",
    spec: ["The judge reads every screen's text and controls and marks each must-have requirement as seen or not.", "What is not met is built as repair features, then judged once more.", "Gate B names what is still open."],
    flow: ["The app is started", "The judge looks at each screen", "Requirements are marked seen or not met", "Repair features are built", "The judge looks again"],
    design: "The Judge tab of the run deck lists each requirement as seen or not, with the product scores.",
    screens: ["/factory"], docs: ["docs/engine.md"], stations: ["evaluate"],
    files: [`${C}factory/evaluate.ts`], api: [],
  },
  {
    id: "repo-engine", name: "Engine in an imported repo", group: "Engine",
    purpose: "Runs the whole engine in a codebase SoftwareFactory did not write, so a feature for an imported repo is designed, planned, built, reviewed and judged like a feature of an app the factory built, on a branch of a clone and never on the main line.",
    spec: [
      "The run works in a clone of the repo on a branch of its own; the repo's main line and the person's working copy are never written to.",
      "SoftwareFactory's notes (plan, design, feature list, Python environment) live under .sf/ in the clone, which git leaves out.",
      "The Designer designs the change from the code map, the Critic judges it, and the Planner splits it into features in the repo's own stack.",
      "The repo's own tests are run before anything changes: what passed must keep passing, what already failed is not held against the run.",
      "The judge reads the pages of the running site when it can be started here, and says so plainly when it cannot.",
      "The branch is handed over as a draft pull request when GitHub access allows, else it waits in the clone with the command that takes it.",
    ],
    flow: ["A feature-sized ask or ticket in a repo project is routed to the engine", "The repo is cloned on a new branch and its tools are set up", "The change is designed and criticised", "The plan waits for the person at the plan gate", "The repo's tests are run as the baseline", "Each feature is built in its own session, with the tests after each", "The Reviewer runs the acceptance criteria", "The judge reads the running site", "The person accepts at the build gate", "The branch becomes a draft pull request"],
    design: "A run like any other on the run deck, with the repo and branch on its header; started from a ticket's Work it on the engine or from the idea box of a project that lives in a repo.",
    screens: ["/factory", "/factory/tickets"], docs: ["docs/engine.md", "docs/tickets.md"], stations: ["design", "critique", "plan", "build", "fix", "review", "evaluate"],
    files: [`${C}factory/reporun.ts`, `${C}factory/repoenv.ts`], api: [],
  },
  {
    id: "engine-review", name: "Engine review and cycles", group: "Engine",
    purpose: "Every run ends with the engine's review of its own work, and runs of the same prompt are compared side by side, so the engine itself can be improved from evidence.",
    spec: ["The review is written by the core from events, with no agent call.", "Runs of the same prompt are shown as columns: version, scores, money, minutes, review."],
    flow: ["A run ends", "The core folds its events into a review", "The review is logged", "Engine cycles lines it up with earlier runs of the same prompt"],
    design: "The Engine tab of the run deck, and the Engine cycles page with one column per run.",
    screens: ["/factory/cycles"], docs: ["docs/engine.md", "docs/flows.md"], stations: [],
    files: [`${C}factory/retro.ts`, `${C}factory/cycles.ts`, `${B}Cycles.tsx`], api: [],
  },

  // ───────────────────────────── Agents
  {
    id: "agent-runtime", name: "Agent runtime and crew mode", group: "Agents",
    purpose: "The one door to agents: runs each call on Claude Code or on the free practice crew, with a cap, a timeout and its cost recorded.",
    spec: ["Every agent call goes through the runtime adapter.", "Each call has a money cap and a timeout, and its cost is recorded.", "The person switches between the practice crew (free) and the real crew.", "Setup checks for Node.js, Claude Code and Git and says the one thing to do when one is missing."],
    flow: ["A station asks for a call", "The runtime starts the agent with its prompt and kit", "The result and the cost are logged", "A failed call is retried within limits"],
    design: "The crew chip in the sidebar, and the Systems drawer (Crew, This computer, Where things land).",
    screens: [], docs: ["docs/architecture.md", "docs/spike-runtime.md"], stations: [],
    files: [`${C}runtime.ts`, `${C}agents.ts`, `${C}setup.ts`, `${B}Setup.tsx`],
    api: ["/api/agent", "/api/setup", "/api/cost", "/api/open"],
  },
  {
    id: "agent-bay", name: "Agent Bay", group: "Agents",
    purpose: "Where the workers are made and managed: create, edit, version, test and assign agents to station seats, each with only the skills and tools it lists.",
    spec: ["An agent is a file with a name, a model, a cap per call, plugins, skills, tools, MCP servers and a prompt.", "Every save is a version, with diff and rollback.", "An agent can be tested on a sample task before it is assigned.", "Stations have seats; an agent is assigned to seats.", "Each agent loads only the skills and MCP servers it lists."],
    flow: ["Create an agent from one line or a file", "Edit and test it", "Assign it to a station seat", "The engine binds it to the station's contract on each call", "Its calls, cost and verdicts add to its stats"],
    design: "The Agents page: a crew card per agent (avatar, state, current task, cost), the editor with versions, the test bench and the seat map.",
    screens: ["/factory/bay"], docs: ["docs/architecture.md", "docs/mcp-safety.md"], stations: [],
    files: [`${C}bay/`, `${B}AgentBay.tsx`], api: ["/api/bay"],
  },
  {
    id: "flow-improve", name: "Flows that improve themselves", group: "Engine",
    purpose: "A change to a flow is first a proposal, from the person's words or from what SF reads in the flow's past runs. It is replayed on those runs before anyone uses it, tried once live, and becomes the flow only when the person accepts it.",
    spec: [
      "A change in words becomes operations on the flow: leave a step out, bring one back, a loop's round limit, who works a step, words for the crew. The practice crew reads the words with plain rules; the real crew with one capped haiku call ($0.05).",
      "Every proposal is replayed on the flow's past runs from what they recorded: what each would have cost, and where it would have let a problem through or stopped before passing. What the past cannot price is said.",
      "SF proposes on its own, free, every 5 minutes: one more round for a loop that keeps running out, and leaving out an optional step that cost money and never caught anything.",
      "Try it once: the next run of the flow follows the proposal, within that run's own limit, and its outcome and cost are recorded. Trial runs never count as past runs of the flow.",
      "Accepting saves the proposal as the flow's next version; a proposal whose flow changed since is refused.",
    ],
    flow: ["Say a change, or SF proposes one", "It is replayed on past runs", "Try it once on the next run", "Accept or reject it"],
    design: "Improve this flow, under each flow on the Flows page: a words box, Ask SF for ideas, and a card per proposal with its changes, its replay run by run, the trial, and Accept or Reject.",
    screens: ["/factory/flows"], docs: ["docs/flows-improve.md"], stations: [],
    files: [`${C}flows/improve.ts`, `${C}flows/improver.ts`], api: [],
  },
  {
    id: "agent-memory", name: "Agent memory and cleaning", group: "Agents",
    purpose: "Each agent keeps its own memory of lessons from its past work and carries it into every project: the lessons go into its prompt on every call, and the memory is cleaned the way Claude Code's Auto Dream cleans its own, with the person accepting each cleaning before it is used.",
    spec: [
      "Lessons come from the person (Teach), from the agent's own Remember: lines, and from a review that sends its build back.",
      "The newest twelve lessons, the person's first, go into the agent's prompt between its own instructions and the station contract.",
      "A repeat or near repeat is never noted twice; past 40 lessons a free tidy removes repeats and the oldest, never one the person taught.",
      "A cleaning (dream) is one capped haiku call, $0.10 unless the person says, at most $0.60; on the practice crew it is the free tidy. It is shown before and after, and changes nothing until the person accepts it.",
      "Everything is an event: no lesson is lost from the record, and accepting a cleaning keeps the lessons noted since it started.",
    ],
    flow: ["An agent works, is reviewed, or is taught", "The lesson is added to its memory", "Its next call carries the lesson", "The person cleans the memory and accepts the result"],
    design: "A Memory tab on each agent in the Agent Bay: the lessons with where each came from, Teach, Forget, Tidy, and a cleaning to review side by side.",
    screens: ["/factory/bay"], docs: ["docs/agents.md"], stations: [],
    files: [`${C}bay/memory.ts`], api: [],
  },
  {
    id: "watchers", name: "Watchers", group: "Work",
    purpose: "Scheduled looks at each project that only open tickets: code debt, security, dependencies and flaky tests. They never change code, start the crew or spend money.",
    spec: [
      "Four watchers per project, each on its own schedule (security and flaky tests daily, debt and dependencies weekly, as shipped), each with an on/off switch.",
      "Every look is plain code: the project's folder (long files, TODO piles, secrets and risky code, a .env git does not ignore, npm audit and unpinned Python packages) or its builds' test records (a test that passed and then failed again in one build, in two builds).",
      "A finding becomes an open ticket, once: each has a fingerprint, so the same finding is never filed twice. A look files at most five; the rest wait for the next look.",
      "A ticket a watcher opens is open, not ready, so the crew does not pick it up until the person makes it ready. A secret's value is never copied into a ticket.",
    ],
    flow: ["A watcher's time comes round", "It looks at the folder or the records", "Each new finding opens one ticket", "The person makes the ones worth doing ready"],
    design: "A Watchers tab on each project (Improve): one card per watcher with its switch, how often it looks, Look now, its last look and the tickets it opened.",
    screens: ["/p/ID/watchers"], docs: ["docs/watchers.md"], stations: [],
    files: [`${C}watch/watchers.ts`, `${C}watch/routes.ts`], api: ["/api/watchers"],
  },
  {
    id: "scout", name: "Scout (AI engineering scout)", group: "Work",
    purpose: "A project's daily look for AI engineering worth knowing (skills, plugins, MCP servers, mods, agents, prompts, tips, and the pages and people worth following): each find analyzed, rated, the best tried in a throwaway sandbox, and advised use, adapt, build our own or skip.",
    spec: [
      "Gathering is plain code and free: GitHub search, Hacker News, Reddit, RSS and Atom feeds (YouTube channels too), and awesome lists (only links added since the last read). Sites that need a sign-in (Instagram, Facebook, much of X) come in through the link inbox.",
      "The same thing found twice is one find (one key per address). A look adds at most 60 new finds, strongest first; the inbox is read first.",
      "The Analyst (a cheap model) reads each picked find and scores token efficiency, best practice, productivity, security and upkeep from 1 to 5 with reasons, and gives a category, a verdict, where it helps, an estimate and a risk level. A find scored 2 or less on security is never use.",
      "Risk comes from what is known (know-how is read-only; a repo with few stars, or new, or archived is high); the Analyst may only raise it.",
      "Every paid call is charged to the Scout project, so its monthly budget holds it: with less than five cents left, a look gathers and stops.",
      "The best finds of the week (a set number) are queued for the sandbox; high risk waits for the person's click.",
      "A sandbox trial downloads the code, scans it (install scripts, download-and-run, binaries, encoded code, credential reading, webhooks, secrets), makes a throwaway WSL machine with no Windows drives and no Windows programs, lets the Tester run use cases only inside it from outside, and removes the machine.",
      "A rated find that meets an auto-file rule becomes a ticket on the project the settings name; the rest wait for one press. The person's verdict wins over Scout's.",
    ],
    flow: ["Its day comes round", "Plain code gathers new finds", "The Analyst rates the strongest", "The best go to the sandbox (high risk waits for a click)", "Rules file tickets, the rest wait for a press"],
    design: "A Scout tab on a project (Improve) with the catalog (filters by category, verdict, trial; each find's scores, verdict, trial and buttons), the link inbox, the follow list, settings and the week; a Scout card on Home with today's finds and what waits for a click.",
    screens: ["/p/ID/scout", "/"], docs: ["docs/scout.md"], stations: [],
    files: [`${C}scout/`, `${B}projects/scoutPanel.tsx`], api: ["/api/scout"],
  },
  {
    id: "autofile", name: "Auto-file rules", group: "Work",
    purpose: "The person's settings for which suggestions become tickets by themselves (time, cost, severity, verdict, score, risk, category), and which of those are made ready for the crew.",
    spec: [
      "A suggestion that meets every condition of a rule that is on is filed; a condition the suggestion has nothing for does not match.",
      "Scout hands every rated find to the rules; the watchers hand every ticket they open, and a matching rule can make it ready.",
      "Rules are saved whole and checked; the list as shipped files quick, cheap, safe finds to use, not ready.",
    ],
    flow: ["Set the rules", "A suggestion arrives", "The first rule it meets files it (and may make it ready)", "Everything else waits for a press"],
    design: "An Auto-file rules card on the Scout tab: one row per rule with its switch and conditions.",
    screens: ["/p/ID/scout"], docs: ["docs/scout.md"], stations: [],
    files: [`${C}tickets/autofile.ts`], api: ["/api/autofile"],
  },
  {
    id: "monthly-budgets", name: "Monthly budgets and burn rate", group: "Projects",
    purpose: "A monthly budget for each project and one for everything, read from the agent calls actually paid, with the burn rate and where the month ends at that rate. The crew's queue fits them.",
    spec: [
      "Each paid agent call is charged to the project it was made for (its ticket's, its build's, or the one it names); the rest counts toward the overall month only.",
      "The burn rate is the average spend per day over the last seven days; the month's end is projected from it, with the day the budget runs out when that is sooner.",
      "On the real crew, a ready ticket waits in the queue while its month has less left than one start may spend, and says so; it starts by itself when money is there again (the new month, or a higher budget).",
      "A start the person presses gets no more than the month has left, and is refused when nothing is left.",
    ],
    flow: ["Set a monthly budget", "Every paid call counts against it", "See the burn rate and where the month ends", "The queue waits when the month runs low"],
    design: "This month at the top of each project's Money tab (budget, spent, burn per day, where the month ends, a bar per day) and, for all projects, a strip on Home.",
    screens: ["/p/ID/money", "/"], docs: ["docs/watchers.md"], stations: [],
    files: [`${C}watch/spend.ts`], api: ["/api/budget"],
  },
  {
    id: "brain", name: "Brain (principles)", group: "Agents",
    purpose: "SoftwareFactory's principles, written once and put in front of every agent's instructions on every call, so a rule about what the factory makes is said in one place and followed everywhere.",
    spec: [
      "A principle names the stations whose agents must follow it.",
      "Every agent call's instructions are: the agent's own prompt, the Brain's principles for its station, then the station contract.",
      "The person can add, edit, turn off, reset and remove principles; every change is an event.",
      "The Brain shows proof of use: how many agent calls read each principle and when the last one was.",
      "The Brain shows its own history of changes.",
      "Rules and decisions the person wrote in Rules and ideas are offered to the Brain, to add with one press.",
    ],
    flow: ["A principle is added or changed (by the person, or from one of their rules)", "The change is logged as an event", "The next agent call on a named station reads it", "The Brain counts the call as a read", "Checks in code hold builds to the built-in principles"],
    design: "The Brain page: a use strip (reads and changes), a card per principle with its stations, its checks and its reads, suggestions from the person's rules, the station by principle matrix, the exact instructions an agent reads now, and the history.",
    screens: ["/brain"], docs: ["docs/apps.md", "docs/feature-map.md"],
    stations: ["council", "design", "critique", "plan", "tests", "build", "review", "evaluate", "fix", "improve", "overseer", "survey"],
    files: [`${C}brain/brain.ts`, `${C}brain/routes.ts`, `${C}brain/learn.ts`, `${B}Brain.tsx`], api: ["/api/brain"],
  },
  {
    id: "recall", name: "Recall of the person's words", group: "Agents",
    purpose: "A full-text index over what the person already said, so the Council and the Planner build on past notes and decisions instead of rediscovering them.",
    spec: ["Notes, filed fragments, tickets, plans, Council decisions and proposals are indexed from the event log.", "A new build recalls only the person's own words, so a new version never descends from old plans."],
    flow: ["An event with text is logged", "It is added to the index", "A run starts", "The top matches for the idea are put in the Council's and the Planner's prompt"],
    design: "No screen of its own; what was recalled is logged with the run.",
    screens: [], docs: ["docs/engine.md", "docs/storage.md"], stations: ["council", "plan"],
    files: [`${C}brain/recall.ts`], api: [],
  },

  // ───────────────────────────── Order
  {
    id: "order-engine", name: "Order Engine (rules and ideas)", group: "Order",
    purpose: "Brings order to messy, parallel thinking: cuts what the person writes into fragments, files each under the right project, idea or thread, keeps the rules (the Canon) and finds conflicts between them.",
    spec: ["A note is cut into fragments: rule, decision, idea, task, question, note or noise.", "Each fragment is filed on a node of the tree; unsure ones wait in the Unsorted tray.", "Rules and decisions on a node and its ancestors are its Canon.", "Conflicts are resolved by fixed precedence (the person's words, the more specific node, newer, important), or a conflict card asks.", "A sweep cleans old data, with undo."],
    flow: ["The person captures a note", "The Archivist proposes how to cut and file it", "The engine files it and checks it against the Canon", "A conflict is resolved by precedence or shown as a card", "The briefing says what changed"],
    design: "Rules and ideas: the star map of projects, ideas and threads, and the Order deck with the Canon, the Unsorted tray, conflict cards and the briefing. Each project has the same view on its Ideas tab.",
    screens: ["/factory/order", "/p/ID/ideas"], docs: ["docs/flows.md", "docs/history.md"], stations: ["order"],
    files: [`${C}order/`, `${C}order-cli.ts`, `${C}signals.ts`, `${B}StarMap.tsx`, `${B}OrderDeck.tsx`],
    api: ["/api/order", "/api/signals"],
  },
  {
    id: "capture", name: "Capture, drop folder and settings", group: "Order",
    purpose: "Ways to get a thought in without opening a project: a note typed anywhere, or a text file saved into the drop folder, plus the small settings the app remembers.",
    spec: ["A .txt or .md file saved in the drop folder is filed as a note.", "A file is filed once; a file that cannot be read is skipped with a reason.", "App settings (crew mode, drop folder) are events, like everything else."],
    flow: ["A file lands in the drop folder", "The core reads it", "It is captured as a note", "The Order Engine files it"],
    design: "The Systems drawer shows the drop folder with Open and Copy path; filed drops appear in the Assistant.",
    screens: [], docs: ["docs/architecture.md", "docs/storage.md"], stations: [],
    files: [`${C}bridge/drop.ts`, `${C}bridge/tables.ts`], api: [],
  },
  {
    id: "assistant", name: "Assistant, chats and the Helm", group: "Order",
    purpose: "The place to talk to the factory: capture a note, ask what is going on, or start a build, in a General chat or one chat per project, or from one line anywhere with Ctrl K.",
    spec: ["Capture files a note for free.", "Ask is answered by the Overseer from a live status digest, inside a cap.", "Build it starts a run.", "Each project has its own chat, next to a General chat.", "A Since you left card says what happened after 10 minutes away."],
    flow: ["The person types one line", "Capture, Ask or Build it", "The line is filed in the chat it belongs to", "Gates waiting are said here with a Show me button"],
    design: "The Assistant panel on the right of every screen (Ctrl J), and the Helm (Ctrl K).",
    screens: [], docs: ["docs/app.md", "docs/projects.md"], stations: ["overseer"],
    files: [`${C}bridge/status.ts`, `${C}chat/`, `${B}Overseer.tsx`, `${B}shell/Helm.tsx`],
    api: ["/api/chat", "/api/since", "/api/presence"],
  },

  // ───────────────────────────── Projects
  {
    id: "projects", name: "Projects", group: "Projects",
    purpose: "The top-level thing the person works on. Everything else (ideas, builds, tickets, agents, money) hangs from a project and is seen in its own workspace.",
    spec: ["A project has a name, a kind, a status and a summary.", "Builds, ideas, tickets and imports are linked to a project.", "Two live projects may not share a name; duplicates can be merged.", "A project can be archived.", "Tabs come from a registry, so any feature or add-on adds a tab."],
    flow: ["Create a project, or start a build that makes one", "Open its workspace", "Work in its tabs", "Archive it or merge it into another"],
    design: "The Projects page with a card per project, and one project's workspace: a header and a row of tabs (Mission, Product, Use, Ideas, Builds, Money, Tickets, Agents, Integrate, More).",
    screens: ["/", "/p/ID"], docs: ["docs/projects.md", "docs/app.md"], stations: [],
    files: [`${C}projects/`, `${B}projects/`], api: ["/api/projects"],
  },
  {
    id: "mission", name: "Mission and plan view", group: "Projects",
    purpose: "Shows a project's newest build as a story the person can follow without knowing the engine: ten stops on one track, what is happening now, and the answer bar when it waits.",
    spec: ["The track shows Idea, Council, Design loop, Plan, Your OK, Build, Test and fix, Judge, Your OK, Ship.", "One sentence says what is happening now.", "The plan is drawn as a blueprint: entities, views, flows, tasks and acceptance checks.", "A shipped app takes Add it for the next version, in the same folder with the locked tests kept."],
    flow: ["Open the project", "The Mission tab shows the newest build", "Pick a stop to see its card", "Answer the gate in place", "Add it starts the next version"],
    design: "The project's Mission and Product tabs.",
    screens: ["/p/ID/overview", "/p/ID/product"], docs: ["docs/app.md", "docs/flows.md"], stations: [],
    files: [`${B}projects/mission/`, `${B}projects/addScreen.tsx`], api: [],
  },
  {
    id: "money", name: "Money limits", group: "Projects",
    purpose: "Gives each project a limit in all, for its first version and for each later version, and shows where the money went.",
    spec: ["A project has a total limit, a first-version limit and a later-version limit.", "A run may not start or continue past its project's limit.", "Spending is shown per version."],
    flow: ["Set the limits on the Money tab", "A run asks for its budget", "The limit is applied", "Spending is added up per version"],
    design: "The project's Money tab, and the budget bar on the Mission tab.",
    screens: ["/p/ID/money"], docs: ["docs/projects.md", "docs/spec.md"], stations: [],
    files: [`${C}projects/budget.ts`, `${B}projects/budgetPanel.tsx`], api: [],
  },
  {
    id: "needs-you", name: "Needs you and approvals", group: "Projects",
    purpose: "One list of every place the factory waits for the person, with each approval answered right there, so human stations stay few and quick.",
    spec: ["Runs at a gate, finished apps to approve, tickets waiting and rule conflicts are in one list, oldest first.", "An approval shows what is being approved and takes Approve, Stop, or a typed change.", "The same approval bar is used everywhere."],
    flow: ["Something waits for the person", "The sidebar badge turns amber", "The person opens Needs you", "They answer in place", "The run goes on"],
    design: "The Needs you page, the amber badge in the sidebar, and the approval bar wherever a gate is shown.",
    screens: ["/needs"], docs: ["docs/app.md", "docs/flows.md"], stations: [],
    files: [`${B}shell/NeedsYou.tsx`, `${B}shell/ApprovalCard.tsx`, `${B}ui/GateBar.tsx`, `${B}GateActions.tsx`], api: [],
  },

  // ───────────────────────────── Work
  {
    id: "tickets", name: "Tickets", group: "Work",
    purpose: "One record for every unit of work on a project, opened by the person, an agent or an error, with a queue the crew picks up from.",
    spec: ["A ticket has a kind, a state, a thread of notes, links and a key per project.", "Views: Waiting on you, Open, Crew working, Epics, Closed, All, and a Board.", "The crew picks up ready tickets when the switch is on, within caps per run and per day.", "A ticket can ask the person a question and wait."],
    flow: ["A ticket is opened", "It is made ready", "The crew or the person works it", "It waits on the person when built or when it has a question", "It is closed"],
    design: "The Tickets page (list or board, and a ticket page with its thread and actions) and the Tickets tab of every project.",
    screens: ["/factory/tickets", "/p/ID/tickets"], docs: ["docs/tickets.md", "docs/flows.md"], stations: [],
    files: [`${C}tickets/`, `${B}Tickets.tsx`, `${B}TicketsPanel.tsx`], api: ["/api/tickets"],
  },
  {
    id: "intake", name: "Intake (not every idea is a project)", group: "Work",
    purpose: "Work comes in through many doors and not all of it needs the whole pipeline. Intake checks whether a line is really a change to something that exists, and sends work in a repo down the route that fits it: one Builder session for a fix or a small ask, the whole engine for a feature.",
    spec: ["A line that reads like a change to an existing project is offered as a ticket on that project.", "The person can still make a project of it.", "In a project that lives in a repo, a bug, a task, a question or anything sized S takes the light route (one session); a request sized M, anything sized L, or an unsized ask longer than a small job takes the engine.", "The route and its reason are shown before the work starts, and the person can choose the other one.", "A spending limit under what an engine run needs always gives the light route, so the crew's own pickups never start an engine run."],
    flow: ["The person types a line or presses Work it", "Intake compares it with existing projects", "It offers a ticket on the match, or a new project", "In a repo project the ticket's kind, size and words pick the route", "The person picks, or lets the suggestion stand"],
    design: "A card shown in place of Create project or Build it when a match is found; on a ticket of a repo project, the suggested route with its reason next to both buttons.",
    screens: [], docs: ["docs/tickets.md", "docs/engine.md"], stations: [],
    files: [`${C}tickets/intake.ts`, `${C}factory/route.ts`, `${B}Intake.tsx`], api: [],
  },
  {
    id: "crew-prs", name: "Crew work in a repository", group: "Work",
    purpose: "Lets the crew work a ticket inside an existing codebase, on a branch, and bring it back as a draft pull request, never a push to main.",
    spec: ["A ticket on a project that lives in a repository is worked on a branch of its own.", "The work returns as a draft pull request when a GitHub write token is set.", "The token is kept in the data folder, never in the log, and never sent back.", "Each run is capped."],
    flow: ["Press Work it in the repo", "The crew works on a branch in a copy", "Checks run", "The branch is pushed", "A draft pull request is opened and linked to the ticket"],
    design: "The ticket page's Work it in the repo, the first tab of a project that lives in a repository, and Systems, Crew pull requests for the token.",
    screens: ["/factory/tickets"], docs: ["docs/tickets.md", "docs/dogfood.md"], stations: ["build", "review"],
    files: [`${C}tickets/repowork.ts`, `${C}tickets/github.ts`, `${B}CrewGitHub.tsx`, `${B}projects/mission/RepoWork.tsx`], api: [],
  },
  {
    id: "error-capture", name: "Errors become bug tickets", group: "Work",
    purpose: "Every fault in the app becomes a bug ticket by itself, with what was around it, and the person can report one with the screen attached.",
    spec: ["A fault in the core or a screen that throws opens a bug ticket once, not once per repeat.", "The Bug button files a report with the screen attached.", "When the core does not answer, the window says why and offers a restart."],
    flow: ["Something fails", "The fault is captured with its context", "A bug ticket is opened or the existing one is counted up", "The person sees it under Tickets"],
    design: "The Bug button in the top strip, the error screen that replaces a broken page, and the Core down cover.",
    screens: [], docs: ["docs/tickets.md", "docs/app.md"], stations: [],
    files: [`${C}tickets/capture.ts`, `${B}BugReport.tsx`, `${B}CoreDown.tsx`], api: [],
  },
  {
    id: "improve", name: "Improvement Council", group: "Work",
    purpose: "A standing loop that looks again at what already exists through six lenses and proposes improvements, which the person accepts, parks or rejects.",
    spec: ["Six lens agents look at a subject and answer with proposals.", "It runs by itself every few hours on the real crew, only when something changed, inside a daily cap.", "It pauses at 12 waiting proposals and never starts a build itself.", "An accepted proposal becomes a ticket."],
    flow: ["A subject changed, or the person presses Look now", "The lenses answer", "Proposals enter the queue", "The person accepts, parks or rejects", "An accepted one becomes a ticket"],
    design: "The Improve page (lens wheel, cost meter, queue) and the Improvements tab of every project.",
    screens: ["/factory/improve", "/p/ID/improve"], docs: ["docs/improve.md", "docs/flows.md"], stations: ["improve"],
    files: [`${C}improve/`, `${B}ImproveDeck.tsx`, `${B}projects/improvePanel.tsx`], api: ["/api/improve"],
  },
  {
    id: "imports", name: "Import a repository (code map)", group: "Work",
    purpose: "Brings an existing git repository in as a project: agents explore it read-only, map its modules and suggest changes, which become tickets.",
    spec: ["A repository is imported from a URL, owner/repo or a folder.", "A free static scan comes first; agent exploration is capped per import.", "Modules are drawn as a map with what depends on what.", "Suggestions become tickets."],
    flow: ["Give a URL or a folder", "The scan reads the working copy", "The Cartographer maps the modules", "The Surveyor suggests changes", "Suggestions are filed as tickets"],
    design: "The Code map tab of a project, and the Import a repo box on the Projects page.",
    screens: ["/p/ID/code"], docs: ["docs/flows.md", "docs/spec.md"], stations: ["map", "survey"],
    files: [`${C}imports/`, `${B}CodeMap.tsx`], api: ["/api/imports"],
  },
  {
    id: "repo-review", name: "Deep review of an imported repository", group: "Work",
    purpose: "When a repository is first imported the crew runs it, reads it and judges it without asking the person anything: what the app is, whether to keep, refactor or rewrite it, advice on the stack, and next steps to approve.",
    spec: ["A first import is reviewed by itself; after that a review runs only when pressed.", "It works in a copy: installs, runs the repo's tests, starts the site, opens its pages and looks its packages up.", "The Inspector says what the app is; the Assessor scores it and recommends keep, refactor or rewrite.", "Next steps become tickets only when the person approves them.", "The person can be interviewed or correct any point; Update the verdict rewrites it with what they said.", "The review is also one Markdown brief that can be put in the repo on a branch.", "Spend is capped per review, $1.50 unless changed."],
    flow: ["A repo is imported and mapped", "A copy is installed, tested, started and scanned", "The Inspector reads the code", "The Assessor gives the verdict and next steps", "The person approves steps, answers questions or corrects points", "Update the verdict rewrites it"],
    design: "The Review tab of an imported project: the stations strip, the verdict with three dials, the app flow drawn step by step, next steps to approve, Interview me, and the brief.",
    screens: ["/p/ID/review"], docs: ["docs/review.md", "docs/flows.md"], stations: ["inspect", "verdict"],
    files: [`${C}imports/review.ts`, `${C}imports/reviewcrew.ts`, `${C}imports/reviewTables.ts`, `${C}imports/evidence.ts`, `${B}RepoReview.tsx`], api: [],
  },
  {
    id: "runners", name: "Build runners", group: "Work",
    purpose: "SoftwareFactory's own manager for GitHub runners on this PC, so a repository's checks and builds run here instead of on GitHub's machines.",
    spec: ["Add, start, stop, restart and remove a runner.", "Show where a repository's builds run, the jobs waiting and done, and a live log.", "The core keeps runners running and closes what it started.", "It belongs to the app, not to a base."],
    flow: ["Add a runner for a repository", "The core registers and starts it", "GitHub sends jobs", "Jobs and logs are shown live"],
    design: "The Build runners page: runners, jobs with the machine each ran on, and the live log.",
    screens: ["/runners"], docs: ["docs/runners.md"], stations: [],
    files: [`${C}runners/`, `${B}Runners.tsx`], api: ["/api/runners"],
  },

  // ───────────────────────────── Library
  {
    id: "use-apps", name: "Use a finished app", group: "Library",
    purpose: "Starts a finished project with one press and shows it inside SoftwareFactory, so the person never guesses a command, an argument or a data file.",
    spec: ["How to run a project is found by looking at its folder.", "Start and Stop are one press; the app's page or output shows inside the window.", "Its data files are edited as forms.", "A command-line tool is used through a form of its arguments.", "The core closes every process it started, and never hands keys to a project's code."],
    flow: ["Open the project's Use tab", "Press Start", "The core starts it and finds its address", "The page opens inside the tab", "Press Stop"],
    design: "The Use tab of a project.",
    screens: ["/p/ID/run"], docs: ["docs/run.md", "docs/flows.md"], stations: [],
    files: [`${C}launch/`, `${B}projects/runPanel.tsx`, `${B}projects/useTool.tsx`, `${B}projects/dataFiles.tsx`], api: ["/api/launch"],
  },
  {
    id: "finished-apps", name: "Finished apps inside SoftwareFactory", group: "Library",
    purpose: "Installs a finished project into SoftwareFactory itself as a tool, a panel or a plugin, after readiness checks and one approval.",
    spec: ["Readiness checks say which forms a project can take.", "Installing needs one approval.", "A tool gets an arguments box and its output; a panel opens its page inside the app.", "An installed app can be updated and removed; each use is counted."],
    flow: ["Open the project's Integrate tab", "See the readiness checks", "Pick a form and ask", "Approve", "It appears under Finished apps"],
    design: "The Finished apps page and the Integrate tab of every project.",
    screens: ["/features", "/p/ID/integrate"], docs: ["docs/integrations.md", "docs/flows.md"], stations: [],
    files: [`${C}integrations/`, `${B}Features.tsx`], api: ["/api/integrations"],
  },
  {
    id: "plugins", name: "Add-ons (plugins)", group: "Library",
    purpose: "Folders with a plugin.json that add tabs, pages and a backend to SoftwareFactory, each in its own process with only what it was allowed.",
    spec: ["A plugin is installed, turned on and off, and removed.", "Its backend runs in its own Node process.", "The page says what each plugin may do, and shows its log.", "A plugin can add a tab to every project."],
    flow: ["Install a plugin folder", "Turn it on", "Its backend starts", "Its tabs and pages appear", "Turn it off or remove it"],
    design: "The Add-ons page, and add-on tabs under More in a project.",
    screens: ["/plugins"], docs: ["docs/plugins.md"], stations: [],
    files: [`${C}plugins/`, `${B}Plugins.tsx`], api: ["/api/plugins"],
  },
  {
    id: "feature-map", name: "Feature map", group: "Library",
    purpose: "One record per feature and a wiring map read from the real code, so it is always known what each feature is, what it is connected to, and whether it is alive.",
    spec: [
      "Every feature has one record: purpose, spec, flow, design, screens, documents, stations, and the source and API areas it owns.",
      "The wiring (what calls what, shared events and tables, API calls) is generated from the code, never drawn by hand.",
      "Each feature shows proof it is alive: how many of its events are in the log and when the last one was.",
      "Unconnected things are flagged: a feature that never ran, an event nobody reads, an API area the app never calls.",
      "The person can edit a record, add a planned feature and remove one they added, in forms.",
      "A check in the test run fails when a source file or an API area has no record, or a record is incomplete.",
    ],
    flow: ["Code changes", "The wiring is regenerated from it before every test run and build", "The check fails until every file and API area has a complete record", "The app folds records, wiring and the event log into the map", "The person reads it, and edits records in place"],
    design: "The Feature map page: totals, the list of features by group with a state mark, and one feature's page with its record, its connections drawn both ways, its shared data, its proof of life and its loose ends.",
    screens: ["/map"], docs: ["docs/feature-map.md"], stations: [],
    files: [`${C}featuremap/`, `${B}FeatureMap.tsx`], api: ["/api/feature-map"],
  },

  // ───────────────────────────── App
  {
    id: "factory-bridge", name: "Factory Bridge dashboard", group: "App",
    purpose: "One dashboard over the whole factory, in three views: where every build is, which agent worked when, and how every project is doing.",
    spec: ["Signal Loom shows every build through the stations and which waits for the person.", "Partitura shows each agent's calls over time with cost.", "Lantern Quarter shows every project's state."],
    flow: ["Open Factory Bridge", "Pick a view", "Press a build or a project to open it"],
    design: "The Factory Bridge page with a status strip and three views.",
    screens: ["/bridge"], docs: ["docs/app.md", "docs/design.md"], stations: [],
    files: [`${B}bridge/`], api: [],
  },
  {
    id: "shell", name: "App shell and design system", group: "App",
    purpose: "The frame every screen sits in (sidebar, top strip, keyboard) and the shared look, Foundry Glass, so the app reads as one product.",
    spec: ["The sidebar holds navigation, badges for what waits, and recent projects.", "The address hash keeps the place across a reload.", "Shared components and tokens are used by every screen.", "Keyboard: Ctrl K, Ctrl J, g then a letter, ?."],
    flow: ["The app opens", "The shell draws the sidebar and the page for the address", "Pages read the live event stream", "The person moves by click or keyboard"],
    design: "Foundry Glass: the tokens in styles.css, the shared components in ui/, the kit page at #/_kit.",
    screens: ["/_kit"], docs: ["docs/design.md", "docs/app.md", "docs/ui-tour.md"], stations: [],
    files: [`${B}App.tsx`, `${B}main.tsx`, `${B}shell/`, `${B}ui/`, `${B}styles.css`, `${B}Kit.tsx`, `${B}projects/router.ts`], api: [],
  },
  {
    id: "bases", name: "Bases", group: "App",
    purpose: "Several factories hosted by one app, like save files in a game: each base has its own database and projects.",
    spec: ["Open, create (with a folder picker), rename and archive a base.", "One base is open at a time, on the same port.", "Every base has its own event log."],
    flow: ["Open Bases", "Create or pick a base", "The host closes the current one and opens the other", "The app reloads on it"],
    design: "The Bases page, a card per base that peeks inside it.",
    screens: ["/bases"], docs: ["docs/bases.md"], stations: [],
    files: [`${C}bases/`, `${B}Bases.tsx`], api: ["/api/bases"],
  },
  {
    id: "updates", name: "In-app updates", group: "App",
    purpose: "The installed app checks for a newer signed build and installs it, by itself or on a button, without losing work in progress.",
    spec: ["The app checks GitHub for a newer signed build.", "An update waits for a running build to finish, or takes two presses to install over it.", "The log says who started an install.", "A read token is used when the repository is private."],
    flow: ["The shell checks for an update", "A strip counts down or waits for a build", "The update is downloaded and verified", "The app restarts on the new version"],
    design: "The version chip in the sidebar, the update strip under the top strip, and Systems, Updates.",
    screens: [], docs: ["docs/updates.md", "docs/flows.md"], stations: [],
    files: [`${B}Updates.tsx`, "src-tauri/src/updates.rs"], api: ["/api/updates"],
  },
  {
    id: "desktop-shell", name: "Desktop shell", group: "App",
    purpose: "The Windows program around everything: starts the core, restarts it when it stops, shows the Bridge in a window and closes what it started.",
    spec: ["Starts the core and waits for it to answer.", "Restarts the core when it stops.", "Closes the core and its children on exit."],
    flow: ["The person opens the app", "The shell starts the core", "The window loads the Bridge", "On close, the core is stopped"],
    design: "The app window itself.",
    screens: [], docs: ["docs/architecture.md", "docs/development.md"], stations: [],
    files: ["src-tauri/src/main.rs"], api: [],
  },

  // ───────────────────────────── Foundation
  {
    id: "storage", name: "Event log and data vault", group: "Foundation",
    purpose: "The source of truth: an append-only event log, with typed tables folded from it and rebuilt from it whenever needed, so nothing is ever lost and everything can be shown.",
    spec: ["Every change is an event in one append-only log.", "Tables are derived from the log in the same transaction and can be rebuilt from it.", "Schema changes are versioned migrations with a backup.", "The Data vault shows the log, the tables with their health, the files on disk and the cache."],
    flow: ["A feature appends an event", "Projections update their tables in the same transaction", "Listeners and the live stream get the event", "Rebuild from log recreates any table"],
    design: "The Data vault page: three storage tiers drawn live, with Rebuild from log.",
    screens: ["/factory/data"], docs: ["docs/storage.md", "docs/reference.md"], stations: [],
    files: [`${C}events.ts`, `${C}store/`, `${B}DataDeck.tsx`], api: ["/api/store"],
  },
  {
    id: "core-api", name: "Core server and live stream", group: "Foundation",
    purpose: "The one local server the Bridge talks to: routes every API call to its feature and streams every event live.",
    spec: ["Listens only on this computer.", "Every API area is answered by one feature.", "The event stream sends every event as it is appended.", "A fault in a route becomes a bug ticket and a plain sentence for the person."],
    flow: ["The Bridge calls an API area", "The server hands it to the feature's routes", "The feature reads or appends events", "The stream carries the events back to every open screen"],
    design: "No screen of its own; the Online dot in the sidebar shows it answers.",
    screens: [], docs: ["docs/architecture.md", "docs/reference.md"], stations: [],
    files: [`${C}server.ts`, `${C}index.ts`, `${B}api.ts`], api: ["/api/events", "/api/health"],
  },
];
