import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PB0 } from '../../src/data/playbooks.ts'
import type { Job, Playbook, Tpl } from '../../src/model/types.ts'
import { BridgeClient } from '../bridge/client.ts'
import { startFakeGateway } from '../bridge/fake.ts'
import { GatewayError } from '../bridge/wire.ts'
import { Bus } from '../events.ts'
import { demoFake, demoSeed } from '../testkit.ts'
import { bridgeStore } from './bridge.ts'
import { Conflict } from './port.ts'

async function setup(prefix = 'J') {
  const fake = await startFakeGateway({ statusMs: 50, seed: demoFake() })
  const bus = new Bus()
  const client = new BridgeClient({ url: fake.url, token: () => fake.token, bus, backoff: [30, 60] })
  const store = bridgeStore({ bridge: client, bus, playbooks: PB0, prefix })
  client.start()
  await until(() => client.available())
  const stop = async () => { client.stop(); await fake.close() }
  return { fake, bus, client, store, stop }
}
async function until(f: () => boolean | Promise<boolean>, ms = 3000) {
  const t0 = Date.now()
  while (!(await f())) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 10)) }
}
const newJob = (id = 'J-0001', t = 'Test job'): Job => ({ ...structuredClone(demoSeed().jobs![0]), id, t, v: undefined })
const put = async (url: string, token: string, b: unknown) => {
  const r = await fetch(`${url}/api/state/put`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(b) })
  return { status: r.status, body: await r.json() as any }
}

test('a new job is stored at v1 and read back', async () => {
  const { store, stop } = await setup()
  try {
    const saved = await store.putJob(newJob(), null)
    assert.equal(saved.v, 1)
    assert.equal((await store.job('J-0001'))?.t, 'Test job')
    assert.deepEqual((await store.jobs()).map((j) => j.id), ['J-0001'])
    assert.equal('updated' in saved, false, 'B bookkeeping stays out of the Job')
  } finally { await stop() }
})

test('two writers on one job: one wins, the other conflicts', async () => {
  const { store, stop } = await setup()
  try {
    await store.putJob(newJob(), null)
    const [a, b] = await Promise.allSettled([store.putJob(newJob('J-0001', 'a'), 1), store.putJob(newJob('J-0001', 'b'), 1)])
    const won = [a, b].filter((x) => x.status === 'fulfilled'), lost = [a, b].filter((x) => x.status === 'rejected')
    assert.equal(won.length, 1); assert.equal(lost.length, 1)
    const e = (lost[0] as PromiseRejectedResult).reason
    assert.ok(e instanceof Conflict, 'the loser gets Conflict, not a silent overwrite')
    assert.equal(e.current?.v, 2)
    assert.equal((await store.job('J-0001'))?.v, 2)
  } finally { await stop() }
})

test("another writer's change reaches the store by delta", async () => {
  const { fake, store, stop } = await setup()
  try {
    await store.putJob(newJob(), null)
    const r = await put(fake.url, fake.token, { concept: 'jobs', id: 'J-0001', doc: { ...newJob(), t: 'from elsewhere' }, expectV: 1 })
    assert.equal(r.body.status, 'ok')
    await until(async () => (await store.job('J-0001'))?.t === 'from elsewhere')
  } finally { await stop() }
})

test('a late delta never takes a job back to an older v', async () => {
  const { fake, store, stop } = await setup()
  try {
    const v1 = await store.putJob(newJob(), null)
    await store.putJob({ ...v1, t: 'second' }, 1)
    fake.emitDelta({ concept: 'jobs', upserts: [{ ...v1, id: 'J-0001', t: 'stale' } as never] })
    await new Promise((r) => setTimeout(r, 100))
    assert.equal((await store.job('J-0001'))?.t, 'second')
  } finally { await stop() }
})

test('marks merge, and mail comes back joined from the bridge', async () => {
  const { fake, store, stop } = await setup()
  try {
    const snap = async () => (await (await fetch(`${fake.url}/api/snapshot?concepts=mail`, { headers: { authorization: `Bearer ${fake.token}` } })).json()) as any
    const id = (await snap()).concepts.mail.items[0].id as string
    await store.putMark(id, { done: true })
    await store.putMark(id, { job: 'J-0001' })
    assert.deepEqual((await store.marks())[id], { done: true, job: 'J-0001' })
    const mail = (await snap()).concepts.mail.items.find((m: { id: string }) => m.id === id)
    assert.equal(mail.done, true); assert.equal(mail.job, 'J-0001')
  } finally { await stop() }
})

test('a chat mark hides its thread from the snapshot and its deletion brings it back', async () => {
  const { fake, store, stop } = await setup()
  try {
    const chats = async () => ((await (await fetch(`${fake.url}/api/snapshot?concepts=chat`, { headers: { authorization: `Bearer ${fake.token}` } })).json()) as any).concepts.chat.items.map((c: { id: string }) => c.id)
    await store.putMark('chat:c1', { hidden: true, name: 'Team Dev' })
    assert.deepEqual((await store.marks())['chat:c1'], { hidden: true, name: 'Team Dev' })
    assert.ok(!(await chats()).includes('c1'))
    await store.putMark('chat:c1', null)
    await store.putMark('chat:none', null)
    assert.equal((await store.marks())['chat:c1'], undefined)
    assert.ok((await chats()).includes('c1'))
  } finally { await stop() }
})

test('a deleted built-in playbook stays deleted; an added one comes and goes', async () => {
  const { store, stop } = await setup()
  try {
    const builtin = Object.keys(PB0)[0]
    await store.putPlaybook(builtin, null)
    assert.equal(builtin in (await store.playbooks()), false)
    const mine: Playbook = { ...structuredClone(PB0[builtin]), n: 'Mine', custom: 1 }
    await store.putPlaybook('mine', mine)
    assert.equal((await store.playbooks()).mine.n, 'Mine')
    await store.putPlaybook('mine', null)
    assert.equal('mine' in (await store.playbooks()), false)
    assert.equal(Object.keys(await store.playbooks()).length, Object.keys(PB0).length - 1)
  } finally { await stop() }
})

test("an added playbook's planned messages are kept with it, read back by a new store, and go with it", async () => {
  const { store, client, bus, stop } = await setup()
  try {
    const mine: Playbook = { ...structuredClone(PB0[Object.keys(PB0)[0]]), n: 'Mine', custom: 1 }
    const tpl: Record<string, Tpl[]> = { 'mine/tell': [['chat', 'team chat', 'hi all, {key} is done.']] }
    await store.putPlaybook('mine', mine, tpl)
    assert.deepEqual(await store.templates(), tpl)
    // the client's cache catches up by the delta, as with an edit from elsewhere
    const anew = () => bridgeStore({ bridge: client, bus, playbooks: PB0, prefix: 'J' }).templates()
    await until(async () => 'mine/tell' in (await anew()))
    assert.deepEqual(await anew(), tpl, 'a store made anew reads them from B')
    await store.putPlaybook('mine', mine)
    assert.deepEqual(await store.templates(), {}, 'a save without them drops them')
    await store.putPlaybook('mine', mine, tpl)
    await store.putPlaybook('mine', null)
    assert.deepEqual(await store.templates(), {})
  } finally { await stop() }
})

test('runs are stored and replaced by id', async () => {
  const { store, stop } = await setup()
  try {
    const r = { id: 'r-1', job: 'J-0001', step: 's1', q: 'go', state: 'queued' as const, at: new Date().toISOString() }
    await store.putRun(r)
    await store.putRun({ ...r, state: 'running' })
    assert.deepEqual(await store.runs(), [{ ...r, state: 'running' }])
  } finally { await stop() }
})

test('next job ids never repeat; prefix J keeps the gateway ids as they are', async () => {
  const { store, stop } = await setup('J')
  try {
    assert.deepEqual([await store.nextJobId(), await store.nextJobId()], ['J-0001', 'J-0002'])
  } finally { await stop() }
})

test("the gateway's J-NNNN comes back under the workspace prefix, its digits kept", async () => {
  const { store, stop } = await setup('B')
  try {
    assert.deepEqual([await store.nextJobId(), await store.nextJobId()], ['B-0001', 'B-0002'])
  } finally { await stop() }
})

test('a gateway id that is not J-NNNN is an error naming it, never a job id', async () => {
  const bridge = { read: async () => ({}), state: async () => ({ status: 'ok', rev: 1, items: { id: 'X-1' } }) }
  const store = bridgeStore({ bridge, bus: new Bus(), playbooks: PB0, prefix: 'B' })
  await assert.rejects(store.nextJobId(), (e: unknown) => e instanceof GatewayError && e.status === 502 && /X-1/.test(e.message))
})

test('while the workplace is away, reads and writes fail with 503', async () => {
  const { fake, client, store, stop } = await setup()
  try {
    fake.setDown(true)
    await until(() => !client.available())
    await assert.rejects(store.jobs(), (e: unknown) => e instanceof GatewayError && e.status === 503)
    await assert.rejects(store.putJob(newJob(), null), (e: unknown) => e instanceof GatewayError && e.status === 503)
    fake.setDown(false)
    await until(() => client.available())
    assert.deepEqual(await store.jobs(), [])
  } finally { await stop() }
})

test('a write the bridge never confirms is outcome_unknown, not a failure', async () => {
  const silent = createServer(() => { /* never answers */ })
  await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r))
  const client = new BridgeClient({ url: `http://127.0.0.1:${(silent.address() as AddressInfo).port}`, token: () => 't', bus: new Bus(), stateMs: 100 })
  try {
    await assert.rejects(client.state('POST', '/api/state/put', { concept: 'jobs', id: 'J-0001', doc: {}, expectV: null }),
      (e: unknown) => e instanceof GatewayError && e.code === 'outcome_unknown' && e.status === 503)
  } finally { silent.closeAllConnections(); await new Promise((r) => silent.close(r)) }
})

test('the fake refuses the llm token on the console-only state routes', async () => {
  const fake = await startFakeGateway()
  try {
    for (const path of ['/api/state/put', '/api/state/new-job-id']) {
      const r = await fetch(fake.url + path, { method: 'POST', headers: { authorization: `Bearer ${fake.llmToken}`, 'content-type': 'application/json' }, body: '{}' })
      assert.equal(r.status, 403, path)
    }
  } finally { await fake.close() }
})
