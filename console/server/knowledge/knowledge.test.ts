import '../testkit.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BridgeClient } from '../bridge/client.ts'
import { startFakeGateway } from '../bridge/fake.ts'
import { GatewayError } from '../bridge/wire.ts'
import { Bus } from '../events.ts'
import { HttpError } from '../events.ts'
import { knowledge, noteIn } from './knowledge.ts'

async function setup() {
  const fake = await startFakeGateway({ statusMs: 50 })
  const client = new BridgeClient({ url: fake.url, token: () => fake.token, bus: new Bus(), backoff: [30, 60] })
  client.start()
  await until(() => client.available())
  const propose = async (b: Record<string, unknown>) => {
    const r = await fetch(`${fake.url}/api/knowledge/propose`, { method: 'POST', headers: { authorization: `Bearer ${fake.llmToken}`, 'content-type': 'application/json' }, body: JSON.stringify(b) })
    return ((await r.json()) as { items: { doc: { id: string } } }).items.doc
  }
  return { fake, client, kn: knowledge(client), propose, stop: async () => { client.stop(); await fake.close() } }
}
async function until(f: () => boolean | Promise<boolean>, ms = 3000) {
  const t0 = Date.now()
  while (!(await f())) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 10)) }
}

test('a note written by hand is listed, read, found and edited', async () => {
  const { kn, stop } = await setup()
  try {
    const n = await kn.save(null, { title: 'Where the CLIs live', tags: ['machine'], text: 'sqlcmd is on PATH; git is the VS one' }, null)
    assert.equal(n.id, 'where-the-clis-live'); assert.equal(n.v, 1)
    await until(async () => (await kn.list()).length === 1)
    assert.deepEqual((await kn.list()).map((x) => [x.id, x.title]), [['where-the-clis-live', 'Where the CLIs live']])
    assert.equal((await kn.read(n.id)).text, 'sqlcmd is on PATH; git is the VS one')
    assert.deepEqual((await kn.search('sqlcmd', [])).map((h) => h.id), [n.id])
    assert.deepEqual(await kn.search('nothing-like-it', []), [])
    const e = await kn.save(n.id, { title: n.title, tags: ['machine'], text: 'psql via the bastion host' }, 1)
    assert.equal(e.v, 2)
  } finally { await stop() }
})

test('an edit on an old v is a conflict; a new note under a taken title is too', async () => {
  const { kn, stop } = await setup()
  try {
    const n = await kn.save(null, { title: 'VPN', tags: [], text: 'a' }, null)
    await kn.save(n.id, { title: 'VPN', tags: [], text: 'b' }, 1)
    await assert.rejects(kn.save(n.id, { title: 'VPN', tags: [], text: 'c' }, 1), (e: unknown) => e instanceof GatewayError && e.status === 409)
    await assert.rejects(kn.save(null, { title: 'VPN', tags: [], text: 'd' }, null), (e: unknown) => e instanceof GatewayError && e.status === 409)
    await assert.rejects(kn.read('no-such-note'), (e: unknown) => e instanceof GatewayError && e.status === 404)
  } finally { await stop() }
})

test('a proposal is listed, accepted with an edit, and leaves the list', async () => {
  const { kn, propose, stop } = await setup()
  try {
    const p = await propose({ title: 'Sleeping tabs', tags: ['edge'], text: 'freeze fetch', reason: 'seen twice' })
    await until(async () => (await kn.proposals()).length === 1)
    const got = (await kn.proposals())[0]
    assert.equal(got.by, 'llm'); assert.equal(got.reason, 'seen twice')
    const n = await kn.decide(p.id, true, 'Sleeping tabs freeze fetch; set the lifecycle state active first')
    assert.equal(n?.text, 'Sleeping tabs freeze fetch; set the lifecycle state active first')
    await until(async () => (await kn.proposals()).length === 0)
    const q = await propose({ title: 'Wrong', text: 'x', reason: 'guess' })
    assert.equal(await kn.decide(q.id, false), null)
  } finally { await stop() }
})

test('a change proposed against an old v cannot be accepted', async () => {
  const { kn, propose, stop } = await setup()
  try {
    const n = await kn.save(null, { title: 'Stand-up', tags: [], text: '09:30' }, null)
    const p = await propose({ note: n.id, title: 'Stand-up', text: '09:30, Zoom', reason: 'more precise' })
    await kn.save(n.id, { title: 'Stand-up', tags: [], text: 'moved' }, 1)
    await assert.rejects(kn.decide(p.id, true), (e: unknown) => e instanceof GatewayError && e.status === 409)
  } finally { await stop() }
})

test('while the workplace is away every call is 503', async () => {
  const { fake, client, kn, stop } = await setup()
  try {
    fake.setDown(true)
    await until(() => !client.available())
    for (const call of [() => kn.list(), () => kn.search('x', []), () => kn.proposals(), () => kn.save(null, { title: 't', tags: [], text: 'x' }, null)])
      await assert.rejects(call, (e: unknown) => e instanceof GatewayError && e.status === 503)
  } finally { await stop() }
})

test('noteIn wants a title and a text and keeps only string tags', () => {
  assert.deepEqual(noteIn({ title: ' T ', tags: ['a', 3, ' b ', ''], text: 'x' }), { title: 'T', tags: ['a', 'b'], text: 'x' })
  assert.throws(() => noteIn({ title: '', text: 'x' }), (e: unknown) => e instanceof HttpError && e.status === 400)
  assert.throws(() => noteIn({ title: 'T' }), (e: unknown) => e instanceof HttpError && e.status === 400)
})
