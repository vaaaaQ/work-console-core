import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
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
import { tempDir } from '../testdirs.ts'

const FIXTURE_PACKS = join(import.meta.dirname, '..', 'browser', 'testdata', 'packs')
const CFG = { gatewayUrl: 'http://127.0.0.1:1', consoleTokenPath: '', llmTokenPath: '', workDir: '', runTools: [], teamTz: null, maxSessions: 1 } as WsConfig

const work = (id: string, title = 'one') => ({ id, type: 'Task', title, state: 'Active', assignedTo: null, changedAt: '2026-10-08T10:00:00Z', link: `https://board.example/acme/${id}` })
const mail = (id: string) => ({
  id, folder: 'Inbox', from: 'a@mail.example', to: [], cc: [], subject: 's', at: '2026-10-08T10:00:00Z', unread: true, preview: 'p',
  category: 'reply', myReply: false, conversationId: 'c', link: `https://mail.example/m/${id}`,
})
const chat = (id: string) => ({ id, name: id, kind: 'group', unread: 0, lastAt: '2026-10-08T10:00:00Z', lastFrom: null, lastPreview: null, link: `https://mail.example/c/${id}`, mentioned: false })

const grants = (o: Partial<PackGrants> = {}): GrantsFn => () => ({ packs: ['fixture'], hosts: ['board.example', 'mail.example'], config: { fixture: { org: 'acme' } }, ...o })
const both = (o: Partial<PackGrants> = {}) => grants({ packs: ['fixture', 'talk'], scopes: { talk: ['t1', 't2'] }, ...o })
const talkChat = (id: string, name = id) => ({ ...chat(id), name, link: `https://talk.example/c/${id}` })
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
after(async () => { for (const s of live.splice(0)) s.stop(); await cdp.close() })
beforeEach(async () => {
  for (const s of live.splice(0)) s.stop()
  for (const t of [...cdp.tabs]) cdp.closeTab(t.id)
  cdp.activated.length = 0
  board = cdp.addTab('https://board.example/acme/core', { DATA: { work: [work('W-1')] } })
  cdp.addTab('https://mail.example/inbox', { DATA: { mail: [mail('m1')], chat: [chat('c1')] } })
})

function make(o: { grants?: GrantsFn; browser?: BrowserStatus; tickMs?: number; packsDir?: string | string[]; firstReadMs?: number } = {}) {
  const bus = new Bus(), events: Ev[] = []
  bus.on((e) => events.push(e))
  const br = stubBrowser(cdp, o.browser)
  const src = localSource(CFG, {
    bus, ws: 'w', grants: o.grants ?? grants(), docs: memDocs(), browser: br.b, packsDir: o.packsDir ?? FIXTURE_PACKS, tickMs: o.tickMs ?? 20, firstReadMs: o.firstReadMs,
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
  assert.deepEqual(plain(r), { status: 'ok', rev: 1, items: [{ ...work('W-1'), pack: 'fixture' }], packs: { fixture: { status: 'ok' } } })
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
  // a poll already under way when the get came may still go out without the id
  const n = reads(board).length
  await until(() => reads(board).slice(n).some((c: { watch?: unknown }) => JSON.stringify(c.watch) === JSON.stringify({ work: ['W-9'] })))
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

test("an act refused before it ran answers a repeat of its actionId with that refusal; a new Send runs it", async () => {
  const { src, br } = make({ browser: { state: 'unavailable', reason: 'Edge is closed' } })
  const a = { action: 'work.comment', actionId: 'retry', args: { id: 'W-1', text: 'later' } }
  assert.equal((await src.act(a)).error?.code, 'source_unavailable')
  br.set({ state: 'up' })
  assert.equal((await src.act(a)).error?.code, 'source_unavailable', 'one Send is never sent twice')
  assert.equal(plain(board.ctx.ACTS ?? []).length, 0)
  assert.equal((await src.act({ ...a, actionId: 'again' })).status, 'ok')
  assert.equal(plain(board.ctx.ACTS).length, 1)
})

test('the actions are what the loaded packs declare, less what the grants leave out', () => {
  assert.deepEqual([...make().src.actions()], ['work.comment'], 'acts absent: every declared action')
  assert.deepEqual([...make({ grants: grants({ acts: ['work.comment', 'mail.send'] }) }).src.actions()], ['work.comment'])
  assert.deepEqual([...make({ grants: grants({ acts: [] }) }).src.actions()], [])
  assert.deepEqual([...make({ grants: grants({ packs: [] }) }).src.actions()], [])
})

test('down, it names its own state store and why, and says each new reason once', async () => {
  const said: string[] = []
  let n = 0
  const docs: StateDocs = { load: async () => { n++; throw new Error('Postgres not running') }, put: async () => {}, seq: async () => {} }
  const src = localSource(CFG, { bus: new Bus(), ws: 'w', grants: grants({ packs: [] }), docs, log: (l) => said.push(l), backoffMs: [5] })
  live.push(src)
  assert.equal(src.via, 'store')
  src.start()
  await until(() => n >= 3)
  assert.equal(src.available(), false)
  assert.equal(src.why!(), 'Postgres not running')
  assert.equal(said.filter((l) => /Postgres not running/.test(l)).length, 1)
})

test('its run MCP on port 0 takes a free port, and its status names it', async () => {
  const dir = tempDir('local-mcp')
  const src = localSource({ ...CFG, gatewayUrl: 'http://127.0.0.1:0', llmTokenPath: join(dir, 'llm.token') }, { bus: new Bus(), ws: 'w', grants: grants({ packs: [] }), docs: memDocs(), mcp: true, log: () => {} })
  live.push(src)
  assert.equal(src.mcp, true)
  src.start()
  try {
    await until(() => !!src.status().mcp || !!src.status().mcpError)
    assert.match(src.status().mcp ?? src.status().mcpError!, /^http:\/\/127\.0\.0\.1:[1-9]\d*\/mcp$/)
  } finally { src.stop(); await sleep(50); rmSync(dir, { recursive: true, force: true }) }
})

test("its run MCP never takes the gateway's port 47821", async () => {
  const src = localSource({ ...CFG, gatewayUrl: 'http://127.0.0.1:47821' }, { bus: new Bus(), ws: 'w', grants: grants({ packs: [] }), docs: memDocs(), mcp: true, log: () => {} })
  live.push(src)
  src.start()
  await until(() => !!src.status().mcpError)
  assert.equal(src.status().mcp, null)
  assert.match(src.status().mcpError!, /47821/)
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

test("a granted pack's tabs open on its own hosts with grants.hosts empty", async () => {
  const { src } = make({ grants: grants({ hosts: [] }) })
  const r = (await src.read(['work'])).work as { status: string }
  assert.equal(r.status, 'ok')
  assert.equal(src.status().packs.fixture, 'loaded')
})

test("a workspace pack's host that grants.hosts leaves out does not load and no tab opens; granted, it does", async () => {
  const core = tempDir('packs')
  const off = make({ grants: grants({ hosts: ['board.example'] }), packsDir: [core, FIXTURE_PACKS] }).src
  const r = (await off.read(['work'])).work as { status: string; message: string }
  assert.equal(r.status, 'source_error')
  assert.match(r.message, /mail\.example is not granted/)
  assert.equal(cdp.tabs.length, 2)
  assert.equal(reads(board).length, 0)
  const on = make({ packsDir: [core, FIXTURE_PACKS] }).src
  assert.equal(((await on.read(['work'])).work as { status: string }).status, 'ok')
})

test('two packs on chat: a read merges both, each item says its pack, and each pack has its own state', async () => {
  const talk = cdp.addTab('https://talk.example/app', { DATA: { chat: [talkChat('t1', 'Brothers'), talkChat('t9', 'Outside')] } })
  const { src } = make({ grants: both() })
  await until(() => src.concepts().chat === 'ready' && reads(talk).length > 0)
  await until(() => src.packStates().talk?.concepts.chat?.status === 'ok')
  const r = plain((await src.read(['chat'])).chat)
  assert.equal(r.status, 'ok')
  assert.deepEqual(r.items.map((i: { id: string; pack: string }) => `${i.pack}:${i.id}`).sort(), ['fixture:c1', 'talk:t1'])
  assert.deepEqual(r.packs, { fixture: { status: 'ok' }, talk: { status: 'ok' } })
  assert.deepEqual(src.packStates().talk.names, { t1: 'Brothers' })
})

test('get on a concept two packs serve needs pack; with it, the pack answers', async () => {
  cdp.addTab('https://talk.example/app', { DATA: { chat: [talkChat('t1')] }, GETS: { chat: { t1: { messages: [], cursor: null } } } })
  const { src } = make({ grants: both() })
  await until(() => src.concepts().chat === 'ready')
  assert.deepEqual(plain(await src.get('chat', 'zz')), { status: 'ambiguous', message: 'ambiguous: chat served by fixture, talk; give pack' }, 'an id no pack lists')
  assert.deepEqual(plain(await src.get('chat', 't1', undefined, 'nope')), { status: 'not_found', message: 'no pack nope serves chat' })
  const r = plain(await src.get('chat', 't1', undefined, 'talk'))
  assert.deepEqual([r.status, r.items], ['ok', { messages: [], cursor: null }])
  assert.equal((await src.get('chat', 't9', undefined, 'talk')).status, 'out_of_scope')
  assert.equal(src.actionPack('talk.post'), 'talk')
  assert.equal(src.actionPack('chat.post'), undefined)
})

test('get without pack goes to the one pack that lists the id; an id both list is ambiguous', async () => {
  cdp.addTab('https://talk.example/app', { DATA: { chat: [talkChat('t1'), talkChat('c1')] }, GETS: { chat: { t1: { messages: [], cursor: null } } } })
  const { src } = make({ grants: both({ scopes: { talk: ['t1', 'c1'] } }) })
  await until(() => src.concepts().chat === 'ready' && src.packStates().talk?.concepts.chat?.status === 'ok')
  const r = plain(await src.get('chat', 't1'))
  assert.deepEqual([r.status, r.items], ['ok', { messages: [], cursor: null }])
  assert.equal((await src.get('chat', 'c1')).status, 'ambiguous')
})

test('two packs on chat, one signed out: the concept stays ok with the other, and the signed-out pack names its host', async () => {
  cdp.addTab('https://talk.example/app', { MODE: { chat: { ok: false, code: 'unauthorized', message: 'signed out' } } })
  const { src } = make({ grants: both() })
  await until(() => src.packStates().talk?.concepts.chat?.status === 'signin_required')
  const r = plain((await src.read(['chat'])).chat)
  assert.equal(r.status, 'ok')
  assert.deepEqual(r.items.map((i: { pack: string }) => i.pack), ['fixture'])
  assert.deepEqual([r.packs.talk.status, r.packs.talk.host], ['signin_required', 'talk.example'])
  assert.equal(src.concepts().chat, 'ready')
})

test('a concept whose every pack fails answers the first failure, with the per-pack states', async () => {
  cdp.addTab('https://talk.example/app', { MODE: { chat: { ok: false, code: 'unauthorized', message: 'signed out' } } })
  const { src } = make({ grants: both({ packs: ['talk'] }) })
  await until(() => src.concepts().chat === 'signin_required')
  const r = plain((await src.read(['chat'])).chat)
  assert.equal(r.status, 'signin_required')
  assert.equal(r.packs.talk.status, 'signin_required')
})

test('a source event of work carries the pack on each upsert', async () => {
  const { src, events } = make()
  await src.read(['work'])
  board.ctx.DATA = { work: [work('W-1', 'changed')] }
  await until(() => sources(events, 'work').some((e) => e.upserts.length === 1))
  assert.equal(plain(sources(events, 'work').find((e) => e.upserts.length === 1)!.upserts[0]).pack, 'fixture')
})

test('one of two packs on chat signs out after a good read, then recovers: a chat event each way, and the read follows', async () => {
  const talk = cdp.addTab('https://talk.example/app', { DATA: { chat: [talkChat('t1')] } })
  const { src, events } = make({ grants: both() })
  await until(() => src.packStates().talk?.concepts.chat?.status === 'ok')
  await until(() => events.some((e) => e.kind === 'source' && e.concept === 'chat'))
  const ids = async () => plain((await src.read(['chat'])).chat).items.map((i: { id: string }) => i.id).sort()
  assert.deepEqual(await ids(), ['c1', 't1'])
  await sleep(100)
  let n = sources(events, 'chat').length
  talk.ctx.MODE = { chat: { ok: false, code: 'unauthorized', message: 'signed out' } }
  await until(() => src.packStates().talk.concepts.chat.status === 'signin_required')
  await until(() => sources(events, 'chat').length > n)
  assert.ok(sources(events, 'chat').slice(n).some((e) => e.reset))
  assert.deepEqual(await ids(), ['c1'])
  await sleep(100)
  n = sources(events, 'chat').length
  talk.ctx.MODE = {}
  await until(() => src.packStates().talk.concepts.chat.status === 'ok')
  await until(() => sources(events, 'chat').length > n)
  assert.deepEqual(await ids(), ['c1', 't1'])
})

test('every pack of a concept failing or warming: the answer is the first one past warming_up, with the summed rev', async () => {
  const mailTab = cdp.tabs.find((t) => t.url.startsWith('https://mail.example/'))!
  mailTab.ctx.MODE = { chat: async () => { await sleep(300); return null } }
  cdp.addTab('https://talk.example/app', { MODE: { chat: { ok: false, code: 'unauthorized', message: 'signed out' } } })
  const { src } = make({ grants: both(), firstReadMs: 50 })
  await until(() => src.packStates().talk?.concepts.chat?.status === 'signin_required')
  const r = plain((await src.read(['chat'])).chat)
  assert.equal(r.status, 'signin_required')
  assert.deepEqual([r.packs.fixture.status, r.packs.talk.status], ['warming_up', 'signin_required'])
  assert.equal(typeof r.rev, 'number')
})

test("candidates run the pack's candidates verb with no scope; a pack without one says so", async () => {
  const talk = cdp.addTab('https://talk.example/app', { DATA: { chat: [] }, CANDIDATES: [{ id: 't1', name: 'Brothers' }, { id: 't7', name: 'Family' }] })
  const { src } = make({ grants: both({ scopes: {} }) })
  await until(() => src.concepts().chat === 'ready')
  assert.deepEqual(plain(await src.candidates('talk')), { status: 'ok', items: [{ id: 't1', name: 'Brothers' }, { id: 't7', name: 'Family' }] })
  assert.equal(plain(talk.ctx.CALLS).find((c: { verb: string }) => c.verb === 'candidates').scope, undefined)
  assert.equal((await src.candidates('fixture')).status, 'bad_args')
  assert.equal((await src.candidates('nope')).status, 'not_found')
})
