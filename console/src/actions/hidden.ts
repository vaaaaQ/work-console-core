import * as api from '../live/api.ts'
import { LIVE } from '../live/api.ts'
import { CHATS, S } from '../model/world.ts'
import type { Chat, Ws } from '../model/types.ts'
import { commit } from '../store.ts'

/* Hidden threads: the console's own mark (B when live, memory in the demo), never the chat tool's.
   One list per workspace, so an Unhide acts on the workspace whose list it was clicked in. */

export interface Hidden { id: string; name: string }
export const HID = { open: false, list: {} as Record<Ws, Hidden[]>, demo: [] as { ws: Ws; c: Chat; i: number }[] }
export const hiddenOf = (ws: Ws = S.ws): Hidden[] => HID.list[ws] || []

export async function loadHidden(ws: Ws = S.ws) {
  if (!LIVE.on) return
  try { const l = await api.hiddenChats(ws); commit(() => { HID.list[ws] = l }) } catch { /* the list stays as it was */ }
}

/** moves the thread from ws's chats to ws's hidden list; done settles to why B refused (the thread is back), or null */
export function hideIn(ws: Ws, id: string): { c: Chat; done: Promise<string | null> } | null {
  const L = CHATS[ws] || [], i = L.findIndex((x) => x.id === id), c = L[i]
  if (!c) return null
  commit(() => {
    CHATS[ws] = L.filter((x) => x !== c)
    HID.list[ws] = [...hiddenOf(ws).filter((h) => h.id !== id), { id, name: c.name }]
    if (!LIVE.on) HID.demo.push({ ws, c, i })
  })
  const done = !LIVE.on ? Promise.resolve(null) : api.hideChat(ws, id, true, c.name).then(() => null, (e: Error) => {
    commit(() => {
      const now = (CHATS[ws] ||= [])
      if (!now.some((x) => x.id === id)) now.splice(Math.min(i, now.length), 0, c)
      HID.list[ws] = hiddenOf(ws).filter((h) => h.id !== id)
    })
    return e.message
  })
  return { c, done }
}

/** brings the thread back in ws, the workspace whose list held it; settles to why B refused (it stays listed), or null */
export function unhideIn(ws: Ws, id: string): Promise<string | null> {
  const h = hiddenOf(ws).find((x) => x.id === id), back = HID.demo.find((x) => x.ws === ws && x.c.id === id)
  commit(() => {
    HID.list[ws] = hiddenOf(ws).filter((x) => x.id !== id)
    const L = (CHATS[ws] ||= []), on = L.find((x) => x.id === id)
    if (on) { delete on.hidden; delete on.mentioned }
    if (back) { HID.demo = HID.demo.filter((x) => x !== back); if (!on) L.splice(Math.min(back.i, L.length), 0, back.c) }
  })
  // live: the thread comes back with the next chat reload, once B has rejoined it
  if (!LIVE.on) return Promise.resolve(null)
  return api.hideChat(ws, id, false).then(() => null, (e: Error) => {
    commit(() => { if (h && !hiddenOf(ws).some((x) => x.id === id)) HID.list[ws] = [...hiddenOf(ws), h] })
    return e.message
  })
}
