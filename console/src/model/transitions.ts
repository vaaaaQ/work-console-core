import { BK } from '../data/core.ts'
import { PACKS } from '../data/packs.ts'
import { clone, slugify, tfmt } from '../lib/util.ts'
import { fromWall, midnight, offsetAt } from '../lib/zone.ts'
import { CTX_MAX, KINDS, ctxDefaults, ctxLabel, ctxOf, ctxUnit, parseWorkId } from './context.ts'
import type {
  BadgeKind, Cmd, CtxItem, CtxKind, Flow, Job, JobStatus, JournalEntry, Lamp, NodeState, Playbook, Round, Step, StepOverride, Tpl, Ws,
} from './types.ts'

/* The one place for job transitions: the page (demo and live) and the backend run the same code.
   apply() never mutates its input; it returns the changed copy. */

/** by = who the journal names for this change: the page and its runs are 'you', a Claude Code session or the console itself sign their own */
export interface Ctx { PB: Record<string, Playbook>; TPL: Record<string, Tpl[]>; now?: () => Date; by?: string }
export type CmdCode = 'bad_step' | 'bad_state' | 'bad_args'
export class CmdError extends Error {
  code: CmdCode
  constructor(code: CmdCode, msg: string) { super(msg); this.code = code }
}

const nowOf = (x: Ctx) => (x.now ? x.now() : new Date())
const by = (x: Ctx) => x.by || 'you'
export const steps = (x: Ctx, pb: string): Step[] => (x.PB[pb]?.ph || []).flatMap((p) => p.s)
export const stepOf = (x: Ctx, j: Job, id: string | null) => steps(x, j.pb).find((s) => s.id === id)
export const isClosed = (j: Job) => j.st === 'done' || j.st === 'cancelled'
export const isLive = (f: Flow) => f.s !== 'done' && f.s !== 'skip'
export const flows = (j: Job) => Object.values(j.flow)
export const atOf = (x: Ctx, j: Job) => { const s = steps(x, j.pb).find((s) => j.flow[s.id] && isLive(j.flow[s.id])); return s ? s.id : null }
export const hasDraft = (j: Job) => flows(j).some((f) => f.dr)
/** the current step still has a planned message you have not sent */
export const unsentAt = (x: Ctx, j: Job) => {
  if (j.st === 'draft') return false
  const id = atOf(x, j), f = id && j.flow[id]
  return !!f && ['cur', 'wait', 'bad'].includes(f.s) && (x.TPL[id] || []).some((_, i) => !f.sent[i])
}
/** when a job with a due date starts needing you: midnight of its due day, `lead` days earlier */
export const dueFrom = (j: Job) => (j.due ? midnight(Date.parse(j.due), j.lead || 0) : null)
export const dueNow = (x: Ctx, j: Job) => { const f = dueFrom(j); return f != null && nowOf(x).getTime() >= f }
export const needsYou = (x: Ctx, j: Job) => !isClosed(j) && (j.st === 'waiting-user' || j.st === 'ready' || hasDraft(j) || unsentAt(x, j)
  || flows(j).some((f) => f.s === 'bad' || f.b.some((b) => b.o)) || dueNow(x, j))
/** the same wall-clock day and time one month on, kept inside a shorter month */
export function nextMonth(iso: string) {
  const ms = Date.parse(iso), d = new Date(ms + offsetAt(ms)), day = d.getUTCDate()
  const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, d.getUTCHours(), d.getUTCMinutes()))
  n.setUTCDate(Math.min(day, new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 0)).getUTCDate()))
  return new Date(fromWall(n.getTime())).toISOString()
}
export const allSent = (x: Ctx, j: Job, sid: string) => (x.TPL[sid] || []).every((_, i) => j.flow[sid].sent[i])

/** status follows the current step unless you set it (draft, ready, recurring, closed) */
export function syncStatus(x: Ctx, j: Job) {
  if (isClosed(j) || ['draft', 'ready', 'recurring'].includes(j.st)) return
  const id = atOf(x, j); if (!id) return
  const f = j.flow[id], s = stepOf(x, j, id)!, unsent = (x.TPL[id] || []).some((_, i) => !f.sent[i])
  j.st = f.run ? 'active' : f.dr ? 'waiting-user' : f.s === 'wait' ? (s.rv ? 'review' : 'waiting-external') : (f.s === 'cur' && unsent) ? 'waiting-user' : 'active'
}
export function rvState(j: Job, f: Flow) {
  const w = PACKS[j.ws], r = f.rv || { v: [], need: 2 }
  return { r, ok: r.v.filter((v) => v.v >= w.ok).length, veto: r.v.some((v) => v.v <= w.veto) }
}
export const nextTxt = (x: Ctx, j: Job, nx: string | null) => {
  const s = nx ? stepOf(x, j, nx) : undefined
  return s ? `${s.m === 'llm' ? 'ask the LLM for' : 'work on'} “${s.t}”.` : j.st === 'recurring' ? 'wait for the next period.' : 'close the job.'
}
function jr(x: Ctx, j: Job, o: string, c: string, n: string, a = by(x), l: Lamp = 'ok') {
  const now = nowOf(x)
  j.jr.unshift({ ts: now.toISOString(), a, o, c, n, l, nw: 1 }); j.ts = now.getTime()
}

/* ===== building a job ===== */
const AT_ST: Partial<Record<JobStatus, NodeState>> = { active: 'cur', 'waiting-user': 'cur', 'waiting-external': 'wait', review: 'wait', recurring: 'cur', ready: 'fut' }
/** lays out a job's flow from its status and current step; ovr and journal come from seed data */
export function seedFlow(x: Ctx, j: Job, ovr: Record<string, StepOverride> = {}, journal?: JournalEntry[]) {
  const all = steps(x, j.pb), ai = j.at ? all.findIndex((s) => s.id === j.at) : -1
  j.flow = {}
  all.forEach((s, i) => {
    let st: NodeState = 'fut'
    if (j.st === 'done') st = 'done'
    else if (ai >= 0) { if (i < ai) st = 'done'; else if (j.st === 'cancelled') st = 'skip'; else if (i === ai) st = AT_ST[j.st] || 'fut' }
    const o = ovr[s.id] || {}
    if (o.s) st = o.s
    if (st === 'fut' && s.msg) st = 'tpl'
    j.flow[s.id] = {
      s: st, m: o.m || '', arts: o.arts ? clone(o.arts) : (s.a || []).map((n) => ({ n, ok: st === 'done' })), b: clone(o.b || []),
      rv: o.rv ? clone(o.rv) : null, dr: o.dr ? clone(o.dr) : null, out: o.out || null, run: null, sent: {},
    }
  })
  j.ts = nowOf(x).getTime() - (j.upd || 0) * 60000
  const first = stepOf(x, j, j.at) || all[0]
  j.jr = clone(journal || [{
    ts: new Date(j.ts).toISOString(), a: by(x), o: `Created the job “${j.t}”.`, c: `playbook ${x.PB[j.pb].n}.`, l: 'ok' as Lamp,
    n: j.st === 'draft' ? 'start it when ready.' : `work on “${first.t}”.`,
  }])
}
/** chatName = the chat's name, for its row in the job's context */
export interface NewJob { t: string; key: string; pb: string; prj: string; ws: Ws; src?: string; chat?: string; chatName?: string; mail?: string; ev?: string; due?: string }
export function freshJob(x: Ctx, id: string, o: NewJob): Job {
  if (!x.PB[o.pb] || !steps(x, o.pb).length) throw new CmdError('bad_args', `unknown playbook ${o.pb}`)
  if (!o.t.trim()) throw new CmdError('bad_args', 'a job needs a title')
  const now = nowOf(x)
  const j = {
    id, ws: o.ws, key: o.key || 'NEW', pb: o.pb, prj: o.prj, t: o.t, st: 'ready', at: steps(x, o.pb)[0].id, upd: 0,
    slug: now.toISOString().slice(0, 10).replace(/-/g, '') + '-' + slugify(o.key === 'NEW' || !o.key ? o.t : o.key + '-' + o.t),
  } as Job
  seedFlow(x, j)
  if (o.src) j.jr[0].o = `Created the job from ${o.src}.`
  if (o.chat) j.chat = o.chat
  if (o.mail) j.mail = o.mail
  if (o.ev) j.ev = o.ev
  if (o.due) { if (!Number.isFinite(Date.parse(o.due))) throw new CmdError('bad_args', 'due is not a date'); j.due = new Date(o.due).toISOString() }
  const ctx = ctxDefaults(j.ws, j.key, j.chat, typeof o.chatName === 'string' ? o.chatName.trim().slice(0, 120) || undefined : undefined)
  if (ctx.length) j.ctx = ctx
  return j
}

/** adds, recounts or removes one context item; a job without a list starts from its defaults */
function ctxEdit(x: Ctx, j: Job, c: Extract<Cmd, { op: 'ctxAdd' | 'ctxSet' | 'ctxDel' }>) {
  const K = Object.hasOwn(KINDS, c.k) ? KINDS[c.k as CtxKind] : undefined
  if (!K) throw new CmdError('bad_args', `unknown context kind ${c.k}`)
  const id = typeof c.id === 'string' ? c.id.trim() : ''
  if (!id || id.length > 200) throw new CmdError('bad_args', 'a context item needs an id')
  if (c.k === 'work' && parseWorkId(j.ws, id) !== id) throw new CmdError('bad_args', `${id} is not a work item id`)
  const count = (v: unknown) => {
    if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > K.max) throw new CmdError('bad_args', `the ${K.unit} count is 1–${K.max}`)
    return v as number
  }
  const list = ctxOf(j).map((it) => ({ ...it })), i = list.findIndex((it) => it.k === c.k && it.id === id), what = K.l.toLowerCase()
  const next = nextTxt(x, j, atOf(x, j))
  if (c.op === 'ctxAdd') {
    if (i >= 0) throw new CmdError('bad_args', `${what} ${ctxLabel(j.ws, list[i])} is already in the context`)
    if (list.length >= CTX_MAX) throw new CmdError('bad_args', `the context holds at most ${CTX_MAX} items`)
    const it: CtxItem = { k: c.k, id, n: c.n === undefined ? K.def : count(c.n) }
    const name = typeof c.name === 'string' ? c.name.trim().slice(0, 120) : ''
    if (name) it.name = name
    list.push(it)
    jr(x, j, `Added ${what} ${ctxLabel(j.ws, it)} to the context.`, `LLM runs get its ${ctxUnit(it)}.`, next, by(x), 'ok')
  } else {
    if (i < 0) throw new CmdError('bad_args', `${what} ${id} is not in the context`)
    const it = list[i]
    if (c.op === 'ctxSet') {
      it.n = count(c.n)
      jr(x, j, `${K.l} ${ctxLabel(j.ws, it)} now gives the ${ctxUnit(it)}.`, 'context changed for the next LLM runs.', next, by(x), 'ok')
    } else {
      list.splice(i, 1)
      jr(x, j, `Removed ${what} ${ctxLabel(j.ws, it)} from the context.`, 'the next LLM runs no longer get it.', next, by(x), 'ok')
    }
  }
  j.ctx = list
}

/* ===== commands ===== */
function advance(x: Ctx, j: Job, sid: string, state: NodeState) {
  const f = j.flow[sid]
  f.s = state; f.nw = 1; f.dr = null
  if (state === 'done') f.arts.forEach((a) => { if (!a.ok) { a.ok = true; a.nw = 1 } })
  if (j.st === 'draft' || j.st === 'ready') j.st = 'active'
  const nx = atOf(x, j)
  if (nx) { const g = j.flow[nx]; if (g.s === 'fut' || g.s === 'tpl') { g.s = 'cur'; g.nw = 1 } }
  else if (j.st === 'recurring') {
    steps(x, j.pb).forEach((s) => { const g = j.flow[s.id]; g.s = s.msg ? 'tpl' : 'fut'; g.out = null; g.sent = {}; g.m = ''; g.arts.forEach((a) => { a.ok = false; delete a.link }) })
    const first = steps(x, j.pb)[0]; j.flow[first.id].s = 'cur'
    if (j.due && j.every === 'month') j.due = nextMonth(j.due)
    jr(x, j, 'Period complete.', `all steps done; the flow starts again${j.due && j.every ? `, due ${tfmt(j.due)}` : ''}.`, `next period: “${first.t}”.`, by(x), 'ok')
    syncStatus(x, j)
    return first.id
  }
  syncStatus(x, j)
  return nx
}

/** the steps a round covers: from its first step to the end */
export const roundSteps = (x: Ctx, pb: string, from: string | undefined) => {
  const all = steps(x, pb), i = from ? all.findIndex((s) => s.id === from) : 0
  return all.slice(Math.max(i, 0))
}
/** a step's state as it was before anyone touched it */
const blank = (s: Step): Flow => ({ s: s.msg ? 'tpl' : 'fut', m: '', arts: (s.a || []).map((n) => ({ n, ok: false })), b: [], rv: null, dr: null, out: null, run: null, sent: {} })
const noNew = (f: Flow): Flow => ({ ...f, nw: 0, run: null, arts: f.arts.map((a) => ({ ...a, nw: 0 })), b: f.b.map((b) => ({ ...b, nw: 0 })), dr: f.dr ? { ...f.dr, nw: 0 } : null })

/** keeps the current pass as a round and starts a new one at sid: the steps from sid on start blank,
    open notes carry over, a closed job is active again */
function returnTo(x: Ctx, j: Job, sid: string, why: string) {
  const all = steps(x, j.pb), ti = all.findIndex((s) => s.id === sid), at = atOf(x, j)
  if (j.st === 'draft' || j.st === 'ready') throw new CmdError('bad_state', `${j.id} has not started`)
  if (!isClosed(j) && at && ti >= all.findIndex((s) => s.id === at)) throw new CmdError('bad_step', `“${all[ti].t}” has not been passed yet`)
  if (flows(j).some((f) => f.run)) throw new CmdError('bad_state', `${j.id} has an LLM run in flight; cancel it first`)
  const rounds = j.rounds || []
  const kept: Round = {
    n: rounds.length + 1, from: j.rf || all[0].id, at: nowOf(x).toISOString(), by: by(x), why, st: j.st,
    flow: Object.fromEntries(roundSteps(x, j.pb, j.rf).map((s) => [s.id, noNew(clone(j.flow[s.id]))])),
  }
  j.rounds = [...rounds, kept]; j.rf = sid
  const back = all.slice(ti)
  back.forEach((s) => { const open = j.flow[s.id].b.filter((b) => b.o); j.flow[s.id] = { ...blank(s), b: open, nw: 1 } })
  j.flow[sid].s = 'cur'
  if (isClosed(j)) j.st = 'active'
  syncStatus(x, j)
  jr(x, j, `Returned to “${all[ti].t}”: ${why}`, `round ${kept.n + 1} starts here; ${back.length} step${back.length > 1 ? 's' : ''} from “${all[ti].t}” on start again, round ${kept.n} is kept.`,
    `work on “${all[ti].t}”.`, by(x), 'cur')
}

const STEP_OPS = new Set(['returnTo', 'stepDone', 'stepSkip', 'stepWait', 'stepResume', 'stepReopen', 'acceptDraft', 'rejectDraft',
  'noteAdd', 'noteAnswer', 'noteReopen', 'sent', 'vote', 'runStart', 'runDraft', 'runEnd', 'artifact'])

/** runs one command on a copy of the job; nx is the step to show next, when the command moved on */
export function apply(x: Ctx, job: Job, cmd: Cmd): { job: Job; nx: string | null } {
  const j = clone(job)
  let nx: string | null = null
  const needOpen = () => { if (isClosed(j)) throw new CmdError('bad_state', `${j.id} is closed`) }
  let sid = '', s: Step | undefined, f: Flow | undefined
  if (STEP_OPS.has(cmd.op)) {
    sid = (cmd as { step: string }).step
    s = stepOf(x, j, sid); f = j.flow[sid]
    if (!s || !f) throw new CmdError('bad_step', `${j.id} has no step ${sid}`)
    if (cmd.op !== 'runEnd' && cmd.op !== 'artifact' && cmd.op !== 'returnTo') needOpen()
  }
  const S = s!, F = f!
  const needDraft = () => { if (!F.dr) throw new CmdError('bad_state', `“${S.t}” has no draft`) }
  const badge = (i: number) => { const b = F.b[i]; if (!b) throw new CmdError('bad_args', `no note ${i} on “${S.t}”`); return b }

  switch (cmd.op) {
    case 'start': {
      if (j.st !== 'draft' && j.st !== 'ready') throw new CmdError('bad_state', `${j.id} has already started`)
      const first = atOf(x, j) || steps(x, j.pb)[0].id
      j.st = 'active'; j.flow[first].s = 'cur'; j.flow[first].nw = 1; nx = first
      jr(x, j, 'Started the job.', `“${stepOf(x, j, first)!.t}” in progress.`, nextTxt(x, j, first), by(x), 'cur'); syncStatus(x, j)
      break
    }
    case 'close': {
      needOpen()
      if (cmd.st !== 'done' && cmd.st !== 'cancelled') throw new CmdError('bad_args', 'close as done or cancelled')
      flows(j).forEach((g) => { g.run = null })
      j.st = cmd.st
      jr(x, j, cmd.st === 'done' ? 'Closed the job as done.' : 'Cancelled the job.', cmd.note || 'no note.', 'nothing; reopen it if needed.', by(x), cmd.st === 'done' ? 'ok' : 'off')
      break
    }
    case 'reopen': {
      if (!isClosed(j)) throw new CmdError('bad_state', `${j.id} is not closed`)
      j.st = 'active'
      steps(x, j.pb).forEach((st) => { const g = j.flow[st.id]; if (g.s === 'skip') g.s = st.msg ? 'tpl' : 'fut' })
      const a = atOf(x, j)
      if (a && (j.flow[a].s === 'fut' || j.flow[a].s === 'tpl')) j.flow[a].s = 'cur'
      syncStatus(x, j); nx = a
      jr(x, j, 'Reopened the job.', 'status back to in progress.', a ? nextTxt(x, j, a) : 'reopen a step.', by(x), 'cur')
      break
    }
    case 'returnTo': {
      const why = (cmd.why || '').trim()
      if (!why) throw new CmdError('bad_args', 'say why the job goes back')
      returnTo(x, j, sid, why); nx = sid
      break
    }
    case 'schedule': {
      needOpen()
      // a monthly repeat makes the job recurring, so finishing its last step rolls the period; dropping it returns the job to its step
      const recur = (on: boolean) => {
        if (on === (j.st === 'recurring')) return
        j.st = on ? 'recurring' : 'active'
        const a = atOf(x, j)
        if (on && a && (j.flow[a].s === 'fut' || j.flow[a].s === 'tpl')) j.flow[a].s = 'cur'
        syncStatus(x, j)
      }
      if (cmd.due === null) {
        delete j.due; delete j.lead; delete j.remind; delete j.every
        recur(false)
        jr(x, j, 'Removed the due date.', 'no reminder.', nextTxt(x, j, atOf(x, j)), by(x), 'ok')
        break
      }
      const ms = Date.parse(cmd.due)
      const int = (v: unknown, max: number) => v === undefined || (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max)
      if (!Number.isFinite(ms)) throw new CmdError('bad_args', 'due is not a date')
      if (!int(cmd.lead, 31) || !int(cmd.remind, 31 * 1440)) throw new CmdError('bad_args', 'lead is 0–31 days, remind 0–44640 minutes')
      if (cmd.every != null && cmd.every !== 'month') throw new CmdError('bad_args', 'every is month or nothing')
      j.due = new Date(ms).toISOString()
      if (cmd.lead) j.lead = cmd.lead; else delete j.lead
      if (cmd.remind !== undefined && cmd.remind !== 60) j.remind = cmd.remind; else delete j.remind
      if (cmd.every) j.every = cmd.every; else delete j.every
      recur(!!j.every)
      jr(x, j, `Due ${tfmt(j.due)}.`, `${j.lead ? `needs you from ${j.lead} days before; ` : ''}reminder ${j.remind ?? 60} min before${j.every ? '; repeats monthly' : ''}.`,
        nextTxt(x, j, atOf(x, j)), by(x), 'ok')
      break
    }
    case 'ctxAdd': case 'ctxSet': case 'ctxDel':
      needOpen()
      ctxEdit(x, j, cmd)
      break
    case 'stepDone': {
      const had = !!F.dr
      nx = advance(x, j, sid, 'done')
      jr(x, j, `Marked “${S.t}” done${had ? ' (LLM draft discarded)' : ''}.`, `step done${nx ? `; “${stepOf(x, j, nx)!.t}” is next` : ''}.`, nextTxt(x, j, nx), by(x), 'ok')
      break
    }
    case 'stepSkip':
      nx = advance(x, j, sid, 'skip')
      jr(x, j, `Skipped “${S.t}”.`, 'step skipped.', nextTxt(x, j, nx), by(x), 'off')
      break
    case 'stepReopen':
      F.s = 'cur'; F.nw = 1; nx = sid
      jr(x, j, `Reopened “${S.t}”.`, 'step back in progress.', `finish “${S.t}” again.`, by(x), 'cur'); syncStatus(x, j)
      break
    case 'stepWait': {
      const m = (cmd.m || '').trim() || 'waiting on others'
      F.s = 'wait'; F.m = m; F.nw = 1
      if (j.st === 'draft' || j.st === 'ready') j.st = 'active'
      jr(x, j, `“${S.t}” is waiting: ${m}.`, 'step set to waiting.', 'resume it when the answer arrives.', by(x), 'wait'); syncStatus(x, j)
      break
    }
    case 'stepResume':
      F.s = 'cur'; F.m = ''
      jr(x, j, `Resumed “${S.t}”.`, 'step back in progress.', `finish “${S.t}”.`, by(x), 'cur'); syncStatus(x, j)
      break
    case 'acceptDraft': {
      needDraft()
      const dr = F.dr!, edited = cmd.text != null && cmd.text !== dr.t
      F.out = edited ? cmd.text! : dr.t; F.m = edited ? 'accepted with your edits' : 'draft accepted'
      nx = advance(x, j, sid, 'done')
      jr(x, j, `Accepted the LLM draft for “${S.t}”${edited ? ' with edits' : ''}.`, `step done${nx ? `; “${stepOf(x, j, nx)!.t}” is next` : ''}.`, nextTxt(x, j, nx), by(x), 'ok')
      break
    }
    case 'rejectDraft':
      needDraft()
      F.dr = null; F.s = 'cur'; F.m = 'draft rejected'
      jr(x, j, `Rejected the LLM draft for “${S.t}”.`, 'step back in progress.', 'do it yourself, or ask again with a sharper instruction.', by(x), 'bad'); syncStatus(x, j)
      break
    case 'noteAdd': {
      const t = (cmd.t || '').trim()
      if (!t || !BK[cmd.k as BadgeKind]) throw new CmdError('bad_args', 'a note needs a kind and text')
      F.b.push({ k: cmd.k, t, r: '', o: 1, nw: 1 })
      jr(x, j, `${BK[cmd.k].l} on “${S.t}”: ${t}`, 'added to the step.', 'answer it.', by(x), cmd.k === 'p' ? 'bad' : 'wait')
      break
    }
    case 'noteAnswer': {
      const b = badge(cmd.i), r = (cmd.r || '').trim()
      if (!r) throw new CmdError('bad_args', 'an answer needs text')
      b.r = r; b.o = 0
      jr(x, j, `${BK[b.k].l} resolved on “${S.t}”: ${r}`, 'marked resolved.', 'carry on with the step.', by(x), 'ok')
      break
    }
    case 'noteReopen': {
      const b = badge(cmd.i)
      b.o = 1
      jr(x, j, `Reopened: ${b.t}`, 'open again.', 'answer it.', by(x), 'wait')
      break
    }
    case 'sent': {
      if (!(x.TPL[sid] || [])[cmd.i]) throw new CmdError('bad_args', `“${S.t}” has no planned message ${cmd.i}`)
      F.sent[cmd.i] = { at: nowOf(x).toISOString(), t: cmd.t }
      jr(x, j, `Sent to ${cmd.to}.`, 'message recorded on the step.', allSent(x, j, sid) ? `mark “${S.t}” done.` : 'send the remaining messages.', by(x), 'ok')
      syncStatus(x, j)
      break
    }
    case 'vote': {
      const w = PACKS[j.ws], n = (cmd.n || '').trim()
      if (!n || w.votes[String(cmd.v)] == null) throw new CmdError('bad_args', 'a vote needs a reviewer and a known value')
      const rv = F.rv = F.rv || { v: [], need: 2 }
      const e = rv.v.find((r) => r.n === n)
      if (e) e.v = cmd.v; else rv.v.push({ n, v: cmd.v })
      const st = rvState(j, F)
      F.m = `approvals ${st.ok}/${rv.need}`
      jr(x, j, `${n} voted ${cmd.v > 0 ? '+' : ''}${cmd.v} (${w.votes[String(cmd.v)]}).`, `approvals ${st.ok}/${rv.need}${st.veto ? ', blocked' : ''}.`,
        st.veto ? 'address the rejection.' : st.ok >= rv.need ? `mark “${S.t}” done.` : 'wait for more votes.', by(x), st.veto ? 'bad' : 'ok')
      break
    }
    case 'nudged':
      needOpen()
      jr(x, j, `Nudged reviewers in ${cmd.to}.`, 'message recorded.', 'wait for the votes.', by(x), 'ok')
      break
    case 'replied':
      jr(x, j, `Replied to “${cmd.subj}”.`, 'reply recorded on the mail.', 'carry on with the job.', by(x), 'ok')
      break
    case 'runStart':
      if (F.run) throw new CmdError('bad_state', `“${S.t}” already has an LLM run`)
      F.run = { q: cmd.q, at: nowOf(x).getTime(), id: cmd.id }; F.dr = null; F.s = 'cur'; F.nw = 1
      if (j.st === 'draft' || j.st === 'ready') j.st = 'active'
      if (cmd.resumed) jr(x, j, `Resumed the LLM run for “${S.t}”.`, 'LLM run continues its session.', 'review the draft when it is ready.', by(x), 'cur')
      else jr(x, j, `Asked the LLM for “${S.t}”.`, 'LLM run started.', 'review the draft when it is ready.', by(x), 'cur')
      syncStatus(x, j)
      break
    case 'runDraft':
      if (!F.run) throw new CmdError('bad_state', `“${S.t}” has no LLM run`)
      F.run = null; F.dr = { t: cmd.t, at: nowOf(x).toISOString(), nw: 1 }; F.s = 'wait'; F.m = 'LLM draft ready'; F.nw = 1
      jr(x, j, `Draft for “${S.t}” is ready.`, 'waiting for your review.', 'accept, edit or reject it.', 'LLM', 'wait'); syncStatus(x, j)
      break
    case 'runEnd': {
      if (!F.run) break
      F.run = null; F.s = 'cur'
      const d = cmd.detail ? `: ${cmd.detail}` : ''
      if (cmd.why === 'cancelled') jr(x, j, `Cancelled the LLM run for “${S.t}”.`, 'no draft kept.', 'do it yourself, or ask again.', by(x), 'off')
      else if (cmd.why === 'failed') jr(x, j, `The LLM run for “${S.t}” failed${d}.`, 'no draft kept.', 'resume it, do it yourself, or ask again.', 'LLM', 'bad')
      else jr(x, j, `The LLM run for “${S.t}” was interrupted${d}.`, 'no draft kept.', 'resume it when the console is back.', 'LLM', 'wait')
      syncStatus(x, j)
      break
    }
    case 'artifact': {
      const n = (cmd.n || '').trim()
      if (!n) throw new CmdError('bad_args', 'an artifact needs a name')
      const a = F.arts.find((a) => a.n === n)
      // ok: false = planned again; its file is gone, so is the link
      if (cmd.ok === false) { if (a) { a.ok = false; delete a.link } }
      else if (a) { a.ok = true; a.nw = 1; if (cmd.link) a.link = cmd.link } else F.arts.push({ n, ok: true, nw: 1, ...(cmd.link ? { link: cmd.link } : {}) })
      j.ts = nowOf(x).getTime()
      break
    }
    case 'journal':
      jr(x, j, cmd.o, cmd.c, cmd.n, cmd.a || 'LLM', 'cur')
      break
    default:
      throw new CmdError('bad_args', `unknown command ${(cmd as { op: string }).op}`)
  }
  return { job: j, nx }
}
