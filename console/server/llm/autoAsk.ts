import { writeFile } from 'node:fs/promises'
import { openOf } from '../../src/model/blockers.ts'
import * as T from '../../src/model/transitions.ts'
import type { Cmd, Draft, Flow, Job, Start, Step } from '../../src/model/types.ts'
import type { Jobs } from '../jobs/jobs.ts'
import { NOTES_MAX, NOTE_MAX, blockersText } from './prompt.ts'
import type { Runner } from './runner.ts'

/* Auto-ask: an llm step that starts by itself runs when a change moves the job onto it, and a drafted one whose
   last blocker closed revises its draft with the outcome, or whose last open question got its answer, with the answers,
   once nothing else holds it; an auto step's clean draft is accepted by the console, and so is its failed one when the
   step's retry sends the job back (a fix round, at most max in a row). A draft whose commands are all in the job's
   one-time approval has them approved by the console.
   The run waits longer than the page's Undo toast, so an undone change finds the step no longer current. */

/** how an llm step starts; a step without its own start follows the workspace's autoAsk; null = not an llm step */
export const startOf = (s: Step | undefined, on: boolean): Start | null =>
  !s || s.m !== 'llm' ? null : s.start ?? (on ? 'self' : 'hand')
/** what keeps a draft from being accepted by itself, or null; s and j = its step and job, which a fix round needs */
export function holdOf(f: Flow, s?: Step, j?: Job): string | null {
  // a draft that says it did not finish is the person's to accept, unless its auto step's retry sends the job back,
  // and then only max times in a row: going back by itself could loop
  if (f.dr?.o) {
    if (!s || !j || s.start !== 'auto' || !T.isFix(s, f.dr)) return `the draft reports ${f.dr.o === 'failed' ? 'failed' : 'not done'}`
    if (T.fixRounds(j) >= T.fixMax(s)) return T.fixLimitText(T.fixMax(s))
  }
  // the person approves commands, or the console within the job's one-time approval; the person reads what the commands
  // they approved printed
  if (f.dr?.cm?.length) return `the draft waits for approval of ${T.cmdsN(f.dr.cm.length)}`
  if (f.dr?.ap === 1) return 'the draft reports approved commands'
  if (f.b.some((b) => b.o && b.k === 'q')) return 'an open question'
  // the person accepts or replies; a wake would not fire, since the draft came after the answer
  if (f.dr?.ua) return 'a question was answered while the run worked, so the draft has not seen the answer'
  if (f.b.some((b) => b.o && b.k === 'p')) return 'a problem note'
  if (f.bb) return 'a blocker asked for'
  return openOf(f).length ? 'open blockers' : null
}

/** the changes that move a job forward onto its next step */
const MOVES = new Set<Cmd['op']>(['start', 'stepDone', 'review', 'stepSkip', 'acceptDraft', 'stepAdd', 'ppAccept'])

/** the console approves a draft's commands itself: a session wrote it, none of its commands was approved before in its
    chain (one that asks again is the person's), and every one is in the job's one-time approval */
export const okFor = (j: Job, dr: Draft | null | undefined) =>
  !!dr?.cm?.length && !dr.hd && !dr.ap && !!j.ok && dr.cm.every((c) => j.ok!.cmds.includes(c))

/** the steps this command made current: a forward move onto a step not reached yet, a return, or a blocker closing */
export function madeCurrent(cmd: Cmd, prev: Job, job: Job): string[] {
  if (cmd.op === 'returnTo') return job.flow[cmd.step]?.s === 'cur' ? [cmd.step] : []
  // a review sent back is a return, onto the step its new round starts at; one accepted moves on like Mark done
  if (cmd.op === 'review' && cmd.verdict === 'sent_back') {
    return (job.rounds?.length ?? 0) > (prev.rounds?.length ?? 0) && job.rf && job.flow[job.rf]?.s === 'cur' ? [job.rf] : []
  }
  // an accepted draft that went back started a new round at the step it named
  const rt = cmd.op === 'acceptDraft' ? prev.flow[cmd.step]?.dr?.rt : undefined
  if (rt && (job.rounds?.length ?? 0) > (prev.rounds?.length ?? 0)) return job.flow[rt]?.s === 'cur' ? [rt] : []
  // a reopen that started a new round is a return; one that reopened the step alone is not
  if (cmd.op === 'stepReopen') return (job.rounds?.length ?? 0) > (prev.rounds?.length ?? 0) && job.flow[cmd.step]?.s === 'cur' ? [cmd.step] : []
  if (cmd.op === 'blockerClosed') return prev.flow[cmd.step]?.s !== 'cur' && job.flow[cmd.step]?.s === 'cur' ? [cmd.step] : []
  if (!MOVES.has(cmd.op)) return []
  // a step added in front of the current one had no flow before
  const was = (sid: string) => !prev.flow[sid] || prev.flow[sid].s === 'fut' || prev.flow[sid].s === 'tpl'
  const back = cmd.op === 'ppAccept' ? (prev.pp?.cmds ?? []).flatMap((c) => c.op === 'returnTo' ? [c.step] : []) : []
  return Object.keys(job.flow).filter((sid) => job.flow[sid].s === 'cur' && (was(sid) || back.includes(sid)))
}

/** a step that waits only for its draft's review: no open blocker or question, no run */
const freed = (f: Flow | undefined) => !!f && f.s === 'wait' && !!f.dr && !f.run && !openOf(f).length && !T.openQs(f).length
/** the step whose draft this blockerClosed, or this answer to its last open question, freed, if it did */
export function freedDraft(cmd: Cmd, prev: Job, job: Job): string | null {
  if (cmd.op !== 'blockerClosed' && cmd.op !== 'noteAnswer') return null
  const was = prev.flow[cmd.step]
  if (!was || !freed(job.flow[cmd.step])) return null
  const by = cmd.op === 'blockerClosed' ? openOf(was).some((l) => l.j === cmd.j) : was.b[cmd.i]?.k === 'q' && !!was.b[cmd.i].o
  return by ? cmd.step : null
}
/** what the draft's session is told when its last blocker closed */
export const wokeText = (f: Flow) =>
  `Every blocker this step waited for has closed:\n\n${blockersText(f)}\n\nGo on with the step from your draft, as each outcome and plan say.`
/** what the draft's session is told when its last question got its answer */
export function answeredText(f: Flow) {
  const qs = f.b.filter((b) => b.k === 'q' && !b.o), kept = qs.slice(-NOTES_MAX)
  const of = qs.length > kept.length ? ` (the latest ${kept.length} of ${qs.length})` : ''
  return `Every question this step asked has an answer${of}:\n\n${kept.map((b) => `- ${T.line(b.t, NOTE_MAX)} → ${T.line(b.r ?? '', NOTE_MAX)}`).join('\n')}\n\nGo on with the step from your draft, as the answers say.`
}

/** asks each llm step a change made current, and revises each llm draft a blocker freed, unless an LLM run made
    the change; returns the off */
export function autoAsk(o: { jobs: Jobs; runner: Runner; ctx: () => T.Ctx; on: boolean; delay?: number }): () => void {
  const delay = o.delay ?? 6000, timers = new Set<ReturnType<typeof setTimeout>>()
  const llm = async (id: string, sid: string) => {
    const j = await o.jobs.get(id), s = j && T.stepOf(o.ctx(), j, sid)
    return j && s && !T.isClosed(j) && s.m === 'llm' ? { j, s, f: j.flow[sid] } : null
  }
  /** a fix round's record: its text as an artifact on the step that failed, numbered across the job so none is overwritten */
  const keepFix = async (id: string, sid: string, j: Job) => {
    const r = j.rounds?.at(-1)
    if (!r?.fx) return
    const n = j.rounds!.filter((q) => q.fx).length
    await o.runner.keepArtifact(id, sid, `fix-round-${n}.md`, (f) => writeFile(f, `${T.fixRoundText(o.ctx(), j, r)}\n`, 'utf8'))
  }
  const accept = async (id: string, sid: string) => {
    const a = await llm(id, sid)
    if (!a || a.f.s !== 'wait' || !a.f.dr || a.f.run || T.ahead(a.f)) return
    const why = holdOf(a.f, a.s, a.j)
    if (!why) {
      const r = await o.jobs.cmd(id, { op: 'acceptDraft', step: sid, auto: true }, undefined, 'console')
      if ((r.job.rounds?.length ?? 0) > (a.j.rounds?.length ?? 0)) await keepFix(id, sid, r.job)
      return
    }
    await o.jobs.cmd(id, { op: 'journal', o: `Held back the automatic accept of “${a.s.t}”: ${why}.`, c: 'the draft waits for your review.',
      n: 'accept, edit or reject it.', a: 'console' }, undefined, 'console')
  }
  const ask = async (id: string, sid: string) => {
    const a = await llm(id, sid)
    if (!a || a.f.s !== 'cur' || a.f.run || a.f.dr) return
    await o.runner.ask(id, sid, T.askText(a.s), { auto: true })
  }
  /** runs the draft's commands under the job's one-time approval; the run that wrote it may still be winding down */
  const approve = async (id: string, sid: string) => {
    for (let i = 0; ; i++) {
      const a = await llm(id, sid)
      if (!a || a.f.s !== 'wait' || !a.f.dr || a.f.run || !okFor(a.j, a.f.dr)) return
      try { await o.runner.reply(id, sid, '', 'approve', { via: 'console', at: a.f.dr.at }); return } catch (e) {
        if ((e as { code?: string }).code !== 'busy' || i >= 40) throw e
        await new Promise((r) => setTimeout(r, 250))
      }
    }
  }
  const revise = (say: (f: Flow) => string) => async (id: string, sid: string) => {
    const a = await llm(id, sid)
    if (!a || !freed(a.f)) return
    await o.runner.reply(id, sid, say(a.f), 'revise', { via: 'console' })
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
    if (who === 'runner' && cmd.op === 'runDraft') {
      if (okFor(job, job.flow[cmd.step]?.dr) && start(cmd.step) !== null) later(job.id, cmd.step, approve)
      else if (start(cmd.step) === 'auto') later(job.id, cmd.step, accept)
    }
    for (const sid of madeCurrent(cmd, prev, job)) if (self(sid)) later(job.id, sid, ask)
    const d = freedDraft(cmd, prev, job)
    if (d && self(d)) later(job.id, d, revise(cmd.op === 'noteAnswer' ? answeredText : wokeText))
  })
  return () => { off(); timers.forEach(clearTimeout); timers.clear() }
}
