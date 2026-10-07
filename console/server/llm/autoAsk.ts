import { openOf } from '../../src/model/blockers.ts'
import * as T from '../../src/model/transitions.ts'
import type { Cmd, Flow, Job } from '../../src/model/types.ts'
import type { Jobs } from '../jobs/jobs.ts'
import { blockersText } from './prompt.ts'
import type { Runner } from './runner.ts'

/* Auto-ask: an llm step starts its run by itself when a change moves the job onto it, and a drafted llm step whose
   last blocker closed revises its draft with the outcome. The run waits longer than the page's Undo toast, so an
   undone change finds the step no longer current and asks nothing. */

/** the changes that move a job forward onto its next step */
const MOVES = new Set<Cmd['op']>(['start', 'stepDone', 'stepSkip', 'acceptDraft'])

/** the steps this command made current: a forward move onto a step not reached yet, a return, or a blocker closing */
export function madeCurrent(cmd: Cmd, prev: Job, job: Job): string[] {
  if (cmd.op === 'returnTo') return job.flow[cmd.step]?.s === 'cur' ? [cmd.step] : []
  if (cmd.op === 'blockerClosed') return prev.flow[cmd.step]?.s !== 'cur' && job.flow[cmd.step]?.s === 'cur' ? [cmd.step] : []
  if (!MOVES.has(cmd.op)) return []
  return Object.keys(job.flow).filter((sid) => job.flow[sid].s === 'cur' && (prev.flow[sid]?.s === 'fut' || prev.flow[sid]?.s === 'tpl'))
}

/** a step that waits only for its draft's review: no open blocker, no run */
const freed = (f: Flow | undefined) => !!f && f.s === 'wait' && !!f.dr && !f.run && !openOf(f).length
/** the step whose draft this blockerClosed freed, if it did */
export function freedDraft(cmd: Cmd, prev: Job, job: Job): string | null {
  if (cmd.op !== 'blockerClosed') return null
  const was = prev.flow[cmd.step]
  return was && openOf(was).some((l) => l.j === cmd.j) && freed(job.flow[cmd.step]) ? cmd.step : null
}
/** what the draft's session is told when its last blocker closed */
export const wokeText = (f: Flow) =>
  `Every blocker this step waited for has closed:\n\n${blockersText(f)}\n\nGo on with the step from your draft, as each outcome and plan say.`

/** asks each llm step a change made current, and revises each llm draft a blocker freed, unless an LLM run made
    the change; returns the off */
export function autoAsk(o: { jobs: Jobs; runner: Runner; ctx: () => T.Ctx; delay?: number }): () => void {
  const delay = o.delay ?? 6000, timers = new Set<ReturnType<typeof setTimeout>>()
  const llm = async (id: string, sid: string) => {
    const j = await o.jobs.get(id), s = j && T.stepOf(o.ctx(), j, sid)
    return j && s && !T.isClosed(j) && s.m === 'llm' ? { j, s, f: j.flow[sid] } : null
  }
  const ask = async (id: string, sid: string) => {
    const a = await llm(id, sid)
    if (!a || a.f.s !== 'cur' || a.f.run || a.f.dr) return
    await o.runner.ask(id, sid, T.askText(a.s), { auto: true })
  }
  const revise = async (id: string, sid: string) => {
    const a = await llm(id, sid)
    if (!a || !freed(a.f)) return
    await o.runner.reply(id, sid, wokeText(a.f), 'revise', { via: 'console' })
  }
  const later = (id: string, sid: string, go: (id: string, sid: string) => Promise<void>) => {
    const t = setTimeout(() => {
      timers.delete(t)
      go(id, sid).catch((e) => console.error(`auto-ask on ${id} ${sid}:`, (e as Error).message))
    }, delay)
    timers.add(t)
  }
  const off = o.jobs.onCmd(({ who, cmd, prev, job }) => {
    if (who === 'run') return
    const isLlm = (sid: string) => T.stepOf(o.ctx(), job, sid)?.m === 'llm'
    for (const sid of madeCurrent(cmd, prev, job)) if (isLlm(sid)) later(job.id, sid, ask)
    const d = freedDraft(cmd, prev, job)
    if (d && isLlm(d)) later(job.id, d, revise)
  })
  return () => { off(); timers.forEach(clearTimeout); timers.clear() }
}
