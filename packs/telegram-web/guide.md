Telegram chats of the person's own account, only the ones ticked as scopes; any other chat is invisible.
- `bridge_snapshot` concept `chat`: one item per ticked chat, with its name, last message and when.
- `bridge_get {concept: "chat", id, pack: "telegram-web"}`: the last 50 messages, newest first; `cursor` from the
  answer pages back. `pack` is needed while another pack also serves chat.
- A message with a file says what it is in `text` (`[document "acta.pdf", application/pdf, 127 KB]`) and lists it
  in `files`. Save one with `save_source_file {concept: "chat", id, file, pack: "telegram-web"}` only when its
  content matters to the step; the description is often enough. Over 20 MB answers `too_large`.
- An id is the chat's number as text; a group's is negative.
- `tg.post {chat, text}` posts as the person. A run drafts the text; the person sends it, unless "runs can" is ticked.
- `chat_migrated` means a group became a supergroup: its new id must be ticked in Settings → Packs.
- `signin_required` means Telegram Web is signed out in the console's browser; say so instead of retrying.
