import { hm } from '../lib/util.ts'
import { dayOf, zone } from '../lib/zone.ts'
import type { CalEvent, Chat, Mail, MailCat, Msg } from '../model/types.ts'

/* Bridge A's items in the shapes the views already draw. Times arrive as ISO UTC and are shown
   in the home zone: HH:MM today, "yesterday", or the date. */

type Any = Record<string, unknown>
const s = (v: unknown) => (v == null ? '' : String(v))

const ymd = (d: Date) => dayOf(d)
export function when(iso: unknown, now = new Date()): string {
  const d = new Date(s(iso))
  if (isNaN(+d)) return s(iso)
  const day = ymd(d)
  if (day === ymd(now)) return hm(d)
  if (day === ymd(new Date(+now - 86400e3))) return 'yesterday'
  return d.toLocaleDateString('en-GB', { timeZone: zone(), day: '2-digit', month: '2-digit' })
}

const CATS = new Set(['reply', 'wait', 'fyi', 'auto'])
const list = (v: unknown) => (Array.isArray(v) ? v.map(s) : v ? [s(v)] : [])

export const adapt = {
  chat(i: Any, now?: Date): Chat {
    const from = s(i.lastFrom), prev = s(i.lastPreview)
    const o: Chat = { id: s(i.id), name: s(i.name), kind: s(i.kind), unread: Number(i.unread) || 0, sum: from ? `${from}: ${prev}` : prev, msgs: [], at: when(i.lastAt, now), link: s(i.link) }
    if (i.hidden === true) o.hidden = 1
    if (i.mentioned === true) o.mentioned = 1
    return o
  },
  msg(m: Any, now?: Date): Msg {
    const k = s(m.authorKind), o: Msg = { who: k === 'me' ? 'You' : s(m.author), at: when(m.at, now), t: s(m.text) }
    if (k === 'me') o.me = 1
    if (k === 'bot') o.bot = 1
    return o
  },
  mail(i: Any, mark: { done?: boolean; job?: string } = {}, now?: Date): Mail {
    const cat = (CATS.has(s(i.category)) ? s(i.category) : 'reply') as MailCat
    const o: Mail = {
      id: s(i.id), cat, from: cat === 'wait' ? `You → ${list(i.to)[0] || ''}` : s(i.from), subj: s(i.subject),
      at: when(i.at, now), sum: s(i.preview), body: '',
    }
    if (mark.job) o.job = mark.job
    if (mark.done || i.myReply === true) o.done = true
    return o
  },
  /** tz = the pack's team zone; null when the pack has none */
  cal(i: Any, tz: string | null): CalEvent {
    const a = new Date(s(i.start)), b = new Date(s(i.end)), min = Math.round((+b - +a) / 60e3)
    const n = i.cancelled ? 'cancelled' : s(i.organizer)
    const o: CalEvent = { b: hm(a), v: tz ? hm(a, tz) : '', t: s(i.subject), d: min > 0 ? `${min} min` : '—', n }
    if (isNaN(+a)) return o
    o.day = ymd(a); o.start = a.toISOString(); o.end = isNaN(+b) ? o.start : b.toISOString()
    if (i.organizer) o.org = s(i.organizer)
    if (i.cancelled) o.x = 1
    if (/^https:\/\//.test(s(i.joinUrl))) o.join = s(i.joinUrl)
    return o
  },
}

export function actFor(k: string, target: string, text: string): { action: string; args: Record<string, unknown> } | null {
  if (k === 'chat') return { action: 'chat.post', args: { chatName: target, text } }
  if (k === 'work') return { action: 'work.comment', args: { id: target, text } }
  if (k === 'mail') return { action: 'mail.send', args: { replyTo: target, text } }
  return null
}
