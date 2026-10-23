import * as React from 'react'
import { BK } from '../data/core.ts'
import { PRI } from '../data/demo.ts'
import { PACKS } from '../data/packs.ts'
import * as api from '../live/api.ts'
import { LIVE } from '../live/api.ts'
import { down, loadSources } from '../live/boot.ts'
import { actFor, addrs, isAddr } from '../live/adapt.ts'
import {
  S, allSent, applyLocal, byId, chName, chatOf, clearNew, ctxRows, draftReport, goesBack, isLive, jsteps, keyShort, llmText, plainT, postToChat, putJob,
  restore, rvState, snap, stepOf, tplOf,
} from '../model/world.ts'
import { openOf } from '../model/blockers.ts'
import { ctxOf } from '../model/context.ts'
import { askText, cmdsN, latestBranch, openQs, qsM } from '../model/transitions.ts'
import { CTX } from '../model/world.ts'
import type { BadgeKind, Cmd, Job, JobStatus, RunRec } from '../model/types.ts'
import { commit } from '../store.ts'
import { Ic } from '../ui/Icon.tsx'
import { CancelBtn, copy } from '../ui/bits.tsx'
import { ChatTo } from '../ui/ChatTo.tsx'
import { closeModal, modal } from '../ui/modal.tsx'
import { toast } from '../ui/toasts.tsx'
import { VoiceField } from '../ui/VoiceField.tsx'
import { confirmForce } from './blockers.tsx'
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
    if (e.status === 503) return `${down().off}; nothing was changed.`
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

/** run = the LLM run a reject with a reason started; redo = why it did not start */
type Done = { job: Job; nx: string | null; undo: () => void; run?: RunRec; redo?: string }
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
      commit(() => { putJob(res.job); sel(res.nx); if (res.run) LIVE.runs[res.run.id] = res.run })
      r = {
        job: res.job, nx: res.nx, run: res.run, redo: res.redo,
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
export async function sendVia(k: string, target: string, text: string, jobId?: string, mail?: { to: string; cc?: string; subject: string }) {
  if (!LIVE.on) return true
  const a = actFor(k, target, text, mail)
  if (!a) { toast(`Nothing sends to ${k} yet.`); return false }
  // the job's workspace sends; a message from a source view goes out through the one on screen
  const ws = (jobId && byId(jobId)?.ws) || S.ws
  try {
    const r = await api.act(ws, a.action, a.args, jobId)
    if (r.status === 'ok') return true
    toast(r.status === 'outcome_unknown'
      ? 'Not sure it went out — check before sending again. Nothing recorded.'
      : `Not sent: ${r.error?.message || r.error?.code}. Nothing recorded.`)
  } catch (e) { toast(`Not sent: ${failText(e)}`) }
  return false
}

export function selStep(sid: string) { commit(() => { S.sel = sid; S.focusB = null }) }
export function selBadge(sid: string, i: number) { commit(() => { S.sel = sid; S.focusB = i }) }

export async function stepDone(j: Job, sid: string, force = false) {
  if (!force && openOf(j.flow[sid]).length) { confirmForce(j, sid, () => void stepDone(j, sid, true)); return }
  const s = stepOf(j, sid)!, id = j.id
  const r = await doCmd(id, { op: 'stepDone', step: sid, ...(force ? { force } : {}) }, null, { moveSel: true })
  if (!r) return
  if (!r.nx && r.job.st !== 'recurring') toast('All steps are done.', 'Close as done', () => { void closeJob(id, 'done', '') })
  else toast(`Done · ${s.t}`, 'Undo', r.undo)
}
export const stepDoneHere = () => { const { j, sid } = here(); void stepDone(j, sid) }

/** a review step closed by a person: Accept with an optional note, or Send back with why and where to; the note becomes the review fact's */
export function reviewStep(verdict: 'accepted' | 'sent_back', force = false) {
  const { j, sid, s } = here(), id = j.id, back = verdict === 'sent_back'
  // Accept over open blockers asks first and drops them, as Mark done does
  if (!back && !force && openOf(j.flow[sid]).length) { confirmForce(j, sid, () => reviewStep(verdict, true)); return }
  const all = jsteps(j), i = all.findIndex((t) => t.id === sid), passed = all.slice(0, Math.max(i, 0))
  const def = latestBranch(CTX, j)?.step ?? passed.at(-1)?.id
  if (back && !passed.length) { toast('No step before this one to send it back to'); return }
  modal({
    title: back ? `Send “${s.t}” back` : `Accept “${s.t}”`, form: 'review',
    body: <>
      <label className="field"><span>{back ? 'Why does it go back?' : 'Note (optional)'}</span><VoiceField name="note" target="llm" ctx={s.t} rows={3} autoFocus
        placeholder={back ? 'What has to change' : 'What you checked'} /></label>
      {back ? <label className="field"><span>Back to</span><select name="to" defaultValue={def}>{passed.map((t) => <option key={t.id} value={t.id}>{t.t}</option>)}</select></label> : null}
      <p className="why" style={{ margin: 0 }}>{back ? 'The steps from there on start again; this pass is kept as a round. The note goes on the review fact and into the next runs’ prompts.'
        : 'The step is done; the note goes on the review fact with the latest branch commit.'}</p>
    </>,
    foot: <><CancelBtn /><button className="btn pri" type="submit"><Ic n={back ? 'retry' : 'check'} sm />{back ? 'Send back' : 'Accept'}</button></>,
    onSubmit: (fd) => {
      const note = String(fd.get('note') || '').trim(), to = String(fd.get('to') || '')
      if (back && !note) { toast('Say why it goes back'); return }
      closeModal()
      void doCmd(id, { op: 'review', step: sid, verdict, ...(note ? { note } : {}), ...(back && to ? { to } : {}), ...(force ? { force } : {}) }, back ? `Sent back · ${s.t}` : `Accepted · ${s.t}`, { moveSel: true })
    },
  })
}

export async function closeJob(id: string, st: JobStatus, note: string) {
  const j = byId(id)
  if (!j) return
  // a run still going would write into a closed job; the backend ends it, the close records it
  if (LIVE.on) for (const f of Object.values(j.flow)) if (f.run?.id) await api.cancelRun(f.run.id).catch(() => undefined)
  const r = await doCmd(id, { op: 'close', st: st === 'done' ? 'done' : 'cancelled', note }, st === 'done' ? `Closed ${id} as done` : `Cancelled ${id}`)
  if (r) commit(() => { S.sel = null })
}

export function stepSkip() { const { j, sid, s } = here(); void doCmd(j.id, { op: 'stepSkip', step: sid }, `Skipped · ${s.t}`, { moveSel: true }) }
export function stepReopen() {
  const { j, sid, s } = here(), id = j.id
  if (!goesBack(j, sid)) { void doCmd(id, { op: 'stepReopen', step: sid }, `Reopened · ${s.t}`, { moveSel: true }); return }
  // the steps after it were built on it: they start again in a new round, the old one is kept
  modal({
    title: `Go back to “${s.t}”`, form: 'reopen',
    body: <>
      <label className="field"><span>Why does the job go back? (optional)</span><VoiceField name="why" target="llm" ctx={s.t} rows={2} autoFocus
        placeholder="e.g. new requirements from the PO" /></label>
      <p className="why" style={{ margin: 0 }}>Every step after it starts again, so the work built on the old version is done anew.
        The current pass is kept as a round. Messages sent in it go out again and say what changed.</p>
    </>,
    foot: <><CancelBtn /><button className="btn pri" type="submit"><Ic n="retry" sm />Go back</button></>,
    onSubmit: (fd) => {
      closeModal()
      const why = String(fd.get('why') || '').trim()
      void doCmd(id, { op: 'stepReopen', step: sid, ...(why ? { why } : {}) }, `Back to · ${s.t}`, { moveSel: true })
    },
  })
}

export function stepWait() {
  const { j, sid } = here(), id = j.id
  modal({
    title: 'Waiting on others', form: 'wait',
    body: <>
      <label className="field"><span>What are you waiting for?</span><VoiceField name="m" target="llm" ctx={stepOf(j, sid)!.t} rows={2} autoFocus
        placeholder="e.g. pipeline queued, an answer from the PO" /></label>
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
    ...jsteps(j).filter((x) => j.flow[x.id].out).map((x): [string, string] => ['bot', `output of “${x.t}”`]), ['list', 'journal, last 20']]
  modal({
    title: `Ask LLM · ${s.t}`, form: 'ask',
    body: <>
      <div className="field"><span className="lbl">Context it gets</span><div className="ctx">{ctx.map(([i, n], k) => <span key={k} className="art"><Ic n={i} sm />{n}</span>)}</div>
        <span className="hint">Read when the run starts; change it in the job's Context panel.</span></div>
      <label className="field"><span>Instruction</span><VoiceField name="q" target="llm" rows={5} autoFocus defaultValue={askText(s)} ctx={askText(s)} /></label>
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

/** live, on the PC: the step taken up by hand in the manual provider; a link opens the app, a command goes to the clipboard */
export async function openStep(id: string, sid: string) {
  try {
    const { open, label } = await api.openStep(id, sid)
    if (open.kind === 'link') { location.href = open.value; toast(<>Opening <b>{label}</b>…</>) }
    else copy(open.value, null, <>Copied — paste it in a terminal to go on in <b>{label}</b></>)
  } catch (e) { toast(failText(e)) }
}

/** live only: continues an interrupted or failed run in its own Claude session */
export async function llmResume(runId: string) {
  try { const { run } = await api.resumeRun(runId); commit(() => { LIVE.runs[run.id] = run }) } catch (e) { toast(failText(e)) }
}

export function acceptDraft(id: string, sid: string, text?: string, force = false, anyway = false) {
  const j = byId(id), f = j?.flow[sid]
  if (!j || !f || !f.dr) return
  // open questions stay open after the accept; the person says they go on without the answers, before anything else is asked
  if (!anyway && openQs(f).length) { confirmQuestions(j, sid, () => acceptDraft(id, sid, text, force, true)); return }
  // a draft that reports it did not finish asks how: go back, keep the step open, or mark it done anyway
  if (f.dr.o) { acceptReported(id, sid, text); return }
  if (!force && openOf(f).length) { confirmForce(j, sid, () => acceptDraft(id, sid, text, true, anyway)); return }
  void doCmd(id, { op: 'acceptDraft', step: sid, ...(text != null ? { text } : {}), ...(force ? { force } : {}) }, `Accepted · ${stepOf(j, sid)!.t}`, { moveSel: true })
}

/** a draft accepted over the step's open questions: they stay open on the step */
function confirmQuestions(j: Job, sid: string, go: () => void) {
  const qs = openQs(j.flow[sid])
  modal({
    title: 'Questions still open',
    body: <><p>{qsM(qs.length)} on “{stepOf(j, sid)?.t}” {qs.length === 1 ? 'stays' : 'stay'} open. Accept anyway?</p>
      <ul>{qs.map((b, i) => <li key={i}>{b.t}</li>)}</ul></>,
    foot: <><button type="button" className="btn" onClick={closeModal}>Cancel</button>
      <button type="button" className="btn pri" onClick={() => { closeModal(); go() }}>Accept anyway</button></>,
  })
}

/** the dialog on a draft that reports not done or failed: Mark done anyway is the only way it closes the step */
function acceptReported(id: string, sid: string, text?: string) {
  const j = byId(id), dr = j?.flow[sid].dr
  if (!j || !dr?.o) return
  const t = stepOf(j, sid)!.t, back = dr.rt ? stepOf(j, dr.rt)?.t : undefined, rep = dr.o === 'failed' ? 'failed' : 'not done'
  const send = (extra: { stay?: true; asDone?: true }, say: string, force = false) => {
    closeModal()
    const f = byId(id)?.flow[sid]
    if (extra.asDone && !force && f && openOf(f).length) { confirmForce(byId(id)!, sid, () => send(extra, say, true)); return }
    void doCmd(id, { op: 'acceptDraft', step: sid, ...(text != null ? { text } : {}), ...extra, ...(force ? { force } : {}) }, say, { moveSel: true })
  }
  modal({
    title: `The draft reports ${rep} · ${t}`,
    body: <>
      <p>{draftReport(j, dr)}</p>
      <p className="why" style={{ margin: 0 }}>Accepting keeps the draft as the step’s output. The step is not marked done unless you say so.</p>
    </>,
    foot: <><CancelBtn />
      <button type="button" className="btn" onClick={() => send({ asDone: true }, `Marked done although it reported ${rep} · ${t}`)}>Mark done anyway</button>
      <button type="button" className={'btn' + (back ? '' : ' pri')} onClick={() => send({ stay: true }, `Kept open · ${t}`)}>Keep the step open</button>
      {back && <button type="button" className="btn pri" onClick={() => send({}, `Back to ${back}`)}><Ic n="check" sm />Return to {back}</button>}</>,
  })
}

/** a draft that waits for commands the person ran outside the console: accepting it says so, and only then closes the step */
export function acceptRan(id: string, sid: string, force = false) {
  const j = byId(id), f = j?.flow[sid], cm = f?.dr?.cm
  if (!j || !f || !cm?.length) return
  const t = stepOf(j, sid)!.t
  const send = (force: boolean) => {
    closeModal()
    const g = byId(id)?.flow[sid]
    if (!force && g && openOf(g).length) { confirmForce(byId(id)!, sid, () => send(true)); return }
    void doCmd(id, { op: 'acceptDraft', step: sid, ran: true, ...(force ? { force } : {}) }, `Accepted; you ran its commands · ${t}`, { moveSel: true })
  }
  modal({
    title: `You ran its ${cmdsN(cm.length)} yourself? · ${t}`,
    body: <>
      <ol className="mono">{cm.map((c, i) => <li key={i} style={{ whiteSpace: 'pre-wrap' }}>{c}</li>)}</ol>
      <p className="why" style={{ margin: 0 }}>Accepting closes the step as done. Use Approve instead to have the LLM run them in its session and report what they printed.</p>
    </>,
    foot: <><CancelBtn /><button type="button" className="btn pri" onClick={() => send(force)}><Ic n="check" sm />I ran them</button></>,
  })
}

/** with a reason, live, the LLM redoes the step in a new session */
export function rejectDraft(id: string, sid: string) {
  const j = byId(id), dr = j?.flow[sid].dr
  if (!j || !dr) return
  const t = stepOf(j, sid)!.t
  const reject = async (why: string) => {
    closeModal()
    const r = await doCmd(id, { op: 'rejectDraft', step: sid, ...(why ? { why } : {}) }, null)
    if (!r) return
    toast(r.redo ? `Rejected; the redo did not start: ${r.redo}` : r.run ? `Rejected; the LLM redoes it · ${t}` : `Rejected · ${t}`, 'Undo', r.undo)
  }
  modal({
    title: `Reject the draft · ${t}`, form: 'reject',
    body: <>
      <label className="field"><span>Why?</span><VoiceField name="why" target="llm" ctx={dr.t} rows={3} autoFocus placeholder="What is wrong with it" /></label>
      <p className="why" style={{ margin: 0 }}>{LIVE.on ? 'With a reason the LLM redoes the step in a new session; without one the step just goes back.' : 'The reason goes into the journal.'}</p>
    </>,
    foot: <><CancelBtn /><button type="button" className="btn" onClick={() => void reject('')}>Just reject</button>
      <button className="btn pri" type="submit"><Ic n="x" sm />{LIVE.on ? 'Reject and redo' : 'Reject'}</button></>,
    onSubmit: (fd) => { void reject(String(fd.get('why') || '').trim()) },
  })
}

export function editDraft(id: string, sid: string) {
  const j = byId(id), dr = j?.flow[sid].dr
  if (!j || !dr) return
  modal({
    title: `Edit draft · ${stepOf(j, sid)!.t}`, form: 'edit',
    body: <label className="field"><span>Draft</span><VoiceField name="t" target="llm" rows={10} autoFocus defaultValue={dr.t} ctx={`done when: ${stepOf(j, sid)!.x}`} /></label>,
    foot: <><CancelBtn /><button className="btn pri" type="submit"><Ic n="check" sm />Accept edited</button></>,
    onSubmit: (fd) => { closeModal(); acceptDraft(id, sid, String(fd.get('t') || '')) },
  })
}

/* ----- planned messages ----- */
/** where a planned message goes: a chat by id (chatOf), the job's work item, or the mail it came from */
const targetOf = (j: Job, k: string, lbl: string) => k === 'work' ? keyShort(j) : k === 'mail' ? j.mail || '' : k === 'chat' ? chatOf(j, lbl)?.id || '' : lbl

/** the chat the To picked: a listed one as it is, a person's or an address's 1:1 opened first; a chat other than the
    planned one joins the job's context, so the next message finds it and a reply in it is seen */
async function chatTo(j: Job, fd: FormData, planned: string): Promise<{ id: string; name: string } | null> {
  const addr = String(fd.get('toAddr') || ''), name = String(fd.get('toName') || '')
  let id = String(fd.get('toChat') || ''), nm = name
  if (!id && !addr) { toast('Pick who it goes to first.'); return null }
  if (!id && !LIVE.on) id = `c-1on1-${addr.toLowerCase()}`
  else if (!id) {
    const no = (why: string) => { toast(`No chat opened with ${addr}: ${why}. Nothing was sent.`); return null }
    try {
      const r = await api.act(j.ws, 'chat.open', { to: addr }, j.id), res = (r.result ?? {}) as { chat?: unknown; name?: unknown }
      if (r.status !== 'ok' || typeof res.chat !== 'string') return no(r.error?.message || r.error?.code || 'the bridge named no chat')
      id = res.chat
      if (typeof res.name === 'string' && res.name) nm = res.name
    } catch (e) { return no(failText(e)) }
  }
  if (id !== planned && !ctxOf(j).some((it) => it.k === 'chat' && it.id === id) && !(await doCmd(j.id, { op: 'ctxAdd', k: 'chat', id, name: nm }, null))) return null
  return { id, name: nm }
}

export function tplSend(id: string, sid: string, i: number) {
  const j0 = byId(id)
  if (!j0) return
  const [k, lbl, t0, head] = tplOf(j0, sid)[i], txt = plainT(j0, t0), unk = [...txt.matchAll(/\{(\w+)\}/g)].map((m) => m[1])
  // a mail with To is a new mail: its head is checked and sent with it
  const nm = k === 'mail' && !!lbl
  // a chat message shows who it goes to, the planned chat picked: a label that names no chat falls back to the job's
  // own, and that has to be seen and changeable before it goes out
  const plan = k === 'chat' ? chatOf(j0, lbl) : undefined
  modal({
    title: 'Review and send', form: 'tpl',
    body: <>
      <div className="src"><Ic n={k === 'work' ? 'file' : k === 'mail' ? 'mail' : 'message'} sm /> {nm ? `${PACKS[j0.ws].src.mail?.n || 'mail'} · new mail` : k === 'chat' ? PACKS[j0.ws].src.chat?.n || 'chat' : chName(j0, k, lbl)}</div>
      {k === 'chat' ? <div className="field"><span>To</span><ChatTo ws={j0.ws} init={plan && { chat: plan.id, name: plan.name }} /></div> : null}
      {nm ? <>
        <label className="field"><span>To</span><input className="inp" name="to" required defaultValue={plainT(j0, lbl)} /></label>
        <label className="field"><span>CC</span><input className="inp" name="cc" defaultValue={plainT(j0, head?.cc || '')} /></label>
        <label className="field"><span>Subject</span><input className="inp" name="subject" required defaultValue={plainT(j0, head?.subject || '')} /></label>
      </> : null}
      <label className="field"><span>Message</span><VoiceField name="t" target="people" rows={6} autoFocus={k !== 'chat' || !!plan} defaultValue={txt} ctx={txt} /></label>
      {unk.length ? <p className="why" style={{ margin: 0, color: 'var(--wait)' }}><Ic n="warn" sm /> Fill in {unk.map((u) => '{' + u + '}').join(', ')} before sending.</p> : null}
      <p className="hint" style={{ margin: 0 }}>{LIVE.on ? 'Sends through the bridge; recorded here once it went out.' : 'Demo: sending only records it here.'}</p>
    </>,
    foot: <><CancelBtn /><button className="btn pri" type="submit"><Ic n="send" sm />Send</button></>,
    onSubmit: async (fd) => {
      const j = byId(id), t = String(fd.get('t') || '').trim()
      if (!j || !t) return
      const mail = nm ? { to: String(fd.get('to') || '').trim(), cc: String(fd.get('cc') || '').trim(), subject: String(fd.get('subject') || '').trim() } : undefined
      if (/\{\w+\}/.test(t) || (mail && /\{\w+\}/.test(mail.to + mail.cc + mail.subject))) { toast('Fill in the {placeholders} first.'); return }
      if (mail) {
        const bad = [...addrs(mail.to), ...addrs(mail.cc)].filter((a) => !isAddr(a))
        if (!addrs(mail.to).length || !mail.subject) { toast('A new mail needs To and a subject.'); return }
        if (bad.length) { toast(`Not a mail address: ${bad.join(', ')}`); return }
      }
      let to0 = targetOf(j, k, lbl), via = ''
      if (k === 'chat') {
        const c = await chatTo(j, fd, plan?.id ?? '')
        if (!c) return
        to0 = c.id; via = c.name
      }
      if (!(await sendVia(k, to0, t, id, mail))) return
      closeModal()
      // a chat opened here is listed from now on
      if (via && LIVE.on && !fd.get('toChat')) void loadSources(j.ws, ['chat'])
      const to = via ? `${PACKS[j.ws].src.chat?.n || 'chat'} · ${via}`
        : mail ? chName(j, k, addrs(mail.to).join(', ') + (addrs(mail.cc).length ? `; cc ${addrs(mail.cc).join(', ')}` : '')) : chName(j, k, lbl)
      const r = await doCmd(id, { op: 'sent', step: sid, i, t, to, ch: nm ? '' : to0 ?? '', ...(mail ? { rto: addrs(mail.to).join(', ') } : {}) }, null)
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
      <label className="field"><span>{b.k === 'p' ? 'Resolution' : 'Answer'}</span><VoiceField name="r" target="llm" rows={3} autoFocus defaultValue={b.r || ''} ctx={b.t} /></label>
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
