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
  fake = await startFakeGateway(); url = fake.url; token = fake.token
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
