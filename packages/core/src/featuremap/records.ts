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
    files: [`${C}factory/loop.ts`, `${C}factory/run.ts`, `${C}factory/runbase.ts`, `${C}factory/runjudge.ts`, `${C}factory/runkit.ts`, `${C}factory/stoprules.ts`, `${C}factory/crew.ts`, `${C}factory/workspace.ts`, `${C}factory/workbench.ts`, `${C}factory/trim.ts`, `${C}factory-cli.ts`, `${B}FactoryFloor.tsx`, `${B}RunDeck.tsx`, `${B}Timeline.tsx`, `${B}DuplicateNotice.tsx`],
    api: ["/api/factory"],
  },
  {
    id: "supervisor", name: "Supervisor", group: "Engine",
    purpose: "Keeps work going without anyone watching: the PC stays awake while the crew works, a stuck run is cut at once, a stopped run is tried again, and the queue never idles, all inside the money caps.",
    spec: [
      "While a run or a ticket's Builder works, Windows is asked not to sleep on idle; the hold ends with the core.",
      "Clocks that measure work leave out the time the PC slept, so waking never stops a run as too long.",
      "An agent call with no output for 10 minutes is cut as stuck; one still working at its limit gets more time, up to three times.",
      "A run at its time limit whose last round made progress gets the limit again, at most twice.",
      "A run with no sign of progress for 30 minutes is cut by the supervisor and tried again.",
      "A run that stopped or failed, not on purpose, is tried again from its step, at most twice by itself, within today's auto-work limit; then it waits for you.",
      "Once a minute the dispatcher is asked to start the next ready ticket.",
    ],
    flow: ["A run stops, stalls or the PC sleeps", "The supervisor looks once a minute", "A stuck run is cut", "A stopped run is tried again from its step with fresh money", "After two tries it waits for you, said on its ticket", "The next ready ticket starts"],
    design: "Shown as the Supervisor card on All builds: whether the PC is held awake, the last sleep, each run in flight with minutes since its last progress, and what the supervisor did lately.",
    screens: ["/factory"], docs: ["docs/supervisor.md"], stations: [],
    files: [`${C}factory/supervisor.ts`, `${C}factory/awake.ts`, `${B}SupervisorCard.tsx`],
    api: ["/api/supervisor"],
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
    spec: ["Tests are tried in a dry run before they are locked.", "Fast checks (syntax, types, lint, secrets) run after every build or fix.", "Every screen is opened in a real browser; without a browser the check is skipped, not passed.", "Every link the app ships is opened.", "A change that weakens a locked test is reported.", "Before anything costs money, a free preflight checks Git, Claude Code, its sign-in and disk space (safety/preflight.ts).", "Each station's output must have a visual (visualizeEverything)."],
    flow: ["A build or fix finishes", "Fast checks run", "The whole test suite runs", "Screens and links are opened", "Failures go to the Fixer with trimmed output"],
    design: "The Tests, Loop and Visuals tabs of the run deck show each check per round; fast checks appear in the Loop tab.",
    screens: ["/factory"], docs: ["docs/engine.md", "docs/screens.md"], stations: ["tests", "fix", "review"],
    files: [`${C}factory/testcheck.ts`, `${C}factory/screencheck.ts`, `${C}factory/uicheck.ts`, `${C}factory/linkcheck.ts`, `${C}factory/visualize.ts`, `${C}safety/`],
    api: ["/api/preflight"],
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
    files: [`${C}factory/reporun.ts`, `${C}factory/repoenv.ts`, `${C}factory/suitememo.ts`], api: [],
  },
  {
    id: "engine-review", name: "Engine review", group: "Engine",
    purpose: "Every run ends with the engine's review of its own work, so the engine itself can be improved from evidence.",
    spec: ["The review is written by the core from events, with no agent call."],
    flow: ["A run ends", "The core folds its events into a review", "The review is logged"],
    design: "The Engine tab of the run deck.",
    screens: [], docs: ["docs/engine.md", "docs/flows.md"], stations: [],
    files: [`${C}factory/retro.ts`], api: [],
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
    id: "crew-advisor", name: "Crew advisor (advisor tool)", group: "Agents",
    purpose: "Lets a crew agent on a cheaper model consult a stronger one mid-task (Anthropic's advisor tool), so hard moments get the stronger model's judgment at close to the cheaper model's price.",
    spec: ["Every paid call gets the advisor by one rule, in one place.", "An agent only gets an advisor stronger than its own model.", "Calls with a small cap get none, so a consultation never fails a small call.", "The advisor's tokens count inside the call's own cap.", "A CLI that refuses the advisor never fails a run: the call runs again without it.", "The person turns it off, or picks Sonnet or Opus, in Systems."],
    flow: ["A station asks for a call", "The rule picks the advisor, or none", "Claude Code runs the agent with --advisor", "The agent consults the advisor before a plan, when stuck, and before it calls the work done", "The cost, with the advisor's share, is logged"],
    design: "Systems drawer, Crew advisor: Off, Sonnet or Opus, and the smallest call cap that gets one.",
    screens: [], docs: ["docs/advisor.md"], stations: [],
    files: [`${C}advisor.ts`, `${B}CrewAdvisor.tsx`], api: ["/api/crew"],
  },
  {
    id: "configuration", name: "Configuration (what SF runs with)", group: "Agents",
    purpose: "One place that shows everything SoftwareFactory runs with right now, in three layers, and where each piece came from, so it is always clear what is in use and why. Every run records the setup it ran with.",
    spec: ["Every flow, agent, skill, MCP server, add-on, gate, limit and SF_* switch in use is listed in one of three layers: how we work, who works, where and with what.", "Each entry says whether it is on, what it is set to, where it came from and since when.", "Every paid call records the fingerprint of the setup it ran with; each setup is kept once.", "A run and a ticket show the setup they ran with, and what changed since.", "The crew never loads the person's own Claude Code settings unless SF_CREW_PERSONAL_SETTINGS=1 or a profile says so.", "Profiles are named sets of settings in the three layers, picked everywhere, per project, per ticket or per run; the narrowest one that sets a thing wins.", "Inside one profile two settings that touch the same thing are refused.", "Every pick (from Scout or by hand) is a catalog entry with its source and state; its build ticket waits, held from the crew, until the person chooses Build it.", "Scout's open tickets were adopted once into the catalog, tickets about the same named thing merged as duplicates.", "A ready entry with settings can go on trial: every second ticket or run gets it, and after 5 finished on each side SF promotes it (clearly better, at most 20% pricier), drops it (worse) or asks the person.", "The SF_* switches that change how the crew works can be set on the page; a value set there wins over the PC's environment, stays after a restart, and Reset gives the PC's value back."],
    flow: ["The core reads the live setup from the Bay, flows, add-ons, settings and environment", "A paid call asks for the setup's fingerprint and records it", "A new fingerprint keeps its whole list once", "The Configuration page lists the setup; a run or ticket shows Ran with and the differences"],
    design: "Main menu, Factory, Configuration: a table per layer with state, setting, source and since; a Ran with line on each run deck and ticket.",
    screens: ["/config"], docs: ["docs/configuration.md"], stations: [],
    files: [`${C}configs/`, `${B}Configuration.tsx`, `${B}Profiles.tsx`, `${B}Catalog.tsx`, `${B}Switches.tsx`], api: ["/api/config"],
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
    id: "agent-memory", name: "Agent memory", group: "Agents",
    purpose: "Each agent keeps its own memory of lessons from its past work and carries it into every project: the lessons go into its prompt on every call, and a free tidy keeps it short.",
    spec: [
      "Lessons come from the person (Teach), from the agent's own Remember: lines, and from a review that sends its build back.",
      "The newest twelve lessons, the person's first, go into the agent's prompt between its own instructions and the station contract.",
      "A repeat or near repeat is never noted twice; past 40 lessons a free tidy removes repeats and the oldest, never one the person taught.",
      "Everything is an event: no lesson is lost from the record.",
    ],
    flow: ["An agent works, is reviewed, or is taught", "The lesson is added to its memory", "Its next call carries the lesson", "Past 40 lessons a free tidy keeps it short"],
    design: "A Memory tab on each agent in the Agent Bay: the lessons with where each came from, Teach, Forget and Tidy.",
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
      "Errors: a fault in the core or a screen opens one bug ticket, counted up on repeats; the Bug button files one with the screen attached.",
    ],
    flow: ["A watcher's time comes round", "It looks at the folder or the records", "Each new finding opens one ticket", "The person makes the ones worth doing ready"],
    design: "A Watchers tab on each project (Improve): one card per watcher with its switch, how often it looks, Look now, its last look and the tickets it opened.",
    screens: ["/p/ID/watchers"], docs: ["docs/watchers.md", "docs/tickets.md", "docs/app.md"], stations: [],
    files: [`${C}watch/watchers.ts`, `${C}watch/routes.ts`, `${C}tickets/capture.ts`, `${B}BugReport.tsx`, `${B}CoreDown.tsx`], api: ["/api/watchers"],
  },
  {
    id: "videos", name: "Videos (watch and learn)", group: "Agents",
    purpose: "SoftwareFactory watches a video, a YouTube link or a clip you saved, and keeps timestamped notes of what it says and shows, searchable forever, so a video is learned once and never paid for twice.",
    spec: [
      "A YouTube link goes to Gemini as it is: Google fetches the video, nothing is downloaded on this computer. A video file you saved (TikTok, Instagram, X, a screen recording) is uploaded to Gemini, watched, then deleted there.",
      "Link drop: an Instagram, TikTok or X link (the watch box, or a .txt file in the Watch folder) is fetched logged out, with Scrape Creators when its key is set, else yt-dlp, never with your login; those sites forbid automated downloading and this was chosen knowingly.",
      "The Gemini key is pasted once in Systems and kept in ~/.config/watch/.env, the file Claude Code's /watch plugin reads too. It is never logged or sent back.",
      "The same video with the same question is answered from the notes, free. A daily limit (40 by default) stops a loop from watching without end.",
      "Add-ons with the video permission (Scout) watch YouTube links and search the notes; they cannot send files.",
      "Instagram by DM: a reel shared to your second (professional) Instagram account arrives through Meta's official Messaging API at a small Cloudflare Worker on your own account, which SoftwareFactory deploys; it is pulled into the Watch folder every minute. Nothing on this computer is opened to the internet.",
    ],
    flow: ["Paste a free Gemini key once", "Give a YouTube link or a saved clip, and a question if you have one", "Gemini watches it and answers with timestamps", "The notes are kept and found by search later"],
    design: "A Videos section in Systems: the key, the daily limit, a box to watch a link or a file, and the latest notes with search.",
    screens: [], docs: ["docs/videos.md"], stations: [],
    files: [`${C}video/gemini.ts`, `${C}video/videos.ts`, `${C}video/routes.ts`, `${C}video/instagram.ts`, `${C}video/ig-worker.ts`, `${C}video/links.ts`, `${B}Videos.tsx`], api: ["/api/videos"],
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
    ],
    flow: ["A principle is added or changed by the person", "The change is logged as an event", "The next agent call on a named station reads it", "The Brain counts the call as a read", "Checks in code hold builds to the built-in principles"],
    design: "The Principles section under the crew on the Agents page: a use strip (reads and changes), a card per principle with its stations, its checks and its reads, the station by principle matrix, the exact instructions an agent reads now, and the history.",
    screens: ["/factory/bay"], docs: ["docs/apps.md", "docs/feature-map.md"],
    stations: ["council", "design", "critique", "plan", "tests", "build", "review", "evaluate", "fix", "overseer", "survey"],
    files: [`${C}brain/brain.ts`, `${C}brain/routes.ts`, `${C}brain/learn.ts`, `${B}Brain.tsx`], api: ["/api/brain"],
  },

  // ───────────────────────────── Order
  {
    id: "order-engine", name: "Order Engine (rules and ideas)", group: "Order",
    purpose: "Brings order to messy, parallel thinking: cuts what the person writes into fragments, files each under the right project, idea or thread, keeps the rules (the Canon) and finds conflicts between them.",
    spec: ["A note is cut into fragments: rule, decision, idea, task, question, note or noise.", "Each fragment is filed on a node of the tree; unsure ones wait in the Unsorted tray.", "Rules and decisions on a node and its ancestors are its Canon.", "Conflicts are resolved by fixed precedence (the person's words, the more specific node, newer, important), or a conflict card asks.", "A sweep cleans old data, with undo.", "Recall: agents can look up the person's own words across notes, tickets and plans."],
    flow: ["The person captures a note", "The Archivist proposes how to cut and file it", "The engine files it and checks it against the Canon", "A conflict is resolved by precedence or shown as a card", "The briefing says what changed"],
    design: "Rules and ideas: the star map of projects, ideas and threads, and the Order deck with the Canon, the Unsorted tray, conflict cards and the briefing. Each project has the same view on its Ideas tab.",
    screens: ["/factory/order", "/p/ID/ideas"], docs: ["docs/flows.md", "docs/history.md", "docs/engine.md", "docs/storage.md"], stations: ["order", "council", "plan"],
    files: [`${C}order/`, `${C}order-cli.ts`, `${C}signals.ts`, `${B}StarMap.tsx`, `${B}OrderDeck.tsx`, `${C}brain/recall.ts`],
    api: ["/api/order", "/api/signals"],
  },
  {
    id: "assistant", name: "Assistant, chats and the Helm", group: "Order",
    purpose: "The place to talk to the factory: capture a note or start a build, in a General chat or one chat per project, or from one line anywhere with Ctrl K.",
    spec: ["Capture files a note for free.", "Build it starts a run.", "Each project has its own chat, next to a General chat.", "A Since you left card says what happened after 10 minutes away.", "App settings (crew mode and the rest) are events, like everything else."],
    flow: ["The person types one line", "Capture or Build it", "The line is filed in the chat it belongs to", "Gates waiting are said here with a Show me button"],
    design: "The Assistant panel on the right of every screen (Ctrl J), and the Helm (Ctrl K).",
    screens: [], docs: ["docs/app.md", "docs/projects.md", "docs/architecture.md", "docs/storage.md"], stations: ["overseer"],
    files: [`${C}bridge/status.ts`, `${C}chat/`, `${B}Overseer.tsx`, `${B}shell/Helm.tsx`, `${C}bridge/tables.ts`],
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
    spec: ["A project has a total limit, a first-version limit and a later-version limit.", "A run may not start or continue past its project's limit.", "Spending is shown per version.", "A monthly budget per project and overall, with the burn rate; the queue waits when the month runs low."],
    flow: ["Set the limits on the Money tab", "A run asks for its budget", "The limit is applied", "Spending is added up per version"],
    design: "The project's Money tab, and the budget bar on the Mission tab.",
    screens: ["/p/ID/money", "/"], docs: ["docs/projects.md", "docs/spec.md", "docs/watchers.md"], stations: [],
    files: [`${C}projects/budget.ts`, `${B}projects/budgetPanel.tsx`, `${C}watch/spend.ts`], api: ["/api/budget"],
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
    spec: ["A ticket has a kind, a state, a thread of notes, links and a key per project.", "Views: Waiting on you, Open, Crew working, Epics, Closed, All, and a Board.", "The crew picks up ready tickets when the switch is on, within caps per run and per day.", "A ticket can ask the person a question and wait.", "Intake: a line that reads like a change to an existing project is offered as a ticket there, and a repo ticket takes the light route or the engine by its kind, size and words.", "Before money is spent, a ticket is checked: one that needs the person's call waits for their answer instead."],
    flow: ["A ticket is opened", "It is made ready", "The crew or the person works it", "It waits on the person when built or when it has a question", "It is closed"],
    design: "The Tickets page (list or board, and a ticket page with its thread and actions) and the Tickets tab of every project.",
    screens: ["/factory/tickets", "/p/ID/tickets", "/"], docs: ["docs/tickets.md", "docs/flows.md", "docs/engine.md"], stations: [],
    files: [`${C}tickets/`, `${B}Tickets.tsx`, `${B}TicketVerify.tsx`, `${B}TicketsPanel.tsx`, `${C}tickets/intake.ts`, `${C}factory/route.ts`, `${B}Intake.tsx`, `${C}tickets/precheck.ts`], api: ["/api/tickets"],
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

  // ───────────────────────────── Library
  {
    id: "use-apps", name: "Run a finished app (parked)", group: "Library",
    purpose: "Starts a finished project with one press and shows it inside SoftwareFactory, so the person never guesses a command, an argument or a data file.",
    spec: ["How to run a project is found by looking at its folder.", "Start and Stop are one press; the app's page or output shows inside the window.", "Its data files are edited as forms.", "A command-line tool is used through a form of its arguments.", "The core closes every process it started, and never hands keys to a project's code.", "A finished app can be installed into SoftwareFactory and used from a project's Integrate tab.", "An app the factory built may ask one of the person's agents (the Researcher by default) for work plain code cannot do, inside a cap."],
    flow: ["Open the project's Use tab", "Press Start", "The core starts it and finds its address", "The page opens inside the tab", "Press Stop"],
    design: "The Use tab of a project.",
    screens: ["/p/ID/run", "/features", "/p/ID/integrate"], docs: ["docs/run.md", "docs/flows.md", "docs/integrations.md", "docs/apps.md"], stations: [],
    files: [`${C}launch/`, `${B}projects/runPanel.tsx`, `${B}projects/useTool.tsx`, `${B}projects/dataFiles.tsx`, `${C}integrations/`, `${B}Features.tsx`, `${C}factory/appagent.ts`], api: ["/api/launch", "/api/integrations", "/api/apps"],
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
    files: [`${B}App.tsx`, `${B}main.tsx`, `${B}shell/`, `${B}ui/`, `${B}styles.css`, `${B}styles/`, `${B}Kit.tsx`, `${B}projects/router.ts`], api: [],
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
    id: "storage", name: "Event log", group: "Foundation",
    purpose: "The source of truth: an append-only event log, with typed tables folded from it and rebuilt from it whenever needed, so nothing is ever lost and everything can be shown.",
    spec: ["Every change is an event in one append-only log.", "Tables are derived from the log in the same transaction and can be rebuilt from it.", "Schema changes are versioned migrations with a backup.", "GET /api/store reports the three tiers and POST /api/store/rebuild rebuilds from the log; the installed-app smoke test checks every upgrade with them."],
    flow: ["A feature appends an event", "Projections update their tables in the same transaction", "Listeners and the live stream get the event", "Rebuild from log recreates any table"],
    design: "No screen of its own (the Data vault page was removed 24 Nov 2026: a debug view nobody used).",
    screens: [], docs: ["docs/storage.md", "docs/reference.md"], stations: [],
    files: [`${C}events.ts`, `${C}store/`], api: ["/api/store"],
  },
  {
    id: "core-api", name: "Core server and live stream", group: "Foundation",
    purpose: "The one local server the Bridge talks to: routes every API call to its feature and streams every event live.",
    spec: ["Listens only on this computer.", "Every API area is answered by one feature.", "The event stream sends every event as it is appended.", "A fault in a route becomes a bug ticket and a plain sentence for the person."],
    flow: ["The Bridge calls an API area", "The server hands it to the feature's routes", "The feature reads or appends events", "The stream carries the events back to every open screen"],
    design: "No screen of its own; the Online dot in the sidebar shows it answers.",
    screens: [], docs: ["docs/architecture.md", "docs/reference.md"], stations: [],
    files: [`${C}server.ts`, `${C}webui.ts`, `${C}index.ts`, `${B}api.ts`], api: ["/api/events", "/api/health"],
  },
];
