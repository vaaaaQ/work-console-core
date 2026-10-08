# m365-mail

Mail and calendar from a signed-in Outlook on the web tab, and `mail.send`.

The script uses the access token that the tab's own sign-in library (MSAL) keeps in `localStorage`.
It sends the token as a bearer header from inside the tab and never returns it. It calls Microsoft
Graph when the tab holds a live Graph token for the scope. Otherwise it calls Outlook REST v2 with an
Outlook token. Outlook REST has no message headers, so there a mailing-list mail is recognised only by
its sender.

## Config

| Key | Default | Meaning |
|---|---|---|
| `host` | `outlook.office.com` | The Outlook on the web site: `outlook.office.com`, `outlook.office365.com` or `outlook.cloud.microsoft` |

## Hosts

`{host}` (the tab), `graph.microsoft.com`, `outlook.office.com` (Outlook REST).

## Concepts

| Concept | Every | Cap | Source | Token scope (any one) |
|---|---|---|---|---|
| `mail` | 10 s | 100 | The latest 50 in Inbox and 50 in Sent, each with a category: `auto`, `wait`, `fyi` or `reply` | `Mail.Read`, `Mail.ReadWrite` |
| `cal` | 60 s | 200 | This week and next, from Monday in the call's zone | `Calendars.Read`, `Calendars.ReadWrite` |

`get mail <id>` returns the body as text and the attachment names.

## Actions

| Action | Args | Token scope |
|---|---|---|
| `mail.send` | `{text, replyTo}` replies to a message; `{text, to[], cc[]?, subject}` sends a new mail | `Mail.Send` |
