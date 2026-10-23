# AD-0017: auto steps, the one-time approval (okCmds) and retry {to, max} fix rounds

Where the scope comes from:
- AD-0015 `followups.md` §2 and `analysis.md` rev 3, concerns 2, 3 and 5, with Valery's answers of 2026-10-15: one
  approval also covers core, fix rounds have a playbook limit with a default of 3, and the PR opens as usual.
- The core at `a2101d4`, the base of `job/ad-0017`. Paths are under `console/`.
- The agents-dev playbook in `D:\agents\services\work-console\workspaces\agents-dev\page.ts`.

This job changes the **core only**. agents-dev's own playbook moves to the new fields in AD-0019 (playbook v2). This job
proves the fields with a test playbook in the demo workspace.

## What exists today

| Fact | Where |
|---|---|
| A step's `start` is `'hand' \| 'self' \| 'auto'`; absent follows the workspace's `autoAsk`. `auto` = the run starts by itself and the console accepts its clean draft. | `src/model/types.ts:22-27`; `server/llm/autoAsk.ts:13,92` |
| `holdOf` holds the automatic accept on: an outcome (`not_done`/`failed`), commands to approve (`cm`), a draft that reports approved commands (`ap`), an open question, a problem note, a blocker asked for, open blockers. | `server/llm/autoAsk.ts:16-26` |
| A failed draft with `rt` goes back on Accept (`returnTo` → a new **round**); without `rt` the step stays open. | `src/model/transitions.ts:672-685`, `:273-294` |
| **Gap:** an `acceptDraft` that goes back does not make the console ask the step it went back to: `madeCurrent` counts only steps that were `fut`/`tpl` before, and the returned-to step was `done`. A fix round would stall at its first step. | `server/llm/autoAsk.ts:37-41` |
| Only the person approves commands: `runner.reply(…, 'approve', {via})` throws `not_yours` for any `via`. The approval is a reply that makes the draft's own session run exactly `cm`, then hand in a new draft with `ap: 1`. | `server/llm/runner.ts:186-212`; `src/model/transitions.ts:761-781` |
| A page Accept of a draft that has `cm` and no outcome **closes the step although its commands never ran** (concern 5). Nothing checks the step's `a` artifacts. | `src/model/transitions.ts:686-691` |
| A run's prompt shows earlier steps' accepted drafts (`## Earlier outputs`) and the journal. After a `returnTo` the failed step's text is only in the kept round and in one journal line. | `server/llm/prompt.ts:45-64` |
| A job's work dir is a worktree on `job/<id>` from the repo its project names, base `main` (core) or `master` (agents). | `server/llm/worktree.ts:11-57`; agents-dev `server.ts:27-30` |

## What changes and why

### 1. Auto steps that really go on by themselves

**Why:** `start: 'auto'` exists, but a job of auto steps still stops at three points. Every command needs Valery's
approval. A draft that ran approved commands is held for him to read. A failed check either waits for him or goes back and
then stalls.

- **Fix the stall.** `madeCurrent` also counts an `acceptDraft` whose draft had `rt` and that made `rt` current. The
  console then asks that step when its `start` is `self` or `auto`, as it already does for `returnTo` and `stepReopen`.
  This also fixes the case where a person accepts a failed draft by hand.
- A draft that reports commands the **console** approved under `okCmds` (§2) is not held for `ap`. One the person
  approved is still held, as today.
- No new "gate" field. The job stops for Valery where a step is `self` or `m: 'you'`, or where `holdOf` holds. AD-0015
  rejected a `gate` flag as the same thing in another spelling.

### 2. The one-time approval: `okCmds`

**Why:** in the PR flow every ship step (push, open PR, merge, deploy) waits on an approval of commands Valery already
agreed to when he accepted the analysis.

- **Playbook field.** `Playbook.ok?: { at: string; cmds: string[] }`:
  - `at` is the step whose Accept grants the list (agents-dev: Analysis).
  - `cmds` are command templates. The only placeholders are `{branch}` and `{base}`, which the console fills from the
    job's work dir (`WorkDir.branch`, and a new `WorkDir.base`, which is the `RepoSpec.base` of the job's project).
  - With these, core and agents jobs share one list, since the same text fills to `main` or `master`.
  - A template with any other `{…}` is refused when the playbook loads.
  - Up to `CMDS_MAX` (10) templates.
- **Granting.** When the **person** accepts step `at` from the page (not `auto` and not `said`), the console fills the
  templates and stores `job.ok = { cmds, at, by }`.
  - The journal says "Approved for this job: N commands: …".
  - Before he accepts, the draft card of step `at` lists the filled commands: "Accepting also approves these commands for
    this job". So he sees exactly what he approves.
  - Without a work dir, or with a template that does not fill, nothing is granted, and the card says why.
- **Using it.** When a run hands in a draft whose `cm` are **all** in `job.ok.cmds` (exact text after trimming), the console
  approves them itself:
  - It calls `runner.reply(…, 'approve', { via: 'console' })`, and `Run.ap` / `Draft.ap` record `'ok'` instead of `1`.
  - This works on any llm step whose draft came from a session (not one handed in by hand, `hd`).
  - The journal says "Approved N commands under this job's one-time approval: …".
  - One command outside the list, and the whole draft waits for Valery as today.
- **Withdrawing.**
  - A new page op `okDrop` drops `job.ok`. Approvals shows the job's list with Withdraw.
  - A `returnTo` to step `at` or before it also drops `job.ok`, because the shape is approved again.
- **Rule.** Sessions still never approve anything: `draft_reply` with `approve` stays refused, and only the console's own
  path, which `via: 'console'` marks, may approve, and only within `job.ok`. `CLAUDE.md` gets a fourth exception that
  says this.
- **What it is not.** It is not a shell allowlist. The commands still run in the draft's session, with its grants. A
  playbook simply does not list what must always stop. For agents-dev that is the console's own `update.ps1` (AD-0019).

### 3. Fix rounds: `retry: { to, max }`

**Why:** a failed live check should go back to Build, fix, redeploy and re-check by itself, without looping forever.

- **Step field.** `Step.retry?: { to: string; max?: number }`. `max` defaults to **3** and runs 1–10. When the playbook
  loads, it is refused unless `to` is an earlier step and the step is an llm step.
- **Handing in.** When a run hands in `outcome: failed` on a step with `retry` and names no `return_to`, the draft
  gets `rt = retry.to`. The draft card shows where it goes back to, even for a person.
- **The console accepts it by itself** when all of these hold:
  - the step is `start: 'auto'`;
  - the draft is `failed` with `rt === retry.to`;
  - the job has had fewer than `max` fix rounds;
  - nothing else in `holdOf` holds it (no question, problem note, blocker or unapproved `cm`).
- **Holding.** `holdOf` keeps holding `not_done`, a `failed` draft without `retry`, a `failed` draft whose `rt` is
  another step, and a `failed` draft at the limit.
  - At the limit the hold reads "the job has had its 3 fix rounds".
  - "When the run asks" means it opened a question or problem note. That holds already, and AD-0018 adds the question tool.
- **Counting.** `Round` gets `fx?: 1` on a round the console opened for a retry.
  - Fix rounds are counted **per job**, across all `retry` steps: the `fx` rounds after the last round a person opened.
  - A round the person opens (a Reject at Look at it live, a Return to, a reopen that goes back) does not count, and it
    **resets the count to 0**. That was Valery's answer to question 4.
- **Every fix round leaves a record.**
  - A journal line: "Fix round 2 of 3: “Live check” failed, back to “Build”: <why>".
  - An artifact `fix-round-<n>.md` on the failed step, written by the console. It holds the round number and the limit,
    the failed step, where the job went back to and why, and the failed draft's full text. It is a plain `Art` today and
    becomes AD-0016's typed `fix-round` output when that lands.
  - The first run of the round gets a `## Fix round <n> of <max>` section in its prompt with the same text, so the
    fix starts from the cause and not from one journal line.
- A step without `retry` behaves exactly as today.

### 4. Stricter step completion (concern 5A): folded in, because it is small and §2 needs it

**Why:** a page Accept of a draft that waits for commands closes the step although nothing ran.

- `acceptDraft` of a draft with `cm` (not `ap`) is refused with `bad_state`: "approve its commands, or say you ran them".
- A new flag `ran: true`, available only on the page, lets the person accept it anyway. This covers commands Valery runs
  outside the console, such as `update.ps1`.
  - The journal then says "Accepted … ; you ran its N commands yourself".
  - The page's Accept on such a draft becomes **Approve** and **I ran them**.
- `auto` and `said` never close a draft with `cm`.
- **Concern 5B (expected artifacts block done) stays with AD-0016**, as AD-0015 planned. It needs typed outputs.

## Files that change

- `src/model/types.ts`:
  - `Playbook.ok`, `Step.retry`, `Job.ok`, `Round.fx`;
  - `Run.ap` and `Draft.ap` become `1 | 'ok'`;
  - `acceptDraft.ran`, op `okDrop`.
- `src/model/transitions.ts`:
  - grant on accept, `okDrop`;
  - the `retry` default `rt` in `report`;
  - `fx` in `returnTo`, which also drops `ok` when it goes back to `at` or before;
  - the `cm` rule in `acceptDraft`;
  - a playbook check for `ok` and `retry`.
- `server/llm/autoAsk.ts`:
  - `madeCurrent` for an `acceptDraft` that goes back;
  - `holdOf(f, step, job)` for retry, the limit and `ap: 'ok'`;
  - auto-approve under `job.ok`.
- `server/llm/runner.ts`: `reply` takes `via: 'console'` for `approve` only when every command is in `job.ok`.
- `server/llm/worktree.ts`: `WorkDir.base`.
- `server/llm/prompt.ts`: the `## Fix round` section.
- The fix-round artifact is written next to the run's artifacts (`server/llm/runner.ts`, where `Art` files are written).
- Page:
  - the draft card's "also approves" list;
  - Approve and I ran them;
  - the fix-round line in Rounds;
  - the job's approval with Withdraw in Approvals.
- `docs/architecture.md` (jobs and steps), `CLAUDE.md` (fourth exception), `EXTENDING.md` (the playbook fields).
- The demo workspace: a test playbook `auto-ship` in Acme with `ok` and `retry`, with example hosts only.

## How it will be proven

**Unit tests**, each failing first:
- `transitions.test.ts`:
  - grant on a person's Accept of `at`, not on `auto` or `said`;
  - a template that does not fill grants nothing;
  - `okDrop`, and the drop on a `returnTo` to `at`;
  - `retry` gives `rt`;
  - `fx` counting, and a person's Return to resets it;
  - Accept of a `cm` draft refused, and accepted with `ran`;
  - the playbook check refuses a bad `to`, `max` or placeholder.
- `autoAsk.test.ts`:
  - an `acceptDraft` with `rt` asks the returned-to step (the stall);
  - a failed auto draft goes back by itself 3 times and the 4th is held, with the limit text;
  - `not_done` is held;
  - a failed draft with an open question is held;
  - every `cm` in `ok` is approved by the console, one outside it waits;
  - a draft with `ap: 'ok'` is accepted and one with `ap: 1` is held.
- `runner.test.ts` and `app.test.ts`: `approve` with `via: 'console'` outside `job.ok` gives 403, and `via: 'session'` is
  still refused.
- `mcp.test.ts`: a session still cannot approve.
- `prompt.test.ts`: the fix-round section.
- `npm test`, `npm run typecheck`, `npm run build && npm run smoke`, all green.

**Live, on this PC** (the Prove step), on a scratch console from the job branch: its own `WORK_CONSOLE_HOME` and port,
the demo workspace, the `auto-ship` test playbook, and real Claude runs whose commands are harmless (`git status`,
`echo`). I will quote the journal for each, and take a screenshot of each changed view:
1. Accept Analysis: the journal shows the filled commands granted.
2. An auto step's `echo` command draft is approved by the console and runs, and the step goes on by itself.
3. A command off the list waits, and its Accept shows Approve and I ran them.
4. A step told to fail goes back 3 times, each with its journal line and `fix-round-<n>.md`, and the 4th failure waits
   with "the job has had its 3 fix rounds".

5. After that, your own Return to resets the count: the next failure goes back by itself again, as round 1 of 3.

The live proof uses **real Claude runs** (answer 7).

## Decisions (Valery, 2026-10-18, answers to the open questions of the first draft)

1. **`{pr}`: no.** Valery answered "-". The placeholders stay `{branch}` and `{base}`, and the merge is
   `gh pr merge {branch} --merge`. This job does not wait on AD-0016.
2. **Exact match: yes.** A command that differs in any way from the list waits for Valery.
3. **Only `failed` retries: yes.** `not_done` always waits for Valery.
4. **A person's round resets the fix-round count: yes** (see Counting in §3).
5. **Auto timers after a restart: leave them.** A draft caught by a restart waits for Valery. No sweep on start.
6. **No time limit on the approval.** It lasts until Withdraw, or until the job goes back to Analysis.
7. **The live proof uses real Claude runs**, not a fake provider.

No open questions remain.

## What the implementation found (TDD step, 2026-10-23)

Where the code differs from the plan above, and why:

1. **The work dir's branch and base live on the job (`Job.wd`).** The runner names them in `runStart` as each run starts
   (`WorkDir.branch` and the new `WorkDir.base`). The transitions are pure and run on the page too, so the grant fills from
   `Job.wd`, and the draft card shows the same filled list. A job with no run in a work dir yet grants nothing, and the
   card and journal say so.
2. **`Round.fx` is `{ n, max, step }`**, not `1`, so Rounds, the prompt and the artifact can name the round without
   working it out again.
3. **The artifact is `fix-round-<k>.md`, where `k` counts every fix round of the job.** The count shown ("Fix round 1 of 3")
   starts again after your own round, so naming the file by it would overwrite an earlier file.
4. **A loop guard.** A draft from an approved run (`ap` set) that asks for commands again waits for you, even when they
   are on the list. Without the guard, a session that keeps asking for `git status` would loop.
5. **An Accept of a draft with commands is refused whenever it has `cm`,** including one that reports approved commands
   and then asks for new ones.
6. **The transitions refuse the console's own accept** of a `not_done` draft, and of a `failed` one that its retry does not
   cover or that is at the limit. Before, only `holdOf` stopped it. Two old tests that accepted such drafts with `auto`
   now expect the refusal.
7. **A lapse is journaled.** "The one-time approval of N commands lapsed" appears when a return goes to `ok.at` or before.
8. **The `## Fix round` section goes only to the step the round went back to** (the round's first step), not to the steps
   after it.
9. **The demo playbook is Acme's `auto-ship`.** Its commands are harmless: `git status`, `git log --oneline -1 {branch}` and
   `echo ship {branch} onto {base}`. It is the playbook for the live proof.
