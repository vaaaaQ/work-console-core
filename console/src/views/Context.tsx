import * as React from 'react'
import { WORK0 } from '../data/demo.ts'
import { PACKS } from '../data/packs.ts'
import * as api from '../live/api.ts'
import { LIVE } from '../live/api.ts'
import { CTX_MAX, KINDS, badItem, ctxLabel, ctxOf, okItem, parseWorkId, workId } from '../model/context.ts'
import type { Resolved } from '../model/context.ts'
import { CHATS, ctxName as label, isClosed } from '../model/world.ts'
import type { CtxItem, CtxKind, Job } from '../model/types.ts'
import { doCmd, failText } from '../actions/flow.tsx'
import { CancelBtn } from '../ui/bits.tsx'
import { Ic } from '../ui/Icon.tsx'
import { closeModal, modal } from '../ui/modal.tsx'
import { pageOf } from '../workspace.ts'

/* What the job's LLM runs are given. A row expands to the exact text a run would get: live through the
   backend's renderer, in the demo from demo data through the same one. */

const chatName = (j: Job, id: string) => (CHATS[j.ws] || []).find((c) => c.id === id)?.name

function demoItem(j: Job, it: CtxItem): Resolved {
  const me = pageOf(j.ws)?.me
  if (it.k === 'work') return WORK0[it.id] ? okItem(it, WORK0[it.id], me) : badItem(it, 'source_error', `no work item ${it.id} in the demo`)
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
  return (
    <section className="panel"><header><Ic n="layers" /><h3>Context</h3><span className="src">in every LLM run</span></header>
      <div className="pb">
        {list.length ? <ul className="cx">{list.map((it) => {
          const k = KINDS[it.k], key = `${it.k}/${it.id}`, lb = label(j, it)
          return <li key={key}>
            <div className="cx-r">
              <button className="lnk" aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)} title="Show what a run gets">
                <Ic n="chevron" sm /><Ic n={k.ic} sm /><span className="cx-k">{k.l}</span><span className="cx-l">{lb}</span></button>
              <span className="why cx-u">last {ro ? it.n : <Count j={j} it={it} />} {k.unit}</span>
              {ro ? null : <button className="iconbtn cx-x" aria-label={`Remove ${lb} from the context`} title="Remove"
                onClick={() => { void doCmd(j.id, { op: 'ctxDel', k: it.k, id: it.id }, `Removed ${lb} from the context`) }}><Ic n="x" sm /></button>}
            </div>
            {open === key ? <Preview j={j} it={it} /> : null}
          </li>
        })}</ul> : <p className="why" style={{ margin: 0 }}>Runs get the job's frame and journal only.</p>}
        {ro ? null : <button className="btn ghost sm cx-add" disabled={list.length >= CTX_MAX} onClick={() => addCtx(j)}><Ic n="plus" sm />Add</button>}
      </div>
    </section>
  )
}

function AddBody({ j }: { j: Job }) {
  const [k, setK] = React.useState<CtxKind>(workId(j.ws, j.key) ? 'chat' : 'work')
  const have = new Set(ctxOf(j).map((c) => `${c.k}/${c.id}`)), chats = (CHATS[j.ws] || []).filter((c) => !have.has(`chat/${c.id}`))
  return <>
    <div className="field"><span>Kind</span><div className="seg cx-kind" role="group" aria-label="Kind">{(Object.keys(KINDS) as CtxKind[]).map((x) => (
      <button key={x} type="button" aria-pressed={k === x} onClick={() => setK(x)}><Ic n={KINDS[x].ic} sm />{KINDS[x].l}</button>))}</div>
      <input type="hidden" name="k" value={k} /></div>
    {k === 'work'
      ? <label className="field"><span>Work item</span><input className="inp" name="id" placeholder={PACKS[j.ws]?.keyPh} data-autofocus /></label>
      : <label className="field"><span>Chat</span>{chats.length
        ? <select className="sel" name="id" data-autofocus>{chats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        : <span className="why">Every loaded chat is already in the context.</span>}</label>}
    <label className="field"><span>Newest {KINDS[k].unit}, up to {KINDS[k].max}</span>
      <input key={k} className="inp" type="number" name="n" min={1} max={KINDS[k].max} defaultValue={KINDS[k].def} /></label>
  </>
}

export function addCtx(j0: Job) {
  const id = j0.id
  modal({
    title: 'Add to context', form: 'ctxadd',
    body: <AddBody j={j0} />,
    foot: <><CancelBtn /><button className="btn pri" type="submit"><Ic n="plus" sm />Add</button></>,
    onSubmit: (fd, f) => {
      const k = String(fd.get('k')) as CtxKind, raw = String(fd.get('id') || '').trim(), n = Number(fd.get('n'))
      const item = k === 'work' ? parseWorkId(j0.ws, raw) : raw
      if (!item) { const i = f.querySelector<HTMLInputElement>('[name=id]'); if (i) { i.focus(); i.setAttribute('aria-invalid', 'true') } return }
      const name = k === 'work' ? (workId(j0.ws, raw) ? raw : undefined) : chatName(j0, item)
      closeModal()
      const lb = name || ctxLabel(j0.ws, { k, id: item })
      void doCmd(id, { op: 'ctxAdd', k, id: item, n, ...(name ? { name } : {}) }, `Added ${KINDS[k].l.toLowerCase()} ${lb} to the context`)
    },
  })
}

