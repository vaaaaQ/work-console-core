import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bus } from '../events.ts'
import { bridgeStore } from '../store/bridge.ts'
import { Conflict } from '../store/port.ts'
import type { Job } from '../../src/model/types.ts'
import { StateB, fileDocs } from './state.ts'
import type { Doc, StateDocs } from './state.ts'

const root = mkdtempSync(join(tmpdir(), 'wc-state-'))
after(() => rmSync(root, { recursive: true, force: true }))
let n = 0
const file = () => join(root, `s${++n}`, 'ws.json')
const at = () => Date.parse('2026-10-08T12:00:00Z')

/** a B over a file, loaded, with its changes recorded */
const fresh = async (docs: StateDocs = fileDocs(file())) => {
  const changes: [string, Doc[], string[]][] = []
  const b = new StateB({ docs, onChange: (c, u, r) => changes.push([c, u, r]), now: at })
  await b.load()
  return { b, changes }
}
const items = (r: { items?: unknown }) => r.items as { doc: Doc | null; replaced: Doc | null; current?: Doc }

test('a new document gets v1; a stale expectV is a conflict that carries the current document', async () => {
  const { b } = await fresh()
  assert.equal(b.ready, true)
  const r = await b.put({ concept: 'jobs', id: 'AD-0001', doc: { title: 'one' }, expectV: null })
  assert.equal(r.status, 'ok')
  assert.deepEqual(items(r), { doc: { title: 'one', id: 'AD-0001', v: 1, updated: '2026-10-08T12:00:00.000Z' }, replaced: null })
  const c = await b.put({ concept: 'jobs', id: 'AD-0001', doc: { title: 'two' }, expectV: null })
  assert.equal(c.status, 'conflict')
  assert.equal(items(c).current!.v, 1)
  assert.equal((await b.put({ concept: 'jobs', id: 'AD-0001', doc: { title: 'two' }, expectV: 1 })).status, 'ok')
  assert.deepEqual(b.items('jobs').map((d) => [d.id, d.v, d.title]), [['AD-0001', 2, 'two']])
  assert.deepEqual(b.reply('jobs'), { status: 'ok', rev: 3, items: b.items('jobs') })
  assert.deepEqual(b.get('jobs', 'AD-0001'), { status: 'ok', rev: 3, items: b.items('jobs')[0] })
  assert.equal(b.get('jobs', 'AD-0404').status, 'not_found')
})

test('a delete replies with what it replaced', async () => {
  const { b } = await fresh()
  await b.put({ concept: 'marks', id: 'm1', doc: { done: true }, expectV: null })
  const r = await b.put({ concept: 'marks', id: 'm1', doc: null, expectV: 1 })
  assert.equal(r.status, 'ok')
  assert.equal(items(r).doc, null)
  assert.equal(items(r).replaced!.done, true)
  assert.deepEqual(b.items('marks'), [])
})

test('a document over 256 KB is too_large; an unknown concept or an empty id is bad_request', async () => {
  const { b } = await fresh()
  assert.equal((await b.put({ concept: 'runs', id: 'r', doc: { log: 'x'.repeat(256 * 1024) }, expectV: null })).status, 'too_large')
  assert.equal((await b.put({ concept: 'mail', id: 'm', doc: {}, expectV: null })).status, 'bad_request')
  assert.equal((await b.put({ concept: 'jobs', id: '', doc: {}, expectV: null })).status, 'bad_request')
  assert.equal((await b.put('nonsense')).status, 'bad_request')
  assert.equal(b.reply('mail').status, 'bad_request')
})

test('job ids mint as J-0001, J-0002, and past every held id', async () => {
  const { b } = await fresh()
  const id = async () => ((await b.newJobId()).items as { id: string }).id
  assert.equal(await id(), 'J-0001')
  assert.equal(await id(), 'J-0002')
  await b.put({ concept: 'jobs', id: 'A-0007', doc: {}, expectV: null })
  assert.equal(await id(), 'J-0008')
})

test('a reload from the same file gives the same documents and seq', async () => {
  const path = file()
  const { b } = await fresh(fileDocs(path))
  await b.put({ concept: 'playbooks', id: 'pb', doc: { pb: { steps: [] } }, expectV: null })
  await b.newJobId(); await b.newJobId()
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).kind, 'state')
  const { b: again } = await fresh(fileDocs(path))
  assert.deepEqual(again.items('playbooks'), b.items('playbooks'))
  assert.equal(((await again.newJobId()).items as { id: string }).id, 'J-0003')
})

test('fileDocs keeps two writes made at once', async () => {
  const path = file(), d = fileDocs(path)
  await d.load()
  await Promise.all([d.put('jobs', 'a', { id: 'a', v: 1 }), d.put('jobs', 'b', { id: 'b', v: 1 }), d.seq(4)])
  const back = await fileDocs(path).load()
  assert.deepEqual([back.docs.jobs.map((x) => x.id).sort(), back.seq], [['a', 'b'], 4])
})

test('a persist that throws changes nothing and answers source_unavailable', async () => {
  const inner = fileDocs(file())
  let broken = false
  const docs: StateDocs = {
    load: () => inner.load(),
    put: async (c, id, d) => { if (broken) throw new Error('disk full'); return inner.put(c, id, d) },
    seq: async (s) => { if (broken) throw new Error('disk full'); return inner.seq(s) },
  }
  const { b, changes } = await fresh(docs)
  await b.put({ concept: 'jobs', id: 'J-0001', doc: { title: 'kept' }, expectV: null })
  broken = true
  const r = await b.put({ concept: 'jobs', id: 'J-0001', doc: { title: 'lost' }, expectV: 1 })
  assert.equal(r.status, 'source_unavailable')
  assert.match(r.message!, /disk full/)
  assert.equal(b.items('jobs')[0].title, 'kept')
  assert.equal((await b.newJobId()).status, 'source_unavailable')
  broken = false
  assert.equal(((await b.newJobId()).items as { id: string }).id, 'J-0002', 'the failed mint took no number')
  assert.equal(changes.length, 1)
})

test('onChange fires with the upsert, and with the remove', async () => {
  const { b, changes } = await fresh()
  await b.put({ concept: 'marks', id: 'chat:c1', doc: { hidden: true }, expectV: null })
  await b.put({ concept: 'marks', id: 'chat:c1', doc: null, expectV: 1 })
  assert.deepEqual(changes.map(([c, u, r]) => [c, u.map((d) => d.id), r]), [['marks', ['chat:c1'], []], ['marks', [], ['chat:c1']]])
})

test('join: mail takes done and job from its mark; chat takes its jobs, drops a hidden thread unless an unread mention surfaces it, keeps the 30 newest', async () => {
  const { b } = await fresh()
  await b.put({ concept: 'marks', id: 'm1', doc: { done: true, job: 'AD-0001' }, expectV: null })
  await b.put({ concept: 'jobs', id: 'AD-0002', doc: { chat: 'c1' }, expectV: null })
  await b.put({ concept: 'jobs', id: 'AD-0001', doc: { chat: 'c1' }, expectV: null })
  await b.put({ concept: 'marks', id: 'chat:c2', doc: { hidden: true }, expectV: null })
  await b.put({ concept: 'marks', id: 'chat:c3', doc: { hidden: true }, expectV: null })
  assert.deepEqual(b.join('mail', [{ id: 'm1', s: 'a' }, { id: 'm2' }]), [{ id: 'm1', s: 'a', done: true, job: 'AD-0001' }, { id: 'm2' }])
  const old = Array.from({ length: 30 }, (_, i) => ({ id: `x${i}`, lastAt: `2026-10-01T00:00:${String(i).padStart(2, '0')}Z` }))
  const chat = b.join('chat', [
    ...old,
    { id: 'c1', lastAt: '2026-10-08T10:00:00Z' },
    { id: 'c2', lastAt: '2026-10-08T11:00:00Z' },
    { id: 'c3', lastAt: '2026-10-08T09:00:00Z', mentioned: true, unread: 2 },
  ])
  assert.equal(chat.length, 30)
  assert.deepEqual(chat.slice(0, 2), [
    { id: 'c1', lastAt: '2026-10-08T10:00:00Z', jobs: ['AD-0001', 'AD-0002'] },
    { id: 'c3', lastAt: '2026-10-08T09:00:00Z', mentioned: true, unread: 2, hidden: true },
  ])
  assert.equal(chat.at(-1)!.id, 'x2')
  assert.deepEqual(b.join('work', [{ id: 'W-1' }]), [{ id: 'W-1' }])
})

test('before load nothing is ready, and a reply says warming_up', () => {
  const b = new StateB({ docs: fileDocs(file()) })
  assert.equal(b.ready, false)
  assert.equal(b.reply('jobs').status, 'warming_up')
})

test('bridgeStore over a StateB does putJob, then a conflict, then nextJobId', async () => {
  const { b } = await fresh()
  const shim = {
    read: async (cs: string[]) => Object.fromEntries(cs.map((c) => [c, b.reply(c)])),
    state: async (_m: 'GET' | 'POST', path: string, body?: unknown) => (path === '/api/state/put' ? b.put(body) : b.newJobId()),
  }
  const store = bridgeStore({ bridge: shim, bus: new Bus(), playbooks: {}, prefix: 'AD' })
  const job = { id: 'AD-0001', title: 'one' } as unknown as Job
  const saved = await store.putJob(job, null)
  assert.equal((saved as unknown as Doc).v, 1)
  await assert.rejects(store.putJob(job, null), Conflict)
  assert.equal(await store.nextJobId(), 'AD-0002')
})
