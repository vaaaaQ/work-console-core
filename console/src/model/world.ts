import { DEFAULT_WS, PACKS } from '../data/packs.ts'
import { PB0 } from '../data/playbooks.ts'
import { CHATS0, JOBS0, JR, LLMS, LOG0, MAIL0, OVR, PRI, RET0, TPL0 } from '../data/demo.ts'
import { clone, hm, norm, refill } from '../lib/util.ts'
import * as T from './transitions.ts'
import { KINDS, ctxLabel, ctxOf, ctxUnit } from './context.ts'
import type { BadgeKind, Chat, Cmd, CtxItem, Flow, Job, LogEntry, Mail, NodeState, Playbook, Src, SrcKey, Step, Tpl, Ui, Ws } from './types.ts'

/* ===== the world: plain mutable data, as in the prototype; the views re-render after each commit() =====
   Empty until install() (src/workspace.ts) seeds it from the registered workspaces through resetWorld(). */
export const PB: Record<string, Playbook> = {}
export const TPL: Record<string, Tpl[]> = {}
export const JOBS: Job[] = []
export const LOG: Record<Ws, LogEntry[]> = {}
export const CHATS: Record<Ws, Chat[]> = {}
export const MAIL: Partial<Record<Ws, Mail[]>> = {}
const ui = (): Ui => ({
  ws: DEFAULT_WS, view: 'jobs', job: null, sel: null, f: 'all', prj: 'all', q: '', flash: null,
  chat: { [DEFAULT_WS]: 'c1' }, mail: 'm1', mcat: 'reply', pbv: null, sum: {}, focusB: null, cd: {},
  pbRet: null, wide: null,
})
export const S: Ui = ui()
/** the world as the installed workspaces seed it, rebuilt in place so every module keeps its reference */
export function resetWorld() {
  refill(PB, clone(PB0)); refill(TPL, clone(TPL0))
  JOBS.splice(0, JOBS.length, ...(clone(JOBS0) as Job[]))
  refill(LOG, clone(LOG0)); refill(CHATS, clone(CHATS0)); refill(MAIL, clone(MAIL0)); refill(S, ui())
}

/* ===== workspace (pack) helpers ===== */
export const W = () => PACKS[S.ws]
export const wsJobs = () => JOBS.filter((j) => j.ws === S.ws)
/** the playbooks a workspace offers; a once playbook is one job's own steps, so none lists it */
export const pbs = (ws = S.ws) => Object.keys(PB).filter((k) => !PB[k].once && (!PB[k].ws || PB[k].ws === ws))
export const keyShort = (j: Job) => { const r = PACKS[j.ws].strip; return r ? j.key.replace(r, '') : j.key }

/* ===== job helpers: the transitions module holds the rules; these bind it to this world ===== */
export const CTX: T.Ctx = { PB, TPL }
export const byId = (id: string | null | undefined) => JOBS.find((j) => j.id === id)
export const steps = (pb: string) => T.steps(CTX, pb)
export const stepOf = (j: Job, id: string | null) => T.stepOf(CTX, j, id)
export const phaseOf = (j: Job, id: string) => PB[j.pb].ph.find((p) => p.s.some((s) => s.id === id))
export const { isClosed, isLive, flows, hasDraft } = T
export const atOf = (j: Job) => T.atOf(CTX, j)
/** the open job in this workspace whose current step carries a console action */
export const jobAtAct = (act: string) => wsJobs().find((j) => !isClosed(j) && stepOf(j, atOf(j))?.act === act)
/** the job an act's view links to: the one at a step with the act, else an open one (recurring too) whose playbook has such a step */
export const jobForAct = (act: string) => jobAtAct(act) || wsJobs().find((j) => !isClosed(j) && steps(j.pb).some((s) => s.act === act))
/** the job the Time view links to: jobForAct('time'), else a recurring one named for timesheets */
export const timesheetJob = () => jobForAct('time') || wsJobs().find((j) => j.st === 'recurring' && /timesheet/i.test(`${j.t} ${j.key}`))
export const openBadges = (j: Job, k?: BadgeKind) => flows(j).reduce((a, f) => a + f.b.filter((b) => b.o && (k ? b.k === k : b.k !== 'p')).length, 0)
export const unsentAt = (j: Job) => T.unsentAt(CTX, j)
export const needsYou = (j: Job) => T.needsYou(CTX, j)
export const syncStatus = (j: Job) => T.syncStatus(CTX, j)
export const nextTxt = (j: Job, nx: string | null) => T.nextTxt(CTX, j, nx)
export const allSent = (j: Job, sid: string) => T.allSent(CTX, j, sid)
export const { rvState } = T
export function initFlow(j: Job) {
  T.seedFlow(CTX, j, OVR[j.id], JR[j.id])
  const r = RET0[j.id]
  if (!r) return
  const all = T.steps(CTX, j.pb), last = all.findIndex((s) => s.id === r.upTo)
  const flow = clone(j.flow)
  all.forEach((s, i) => { const f = flow[s.id]; f.s = i <= last ? 'done' : s.msg ? 'tpl' : 'fut'; f.arts.forEach((a) => { a.ok = i <= last }); f.dr = null })
  j.rounds = [{ n: 1, from: all[0].id, at: r.at, by: r.by, why: r.why, st: 'waiting-external', flow }]
  j.rf = r.to
}
export function phState(j: Job, p: { s: Step[] }): NodeState {
  const ss = p.s.map((s) => j.flow[s.id].s)
  if (ss.every((s) => s === 'skip')) return 'skip'
  if (ss.every((s) => s === 'done' || s === 'skip')) return 'done'
  if (ss.includes('bad')) return 'bad'
  if (ss.includes('wait')) return 'wait'
  if (ss.includes('cur') || ss.includes('done')) return 'cur'
  return 'fut'
}
/** what the last change marked new shows once; the next change clears it */
export function clearNew() {
  S.flash = null
  JOBS.forEach((j) => {
    j.jr.forEach((e) => { e.nw = 0 })
    flows(j).forEach((f) => { f.nw = 0; if (f.dr) f.dr.nw = 0; f.b.forEach((b) => { b.nw = 0 }); f.arts.forEach((a) => { a.nw = 0 }) })
  })
  Object.values(LOG).forEach((l) => l.forEach((e) => { e.nw = 0 }))
}

/** a context item's row label: its name, a loaded chat's name, or its id */
export const ctxName = (j: Job, it: CtxItem) => it.name || (it.k === 'chat' && (CHATS[j.ws] || []).find((c) => c.id === it.id)?.name) || ctxLabel(j.ws, it)
/** what a run's prompt will carry from the job's context, as [icon, text] */
export const ctxRows = (j: Job): [string, string][] => ctxOf(j).map((it) => [KINDS[it.k].ic, `${KINDS[it.k].l} ${ctxName(j, it)} · ${ctxUnit(it)}`])

/* ===== changing jobs ===== */
export const chName = (j: Job, k: string, lbl: string) => `${PACKS[j.ws].src[k as SrcKey]?.n || k} · ${lbl}`
/** a job from a workspace that no longer exists lands in the default one */
const known = (j: Job) => { if (!Object.hasOwn(PACKS, j.ws)) j.ws = DEFAULT_WS; return j }
/** puts a changed job in place and adds its new journal entries to the workspace log */
export function putJob(j: Job) {
  known(j)
  const i = JOBS.findIndex((x) => x.id === j.id), old = i >= 0 ? JOBS[i] : undefined
  // the HTTP reply and the event for the same write both arrive; the second is not news
  if (old && old.v != null && j.v != null && j.v <= old.v) return false
  if (i >= 0) JOBS[i] = j; else JOBS.unshift(j)
  const fresh = old ? j.jr.slice(0, Math.max(0, j.jr.length - old.jr.length)) : j.jr.slice(0, 1)
  LOG[j.ws].unshift(...fresh.map((e) => ({ at: hm(new Date(e.ts)), ts: e.ts, job: j.id, a: e.a, l: e.l || 'ok', t: e.o, nw: 1 as const })))
  return true
}
/** demo mode: the command runs here, on the in-memory world */
export function applyLocal(id: string, cmd: Cmd) {
  const j = byId(id)
  if (!j) throw new T.CmdError('bad_args', `no job ${id}`)
  const r = T.apply(CTX, j, cmd)
  r.job.v = (j.v || 0) + 1
  putJob(r.job)
  return { job: r.job, nx: r.nx }
}
/** live mode: the backend's jobs replace the demo's, and the log is rebuilt from their journals */
export function setJobs(list: Job[]) {
  JOBS.splice(0, JOBS.length, ...list.map(known))
  ;(Object.keys(LOG) as Ws[]).forEach((ws) => {
    LOG[ws] = list.filter((j) => j.ws === ws).flatMap((j) => j.jr.map((e) => ({ ...e, job: j.id })))
      .sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 200)
      .map((e) => ({ at: hm(new Date(e.ts)), ts: e.ts, job: e.job, a: e.a, l: e.l || 'ok', t: e.o }))
  })
}
export type Snap = { J: Job[]; L: Record<Ws, LogEntry[]> }
export const snap = (): Snap => ({ J: clone(JOBS), L: clone(LOG) })
/** demo undo puts the jobs and the log back; a run in flight is dropped, so its timer finds nothing to finish */
export function restore(x: Snap) {
  JOBS.splice(0, JOBS.length, ...x.J)
  ;(Object.keys(x.L) as Ws[]).forEach((k) => { LOG[k] = x.L[k] })
  JOBS.forEach((j) => flows(j).forEach((f) => { if (f.run) { f.run = null; f.s = 'cur' } }))
}
/** demo mode: the prefix the workspace's jobs carry (J when it has none), numbered past that prefix's highest */
export function nextJobId(ws: Ws) {
  const cut = (id: string) => { const i = id.indexOf('-'); return i > 0 ? [id.slice(0, i), id.slice(i + 1)] as const : null }
  const own = JOBS.filter((j) => j.ws === ws).map((j) => cut(j.id)).find((x) => x !== null), prefix = own ? own[0] : 'J'
  const n = Math.max(0, ...JOBS.map((j) => cut(j.id)).map((x) => (x && x[0] === prefix ? +x[1] || 0 : 0)))
  return `${prefix}-${String(n + 1).padStart(4, '0')}`
}
/** demo mode: the new job lands in the world, and a mail it starts from is marked handled */
export function createJob(o: T.NewJob) {
  const j = T.freshJob(CTX, nextJobId(o.ws), o)
  if (o.mail) { const m = (MAIL[o.ws] || []).find((x) => x.id === o.mail); if (m) { m.job = j.id; m.done = true } }
  putJob(j)
  return j
}

/* ===== the LLM only runs when you ask, and only returns a draft ===== */
/** what a job's key points at: a work item by default, a build for playbooks that start from one */
export const keySrc = (j: Job): Src => { const s = PACKS[j.ws].src, ks = PB[j.pb]?.ks; return (ks && s[ks]) || s.work! }
export function llmText(j: Job, s: Step) {
  const k = LLMS[j.id + '/' + s.id]; if (k) return k
  const ks = keySrc(j)
  return `${s.t}: draft for ${j.key}\n\n• Based on the ${ks.n} ${ks.item}, the journal and the earlier steps.\n• ${s.a ? 'Proposed ' + s.a.join(', ') + '.' : 'Proposed result, ready for your edits.'}\n• Check before you accept: ${s.x}.`
}

/* ===== messages and review ===== */
export function tvars(j: Job) {
  const w = PACKS[j.ws], pr = PRI[j.id]
  const v: Record<string, string | null | undefined> = { key: keyShort(j), po: w.people.po, pr: pr && pr.id, reporter: j.vars && j.vars.reporter }
  steps(j.pb).forEach((s) => { if (s.out) v[s.out] = j.flow[s.id].out })
  return v
}
export const plainT = (j: Job, t: string) => { const v = tvars(j); return t.replace(/\{(\w+)\}/g, (m, k) => v[k] || m) }
export function postToChat(j: Job, k: string, lbl: string, t: string) {
  if (k !== 'chat') return
  const L = CHATS[j.ws] || [], c = L.find((c) => norm(c.name) === norm(lbl)) || (j.chat && L.find((c) => c.id === j.chat))
  if (c) { c.msgs.push({ who: 'You', me: 1, at: hm(), t }); c.unread = 0 }
}

/* ===== approvals: every LLM draft and planned message, in one list ===== */
export type Approval = { k: 'draft'; j: Job; s: Step; f: Flow } | { k: 'msg'; j: Job; s: Step; f: Flow; i: number }
export function approvals() {
  const out: Approval[] = []
  wsJobs().filter((j) => !isClosed(j)).forEach((j) => {
    steps(j.pb).forEach((s) => { const f = j.flow[s.id]; if (f.dr) out.push({ k: 'draft', j, s, f }) })
    const id = unsentAt(j) ? atOf(j) : null, f = id && j.flow[id]
    if (id && f && !f.dr && !f.run) TPL[id].forEach((_, i) => { if (!f.sent[i]) out.push({ k: 'msg', j, s: stepOf(j, id)!, f, i }) })
  })
  return out.sort((a, b) => b.j.ts - a.j.ts)
}
