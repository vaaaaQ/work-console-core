# azure-devops

My work items, pull requests, builds and a team board from a signed-in Azure DevOps tab, plus state,
comment and vote actions.

The script calls the REST API (`api-version=7.1`) from inside the tab with the tab's own cookie
session, so it holds no token and returns none. Every setting is checked again in the tab, and a bad
one is refused before any request is sent.

## Config

| Key | Default | Meaning |
|---|---|---|
| `org` | required | The organization in `https://dev.azure.com/<org>` |
| `project` | required | The project that reviews, builds and the board are read in |
| `team` | `<project> Team` | The team whose board and area the `board` concept reads |
| `board` | none | The backlog-level board, such as `Stories`; `board` refuses to read without it |
| `ready` | the board's first column | The column of items ready to take: the `free` lane |
| `handoff` | none | Columns an item goes to after me, such as a test column: the `qa` lane; none means no `qa` lane |
| `doneStates` | `Closed`, `Done`, `Removed` | States that count as finished |
| `fields` | System and VSTS scheduling fields | Field reference names that `get work` returns when the item has them; custom fields go here |

## Hosts

`dev.azure.com`. The tab matches `https://dev.azure.com/{org}` and opens on the project.

## Concepts

| Concept | Every | Cap | Source |
|---|---|---|---|
| `work` | 30 s | 100 | Work items assigned to me and not in a done state, plus watched ones |
| `review` | 20 s | 30 | Active pull requests I review or wrote, plus watched ones: my vote, all votes, open threads |
| `ci` | 30 s | 30 | Builds requested for me, plus watched ones |
| `board` | 60 s | 100 | The team's board in lanes `mine`, `qa` and `free`, each item with its column and swimlane |

`get work <id>` returns the header, linked PRs, description, repro steps, acceptance criteria, the
latest 20 comments and the configured fields; pictures become `[image]`. `get review <id>` returns
the PR with its branch policies and threads. `get ci <id>` returns the last 200 lines of the failed
step's log.

The board is scoped by the team's area values and the item types the board's first column maps.

## Actions

| Action | Args |
|---|---|
| `work.setState` | `{id, state}` |
| `work.comment` | `{id, text}` |
| `review.vote` | `{id, vote}`, vote one of 10, 5, 0, -5, -10 |
| `review.comment` | `{id, text, threadId?}`: a new thread, or a reply in `threadId` |

## Errors

401 and 203 (an expired session) and an HTML page in place of JSON are `unauthorized`. 403 is
`source_error`: the session works but lacks the permission. A failure after an action's write went out
is `unknown`.
