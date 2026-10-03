import { demoFake } from '../testkit.ts'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { startFakeGateway } from './fake.ts'
import type { FakeGateway } from './fake.ts'

/* The gateway contract the console relies on. Runs against a real gateway when GATEWAY_URL and
   GATEWAY_TOKEN are set (read-only: no act reaches a source), else against the fake. */

const FIELDS: Record<string, string[]> = {
  chat: ['id', 'name', 'kind', 'unread', 'lastAt', 'link'],
  mail: ['id', 'folder', 'from', 'subject', 'at', 'category', 'link'],
  cal: ['id', 'subject', 'start', 'end', 'link'],
  work: ['id', 'type', 'title', 'state', 'link'],
  review: ['id', 'repo', 'title', 'author', 'link'],
  ci: ['id', 'pipeline', 'status', 'link'],
  time: ['id', 'period', 'state', 'hours', 'workdays', 'emptyDays', 'top', 'locked', 'link'],
}
let fake: FakeGateway | null = null, url = '', token = ''
before(async () => {
  if (process.env.GATEWAY_URL && process.env.GATEWAY_TOKEN) { url = process.env.GATEWAY_URL; token = process.env.GATEWAY_TOKEN; return }
  fake = await startFakeGateway({ seed: demoFake() }); url = fake.url; token = fake.token
})
after(async () => { await fake?.close() })

const get = async (path: string, tok: string | null = token) => {
  const r = await fetch(url + path, { headers: tok ? { authorization: `Bearer ${tok}` } : {} })
  return { status: r.status, body: await r.json() as any }
}

test('snapshot: bridge state and a status per concept; ok concepts carry rev and the spec fields', async () => {
  const { status, body } = await get(`/api/snapshot?concepts=${Object.keys(FIELDS).join(',')}`)
  assert.equal(status, 200)
  assert.equal(typeof body.bridge.state, 'string')
  for (const [k, fields] of Object.entries(FIELDS)) {
    const c = body.concepts[k]
    assert.ok(c && typeof c.status === 'string', `${k} has a status`)
    if (c.status !== 'ok') continue
    assert.equal(typeof c.rev, 'number')
    assert.ok(Array.isArray(c.items))
    for (const it of c.items) for (const f of fields) assert.ok(f in it, `${k} item has ${f}`)
  }
})

test('get chat returns messages', async (t) => {
  const s = await get('/api/snapshot?concepts=chat'), c = s.body.concepts.chat
  if (c.status !== 'ok' || !c.items.length) return t.skip('no chat to read')
  const { body } = await get(`/api/items/chat/${encodeURIComponent(c.items[0].id)}`)
  assert.equal(body.status, 'ok')
  assert.ok(Array.isArray(body.items.messages))
  for (const m of body.items.messages) for (const f of ['id', 'author', 'authorKind', 'at', 'text']) assert.ok(f in m, `message has ${f}`)
})

test('get work returns the item with its sections and comments', async (t) => {
  const s = await get('/api/snapshot?concepts=work'), c = s.body.concepts.work
  if (c.status !== 'ok' || !c.items.length) return t.skip('no work item to read')
  const { body } = await get(`/api/items/work/${encodeURIComponent(c.items[0].id)}`)
  assert.equal(body.status, 'ok')
  for (const f of ['type', 'title', 'state', 'assignedTo', 'description', 'reproSteps', 'acceptanceCriteria', 'comments']) assert.ok(f in body.items, `work has ${f}`)
  for (const m of body.items.comments) for (const f of ['id', 'author', 'at', 'text']) assert.ok(f in m, `comment has ${f}`)
})

test('no token is 401; an act without the console token never lands', async () => {
  assert.equal((await get('/api/snapshot', null)).status, 401)
  const r = await fetch(url + '/api/act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'chat.post', actionId: 'x', args: {} }) })
  assert.equal(r.status, 401)
})

test('an unknown action is refused as unknown_action', async () => {
  const r = await fetch(url + '/api/act', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'console.contract.noop', actionId: `contract-${Date.now()}`, args: {} }),
  })
  const body = await r.json() as any
  assert.equal(body.status ?? body.error, 'unknown_action')
})

test('the event stream sends status within 11 s', { timeout: 15000 }, async () => {
  const ac = new AbortController()
  const r = await fetch(url + '/api/events', { signal: ac.signal, headers: { authorization: `Bearer ${token}` } })
  assert.equal(r.status, 200)
  const dec = new TextDecoder(), t0 = Date.now()
  let buf = ''
  for await (const ch of r.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(ch, { stream: true })
    if (/event: status\n/.test(buf) || Date.now() - t0 > 11000) break
  }
  ac.abort()
  assert.match(buf, /event: status\ndata: \{/)
})

const call = async (f: FakeGateway, method: string, path: string, body?: unknown) => {
  const r = await fetch(f.url + path, { method, headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return (await r.json()) as any
}

test("the fake's Start moves an item from the board's ready column to its dev column", async () => {
  const it = (id: string, column: string) => ({ id, type: 'Task', title: id, state: 'New', column, lane: 'free', assignedTo: null, changedAt: '2026-10-01T09:00:00Z', link: '' })
  const seed = { concepts: { board: [it('T-1', 'Approved'), it('T-2', 'Ready')] }, threads: {} }
  const own = await startFakeGateway({ seed, me: 'Robin', board: { ready: 'Approved', dev: { column: 'Build', state: 'Active' } } })
  const plain = await startFakeGateway({ seed })
  const start = async (f: FakeGateway, id: string) => {
    await call(f, 'POST', '/api/act', { action: 'work.start', actionId: id, args: { id } })
    const b = (await call(f, 'GET', '/api/snapshot?concepts=board')).concepts.board.items.find((i: { id: string }) => i.id === id)
    return [b.column, b.state, b.assignedTo]
  }
  try {
    assert.deepEqual(await start(own, 'T-1'), ['Build', 'Active', 'Robin'])
    assert.deepEqual(await start(own, 'T-2'), ['Ready', 'New', 'Robin'], "Ready is not this board's ready column")
    assert.deepEqual(await start(plain, 'T-2'), ['Dev', 'In Progress', 'You'])
    assert.deepEqual(await start(plain, 'T-1'), ['Approved', 'New', 'You'])
  } finally { await own.close(); await plain.close() }
})

test("a seed's get answers a concept's item get; the item lookup and the other concepts stay as they are", async () => {
  const seen: unknown[] = []
  const f = await startFakeGateway({ seed: {
    concepts: { time: [{ id: '2026-09', emptyDays: ['2026-09-02'] }], board: [{ id: 'T-1', title: 'x' }] }, threads: {},
    get: { time: (id, item) => { seen.push([id, item.emptyDays]); return { entries: [{ id: `${id}-01` }] } } },
  } })
  try {
    const r = await call(f, 'GET', '/api/items/time/2026-09')
    assert.deepEqual([r.status, typeof r.rev, r.items], ['ok', 'number', { entries: [{ id: '2026-09-01' }] }])
    assert.deepEqual(seen, [['2026-09', ['2026-09-02']]])
    assert.equal((await call(f, 'GET', '/api/items/time/2026-10')).status, 'source_error', 'no item, no get')
    assert.deepEqual((await call(f, 'GET', '/api/items/board/T-1')).items, { id: 'T-1', title: 'x' })
  } finally { await f.close() }
})

test("a seed's get that throws answers 500 naming the error, is logged, and leaves the fake serving", async () => {
  const lines: string[] = []
  const f = await startFakeGateway({ log: (l) => lines.push(l), seed: {
    concepts: { time: [{ id: '2026-09' }] }, threads: {},
    get: { time: () => { throw new Error('no hours file') } },
  } })
  try {
    const r = await fetch(f.url + '/api/items/time/2026-09', { headers: { authorization: `Bearer ${f.token}` }, signal: AbortSignal.timeout(5000) })
    assert.equal(r.status, 500)
    assert.deepEqual(await r.json(), { error: 'internal_error', message: 'no hours file' })
    assert.deepEqual(lines, ['fake gateway: GET /api/items/time/2026-09 failed: no hours file'])
    assert.equal((await call(f, 'GET', '/api/items/board/none')).status, 'source_error', 'the next request is served')
  } finally { await f.close() }
})

test('the fake mints J-NNNN only, as the gateway does, numbered past every job it holds whatever its prefix', async () => {
  const mint = async (f: FakeGateway) => {
    const r = await fetch(f.url + '/api/state/new-job-id', { method: 'POST', headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' }, body: '{}' })
    return ((await r.json()) as { items: { id: string } }).items.id
  }
  const fresh = await startFakeGateway(), held = await startFakeGateway()
  try {
    assert.deepEqual([await mint(fresh), await mint(fresh)], ['J-0001', 'J-0002'])
    assert.equal((await call(held, 'POST', '/api/state/put', { concept: 'jobs', id: 'A-0003', doc: { t: 'x' }, expectV: null })).status, 'ok')
    assert.equal(await mint(held), 'J-0004', 'a held A-0003 counts as the seq a real gateway keeps')
  } finally { await fresh.close(); await held.close() }
})
