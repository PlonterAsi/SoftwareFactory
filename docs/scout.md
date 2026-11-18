# Scout and auto-file rules

Scout is a project's daily look for AI engineering worth knowing: skills, plugins, MCP servers, mods, agents,
prompts, tips, and the pages and people worth following. Each find is analyzed, rated, given a verdict (use, adapt,
build our own, skip), and the best are tried in a throwaway sandbox. Brief:
<https://claude.ai/artifact/7tB8wsLB9KxoxxnswmJSKz> (2026-11-18).

Code: `packages/core/src/scout/` (`gather.ts` the readers, `scout.ts` the look and the catalog, `sandbox.ts` the
trials, `tables.ts` the catalog table, `routes.ts`), `packages/core/src/tickets/autofile.ts` (the rules). Screens:
the **Scout** tab on a project (Improve), and a Scout card on **Home**. In the flow library it is the **Scout** door
flow.

Any project can turn Scout on; the Scout project is the one made for it. Scout is off until you turn it on.

## A look

| Step | Who | Cost |
| --- | --- | --- |
| Gather | plain code reads the sources, the follow list and the link inbox | free |
| Triage | plain code: one find per address, at most 60 new a look, strongest first | free |
| Analyze | the **Analyst** (Haiku, may read the page) rates up to 10 finds a look, 5 per call | capped per look ($0.30 as shipped) |
| Try | the **Tester** (Sonnet) in the sandbox, top finds only (3 a week as shipped) | up to $0.60 a trial |
| Rate and advise | scores, risk, verdict, where it helps, how to adapt it | |
| File | your auto-file rules, or your press | free |

Every paid call is charged to the Scout project, so the project's **monthly budget** holds it (docs/watchers.md).
With less than $0.05 left in the month a look gathers and stops; a trial needs $0.10. On the practice crew nothing is
paid.

### Sources

| Kind | Reads | Notes |
| --- | --- | --- |
| GitHub search | new repositories by topic or words, with their stars | forks and repos under 3 stars are dropped |
| Hacker News | stories with 15+ points (Algolia search) | |
| Reddit | a subreddit's top posts of the day (its public `.json`) | |
| Feed | any RSS or Atom feed: a blog, a newsletter, a YouTube channel's feed | |
| Awesome list | an `owner/repo` README on GitHub | the first read only remembers its links; links added after are finds |

Instagram, Facebook and much of X need a sign-in to read, so they have no reader. Their links come in through the
**link inbox**: paste any link (with a note if you like); it is read first on the next look.

The **follow list** holds the pages and people worth following. A feed, a YouTube channel (`/channel/UC…`) and a
GitHub user are read on every look; the rest are kept for you. A find the Analyst marks worth following has a
Follow button.

### Scores, risk, verdict

The Analyst scores **token efficiency, best practice, productivity, security and upkeep** from 1 to 5, each with a
reason, against the focus in the settings (SoftwareFactory, as shipped). The overall score is their average. A find
scored 2 or less on security is never **use**: its idea goes to **build our own**.

Risk is set from what is known before anything runs, and the Analyst can only raise it:

| Risk | What | Trial |
| --- | --- | --- |
| read-only | prompts, tips, pages, people | never run as code (a prompt is tried as know-how) |
| low | a repo with no code language (text-only skills), established | automatic |
| medium | code from an established source | automatic |
| high | under 20 stars, under a month old with under 100 stars, archived, or the Analyst says so | waits for your click |

### The sandbox

1. **Fetch**: the repository is downloaded (at most 60 MB) into `scout/trial-<id>` in the data folder. Nothing in it runs here.
2. **Scan**: plain code looks for install scripts, download-and-run, binaries, encoded code, credential reading,
   webhooks and paste sites, and committed secrets. A critical or high finding makes the trial wait for your
   click, whatever its risk was.
3. **Machine**: a throwaway WSL 2 machine is made from Alpine's mini root file system. Before the find goes in,
   `/etc/wsl.conf` turns off Windows drives (automount) and Windows programs (interop), and the machine is
   restarted; a check that it cannot see `/mnt/c` or `cmd.exe` stops the trial otherwise.
4. **Try**: the Tester runs on this computer with one command it may use, `wsl -d sf-scout-<id> …`, so its Claude
   sign-in never goes inside. It runs 2 or 3 use cases and ends with a JSON report.
5. **Remove**: the machine is unregistered, whatever happened.

A trial passes or fails on the Tester's report; a different verdict from the Tester replaces Scout's (never yours).
Sandbox machines need Windows with WSL (`wsl --install --no-distribution` in an administrator PowerShell). Without
it a trial waits and says so.

## Auto-file rules

Your settings for which suggestions become tickets by themselves. A suggestion that meets every condition of a rule
that is on is filed; the rest wait as proposals you press. Conditions: estimated minutes at most, estimated cost at
most, severity at least, verdicts, score at least, risk at most, categories. A condition the suggestion has no value
for does not match. A rule can also **make the ticket ready**, so the crew picks it up within its caps and the
monthly budget.

- **Scout** hands every rated find (not skip). The ticket goes to the project the settings name (this project when
  empty), with a fingerprint so a find is filed once.
- **Watchers** hand every ticket they open (with its severity). A watcher files every finding anyway, so a matching
  rule can only make it ready: for example "blocking watcher tickets go now".

As shipped: one rule, **Quick, cheap, safe finds to use** (verdict use, risk medium or lower, under $5 and 20
minutes), filing only, not ready.

## Events and API

| Event | Payload |
| --- | --- |
| `scout.set` | `{ projectId, on, everyHours, runUsd, perLook, trialsPerWeek, ticketsTo, focus, sources, follow, by }` |
| `scout.found` | `{ projectId, url, key, title, source, snippet, meta }` |
| `scout.seen` | `{ projectId, source, keys }` an awesome list's links at its last read |
| `scout.analyzed` | `{ id, category, summary, scores, score, verdict, where, how, risk, minutes, usd, follow, trial, costUsd }` |
| `scout.judged` | `{ id, verdict, note, by }` |
| `scout.filed` | `{ id, ticketId, by }` |
| `scout.trial` | `{ id, state, note, costUsd?, by? }` state: queued, needs-approval, running, passed, failed, declined |
| `scout.ran` | `{ projectId, gathered, fresh, analyzed, filed, trials, costUsd, notes, error? }` |
| `autofile.rules` | `{ rules, by }` |

Table `scout_finds` (one row per find). API: see the header of `scout/routes.ts` (`/api/scout…`, `/api/autofile`).
The core checks every 30 minutes for a look that is due, then runs the next queued trial.
