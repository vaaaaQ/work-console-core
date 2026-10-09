import * as T from '../../src/model/transitions.ts'
import type { Job } from '../../src/model/types.ts'
import type { Jobs } from '../jobs/jobs.ts'
import type { AgentSession, Target } from './session.ts'

/* What the console tells the agent by itself, with no LLM watching: a reply that came in on a step, and what became of
   a proposal. A reply and a failed accept start a turn; an accept or a reject is only heard with the next one. */

const one = (t: string) => t.replace(/\s+/g, ' ').trim()

/** returns the unsubscribe */
export function agentReactor(o: { jobs: Pick<Jobs, 'onCmd' | 'onFail'>; agent: Pick<AgentSession, 'hear'>; ctx: () => T.Ctx }): () => void {
  // the proposal before the command names the conversation that made it
  const to = (prev: Job): Target => (prev.pp?.by ? { conv: prev.pp.by } : { job: prev.id })
  const hear = (t: Target, line: string, turn: boolean) => {
    o.agent.hear(t, line, turn).catch((e) => console.error(`the agent did not hear a line for ${t.conv ?? t.job}:`, (e as Error).message))
  }
  const offCmd = o.jobs.onCmd(({ cmd: c, prev, job }) => {
    if (c.op === 'replyIn') {
      const s = T.stepOf(o.ctx(), job, c.step)?.t ?? c.step
      hear({ job: job.id }, `A reply came in on step ${c.step} “${s}” from ${c.from} at ${c.at}:\n${c.t}`, true)
    } else if (c.op === 'ppAccept' && prev.pp) {
      if (job.pp?.err) hear(to(prev), `Your proposal for ${job.id} was not applied: ${job.pp.err}. Read the job and propose again.`, true)
      else if (!job.pp) hear(to(prev), `The person accepted your proposal for ${job.id}: ${one(prev.pp.say)}.`, false)
    } else if (c.op === 'ppReject' && prev.pp) {
      hear(to(prev), `The person rejected your proposal for ${job.id}: ${one(prev.pp.say)}. Their reason: ${one(c.why ?? '') || 'none given'}.`, false)
    }
  })
  const offFail = o.jobs.onFail(({ cmd: c, prev, error }) => {
    if (c.op === 'ppAccept' && error.status === 413)
      hear(to(prev), `Your proposal for ${prev.id} was not applied: the job would pass 256 KB. Propose fewer or shorter changes.`, true)
  })
  return () => { offCmd(); offFail() }
}
