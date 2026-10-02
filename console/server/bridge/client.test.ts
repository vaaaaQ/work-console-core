import { demoFake } from '../testkit.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Bus, HttpError } from '../events.ts'
import type { Ev } from '../events.ts'
import { resolveAct } from './actions.ts'
import { BridgeClient } from './client.ts'
import { startFakeGateway } from './fake.ts'
import { GatewayError } from './wire.ts'

async function setup(o: { statusMs?: number; staleMs?: number } = {}) {
  const fake = await startFakeGateway({ statusMs: o.statusMs ?? 50, seed: demoFake() })
  const bus = new Bus(), evs: Ev[] = []
  bus.on((e) => evs.push(e))
  const client = new BridgeClient({ url: fake.url, token: () => fake.token, bus, backoff: [30, 60], staleMs: o.staleMs })
  const stop = async () => { client.stop(); await fake.close() }
  return { fake, bus, evs, client, stop }
}
async function until(f: () => boolean, ms = 3000) {
  const t0 = Date.now()
  while (!f()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 10)) }
}
const bridgeStates = (evs: Ev[]) => evs.filter((e) => e.kind === 'bridge').map((e) => (e as { state: string }).state)

test('a status on the stream makes the bridge available, once', async () => {
  const { client, evs, stop } = await setup()
  assert.equal(client.available(), false)
  client.start()
  await until(() => client.available())
  await new Promise((r) => setTimeout(r, 150))
  assert.deepEqual(bridgeStates(evs), ['ok'])
  assert.equal(client.concepts().chat, 'ready')
  await stop()
})

test('the gateway going away makes it unavailable; it comes back on its own', async () => {
  const { client, fake, evs, stop } = await setup()
  client.start()
  await until(() => client.available())
  fake.setDown(true)
  await until(() => !client.available())
  await assert.rejects(client.snapshot(['chat']), (e: unknown) => e instanceof GatewayError && e.status === 503)
  fake.setDown(false)
  await until(() => client.available())
  assert.deepEqual(bridgeStates(evs), ['ok', 'unavailable', 'ok'])
  await stop()
})

test('every source unavailable counts as the bridge unavailable', async () => {
  const { client, fake, stop } = await setup()
  client.start()
  await until(() => client.available())
  // B's concepts count as sources too
  for (const k of ['chat', 'mail', 'cal', 'work', 'board', 'review', 'time', 'jobs', 'runs', 'playbooks', 'marks', 'notes', 'proposals']) fake.setSource(k, 'source_unavailable')
  fake.pushStatus()
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(client.available(), true, 'ci still answers')
  fake.setSource('ci', 'signin_required'); fake.pushStatus()
  await until(() => !client.available())
  fake.setSource('chat', null); fake.pushStatus()
  await until(() => client.available())
  await stop()
})

test('a silent stream is dropped after staleMs and reconnected', async () => {
  const { client, evs, stop } = await setup({ statusMs: 100000, staleMs: 150 })
  client.start()
  await until(() => client.available())
  await until(() => bridgeStates(evs).length >= 3)
  assert.deepEqual(bridgeStates(evs).slice(0, 3), ['ok', 'unavailable', 'ok'])
  await stop()
})

test('a delta in order patches the cache and goes out as a source event', async () => {
  const { client, fake, evs, stop } = await setup()
  client.start()
  await until(() => client.available())
  const before = (await client.read(['chat'])).chat
  fake.emitDelta({ concept: 'chat', upserts: [{ id: 'c9', name: 'New chat', kind: 'direct', unread: 1 }], removes: ['c2'] })
  await until(() => evs.some((e) => e.kind === 'source'))
  const src = evs.find((e) => e.kind === 'source') as Extract<Ev, { kind: 'source' }>
  assert.deepEqual(src.removes, ['c2'])
  assert.equal(src.reset, undefined)
  const now = (await client.read(['chat'])).chat
  assert.equal(now.rev, before.rev! + 1)
  const ids = (now.items as { id: string }[]).map((i) => i.id)
  assert.ok(ids.includes('c9') && !ids.includes('c2'))
  await stop()
})

test('a rev gap re-reads the concept and tells the page to refetch', async () => {
  const { client, fake, evs, stop } = await setup()
  client.start()
  await until(() => client.available())
  await client.read(['chat'])
  fake.emitDelta({ concept: 'chat', upserts: [{ id: 'c8', name: 'Gap chat' }], fromRev: 41 })
  await until(() => evs.some((e) => e.kind === 'source' && e.reset))
  const ids = ((await client.read(['chat'])).chat.items as { id: string }[]).map((i) => i.id)
  assert.ok(ids.includes('c8'), 'the re-read snapshot has the item the gapped delta carried')
  await stop()
})

test('a resync delta re-reads the concept even when its rev is in order', async () => {
  const { client, fake, evs, stop } = await setup()
  client.start()
  await until(() => client.available())
  await client.read(['chat'])
  fake.emitDelta({ concept: 'chat', upserts: [{ id: 'c7', name: 'Too big to ship' }], resync: true })
  await until(() => evs.some((e) => e.kind === 'source' && e.reset))
  const ids = ((await client.read(['chat'])).chat.items as { id: string }[]).map((i) => i.id)
  assert.ok(ids.includes('c7'), 'the re-read snapshot has the change the resync delta left out')
  await stop()
})

test('acts: ok, unknown_action as an error, a bad token as a refusal', async () => {
  const { client, fake, stop } = await setup()
  assert.deepEqual(await client.act({ action: 'chat.post', actionId: 'a1', args: { chat: 'c1', text: 'hi' } }), { status: 'ok' })
  const r = await client.act({ action: 'nope', actionId: 'a2', args: {} })
  assert.equal(r.status, 'error'); assert.equal(r.error!.code, 'unknown_action')
  assert.equal(fake.acts.length, 2)
  const bad = new BridgeClient({ url: fake.url, token: () => 'wrong', bus: new Bus() })
  await assert.rejects(bad.act({ action: 'chat.post', actionId: 'a3', args: {} }), (e: unknown) => e instanceof GatewayError && e.code === 'unauthorized')
  const none = new BridgeClient({ url: fake.url, token: () => { throw new Error('ENOENT') }, bus: new Bus() })
  await assert.rejects(none.snapshot(['chat']), (e: unknown) => e instanceof GatewayError && e.code === 'bridge_unavailable')
  await stop()
})

test('time.fill returns what it filled and changes the time concept', async () => {
  const { client, evs, stop } = await setup()
  client.start()
  await until(() => client.available())
  type M = { id: string; state: string; emptyDays: string[] }
  const prev = ((await client.read(['time'])).time.items as M[])[1], first = `${prev.id}-01`
  const r = await client.act({ action: 'time.fill', actionId: 't1', args: { month: prev.id, days: [...prev.emptyDays, first], workItemId: 4230, activityId: 1343, hours: 8 } })
  assert.deepEqual(r, { status: 'ok', result: { month: prev.id, filled: prev.emptyDays, skipped: [first], failed: [] } })
  await until(() => evs.some((e) => e.kind === 'source' && e.concept === 'time'))
  const after = ((await client.read(['time'])).time.items as M[]).find((m) => m.id === prev.id)!
  assert.deepEqual([after.emptyDays, after.state], [[], 'entered'])
  await stop()
})

test('a get returns a chat thread and a mail body', async () => {
  const { client, stop } = await setup()
  const t = await client.get('chat', 'c1')
  assert.equal(t.status, 'ok')
  assert.equal((t.items as { messages: unknown[] }).messages.length, 3)
  const m = await client.get('mail', 'm2')
  assert.match((m.items as { body: string }).body, /Q3 usage/)
  assert.equal((await client.get('chat', 'nope')).status, 'source_error')
  await stop()
})

test('resolveAct: chat names become chat ids, an unknown name is refused, empty text is refused', async () => {
  const chats = async () => [{ id: '19:abc', name: 'Team Dev' }]
  assert.deepEqual((await resolveAct({ action: 'chat.post', actionId: 'x', args: { chatName: 'team  dev', text: 't' } }, chats)).args, { chat: '19:abc', text: 't' })
  await assert.rejects(resolveAct({ action: 'chat.post', args: { chatName: 'Gone', text: 't' } }, chats), (e: unknown) => e instanceof HttpError && e.code === 'unknown_chat')
  await assert.rejects(resolveAct({ action: 'chat.post', args: { chatName: 'Team Dev', text: '  ' } }, chats), (e: unknown) => e instanceof HttpError && e.code === 'bad_args')
  await assert.rejects(resolveAct({ action: 'rm -rf', args: {} }, chats), (e: unknown) => e instanceof HttpError && e.status === 400)
  assert.ok((await resolveAct({ action: 'work.comment', args: { id: 'ACME-512', text: 't' } }, chats)).actionId)
})
