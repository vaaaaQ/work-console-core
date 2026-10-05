import * as React from 'react'
import { WORK0 } from '../data/demo.ts'
import { PACKS } from '../data/packs.ts'
import * as api from '../live/api.ts'
import { LIVE } from '../live/api.ts'
import { KINDS, badItem, ctxLabel, ctxOf, okItem, parseWorkId, workId } from '../model/context.ts'
import type { Resolved } from '../model/context.ts'
import { md } from '../lib/md.ts'
import { DESC_MAX } from '../model/transitions.ts'
import { CHATS, MAIL, ctxName as label, isClosed } from '../model/world.ts'
import type { CtxItem, CtxKind, Job, Mail } from '../model/types.ts'
import { doCmd, failText } from '../actions/flow.tsx'
import { CancelBtn } from '../ui/bits.tsx'
import { Ic } from '../ui/Icon.tsx'
import { closeModal, modal } from '../ui/modal.tsx'
import { VoiceField } from '../ui/VoiceField.tsx'
import { pageOf } from '../workspace.ts'

/* What the job's LLM runs are given: its description, the user's part of every prompt, and its context.
   A context row expands to the exact text a run would get: live through the backend's renderer, in the demo
   from demo data through the same one. */

export function DescPanel({ j }: { j: Job }) {
  return (
    <section className="panel"><header><Ic n="pen" /><h3>Description</h3><span className="src">your part of every LLM run</span></header>
      <div className="pb">
        {j.d ? <div className="md">{md(j.d)}</div> : <p className="why" style={{ margin: 0 }}>No description yet.</p>}
        {isClosed(j) ? null : <button className="btn ghost sm cx-add" onClick={() => editDesc(j)}><Ic n="pen" sm />Edit…</button>}
      </div>
    </section>
  )
}

export function editDesc(j0: Job) {
  const id = j0.id
  modal({
    title: `Description · ${j0.t}`, form: 'jdesc',
    body: <label className="field"><span>Markdown, in English: what the job is for. Every LLM run gets it after the generated part of its prompt.</span>
      <VoiceField name="d" target="people" rows={14} maxLength={DESC_MAX} defaultValue={j0.d ?? ''} autoFocus ctx={j0.t} /></label>,
    foot: <><CancelBtn /><button className="btn pri" type="submit"><Ic n="check" sm />Save</button></>,
    onSubmit: (fd) => {
      closeModal()
      void doCmd(id, { op: 'describe', d: String(fd.get('d') ?? '') }, 'Description saved')
    },
  })
}

const mailName = (m: Mail) => `${m.subj} — ${m.from}`
const notesOf = (j: Job) => LIVE.ws[j.ws]?.notes || []
/** the label an added item keeps: a chat's name, a mail's subject and sender, a note's title */
function nameOf(j: Job, k: CtxKind, id: string) {
  if (k === 'chat') return (CHATS[j.ws] || []).find((c) => c.id === id)?.name
  if (k === 'mail') { const m = (MAIL[j.ws] || []).find((x) => x.id === id); return m ? mailName(m) : undefined }
  if (k === 'note') return notesOf(j).find((n) => n.id === id)?.title
  return undefined
}

function demoItem(j: Job, it: CtxItem): Resolved {
  const me = pageOf(j.ws)?.me
  if (it.k === 'work') return WORK0[it.id] ? okItem(it, WORK0[it.id], me) : badItem(it, 'source_error', `no work item ${it.id} in the demo`)
  if (it.k === 'note') return badItem(it, 'source_error', 'the demo has no notes')
  if (it.k === 'mail') {
    const m = (MAIL[j.ws] || []).find((x) => x.id === it.id)
    return m ? okItem(it, { body: m.body, attachments: [] }, me) : badItem(it, 'source_error', `no mail ${it.id} in the demo`)
  }
  const c = (CHATS[j.ws] || []).find((x) => x.id === it.id)
  if (!c) return badItem(it, 'source_error', `no chat ${it.id} in the demo`)
  return okItem(it, { messages: c.msgs.map((m) => ({ author: m.who, authorKind: m.me ? 'me' : m.bot ? 'bot' : 'person', at: m.at, text: m.t })) }, me)
}

function Preview({ j, it }: { j: Job; it: CtxItem }) {
  const [st, set] = React.useState<{ r?: Resolved; err?: string }>({})
  React.useEffect(() => {
    let on = true
    set({})
    if (!LIVE.on) set({ r: demoItem(j, it) })
    else api.ctxPreview(j.id, it.k, it.id).then((r) => { if (on) set({ r }) }, (e: Error) => { if (on) set({ err: failText(e) }) })
    return () => { on = false }
  }, [j.id, it.k, it.id, it.n])
  if (st.err) return <p className="why cx-t">Could not read it: {st.err}</p>
  if (!st.r) return <p className="why cx-t">Reading…</p>
  return st.r.status === 'ok' ? <pre className="cx-t">{st.r.text}</pre> : <p className="why cx-t"><Ic n="warn" sm /> Unavailable: {st.r.text}</p>
}

function Count({ j, it }: { j: Job; it: CtxItem }) {
  const k = KINDS[it.k], id = j.id
  const save = (el: HTMLInputElement) => {
    const n = Number(el.value)
    if (n === it.n) return
    if (!Number.isInteger(n) || n < 1 || n > k.max) { el.value = String(it.n); return }
    void doCmd(id, { op: 'ctxSet', k: it.k, id: it.id, n }, `${k.l} ${label(j, it)}: last ${n} ${k.unit}`)
  }
  return <input key={it.n} className="inp cx-n" type="number" min={1} max={k.max} defaultValue={it.n} aria-label={`How many ${k.unit}`}
    onBlur={(e) => save(e.currentTarget)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(e.currentTarget) } }} />
}

export function CtxPanel({ j }: { j: Job }) {
  const [open, setOpen] = React.useState<string | null>(null), list = ctxOf(j), ro = isClosed(j)
  const pbNotes = notesOf(j).filter((n) => n.playbooks.includes(j.pb) && !list.some((c) => c.k === 'note' && c.id === n.id))
  return (
    <section className="panel"><header><Ic n="layers" /><h3>Context</h3><span className="src">in every LLM run</span></header>
      <div className="pb">
        {list.length ? <ul className="cx">{list.map((it) => {
          const k = KINDS[it.k], key = `${it.k}/${it.id}`, lb = label(j, it)
          return <li key={key}>
            <div className="cx-r">
              <button className="lnk" aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)} title="Show what a run gets">
                <Ic n="chevron" sm /><Ic n={k.ic} sm /><span className="cx-k">{k.l}</span><span className="cx-l">{lb}</span></button>
              <span className="why cx-u">{k.whole ?? <>last {ro ? it.n : <Count j={j} it={it} />} {k.unit}</>}</span>
              {ro ? null : <button className="iconbtn cx-x" aria-label={`Remove ${lb} from the context`} title="Remove"
                onClick={() => { void doCmd(j.id, { op: 'ctxDel', k: it.k, id: it.id }, `Removed ${lb} from the context`) }}><Ic n="x" sm /></button>}
            </div>
            {open === key ? <Preview j={j} it={it} /> : null}
          </li>
        })}</ul> : <p className="why" style={{ margin: 0 }}>No items: runs get the job, its earlier outputs and its journal.</p>}
        {pbNotes.length ? <p className="why" style={{ margin: 0 }}>Every run also gets the playbook's notes: {pbNotes.map((n) => n.title).join(', ')}.</p> : null}
        {ro ? null : <button className="btn ghost sm cx-add" onClick={() => addCtx(j)}><Ic n="plus" sm />Add</button>}
      </div>
    </section>
  )
}

function AddBody({ j }: { j: Job }) {
  const [k, setK] = React.useState<CtxKind>(workId(j.ws, j.key) ? 'chat' : 'work')
  const have = new Set(ctxOf(j).map((c) => `${c.k}/${c.id}`)), left = <T extends { id: string }>(kind: CtxKind, xs: T[]) => xs.filter((x) => !have.has(`${kind}/${x.id}`))
  const K = KINDS[k]
  const pick = (what: string, opts: [string, string][], none: string) => <label className="field"><span>{what}</span>{opts.length
    ? <select className="sel" name="id" data-autofocus>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
    : <span className="why">{none}</span>}</label>
  return <>
    <div className="field"><span>Kind</span><div className="seg cx-kind" role="group" aria-label="Kind">{(Object.keys(KINDS) as CtxKind[]).map((x) => (
      <button key={x} type="button" aria-pressed={k === x} onClick={() => setK(x)}><Ic n={KINDS[x].ic} sm />{KINDS[x].l}</button>))}</div>
      <input type="hidden" name="k" value={k} /></div>
    {k === 'work'
      ? <label className="field"><span>Work item</span><input className="inp" name="id" placeholder={PACKS[j.ws]?.keyPh} data-autofocus /></label>
      : k === 'chat' ? pick('Chat', left('chat', CHATS[j.ws] || []).map((c) => [c.id, c.name]), 'Every loaded chat is already in the context.')
        : k === 'mail' ? pick('Mail', left('mail', MAIL[j.ws] || []).map((m) => [m.id, mailName(m)]), 'Every loaded mail is already in the context.')
          : pick('Note', left('note', notesOf(j)).map((n) => [n.id, n.title]), 'No note left to add. Notes are written in Knowledge.')}
    {K.whole ? <p className="why" style={{ margin: 0 }}>Runs get {K.whole}.</p> : <label className="field"><span>Newest {K.unit}, up to {K.max}</span>
      <input key={k} className="inp" type="number" name="n" min={1} max={K.max} defaultValue={K.def} /></label>}
  </>
}

export function addCtx(j0: Job) {
  const id = j0.id
  modal({
    title: 'Add to context', form: 'ctxadd',
    body: <AddBody j={j0} />,
    foot: <><CancelBtn /><button className="btn pri" type="submit"><Ic n="plus" sm />Add</button></>,
    onSubmit: (fd, f) => {
      const k = String(fd.get('k')) as CtxKind, raw = String(fd.get('id') || '').trim(), K = KINDS[k]
      const item = k === 'work' ? parseWorkId(j0.ws, raw) : raw
      if (!item) { const i = f.querySelector<HTMLInputElement>('[name=id]'); if (i) { i.focus(); i.setAttribute('aria-invalid', 'true') } return }
      const name = k === 'work' ? (workId(j0.ws, raw) ? raw : undefined) : nameOf(j0, k, item)
      closeModal()
      const lb = name || ctxLabel(j0.ws, { k, id: item })
      void doCmd(id, { op: 'ctxAdd', k, id: item, ...(K.whole ? {} : { n: Number(fd.get('n')) }), ...(name ? { name } : {}) }, `Added ${K.l.toLowerCase()} ${lb} to the context`)
    },
  })
}

