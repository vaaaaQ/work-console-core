# Concept mapping for an Atlassian + GitHub + Slack + Jenkins + Zoom workplace

> **Hypotheses, not findings.** Only Jira `work` read, get and comment are written (`packs/example`),
> and even that runs only against a fake tab in tests. Check each row live in a signed-in tab
> before you build on it.

| Concept | Tool | Read from the tab | Acts | Main risk |
|---|---|---|---|---|
| `work` | Jira | `/rest/api/3/search/jql` (fallback `/rest/api/2/search`), `/rest/api/2/issue/{key}` | `work.comment`, `work.setState` via `/transitions` | low: same-origin REST with the session cookie |
| `board` | Jira | Agile `/rest/agile/1.0/board/{id}/issue` | `work.start` = assign to me plus a transition | board id per team goes in the pack |
| `tickets` | Jira (service project) | JQL over the support project | `work.comment` | none beyond `work` |
| `docs` | Confluence | `/wiki/rest/api/content/search?cql=`, or the v2 pages API | none at first | the same site cookie as Jira is assumed |
| `review` | GitHub | review requests and my PRs | `review.comment`, `review.vote` | **`api.github.com` probably ignores the github.com session cookie.** Options: a fine-grained token kept by the local gateway, or github.com's own page data |
| `ci` | Jenkins | `/api/json?tree=…` on jobs and builds | rebuild via POST with a crumb from `/crumbIssuer/api/json` | low if Jenkins uses the browser session; SSO may redirect |
| `chat` | Slack | `app.slack.com`'s web API (`conversations.*`) | `chat.post` | **The web client's token is internal** and may break or be against workspace policy. Ask the Slack admins about an approved app first |
| `cal` | Zoom or the calendar | meetings for today plus join links | none | Zoom's REST API needs OAuth; the meeting list probably comes from whatever calendar the team uses |
| `mail` | not in the tool list | leave it out of `pack.json` | | |
| `time` | unknown | if time is logged in Jira, use worklogs or the timesheet app's API | `time.fill` | depends on the tool |

## Order

1. `work`, `board`, `tickets` and `docs`: one Atlassian session covers all four.
2. `ci`: Jenkins, same pattern.
3. `review`: decide the GitHub auth question first.
4. `chat`: only after the Slack question is settled.
5. `cal`: last. The page works without it.
