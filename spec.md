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

A knowledge note for the IAEA workspace, "ADO link patterns", proposed through `knowledge_propose` (not core).
As Valery decided, Build takes `{org}/{project}` (and the release `environmentId` form) from the `link` a real IAEA
run's ADO reply returned, and from nothing else:
`_build/results?buildId={id}` (plus `&view=logs&j=…` for a log only when it was read),
`_releaseProgress?releaseId={r}&_a=release-environment-logs&environmentId={e}`, `_git/{repo}/pullrequest/{id}`,
`_git/{repo}/commit/{sha}`, `_workitems/edit/{id}`. The rule in A points at "a pattern a knowledge note gives". The
core stays free of any workplace name, and a run builds links only from patterns that someone verified.

### D. Delivery: links survive the send (in this job)

Today the core's Teams and mail acts send plain text, so a link put on a name arrives as literal `[name](url)`.

- A helper in the packs, `mdLinks(text)`, finds `[text](https://…)` (also `http:` and `mailto:`). When there is
  none, it returns null and the act sends exactly what it sends today. When there is one, it returns HTML: each link
  becomes `<a href="url">text</a>`, every other character is escaped (`& < > "`), and line breaks become `<br>`.
  Nothing else in Markdown is converted, so `**` stays as it is today. `[x](javascript:…)` stays as text.
- `m365-teams` `chat.post`: `contentType: 'html'` with that HTML when there are links.
- `m365-mail` `mail.send` (a new mail and a reply): `contentType: 'HTML'` the same way.
- `azure-devops` `work.comment` (work item comments are HTML): the same conversion. `review.comment` (PR threads
  are Markdown) stays as it is.
- Packs load as single files in the tab, so the helper is copied into each one. Build checks whether they can share
  one file instead. Nothing changes in `/api/act`, the bridge or the gateway protocol: the act still carries `text`.

**How to check whether IAEA sends through the pack.** An act goes page → `/api/act` → the workspace's source → the
pack that declares the action (`server/bridge/actions.ts`, `actionPacks`). So, on iaea-pc, in the IAEA consumer's console:

1. `console/workspaces/iaea/server.ts`: its `source`. A gateway URL means the gateway's packs; loaded packs mean `packs/`.
2. The workspace's `grants.json` → `packs`: which pack names are granted. Then, in `packs/<name>/` (or the gateway's
   pack dir), which manifest declares `chat.post`. If it is the core's `m365-teams`, D covers it. If it is a pack of
   IAEA's own, that pack needs the same `mdLinks` change, in the IAEA repo.
3. `console/workspaces/iaea/ui.tsx`: whether a page-side act handler sends Teams messages some other way.

Build does this check first, from an iaea-pc session, and writes the answer in the journal.

### E. Plain web links in context, shown as artifacts you can open (added by Valery, 2026-10-15)

Today a context item can only be a work item, chat, mail or note (`CtxKind`). A login page or any other site cannot go in.

- **A new context kind `link`:** `{k: 'link', id: <http(s) URL>, name?: label}`. `ctxId` accepts only http(s) URLs
  (no `javascript:` or `file:`). The console never fetches the URL, through the bridge or any other way. A run gets the
  label and the URL (`### Link <name>` + `Link: <url>`), not the page. A run in a workspace with the runs' browser on
  may open it there, within that browser's allowlist. No new reading path.
- **Adding one:** on the page, the job's Context editor (`views/Context.tsx`, `actions/newjob.tsx`) gets "Link" next
  to work/chat/mail/note, with a URL field and an optional label. When the job builder (`server/llm/builder.ts`)
  gets a URL in the user's text, it puts it in `context` as a `link` item.
- **In a playbook:** a playbook file (`PbFile`, `src/model/pbFormat.ts`) gets an optional `links: [{name, url}]` for
  what every job of that kind needs, such as a login page. A job created from the playbook starts with those links in
  its context. The builder's new-playbook form (`npb`) can fill them in.
- **The job's Artifacts panel gets two groups (Valery, 2026-10-15): Input and Produced.** The panel is per job and
  sits next to Context (`views/Job.tsx`); today it lists every step's `arts`.
  - **Input**, what the job started from: every `link` item of the job and of its playbook, each shown as its label
    (or its host when it has no label). It opens the site in a new tab (`target=_blank`, `rel=noopener noreferrer`), not in the
    artifact viewer, which fetches files from `/api/artifacts`. These entries are read from the job's context; they are
    not stored as `arts`, so there is no new state and no migration.
  - **Produced**, what the steps made: the current list as it is today (name, step, ready/planned, download), with its
    "N/M ready" count. A playbook that produces no files keeps its "This playbook produces no files." line under Produced.
  - The two groups are headed sections in the same panel, so both show without a click. A group with nothing in it
    shows only its empty line, and Input is left out when the job has no links. Tabs inside the panel are the fallback if a
    long Input list pushes Produced out of view; I'd start with groups.
  - Input entries come from the context, never from the `artifact` op, so a run cannot add an external link through
    `add_artifact`. That keeps the "never guess a URL" rule.
  - So links are not tied to a step at all (this answers Q6).

## Then

Commit on job/ad-0013, merge to the core, and sync the IAEA consumer with `sync-core.mjs` (`work-console: core <sha>`).
`core-lock.test.ts` stays green because only core files change there. An IAEA-own pack change, if Q7 finds one, is a
separate commit in the IAEA repo.

## How it will be proven

| What | Proof |
|---|---|
| The rule (A) | `runner.test.ts` `PROMPT` pin gets the `LINKS_LINE` line in its place; `prompt.test.ts` asserts it in `manualText` as well, and the `messageAlone` clause only for a step whose draft is sent |
| Context links (B) | `context.test.ts`: an `okItem` with `link: 'https://ci.example/…'` renders `Link: https://ci.example/…` under its heading; a non-http link and a missing one render nothing |
| Delivery (D) | pack tests: a text with `[x](https://a.example)` posts `contentType: 'html'` with `<a href="https://a.example">x</a>` and escaped `<`/`&`; a text without links posts exactly what it posts today (Teams, mail send and reply, ADO work comment); `[x](javascript:…)` stays as text |
| Link context (E) | `transitions.test.ts`: `ctxAdd` with `k: 'link'` takes `https://login.example/` and refuses `javascript:` and `file:`; `prompt.test.ts`: the item renders its label and URL in Context; `pbFormat.test.ts`: a playbook's `links` reach a new job's context; `builder.test.ts`: a URL in the user's text becomes a `link` item; page test or smoke: the Artifacts panel shows an Input group with the link (`href` = the URL, `target=_blank`) above the Produced group, and no Input group for a job without links |
| No regressions | `npm test`, `npm run typecheck`, `npm run build && npm run smoke`, `node --test "packs/**/test/*.test.mjs"` |
| Done-when, live | After the sync, a fresh IAEA run that reports a build, release or PR (the J-0006 kind of step). Its draft shows each of them as a working link without anyone asking; I quote the draft and open one link of each kind. If D covers IAEA's sending pack, a Teams message Valery sends shows the name as a link (Valery sends; I don't). A job with a login-page link in its context shows it as an artifact that opens the page |

## Decided (Valery, 2026-10-15)

- E's links exist at both levels: a playbook's links (such as a login page) reach every job made from it, and a job
  adds its own.
- Artifacts are shown in two groups, Input (what the job started from) and Produced (what its steps made), instead of
  link artifacts on a step.
- IAEA has two sending packs, one for Outlook and one for Teams. Build checks whether they are the core's `m365-mail`
  and `m365-teams` (then D covers both) or IAEA's own (then the same change goes into each, in the IAEA repo).
- D is part of this job.
- The IAEA pattern note takes org and project from a real IAEA run's reply.
- The rule in A applies to every run, not only message steps.
- Revise rounds keep the rule from the session's first prompt; `replyPrompt` does not change.

- The Artifacts panel starts with two groups (Input, Produced), not tabs.
- On IAEA, sending goes, as far as Valery knows, through the pack he named "Remont Agent" (written as heard, perhaps a
  remote-agent pack). It is not in this core: nothing here is named like it. Build checks it on iaea-pc first.

## Open questions (notes)

- **Q7: Which pack sends on IAEA.** Build first finds, on iaea-pc, the pack that declares `chat.post` and
  `mail.send` for the IAEA workspace (the steps in D), and whether it is the "Remont Agent" pack. If that pack wraps
  the core's `m365-teams` and `m365-mail`, D covers it. If it posts by itself, the same `mdLinks` change goes into
  it, in the repo that owns it. The answer goes in the journal before any pack code changes.
