import type { Job } from '../../src/model/types.ts'
import type { Bus } from '../events.ts'
import type { Mark, Store } from '../store/port.ts'

/* Kept chats: a chat the console found or used stays listed after it leaves the source's window. Its mark
   chat:{id} carries kept and the name; the chat list and the act's chat lookup add the kept chats the source no
   longer lists. Hiding a kept chat hides it; unhiding keeps it. */

type Named = { id: string; name: string }

/** the kept chats in marks, by name */
export function keptChats(marks: Record<string, Mark>): Named[] {
  return Object.entries(marks).filter(([id, m]) => id.startsWith('chat:') && m.kept)
    .map(([id, m]) => ({ id: id.slice(5), name: m.name || id.slice(5) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** the source's chat items with the kept ones: a listed kept chat carries kept, an unlisted one comes last with no
    last message; a hidden one stays out */
export function withKept(items: Record<string, unknown>[], marks: Record<string, Mark>): Record<string, unknown>[] {
  const listed = new Set(items.map((i) => String(i.id)))
  const out = items.map((i) => (marks[`chat:${String(i.id)}`]?.kept ? { ...i, kept: true } : i))
  for (const k of keptChats(marks)) {
    if (listed.has(k.id) || marks[`chat:${k.id}`].hidden) continue
    out.push({ id: k.id, name: k.name, kind: 'chat', unread: 0, lastAt: null, lastFrom: null, lastPreview: null, kept: true })
  }
  return out
}

/** the source's list plus the kept chats it no longer lists, for finding a chat by name or id */
export const withKeptNames = (listed: Named[], marks: Record<string, Mark>): Named[] =>
  [...listed, ...keptChats(marks).filter((k) => !listed.some((c) => c.id === k.id))]

/** marks a chat kept; a known name replaces the kept one */
export const keep = (store: Pick<Store, 'putMark'>, id: string, name?: string) =>
  store.putMark(`chat:${id}`, { kept: true, ...(name ? { name } : {}) })

/** the chats a job uses: its own and its context's */
export const jobChats = (j: Job) => [...new Set([j.chat ?? '', ...(j.ctx ?? []).filter((c) => c.k === 'chat').map((c) => c.id)])].filter(Boolean)

/** keeps every chat a saved job uses, once per chat while the console runs and only when it is not kept yet; the
    name comes from the job's context or the source's list. Returns the unsubscribe. */
export function keepJobChats(o: { bus: Pick<Bus, 'on'>; store: Pick<Store, 'putMark' | 'marks'>; chats: () => Promise<Named[]> }) {
  const seen = new Set<string>()
  let chain = Promise.resolve()
  return o.bus.on((e) => {
    if (e.kind !== 'job') return
    const j = e.job, fresh = jobChats(j).filter((id) => !seen.has(id))
    if (!fresh.length) return
    fresh.forEach((id) => seen.add(id))
    chain = chain.then(async () => {
      const marks = await o.store.marks().catch(() => ({} as Record<string, Mark>))
      const todo = fresh.filter((id) => !marks[`chat:${id}`]?.kept)
      const named = (id: string) => (j.ctx ?? []).find((c) => c.k === 'chat' && c.id === id)?.name
      const listed = todo.every(named) ? [] : await o.chats().catch(() => [])
      for (const id of todo) {
        try { await keep(o.store, id, named(id) ?? listed.find((c) => c.id === id)?.name) }
        catch (e) { seen.delete(id); console.error(`keeping chat ${id} of ${j.id}: ${(e as Error).message}`) }
      }
    })
  })
}
