import type { Job, Playbook, RunRec } from '../../src/model/types.ts'
import { GatewayError, READY, stateError } from '../bridge/wire.ts'
import type { ConceptReply } from '../bridge/wire.ts'
import type { Bus } from '../events.ts'
import { Conflict } from './port.ts'
import type { Mark, Store } from './port.ts'

/* The Store port over B, the state concepts in the workplace bridge. Reads come from a mirror filled
   by one snapshot and kept current by B's deltas and by this store's own write replies; a copy never
   goes back to an older v. Writes are compare-and-set on B, so a stale mirror costs a conflict, never
   a lost write. While the workplace is away the mirror is dropped and every call fails with 503. */

export interface StateGateway {
  read(concepts: string[]): Promise<Record<string, ConceptReply>>
  state(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ConceptReply>
}
export type BridgeStore = Store & { reset(): void }

type Doc = { id: string; v: number; [k: string]: unknown }
const KINDS = ['jobs', 'runs', 'playbooks', 'marks'] as const
type Kind = typeof KINDS[number]
type Mirror = Record<Kind, Map<string, Doc>>
type Written = { doc?: Doc | null; replaced?: Doc | null; current?: Doc | null }

const isKind = (c: string): c is Kind => (KINDS as readonly string[]).includes(c)
const clone = <T>(x: T): T => structuredClone(x)
const asJob = (d: Doc): Job => { const { updated: _u, ...j } = d; return clone(j) as unknown as Job }
const asRun = (d: Doc): RunRec => { const { v: _v, updated: _u, ...r } = d; return clone(r) as unknown as RunRec }
const asMark = (d: Doc | undefined): Mark => ({
  ...(d?.done === true ? { done: true } : {}), ...(typeof d?.job === 'string' ? { job: d.job } : {}),
  ...(d?.hidden === true ? { hidden: true } : {}), ...(typeof d?.name === 'string' ? { name: d.name } : {}),
})

/** prefix = the workspace's job prefix: the gateway mints J-NNNN, and the job is stored as <prefix>-NNNN */
export function bridgeStore(o: { bridge: StateGateway; bus: Bus; playbooks: Record<string, Playbook>; prefix: string }): BridgeStore {
  let mirror: Mirror | null = null, loading: Promise<Mirror> | null = null, gen = 0
  /** kind/id → the v a delete of ours removed: a delta still in flight must not bring it back */
  const gone = new Map<string, number>()

  async function load(): Promise<Mirror> {
    const r = await o.bridge.read([...KINDS])
    const m = {} as Mirror
    for (const k of KINDS) {
      const c = r[k]
      if (!c || !READY.has(c.status) || !Array.isArray(c.items))
        throw new GatewayError(503, c?.status || 'source_unavailable', c?.message || `${k} is unavailable`)
      m[k] = new Map((c.items as Doc[]).map((d) => [d.id, d]))
    }
    return m
  }
  async function docs(): Promise<Mirror> {
    if (mirror) return mirror
    const g = gen
    loading ??= load().finally(() => { loading = null })
    const m = await loading
    if (g === gen) mirror = m
    return m
  }
  function reset() { gen++; mirror = null; gone.clear() }
  function keep(k: Kind, d: Doc) {
    const m = mirror?.[k]
    if (!m) return
    const had = m.get(d.id), dead = gone.get(`${k}/${d.id}`)
    if ((had && had.v > d.v) || (dead !== undefined && d.v <= dead)) return
    m.set(d.id, d)
  }

  o.bus.on((e) => {
    if (e.kind === 'bridge' && e.state === 'unavailable') { reset(); return }
    if (e.kind !== 'source' || !isKind(e.concept)) return
    if (e.reset) { reset(); return }
    for (const u of e.upserts as Doc[]) keep(e.concept, u)
    for (const id of e.removes) { mirror?.[e.concept].delete(id); gone.delete(`${e.concept}/${id}`) }
  })

  async function put(k: Kind, id: string, doc: Record<string, unknown> | null, expectV: number | null): Promise<Written> {
    await docs() // a mirror to keep current: the reply below and any late delta go through the v guard
    const r = await o.bridge.state('POST', '/api/state/put', { concept: k, id, doc, expectV })
    const it = (r.items ?? {}) as Written
    if (r.status === 'conflict') {
      if (it.current) keep(k, it.current); else mirror?.[k].delete(id)
      throw new Conflict(r.message || `${k} ${id} changed elsewhere`, (it.current ?? undefined) as unknown as Job | undefined)
    }
    // unconfirmed: the mirror may be wrong either way, so the next read asks B
    if (r.status === 'outcome_unknown') reset()
    if (!READY.has(r.status)) throw stateError(r)
    if (it.doc) keep(k, it.doc)
    else { mirror?.[k].delete(id); if (it.replaced) gone.set(`${k}/${id}`, it.replaced.v) }
    return it
  }
  /** a write that only this console makes: on a conflict take B's v and write again */
  async function putLatest(k: Kind, id: string, doc: (cur: Doc | undefined) => Record<string, unknown> | null) {
    for (let n = 0; ; n++) {
      const cur = (await docs())[k].get(id), next = doc(cur)
      if (next === null && !cur) return
      try { await put(k, id, next, cur?.v ?? null); return } catch (e) {
        if (e instanceof Conflict && n < 3) continue
        throw e
      }
    }
  }

  return {
    async jobs() { return [...(await docs()).jobs.values()].map(asJob).sort((a, b) => b.id.localeCompare(a.id)) },
    async job(id) { const d = (await docs()).jobs.get(id); return d && asJob(d) },
    async putJob(job, expectV) { return asJob((await put('jobs', job.id, { ...job }, expectV)).doc!) },
    async runs() { return [...(await docs()).runs.values()].map(asRun) },
    async putRun(r) { await putLatest('runs', r.id, () => ({ ...r })) },
    async playbooks() {
      const out = clone(o.playbooks)
      for (const d of (await docs()).playbooks.values()) { if (d.pb) out[d.id] = clone(d.pb as Playbook); else delete out[d.id] }
      return out
    },
    // a built-in playbook is deleted by a tombstone; an added one by removing its document
    async putPlaybook(id, pb) { await putLatest('playbooks', id, () => (pb ? { pb } : o.playbooks[id] ? { pb: null } : null)) },
    async marks() { return Object.fromEntries([...(await docs()).marks.values()].map((d) => [d.id, asMark(d)])) },
    async putMark(id, m) { await putLatest('marks', id, (cur) => (m ? { ...asMark(cur), ...m } : null)) },
    async nextJobId() {
      const r = await o.bridge.state('POST', '/api/state/new-job-id', {})
      if (!READY.has(r.status)) throw stateError(r)
      const id = String((r.items as { id?: unknown } | null)?.id), m = /^J-(\d+)$/.exec(id)
      if (!m) throw new GatewayError(502, 'bad_reply', `the bridge minted ${id} as a job id, not J-NNNN`)
      return `${o.prefix}-${m[1]}`
    },
    reset,
  }
}
