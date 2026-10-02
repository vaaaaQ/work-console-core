import * as React from 'react'
import { CDR } from '../data/demo.ts'
import { MDR } from '../data/ui.ts'
import { first, hm, snip } from '../lib/util.ts'
import { LIVE } from '../live/api.ts'
import * as api from '../live/api.ts'
import { refreshThread } from '../live/boot.ts'
import { CHATS, MAIL, S, W, byId } from '../model/world.ts'
import { doCmd, sendVia } from './flow.tsx'
import type { Chat, MailCat, Ws } from '../model/types.ts'
import { commit } from '../store.ts'
import { Ic } from '../ui/Icon.tsx'
import { CancelBtn } from '../ui/bits.tsx'
import { closeModal, modal } from '../ui/modal.tsx'
import { toast } from '../ui/toasts.tsx'
import { newJob } from './playbooks.tsx'

export const curChat = () => { const L = CHATS[S.ws] || []; return L.find((x) => x.id === S.chat[S.ws]) || L[0] }
export const mailOf = (id: string) => (MAIL[S.ws] || []).find((x) => x.id === id)

/** the LLM summary runs only when asked */
export function summarize(id: string) {
  commit(() => { S.sum[id] = 'run' })
  setTimeout(() => { S.sum[id] = 'ok'; if (S.view === 'chats' || S.view === 'mail') commit() }, 900)
}

/* ----- chats ----- */
export function pickChat(id: string) { commit(() => { S.chat[S.ws] = id }) }

/* hidden threads: the console's own mark (B when live, memory in the demo), never the chat tool's */
export const HID = { open: false, list: [] as { id: string; name: string }[], demo: [] as { c: Chat; i: number }[] }

/** the list is the current workspace's; one that lands after a switch is dropped */
export function loadHidden(ws: Ws = S.ws) {
  if (LIVE.on) void api.hiddenChats(ws).then((l) => { if (S.ws === ws) commit(() => { HID.list = l }) }).catch(() => undefined)
}
export function toggleHidden() { commit(() => { HID.open = !HID.open }); if (HID.open) loadHidden() }

export function hideChat(id: string) {
  const ws = S.ws, L = CHATS[ws] || [], i = L.findIndex((x) => x.id === id), c = L[i]
  if (!c) return
  commit(() => {
    CHATS[ws] = L.filter((x) => x !== c)
    HID.list = [...HID.list.filter((h) => h.id !== id), { id, name: c.name }]
    if (!LIVE.on) HID.demo.push({ c, i })
  })
  if (LIVE.on) void api.hideChat(ws, id, true, c.name).catch((e) => {
    commit(() => { const now = CHATS[ws] || []; if (!now.some((x) => x.id === id)) now.splice(Math.min(i, now.length), 0, c); HID.list = HID.list.filter((h) => h.id !== id) })
    toast(`Not hidden: ${(e as Error).message}`)
  })
  toast(<>Hid <b>{c.name}</b> · it comes back when someone mentions you</>, 'Undo', () => unhideChat(id, ws))
}

export function unhideChat(id: string, ws: Ws = S.ws) {
  const h = HID.list.find((x) => x.id === id), back = HID.demo.find((x) => x.c.id === id)
  commit(() => {
    HID.list = HID.list.filter((x) => x.id !== id)
    const L = CHATS[ws] || [], on = L.find((x) => x.id === id)
    if (on) { delete on.hidden; delete on.mentioned }
    if (back) { HID.demo = HID.demo.filter((x) => x !== back); if (!on) L.splice(Math.min(back.i, L.length), 0, back.c) }
  })
  // live: the thread comes back with the next chat reload, once B has rejoined it
  if (LIVE.on) void api.hideChat(ws, id, false).catch((e) => { commit(() => { if (h && !HID.list.some((x) => x.id === id)) HID.list.push(h) }); toast(`Not unhidden: ${(e as Error).message}`) })
}

export function msgJob(i: number) {
  const c = curChat(), m = c.msgs[i], w = W(), src = `${w.src.chat!.n} · ${c.name}`
  newJob({ t: `Reply to ${first(m.who)}: ${snip(m.t, 60)}`, key: w.src.chat!.n.toUpperCase(), pb: 'action', src, chat: c.id })
}

export function msgDraft(i: number) {
  const c = curChat(), n = first(c.msgs[i].who)
  const body = LIVE.on ? '' : CDR[c.id + '/' + n] || 'thanks, I will check and come back to you today.'
  commit(() => { S.cd[c.id] = `hi ${n},\n${body}` }, () => {
    const t = document.getElementById('cmp') as HTMLTextAreaElement | null
    if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length) }
  })
  toast(LIVE.on ? 'Reply started in the box.' : 'The LLM draft is in the reply box. Read it before sending.')
}

/** the reply is shown once more before it goes out */
export function chatSubmit(fd: FormData) {
  const c = curChat(), t = String(fd.get('t') || '').trim()
  if (!t) { const i = document.getElementById('cmp'); if (i) { i.setAttribute('aria-invalid', 'true'); i.focus() } return }
  S.cd[c.id] = t
  modal({
    title: `Send to ${c.name}`,
    body: <>
      <div className="src"><Ic n="message" sm /> {W().src.chat!.n} · {c.name}</div>
      <div className="draft">{t}</div>
      <p className="hint" style={{ margin: 0 }}>{LIVE.on ? 'Sends through the bridge.' : 'Demo: sending only records it here.'}</p>
    </>,
    foot: <>
      <button type="button" className="btn ghost" onClick={chatEdit}><Ic n="pen" sm />Edit</button>
      <button type="button" className="btn pri" data-autofocus onClick={chatOk}><Ic n="send" sm />Send</button>
    </>,
  })
}
function chatEdit() { closeModal(); document.getElementById('cmp')?.focus() }
async function chatOk() {
  const c = curChat(), t = (S.cd[c.id] || '').trim()
  if (!t) return
  if (!(await sendVia('chat', c.name, t))) return
  closeModal()
  commit(() => { c.msgs.push({ who: 'You', me: 1, at: hm(), t }); S.cd[c.id] = '' })
  if (LIVE.on) { refreshThread(c.id); toast(<>Posted in <b>{c.name}</b></>) }
  else toast(<>Posted in <b>{c.name}</b> · demo, nothing left this page</>)
}

/* ----- mail ----- */
export function pickMcat(k: MailCat) { commit(() => { S.mcat = k; S.mail = null }) }
export function pickMail(id: string) { commit(() => { S.mail = id }) }

export function mailJob(id: string) {
  const m = mailOf(id)
  if (m) newJob({ t: m.subj, key: 'MAIL', pb: 'action', src: `${W().src.mail!.n} · ${m.from}`, mail: m.id })
}

export function mailDone(id: string) {
  const m = mailOf(id)
  if (!m) return
  const ws = S.ws, mark = (done: boolean) => {
    commit(() => { m.done = done })
    if (LIVE.on) void api.markMail(ws, m.id, { done }).catch((e) => { commit(() => { m.done = !done }); toast(`Not saved: ${(e as Error).message}`) })
  }
  mark(true)
  toast('Marked handled', 'Undo', () => mark(false))
}

export function mailReply(id: string) {
  const m = mailOf(id), ws = S.ws
  if (!m) return
  modal({
    title: `Reply · ${m.subj}`, form: 'mreply',
    body: <>
      <div className="src"><Ic n="mail" sm /> {W().src.mail!.n} · to {m.from.replace(/^You → /, '')}</div>
      <label className="field"><span>{LIVE.on ? 'Your reply' : 'LLM draft, yours to edit'}</span><textarea className="ta" name="t" rows={7} data-autofocus defaultValue={LIVE.on ? 'hi,\n' : MDR[m.id] || 'hi,\nthanks, I will come back to you today.'} /></label>
      <p className="hint" style={{ margin: 0 }}>{LIVE.on ? 'Sends through the bridge; recorded here once it went out.' : 'Demo: sending only records it here.'}</p>
    </>,
    foot: <><CancelBtn /><button className="btn pri" type="submit"><Ic n="send" sm />Send</button></>,
    onSubmit: async (fd) => {
      const t = String(fd.get('t') || '').trim()
      if (!t) return
      if (!(await sendVia('mail', m.id, t))) return
      closeModal()
      commit(() => { m.sent = { at: hm(), t }; if (m.cat === 'reply') m.done = true })
      if (LIVE.on && m.cat === 'reply') void api.markMail(ws, m.id, { done: true }).catch(() => undefined)
      if (m.job && byId(m.job)) await doCmd(m.job, { op: 'replied', subj: m.subj }, null)
      toast(LIVE.on ? 'Reply sent' : 'Reply recorded · demo, nothing was sent')
    },
  })
}
