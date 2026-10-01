import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Job } from '../src/model/types.ts'
import { startFakeGateway } from './bridge/fake.ts'
import { loadConfig } from './config.ts'
import { Bus } from './events.ts'
import { jobByText, main, onBridgeBack } from './main.ts'

async function until(f: () => boolean, ms = 2000) {
  const t0 = Date.now()
  while (!f()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 2)) }
}

const job = (id: string, key: string, st = 'active') => ({ id, key, st }) as unknown as Job

test('a review or build names a job by its key number as a whole token', () => {
  const js = [job('J-1', 'ACME-512'), job('J-2', 'OPS-12', 'active'), job('J-3', 'ACME-777', 'done')]
  assert.equal(jobByText(js, 'feature/ACME-512-rate-limit')?.id, 'J-1')
  assert.equal(jobByText(js, 'feature/ACME-1512-x'), undefined, 'not inside a longer number')
  assert.equal(jobByText(js, 'fix 12 things'), undefined, 'too short to trust')
  assert.equal(jobByText(js, 'bugfix/777'), undefined, 'closed jobs are skipped')
})

test('the state is loaded once at startup and again only when the bridge comes back', () => {
  const bus = new Bus()
  let loads = 0
  const stop = onBridgeBack(bus, async () => { loads++ })
  const up = (concepts: Record<string, string>) => bus.emit({ kind: 'bridge', state: 'ok', concepts })
  try {
    up({ chat: 'ready' })
    assert.equal(loads, 1, 'startup')
    up({ chat: 'degraded' }); up({ chat: 'ready' })
    assert.equal(loads, 1, 'a concept flip while the bridge stays up is not a comeback')
    bus.emit({ kind: 'bridge', state: 'unavailable', concepts: {} })
    up({ chat: 'ready' })
    assert.equal(loads, 2, 'back after being away')
  } finally { stop() }
})

test('a failed load is retried with backoff until it succeeds, and stops when the bridge goes away', async (t) => {
  t.mock.method(console, 'error', () => undefined)
  const bus = new Bus()
  const up = () => bus.emit({ kind: 'bridge', state: 'ok', concepts: {} })
  let calls = 0
  const stop = onBridgeBack(bus, async () => { if (++calls < 3) throw new Error('store_error') }, [5, 5])
  try {
    up()
    await until(() => calls === 3)
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(calls, 3, 'no more loads once one succeeded')
  } finally { stop() }

  const bus2 = new Bus()
  let tries = 0
  const stop2 = onBridgeBack(bus2, async () => { tries++; throw new Error('store_error') }, [5, 5])
  try {
    bus2.emit({ kind: 'bridge', state: 'ok', concepts: {} })
    await until(() => tries >= 2)
    bus2.emit({ kind: 'bridge', state: 'unavailable', concepts: {} })
    const n = tries
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(tries, n, 'no retry while the bridge is away')
  } finally { stop2() }
})

test('main starts on loopback with the fake gateway, recovers runs, and closes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wc-main-'))
  const cfg = { ...loadConfig({ WORK_CONSOLE_HOME: home, WORK_CONSOLE_FAKE_GATEWAY: '1' }), loopbackPort: 0 }
  const m = await main({ cfg, sdk: { async *start() { yield { k: 'result', ok: false, error: 'unused' } } } })
  try {
    assert.equal(m.lanPort, null, 'no certificate, no LAN listener')
    const r = await fetch(`http://127.0.0.1:${m.loopbackPort}/api/state`)
    assert.equal(r.status, 200)
    const st = await r.json() as { jobs: Job[]; playbooks: Record<string, unknown> }
    assert.deepEqual(st.jobs, []); assert.ok(Object.keys(st.playbooks).length > 0)
  } finally { await m.close() }
})

test('the console starts while the workplace is away', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wc-main-'))
  const free = createServer()
  await new Promise<void>((r) => free.listen(0, '127.0.0.1', r))
  const port = (free.address() as { port: number }).port
  await new Promise((r) => free.close(r))
  const tok = join(home, 'console.token')
  writeFileSync(tok, 'tok-away')
  const cfg = { ...loadConfig({ WORK_CONSOLE_HOME: home, GATEWAY_URL: `http://127.0.0.1:${port}` }), loopbackPort: 0, consoleTokenPath: tok, llmTokenPath: tok }
  const m = await main({ cfg, sdk: { async *start() { yield { k: 'result', ok: false, error: 'unused' } } } })
  const state = async () => (await (await fetch(`http://127.0.0.1:${m.loopbackPort}/api/state`)).json()) as { jobs: Job[]; playbooks: Record<string, unknown>; bridge: { state: string } }
  let fake: Awaited<ReturnType<typeof startFakeGateway>> | null = null
  try {
    const away = await state()
    assert.deepEqual(away.jobs, []); assert.equal(away.bridge.state, 'unavailable')
    assert.ok(Object.keys(away.playbooks).length > 0, 'the built-in playbooks stand in')

    fake = await startFakeGateway({ port, token: 'tok-away', statusMs: 100 })
    const put = await fetch(`${fake.url}/api/state/put`, { method: 'POST', headers: { authorization: 'Bearer tok-away', 'content-type': 'application/json' }, body: JSON.stringify({ concept: 'jobs', id: 'J-0007', doc: { id: 'J-0007', t: 'waiting', key: 'ACME-1', pb: 'action', prj: 'platform', ws: 'acme', st: 'ready', flow: {}, ts: 0, jr: [] }, expectV: null }) })
    assert.equal(put.status, 200)
    const t0 = Date.now()
    for (let s = await state(); s.bridge.state !== 'ok' || s.jobs.length !== 1; s = await state()) {
      if (Date.now() - t0 > 15000) throw new Error('the jobs never loaded')
      await new Promise((r) => setTimeout(r, 100))
    }
  } finally { await m.close(); await fake?.close() }
})
