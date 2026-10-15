One Azure DevOps project, read as the person through dev.azure.com.
- Concepts: `work` (work items assigned to the person and not done, plus watched ones), `review` (active pull
  requests the person reviews or wrote, plus watched ones), `ci` (builds requested for the person, plus watched
  ones), `board` (the team board's items by column and lane: mine, qa, free).
- `bridge_get {concept: "work", id}`: one work item with its description, fields and comments;
  `{concept: "review", id}`: one pull request with its threads.
- Acts: `work.setState {id, state}`, `work.comment {id, text}`, `review.vote {id, vote}` (vote 10, 5, 0, -5 or -10),
  `review.comment {id, text, threadId?}`. A run drafts them; the person runs
  them, unless "runs can" is ticked.
- `signin_required` means dev.azure.com is signed out in the console's browser; say so instead of retrying.
