import type { ConceptReply } from '../bridge/wire.ts'
import { SourceFail } from './runtime.ts'

/* One concept's projection: the items last read, a hash per item, and a rev that moves only on a change. */

export type Item = { id: string; [k: string]: unknown }
export type Change = { upserts: Item[]; removes: string[] }

/** stable JSON: object keys sorted, so a re-ordered item is the same item */
const stable = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v) ?? 'null'
}

export class Projection {
  state = 'warming_up'
  rev = 0
  items: Item[] = []
  message?: string
  host?: string
  private hashes = new Map<string, string>()

  /** null: nothing changed; a recovery to ready counts as a change even with no item moving */
  apply(items: Item[]): Change | null {
    const next = new Map(items.map((i) => [i.id, stable(i)]))
    const upserts = items.filter((i) => this.hashes.get(i.id) !== next.get(i.id))
    const removes = [...this.hashes.keys()].filter((k) => !next.has(k))
    const wasReady = this.state === 'ready'
    this.items = items; this.hashes = next; this.state = 'ready'; this.message = undefined; this.host = undefined
    if (wasReady && !upserts.length && !removes.length) return null
    this.rev++
    return { upserts, removes }
  }

  /** true when the state or its message changed */
  fail(code: string, message: string, host?: string): boolean {
    const changed = this.state !== code || this.message !== message
    this.state = code; this.message = message; this.host = host
    return changed
  }

  reply(): ConceptReply & { host?: string } {
    if (this.state === 'ready') return { status: 'ok', rev: this.rev, items: this.items }
    return { status: this.state, rev: this.rev, message: this.message ?? this.state.replace(/_/g, ' '), ...(this.host ? { host: this.host } : {}) }
  }
}

/** a read's result as items: a list within the cap, string ids, no duplicates, each passing validate */
export function checkItems(raw: unknown, cap: number, validate?: (item: unknown) => string[]): Item[] {
  const bad = (m: string) => new SourceFail('source_error', m)
  if (!Array.isArray(raw)) throw bad(`the pack returned ${raw === null ? 'null' : typeof raw}, not a list`)
  if (raw.length > cap) throw bad(`${raw.length} items, over the cap of ${cap}`)
  const seen = new Set<string>()
  raw.forEach((it, i) => {
    const id = it && typeof it === 'object' ? (it as Record<string, unknown>).id : undefined
    if (typeof id !== 'string') throw bad(`item ${i} needs a string id`)
    if (seen.has(id)) throw bad(`duplicate id ${id}`)
    seen.add(id)
    const errors = validate?.(it) ?? []
    if (errors.length) throw bad(`item ${i}: ${errors.slice(0, 3).join('; ')}`)
  })
  return raw as Item[]
}
