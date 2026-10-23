# AD-0016: Typed step outputs

Branch, PR and checks, review, deploy, live check and fix round become typed records on a step. The page shows them
and later runs' prompts carry them. All of this lives in the core (Work Console Core, this repo). The agents-dev
playbook only declares which step produces which kind, and that change goes through a sync job in `D:\agents`.

Read from the core at `a2101d4` (the base of `job/ad-0016`). Each claim names the file it comes from.

## Why

A step's output today is one Markdown blob. On accept, the draft's text becomes `Flow.out` (`src/model/transitions.ts`
`acceptDraft`, lines 676/687). Every later prompt carries all of them under `## Earlier outputs`
(`server/llm/prompt.ts` line 45), whole and unparsed. So:

- **A later run has to dig facts out of prose.** "Merge and push" has to find the branch and the last tested commit
  in the TDD step's text. "Deploy" has to work out what was merged. "Smoke test" has to work out which version it
  should see. When a draft words a fact loosely ("the branch", no sha), the run guesses.
- **The page cannot show state at a glance.** To see whether a PR's checks passed, which build is deployed, or
  whether the live check passed, Valery opens each step and reads its output.
- **Rounds lose their reason.** When Smoke test fails and the job goes back to Build, `returnTo` keeps the round's `why`
  (one line) and the old flow (`Round`, `src/model/types.ts`). The next pass's prompt gets the journal line and nothing
  structured: which check failed, against which version, and which commit came before the fix.
- **Nothing checks that a step produced what it must.** A "Deploy" draft with no version in it can be accepted as done.

## What changes

### 1. Fact kinds (core, `src/model/facts.ts`, new)

A fixed set of kinds. Each kind is a generic development concept: it names no workplace, host or product, so the
core rule holds. Every string is trimmed and capped. URLs must be http(s), and any other URL is refused.

| kind | fields | who writes it |
|---|---|---|
| `branch` | `repo`, `name`, `sha`, `base?` | a run (TDD, Merge) |
| `pr` | `url`, `n?`, `title?`, `state`: open/merged/closed, `checks`: `[{name, state: pass/fail/pending, url?}]` | a run (Merge) |
| `review` | `by`, `verdict`: accepted/sent_back, `of?` (the sha reviewed), `note?` | the console, when a person closes a review step (see 4) |
| `deploy` | `what`, `where`, `version`, `ok`, `url?` | a run (Deploy) |
| `check` | `name`, `ok`, `against?` (the version it ran against), `url?` / `art?` (an artifact of the step), `note?` | a run (Prove it live, Smoke test) |
| `round` | `n`, `back_to`, `why`, `failed`: the names of the failed checks | the console, on a return (see 5) |

A fact always carries `at` and the step that made it. The console adds these; a run never writes them.

`Draft.fx?: Fact[]` holds what a draft reports. `Flow.fx?: Fact[]` holds what an accepted draft left on its step. Both are
optional JSON in the job document. The pg store keeps a job as `doc jsonb` (`server/store/pg.ts:61`), and the file
store writes JSON, so no migration is needed.

### 2. A step declares what it must produce

`Step.fx?: FactKind[]` (and `NewStep.fx`, the playbook file's `facts:`, and `stepAdd`/`stepEdit` checks like the
existing `out`). A draft whose outcome is done must carry at least one fact of each declared kind. Otherwise
`report()` in `transitions.ts` refuses it while the run is still live (`bad_args: "Deploy" reports a deploy`), the
same way a bad `return_to` is refused today. A draft that reports not_done or failed does not need the declared
kinds. A step that declares nothing may still report any facts.

### 3. How a run reports facts

- `submit_draft` gets an optional `facts` array. In `server/llm/sdk.ts` it is a zod discriminated union on `kind`
  (`REPORT_SCHEMA`, `reportOf`). Claude runs and Cursor runs both use `runToolDefs`, so both get it with one change.
- A session taken up by hand gets the same `facts` property on the console MCP's `submit_draft` (`server/mcp/mcp.ts:215`).
- `runDraft`/`draftIn` carry `fx` through `DraftReport`. Editing a draft on the page keeps its facts. If someone
  needs to correct a fact, they reject the draft with a note.
- On accept, `F.fx = dr.fx`, in both branches of `acceptDraft`. A draft that reports not done keeps its facts on the
  open step, because they are real evidence, for example a failed check.

### 4. Review: written by the console

"Review" (`ad5`) is a `you` step, so no run drafts it. The console writes the `review` fact itself:
- `stepDone` on a step that declares `review`: `{by: <who>, verdict: accepted, of: <the latest branch sha>}`.
- `returnTo`/`stepReopen` while such a step is current, or right after it: `{verdict: sent_back, note: why}`. This
  fact goes into the kept round, so the next pass sees that the last review sent the change back and why.

### 5. Fix round: written by the console

When `returnTo` starts a new round, the console adds a `round` fact to the step the job goes back to:
`{n, back_to, why, failed}`. `failed` lists the names of the `check` facts with `ok: false` from the draft that
sent it back. A round started by hand (`stepReopen`) gets a `round` fact with an empty `failed` list.

### 6. Earlier facts in later prompts (`server/llm/prompt.ts`)

A new section, `## Facts`, goes before `## Earlier outputs`:
- **This round:** the latest fact of each kind, one line each, each with the step that made it, e.g.
  `- branch job/ad-0016 at 3f2c9e1 (repo core; from "TDD on the job branch")`,
  `- pr [#41](url) open; checks: build pass, test fail ([test](url))`,
  `- deploy console at core 3f2c9e1 on this PC: ok`.
- **Earlier rounds:** one line per round:
  `- round 1 → back to "TDD on the job branch": smoke "rounds view" failed against 3f2c9e1; review sent_back: …`.
  A run doing a fix can then see which version failed and which check to make pass.
- How to work gets one more line when the step declares kinds:
  `- This step reports facts with submit_draft(facts): branch, pr. A done draft without them is refused.`

`## Earlier outputs` stays as it is, so the prose is still there. Facts add to it and replace nothing. The run's
`context()` and `step_context` share `parts()`, so both get the section for free. The agent's `step_output` tool
(`server/agent/jobTools.ts`) lists the step's facts as well.

### 7. The page

- **Drawer:** a `Facts` section above the draft and the accepted output (`src/views/Drawer.tsx`, `LlmSec`). Each fact is
  one row with a lamp: a branch with its sha (copy button); a PR link with one lamp per check; a deploy's version and
  where it went; a live check pass/fail with its link or artifact; a review verdict. A waiting draft shows the facts
  it would leave.
- **Job header:** one strip with the latest fact of each kind across the job: `branch · PR #41 ✓3 ✗1 · deployed 3f2c9e1 ·
  live check ✓`. This is the "where is it" view without opening a step.
- **Rounds** (`src/views/Rounds.tsx`): a round's row shows its `round` fact (why it went back and which checks
  failed), and its detail shows each step's facts.
- **Demo:** one Acme demo job gets facts, so they show without a backend. Hosts end in `.example`.

### 8. agents-dev (not in this job's diff)

The agents-dev playbook lives in `D:\agents\services\work-console\workspaces\agents-dev\page.ts`, a consumer.
After the core sync, a follow-up agents job sets `fx`: ad3 `branch`; ad4 `check`; ad5 `review`; ad6 `branch`, `pr`;
ad7 `deploy`; ad8 `check`. The Merge, Deploy and Smoke test texts then refer to the facts ("deploy the `branch` sha";
"`against` is the deployed `version`").

## How it will be proven

**Tests (TDD step), each failing first:**
- `facts.test.ts`: each kind validates. A non-http URL, a missing required field, an unknown kind and an over-cap
  string are each refused, with a message the run can act on.
- `transitions.test.ts`:
  - a done draft without a declared kind is refused;
  - a not_done draft without it is accepted;
  - accept copies `fx`, and an edited accept keeps it;
  - `stepDone` on a review step writes `review` with the latest branch sha;
  - `returnTo` writes `round` with the failed checks, and the kept round keeps the old facts;
  - a removed or added step does not bring facts back (the `ns` rule).
- `prompt.test.ts`: `## Facts` lists the latest fact of each kind per round and earlier rounds one line each, and
  the How to work line names the declared kinds. There is no section when there are no facts.
- `sdk.test.ts` / `mcp.test.ts`: `facts` reaches `runDraft`/`draftIn` through both tools, and a bad fact comes back
  as the tool's error.
- `playbookFile.test.ts`: `facts:` round-trips. `core-lock` and the workspace tests stay green.
- `npm test`, `npm run typecheck`, `npm run build && npm run smoke`. The smoke's fake SDK submits a `branch` fact,
  and the smoke asserts it is on the job.

**Live (Prove it live):** run the console from the job branch with the demo workspace. Take screenshots of the drawer's
Facts section (with a waiting draft and with an accepted output), the job header strip, and an expanded round with
its `round` fact. Then run one real LLM step on a scratch Acme job whose step declares `branch`. Its first draft
without the fact is refused, which shows in the run feed, and its retry is accepted. Quote the prompt's `## Facts`
section from the next step's run record.

**After deploy (Smoke test):** on the deployed console, the next agents-dev job shows its branch and deploy facts on
the page. The core version is `core.lock.json`'s `core` field.

## Open questions (notes)

1. **PR checks go stale.** A `pr` fact is a snapshot taken when the draft was submitted. Should the page refresh check
   states through the `ci`/`review` concepts? I suggest no for v1: agents-dev has no sources (`src: {}`), and the
   Smoke test step reads them anyway. Later, a pack could update them.
2. **Should a missing declared kind be refused?** Refusing is the proposal, as with `return_to`. The softer option
   is a warning on the draft (`reports no deploy`) that still lets it through. Refusing does block a step whose
   honest result has nothing to report, for example a deploy skipped because only docs changed. For that, a fact
   could carry `none: why`, e.g. `{kind: 'deploy', none: 'docs only'}`. Is that acceptable?
3. **Review written by the console.** Is a page-side Mark done enough for `review`? Or should Review get Accept /
   Send back buttons with a note, so the note becomes the fact's `note`?
4. **`{var}` in templates.** Should facts fill message templates (`{branch}`, `{pr}`, `{deploy.version}` in `tvars`,
   `src/model/world.ts:180`)? Not needed for agents-dev, but it fits other workspaces' messages (a "deployed X"
   chat post). I suggest leaving it out of v1.
5. **The kind list is fixed in the core.** Can a workspace add its own kinds? I suggest no: the six kinds cover this
   job, and a free-form kind is just `Flow.out` again.
6. **Language.** This spec is in English, like AD-0013. AD-0026's spec was in Russian. Tell me if you prefer that.

## Valery's answers (2026-10-23)

1. No refresh in v1: a `pr` fact stays the snapshot taken at submit.
2. Refuse a done draft that lacks a declared kind; an honest empty result reports `{kind, none: why}` (e.g. `{kind: 'deploy', none: 'docs only'}`).
3. Review gets **Accept / Send back** buttons with a note field; the note becomes the `review` fact's `note`, and Send back goes back like a return.
4. No facts in message templates (`{var}`) in v1.
5. The six kinds stay fixed in the core; no workspace kinds.
6. Specs stay in English.
