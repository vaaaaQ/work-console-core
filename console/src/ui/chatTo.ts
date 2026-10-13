import type { Person } from '../live/api.ts'
import { isAddr } from '../live/adapt.ts'
import type { Chat } from '../model/types.ts'

/* What the To of a chat message offers: the chats the console lists whose name has the query in it, then the people
   the source found, then the typed address itself when nobody found has it. A chat is posted to as it is; a person or
   an address gets a 1:1 opened first. */

export type ToPick = { chat: string; name: string } | { addr: string; name: string }
export type ToRow = { pick: ToPick; sub: string }
const MAX_CHATS = 5
const low = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

/** a person named as a listed chat is that chat: a 1:1 carries the other person's name */
export function toRows(q: string, chats: Chat[], people: Person[]): ToRow[] {
  const ql = low(q)
  if (ql.length < 2) return []
  const cs = chats.filter((c) => low(c.name).includes(ql)).slice(0, MAX_CHATS), named = new Set(cs.map((c) => low(c.name)))
  const out: ToRow[] = cs.map((c) => ({ pick: { chat: c.id, name: c.name }, sub: c.kept && !c.at ? `${c.kind} · kept` : c.kind }))
  for (const p of people) if (!named.has(low(p.name))) out.push({ pick: { addr: p.mail, name: p.name }, sub: p.title ? `${p.title} · ${p.mail}` : p.mail })
  const typed = q.trim()
  if (isAddr(typed) && !people.some((p) => low(p.mail) === low(typed))) out.push({ pick: { addr: typed, name: typed }, sub: 'a new chat with this address' })
  return out
}
