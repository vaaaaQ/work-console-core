import { openOf } from '../../src/model/blockers.ts'
import * as T from '../../src/model/transitions.ts'
import type { Cmd, Flow, Job, Start, Step } from '../../src/model/types.ts'
import type { Jobs } from '../jobs/jobs.ts'
import { blockersText } from './prompt.ts'
import type { Runner } from './runner.ts'

/* Auto-ask: an llm step that starts by itself runs when a change moves the job onto it, and a drafted one whose
   last blocker closed revises its draft with the outcome; an auto step's clean draft is accepted by the console.
   The run waits longer than the page's Undo toast, so an undone change finds the step no longer current. */

/** how an llm step starts; a step without its own start follows the workspace's autoAsk; null = not an llm step */
export const startOf = (s: Step | undefined, on: boolean): Start | null =>
  !s || s.m !== 'llm' ? null : s.start ?? (on ? 'self' : 'hand')
/** what keeps a draft from being accepted by itself, or null */
export function holdOf(f: Flow): string | null {
  if (f.b.some((b) => b.o && b.k === 'q')) return 'an open question'
  if (f.b.some((b) => b.o && b.k === 'p')) return 'a problem note'
  if (f.bb) return 'a blocker asked for'
  return openOf(f).length ? 'open blockers' : null
}

/** the changes that move a job forward onto its next step */
const MOVES = new Set<Cmd['op']>(['start', 'stepDone', 'stepSkip', 'acceptDraft', 'stepAdd', 'ppAccept'])

/** the steps this command made current: a forward move onto a step not reached yet, a return, or a blocker closing */
export function madeCurrent(cmd: Cmd, prev: Job, job: Job): string[] {
  if (cmd.op === 'returnTo') return job.flow[cmd.step]?.s === 'cur' ? [cmd.step] : []
  if (cmd.op === 'blockerClosed') return prev.flow[cmd.step]?.s !== 'cur' && job.flow[cmd.step]?.s === 'cur' ? [cmd.step] : []
  if (!MOVES.has(cmd.op)) return []
  // a step added in front of the current one had no flow before
  const was = (sid: string) => !prev.flow[sid] || prev.flow[sid].s === 'fut' || prev.flow[sid].s === 'tpl'
  const back = cmd.op === 'ppAccept' ? (prev.pp?.cmds ?? []).flatMap((c) => c.op === 'returnTo' ? [c.step] : []) : []
  return Object.keys(job.flow).filter((sid) => job.flow[sid].s === 'cur' && (was(sid) || back.includes(sid)))
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
export function autoAsk(o: { jobs: Jobs; runner: Runner; ctx: () => T.Ctx; on: boolean; delay?: number }): () => void {
  const delay = o.delay ?? 6000, timers = new Set<ReturnType<typeof setTimeout>>()
  const llm = async (id: string, sid: string) => {
    const j = await o.jobs.get(id), s = j && T.stepOf(o.ctx(), j, sid)
    return j && s && !T.isClosed(j) && s.m === 'llm' ? { j, s, f: j.flow[sid] } : null
  }
  const accept = async (id: string, sid: string) => {
    const a = await llm(id, sid)
    if (!a || a.f.s !== 'wait' || !a.f.dr || a.f.run || T.ahead(a.f)) return
    const why = holdOf(a.f)
    if (!why) { await o.jobs.cmd(id, { op: 'acceptDraft', step: sid, auto: true }, undefined, 'console'); return }
    await o.jobs.cmd(id, { op: 'journal', o: `Held back the automatic accept of “${a.s.t}”: ${why}.`, c: 'the draft waits for your review.',
      n: 'accept, edit or reject it.', a: 'console' }, undefined, 'console')
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
    const start = (sid: string) => startOf(T.stepOf(o.ctx(), job, sid), o.on), self = (sid: string) => start(sid) === 'self' || start(sid) === 'auto'
    if (who === 'runner' && cmd.op === 'runDraft' && start(cmd.step) === 'auto') later(job.id, cmd.step, accept)
    for (const sid of madeCurrent(cmd, prev, job)) if (self(sid)) later(job.id, sid, ask)
    const d = freedDraft(cmd, prev, job)
    if (d && self(d)) later(job.id, d, revise)
  })
  return () => { off(); timers.forEach(clearTimeout); timers.clear() }
}
