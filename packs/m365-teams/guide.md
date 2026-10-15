Microsoft Teams chats of the person, read through Teams on the web.
- `bridge_snapshot` concept `chat`: the recent chats, with their name, unread count and last message.
- `bridge_get {concept: "chat", id}` (with `pack: "m365-teams"` while another pack also serves chat): the
  messages of one chat; `cursor` pages back.
- `chat.post {chat, text}` or `{chatName, text}` posts as the person. A run drafts; the person sends, unless
  "runs can" is ticked.
- `signin_required` means Teams is signed out in the console's browser; say so instead of retrying.
