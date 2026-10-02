import * as React from 'react'
import { BK } from '../data/core.ts'
import { PRI } from '../data/demo.ts'
import { PACKS } from '../data/packs.ts'
import * as api from '../live/api.ts'
import { LIVE } from '../live/api.ts'
import { actFor } from '../live/adapt.ts'
import {
  S, TPL, allSent, applyLocal, byId, chName, clearNew, ctxRows, isLive, keyShort, llmText, plainT, postToChat, putJob,
  restore, rvState, snap, stepOf, steps,
} from '../model/world.ts'
import type { BadgeKind, Cmd, Job, JobStatus } from '../model/types.ts'
import { commit } from '../store.ts'
import { Ic } from '../ui/Icon.tsx'
import { CancelBtn } from '../ui/bits.tsx'
import { closeModal, modal } from '../ui/modal.tsx'
import { toast } from '../ui/toasts.tsx'
import { go } from './nav.tsx'

/* Step and job actions. Every change to a job is a command (model/transitions.ts): the demo applies it
   here, live mode sends it to the backend, which applies the same rules. A dialog keeps the ids it was
   opened for and looks the job up again on submit: an Undo or another tab may have replaced it. */

/** the step the inspector shows */
function here() { const j = byId(S.job!)!, sid = S.sel!; return { j, sid, s: stepOf(j, sid)!, f: j.flow[sid] } }
const TIMERS: Record<string, ReturnType<typeof setTimeout>> = {}

/** what the page says when the backend refuses */
export function failText(e: unknown) {
  if (e instanceof api.ApiError) {
    if (e.status === 503) return 'The bridge is unavailable; nothing was changed.'
    if (e.status === 409) return 'Changed elsewhere — reloaded.'
    return e.message
  }
  return String((e as Error)?.message || e)
}
/** a 409 means the job moved on elsewhere: take the backend's copy */
export async function reloadJob(id: string) {
  try { const { job } = await api.job(id); commit(() => { putJob(job) }) } catch { /* the next event brings it */ }
}
function fail(id: string, e: unknown) {
  toast(failText(e))
  if (e instanceof api.ApiError && e.status === 409) void reloadJob(id)
}

type Done = { job: Job; nx: string | null; undo: () => void }
/** runs a command; msg = a toast with Undo, null = the caller toasts; moveSel = show the next step */
export async function doCmd(id: string, c: Cmd, msg: string | null, o: { moveSel?: boolean } = {}): Promise<Done | null> {
  const sel = (nx: string | null) => { if (o.moveSel && nx) { S.sel = nx; S.focusB = null } }
  let r: Done
  if (!LIVE.on) {
    const x = snap()
    try { r = commit(() => { const r = applyLocal(id, c); sel(r.nx); return r }) as Done } catch (e) { toast(failText(e)); return null }
    // the snapshot still carries what the change before it marked new; an undo marks nothing new
    r.undo = () => { commit(() => { restore(x); clearNew() }); toast('Undone') }
  } else {
    try {
      const res = await api.cmd(id, c, byId(id)?.v)
      commit(() => { putJob(res.job); sel(res.nx) })
      r = {
        job: res.job, nx: res.nx,
        undo: () => {
          api.undo(id, res.job.v!, res.prev)
            .then((u) => { commit(() => { putJob(u.job); clearNew() }); toast('Undone') })
            .catch((e) => fail(id, e))
        },
      }
    } catch (e) { fail(id, e); return null }
  }
  if (msg != null) toast(msg, 'Undo', r.undo)
  return r
}

/** live mode: a message goes out through the bridge first and is recorded only once the bridge says ok */
export async function sendVia(k: string, target: string, text: string, jobId?: string) {
  if (!LIVE.on) return true
  const a = actFor(k, target, text)
  if (!a) { toast(`Nothing sends to ${k} yet.`); return false }
  try {
    const r = await api.act(a.action, a.args, jobId)
    if (r.status === 'ok') return true
    toast(r.status === 'outcome_unknown'
      ? 'Not sure it went out — check before sending again. Nothing recorded.'
      : `Not sent: ${r.error?.message || r.error?.code}. Nothing recorded.`)
  } catch (e) { toast(`Not sent: ${failText(e)}`) }
  return false
}

export function selStep(sid: string) { commit(() => { S.sel = sid; S.focusB = null }) }
export function selBadge(sid: string, i: number) { commit(() => { S.sel = sid; S.focusB = i }) }

export async function stepDone(j: Job, sid: string) {
  const s = stepOf(j, sid)!, id = j.id
  const r = await doCmd(id, { op: 'stepDone', step: sid }, null, { moveSel: true })
  if (!r) return
  if (!r.nx && r.job.st !== 'recurring') toast('All steps are done.', 'Close as done', () => { void closeJob(id, 'done', '') })
  else toast(`Done · ${s.t}`, 'Undo', r.undo)
}
export const stepDoneHere = () => { const { j, sid } = here(); void stepDone(j, sid) }

export async function closeJob(id: string, st: JobStatus, note: string) {
  const j = byId(id)
  if (!j) return
  // a run still going would write into a closed job; the backend ends it, the close records it
  if (LIVE.on) for (const f of Object.values(j.flow)) if (f.run?.id) await api.cancelRun(f.run.id).catch(() => undefined)
  const r = await doCmd(id, { op: 'close', st: st === 'done' ? 'done' : 'cancelled', note }, st === 'done' ? `Closed ${id} as done` : `Cancelled ${id}`)
  if (r) commit(() => { S.sel = null })
}

export function stepSkip() { const { j, sid, s } = here(); void doCmd(j.id, { op: 'stepSkip', step: sid }, `Skipped · ${s.t}`, { moveSel: true }) }
export function stepReopen() { const { j, sid, s } = here(); void doCmd(j.id, { op: 'stepReopen', step: sid }, `Reopened · ${s.t}`, { moveSel: true }) }

export function stepWait() {
  const { j, sid } = here(), id = j.id
  modal({
    title: 'Waiting on others', form: 'wait',
    body: <>
      <label className="field"><span>What are you waiting for?</span><input className="inp" name="m" placeholder="e.g. pipeline queued, an answer from the PO" data-autofocus /></label>
      <p className="why" style={{ margin: 0 }}>The step turns yellow and the job shows as waiting until you resume it.</p>
    </>,
    foot: <><CancelBtn /><button className="btn pri" type="submit"><Ic n="hourglass" sm />Set waiting</button></>,
    onSubmit: (fd) => { closeModal(); void doCmd(id, { op: 'stepWait', step: sid, m: String(fd.get('m') || '').trim() }, 'Set to waiting') },
  })
}

export function stepResume() { const { j, sid } = here(); void doCmd(j.id, { op: 'stepResume', step: sid }, 'Resumed') }

/* ----- the LLM: ask, then accept, edit or reject its draft ----- */
export function askLlm(j: Job, sid: string) {
  const s = stepOf(j, sid)!, id = j.id
  // the same parts, in the same order, as the run's prompt
  const ctx: [string, string][] = [...ctxRows(j),
    ...steps(j.pb).filter((x) => j.flow[x.id].out).map((x): [string, string] => ['bot', `output of “${x.t}”`]), ['list', 'journal, last 20']]
  modal({
    title: `Ask LLM · ${s.t}`, form: 'ask',
    body: <>
      <div className="field"><span className="lbl">Context it gets</span><div className="ctx">{ctx.map(([i, n], k) => <span key={k} className="art"><Ic n={i} sm />{n}</span>)}</div>
        <span className="hint">Read when the run starts; change it in the job's Context panel.</span></div>
      <label className="field"><span>Instruction</span><textarea className="ta" name="q" rows={5} data-autofocus
        defaultValue={`Do: ${s.t}.\nDone when: ${s.x}.${s.a ? `\nProduce: ${s.a.join(', ')}.` : ''}`} /></label>
      <p className="why" style={{ margin: 0 }}>You get a draft back. Nothing is sent or kept until you accept it. <span className="hint">Ctrl+Enter runs it.</span></p>
    </>,
    foot: <><CancelBtn /><button className="btn pri" type="submit"><Ic n="bot" sm />Run</button></>,
    onSubmit: (fd) => { closeModal(); void runLlm(id, sid, String(fd.get('q') || '').trim()) },
  })
}

async function runLlm(id: string, sid: string, q: string) {
  if (LIVE.on) {
    // the backend records runStart itself and streams the run; the job arrives as an event
    try { const { run } = await api.ask(id, sid, q); commit(() => { LIVE.runs[run.id] = run }) } catch (e) { fail(id, e) }
    return
  }
  if (!(await doCmd(id, { op: 'runStart', step: sid, q, id: `demo-${Date.now()}` }, null))) return
  TIMERS[id + '/' + sid] = setTimeout(() => {
    const j = byId(id), s = j && stepOf(j, sid)
    if (!j || !s || !j.flow[sid].run) return
    void doCmd(id, { op: 'runDraft', step: sid, t: llmText(j, s) }, null)
      .then((r) => { if (r) toast(`LLM draft ready · ${s.t}`, 'Review', () => go('job', id, sid)) })
  }, 1700)
}

export async function llmCancel() {
  const { j, sid, f } = here()
  if (LIVE.on) {
    if (!f.run?.id) return
    try { const { run } = await api.cancelRun(f.run.id); commit(() => { LIVE.runs[run.id] = run }) } catch (e) { fail(j.id, e) }
    return
  }
  clearTimeout(TIMERS[j.id + '/' + sid])
  void doCmd(j.id, { op: 'runEnd', step: sid, why: 'cancelled' }, null)
}

/** live only: cancels a run by its record, queued or running */
export async function runCancel(runId: string) {
  try { const { run } = await api.cancelRun(runId); commit(() => { LIVE.runs[run.id] = run }) } catch (e) { toast(failText(e)) }
}

/** live only: continues an interrupted or failed run in its own Claude session */
export async function llmResume(runId: string) {
  try { const { run } = await api.resumeRun(runId); commit(() => { LIVE.runs[run.id] = run }) } catch (e) { toast(failText(e)) }
}

export function acceptDraft(id: string, sid: string, text?: string) {
  const j = byId(id), f = j?.flow[sid]
  if (!j || !f || !f.dr) return
  void doCmd(id, { op: 'acceptDraft', step: sid, ...(text != null ? { text } : {}) }, `Accepted · ${stepOf(j, sid)!.t}`, { moveSel: true })
}

export function rejectDraft(id: string, sid: string) {
  const j = byId(id), f = j?.flow[sid]
  if (!j || !f || !f.dr) return
  void doCmd(id, { op: 'rejectDraft', step: sid }, `Rejected · ${stepOf(j, sid)!.t}`)
}

export function editDraft(id: string, sid: string) {
  const j = byId(id), dr = j?.flow[sid].dr
  if (!j || !dr) return
  modal({
    title: `Edit draft · ${stepOf(j, sid)!.t}`, form: 'edit',
    body: <label className="field"><span>Draft</span><textarea className="ta" name="t" rows={10} data-autofocus defaultValue={dr.t} /></label>,
    foot: <><CancelBtn /><button className="btn pri" type="submit"><Ic n="check" sm />Accept edited</button></>,
    onSubmit: (fd) => { closeModal(); acceptDraft(id, sid, String(fd.get('t') || '')) },
  })
}

/* ----- planned messages ----- */
/** where a planned message goes: a chat by name, the job's work item, or the mail it came from */
const targetOf = (j: Job, k: string, lbl: string) => k === 'work' ? keyShort(j) : k === 'mail' ? j.mail || '' : lbl

export function tplSend(id: string, sid: string, i: number) {
  const j0 = byId(id)
  if (!j0) return
  const [k, lbl, t0] = TPL[sid][i], txt = plainT(j0, t0), unk = [...txt.matchAll(/\{(\w+)\}/g)].map((m) => m[1])
  modal({
    title: 'Review and send', form: 'tpl',
    body: <>
      <div className="src"><Ic n={k === 'work' ? 'file' : 'message'} sm /> {chName(j0, k, lbl)}</div>
      <label className="field"><span>Message</span><textarea className="ta" name="t" rows={6} data-autofocus defaultValue={txt} /></label>
      {unk.length ? <p className="why" style={{ margin: 0, color: 'var(--wait)' }}><Ic n="warn" sm /> Fill in {unk.map((u) => '{' + u + '}').join(', ')} before sending.</p> : null}
      <p className="hint" style={{ margin: 0 }}>{LIVE.on ? 'Sends through the bridge; recorded here once it went out.' : 'Demo: sending only records it here.'}</p>
    </>,
    foot: <><CancelBtn /><button className="btn pri" type="submit"><Ic n="send" sm />Send</button></>,
    onSubmit: async (fd) => {
      const j = byId(id), t = String(fd.get('t') || '').trim()
      if (!j || !t) return
      if (/\{\w+\}/.test(t)) { toast('Fill in the {placeholders} first.'); return }
      if (!(await sendVia(k, targetOf(j, k, lbl), t, id))) return
      closeModal()
      const to = chName(j, k, lbl)
      const r = await doCmd(id, { op: 'sent', step: sid, i, t, to }, null)
      if (!r) return
      if (!LIVE.on) commit(() => postToChat(r.job, k, lbl, t))
      if (allSent(r.job, sid) && isLive(r.job.flow[sid])) toast(`Sent to ${to}`, 'Mark step done', () => { const jj = byId(id); if (jj) void stepDone(jj, sid) })
      else toast(`Sent to ${to}`)
    },
  })
}

/* ----- code review ----- */
export function rvVote() {
  const { j, sid, f } = here(), w = PACKS[j.ws], id = j.id, v = f.rv?.v || [], pending = v.find((x) => x.v === 0)
  modal({
    title: 'Record a vote', form: 'rvvote',
    body: <>
      <div className="f2"><label className="field"><span>Reviewer</span><input className="inp" name="n" list="rvn" defaultValue={pending ? pending.n : ''} data-autofocus />
        <datalist id="rvn">{v.map((x, i) => <option key={i} value={x.n} />)}</datalist></label>
        <label className="field"><span>Vote</span><select className="sel" name="v">{Object.keys(w.votes).sort((a, b) => +b - +a).map((x) => <option key={x} value={x}>{`${+x > 0 ? '+' : ''}${x} · ${w.votes[x]}`}</option>)}</select></label></div>
      <p className="hint" style={{ margin: 0 }}>Votes come from {w.src.review?.n || 'the review tool'}; here you record them by hand.</p>
    </>,
    foot: <><CancelBtn /><button className="btn pri" type="submit">Record</button></>,
    onSubmit: async (fd) => {
      const n = String(fd.get('n') || '').trim(), vv = +String(fd.get('v'))
      if (!n) return
      closeModal()
      const r = await doCmd(id, { op: 'vote', step: sid, n, v: vv }, null)
      if (!r) return
      const st = rvState(r.job, r.job.flow[sid])
      if (!st.veto && st.ok >= st.r.need) toast('Review rule met.', 'Mark step done', () => { const jj = byId(id); if (jj) void stepDone(jj, sid) })
      else toast(`Recorded · ${n}`, 'Undo', r.undo)
    },
  })
}

export function nudge() {
  const { j, f } = here(), w = PACKS[j.ws], pr = PRI[j.id], st = rvState(j, f), left = Math.max(1, st.r.need - st.ok), id = j.id
  modal({
    title: 'Nudge reviewers', form: 'nudge',
    body: <>
      <div className="src"><Ic n="message" sm /> {w.src.chat?.n} · {pr.ch}</div>
      <label className="field"><span>Message</span><textarea className="ta" name="t" rows={4} data-autofocus
        defaultValue={`hi all,\n${pr.id} (${keyShort(j)}) still needs ${left} more approval${left > 1 ? 's' : ''}. Could someone take a look?`} /></label>
      <p className="hint" style={{ margin: 0 }}>{LIVE.on ? 'Sends through the bridge.' : 'Demo: sending only records it here.'}</p>
    </>,
    foot: <><CancelBtn /><button className="btn pri" type="submit"><Ic n="send" sm />Send</button></>,
    onSubmit: async (fd) => {
      const t = String(fd.get('t') || '').trim()
      if (!byId(id) || !t) return
      if (!(await sendVia('chat', pr.ch, t, id))) return
      closeModal()
      const r = await doCmd(id, { op: 'nudged', to: pr.ch }, null)
      if (!r) return
      if (!LIVE.on) commit(() => postToChat(r.job, 'chat', pr.ch, t))
      toast(`Sent to ${pr.ch}`)
    },
  })
}

export function rvOpen() { const { j } = here(); toast(`Would open ${PRI[j.id]?.id || 'the review'} in ${PACKS[j.ws].src.review?.n} (demo)`) }

/* ----- questions and notes on a step ----- */
export function bAdd() {
  const { j, sid } = here(), id = j.id
  modal({
    title: 'Add a question or note', form: 'badd',
    body: <>
      <label className="field"><span>Type</span><select className="sel" name="k">{(Object.keys(BK) as BadgeKind[]).map((k) => <option key={k} value={k}>{BK[k].l}</option>)}</select></label>
      <label className="field"><span>Text</span><textarea className="ta" name="t" rows={3} data-autofocus /></label>
    </>,
    foot: <><CancelBtn /><button className="btn pri" type="submit">Add</button></>,
    onSubmit: async (fd) => {
      const t = String(fd.get('t') || '').trim(), k = String(fd.get('k')) as BadgeKind
      if (!t) return
      closeModal()
      const r = await doCmd(id, { op: 'noteAdd', step: sid, k, t }, null)
      if (r) commit(() => { S.focusB = r.job.flow[sid].b.length - 1 })
    },
  })
}

export function bAnswer(i: number) {
  const { j, sid, f } = here(), b = f.b[i], id = j.id
  modal({
    title: b.k === 'p' ? 'Resolve' : 'Answer', form: 'bans',
    body: <>
      <p style={{ margin: 0 }}>{b.t}</p>
      <label className="field"><span>{b.k === 'p' ? 'Resolution' : 'Answer'}</span><textarea className="ta" name="r" rows={3} data-autofocus defaultValue={b.r || ''} /></label>
    </>,
    foot: <><CancelBtn /><button className="btn pri" type="submit"><Ic n="check" sm />Save</button></>,
    onSubmit: (fd) => {
      const r = String(fd.get('r') || '').trim()
      if (!r) return
      closeModal()
      void doCmd(id, { op: 'noteAnswer', step: sid, i, r }, 'Resolved')
    },
  })
}

export function bReopen(i: number) { const { j, sid } = here(); void doCmd(j.id, { op: 'noteReopen', step: sid, i }, null) }

/* ----- the job as a whole ----- */
export function jobStart() { void doCmd(S.job!, { op: 'start' }, 'Started', { moveSel: true }) }

export function jobCloseAsk() {
  const id = S.job!
  modal({
    title: `Close ${id}`, form: 'close',
    body: <>
      <div className="pbc" role="radiogroup" aria-label="Outcome">
        <label><input type="radio" name="st" value="done" defaultChecked /><b>Done</b><small>The work is finished</small></label>
        <label><input type="radio" name="st" value="cancelled" /><b>Cancelled</b><small>Not doing it</small></label>
      </div>
      <label className="field"><span>Note (optional)</span><input className="inp" name="n" placeholder="Why, or what came out of it" /></label>
    </>,
    foot: <><CancelBtn /><button className="btn pri" type="submit"><Ic n="archive" sm />Close job</button></>,
    onSubmit: (fd) => { closeModal(); void closeJob(id, String(fd.get('st')) as JobStatus, String(fd.get('n') || '').trim()) },
  })
}

export function jobReopen() { void doCmd(S.job!, { op: 'reopen' }, 'Reopened') }
