import { z } from 'zod'
import * as T from '../../src/model/transitions.ts'
import type { Cmd, Job, RunRec } from '../../src/model/types.ts'
import type { Jobs } from '../jobs/jobs.ts'
import type { Notes } from '../knowledge/notes.ts'
import { buildTools } from '../llm/builder.ts'
import type { SourceReader } from '../llm/builder.ts'
import type { AskTool } from '../llm/sdk.ts'
import { brief, detail } from '../mcp/mcp.ts'
import { PP_HELP } from './prompt.ts'
import type { Proposer } from './proposer.ts'

/* The agent's job tools, in every workspace: it reads the jobs, the notes and the sources, and changes a job only
   by proposing. There is no tool that sends, acts on a source or applies a command. */

/** what a conversation's job tools read and how they propose */
export interface JobDeps {
  jobs: Pick<Jobs, 'get' | 'all'>; runs(): Promise<RunRec[]>; ctx(): T.Ctx
  notes: Pick<Notes, 'list' | 'search' | 'read'>; source: SourceReader | null; me?: string; key(id: string): string
  proposer: Pick<Proposer, 'propose'>
}

const OUT_MAX = 20_000
const FILTERS = ['open', 'needs_you', 'closed', 'all'] as const
const clip = (t: string, n = OUT_MAX) => (t.length > n ? t.slice(0, n) + ` … (${t.length - n} more characters)` : t)
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
export const PROPOSED = 'Proposed: it waits for the person on the board and in Approvals.'

/** conv = the conversation proposals are signed with */
export function jobAgentTools(o: { ws: string; conv: string; d: JobDeps }): AskTool[] {
  const { d } = o
  const job = async (id: unknown): Promise<Job | string> => {
    const k = str(id)
    return (k && (await d.jobs.get(k))) || `no job ${k || '(none named)'} in this workspace`
  }
  /** a step by its id or, failing that, its exact title */
  const stepOf = (x: T.Ctx, j: Job, s: unknown) => {
    const k = str(s)
    return T.stepOf(x, j, k) ?? T.stepsOf(x, j).find((st) => st.t.toLowerCase() === k.toLowerCase())
  }
  return [
    {
      name: 'list_jobs', description: "List the workspace's jobs, newest first: id, title, playbook, status, current step, round, whether it needs the person. filter: open (default), needs_you, closed or all.",
      input: { filter: z.enum(FILTERS).optional() },
      run: async (a) => {
        const f = (a.filter as string) || 'open', x = d.ctx()
        const js = (await d.jobs.all()).filter((j) => f === 'all' || (f === 'closed' ? T.isClosed(j) : f === 'needs_you' ? T.needsYou(x, j) : !T.isClosed(j)))
        return js.sort((p, q) => q.ts - p.ts).map((j) => {
          const b = brief(x, j, o.ws)
          return `- ${b.id}: ${b.title} · ${x.PB[b.playbook]?.n ?? b.playbook} · ${b.status}${b.step ? ` · at “${b.step}”` : ''}${b.round > 1 ? ` · round ${b.round}` : ''}${b.needsYou ? ' · needs the person' : ''}`
        }).join('\n') || `no ${f === 'all' ? '' : `${f.replace('_', ' ')} `}jobs`
      },
    },
    {
      name: 'get_job', description: 'One job in full, as JSON: its steps with state, mode, start, why an added step was added, notes, draft, output, artifacts, blockers, the reply a step waits for and the replies that came; past rounds; the open proposal; the last 10 journal lines.',
      input: { id: z.string().min(1) },
      run: async (a) => {
        const j = await job(a.id)
        if (typeof j === 'string') return j
        return JSON.stringify(detail(d.ctx(), j, o.ws, await d.runs(), await d.jobs.all()), null, 1)
      },
    },
    {
      name: 'step_output', description: `One step's work in full: its draft, its output and its artifact names, each at most ${OUT_MAX} characters. step is its id or exact title.`,
      input: { id: z.string().min(1), step: z.string().min(1) },
      run: async (a) => {
        const j = await job(a.id), x = d.ctx()
        if (typeof j === 'string') return j
        const s = stepOf(x, j, a.step), f = s && j.flow[s.id]
        if (!s || !f) return `${j.id} has no step ${str(a.step)}`
        const arts = f.arts.map((r) => r.n + (r.ok ? '' : ' (planned)'))
        return [
          `${j.id} step ${s.id} “${s.t}” (${f.s})`,
          ...(f.dr ? ['## Draft', clip(f.dr.t)] : ['## Draft', 'none']),
          ...(f.out ? ['## Output', clip(f.out)] : ['## Output', 'none']),
          '## Artifacts', clip(arts.join('\n') || 'none'),
        ].join('\n')
      },
    },
    {
      name: 'propose',
      description: `Propose changes to one job's steps. They are tried on a copy first; a refusal comes back as the answer and nothing is set. Otherwise the proposal waits for the person, who accepts or rejects it; a new one replaces the open one. say = what it does, in a sentence for the person.\n${PP_HELP}`,
      input: { job: z.string().min(1), say: z.string().min(1), cmds: z.array(z.record(z.string(), z.unknown())) },
      run: async (a) => {
        const why = await d.proposer.propose(str(a.job), str(a.say), (Array.isArray(a.cmds) ? a.cmds : []) as Cmd[], o.conv)
        return why || PROPOSED
      },
    },
    ...buildTools({ ws: o.ws, notes: d.notes, source: d.source, me: d.me, key: d.key }),
  ]
}
