import { contextSection, ctxLabel, renderNote } from '../../src/model/context.ts'
import type { Resolved } from '../../src/model/context.ts'
import * as T from '../../src/model/transitions.ts'
import type { Job } from '../../src/model/types.ts'
import type { Note } from '../knowledge/notes.ts'

/* What a run is told, read at its start so it can begin working instead of reading. The generated part
   comes first: the job and its step, its context items, its knowledge notes, earlier outputs and the
   journal, then how to work. The user's part comes last: the job's description, then the instruction.
   The run's context tool returns the same sections but how to work, read anew. */

/** the journal entries a prompt carries: the latest */
const JR_MAX = 20

/** ctx = the job's context items as read now; notes among them go under Knowledge with the playbook's (pbNotes).
    me = what the prompt calls the person the console works for; unset or empty: "the user".
    bridge false: the workspace has no gateway, so the prompt does not point at the bridge tools.
    knowledge: the run has the knowledge tools.
    workDir, branch: the job's own dir and the branch it is on, when the workspace gives each job one */
export interface PromptIn { ctx?: Resolved[]; pbNotes?: Note[]; me?: string; bridge?: boolean; knowledge?: boolean; workDir?: string; branch?: string }

const who = (o: PromptIn) => o.me || 'the user'
const block = (h: string, rows: string[]) => (rows.length ? `${h}\n${rows.join('\n')}` : '')

function parts(x: T.Ctx, j: Job, step: string, q: string, o: PromptIn) {
  const s = T.stepOf(x, j, step), pb = x.PB[j.pb], ctx = o.ctx ?? []
  const own = ctx.filter((r) => r.k === 'note'), mine = new Set(own.map((r) => r.id))
  const notes = [
    ...own.map((r) => `### ${ctxLabel(j.ws, r)} (note ${r.id}, this job's)${r.status === 'ok' ? '' : ' — unavailable'}\n${r.text}`),
    ...(o.pbNotes ?? []).filter((n) => !mine.has(n.id)).map((n) => `### ${n.title} (note ${n.id}, the playbook's)\n${renderNote(n)}`),
  ]
  const outs = T.steps(x, j.pb).filter((t) => j.flow[t.id]?.out).map((t) => `### ${t.t}\n${j.flow[t.id].out}`)
  const jr = j.jr.slice(0, JR_MAX).reverse().map((e) => `- ${e.ts} ${e.a}: ${e.o} → ${e.c} Next: ${e.n}`)
  const job = [
    `## Job ${j.id}: ${j.t}`,
    `Key: ${j.key} · playbook: ${pb?.n ?? j.pb} · project: ${j.prj}`,
    `Step: ${s?.t ?? step}`,
    `Exit criterion: ${s?.x ?? '-'}`,
    ...(s?.a?.length ? [`Expected artifacts: ${s.a.join(', ')}`] : []),
    ...(o.workDir ? [`Work dir: ${o.workDir}${o.branch ? ` (a git worktree on branch ${o.branch}, yours alone; commit there)` : ''}`] : []),
  ].join('\n')
  const data = [
    job,
    contextSection(j.ws, ctx.filter((r) => r.k !== 'note')).trimEnd(),
    notes.length ? `## Knowledge\n${notes.join('\n\n')}` : '',
    outs.length ? `## Earlier outputs\n${outs.join('\n\n')}` : '',
    block(`## Journal (oldest first${j.jr.length > JR_MAX ? `; the latest ${JR_MAX} of ${j.jr.length}` : ''})`, jr),
  ]
  const user = [
    j.d ? `## Description (from ${who(o)})\n${j.d}` : '',
    `## Instruction (from ${who(o)})\n${q}`,
  ]
  return { data, user }
}

const join = (bs: string[]) => bs.filter(Boolean).join('\n\n')

export function buildPrompt(x: T.Ctx, j: Job, step: string, q: string, o: PromptIn = {}): string {
  const p = parts(x, j, step, q, o), w = who(o)
  return join([
    `You are working one step of a job in ${w}'s Work Console.`,
    ...p.data,
    block('## How to work', [
      `- Everything above was read for this step when the run started: work from it, and use tools only for what it does not cover.`,
      ...(o.bridge === false ? [] : [`- Read anything else from the sources with the bridge tools (bridge_snapshot, bridge_get).`]),
      `- context() returns these sections again, read anew, when a long run needs them back.`,
      ...(o.knowledge ? [`- When you learn something a later run would need, propose a knowledge note or a change with knowledge_propose; ${w} decides. Notes not given above are found with knowledge_search and knowledge_read.`] : []),
      `- You never send anything to a source (no chat posts, mails, votes, comments or state changes): ${w} sends after review.`,
      `- Write progress with the run tool journal(observed, changed, next) at meaningful points.`,
      `- Save files the step expects with add_artifact(name, content), or with add_artifact_file(path) for a file already under your working dir; images show on the page.`,
      `- Finish by calling submit_draft(text) exactly once with the draft for ${w} to review. Without it the run counts as failed.`,
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
