Outlook mail and calendar of the person, read through Outlook on the web.
- `bridge_snapshot` concept `mail`: the latest inbox and sent mail, each with sender, subject, preview and a
  category: `auto`, `wait`, `fyi` or `reply`; concept `cal`: the meetings this week and next.
- `bridge_get {concept: "mail", id}`: one message with its body and attachment names.
- `mail.send` sends as the person. A run drafts the mail; the person sends it, unless "runs can" is ticked.
- `signin_required` means Outlook is signed out in the console's browser; say so instead of retrying.
