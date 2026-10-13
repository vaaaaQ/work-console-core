# AD-0012 — One Approve button on a draft that waits for commands

## Why

Some steps let a run prepare a command but not run it until the person says so. In the agents-dev
playbook, Merge and push (ad6) and Deploy (ad7) say: *"run them only after an instruction approves that
exact command; until then the draft is the command"*. AD-0009 is an example. Its draft was one
`git push`, marked "Needs Valery's OK".

Today the only way to approve is to type a reply in the draft's conversation that repeats each command
word for word. That is slow, typos are easy, and nothing ties the approval to the commands the draft
actually showed. The console reads nothing from the draft's words (architecture.md, LLM runs), so it
cannot offer a button.

## What changes

The draft names its commands in a structured field. The page shows them as a list with one **Approve**
button. The backend turns that click into a reply that approves exactly those commands, in that order,
in the draft's own session. Everything is generic core: no workplace, tool or host is named.

```
run ── submit_draft {text, commands:[c1,c2]} ──▶ Flow.dr = {t, at, cm:[c1,c2]}
                                                   │ page: list + [Approve] [Accept] [Edit…] [Reject…]
person ── Approve ─▶ POST /api/runs/<id>/reply {intent:'approve', at}
                                                   │ server builds q from dr.cm (never from the page)
                                    runReply ─▶ same session: "run exactly c1, c2 …"
run ── runs them, quotes output ── submit_draft {text}   (no commands) ─▶ normal draft, Accept
```

### 1. The draft carries its commands (model + run tools)

- `DraftReport` and `Draft` gain `cm?: string[]`: the exact commands the draft waits to have approved.
  - 1 to 10 commands. Each is trimmed and non-empty, at most 2000 characters, and may span lines.
  - A bad list is `bad_args` while the run can still fix it, the same way a bad `return_to` is.
- `runDraft` and `draftIn` store `cm`. A revised draft without commands clears it.
- The journal line says "…is ready; waits for approval of N commands".
- `submit_draft` in `server/llm/sdk.ts` gets `commands: z.array(z.string()).optional()`.
  - `reportOf` hands it on.
  - Cursor's run server uses the same `runToolDefs`, so it gets the field too.
  - The tool text: *"commands: when the step's instruction says a command runs only after it is approved,
    the exact commands, in order, that this draft waits to run. Leave it out otherwise. The text still
    says what each one does."*
- An auto step (`start: 'auto'`) never accepts a draft that has `cm`. It holds the draft for the
  person, as it already does for `not_done`/`failed`.

### 2. Approve: a fourth reply intent, built on the server

- `RunIntent` gains `approve`. The page calls `POST /api/runs/<id>/reply {intent: 'approve', at}`. Any `t`
  it sends is ignored.
- `runner.reply` with `approve` checks:
  - the step's draft has `cm`, otherwise 409 `no_commands`;
  - `at` equals `dr.at`, otherwise 409 `stale`, so a draft revised after the page drew it is never
    approved blind;
  - the reply comes from the page. `via: 'session' | 'console'` gets 403 `not_yours`. An LLM, whether a
    Claude Code session through MCP `draft_reply` or the console's own agent, never approves its own
    commands. `draft_reply`'s intent enum leaves `approve` out.
- `q` is built from `dr.cm`: `Approved, run exactly these commands, in this order:\n1. …\n2. …`. It is
  the record of what was approved, and it shows in the conversation as "You · approve".
- `REPLY_TAIL.approve` in `prompt.ts` reads: *"Run exactly these commands, in this order, and nothing else
  that needs approval. Stop at the first that fails. Then call submit_draft with what each one printed.
  If one failed, set outcome failed. A further command that needs approval goes in commands again."*
- `runReply` journals `Approved N commands for "<step>": c1; c2`, then "LLM runs them", then "wait for it".
- An `approve` turn does not auto-accept the next draft. The person reviews the output and accepts it.
  The playbook says the step is not done until the command has run and its output is quoted.

### 3. The page

- The draft card in the step inspector (`Drawer.tsx`) and in Approvals (`ApCard`) show, when `dr.cm` is set:
  - a "Waits for approval of N commands" heading and a numbered monospace list;
  - **Approve** as the primary button. Accept becomes a secondary button and keeps its meaning: keep the
    draft as the output without running anything.
- Approve is hidden when the draft has no session to continue (the same condition as DraftTalk's box).
  It is disabled while a run is on the step.
- Approve is one click with no modal. The list right above it is what gets approved, and the server
  takes the list from the stored draft, not from the page.
- Live only, like the conversation. The demo draws the list but has no Approve.

### 4. Notifications (Valery: yes)

- `Notifier.run` in `server/notify/notify.ts`, for a run that ended as `draft`:
  - when the step's draft has `cm`, the push says `<job> · <step>: N commands wait for approval`
    instead of `draft ready` / `draft revised`;
  - the body is the commands, numbered and cut to 200 characters as bodies already are;
  - the URL is the same step link.
- `Notifier.needsYou`: a job whose current draft has `cm` says `commands to approve` instead of
  `a draft to review`.
- A draft without `cm` pushes exactly as today.

### 5. Docs

- architecture.md, "Replies to a draft": an `approve` row, the three refusals, and `commands` beside
  `outcome` in "LLM runs".
- architecture.md, "Notifications": the commands push.
- gateway-protocol.md: not touched. This is the console's own API, not the gateway.

### Not in this job

- **The agents-dev playbook text** lives in `D:\agents` (`ASK` in `workspaces/agents-dev/page.ts`) and
  should say "list each in submit_draft's commands". That is a consumer change, a follow-up agents job
  after the core sync. Until then runs learn the field only from the tool description. The same
  follow-up must keep the console's own `update.ps1` **out** of `commands` (see "Run permissions" below).
- **Partial approval** (tick some commands, not others) is left out. Reject with a reason, or a typed
  reply, still covers it.

## How it will be proven

| Check | Where |
|---|---|
| `runDraft`/`draftIn` store `cm`, refuse 0, 11, empty, non-string and >2000-character commands, clear `cm` on a revision without commands, and journal the count | `src/model/transitions.test.ts` |
| An auto step holds a draft with `cm` for the person | `transitions.test.ts` / `runner.test.ts` |
| `submit_draft` takes `commands` and `reportOf` hands it on. Cursor's server lists the same schema | `server/llm/sdk.test.ts`, `cursor/serve.test.ts` |
| `replyPrompt(q, 'approve')` ends with the approve tail | `server/llm/prompt.test.ts` |
| `reply(..., 'approve')` builds `q` from the stored list, resumes the session and does not accept. It refuses `no_commands`, `stale` and via session/console | `server/llm/runner.test.ts` |
| `POST /api/runs/:id/reply {intent:'approve', at}` works, ignores `t`, and gives 409 on a stale `at` | `server/http/app.test.ts` |
| MCP `draft_reply` refuses `approve` | `server/mcp/mcp.test.ts` |
| A draft with `cm` pushes "N commands wait for approval" with the numbered commands as the body, and `needsYou` says "commands to approve". A draft without `cm` pushes as before | `server/notify/notify.test.ts` |
| `npm test`, `npm run typecheck`, `npm run build && npm run smoke` all green | console |
| **Live (Prove it live):** a console built from the job branch on a spare port, with a scripted SDK whose first turn submits a draft with two commands and whose reply turn submits their "output". Screenshots: the inspector card with the list and Approve, the same card in Approvals, the conversation after the click ("You · approve" plus the numbered list), and the journal line. Also quote the prompt the reply turn received | proof/ |

## Decisions (Valery's reply to the first draft)

1. **One click**, no confirm dialog.
2. **Drafts handed in by hand** through MCP `submit_draft` carry `commands` too. Approve stays hidden on
   them because there is no session to continue.
3. **Cap of 10 commands** a draft.
4. **Notifications:** yes, a draft that waits for commands gets its own push (section 4).
5. **Run permissions:** checked; see below.

## Run permissions on agents-dev (checked 2026-10-12, from inside this run)

Approve does not widen a run's tools, so it only works for commands the workspace already lets a run
execute. Here is what agents-dev's runs can do today:

| What | Finding |
|---|---|
| Tools | `D:\agents\services\work-console\workspaces\agents-dev\grants.json` gives `runTools` plain `Bash` and `PowerShell`, with no command patterns. The core `DENY` list only blocks paths with `.bridge`, `.work-console`, `console.token` or `mcp.token` in them, so `git push`, `python …05-deploy-app.py` and `08-deploy-jobs.py` are not denied. There is no `.claude/settings.json` in `D:\agents`, `D:\work-console-core` or the worktree to add deny rules. |
| `git push`, core | From this run in `D:\agents-jobs\AD-0012`: `git push --dry-run origin HEAD:refs/heads/ad-0012-dryrun-probe` → `* [new branch] HEAD -> ad-0012-dryrun-probe`, exit 0. Auth works without a prompt (`GIT_TERMINAL_PROMPT=0`). It was a dry run, so nothing was pushed. |
| `git push`, agents | The same dry run in `D:\agents-jobs\AD-0009` against `vaaaaQ/agents-platform`: exit 0. Nothing was pushed. |
| Azure (05/08) | `az account show` → `Azure subscription 1  valery.hilimovich@gmail.com`, exit 0. |
| Python (05/08) | `python --version` → `Python 3.12.10`. The WindowsApps path is a real interpreter, not the Store stub, and `import yaml` works. |
| **Console deploy** | `powershell -NoProfile -File services/work-console/scripts/update.ps1` is not denied, but it stops the console that hosts the run (task `WorkConsole`, Running), which kills the run halfway. The ad7 text already says "Valery runs it outside the console". **So `update.ps1` must never go in `commands`**: an approved one would cut off its own run. The core cannot know this (it names no workplace), so the agents-dev follow-up states it in the playbook text, and the draft keeps that command as text for Valery to run. |

So Approve works on agents-dev today for `git push` and the 05/08 deploys, and must not be used for
the console's own update.
