# m365-teams

Chats and their messages from a signed-in Teams web tab, and `chat.post`.

The script uses the Microsoft Graph access token that the tab's own sign-in library (MSAL) keeps in
`localStorage`. It sends the token as a bearer header from inside the tab and never returns it. A
`get` cursor is accepted only when it is Graph's own next link for the same chat.

## Config

| Key | Default | Meaning |
|---|---|---|
| `host` | `teams.microsoft.com` | The Teams web site: `teams.microsoft.com` or `teams.cloud.microsoft` |

## Hosts

`{host}` (the tab), `graph.microsoft.com`.

## Concepts

| Concept | Every | Cap | Source | Token scope (any one) |
|---|---|---|---|---|
| `chat` | 5 s | 50 | The 50 chats with the latest messages: name, kind, unread, the last message, and whether an unread message mentions me | `Chat.ReadWrite`, `Chat.Read` |

`get chat <id>` returns the latest 50 messages oldest first, each with its author and whether that is
me, a bot or a person, plus `cursor` for the older ones. The mention lookup for unread chats is cached
in the tab per last message and stops after 2.5 s, so a slow Graph never stalls the list.

## Actions

| Action | Args | Token scope (any one) |
|---|---|---|
| `chat.post` | `{chat, text}` posts the text as HTML | `Chat.ReadWrite`, `ChatMessage.Send` |

A draft is Markdown, so `chat.post` turns it into HTML: `[label](url)` with an http(s) URL is a link,
`**bold**` is bold, `` `code` `` is code, `1. ` and `- ` lines are lists, a blank line parts paragraphs
and a single newline breaks the line. `&`, `<` and `>` are escaped and backslashes stay as written, so a
UNC path survives. The 28 000 limit applies to the HTML too.
