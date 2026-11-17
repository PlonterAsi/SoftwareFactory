# The git manager

SoftwareFactory runs git for every project (SF behavior brief, phase 3, 2026-11-17). The code is in
`packages/core/src/git/` and the screen is the **Git** tab of each project
(`apps/bridge/src/projects/GitPanel.tsx`). The manager pays for no agent. Everything it reads or writes
on GitHub goes through the token in Systems, GitHub access.

## Local first, then a private repo

A new project lives in a folder on this computer: its newest shipped build, or a linked repo folder.
It stays there until you judge it worth continuing. The Git tab offers three choices:

- **Continue** makes a private GitHub repo under the token's account. It sends the folder's branch
  there as `main`, with its tags, and links the repo to the project. From then on each ticket is a
  branch and a draft PR in that repo.
- **Park** pauses the project.
- **Drop** archives it.

Each choice keeps the reasons you typed (`project.verdict`). Publish works at any time through
`POST /api/git/projects/:id/publish`. This is the only time SF pushes a `main` branch, and only into
a repo it has just made.

## The merge policy

Every crew PR gets a **merge review** when its CI ends (`git/confidence.ts`). The review is plain code
and costs nothing. It has eight lines, and each line passes or fails:

| Line | Passes when |
| --- | --- |
| CI | every check run and status on the PR's head commit passed |
| Crew | SF's crew made it, on its own `sf/` branch |
| Review | SF's Reviewer passed it in the ticket's last pass |
| Tests | the tests passed, or no test touches the change and the gates passed |
| Size | at most 15 files and 400 changed lines |
| Sensitive | no CI, secret, migration, lock or install files are touched |
| Decisions | the check before money found no decision only you make (money, data, secrets, going public, legal) |
| Taste | the ticket is a fix or a task; requests, ideas and epics wait for your look |

A review is **confident** only when all eight lines pass.

Each project starts on **Ask me**. A crew PR whose CI passed waits on Home's Needs you as a
**Merge?** card, and the ticket page shows a Merge review box. You press Merge. SF marks a draft PR
ready, squashes it into `main`, and the ticket moves on as with any merge.

After three confident merges in a row went in, the Git tab offers **Merge confident PRs**. Under that
policy, SF's five-minute follow merges a confident PR by itself. It does this only with the real crew,
and never while CI runs or after CI failed. Anything less than confident still waits for you.

If a merge was wrong, press **The merge was not right** on its ticket. SF counts right merges from
zero again, and the project goes back to Ask me.

## Outside work

Every five minutes SF reads each project's GitHub repo, the same pass that follows PRs.

- **The first look** only remembers where the repo stands, so its history is not counted as outside
  work.
- **A PR that names a ticket** joins that ticket's timeline. A PR names a ticket when its title or
  branch says `SF-12`. If the PR was merged, the ticket moves on.
- **Any other PR** opens a ticket tagged *outside* that says who made it.
- **Commits made straight on `main`** go to the ticket they name. Commits that name no ticket become
  one closed *outside* ticket for each look.

Press **Look for outside work** on the Git tab to read the repo now.

## Versions

The Git tab shows the next version: the tickets merged since the last version (or closed, in a local
project), and release notes written from those tickets. The notes have four sections: New, Fixed,
Changed and Made outside SF.

The version number depends on what is in it. If every ticket is a bug, the version is a patch. If
anything is new, it is a minor step. The first version is v0.1.0.

**Cut** does one of two things:

- In a project on GitHub, it makes a GitHub release on the newest commit of `main`.
- In a project on this computer, it tags the folder, past the tags it already has.

Each version goes on the project's version timeline (`project.version`).

## Events and tables

| Event | Meaning |
| --- | --- |
| `project.verdict` | continue, park or drop, with your reasons |
| `project.published` | the repo, whether it is private, and the commit sent |
| `project.mergepolicy` | ask or auto |
| `repo.watched` | how far outside work was read |
| `ticket.mergecheck` | one merge review |
| `ticket.mergewrong` | a merge that was not right |
| `project.version` | a version, with its tickets, notes, commit and release |

These events feed three tables: `project_git`, `merge_checks` and `versions` (`git/tables.ts`).

## API

    GET  /api/git/projects/:id                 where the code lives, verdict, policy, versions, the next version
    POST /api/git/projects/:id/publish         { name?, private? }
    POST /api/git/projects/:id/verdict         { verdict: continue|park|drop, why? }
    POST /api/git/projects/:id/policy          { mode: ask|auto }
    POST /api/git/projects/:id/watch           read the repo for outside work now
    POST /api/git/projects/:id/versions        { bump?, notes? }   cut the next version
    GET  /api/git/tickets/:id                  the last merge review of the ticket's PR
    POST /api/git/tickets/:id/check            review it again now
    POST /api/git/tickets/:id/merge            merge it (your press)
    POST /api/git/tickets/:id/not-right        { why? }
