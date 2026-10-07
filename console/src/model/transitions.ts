import { BK } from '../data/core.ts'
import { PACKS } from '../data/packs.ts'
import { clone, slugify, tfmt } from '../lib/util.ts'
import { fromWall, midnight, offsetAt } from '../lib/zone.ts'
import { openOf, reaches, settled, waitsM } from './blockers.ts'
import { KINDS, ctxDefaults, ctxLabel, ctxOf, ctxUnit, parseWorkId } from './context.ts'
import type { Kind } from './context.ts'
import type {
  BadgeKind, Cmd, CtxItem, CtxKind, Flow, Job, JobStatus, JournalEntry, Lamp, NodeState, Playbook, Round, Step, StepOverride, Tpl, Ws,
} from './types.ts'

/* The one place for job transitions: the page (demo and live) and the backend run the same code.
   apply() never mutates its input; it returns the changed copy. */

/** by = who the journal names for this change: the page and its runs are 'you', a Claude Code session or the console itself sign their own;
    jobOf = another job by its id, for the checks a link needs; absent = links cannot be added */
export interface Ctx { PB: Record<string, Playbook>; TPL: Record<string, Tpl[]>; now?: () => Date; by?: string; jobOf?: (id: string) => Job | undefined }
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
  || flows(j).some((f) => f.s === 'bad' || f.b.some((b) => b.o)) || dueNow(x, j) || flows(j).some((f) => !!f.bb))
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
/** t with a closing period, unless it already ends a sentence */
export const sentence = (t: string) => t.replace(/(?<![.!?…])$/, '.')
/** the instruction an ask starts from: the step in its own words */
export const askText = (s: Step) => `Do: ${sentence(s.t)}\nDone when: ${sentence(s.x)}${s.a ? `\nProduce: ${s.a.join(', ')}.` : ''}`
/** free text on one journal line */
const line = (t: string, n = 160) => { const s = t.replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
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
/** chatName = the chat's name, for its row in the job's context; d = the description;
    ctx = the context as given, kept instead of what the key and chat imply */
export interface NewJob {
  t: string; key: string; pb: string; prj: string; ws: Ws; src?: string; chat?: string; chatName?: string; mail?: string; ev?: string; due?: string
  d?: string; ctx?: CtxItem[]
}
export const DESC_MAX = 20000
/** the description as stored: trimmed, none when blank */
function descOf(v: unknown): string | undefined {
  if (typeof v !== 'string') throw new CmdError('bad_args', 'the description is not text')
  const d = v.trim()
  if (d.length > DESC_MAX) throw new CmdError('bad_args', `the description is longer than ${DESC_MAX} characters`)
  return d || undefined
}
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
  const d = o.d === undefined ? undefined : descOf(o.d)
  if (d) j.d = d
  if (o.ctx !== undefined) {
    if (!Array.isArray(o.ctx)) throw new CmdError('bad_args', 'ctx is not a list')
    const list: CtxItem[] = []
    for (const c of o.ctx) { const it = ctxItem(j.ws, c ?? {}); if (!list.some((y) => y.k === it.k && y.id === it.id)) list.push(it) }
    j.ctx = list
    return j
  }
  const ctx = ctxDefaults(j.ws, j.key, j.chat, typeof o.chatName === 'string' ? o.chatName.trim().slice(0, 120) || undefined : undefined)
  if (ctx.length) j.ctx = ctx
  return j
}

const kindOf = (k: unknown) => {
  if (typeof k !== 'string' || !Object.hasOwn(KINDS, k)) throw new CmdError('bad_args', `unknown context kind ${String(k)}`)
  return KINDS[k as CtxKind]
}
function ctxId(ws: Ws, k: CtxKind, v: unknown) {
  const id = typeof v === 'string' ? v.trim() : ''
  if (!id || id.length > 1000) throw new CmdError('bad_args', 'a context item needs an id')
  if (k === 'work' && parseWorkId(ws, id) !== id) throw new CmdError('bad_args', `${id} is not a work item id`)
  return id
}
function ctxCount(K: Kind, v: unknown) {
  if (K.whole) { if (v !== 1) throw new CmdError('bad_args', `a ${K.l.toLowerCase()} gives ${K.whole}; it has no count`); return 1 }
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > K.max) throw new CmdError('bad_args', `the ${K.unit} count is 1–${K.max}`)
  return v as number
}
/** one context item as a command or a new job gives it, checked */
/** one context item as a job keeps it; throws bad_args naming what is wrong */
export function ctxItem(ws: Ws, c: { k?: unknown; id?: unknown; n?: unknown; name?: unknown }): CtxItem {
  const K = kindOf(c.k), k = c.k as CtxKind
  const it: CtxItem = { k, id: ctxId(ws, k, c.id), n: c.n === undefined ? K.def : ctxCount(K, c.n) }
  const name = typeof c.name === 'string' ? c.name.trim().slice(0, 120) : ''
  if (name) it.name = name
  return it
}

/** adds, recounts or removes one context item; a job without a list starts from its defaults */
function ctxEdit(x: Ctx, j: Job, c: Extract<Cmd, { op: 'ctxAdd' | 'ctxSet' | 'ctxDel' }>) {
  const K = kindOf(c.k), id = ctxId(j.ws, c.k, c.id), what = K.l.toLowerCase()
  const list = ctxOf(j).map((it) => ({ ...it })), i = list.findIndex((it) => it.k === c.k && it.id === id)
  const next = nextTxt(x, j, atOf(x, j))
  if (c.op === 'ctxAdd') {
    if (i >= 0) throw new CmdError('bad_args', `${what} ${ctxLabel(j.ws, list[i])} is already in the context`)
    const it = ctxItem(j.ws, c)
    list.push(it)
    jr(x, j, `Added ${what} ${ctxLabel(j.ws, it)} to the context.`, `LLM runs get ${K.whole ?? `its ${ctxUnit(it)}`}.`, next, by(x), 'ok')
  } else {
    if (i < 0) throw new CmdError('bad_args', `${what} ${id} is not in the context`)
    const it = list[i]
    if (c.op === 'ctxSet') {
      if (K.whole) throw new CmdError('bad_args', `${what} ${ctxLabel(j.ws, it)} gives ${K.whole}; it has no count`)
      it.n = ctxCount(K, c.n)
      jr(x, j, `${K.l} ${ctxLabel(j.ws, it)} now gives the ${ctxUnit(it)}.`, 'context changed for the next LLM runs.', next, by(x), 'ok')
    } else {
      list.splice(i, 1)
      jr(x, j, `Removed ${what} ${ctxLabel(j.ws, it)} from the context.`, 'the next LLM runs no longer get it.', next, by(x), 'ok')
    }
  }
  j.ctx = list
}

/* ===== commands ===== */
/** puts a reached step where its blockers and draft say; true when that made it current */
function settle(f: Flow): boolean {
  const g = settled(f)
  if (!g) return false
  const was = f.s
  f.s = g
  if (g === 'wait' && openOf(f).length) f.m = waitsM(f)
  else if (g === 'bad') f.m = `blocker ${(f.w || []).filter((l) => l.st === 'cancelled').map((l) => l.j).join(', ')} cancelled`
  else if (g === 'cur' && was !== 'cur') f.m = ''
  if (was !== g) f.nw = 1
  return was !== 'cur' && g === 'cur'
}
/** a step the flow moves onto: current, unless its blockers say otherwise */
function onto(g: Flow) { g.s = 'cur'; g.nw = 1; settle(g) }

function advance(x: Ctx, j: Job, sid: string, state: NodeState) {
  const f = j.flow[sid]
  f.s = state; f.nw = 1; f.dr = null
  if (state === 'done') f.arts.forEach((a) => { if (!a.ok) { a.ok = true; a.nw = 1 } })
  if (j.st === 'draft' || j.st === 'ready') j.st = 'active'
  const nx = atOf(x, j)
  if (nx) { const g = j.flow[nx]; if (g.s === 'fut' || g.s === 'tpl') onto(g) }
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
  back.forEach((s) => {
    const old = j.flow[s.id], open = old.b.filter((b) => b.o), w = openOf(old)
    j.flow[s.id] = { ...blank(s), b: open, ...(w.length ? { w } : {}), nw: 1 }
  })
  onto(j.flow[sid])
  if (isClosed(j)) j.st = 'active'
  syncStatus(x, j)
  jr(x, j, `Returned to “${all[ti].t}”: ${why}`, `round ${kept.n + 1} starts here; ${back.length} step${back.length > 1 ? 's' : ''} from “${all[ti].t}” on start again, round ${kept.n} is kept.`,
    `work on “${all[ti].t}”.`, by(x), 'cur')
}

const STEP_OPS = new Set(['returnTo', 'stepDone', 'stepSkip', 'stepWait', 'stepResume', 'stepReopen', 'acceptDraft', 'rejectDraft',
  'noteAdd', 'noteAnswer', 'noteReopen', 'sent', 'vote', 'runStart', 'runReply', 'runDraft', 'runAnswer', 'runEnd', 'artifact',
  'waitAdd', 'waitDel', 'blockerClosed', 'runBlocker', 'blockerDrop'])

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
    if (cmd.op !== 'runEnd' && cmd.op !== 'runAnswer' && cmd.op !== 'artifact' && cmd.op !== 'returnTo' && cmd.op !== 'runBlocker') needOpen()
  }
  const S = s!, F = f!
  const needDraft = () => { if (!F.dr) throw new CmdError('bad_state', `“${S.t}” has no draft`) }
  const noRun = () => { if (F.run) throw new CmdError('bad_state', `“${S.t}” has an LLM run; wait for it or cancel it`) }
  /** an open blocker refuses a done step; force drops them and says so */
  const noBlockers = (force?: boolean) => {
    const open = openOf(F)
    if (!open.length) return
    if (!force) throw new CmdError('bad_state', `“${S.t}” ${waitsM(F)}; remove them, or mark it done with force`)
    F.w = (F.w || []).filter((l) => l.st !== 'open'); if (!F.w.length) delete F.w
    jr(x, j, `Dropped blocker${open.length > 1 ? 's' : ''} ${open.map((l) => l.j).join(', ')} of “${S.t}”.`, 'marked done without waiting for them.', '-', by(x), 'off')
  }
  const badge = (i: number) => { const b = F.b[i]; if (!b) throw new CmdError('bad_args', `no note ${i} on “${S.t}”`); return b }

  switch (cmd.op) {
    case 'start': {
      if (j.st !== 'draft' && j.st !== 'ready') throw new CmdError('bad_state', `${j.id} has already started`)
      const first = atOf(x, j) || steps(x, j.pb)[0].id
      j.st = 'active'; onto(j.flow[first]); nx = first
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
      if (a && (j.flow[a].s === 'fut' || j.flow[a].s === 'tpl')) onto(j.flow[a])
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
    case 'describe': {
      needOpen()
      const d = descOf(cmd.d)
      if (d === j.d) break
      if (d) j.d = d; else delete j.d
      jr(x, j, d ? 'Changed the description.' : 'Removed the description.', d ? 'the next LLM runs get the new text.' : 'the next LLM runs get none.',
        nextTxt(x, j, atOf(x, j)), by(x), 'ok')
      break
    }
    case 'stepDone': {
      noBlockers(cmd.force)
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
      if (openOf(F).length) throw new CmdError('bad_state', `“${S.t}” ${waitsM(F)}; remove them, or mark it done with force`)
      F.s = 'cur'; F.m = ''
      jr(x, j, `Resumed “${S.t}”.`, 'step back in progress.', `finish “${S.t}”.`, by(x), 'cur'); syncStatus(x, j)
      break
    case 'acceptDraft': {
      needDraft(); noRun(); noBlockers(cmd.force)
      const dr = F.dr!, edited = cmd.text != null && cmd.text !== dr.t
      F.out = edited ? cmd.text! : dr.t; F.m = edited ? 'accepted with your edits' : 'draft accepted'
      nx = advance(x, j, sid, 'done')
      jr(x, j, `Accepted the LLM draft for “${S.t}”${edited ? ' with edits' : ''}${cmd.said ? ' as said in the reply' : ''}.`, `step done${nx ? `; “${stepOf(x, j, nx)!.t}” is next` : ''}.`, nextTxt(x, j, nx), by(x), 'ok')
      break
    }
    case 'rejectDraft': {
      needDraft(); noRun()
      const w = line(cmd.why || '', 300)
      F.dr = null; F.s = 'cur'; F.m = 'draft rejected'
      jr(x, j, sentence(`Rejected the LLM draft for “${S.t}”${w ? `: ${w}` : ''}`), 'step back in progress.',
        w ? 'review the new draft when it is ready.' : 'do it yourself, or ask again with a sharper instruction.', by(x), 'bad'); syncStatus(x, j)
      break
    }
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
    case 'runStart': {
      if (F.run) throw new CmdError('bad_state', `“${S.t}” already has an LLM run`)
      F.run = { q: cmd.q, at: nowOf(x).getTime(), id: cmd.id }; F.dr = null; F.s = 'cur'; F.nw = 1
      if (j.st === 'draft' || j.st === 'ready') j.st = 'active'
      const a = cmd.auto ? 'console' : by(x), self = cmd.auto ? ' by itself' : ''
      if (cmd.resumed) jr(x, j, `Resumed the LLM run for “${S.t}”.`, `LLM run continues its session${self}.`, 'review the draft when it is ready.', a, 'cur')
      else jr(x, j, `Asked the LLM for “${S.t}”.`, `LLM run started${self}.`, 'review the draft when it is ready.', a, 'cur')
      syncStatus(x, j)
      break
    }
    case 'runReply': {
      if (F.run) throw new CmdError('bad_state', `“${S.t}” already has an LLM run`)
      needDraft()
      F.run = { q: cmd.q, at: nowOf(x).getTime(), id: cmd.id, reply: 1 }; F.s = 'cur'; F.nw = 1
      const what = cmd.intent === 'ask' ? 'answers' : cmd.intent === 'accept' ? 'revises the draft, then it is accepted' : 'revises the draft'
      if (cmd.resumed) jr(x, j, `Resumed the reply to the LLM draft for “${S.t}”.`, `LLM ${what}.`, 'wait for it.', by(x), 'cur')
      else jr(x, j, `Replied to the LLM draft for “${S.t}”: ${line(cmd.q)}`, `LLM ${what}.`, 'wait for it.', by(x), 'cur')
      syncStatus(x, j)
      break
    }
    case 'runDraft': {
      if (!F.run) throw new CmdError('bad_state', `“${S.t}” has no LLM run`)
      const re = !!F.run.reply
      F.run = null; F.dr = { t: cmd.t, at: nowOf(x).toISOString(), nw: 1 }; F.s = 'wait'; F.m = re ? 'LLM draft revised' : 'LLM draft ready'; F.nw = 1
      jr(x, j, re ? `Draft for “${S.t}” revised.` : `Draft for “${S.t}” is ready.`, 'waiting for your review.', 'accept, edit or reject it.', 'LLM', 'wait'); syncStatus(x, j)
      break
    }
    case 'runAnswer':
      if (!F.run) break
      F.run = null; F.s = F.dr ? 'wait' : 'cur'; F.m = 'LLM answered'; F.nw = 1
      jr(x, j, `The LLM answered on “${S.t}”.`, `answered: ${line(cmd.a)}`, 'read it; accept, reply to or reject the draft.', 'LLM', 'wait'); syncStatus(x, j)
      break
    case 'runEnd': {
      if (!F.run) break
      // a reply's draft outlives the reply
      const re = !!F.run.reply && !!F.dr
      F.run = null; F.s = re ? 'wait' : 'cur'
      const d = cmd.detail ? `: ${cmd.detail}` : '', kept = re ? 'the draft is unchanged.' : 'no draft kept.'
      if (cmd.why === 'cancelled') jr(x, j, `Cancelled the LLM run for “${S.t}”.`, kept, re ? 'accept, reply to or reject the draft.' : 'do it yourself, or ask again.', by(x), 'off')
      else if (cmd.why === 'failed') jr(x, j, `The LLM run for “${S.t}” failed${d}.`, kept,
        re ? 'resume it, reply again, or accept or reject the draft.' : 'resume it, do it yourself, or ask again.', 'LLM', 'bad')
      else jr(x, j, `The LLM run for “${S.t}” was interrupted${d}.`, kept,
        cmd.due ? 'nothing; it resumes by itself when the console is back.' : 'resume it when the console is back.', 'LLM', 'wait')
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
    case 'waitAdd': {
      const bid = (cmd.j || '').trim(), plan = (cmd.plan || '').trim()
      if (!isLive(F)) throw new CmdError('bad_state', `“${S.t}” is ${F.s === 'done' ? 'done' : 'skipped'}`)
      noRun()
      if (bid === j.id) throw new CmdError('bad_args', 'a job cannot wait for itself')
      const b = x.jobOf?.(bid)
      if (!b || b.ws !== j.ws) throw new CmdError('bad_args', `no job ${bid} in this workspace`)
      if (isClosed(b)) throw new CmdError('bad_state', `${bid} is closed`)
      if (openOf(F).some((l) => l.j === bid)) throw new CmdError('bad_state', `“${S.t}” already waits for ${bid}`)
      if (reaches(x.jobOf!, bid, j.id)) throw new CmdError('bad_args', `${bid} already waits for ${j.id}; that would be a cycle`)
      F.w = [...(F.w || []).filter((l) => l.j !== bid), { j: bid, t: b.t, st: 'open', ...(plan ? { plan } : {}) }]
      delete F.bb
      settle(F); F.nw = 1
      jr(x, j, `“${S.t}” waits for ${bid} “${line(b.t, 80)}”.`, plan ? `plan: ${line(plan)}` : 'no plan given.', `it goes on by itself when ${bid} closes.`, by(x), 'wait')
      syncStatus(x, j)
      break
    }
    case 'waitDel': {
      if (!(F.w || []).some((l) => l.j === cmd.j)) throw new CmdError('bad_args', `“${S.t}” does not wait for ${cmd.j}`)
      F.w = F.w!.filter((l) => l.j !== cmd.j); if (!F.w.length) delete F.w
      if (settle(F)) nx = sid
      jr(x, j, `“${S.t}” no longer waits for ${cmd.j}.`, openOf(F).length ? `still ${waitsM(F)}.` : F.s === 'cur' ? 'step back in progress.' : 'step unchanged.',
        nextTxt(x, j, atOf(x, j)), by(x), F.s === 'cur' ? 'cur' : 'wait')
      syncStatus(x, j)
      break
    }
    case 'blockerClosed': {
      const l = (F.w || []).find((y) => y.j === cmd.j)
      if (!l || (l.st === cmd.st && (l.out ?? '') === (cmd.out ?? ''))) break
      l.st = cmd.st; l.at = nowOf(x).toISOString()
      if (cmd.out) l.out = cmd.out; else delete l.out
      if (cmd.st === 'cancelled') F.b = [...F.b, { k: 'p', t: `Blocker ${cmd.j} “${l.t ?? cmd.j}” was cancelled; remove it or link another.`, o: 1, nw: 1 }]
      const on = settle(F)
      if (on) nx = sid
      jr(x, j, `Blocker ${cmd.j} of “${S.t}” ${cmd.st === 'done' ? 'is done' : 'was cancelled'}.`, cmd.out ? `outcome: ${line(cmd.out)}` : 'no outcome.',
        on ? `“${S.t}” goes on.` : F.s === 'bad' ? 'remove the blocker or link another.' : openOf(F).length ? `still ${waitsM(F)}.` : nextTxt(x, j, atOf(x, j)),
        by(x), cmd.st === 'done' ? 'ok' : 'bad')
      syncStatus(x, j)
      break
    }
    case 'runBlocker': {
      if (!F.run) break
      const say = (cmd.say || '').trim()
      F.run = null; F.s = 'cur'; settle(F); F.nw = 1
      F.bb = { say, at: nowOf(x).toISOString() }
      jr(x, j, `Asked for a blocker on “${S.t}”.`, `said: ${line(say)}`, 'open the builder from the step to create or link it.', 'LLM', 'wait')
      syncStatus(x, j)
      break
    }
    case 'blockerDrop':
      if (!F.bb) break
      delete F.bb
      jr(x, j, `Dismissed the blocker asked for on “${S.t}”.`, 'nothing linked.', nextTxt(x, j, atOf(x, j)), by(x), 'off')
      break
    case 'journal':
      jr(x, j, cmd.o, cmd.c, cmd.n, cmd.a || 'LLM', 'cur')
      break
    default:
      throw new CmdError('bad_args', `unknown command ${(cmd as { op: string }).op}`)
  }
  return { job: j, nx }
}
