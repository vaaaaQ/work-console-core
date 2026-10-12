# AD-0005 — Restart Build after a design re-approval

## What happens today (reproduced)

The job is from the IAEA workspace (playbook `usie-dev-item`: Analysis → Tech design → **Build** (im1–im3) → Pull request (pr1 “Open the PR”…) → QA).
The live IAEA console runs on iaea-pc, so its job record could not be read from here. The same playbook (same step ids) is the core's demo `dev-item`, and the bug reproduces there exactly:

```
job at pr1 “Open the PR”
stepReopen td1  → td1:cur td2:done im1:done im2:done im3:done pr1:cur   ← two live steps
stepDone   td1  → nx pr1, journal: “step done; “Open the PR” is next.”
```

### Why

- On the page, a passed step shows one button: **Reopen step** (`views/Drawer.tsx` `StepActs` → op `stepReopen`).
- `stepReopen` (`src/model/transitions.ts`) only sets **that one step** back to `cur`. Every later step keeps its state: Build stays `done` and “Open the PR” stays `cur`.
- When the design is done again, `advance()` moves to `atOf()`, the **first live step**. Build is done, so that is the still-current “Open the PR”. Nothing marks the old build as invalid.
- The correct mechanism already exists: `returnTo`. It keeps the current pass as a round and restarts every step from the target step on as blank (AD-0001's round 2 went through Analysis → TDD again). But the page never offers it. Only sessions (MCP) and proposals can use it.

## What changes

1. **Core, `stepReopen` on a passed step becomes a return.** When the step being reopened has a later step that was already reached (anything not `fut`/`tpl`), `stepReopen` does what `returnTo` does:
   - the current pass is kept as a round (history, drafts and outputs are not lost);
   - every step from the reopened one on starts blank. Build and PR come back as not reached, and open notes and live blockers carry over as `returnTo` already does;
   - the journal says “Returned to “Technical design”: …, N steps from it on start again”.
   - The reason: `stepReopen` gains an optional `why`. Without one it defaults to `reopened “<step>”`.
   - A step with nothing reached after it (for example the last step, as when AD-0003 reopened Deploy) reopens exactly as it does today.
2. **Page.** For a passed step that has reached steps after it, the button reads **Go back to this step…**. It asks for an optional reason and says that the later steps start again. For other steps it stays “Reopen step”.
3. **MCP `command` description.** The `stepReopen` line notes that reopening a passed step restarts the steps after it.
4. **Auto-ask.** `madeCurrent` already treats a step moved onto from `fut` as made current. So after the re-approval, “Branch from develop” / the TDD step becomes current and a `self`/`auto` LLM step there is asked by itself. `stepReopen` routed as a return is added to the same rule as `returnTo`, so a reopened `auto` step is asked as well.

Nothing else moves: `advance`, `atOf` and `returnTo` stay as they are. The rule depends only on step order, not on step names, so it covers “design” in any playbook, not only `usie-dev-item`.

## How it will be proven

- **Failing test first** (`transitions.test.ts`, demo `dev-item`): take the job to pr1, `stepReopen td1`, then `stepDone td1` (and the same through `runDraft` + `acceptDraft`). Expected: next step `td2`, then `im1`. Build steps are `fut`, `pr1` is not live, a round is kept, and `atOf` never jumps over Build. It fails today with `nx = pr1`.
- Also tested: reopening the last step with nothing after it is unchanged; a run in flight refuses the reopen (`bad_state`, as `returnTo` does); `madeCurrent` for the reopened step; the Drawer label.
- `npm test` and `npm run typecheck` green; `core-lock` is untouched in this repo.
- **Live**: after merge, sync the core into `D:\agents\services\work-console` and run `update.ps1`, which Valery runs outside the console. On the deployed console, a scratch job on a two-phase playbook goes reopen design → done and lands on Build. Screenshots of the button and the board column before and after.

## Open questions (notes)

- **Q1.** Should the page require a reason for going back (as `returnTo` does), or should it stay optional with the default text? The proposal is optional.
- **Q2.** Already-sent planned messages of the restarted steps (e.g. pr2 “Post in USIE DEV”) are planned again in the new round. That matches `returnTo` and fits a new PR. Is that OK?
- **Q3.** The IAEA job that already went past Build stays as it is: the fix does not rewrite stored jobs. After the deploy, “Go back to this step” on its Build step (or a session `returnTo`) repairs it. Is it enough to name the job, or should the fix do this?
- **Q4.** Deploy target: the IAEA console runs on iaea-pc. Is the live check there, or is the home console enough for the proof plus a core sync to iaea-pc afterwards?
