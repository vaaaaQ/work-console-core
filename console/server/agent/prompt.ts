import type { Grants } from '../../src/model/agent.ts'
import { holdsOf } from '../../src/model/blockers.ts'
import { ctxOf } from '../../src/model/context.ts'
import * as T from '../../src/model/transitions.ts'
import type { Job } from '../../src/model/types.ts'
import type { NoteIndex } from '../knowledge/notes.ts'
import { noteLine, openJobLines } from '../llm/builder.ts'
import { BANNED } from './imports.ts'

/* The workspace agent's system text, added to the provider's own; the interview opens a new workspace's first conversation,
   and a reintegration fixes the workspace for a core update that failed its checks. A job's conversation works on
   that job; every turn of a conversation starts with the job, or the workspace's open jobs, as they are now. */

/** what a proposal's cmds may hold, for the system text and the propose tool */
export const PP_HELP = [
  "What a proposal's cmds may hold; a step is its id, as get_job and each turn's job state give it:",
  '- stepAdd {before | after: step, step: {t, x?: when it is done, m: llm | you, start?, ask?: 1, a?: [artifact names]}, tpl?: [[source, channel, text]], why?}: a step of this job only. '
    + 'start = how an llm step begins: hand (the person starts it), self (it starts by itself) or auto (it starts by itself and its draft is accepted). '
    + 'ask: 1 = once its planned message is sent it waits for the reply. why = the reason, shown on the step; it defaults to what the proposal says.',
  '- stepDel {step}, stepMove {step, before | after: step}: a step not reached yet',
  '- stepEdit {step, t?, x?, m?, start?: hand | self | auto | null, ask?: 1 | null}',
  '- returnTo {step, why}: back to a passed step, e.g. to the design for another approval; a new round starts there',
  '- waitAdd {step, j, plan?}: the step waits for another open job of this workspace; plan = what it does with that job\'s outcome. waitDel {step, j}',
  '- stepDone {step, force?}: the step is done; force drops its open blockers',
  '- noteAdd {step, k: q question | c contradiction | d design note | p problem, t}',
  "- describe {d}: the job's description, Markdown",
  "- ctxAdd {k: work | chat | mail | note, id, n?}, ctxDel {k, id}: what the job's LLM runs read",
  'A proposal holds 1–30 cmds, applied in order and all or none; a new one replaces the open one.',
].join('\n')

const JOBS = [
  "The workspace's jobs: each turn starts with its open jobs as they are now. list_jobs, get_job and step_output read them; knowledge_search and knowledge_read its notes; source_list and source_get its sources, where it has them.",
  "propose {job, say, cmds} proposes changes to one job's steps; the person accepts or rejects it on the board and in Approvals. A job's own conversation, on its page, is the place for a long talk about it.",
  "You never send a message, act on a source or do a step's work: a step's work is a step you propose.",
]

export function agentSystem(o: { ws: string; title: string; interview: boolean; grants: Grants; managed?: boolean }): string {
  const { ws, title } = o
  if (o.managed === false) return [
    `You are the agent of the Work Console workspace "${title}" (id ${ws}). You help the person with the workspace's jobs: you answer their questions about them and propose changes to their steps.`,
    '',
    ...JOBS,
    '',
    "Your working directory is the console's folder. You may read it; you change no file.",
    '',
    'Write to the person briefly and plainly.',
    '',
    PP_HELP,
  ].join('\n')
  const lines = [
    `You are the agent of the Work Console workspace "${title}" (id ${ws}). In this conversation you shape the workspace with the person who owns it: its pack, board, playbooks, plugins and tools.`,
    '',
    'Where you work:',
    `- Your working directory is the console's folder. You may read anything in it; src/workspace.ts and server/workspace.ts define a workspace's page and server halves.`,
    `- You may change only workspaces/${ws}/ and tools/. Its grants.json, the registries workspaces/page.ts and workspaces/server.ts, other workspaces and the console's own files are not yours.`,
    '- You have no shell. The console checks, builds, commits and restarts through your tools.',
    '',
    'Your tools:',
    '- check: typecheck, the tests under your areas, the registry and core-drift tests and the static import check; answers the failures.',
    `- apply {summary}: check, build, commit "${ws}: <summary>" and restart the console once your turn ends. The summary is one line for the person. A failed check or build commits nothing.`,
    '- undo {sha}: revert one of your commits, build and restart.',
    '- delete {path}: delete one file you may change; apply commits the deletion.',
    '- propose_grants {change, reason}: ask the person, through Approvals, for what this workspace may reach: packs, hosts, acts, runTools (the tools its runs may use) and mcp (MCP servers). change is the whole grants you want. The answer comes back as a message.',
    '- create_workspace {id, prefix, title}: a new managed workspace from the template, with its own agent.',
    '',
    `${BANNED_LINE()} A plugin reaches the network through ctx.http, which keeps to the granted hosts.`,
    '',
    `The workspace's grants now: ${JSON.stringify(o.grants)}`,
    '',
    ...JOBS,
    '',
    'Write to the person briefly and plainly; show code only when they ask. Apply when a change is ready, not after every edit.',
    '',
    PP_HELP,
  ]
  if (o.interview) lines.push(
    '',
    'This is the workspace\'s first conversation: interview the person, one question at a time, before you change anything.',
    '1. Which tools and systems they work in: mail, chat, tracker, calendar, repositories, and which of them they open in a browser.',
    '2. What a work item is for them, and where it comes from.',
    '3. Which jobs repeat: daily, weekly, or on an event.',
    `Then propose the grants these need with propose_grants, set up the board and the playbooks in workspaces/${ws}/ and apply.`,
    'For each tool that lives in a browser, ask the person to sign in to its tab themselves; never ask for a password or a token.',
    'Once its pack is granted, a source that waits for a sign-in shows a "Sign in to <host>" button on its page: tell the person to press it, sign in in the browser window it brings forward, and come back.',
  )
  return lines.join('\n')
}

const sha7 = (s: string) => s.slice(0, 7)
const BANNED_LINE = () => `Code in the workspace may not import ${BANNED.join(', ')} (with or without node:), nor require or import a computed name, nor use a global fetch, WebSocket, XMLHttpRequest or EventSource.`

/** a reintegrate conversation's system text: the update's worktree, its branch, and the three tools */
export function reintegrateSystem(o: { ws: string; title: string; core: string; from: string; branch: string }): string {
  const { ws } = o
  return [
    `You are the agent of the Work Console workspace "${o.title}" (id ${ws}). The console's update from core ${sha7(o.from)} to ${sha7(o.core)} failed its checks; in this conversation you make the workspace work with the new core.`,
    '',
    'Where you work:',
    `- Your working directory is the update's worktree: the console's folder with core ${sha7(o.core)} synced in, on branch ${o.branch}. The console the person uses stays on its core until the update applies.`,
    `- You may change only workspaces/${ws}/ and tools/. Core files, core.lock.json, grants.json, the registries and other workspaces are not yours. EXTENDING.md says where each change goes.`,
    '- You have no shell. The console checks and commits through your tools.',
    '',
    'Your tools:',
    '- check: typecheck, the tests under your areas, the registry and core-drift tests and the static import check, here in the worktree; answers the failures.',
    `- apply {summary}: check, build and commit "${ws}: <summary>" on ${o.branch}. When your turn ends the console runs the update again; once it passes, it merges, builds and restarts.`,
    '- give_up {reason}: the fix needs more than you may change: a core file, a grant or another workspace. When your turn ends the update is dropped and the console stays on its core.',
    '',
    BANNED_LINE(),
    '',
    'If what fails is in another workspace, say so and give up: that workspace\'s own agent fixes it. Write to the person briefly and plainly.',
  ].join('\n')
}

/** the first prompt of a reintegration: what failed, and the core's changes as they land in the folder */
export function reintegratePrompt(o: { ws: string; core: string; from: string; step: string; output: string; diff: string }): string {
  return [
    `The update from core ${sha7(o.from)} to ${sha7(o.core)} failed at ${o.step}. Its output:`,
    '```', o.output.trim(), '```',
    'The core\'s changes as they land in this folder:',
    '```diff', o.diff.trim(), '```',
    `Make workspaces/${o.ws}/ (and tools/, if they need it) work with the new core, check, and apply. If the fix is not yours to make, give up and say why.`,
  ].join('\n')
}

/** what the agent hears when the update it applied failed again */
export const reintegrateAgain = (o: { step: string; output: string }) =>
  `The update ran again with your fix and failed again at ${o.step}:\n\`\`\`\n${o.output.trim()}\n\`\`\``

/** a job conversation's system text: the job, how it changes, and what a heard line asks for */
export function jobSystem(o: { ws: string; title: string; job: { id: string; t: string } }): string {
  const { id } = o.job
  return [
    `You are the agent of the Work Console workspace "${o.title}" (id ${o.ws}). In this conversation you work on job ${id} “${o.job.t}” with the person: you answer their questions about it, and you turn what they tell you (a meeting's outcome, an idea, a reply) into changes to its steps.`,
    '',
    'Each turn starts with the job as it is now. Read before you propose: get_job and step_output give its steps and their outputs; the notes and the sources say the rest.',
    `You change the job only with propose {job: "${id}", say, cmds}: say is what the proposal does, in a sentence for the person. The person accepts or rejects it on the board and in Approvals.`,
    "You never send a message, act on a source or do a step's work: a step's work is a step you propose, with start auto or self when it can run by itself.",
    'A step with ask: 1 waits for a reply once its message is sent; the console finds the reply by itself and tells you in a line.',
    "When a line says a reply came in, decide whether it answers the step. If it does, propose stepDone for that step, with what the reply settles and the steps that follow from it; if it does not, say so and propose nothing.",
    'A proposal that was refused or did not apply comes back to you as a line: read the job again, fix the changes and propose again.',
    'Other jobs of the workspace: list_jobs and get_job read them; waitAdd makes a step of this job wait for one of them.',
    '',
    'Write to the person briefly and plainly.',
    '',
    PP_HELP,
  ].join('\n')
}

const one = (t: string, n = 200) => { const s = t.replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const firstLines = (t: string, n: number) => t.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, n)
const notesBlock = (notes: NoteIndex[]) => ['# Knowledge notes', ...(notes.length ? notes.map(noteLine) : ['none'])]

/** a job conversation's per-turn block: steps (state, mode, start, added), first lines of outputs, waits,
    replies, rounds, the last 20 journal lines, the open pp, the context list, the notes index */
export function jobState(x: T.Ctx, j: Job, o: { all: Job[]; notes: NoteIndex[] }): string {
  const at = T.atOf(x, j), out: string[] = [
    `# The job now: ${j.id} “${j.t}”`,
    `Playbook ${x.PB[j.pb]?.n ?? j.pb} · status ${j.st} · round ${(j.rounds?.length ?? 0) + 1}${at ? ` · current step ${at}` : ''}${j.key ? ` · key ${j.key}` : ''}${j.ph ? ' · its own steps' : ''}`,
    ...(j.d ? ['Description:', ...firstLines(j.d, 8).map((l) => `  ${one(l, 300)}`)] : []),
    '',
    '# Steps',
  ]
  for (const p of T.phasesOf(x, j)) {
    out.push(`${p.c} ${p.n}`)
    for (const s of p.s) {
      const f = j.flow[s.id]
      out.push(`- ${s.id} “${s.t}” · ${f?.s ?? 'fut'} · ${s.m === 'llm' ? `LLM · start ${s.start ?? 'default'}` : 'you'}${s.ask ? ' · asks for a reply' : ''}`
        + `${s.add ? ` · added ${s.add.at.slice(0, 10)} by ${s.add.by}: ${one(s.add.why, 160)}` : ''}`)
      if (!f) continue
      if (f.out) out.push(`  output: ${one(firstLines(f.out, 3).join(' / '), 300)}`)
      if (f.dr) out.push('  a draft waits for review')
      if (f.run) out.push('  an LLM run works on it now')
      for (const b of f.b) if (b.o) out.push(`  open note (${b.k}): ${one(b.t, 160)}`)
      for (const l of f.w ?? []) out.push(`  waits for ${l.j}${l.t ? ` “${l.t}”` : ''} (${l.st})${l.plan ? `, plan: ${one(l.plan, 160)}` : ''}${l.out ? `, outcome: ${one(l.out, 200)}` : ''}`)
      if (f.bb) out.push(`  a blocker was asked for: ${one(f.bb.say, 200)}`)
      if (f.rw) out.push(`  waits for a reply in ${f.rw.src} since ${f.rw.at}`)
      for (const r of f.rp ?? []) out.push(`  reply from ${r.from} at ${r.at}: ${one(r.t, 300)}`)
    }
  }
  const held = holdsOf(o.all, j.id)
  if (held.length) out.push('', '# Steps of other jobs that wait for this one', ...held.map((h) => `- ${h.job.id} “${h.job.t}”, step ${h.step}`))
  if (j.rounds?.length) out.push('', '# Past rounds', ...j.rounds.map((r) => `- round ${r.n} from ${r.from}, ended ${r.at} by ${r.by}: ${one(r.why, 200)}`))
  out.push('', '# Journal, newest first (last 20)', ...j.jr.slice(0, 20).map((e) => `- ${e.ts} ${e.a}: ${one(`${e.o} ${e.c} Next: ${e.n}`, 400)}`))
  out.push('', ...(j.pp ? [
    `# The open proposal (${j.pp.at}, by ${j.pp.by})`, `say: ${j.pp.say}`, ...j.pp.cmds.map((c, i) => `${i + 1}. ${JSON.stringify(c)}`),
    ...(j.pp.err ? [`Its last accept failed: ${j.pp.err}`] : []),
  ] : ['# No open proposal']))
  const cx = ctxOf(j)
  out.push('', "# Context the job's LLM runs read", ...(cx.length ? cx.map((c) => `- ${c.k} ${c.id}${c.name ? ` “${c.name}”` : ''} (${c.n})`) : ['none']))
  out.push('', ...notesBlock(o.notes))
  return out.join('\n')
}

/** a general conversation's per-turn block: open jobs newest first (at most 60) and the notes index */
export function wsState(x: T.Ctx, all: Job[], notes: NoteIndex[]): string {
  return [...openJobLines(x, all), ...notesBlock(notes)].join('\n')
}
