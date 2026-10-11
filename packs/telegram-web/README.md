# telegram-web

The person's own Telegram account through a signed-in Telegram Web K tab (`web.telegram.org/k/`): the chats a
workspace lists, their messages, and `tg.post`.

The script calls the page's own managers (`window.rootScope.managers`): `apiManager.invokeApi('messages.getHistory')`
to read, `appMessagesManager.sendText` to post. It never types into the page and never touches the session's keys.
Reading marks nothing as read.

## Scope

The pack is scoped: `chat` by its `id`, `tg.post` by its `chat` arg. It serves only the chat ids the workspace's
`grants.json` lists under `scopes["telegram-web"]`; with none listed it serves nothing. The console checks the list
before and after the pack, and the pack checks it again. Ids are Web K peer ids as strings: a user is positive, a
group or channel negative (`-1234567890`). The chat's id is the number after `#` in its Web K address.

A basic group that Telegram upgrades to a supergroup gets a new id. Every call on the old id then fails with
`chat_migrated`, naming the new id; adding it to `scopes` is one Approval. Nothing is sent to the new id before that.

## Config

None.

## Hosts

`web.telegram.org`.

## Concepts

| Concept | Every | Cap | Source |
|---|---|---|---|
| `chat` | 30 s | 20 | One item per listed chat: name, kind, the last message. `unread` is always 0 and `mentioned` false |

`get chat <id>` returns the latest 50 messages newest first, each with its author and whether that is me, a bot or a
person, plus `cursor` for the older ones.

## Actions

| Action | Args | Done when |
|---|---|---|
| `tg.post` | `{chat, text}` posts plain text, at most 4096 characters | a new message of mine is in the chat's history on the server, within 10 s; else `unknown`, and it is never retried |
