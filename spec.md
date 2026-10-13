# AD-0013: Drafts link their evidence

## Problem

Runs name builds, releases, PRs, work items and pages by number or by plain name ("build 286944", "release 24610",
"USIE Connect"), even when they fetched the URL or already had it in the prompt. Valery then has to ask for the links
(J-0006, Deploy to dev: the Teams message to Venu took two extra rounds just to add them).

## What I found in the core (branch base 143aab7)

1. **The prompt never asks for links.** The "How to work" lists in `server/llm/prompt.ts` (`buildPrompt` and
   `manualText`) say nothing about URLs. When a step's draft is an outgoing message, the `messageAlone` line covers
   the message's form, but not links.
2. **The prompt leaves out links it already has.** Every bridge item schema has a `link` (`ci.item` requires one,
   and the azure-devops pack builds `…/_build/results?buildId=` when ADO gives none; `work.get` and `review.get` have one too).
   But `contextSection` (`src/model/context.ts`) prints only the label and the text: `Resolved` keeps `k, id, n, name,
   status, text` and drops the reply's `link`. So the job's own work item, PR or chat reaches the run without its URL.
   Asking for links from "the context" can only work once the context carries them.
3. **How a link reaches the reader depends on where the message goes.**
   - On the page, drafts render as Markdown (`src/lib/md.ts` renders `[text](url)` as `<a>` for http(s) and mailto links).
     So a Markdown link in a draft already shows on the page with the name as its visible text.
   - The core `m365-teams` pack posts `chat.post` as `contentType: 'text'`, and `m365-mail` sends `contentType: 'Text'`.
     So if an act sends the draft, `[USIE Connect](https://…)` reaches Teams or Outlook as literal brackets. When Valery
     copies from the rendered page, the link comes along. When the act sends it, it does not.
   - ADO PR thread comments are Markdown, so they work as written. Work item comments are HTML, and a Markdown link
     stays literal there.

## What changes

### A. The rule (core, `server/llm/prompt.ts`)

A new constant `LINKS_LINE`, put in both How to work lists right before the `submit_draft` line, so the same text
is in the run prompt and in the manual session text:

> - Before you submit, check each thing the draft names as evidence (a build, pipeline run, release or its failed stage
>   or log, a PR, commit, work item, chat, mail or page). Where you know its URL, write it as a Markdown link with the
>   name as its text: [build 286944](url), not "build 286944" with the URL next to it or left out. A URL you know is one
>   you fetched in this run, one the context or knowledge above gives, or one you build from a pattern a knowledge note
>   gives. Never guess one. Where you know no URL, leave the plain name.

When the draft is an outgoing message, `messageAlone` adds one clause: links go on the names in the message itself
(visible text = the name), never as a list of bare URLs.

Why a prompt rule and not a post-check: the run is the only party that knows what it fetched. A checker that greps
the draft for "build \d+" would have to invent URLs, which the rule forbids, or nag about every number.

### B. Context items carry their link (core, `src/model/context.ts`)

- `Resolved` gets an optional `link`. `okItem` takes it from the reply's `link` when it is an http(s) string, and
  otherwise leaves it out (a pack never sends secrets in it; `scrub` already covers replies).
- `contextSection` writes `Link: <url>` as the first line under an item's heading when it has one.
- `contextText` (the run's `context()` tool) uses the same section, so it gets the link with no extra change.

Without B, the J-0006 case (the job's own release or PR given as context) still has nothing to link.

### C. URL patterns per workspace (knowledge, not code)

A workspace knowledge note, proposed through `knowledge_propose` for the IAEA workspace, not core: "ADO link
patterns", with `{org}/{project}` verified against a link the pack returned:
`_build/results?buildId={id}` (plus `&view=logs&j=…` for a log only when it was read),
`_releaseProgress?releaseId={r}&_a=release-environment-logs&environmentId={e}`, `_git/{repo}/pullrequest/{id}`,
`_git/{repo}/commit/{sha}`, `_workitems/edit/{id}`. The rule in A points at "a pattern a knowledge note gives". The
core stays free of any workplace name, and a run builds links only from patterns that someone verified.

### D. Delivery (decision needed, see Q1)

The core's Teams and mail acts send plain text, so a link put on a name reaches the reader only through copy from the
page. My proposal is a small, separate pack change: `chat.post` and `mail.send` turn `[text](http…)` into `<a href>`,
escape everything else, and send `html` only when the text holds such a link. Plain messages go out exactly as today.
Work item comments get the same conversion. PR comments stay Markdown.

## Then

Commit on job/ad-0013, merge to the core, and sync the IAEA consumer with `sync-core.mjs` (`work-console: core <sha>`).
`core-lock.test.ts` stays green because only core files change there.

## How it will be proven

| What | Proof |
|---|---|
| The rule is in the prompt | `runner.test.ts` `PROMPT` pin gets the `LINKS_LINE` line in its place; `prompt.test.ts` asserts it in `manualText` as well, and the `messageAlone` clause only for a step whose draft is sent |
| Context links | `context.test.ts`: an `okItem` with `link: 'https://ci.example/…'` renders `Link: https://ci.example/…` under its heading; a non-http link and a missing one render nothing |
| No regressions | `npm test`, `npm run typecheck`, `node --test "packs/**/test/*.test.mjs"` |
| D (if accepted) | pack tests: a text with `[x](https://a.example)` posts `contentType: 'html'` with `<a href="https://a.example">x</a>` and escaped `<`/`&`; a text without links posts `text`, exactly as today |
| Done-when, live | After the sync, a fresh IAEA run that reports a build, release or PR (re-ask the J-0006 kind of step). Its draft shows each of them as a working link on the page without anyone asking, and I quote the draft and open one link of each kind |

## Open questions (notes)

- **Q1: Delivery (D).** Is D part of this job, or a follow-up? Without it, the "link on the name" requirement for an
  outgoing Teams message holds only when Valery copies the message from the page. Does IAEA post through the core
  `m365-teams` pack, or through its own? I could not read the iaea-pc console from here.
- **Q2: The IAEA pattern note.** I can verify `{org}/{project}` and the release `environmentId` only from a link the
  IAEA ADO pack returned. Should Build propose the note from a real IAEA run's reply, or do you have the org URL to put
  in now?
- **Q3: Wording placement.** One line in How to work for every run, including steps with no outgoing message, such as
  an analysis like this one. Links there help too, so I would not limit it to message steps.
- **Q4: Revise rounds.** The rule is in the session's first prompt, so a `revise` reply in the same session keeps it.
  A run that is restarted (not resumed) gets it again from `buildPrompt`. I see nothing to add to `replyPrompt`.
