import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { cdpCarrier } from './cdp.ts'
import { startFakeCdp } from './fake-cdp.ts'
import type { FakeCdp, FakeTab } from './fake-cdp.ts'
import { grantedPacks } from './packs.ts'
import { PackRuntime, SourceFail, Unknown, Watched } from './runtime.ts'
import { TabPool } from './tabs.ts'

const FIXTURE_PACKS = join(import.meta.dirname, 'testdata', 'packs')
const [pack] = grantedPacks({ packs: ['fixture'], hosts: ['board.example', 'mail.example'], config: { fixture: { org: 'acme' } } }, FIXTURE_PACKS).packs
const WORK = [{ id: 'W-1', title: 'one' }]

let cdp: FakeCdp, clock = Date.parse('2026-10-08T12:00:00Z')
before(async () => { cdp = await startFakeCdp() })
after(async () => { await cdp.close() })
beforeEach(() => { for (const t of [...cdp.tabs]) cdp.closeTab(t.id); cdp.onEval = null })

/** a runtime over a fresh pool, and the board tab with the given globals */
const setup = (globals: Record<string, unknown> = {}) => {
  const board = cdp.addTab('https://board.example/acme/core', { DATA: { work: WORK }, ...globals })
  const carrier = cdpCarrier(() => cdp.url)
  const rt = new PackRuntime(pack, new TabPool(carrier, (h) => h.endsWith('.example')), carrier, { evalMs: 300, actMs: 300, settleMs: 20, now: () => clock })
  return { rt, board }
}
const read = (rt: PackRuntime, concept = 'work') => rt.read('board', { verb: 'read', concept, watch: {} })
const evals = () => cdp.log.filter((m) => m === 'Runtime.evaluate').length
const failure = async (p: Promise<unknown>) => { try { await p } catch (e) { return e as SourceFail } assert.fail('expected a failure') }
const seq = (...envs: unknown[]) => { let i = 0; return () => envs[Math.min(i++, envs.length - 1)] }
/** a value out of the tab's realm, as plain JSON */
const plain = (v: unknown) => JSON.parse(JSON.stringify(v))
const calls = (t: FakeTab) => plain(t.ctx.CALLS ?? []) as Record<string, unknown>[]

test("a read returns the envelope's data; the call carries the pack's zone, the time and its config", async () => {
  const { rt, board } = setup()
  assert.deepEqual(plain(await read(rt)), WORK)
  const c = calls(board)[0]
  assert.deepEqual([c.verb, c.concept, c.zone, c.now, c.config], ['read', 'work', 'UTC', '2026-10-08T12:00:00.000Z', { org: 'acme', team: 'core' }])
})

test('a blank tab is reloaded once and the read retried', async () => {
  const { rt, board } = setup({ MODE: { work: seq({ ok: false, code: 'blank', message: 'nothing yet' }, null) } })
  assert.deepEqual(plain(await read(rt)), WORK)
  assert.equal(board.reloads, 1)
})

test('unauthorized after a reload is signin_required with the host; another read in the quiet window does not reload', async () => {
  const { rt, board } = setup({ MODE: { work: { ok: false, code: 'unauthorized', message: 'GET /api → 401' } } })
  const e = await failure(read(rt))
  assert.ok(e instanceof SourceFail)
  assert.deepEqual([e.code, e.host], ['signin_required', 'board.example'])
  assert.match(e.message, /401/)
  assert.equal(board.reloads, 1)
  clock += 60_000
  assert.equal((await failure(read(rt))).code, 'signin_required')
  assert.equal(board.reloads, 1, 'no reload within 10 minutes')
  clock += 10 * 60_000
  await failure(read(rt))
  assert.equal(board.reloads, 2, 'past the quiet window one reload is tried again')
})

test('a tab that moved to a sign-in page is not reloaded, and answers signin_required', async () => {
  const { rt, board } = setup()
  await read(rt)
  cdp.navigate(board.id, 'https://login.example/authorize')
  board.ctx.MODE = { work: { ok: false, code: 'unauthorized', message: 'login' } }
  assert.equal((await failure(read(rt))).code, 'signin_required')
  assert.equal(board.reloads, 0)
})

test('rate_limited carries its retryAfter', async () => {
  const { rt } = setup({ MODE: { work: { ok: false, code: 'rate_limited', message: '429', retryAfter: 7 } } })
  const e = await failure(read(rt))
  assert.deepEqual([e.code, e.retryAfter], ['rate_limited', 7])
})

test('a closed tab is resolved again once, opening a new one, and the read goes on', async () => {
  const { rt, board } = setup()
  await read(rt)
  cdp.closeTab(board.id)
  cdp.globalsFor = () => ({ DATA: { work: WORK } })
  try {
    assert.deepEqual(plain(await read(rt)), WORK)
    assert.equal(cdp.tabs.length, 1)
    assert.equal(cdp.tabs[0].url, 'https://board.example/acme/core')
  } finally { cdp.globalsFor = () => ({}) }
})

test('a token expiring within 5 minutes reloads the tab after the read, once per 5 minutes', async () => {
  const exp = new Date(clock + 60_000).toISOString()
  const { rt, board } = setup({ MODE: { work: { ok: true, data: WORK, tokenExpiresAt: exp } } })
  assert.deepEqual(plain(await read(rt)), WORK)
  assert.equal(board.reloads, 1)
  await read(rt)
  assert.equal(board.reloads, 1)
})

test('a script that throws, or answers without an envelope, is source_error', async () => {
  const { rt } = setup({ MODE: { work: () => { throw new Error('bad') } } })
  assert.equal((await failure(read(rt))).code, 'source_error')
  cdp.addTab('https://mail.example/inbox', { MODE: { mail: () => 42 } })
  assert.equal((await failure(rt.read('mail', { verb: 'read', concept: 'mail' }))).code, 'source_error')
})

test("an act returns the envelope's data and runs once", async () => {
  const { rt, board } = setup()
  cdp.log.length = 0
  assert.deepEqual(plain(await rt.act('board', { verb: 'act', action: 'work.comment', args: { id: 'W-1', text: 'hi' } })), { done: 'work.comment' })
  assert.equal(evals(), 1)
  assert.deepEqual(plain(board.ctx.ACTS)[0].args, { id: 'W-1', text: 'hi' })
})

test('an act whose eval times out is Unknown after exactly one eval', async () => {
  const { rt } = setup({ MODE: { 'work.comment': () => new Promise(() => {}) } })
  cdp.log.length = 0
  const e = await failure(rt.act('board', { verb: 'act', action: 'work.comment', args: {} }))
  assert.ok(e instanceof Unknown)
  assert.equal(evals(), 1)
})

test("an act's envelope unknown is Unknown; bad_args is bad_args; rate_limited is source_unavailable", async () => {
  const { rt, board } = setup()
  const act = (env: unknown) => { board.ctx.MODE = { 'work.comment': env }; return rt.act('board', { verb: 'act', action: 'work.comment', args: {} }) }
  assert.ok(await failure(act({ ok: false, code: 'unknown', message: 'sent, no answer' })) instanceof Unknown)
  assert.equal((await failure(act({ ok: false, code: 'bad_args', message: 'no text' }))).code, 'bad_args')
  assert.equal((await failure(act({ ok: false, code: 'rate_limited', message: '429' }))).code, 'source_unavailable')
})

test('an act on a closed tab is source_unavailable, with no second try', async () => {
  const { rt, board } = setup()
  await read(rt)
  cdp.closeTab(board.id); cdp.log.length = 0
  const e = await failure(rt.act('board', { verb: 'act', action: 'work.comment', args: {} }))
  assert.equal(e.code, 'source_unavailable')
  assert.equal(evals(), 0)
  assert.equal(cdp.tabs.length, 0, 'no tab opened for it')
})

test('watched keeps 50 ids per concept, the newest, and drops those older than 24 h', () => {
  let t = 0
  const w = new Watched(() => t)
  for (let i = 0; i < 52; i++) { t = i; w.add('work', `W-${String(i).padStart(2, '0')}`) }
  w.add('chat', 'c1')
  const s = w.snapshot()
  assert.equal(s.work.length, 50)
  assert.deepEqual(s.work.slice(0, 2), ['W-02', 'W-03'])
  t = 24 * 3600_000 + 51
  assert.deepEqual(w.snapshot(), { work: ['W-51'], chat: ['c1'] })
})
