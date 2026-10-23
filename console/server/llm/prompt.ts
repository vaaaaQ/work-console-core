import { BK } from '../../src/data/core.ts'
import { contextSection, ctxLabel, renderNote } from '../../src/model/context.ts'
import type { Resolved } from '../../src/model/context.ts'
import * as T from '../../src/model/transitions.ts'
import { factLine, factText, isNone, latestFacts, oneLine } from '../../src/model/facts.ts'
import type { CheckFact, Fact, RoundFact } from '../../src/model/facts.ts'
import type { Flow, Job, RunIntent, WaitLink } from '../../src/model/types.ts'
import type { Note } from '../knowledge/notes.ts'

/* What a run is told, read at its start so it can begin working instead of reading. The generated part
   comes first: the job and its step, its context items, its knowledge notes, earlier outputs and the
   journal, then how to work. The user's part comes last: the job's description, then the instruction.
   The pictures the context names come before the text. The run's context tool returns the same sections but
   how to work, and the pictures, read anew. */

/** the journal entries a prompt carries: the latest */
const JR_MAX = 20
/** the notes on a step a prompt carries, the latest, and the most of each one's text and of its answer */
export const NOTES_MAX = 20, NOTE_MAX = 500

/** ctx = the job's context items as read now; notes among them go under Knowledge with the playbook's (pbNotes).
    me = what the prompt calls the person the console works for; unset or empty: "the user".
    bridge false: the workspace has no gateway, so the prompt does not point at the bridge tools.
    knowledge: the run has the knowledge tools.
    images: how many pictures come before the prompt's text.
    workDir, branch: the job's own dir and the branch it is on, when the workspace gives each job one.
    sources: ## Sources, from the packs that are on.
    files: the run can save a source item's files */
export interface PromptIn { ctx?: Resolved[]; pbNotes?: Note[]; me?: string; bridge?: boolean; knowledge?: boolean; images?: number; workDir?: string; branch?: string; sources?: string; files?: boolean }

const who = (o: PromptIn) => o.me || 'the user'
const block = (h: string, rows: string[]) => (rows.length ? `${h}\n${rows.join('\n')}` : '')

/** a step's blockers for its run: what came of each closed one and what to do with it, then the open ones */
export function blockersText(f: Flow | undefined): string {
  const w = f?.w ?? [], name = (l: WaitLink) => `${l.j}${l.t ? ` ${l.t}` : ''}`
  return [
    ...w.filter((l) => l.st !== 'open').map((l) => [`### ${name(l)}: ${l.st}`, ...(l.plan ? [`Plan: ${l.plan}`] : []), `Outcome: ${l.out || 'none given'}`].join('\n')),
    ...w.filter((l) => l.st === 'open').map((l) => `- ${name(l)} is still open${l.plan ? `; plan: ${l.plan}` : ''}`),
  ].join('\n\n')
}

/** the facts a run is given: this round's latest of each kind, then one line per earlier round: why it went back,
    the checks that failed in it and against what, and a review that sent it back */
export function factsText(x: T.Ctx, j: Job): string {
  const title = (id: string) => T.stepOf(x, j, id)?.t ?? id
  const now = latestFacts(T.factsNow(x, j).filter((f) => f.kind !== 'round')).map((f) => `- ${factLine(f, title)}`)
  const rounds = j.rounds ?? [], all: Fact[] = [...rounds.flatMap((r) => Object.values(r.flow)), ...Object.values(j.flow)].flatMap((f) => f.fx ?? [])
  // a job that went back many times would fill the prompt: only the latest rounds, the rest counted
  const shown = rounds.slice(-ROUNDS_SHOWN), left = rounds.length - shown.length
  const past = shown.map((r) => {
    const rf = all.find((f): f is Fact & RoundFact => f.kind === 'round' && !isNone(f) && (f as RoundFact).n === r.n)
    const fx = Object.values(r.flow).flatMap((f) => f.fx ?? [])
    const bad = fx.filter((f): f is Fact & CheckFact => f.kind === 'check' && !isNone(f) && !(f as CheckFact).ok).map((f) => factText(f))
    const back = fx.filter((f) => f.kind === 'review' && !isNone(f) && (f as { verdict: string }).verdict === 'sent_back').map((f) => factText(f))
    const head = rf ? `round ${r.n} → back to "${title(rf.back_to)}": ${rf.why}` : `round ${r.n}: ${r.why}`
    // every part is a person's or a run's words: the line stays one line, whatever a kept round holds
    return rf || bad.length || back.length ? `- ${oneLine([head, ...bad, ...back].join('; '))}` : ''
  }).filter(Boolean)
  if (!now.length && !past.length) return ''
  const pastHead = left ? `Earlier rounds (the latest ${shown.length} of ${rounds.length}; ${left} older left out):` : 'Earlier rounds:'
  return ['## Facts', ...(now.length ? ['This round:', ...now] : []), ...(past.length ? [pastHead, ...past] : [])].join('\n')
}
/** how many earlier rounds ## Facts gives a line each */
export const ROUNDS_SHOWN = 5
/** the How to work line of a step that declares facts; how = how its session hands them in */
const factsRule = (x: T.Ctx, j: Job, step: string, how: string) => {
  const k = T.stepOf(x, j, step)?.fx ?? []
  return k.length ? [`- This step reports facts with ${how}: ${k.join(', ')}. A done draft without them is refused; when there is honestly nothing to report, give {kind, none: why}.`] : []
}

function parts(x: T.Ctx, j: Job, step: string, q: string, o: PromptIn) {
  const s = T.stepOf(x, j, step), pb = x.PB[j.pb], ctx = o.ctx ?? []
  const own = ctx.filter((r) => r.k === 'note'), mine = new Set(own.map((r) => r.id))
  const notes = [
    ...own.map((r) => `### ${ctxLabel(j.ws, r)} (note ${r.id}, this job's)${r.status === 'ok' ? '' : ' — unavailable'}\n${r.text}`),
    ...(o.pbNotes ?? []).filter((n) => !mine.has(n.id)).map((n) => `### ${n.title} (note ${n.id}, the playbook's)\n${renderNote(n)}`),
  ]
  const outs = T.stepsOf(x, j).filter((t) => j.flow[t.id]?.out).map((t) => `### ${t.t}\n${j.flow[t.id].out}`)
  const jr = j.jr.slice(0, JR_MAX).reverse().map((e) => `- ${e.ts} ${e.a}: ${e.o} → ${e.c} Next: ${e.n}`)
  const job = [
    `## Job ${j.id}: ${j.t}`,
    `Key: ${j.key} · playbook: ${pb?.n ?? j.pb} · project: ${j.prj}`,
    `Step: ${s?.t ?? step}`,
    `Exit criterion: ${s?.x ?? '-'}`,
    ...(s?.a?.length ? [`Expected artifacts: ${s.a.join(', ')}`] : []),
    ...(o.workDir ? [`Work dir: ${o.workDir}${o.branch ? ` (a git worktree on branch ${o.branch}, yours alone; commit there)` : ''}`] : []),
  ].join('\n')
  const bl = blockersText(j.flow[step]), rs = resent(x, j, step)
  const all = j.flow[step]?.b ?? [], kept = all.slice(-NOTES_MAX)
  const qs = kept.map((b) => `- ${BK[b.k].l}${b.o ? ` (open): ${T.line(b.t, NOTE_MAX)}` : `: ${T.line(b.t, NOTE_MAX)}${b.r ? ` → ${T.line(b.r, NOTE_MAX)}` : ''}`}`)
  const data = [
    job,
    contextSection(j.ws, ctx.filter((r) => r.k !== 'note')).trimEnd(),
    o.sources ?? '',
    notes.length ? `## Knowledge\n${notes.join('\n\n')}` : '',
    bl ? `## Blockers\n${bl}` : '',
    block(`## Questions on this step${all.length > kept.length ? ` (the latest ${kept.length} of ${all.length})` : ''}`, qs),
    factsText(x, j),
    outs.length ? `## Earlier outputs\n${outs.join('\n\n')}` : '',
    rs.section,
    block(`## Journal (oldest first${j.jr.length > JR_MAX ? `; the latest ${JR_MAX} of ${j.jr.length}` : ''})`, jr),
  ]
  const user = [
    j.d ? `## Description (from ${who(o)})\n${j.d}` : '',
    `## Instruction (from ${who(o)})\n${q}`,
  ]
  return { data, user, resend: rs.rule }
}

const join = (bs: string[]) => bs.filter(Boolean).join('\n\n')

/** the steps whose planned messages carry this step's accepted draft */
const senders = (x: T.Ctx, j: Job, step: string) => {
  const v = T.stepOf(x, j, step)?.out
  return v ? T.stepsOf(x, j).filter((t) => T.tplOf(x, j, t.id).some((m) => m[2].includes(`{${v}}`))) : []
}
/** the same, by title */
const sentBy = (x: T.Ctx, j: Job, step: string) => senders(x, j, step).map((t) => `"${t.t}"`)

/** the messages of this step, or of the steps that send its draft, that went out in an earlier round and go out again now */
function resent(x: T.Ctx, j: Job, step: string) {
  const own = T.stepOf(x, j, step), ss = [...(own ? [own] : []), ...senders(x, j, step).filter((t) => t.id !== step)]
  const rows = ss.flatMap((t) => T.sentBefore(j, t.id).map((m) => ({ ...m, s: t })))
  if (!rows.length) return { section: '', rule: '' }
  const why = [...new Set(rows.flatMap((r) => r.why))]
  return {
    section: `## Sent in an earlier round\n${rows.map((r) => `### ${r.s.t}, message ${r.i + 1}\nSent in round ${r.n} on ${r.at}: ${r.t}`).join('\n\n')}`,
    rule: `- A message this step's draft goes into went out in an earlier round (Sent in an earlier round above). The new one is a resend: write it so it says briefly what changed since then, `
      + `that is why the job went back (${why.join('; ')}) and what is new, rather than repeating the old text.`,
  }
}
/** draft = how the session names what it hands in; remarks = where notes to the user go instead */
const messageAlone = (by: string[], w: string, draft: string, remarks: string) =>
  `- Once accepted, the draft is the message ${by.join(', ')} sends, word for word: ${draft} carries that message alone, in the language it goes out in, with nothing around it (no notes to ${w}, headings or separators). Remarks for ${w} go ${remarks}. Links go on the names in the message itself (the visible text is the name), never as a list of bare URLs.`

export function buildPrompt(x: T.Ctx, j: Job, step: string, q: string, o: PromptIn = {}): string {
  const p = parts(x, j, step, q, o), w = who(o), by = sentBy(x, j, step)
  return join([
    `You are working one step of a job in ${w}'s Work Console.`,
    ...p.data,
    block('## How to work', [
      `- Everything above was read for this step when the run started: work from it, and use tools only for what it does not cover.`,
      ...(o.images ? [`- [image N] in the text is the picture labelled [image N] before this text.`] : []),
      ...(o.bridge === false ? [] : [o.sources
        ? `- Read anything else from the sources with the bridge tools (bridge_snapshot, bridge_get); the packs behind them are under ## Sources, and bridge_get takes pack where a concept has more than one.`
        : `- Read anything else from the sources with the bridge tools (bridge_snapshot, bridge_get).`]),
      `- context() returns these sections again, read anew, when a long run needs them back.`,
      ...(o.knowledge ? [`- When you learn something a later run would need, propose a knowledge note or a change with knowledge_propose; ${w} decides. Notes not given above are found with knowledge_search and knowledge_read.`] : []),
      `- You never send anything to a source (no chat posts, mails, votes, comments or state changes): ${w} sends after review.`,
      `- Write progress with the run tool journal(observed, changed, next) at meaningful points.`,
      `- If something only ${w} can decide holds part of the step, ask it with ask_question, one question per call, rather than only in the draft's text; then finish the draft as far as it goes.`,
      `- Save files the step expects with add_artifact(name, content), or with add_artifact_file(path) for a file already under your working dir; images show on the page.`,
      ...(o.files ? [`- A source message lists the files it carries in files; save one with save_source_file(concept, id, file) when its content matters to the step, then read the copy under .source-files/<job id>/.`] : []),
      LINKS_LINE,
      `- Finish by calling submit_draft(text) exactly once with the draft for ${w} to review. Without it the run counts as failed.`,
      ...factsRule(x, j, step, 'submit_draft(facts)'),
      NOT_DONE_LINE,
      ...(by.length ? [messageAlone(by, w, 'submit_draft', 'in journal()')] : []),
      ...(p.resend ? [p.resend] : []),
    ]),
    ...p.user,
  ])
}

/** the evidence a draft names is a link where its URL is known, and never a guessed one */
const LINKS_LINE = '- Before you submit, check each thing the draft names as evidence (a build, pipeline run, release or its failed stage or log, a PR, commit, work item, chat, mail or page). '
  + 'Where you know its URL, write it as a Markdown link with the name as its text: [build 286944](url), not "build 286944" with the URL next to it or left out. '
  + 'A URL you know is one you fetched while working, one the context or knowledge above gives, or one you build from a pattern a knowledge note gives. Never guess one. '
  + 'Where you know no URL, leave the plain name.'

/** a draft that only says in words that the step is not done is accepted as done; the outcome is what the console reads */
const NOT_DONE_LINE = '- If the step is not finished, or a check or a test failed, call submit_draft with outcome not_done or failed, '
  + 'and name in return_to the earlier step the job should go back to, if any (id or exact title), with why: accepting such a draft never marks the step done.'

/** what a session taken up by hand reads through the console MCP's step_context: a run's prompt, how to work told for that session */
export function manualText(x: T.Ctx, j: Job, step: string, q: string, o: PromptIn = {}): string {
  const p = parts(x, j, step, q, o), w = who(o), by = sentBy(x, j, step)
  return join([
    `You are working one step of a job in ${w}'s Work Console, in a session ${w} opened by hand.`,
    ...p.data,
    block('## How to work', [
      `- Everything above was read for this step just now: work from it.`,
      ...(o.images ? [`- [image N] in the text is the picture labelled [image N] before this text.`] : []),
      `- You never send anything to a source (no chat posts, mails, votes, comments or state changes): ${w} sends after review.`,
      LINKS_LINE,
      `- Finish by calling submit_draft {id: "${j.id}", step: "${step}", output} on the work-console MCP server exactly once, with the draft for ${w} to review; files the step expects go in its artifacts as {name, content}.`,
      ...factsRule(x, j, step, "submit_draft's facts"),
      NOT_DONE_LINE,
      ...(by.length ? [messageAlone(by, w, "submit_draft's output", 'in this session, not in the draft')] : []),
      ...(p.resend ? [p.resend] : []),
    ]),
    ...p.user,
  ])
}

/** what the run's context tool returns: the prompt's sections but how to work, read anew */
export function contextText(x: T.Ctx, j: Job, step: string, q: string, o: PromptIn = {}): string {
  const p = parts(x, j, step, q, o)
  return join([...p.data, ...p.user])
}

export const RESUME_PROMPT = 'The Work Console resumed this run. Continue the same step from where you stopped; finish with submit_draft(text). context() returns the job as it is now.'
export const RESUME_ASK_PROMPT = 'The Work Console resumed this run. Finish answering the last message in text; do not call submit_draft.'

const REPLY_TAIL: Record<RunIntent, string> = {
  revise: 'Change the draft as asked and call submit_draft with the whole new text.',
  accept: 'Change the draft as asked, if anything, and call submit_draft with the whole new text; it is accepted as it is then.',
  ask: 'Answer in text. Do not call submit_draft: the draft stays as it is.',
  approve: 'Run exactly these commands, in this order, and nothing else that needs approval. Stop at the first that fails. '
    + 'Then call submit_draft with what each one printed. If one failed, set outcome failed. A further command that needs approval goes in commands again.',
}
/** an approval as the draft's session reads it, and as the conversation shows it: the draft's commands, numbered */
export const approveText = (cm: string[]) => `Approved, run exactly these commands, in this order:\n${cm.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
const BLOCKER_LINE = 'If the reply asks in so many words for a blocker, a job this step has to wait for (such as waiting for someone\'s answer), call open_blocker with what the user asked and stop. If it seems to want one but leaves open which step or what to wait for, ask back in text instead, without calling submit_draft.'
/** a reply to the run's own draft, in its session; blocker = the run has open_blocker, which an approval never asks for */
export const replyPrompt = (q: string, intent: RunIntent, me?: string, blocker = false) =>
  `${me || 'the user'} replied to your draft:\n\n${q}\n\n${REPLY_TAIL[intent]}${blocker && intent !== 'approve' ? `\n\n${BLOCKER_LINE}` : ''}`

/** the most of a rejected draft a redo carries */
const REDO_DRAFT_MAX = 6000
/** a fresh run's instruction after a rejected draft: the step's ask, the draft and why */
export const redoText = (ask: string, draft: string, why: string) =>
  `${ask}\n\n## Rejected draft\n${draft.length > REDO_DRAFT_MAX ? draft.slice(0, REDO_DRAFT_MAX) + '…' : draft}\n\n## Why\n${why.trim()}`
