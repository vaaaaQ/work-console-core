import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Bus } from '../events.ts'
import type { Ev } from '../events.ts'
import type { WsConfig } from '../workspace.ts'
import { startFakeCdp } from '../browser/fake-cdp.ts'
import type { FakeCdp, FakeTab } from '../browser/fake-cdp.ts'
import type { Browser, BrowserStatus } from '../browser/launcher.ts'
import type { GrantsFn, PackGrants } from '../browser/packs.ts'
import type { StateDocs } from '../browser/state.ts'
import { isLocal, localSource } from './local.ts'
import type { LocalSource } from './local.ts'

const FIXTURE_PACKS = join(import.meta.dirname, '..', 'browser', 'testdata', 'packs')
const CFG = { gatewayUrl: 'http://127.0.0.1:1', consoleTokenPath: '', llmTokenPath: '', workDir: '', runTools: [], teamTz: null, maxSessions: 1 } as WsConfig

const work = (id: string, title = 'one') => ({ id, type: 'Task', title, state: 'Active', assignedTo: null, changedAt: '2026-10-08T10:00:00Z', link: `https://board.example/acme/${id}` })
const mail = (id: string) => ({
  id, folder: 'Inbox', from: 'a@mail.example', to: [], cc: [], subject: 's', at: '2026-10-08T10:00:00Z', unread: true, preview: 'p',
  category: 'reply', myReply: false, conversationId: 'c', link: `https://mail.example/m/${id}`,
})
const chat = (id: string) => ({ id, name: id, kind: 'group', unread: 0, lastAt: '2026-10-08T10:00:00Z', lastFrom: null, lastPreview: null, link: `https://mail.example/c/${id}`, mentioned: false })

const grants = (o: Partial<PackGrants> = {}): GrantsFn => () => ({ packs: ['fixture'], hosts: ['board.example', 'mail.example'], config: { fixture: { org: 'acme' } }, ...o })
const memDocs = (): StateDocs => ({ load: async () => ({ docs: {}, seq: 0 }), put: async () => {}, seq: async () => {} })
const plain = (v: unknown) => JSON.parse(JSON.stringify(v))
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms))
const until = async (f: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (f()) return; await sleep(10) }
  assert.fail('timed out')
}

/** a browser that is whatever the test says, on the fake CDP */
function stubBrowser(cdp: FakeCdp, initial: BrowserStatus = { state: 'up' }) {
  let st = initial, starts = 0, stops = 0
  const subs = new Set<(s: BrowserStatus) => void>()
  const b: Browser = {
    endpoint: () => (st.state === 'up' ? cdp.url : null), status: () => st,
    start: async () => { starts++ }, stop: async () => { stops++ },
    onChange: (f) => { subs.add(f); return () => { subs.delete(f) } },
  }
  return { b, set(s: BrowserStatus) { st = s; for (const f of subs) f(s) }, counts: () => ({ starts, stops }) }
}

let cdp: FakeCdp, board: FakeTab
const live: LocalSource[] = []
before(async () => { cdp = await startFakeCdp() })
after(async () => { await cdp.close() })
beforeEach(async () => {
  for (const s of live.splice(0)) s.stop()
  for (const t of [...cdp.tabs]) cdp.closeTab(t.id)
  cdp.activated.length = 0
  board = cdp.addTab('https://board.example/acme/core', { DATA: { work: [work('W-1')] } })
  cdp.addTab('https://mail.example/inbox', { DATA: { mail: [mail('m1')], chat: [chat('c1')] } })
})

function make(o: { grants?: GrantsFn; browser?: BrowserStatus; tickMs?: number } = {}) {
  const bus = new Bus(), events: Ev[] = []
  bus.on((e) => events.push(e))
  const br = stubBrowser(cdp, o.browser)
  const src = localSource(CFG, {
    bus, ws: 'w', grants: o.grants ?? grants(), docs: memDocs(), browser: br.b, packsDir: FIXTURE_PACKS, tickMs: o.tickMs ?? 20,
    runtime: { evalMs: 500, actMs: 500, settleMs: 10 },
  })
  live.push(src)
  src.start()
  return { src, events, br }
}
const sources = (events: Ev[], concept: string) => events.filter((e): e is Extract<Ev, { kind: 'source' }> => e.kind === 'source' && e.concept === concept)
const reads = (t: FakeTab) => plain(t.ctx.CALLS ?? []).filter((c: { verb: string }) => c.verb === 'read')

test('with no packs B is available, start emits bridge ok, and the browser is never started', async () => {
  const { src, events, br } = make({ grants: grants({ packs: [] }) })
  await until(() => src.available())
  assert.ok(isLocal(src))
  assert.ok(events.some((e) => e.kind === 'bridge' && e.state === 'ok'))
  assert.equal(src.concepts().jobs, 'ready')
  assert.equal(br.counts().starts, 0)
})

test("a read of work gives the tab's items with a rev, waiting for the first poll", async () => {
  board.ctx.MODE = { work: async () => { await sleep(100); return null } }
  const { src } = make()
  const r = (await src.read(['work'])).work
  assert.deepEqual(plain(r), { status: 'ok', rev: 1, items: [work('W-1')] })
  assert.equal(src.concepts().work, 'ready')
})

test('a changed tab dataset is a source delta on the next poll', async () => {
  const { src, events } = make()
  await src.read(['work'])
  board.ctx.DATA = { work: [work('W-1', 'changed'), work('W-2')] }
  await until(() => sources(events, 'work').some((e) => e.upserts.length === 2))
  const d = sources(events, 'work').find((e) => e.upserts.length === 2)!
  assert.deepEqual(plain(d.upserts).map((u: { id: string; title: string }) => [u.id, u.title]), [['W-1', 'changed'], ['W-2', 'one']])
  assert.deepEqual(d.removes, [])
})

test('a tab answering unauthorized is signin_required with its host, and the status flags the tab', async () => {
  board.ctx.MODE = { work: { ok: false, code: 'unauthorized', message: 'GET /api → 401' } }
  const { src, events } = make()
  await until(() => src.concepts().work === 'signin_required')
  const r = (await src.read(['work'])).work as { status: string; host?: string }
  assert.deepEqual([r.status, r.host], ['signin_required', 'board.example'])
  assert.deepEqual(src.status().tabs.find((t) => t.key === 'fixture/board'), { key: 'fixture/board', host: 'board.example', signin: true })
  assert.equal(src.status().tabs.find((t) => t.key === 'fixture/mail')!.signin, false)
  assert.ok(events.some((e) => e.kind === 'bridge' && e.concepts.work === 'signin_required'))
})

test('an unavailable browser makes every pack concept source_unavailable with its reason, while B still works', async () => {
  const { src, br } = make({ browser: { state: 'unavailable', reason: 'no Edge found' } })
  await until(() => src.available())
  const r = (await src.read(['work', 'mail'])) as Record<string, { status: string; message?: string }>
  assert.deepEqual([r.work.status, r.mail.status], ['source_unavailable', 'source_unavailable'])
  assert.match(r.work.message!, /no Edge found/)
  assert.equal((await src.state('POST', '/api/state/put', { concept: 'jobs', id: 'J-0001', doc: { title: 'x' }, expectV: null })).status, 'ok')
  br.set({ state: 'up' })
  await until(() => src.concepts().work === 'ready')
  br.set({ state: 'unavailable', reason: 'Edge closed 3 times within 10 minutes' })
  assert.match(((await src.read(['work'])).work as { message: string }).message, /closed 3 times/)
  assert.equal((await src.get('work', 'W-1')).status, 'source_unavailable')
})

test('a get answers the pack, checked by its schema, and the next read watches the id', async () => {
  board.ctx.GETS = { work: { 'W-9': { description: 'd', comments: [] } } }
  const { src } = make()
  await src.read(['work'])
  assert.deepEqual(plain(await src.get('work', 'W-9')), { status: 'ok', rev: 1, items: { description: 'd', comments: [] } })
  const n = reads(board).length
  await until(() => reads(board).length > n)
  assert.deepEqual(reads(board).at(-1).watch, { work: ['W-9'] })
  assert.equal((await src.get('work', 'W-404')).status, 'not_found')
  board.ctx.GETS = { work: { 'W-8': { description: 'd', comments: [], extra: 1 } } }
  assert.equal((await src.get('work', 'W-8')).status, 'source_error')
})

test('an act runs in its tab, answers ok with the result, and re-reads its concept at once', async () => {
  const { src, events } = make({ tickMs: 60_000 })
  await src.read(['work'])
  board.ctx.DATA = { work: [work('W-1'), work('W-3')] }
  const r = await src.act({ action: 'work.comment', actionId: 'a1', args: { id: 'W-1', text: 'hi' } })
  assert.deepEqual(plain(r), { status: 'ok', result: { done: 'work.comment' } })
  assert.deepEqual(plain(board.ctx.ACTS)[0].args, { id: 'W-1', text: 'hi' })
  await until(() => sources(events, 'work').some((e) => e.upserts.some((u) => (u as { id: string }).id === 'W-3')))
})

test('an action no pack declares, or one the grants leave out, is unknown_action', async () => {
  const { src } = make()
  assert.equal((await src.act({ action: 'mail.send', actionId: 'a1', args: {} })).error?.code, 'unknown_action')
  const narrow = make({ grants: grants({ acts: [] }) }).src
  assert.equal((await narrow.act({ action: 'work.comment', actionId: 'a2', args: {} })).error?.code, 'unknown_action')
  assert.equal(board.ctx.ACTS, undefined)
})

test('the same actionId twice runs once', async () => {
  const { src } = make()
  const a = { action: 'work.comment', actionId: 'same', args: { id: 'W-1', text: 'once' } }
  const [r1, r2] = await Promise.all([src.act(a), src.act(a)])
  assert.deepEqual(plain(r1), plain(r2))
  assert.deepEqual(plain(await src.act(a)), plain(r1))
  assert.equal(plain(board.ctx.ACTS).length, 1)
})

test('an act refused before it ran can run again under the same actionId', async () => {
  const { src, br } = make({ browser: { state: 'unavailable', reason: 'Edge is closed' } })
  const a = { action: 'work.comment', actionId: 'retry', args: { id: 'W-1', text: 'later' } }
  assert.equal((await src.act(a)).error?.code, 'source_unavailable')
  br.set({ state: 'up' })
  assert.equal((await src.act(a)).status, 'ok')
  assert.equal(plain(board.ctx.ACTS).length, 1)
})

test('B: put and new-job-id round trip; anything else is bad_request', async () => {
  const { src } = make({ grants: grants({ packs: [] }) })
  await until(() => src.available())
  assert.equal((await src.state('POST', '/api/state/put', { concept: 'jobs', id: 'J-0001', doc: { title: 'x' }, expectV: null })).status, 'ok')
  assert.equal((await src.state('POST', '/api/state/put', { concept: 'jobs', id: 'J-0001', doc: { title: 'y' }, expectV: null })).status, 'conflict')
  assert.deepEqual((await src.state('POST', '/api/state/new-job-id', {})).items, { id: 'J-0002' })
  assert.equal((await src.state('GET', '/api/state/other')).status, 'bad_request')
  const r = (await src.read(['jobs'])).jobs as { items: { id: string }[] }
  assert.deepEqual(r.items.map((d) => d.id), ['J-0001'])
  assert.deepEqual(plain(await src.get('jobs', 'J-0001')).items.title, 'x')
})

test("a mark's done and job join into mail, a job's chat into chat, and each change resets them", async () => {
  const { src, events } = make()
  await src.read(['mail', 'chat'])
  const put = (concept: string, id: string, doc: Record<string, unknown>) => src.state('POST', '/api/state/put', { concept, id, doc, expectV: null })
  await put('marks', 'm1', { done: true, job: 'J-0001' })
  assert.ok(sources(events, 'mail').some((e) => e.reset) && sources(events, 'chat').some((e) => e.reset))
  await put('jobs', 'J-0001', { chat: 'c1' })
  const r = (await src.read(['mail', 'chat'])) as Record<string, { items: Record<string, unknown>[] }>
  assert.deepEqual([r.mail.items[0].done, r.mail.items[0].job], [true, 'J-0001'])
  assert.deepEqual(r.chat.items[0].jobs, ['J-0001'])
  assert.ok(sources(events, 'jobs').some((e) => e.upserts.length === 1))
})

test('grants with no packs never start the browser; grants with packs start it once', async () => {
  const none = make({ grants: grants({ packs: [] }) })
  const some = make()
  await until(() => some.src.concepts().work === 'ready')
  assert.deepEqual([none.br.counts().starts, some.br.counts().starts], [0, 1])
  some.src.stop()
  assert.equal(some.br.counts().stops, 1)
})

test('front brings the tab of a host forward; an unknown host is refused', async () => {
  const { src } = make()
  await src.read(['work'])
  await src.front('board.example')
  assert.deepEqual(cdp.activated, [board.id])
  await assert.rejects(src.front('elsewhere.example'), /no tab/)
})

test('a pack whose hosts are not all granted does not load: its concepts answer source_error naming the host, and no tab opens', async () => {
  const { src } = make({ grants: grants({ hosts: ['board.example'] }) })
  await until(() => src.available())
  const r = (await src.read(['work'])).work as { status: string; message: string }
  assert.equal(r.status, 'source_error')
  assert.match(r.message, /mail\.example is not granted/)
  assert.match(src.status().packs.fixture, /not granted/)
  assert.equal(cdp.tabs.length, 2)
  assert.equal(reads(board).length, 0)
})
