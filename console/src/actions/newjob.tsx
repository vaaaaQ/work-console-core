import * as React from 'react'
import { PACKS } from '../data/packs.ts'
import { plural, store } from '../lib/util.ts'
import { zoneName } from '../lib/zone.ts'
import * as api from '../live/api.ts'
import { LIVE } from '../live/api.ts'
import { buildFeed } from '../live/boot.ts'
import { KINDS, ctxLabel } from '../model/context.ts'
import { buildForm, ctxAdd, ctxDel, ctxSet, dueWall, mergeBuild, njJob, njOnce, njPlaybook, njStart, njSteps, shownCtx, stepsOn, wallDue } from '../model/njForm.ts'
import type { Nj } from '../model/njForm.ts'
import { freeKey } from '../model/pbFormat.ts'
import type { PbFile } from '../model/pbFormat.ts'
import * as T from '../model/transitions.ts'
import { CHATS, CTX, MAIL, PB, S, TPL, createJob, pbs, putJob, steps } from '../model/world.ts'
import type { CtxItem, CtxKind, Job, Mail, NjDraft } from '../model/types.ts'
import { commit, useWorld } from '../store.ts'
import { Ic } from '../ui/Icon.tsx'
import { CancelBtn, ExportBtn, FlowLegend, FlowMap } from '../ui/bits.tsx'
import { closeModal, modal, modalForm } from '../ui/modal.tsx'
import { toast } from '../ui/toasts.tsx'
import { canRecord, micError, record } from '../ui/voice.ts'
import type { Recording } from '../ui/voice.ts'
import { go, setHash } from './nav.tsx'
import { pbAdd } from './playbooks.tsx'

/* New job: a form the user fills, or says. A say, spoken or typed, goes to the builder with every earlier say
   and the form as it is; its answer folds into the form where the user left it alone. Nothing is made until
   Create job, which saves the builder's steps first when they are the job's playbook. */

type Busy = { k: 'rec' | 'stt' | 'build'; at: number; lines: string[] }
/** busy = what runs; err = why the last say failed; box = the say being typed; tried = Create job was pressed
    without a title; audio = a recording that was not turned into text, for another try */
type Bar = { busy: Busy | null; err: string; box: string; tried: boolean; audio: { audio: string; mime: string } | null }
const BAR0: Bar = { busy: null, err: '', box: '', tried: false, audio: null }
/** a recording stops on its own after this long, well inside what one transcription takes */
const REC_MAX = 10 * 60_000

let F: Nj | null = null
let B: Bar = BAR0
let rec: Recording | null = null, recCap: ReturnType<typeof setTimeout> | undefined
let ac: AbortController | null = null
let creating = false
/** the key Create job saved the steps under, so a second try overwrites them instead of picking a new key */
let saved: string | null = null

let ver = 0
const subs = new Set<() => void>()
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }
const getVer = () => ver
const ping = () => { ver++; subs.forEach((f) => f()) }
const useNj = () => React.useSyncExternalStore(subscribe, getVer)
const put = (f: Nj) => { F = f; ping() }
const setB = (p: Partial<Bar>) => { B = { ...B, ...p }; ping() }
/** what runs now, read afresh after an await */
const busyK = () => B.busy?.k

function stopAll() {
  clearTimeout(recCap)
  rec?.cancel(); rec = null
  ac?.abort(); ac = null
  B = { ...B, busy: null }
}

/** pre fills the form: from a chat message, a mail or a meeting */
export function newJob(pre: NjDraft = {}) {
  stopAll()
  const ws = S.ws, chatName = pre.chat ? (CHATS[ws] || []).find((c) => c.id === pre.chat)?.name : undefined
  F = njStart(ws, { ...pre, ...(chatName ? { chatName } : {}) }, pbs(ws), PACKS[ws].prj, PB)
  B = BAR0; saved = null
  open()
}
/** back to the form a dialog opened over it: with the playbook it added picked, or with the steps as edited */
export function reopenNewJob(o: { pb?: string; steps?: PbFile } = {}) {
  if (!F) { newJob(); return }
  if (o.pb && PB[o.pb]) F = { ...F, pb: o.pb }
  if (o.steps) F = njSteps(F, o.steps, PB)
  open()
}
/** a dialog opens over New job: its Cancel comes back here, and a build in flight keeps running */
export function stashNewJob() {
  if (modalForm() !== 'newjob' || !F) return false
  S.pbRet = 'newjob'
  return true
}

function open() {
  modal({
    title: 'New job', cls: 'wide', form: 'newjob',
    body: <NewJobBody />,
    foot: <><CancelBtn /><button className="btn pri" type="submit"><Ic n="plus" sm />Create job</button></>,
    onSubmit: () => { void create() },
  })
}

/* ===== saying it ===== */
async function startRec() {
  if (B.busy || !F) return
  setB({ busy: { k: 'rec', at: 0, lines: [] }, err: '', audio: null })
  let r: Recording
  try { r = await record() } catch (e) { if (busyK() === 'rec') setB({ busy: null, err: micError(e) }); return }
  // closed, or stopped, while the browser asked for the mic
  if (busyK() !== 'rec' || rec) { r.cancel(); return }
  rec = r
  recCap = setTimeout(() => { void stopRec() }, REC_MAX)
  setB({ busy: { k: 'rec', at: Date.now(), lines: [] } })
}

async function stopRec() {
  const r = rec
  clearTimeout(recCap)
  if (!r) { if (B.busy?.k === 'rec') setB({ busy: null }); return }
  rec = null
  let got: { audio: string; mime: string }
  try { got = await r.stop() } catch (e) { setB({ busy: null, err: `The recording failed: ${(e as Error).message}` }); return }
  if (!got.audio) { setB({ busy: null, err: 'Nothing was recorded.' }); return }
  await hear(got)
}

/** the recording as words, then a say */
async function hear(a: { audio: string; mime: string }) {
  if (!F) return
  const ws = F.ws, ctl = new AbortController()
  ac = ctl
  setB({ busy: { k: 'stt', at: Date.now(), lines: [] }, err: '', audio: null })
  let text: string
  try { text = (await api.transcribe(ws, a.audio, a.mime, ctl.signal)).trim() } catch (e) {
    if (ac === ctl) { ac = null; const x = e as api.ApiError; setB({ busy: null, ...(x.status === 499 ? {} : { err: `The recording was not turned into text: ${x.message}`, audio: a }) }) }
    return
  }
  if (ac !== ctl) return
  ac = null
  if (!text) { setB({ busy: null, err: 'Nothing was heard. Try again, closer to the mic.' }); return }
  await say(text)
}

/** one say to the builder, with every say before it and the form as it is now */
async function say(text: string) {
  const f0 = F
  if (!f0) return
  const ws = f0.ws, says = [...f0.say, text], sent = buildForm(f0), id = crypto.randomUUID(), ctl = new AbortController(), lines: string[] = []
  ac = ctl
  buildFeed.set(id, (t) => { lines.push(t); if (ac === ctl && B.busy?.k === 'build') setB({ busy: { ...B.busy, lines: lines.slice(-3) } }) })
  setB({ busy: { k: 'build', at: Date.now(), lines: [] }, err: '' })
  try {
    const got = await api.build(ws, id, says, sent, ctl.signal)
    if (ac === ctl && F) put(mergeBuild(F, sent, got, { say: says, pbs: pbs(ws), prjs: PACKS[ws].prj }))
  } catch (e) {
    // what was said goes back to the box, so a failed say is not lost
    if (ac === ctl) { const x = e as api.ApiError; setB({ err: x.status === 499 ? '' : `The form was not filled: ${x.message}`, box: B.box.trim() ? `${text} ${B.box}` : text }) }
  } finally {
    buildFeed.delete(id)
    if (ac === ctl) { ac = null; setB({ busy: null }) }
  }
}

function send() {
  const t = B.box.trim()
  if (!t || B.busy) return
  setB({ box: '' })
  void say(t)
}

/* ===== creating it ===== */
async function create() {
  if (!F || creating) return
  if (!F.t.trim()) { setB({ tried: true }); document.querySelector<HTMLInputElement>('#scrim [name=t]')?.focus(); return }
  creating = true
  try {
    let f = F
    if (stepsOn(f)) {
      const s = f.npb!
      // another playbook took the key since the steps got it
      if (Object.hasOwn(PB, s.key) && s.key !== saved) { const key = freeKey(s.file.name || s.key, s.once, PB, null); f = { ...f, npb: { ...s, key }, pb: key }; put(f) }
      const p = njPlaybook(f)
      if (!p.pb) { toast(`The steps are not ready: ${p.errs[0]}`); return }
      if (LIVE.on) {
        try { await api.putPlaybook(f.ws, p.key, p.pb, p.tpl) } catch (e) { toast(`The steps were not saved: ${(e as Error).message}`); return }
      }
      saved = p.key
      commit(() => { PB[p.key] = p.pb!; Object.assign(TPL, p.tpl) })
      if (!LIVE.on && !p.pb.once) { const x = store.get<Record<string, PbFile>>('pbx', {}); x[p.key] = p.file; store.set('pbx', x) }
    } else if (!PB[f.pb]) { toast('Pick a playbook.'); return }

    const o = njJob(f)
    let made: Job | null = null
    try {
      if (LIVE.on) {
        made = (await api.create(o)).job
        if (o.mail) { const m = (MAIL[o.ws] || []).find((x) => x.id === o.mail); if (m) { m.job = made.id; m.done = true } }
      } else T.freshJob(CTX, 'check', o) // what createJob would refuse, before the world changes
    } catch (e) { toast(`Not created: ${(e as Error).message}`); return }
    F = null; saved = null
    closeModal()
    // from a meeting the calendar stays, so its new chip shows
    const j = commit(() => { const j = made ?? createJob(o); if (made) putJob(made); if (!o.ev) { S.view = 'jobs'; S.f = 'all' } S.flash = j.id; return j })
    setHash()
    toast(<>Created <b>{j.id}</b> · {o.t}</>, 'Open', () => go('job', j.id))
  } finally { creating = false }
}

/* ===== the form ===== */
function Since({ at }: { at: number }) {
  const [, tick] = React.useState(0)
  React.useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t) }, [])
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000))
  return <span className="num">{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</span>
}

function Status({ f }: { f: Nj }) {
  const b = B.busy, mic = LIVE.voice && canRecord()
  if (b?.k === 'rec') return <>{b.at ? 'Listening. Press the button again when you are done.' : 'Waiting for the mic…'}</>
  if (b?.k === 'stt') return <><span className="spin" />Turning speech into text…</>
  if (b?.k === 'build') return <><span className="spin" />Filling the form{b.lines.length ? `: ${b.lines.at(-1)}` : '…'}</>
  if (B.err) return <span className="nj-err">{B.err}{B.audio ? <> <button type="button" className="lnk" onClick={() => { const a = B.audio; if (a) void hear(a) }}>Try again</button></> : null}</span>
  if (f.say.length) return <>Check the form. Say or type what to change.</>
  return <>{mic ? 'Press the mic and say what the job is, or type it.' : 'Type what the job is.'} The form fills itself; you check it and create the job.</>
}

function VoiceBar({ f }: { f: Nj }) {
  const b = B.busy, mic = LIVE.voice && canRecord()
  return <div className="nj-v">
    <div className="nj-say">
      {mic ? (b?.k === 'rec'
        ? <button type="button" className="btn nj-mic on" onClick={() => { void stopRec() }} aria-label="Stop and use the recording"><Ic n="stop" sm />{b.at ? <Since at={b.at} /> : null}</button>
        : <button type="button" className="btn nj-mic" onClick={() => { void startRec() }} disabled={!!b} aria-label="Speak" title="Say what the job is"><Ic n="mic" sm /></button>) : null}
      <input className="inp" value={B.box} onChange={(e) => setB({ box: e.currentTarget.value })} disabled={b?.k === 'rec'}
        placeholder={f.say.length ? 'What to change' : 'What the job is'} aria-label={f.say.length ? 'What to change in the form' : 'What the job is'}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); send() } }} />
      {b && b.k !== 'rec'
        ? <button type="button" className="btn" onClick={() => ac?.abort()}><Ic n="stop" sm />Stop</button>
        : <button type="button" className="btn" onClick={send} disabled={!B.box.trim() || !!b}><Ic n="send" sm />Fill</button>}
    </div>
    <p className="nj-st" aria-live="polite"><Status f={f} /></p>
    {f.why.length ? <ul className="nj-why">{f.why.map((x, i) => <li key={i}>{x}</li>)}</ul> : null}
    {f.say.length ? <details className="why"><summary>What you said ({f.say.length})</summary><ol className="nj-said">{f.say.map((x, i) => <li key={i}>{x}</li>)}</ol></details> : null}
  </div>
}

function NjPrev({ pb }: { pb: string }) {
  const p = PB[pb], st = steps(pb), you = st.filter((s) => s.m === 'you').length
  const msg = st.reduce((a, s) => a + (s.msg || 0), 0), rv = st.some((s) => s.rv)
  return <>
    <div className="row"><div className="eyebrow">Flow · {p.n}{p.ws ? '' : ' · core'}{p.custom ? ' · added' : ''}</div><span className="fsp" /><ExportBtn k={pb} /></div>
    <div className="why">{plural(p.ph.length, 'phase')} · {plural(st.length, 'step')} · {you} by you · {st.length - you} as LLM drafts{msg ? ` · ${plural(msg, 'message')}` : ''}{rv ? ' · code review' : ''}</div>
    <FlowMap p={p} /><FlowLegend />
  </>
}

function StepsPrev({ f }: { f: Nj }) {
  const s = f.npb!, p = njPlaybook(f), n = s.file.phases.reduce((a, ph) => a + ph.steps.length, 0), e = p.errs
  return <>
    <div className="row"><div className="eyebrow">New steps · {s.file.name || 'untitled'} · {plural(s.file.phases.length, 'phase')} · {plural(n, 'step')}</div><span className="fsp" />
      <button type="button" className="btn sm ghost" onClick={() => pbAdd(true, s.file)}><Ic n="pen" sm />Edit JSON…</button></div>
    <div className="seg nj-keep" role="group" aria-label="Keep the steps">
      <button type="button" aria-pressed={!s.once} onClick={() => put(njOnce(F!, false, PB))}>New playbook, will be saved</button>
      <button type="button" aria-pressed={s.once} onClick={() => put(njOnce(F!, true, PB))}>Steps only for this job</button></div>
    {e.length ? <ul className="errs">{e.slice(0, 8).map((x, i) => <li key={i}>{x}</li>)}{e.length > 8 ? <li>…and {e.length - 8} more</li> : null}</ul> : null}
    {p.pb ? <><FlowMap p={p.pb} T={p.tpl} /><FlowLegend /></> : null}
    <p className="hint" style={{ margin: 0 }}>{s.once ? 'Create job keeps them with this job only.' : <>Create job saves them as playbook <span className="mono">{s.key}</span> in {PACKS[f.ws].n}.</>}</p>
  </>
}

const mailName = (m: Mail) => `${m.subj} — ${m.from}`
const nameOf = (f: Nj, it: CtxItem) => it.name || (it.k === 'chat' && (CHATS[f.ws] || []).find((c) => c.id === it.id)?.name) || ctxLabel(f.ws, it)

function Count({ it }: { it: CtxItem }) {
  const k = KINDS[it.k]
  const save = (el: HTMLInputElement) => {
    const n = Number(el.value)
    if (n === it.n || !F) return
    const g = ctxSet(F, it.k, it.id, n)
    if (g === F) el.value = String(it.n); else put(g)
  }
  return <input key={it.n} className="inp cx-n" type="number" min={1} max={k.max} defaultValue={it.n} aria-label={`How many ${k.unit}`}
    onBlur={(e) => save(e.currentTarget)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(e.currentTarget) } }} />
}

function CtxAdd({ f }: { f: Nj }) {
  const [open, setOpen] = React.useState(false), [k, setK] = React.useState<CtxKind>('work')
  const [v, setV] = React.useState(''), [n, setN] = React.useState(String(KINDS.work.def)), [err, setErr] = React.useState('')
  if (!open) return <button type="button" className="btn ghost sm cx-add" onClick={() => setOpen(true)}><Ic n="plus" sm />Add</button>
  const K = KINDS[k], have = new Set(shownCtx(f).map((c) => `${c.k}/${c.id}`))
  const opts: [string, string][] = k === 'chat' ? (CHATS[f.ws] || []).map((c) => [c.id, c.name])
    : k === 'mail' ? (MAIL[f.ws] || []).map((m) => [m.id, mailName(m)])
      : k === 'note' ? (LIVE.ws[f.ws]?.notes || []).map((x) => [x.id, x.title]) : []
  const left = opts.filter(([id]) => !have.has(`${k}/${id}`)), pick = left.some(([id]) => id === v) ? v : left[0]?.[0] ?? ''
  const add = () => {
    if (!F) return
    const id = k === 'work' ? v : pick
    const g = ctxAdd(F, k, id, K.whole ? undefined : Number(n), k === 'work' ? undefined : opts.find(([x]) => x === id)?.[1])
    if (typeof g === 'string') { setErr(g); return }
    put(g); setV(''); setErr('')
  }
  const enter = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); add() } }
  const kind = (x: CtxKind) => { setK(x); setV(''); setN(String(KINDS[x].def)); setErr('') }
  const none = k === 'note' ? 'No note left to add. Notes are written in Knowledge.' : `No ${K.l.toLowerCase()} left to add.`
  return <div className="nj-add">
    <div className="row">
      <select className="sel" value={k} onChange={(e) => kind(e.currentTarget.value as CtxKind)} aria-label="Kind">
        {(Object.keys(KINDS) as CtxKind[]).map((x) => <option key={x} value={x}>{KINDS[x].l}</option>)}</select>
      {k === 'work'
        ? <input className="inp nj-grow" value={v} onChange={(e) => setV(e.currentTarget.value)} onKeyDown={enter} placeholder={PACKS[f.ws].keyPh} aria-label="Work item" aria-invalid={err ? true : undefined} />
        : left.length
          ? <select className="sel nj-grow" value={pick} onChange={(e) => setV(e.currentTarget.value)} aria-label={K.l}>{left.map(([id, l]) => <option key={id} value={id}>{l}</option>)}</select>
          : <span className="why nj-grow">{none}</span>}
      {K.whole ? null : <label className="why nj-n">last <input className="inp cx-n" type="number" min={1} max={K.max} value={n} onChange={(e) => setN(e.currentTarget.value)} onKeyDown={enter} aria-label={`How many ${K.unit}`} /> {K.unit}</label>}
      <button type="button" className="btn sm" onClick={add} disabled={k !== 'work' && !left.length}><Ic n="plus" sm />Add</button>
      <button type="button" className="iconbtn cx-x" aria-label="Close adding" title="Close" onClick={() => { setOpen(false); setErr('') }}><Ic n="x" sm /></button>
    </div>
    {err ? <p className="nj-err" role="alert">{err}</p> : null}
  </div>
}

function CtxList({ f }: { f: Nj }) {
  const list = shownCtx(f)
  return <div className="field nj-ctx">
    <span className="lbl">Context · every LLM run of the job gets it</span>
    {list.length ? <ul className="cx">{list.map((it) => {
      const k = KINDS[it.k], lb = nameOf(f, it)
      return <li key={`${it.k}/${it.id}`}><div className="cx-r">
        <span className="nj-cx"><Ic n={k.ic} sm /><span className="cx-k">{k.l}</span><span className="cx-l">{lb}</span></span>
        <span className="nj-cu"><span className="why cx-u">{k.whole ?? <>last <Count it={it} /> {k.unit}</>}</span>
          <button type="button" className="iconbtn cx-x" aria-label={`Remove ${lb} from the context`} title="Remove" onClick={() => { if (F) put(ctxDel(F, it.k, it.id)) }}><Ic n="x" sm /></button></span>
      </div></li>
    })}</ul> : <p className="why" style={{ margin: 0 }}>No items: runs get the job, its earlier outputs and its journal.</p>}
    <CtxAdd f={f} />
  </div>
}

function NewJobBody() {
  useWorld(); useNj()
  // closed, not covered by a dialog that comes back: nothing keeps running
  React.useEffect(() => () => { if (S.pbRet !== 'newjob') stopAll() }, [])
  const f = F
  if (!f) return null
  const w = PACKS[f.ws], on = stepsOn(f), list = pbs(f.ws).filter((k) => k !== f.npb?.key)
  const set = (p: Partial<Nj>) => { if (F) put({ ...F, ...p }) }
  return <>
    {LIVE.on ? <VoiceBar f={f} /> : null}
    <label className="field"><span>Title</span><input className="inp" name="t" value={f.t} onChange={(e) => set({ t: e.currentTarget.value })}
      placeholder="What needs doing" aria-invalid={B.tried && !f.t.trim() ? true : undefined} data-autofocus /></label>
    <div className="f2"><label className="field"><span>Key</span><input className="inp" value={f.key} onChange={(e) => set({ key: e.currentTarget.value })} placeholder={w.keyPh} /></label>
      <label className="field"><span>Project</span><select className="sel" value={f.prj} onChange={(e) => set({ prj: e.currentTarget.value })}>{w.prj.map((p) => <option key={p}>{p}</option>)}</select></label></div>
    <div className="field">
      <div className="row"><span className="lbl">Playbook</span><span className="fsp" /><button type="button" className="btn sm ghost" onClick={() => pbAdd(true)}><Ic n="upload" sm />Add playbook…</button></div>
      <div className="pbc" role="radiogroup" aria-label="Playbook">
        {f.npb ? <label><input type="radio" name="pb" checked={on} onChange={() => { if (F?.npb) set({ pb: F.npb.key }) }} />
          <b>{f.npb.file.name || 'New steps'}</b><small>{f.npb.once ? 'Steps only for this job' : 'New playbook, will be saved'}</small></label> : null}
        {list.map((k) => <label key={k}><input type="radio" name="pb" value={k} checked={f.pb === k} onChange={() => set({ pb: k })} />
          <b>{PB[k].n}</b><small>{PB[k].d}{PB[k].ws ? '' : ' · core'}</small></label>)}</div>
    </div>
    <div className="prev">{on ? <StepsPrev f={f} /> : PB[f.pb] ? <NjPrev pb={f.pb} /> : <p className="why" style={{ margin: 0 }}>Pick a playbook.</p>}</div>
    <label className="field"><span>Description · Markdown, in English: your part of every LLM run</span>
      <textarea className="ta" rows={5} maxLength={T.DESC_MAX} value={f.d} onChange={(e) => set({ d: e.currentTarget.value })} placeholder="What the job is for, and what done looks like" /></label>
    <CtxList f={f} />
    <label className="field nj-due"><span>Due · {zoneName()} time</span>
      <input className="inp" type="datetime-local" value={dueWall(f.due)} onChange={(e) => set({ due: wallDue(e.currentTarget.value) })} /></label>
    {f.src ? <p className="why" style={{ margin: 0 }}><Ic n="external" sm /> From {f.src}</p> : null}
  </>
}
