import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ConceptReply } from '../bridge/wire.ts'

/* B for a local source: the console's own jobs, runs, playbooks and marks, with the workplace bridge's rules.
   Writes are serialized and persisted before they are applied, so a failed persist changes nothing. */

export type Doc = { id: string; v: number; updated?: string; [k: string]: unknown }
export const STATE = ['jobs', 'runs', 'playbooks', 'marks']
export interface StateDocs {
  load(): Promise<{ docs: Record<string, Doc[]>; seq: number }>
  put(concept: string, id: string, doc: Doc | null): Promise<void>
  seq(n: number): Promise<void>
}

const MAX_DOC = 256 * 1024, CHAT_CAP = 30
type Item = { id: string; [k: string]: unknown }

/** one JSON file {kind:'state', docs, seq}, rewritten through a temp file and a rename */
export function fileDocs(path: string): StateDocs {
  let data: { kind: 'state'; docs: Record<string, Doc[]>; seq: number } = { kind: 'state', docs: {}, seq: 0 }
  let queue: Promise<unknown> = Promise.resolve()
  const write = (change: (d: typeof data) => typeof data) => {
    const p = queue.then(async () => {
      const next = change(data)
      await mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(next))
      await rename(tmp, path)
      data = next
    })
    queue = p.catch(() => {})
    return p
  }
  return {
    async load() {
      let raw: string | null = null
      try { raw = await readFile(path, 'utf8') } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      if (raw !== null) {
        const j = JSON.parse(raw)
        if (j?.kind !== 'state' || typeof j.docs !== 'object') throw new Error(`${path} is not a state file`)
        data = { kind: 'state', docs: j.docs, seq: Number(j.seq) || 0 }
      }
      return structuredClone({ docs: data.docs, seq: data.seq })
    },
    put(concept, id, doc) {
      return write((d) => {
        const list = (d.docs[concept] ?? []).filter((x) => x.id !== id)
        return { ...d, docs: { ...d.docs, [concept]: doc ? [...list, doc] : list } }
      })
    },
    seq(n) { return write((d) => ({ ...d, seq: n })) },
  }
}

export class StateB {
  ready = false
  private docs: StateDocs; private onChange: (concept: string, upserts: Doc[], removes: string[]) => void; private now: () => number
  private held: Record<string, Map<string, Doc>> = {}
  private revs: Record<string, number> = {}
  private seqN = 0
  private queue: Promise<unknown> = Promise.resolve()

  constructor(o: { docs: StateDocs; onChange?: (concept: string, upserts: Doc[], removes: string[]) => void; now?: () => number }) {
    this.docs = o.docs; this.onChange = o.onChange ?? (() => {}); this.now = o.now ?? Date.now
  }

  async load(): Promise<void> {
    const { docs, seq } = await this.docs.load()
    for (const c of STATE) { this.held[c] = new Map((docs[c] ?? []).map((d) => [d.id, d])); this.revs[c] = 1 }
    this.seqN = seq
    this.ready = true
  }

  items(concept: string): Doc[] { return [...(this.held[concept]?.values() ?? [])] }

  reply(concept: string): ConceptReply {
    if (!STATE.includes(concept)) return { status: 'bad_request', message: `${concept} is not a state concept` }
    if (!this.ready) return { status: 'warming_up', message: 'the state store is loading' }
    return { status: 'ok', rev: this.revs[concept], items: this.items(concept) }
  }

  get(concept: string, id: string): ConceptReply {
    const r = this.reply(concept)
    if (r.status !== 'ok') return r
    const d = this.held[concept].get(id)
    return d ? { status: 'ok', rev: r.rev, items: d } : { status: 'not_found', message: `${concept} has no ${id}` }
  }

  /** A's mail and chat with B's marks and jobs joined in; other concepts as they are */
  join(concept: string, items: Item[]): Item[] {
    const mark = (id: string) => this.held.marks?.get(id)
    if (concept === 'mail') return items.map((m) => {
      const k = mark(m.id)
      return k ? { ...m, ...(k.done != null ? { done: k.done } : {}), ...(k.job != null ? { job: k.job } : {}) } : m
    })
    if (concept !== 'chat') return items
    const jobs = this.items('jobs')
    return items.flatMap((t): Item[] => {
      const js = jobs.filter((j) => j.chat === t.id).map((j) => j.id).sort(), hidden = mark(`chat:${t.id}`)?.hidden === true
      if (hidden && !(t.mentioned === true && Number(t.unread) > 0)) return []
      return [{ ...t, ...(js.length ? { jobs: js } : {}), ...(hidden ? { hidden: true } : {}) }]
    }).sort((a, b) => String(b.lastAt ?? '').localeCompare(String(a.lastAt ?? ''))).slice(0, CHAT_CAP)
  }

  /** {concept, id, doc|null, expectV}: compare-and-set on v */
  put(body: unknown): Promise<ConceptReply> {
    return this.serial(async () => {
      const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
      const concept = String(b.concept ?? ''), id = typeof b.id === 'string' ? b.id : ''
      const doc = (b.doc && typeof b.doc === 'object' ? b.doc : null) as Record<string, unknown> | null
      const expectV = typeof b.expectV === 'number' ? b.expectV : null
      if (!STATE.includes(concept) || !id) return { status: 'bad_request', message: 'put needs a state concept and an id' }
      if (!this.ready) return { status: 'warming_up', message: 'the state store is loading' }
      const m = this.held[concept], cur = m.get(id)
      if ((cur?.v ?? null) !== expectV)
        return { status: 'conflict', message: `${concept} '${id}' is at v${cur?.v ?? '-'}, not v${expectV ?? '-'}`, items: cur ? { current: cur } : null }
      const saved: Doc | null = doc ? { ...doc, id, v: (expectV ?? 0) + 1, updated: new Date(this.now()).toISOString() } : null
      if (saved && JSON.stringify(saved).length > MAX_DOC) return { status: 'too_large', message: 'a document is capped at 256 KB' }
      if (!saved && !cur) return { status: 'ok', rev: this.revs[concept], items: { doc: null, replaced: null } }
      try { await this.docs.put(concept, id, saved) } catch (e) { return this.unavailable(e) }
      if (saved) m.set(id, saved); else m.delete(id)
      this.revs[concept]++
      this.onChange(concept, saved ? [saved] : [], saved ? [] : [id])
      return { status: 'ok', rev: this.revs[concept], items: { doc: saved, replaced: cur ?? null } }
    })
  }

  /** J-NNNN, past the persisted seq and every held job id's number */
  newJobId(): Promise<ConceptReply> {
    return this.serial(async () => {
      if (!this.ready) return { status: 'warming_up', message: 'the state store is loading' }
      const held = this.items('jobs').map((j) => { const i = j.id.indexOf('-'); return i > 0 ? +j.id.slice(i + 1) || 0 : 0 })
      const n = Math.max(this.seqN, ...held) + 1
      try { await this.docs.seq(n) } catch (e) { return this.unavailable(e) }
      this.seqN = n
      return { status: 'ok', rev: this.revs.jobs, items: { id: `J-${String(n).padStart(4, '0')}` } }
    })
  }

  private unavailable(e: unknown): ConceptReply {
    return { status: 'source_unavailable', message: `the state store did not take the write: ${(e as Error).message}` }
  }

  private serial<T>(f: () => Promise<T>): Promise<T> {
    const p = this.queue.then(f)
    this.queue = p.catch(() => {})
    return p
  }
}
