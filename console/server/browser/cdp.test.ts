import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { CarrierError, cdpCarrier } from './cdp.ts'
import { startFakeCdp } from './fake-cdp.ts'
import type { FakeCdp } from './fake-cdp.ts'

let cdp: FakeCdp
before(async () => { cdp = await startFakeCdp() })
after(async () => { await cdp.close() })

const carrier = () => cdpCarrier(() => cdp.url, { controlMs: 2000 })
const fails = async (p: Promise<unknown>) => { try { await p } catch (e) { return e as CarrierError } assert.fail('expected a CarrierError') }

test('list returns the pages only, with their ids and urls', async () => {
  const a = cdp.addTab('https://mail.example/inbox'), w = cdp.addTab('https://mail.example/sw.js', {}, 'service_worker')
  try {
    const l = await carrier().list()
    assert.deepEqual(l.filter((t) => t.id === a.id || t.id === w.id), [{ id: a.id, url: 'https://mail.example/inbox' }])
  } finally { cdp.closeTab(a.id); cdp.closeTab(w.id) }
})

test('open puts /json/new with the url and returns the new tab', async () => {
  const t = await carrier().open('https://board.example/acme?x=1&y=2')
  try {
    assert.equal(t.url, 'https://board.example/acme?x=1&y=2')
    assert.ok(cdp.tabs.some((x) => x.id === t.id && x.url === t.url))
  } finally { cdp.closeTab(t.id) }
})

test('evaluate wakes the tab, then returns the value of an async expression evaluated in it', async () => {
  const t = cdp.addTab('https://mail.example/inbox', { seed: 41 })
  cdp.log.length = 0
  try {
    const v = await carrier().evaluate(t.id, '(async () => ({ host: location.host, n: seed + 1 }))()', 2000)
    assert.deepEqual(v, { host: 'mail.example', n: 42 })
    assert.deepEqual(cdp.log, ['Page.setWebLifecycleState', 'Runtime.evaluate'])
  } finally { cdp.closeTab(t.id) }
})

test('an expression that throws is a script error, sent', async () => {
  const t = cdp.addTab('https://mail.example/')
  try {
    const e = await fails(carrier().evaluate(t.id, '(() => { throw new Error("boom") })()', 2000))
    assert.ok(e instanceof CarrierError)
    assert.deepEqual([e.kind, e.sent], ['script', true])
    assert.match(e.message, /boom/)
  } finally { cdp.closeTab(t.id) }
})

test('an unknown tab is gone at once, not sent', async () => {
  const t0 = Date.now(), e = await fails(carrier().evaluate('T-none', '1', 2000))
  assert.deepEqual([e.kind, e.sent], ['gone', false])
  assert.ok(Date.now() - t0 < 1000, 'the refused handshake ends it, not the connect timeout')
})

test('an eval that never answers is a timeout, sent', async () => {
  const t = cdp.addTab('https://mail.example/')
  cdp.onEval = () => new Promise(() => {})
  try {
    const t0 = Date.now(), e = await fails(carrier().evaluate(t.id, '1', 300))
    assert.deepEqual([e.kind, e.sent], ['timeout', true])
    assert.ok(Date.now() - t0 < 2000)
  } finally { cdp.onEval = null; cdp.closeTab(t.id) }
})

test('a tab closed while its eval runs is gone, sent', async () => {
  const t = cdp.addTab('https://mail.example/')
  cdp.onEval = () => { setTimeout(() => cdp.closeTab(t.id), 50); return new Promise(() => {}) }
  try {
    const e = await fails(carrier().evaluate(t.id, '1', 3000))
    assert.deepEqual([e.kind, e.sent], ['gone', true])
  } finally { cdp.onEval = null }
})

test('reload sends Page.reload to the tab', async () => {
  const t = cdp.addTab('https://mail.example/')
  try {
    await carrier().reload(t.id)
    assert.equal(t.reloads, 1)
  } finally { cdp.closeTab(t.id) }
})

test('activate hits /json/activate/<id>; an unknown id is gone', async () => {
  const t = cdp.addTab('https://mail.example/')
  try {
    await carrier().activate(t.id)
    assert.deepEqual(cdp.activated.slice(-1), [t.id])
    assert.equal((await fails(carrier().activate('T-none'))).kind, 'gone')
  } finally { cdp.closeTab(t.id) }
})

test('no browser: every call is a cdp error, not sent', async () => {
  const c = cdpCarrier(() => null)
  for (const p of [c.list(), c.open('https://mail.example/'), c.evaluate('T1', '1', 100), c.reload('T1'), c.activate('T1')]) {
    const e = await fails(p)
    assert.deepEqual([e.kind, e.sent], ['cdp', false])
  }
})

test('a port nothing listens on is a cdp error, not sent', async () => {
  const e = await fails(cdpCarrier(() => 'http://127.0.0.1:9', { controlMs: 1000 }).list())
  assert.deepEqual([e.kind, e.sent], ['cdp', false])
})
