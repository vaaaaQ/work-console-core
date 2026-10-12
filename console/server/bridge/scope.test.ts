import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Bus } from '../events.ts'
import type { Ev } from '../events.ts'
import type { WsConfig } from '../workspace.ts'
import { startFakeCdp } from '../browser/fake-cdp.ts'
import type { FakeCdp, FakeTab } from '../browser/fake-cdp.ts'
import type { Browser } from '../browser/launcher.ts'
import type { GrantsFn, PackGrants } from '../browser/packs.ts'
import type { StateDocs } from '../browser/state.ts'
import { localSource } from './local.ts'
import type { LocalSource } from './local.ts'

/* A pack that declares a scope gets only the ids its workspace lists: the console filters what it reads, refuses a get
   and an act outside them, and tells the pack the list. The pack (a test stand-in) ignores it, so these see the console's own check. */

const FIXTURE_PACKS = join(import.meta.dirname, '..', 'browser', 'testdata', 'packs')
const CFG = { gatewayUrl: 'http://127.0.0.1:1', consoleTokenPath: '', llmTokenPath: '', workDir: '', runTools: [], teamTz: null, maxSessions: 1 } as WsConfig

const chat = (id: string) => ({ id, name: `chat ${id}`, kind: 'group', unread: 0, lastAt: '2026-10-08T10:00:00Z', lastFrom: null, lastPreview: null, link: `https://mail.example/c/${id}`, mentioned: false })
const mail = (id: string) => ({
  id, folder: 'Inbox', from: 'a@mail.example', to: [], cc: [], subject: 's', at: '2026-10-08T10:00:00Z', unread: true, preview: 'p',
  category: 'reply', myReply: false, conversationId: 'c', link: `https://mail.example/m/${id}`,
})
const thread = { messages: [{ id: '1', author: 'Dan', authorKind: 'person', at: '2026-10-08T10:00:00Z', text: 'hi' }], cursor: null }

const grants = (o: Partial<PackGrants> = {}): GrantsFn => () => ({ packs: ['scoped'], hosts: ['mail.example'], config: {}, scopes: { scoped: ['-100'] }, ...o })
const memDocs = (): StateDocs => ({ load: async () => ({ docs: {}, seq: 0 }), put: async () => {}, seq: async () => {} })
const plain = (v: unknown) => JSON.parse(JSON.stringify(v))
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms))
const until = async (f: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (f()) return; await sleep(10) }
  assert.fail('timed out')
}

let cdp: FakeCdp, tab: FakeTab
const live: LocalSource[] = []
before(async () => { cdp = await startFakeCdp() })
after(async () => { for (const s of live.splice(0)) s.stop(); await cdp.close() })
beforeEach(() => {
  for (const s of live.splice(0)) s.stop()
  for (const t of [...cdp.tabs]) cdp.closeTab(t.id)
  tab = cdp.addTab('https://mail.example/inbox', {
    DATA: { chat: [chat('-100'), chat('-200')], mail: [mail('m1')] },
    GETS: { chat: { '-100': thread, '-200': thread } },
  })
})

function make(g: GrantsFn = grants()) {
  const bus = new Bus(), events: Ev[] = []
  bus.on((e) => events.push(e))
  const b: Browser = { endpoint: () => cdp.url, status: () => ({ state: 'up' }), start: async () => {}, stop: async () => {}, onChange: () => () => {} }
  const src = localSource(CFG, { bus, ws: 'w', grants: g, docs: memDocs(), browser: b, packsDir: FIXTURE_PACKS, tickMs: 20, runtime: { evalMs: 500, actMs: 500, settleMs: 10 } })
  live.push(src)
  src.start()
  return { src, events }
}
const calls = (verb: string) => plain(tab.ctx.CALLS ?? []).filter((c: { verb: string }) => c.verb === verb)
const acts = () => plain(tab.ctx.ACTS ?? [])
const ids = (r: { items?: unknown }) => (r.items as { id: string }[]).map((x) => x.id)

test('read: a scoped concept gives only the allowed ids, and its deltas carry nothing else', async () => {
  const { src, events } = make()
  const r = (await src.read(['chat'])).chat
  assert.equal(r.status, 'ok')
  assert.deepEqual(ids(r), ['-100'])
  await until(() => events.some((e) => e.kind === 'source' && e.concept === 'chat'))
  const seen = events.flatMap((e) => (e.kind === 'source' && e.concept === 'chat' ? e.upserts.map((u) => (u as { id: string }).id) : []))
  assert.ok(!seen.includes('-200'), 'the denied chat never reaches the bus')
})

test('read: the pack is told the allowed ids of a scoped concept, and an unscoped concept is neither told nor filtered', async () => {
  const { src } = make()
  await src.read(['chat', 'mail'])
  const r = calls('read')
  assert.deepEqual(r.find((c: { concept: string }) => c.concept === 'chat').scope, ['-100'])
  assert.ok(!('scope' in r.find((c: { concept: string }) => c.concept === 'mail')))
  assert.deepEqual(ids((await src.read(['mail'])).mail), ['m1'])
})

test('read: a scoped pack with no scope granted reads nothing, whatever the tab has', async () => {
  const { src } = make(grants({ scopes: {} }))
  const r = (await src.read(['chat'])).chat
  assert.equal(r.status, 'ok')
  assert.deepEqual(ids(r), [])
  assert.deepEqual(calls('read').find((c: { concept: string }) => c.concept === 'chat').scope, [])
})

test('get: an allowed id answers the pack; a denied one is out_of_scope and never reaches the pack', async () => {
  const { src } = make()
  const ok = await src.get('chat', '-100')
  assert.deepEqual(plain(ok.items), thread)
  const no = await src.get('chat', '-200')
  assert.equal(no.status, 'out_of_scope')
  assert.match(no.message!, /-200/)
  assert.deepEqual(calls('get').map((c: { id: string }) => c.id), ['-100'])
  assert.deepEqual(calls('get')[0].scope, ['-100'])
})

test('get: with no scope granted every id is out_of_scope', async () => {
  const { src } = make(grants({ scopes: undefined }))
  assert.equal((await src.get('chat', '-100')).status, 'out_of_scope')
  assert.deepEqual(calls('get'), [])
})

test('act: an allowed target runs, and the pack is told the allowed ids', async () => {
  const { src } = make()
  const r = await src.act({ action: 'chat.post', actionId: 'a1', args: { chat: '-100', text: 'hi' } })
  assert.equal(r.status, 'ok')
  assert.deepEqual(acts().map((a: { args: unknown; scope: unknown }) => [a.args, a.scope]), [[{ chat: '-100', text: 'hi' }, ['-100']]])
})

test('act: a denied, missing or non-string target is out_of_scope and never reaches the pack', async () => {
  const { src } = make()
  for (const [id, args] of [['a1', { chat: '-200', text: 'hi' }], ['a2', { text: 'hi' }], ['a3', { chat: ['-100'], text: 'hi' }], ['a4', { chat: -100, text: 'hi' }]] as const) {
    const r = await src.act({ action: 'chat.post', actionId: id, args: { ...args } })
    assert.equal(r.status, 'error', id)
    assert.equal(r.error!.code, 'out_of_scope', id)
  }
  assert.deepEqual(acts(), [])
})

test('act: with no scope granted a scoped action runs nowhere', async () => {
  const { src } = make(grants({ scopes: { other: ['-100'] } }))
  const r = await src.act({ action: 'chat.post', actionId: 'a1', args: { chat: '-100', text: 'hi' } })
  assert.equal(r.error?.code, 'out_of_scope')
  assert.deepEqual(acts(), [])
})

test('act: an unscoped action of a scoped pack runs as before', async () => {
  const { src } = make()
  const r = await src.act({ action: 'mail.send', actionId: 'a1', args: { to: ['x@mail.example'], subject: 's', text: 't' } })
  assert.equal(r.status, 'ok')
  assert.equal(acts().length, 1)
  assert.ok(!('scope' in acts()[0]))
})

test('the scope check comes after the acts check: an action the grants leave out is unknown_action, whatever its target', async () => {
  const { src } = make(grants({ acts: ['mail.send'] }))
  const r = await src.act({ action: 'chat.post', actionId: 'a1', args: { chat: '-100', text: 'hi' } })
  assert.equal(r.error?.code, 'unknown_action')
})
