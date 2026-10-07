import * as T from '../../src/model/transitions.ts'
import type { Cmd, Job } from '../../src/model/types.ts'
import type { Jobs } from '../jobs/jobs.ts'
import type { Runner } from './runner.ts'

/* Auto-ask: an llm step starts its run by itself when a change moves the job onto it. The ask waits
   longer than the page's Undo toast, so an undone change finds the step no longer current and asks nothing. */

/** the changes that move a job forward onto its next step */
const MOVES = new Set<Cmd['op']>(['start', 'stepDone', 'stepSkip', 'acceptDraft'])

/** the steps this command made current: a forward move onto a step not reached yet, a return, or a blocker closing */
export function madeCurrent(cmd: Cmd, prev: Job, job: Job): string[] {
  if (cmd.op === 'returnTo') return job.flow[cmd.step]?.s === 'cur' ? [cmd.step] : []
  if (cmd.op === 'blockerClosed') return prev.flow[cmd.step]?.s !== 'cur' && job.flow[cmd.step]?.s === 'cur' ? [cmd.step] : []
  if (!MOVES.has(cmd.op)) return []
  return Object.keys(job.flow).filter((sid) => job.flow[sid].s === 'cur' && (prev.flow[sid]?.s === 'fut' || prev.flow[sid]?.s === 'tpl'))
}

/** asks each llm step a change made current, unless an LLM run made the change; returns the off */
export function autoAsk(o: { jobs: Jobs; runner: Runner; ctx: () => T.Ctx; delay?: number }): () => void {
  const delay = o.delay ?? 6000, timers = new Set<ReturnType<typeof setTimeout>>()
  const ask = async (id: string, sid: string) => {
    const j = await o.jobs.get(id), s = j && T.stepOf(o.ctx(), j, sid), f = j?.flow[sid]
    if (!j || !s || !f || T.isClosed(j) || s.m !== 'llm' || f.s !== 'cur' || f.run || f.dr) return
    await o.runner.ask(id, sid, T.askText(s), { auto: true })
  }
  const off = o.jobs.onCmd(({ who, cmd, prev, job }) => {
    if (who === 'run') return
    for (const sid of madeCurrent(cmd, prev, job)) {
      if (T.stepOf(o.ctx(), job, sid)?.m !== 'llm') continue
      const t = setTimeout(() => {
        timers.delete(t)
        ask(job.id, sid).catch((e) => console.error(`auto-ask on ${job.id} ${sid}:`, (e as Error).message))
      }, delay)
      timers.add(t)
    }
  })
  return () => { off(); timers.forEach(clearTimeout); timers.clear() }
}
