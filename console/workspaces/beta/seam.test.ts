import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../../server/config.ts'
import { main } from '../../server/main.ts'
import { fakeSdk } from '../../server/testkit.ts'
import type { FakeSession } from '../../server/testkit.ts'
import type { WorkspacePage } from '../../src/workspace.ts'
import acmeServer from '../acme/server.ts'
import betaServer from './server.ts'
import { tempDir } from '../../server/testdirs.ts'

const cfg = { ...loadConfig({ WORK_CONSOLE_HOME: tempDir('seam'), WORK_CONSOLE_FAKE_GATEWAY: '1' }), loopbackPort: 0 }
const sessions: FakeSession[] = []
const m = await main({ cfg, sdk: fakeSdk(sessions).sdk, workspaces: [acmeServer, betaServer] })
after(() => m.close())
const base = `http://127.0.0.1:${m.loopbackPort}`
const call = async (method: string, path: string, body?: unknown) => (await fetch(base + path, {
  method, headers: { origin: base, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })).json()
const get = (p: string) => call('GET', p), post = (p: string, b: unknown) => call('POST', p, b)
async function until(f: () => Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms
  while (!(await f())) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)) }
}
// main() returns before the sources have connected; every test below needs both gateways up
await until(async () => { const st = await get('/api/state'); return st.ws.acme.bridge.state === 'ok' && st.ws.beta.bridge.state === 'ok' }, 5000)
const state = (id: string) => get(`/api/runs/${id}`).then((r) => r.run.state)
let a: any, b: any

test('a job gets its workspace prefix and lands in that workspace store', async () => {
  a = (await post('/api/jobs', { t: 'x', key: 'NEW', pb: 'dev-item', prj: 'platform', ws: 'acme' })).job
  b = (await post('/api/jobs', { t: 'y', key: 'NEW', pb: 'beta-task', prj: 'main', ws: 'beta' })).job
  assert.match(a.id, /^A-\d{4}$/); assert.match(b.id, /^B-\d{4}$/)
  const st = await get('/api/state')
  assert.ok(st.ws.acme.jobs.some((j: any) => j.id === a.id) && !st.ws.beta.jobs.some((j: any) => j.id === a.id))
})
test('an act in one workspace never reaches the other gateway', async () => {
  const before = m.fakes.acme.acts.length
  await post('/api/ws/beta/act', { action: 'work.comment', args: { id: 'BETA-1', text: 'hi' } })
  assert.equal(m.fakes.beta.acts.length, 1); assert.equal(m.fakes.acme.acts.length, before)
})
test('a duplicate prefix stops startup naming both workspaces', async () => {
  await assert.rejects(main({ cfg, workspaces: [acmeServer, { ...betaServer, jobPrefix: 'A' }] }), /acme and beta both use job prefix A/)
})
test('one gateway down: its block is unavailable, its runs stop, the other carries on', async (t) => {
  // the stopped run cannot be written to B while B is away; the runner says so on the console
  t.mock.method(console, 'error', () => undefined)
  const ra = (await post('/api/runs', { job: a.id, step: 'an1', instruction: 'go' })).run
  const rb = (await post('/api/runs', { job: b.id, step: 'bt1', instruction: 'go' })).run
  await until(async () => (await state(ra.id)) === 'running' && (await state(rb.id)) === 'running')
  // a session's prompt names its job
  const sessionOf = (job: string) => sessions.find((s) => s.prompt.includes(`Job ${job}:`))!
  assert.ok(sessionOf(a.id) && sessionOf(b.id))
  m.fakes.beta.setDown(true)
  await until(async () => (await get('/api/state')).ws.beta.bridge.state === 'unavailable')
  const st = await get('/api/state')
  assert.equal(st.ws.beta.parts.jobs, 'unavailable'); assert.ok(st.ws.acme.jobs.length > 0)
  // its record lives in B, which is away: the session stops now, the record is marked when B is back
  await until(async () => sessionOf(b.id).abort.signal.aborted)
  assert.equal(sessionOf(a.id).abort.signal.aborted, false); assert.equal(await state(ra.id), 'running')
  m.fakes.beta.setDown(false)
  await until(async () => (await get('/api/state')).ws.beta.bridge.state === 'ok', 10000)
  await until(async () => (await state(rb.id)) === 'interrupted', 10000)
  assert.equal(await state(ra.id), 'running')
})

test('Beta shares no job, chat, playbook or step id with Acme: the page merges those maps flat', () => {
  const ids = (p: WorkspacePage) => [
    ...p.demo.jobs.map((j) => j.id), ...p.demo.chats.map((c) => c.id),
    ...Object.entries(p.playbooks).flatMap(([id, pb]) => [id, ...pb.ph.flatMap((ph) => ph.s.map((s) => s.id))]),
  ]
  const taken = new Set(ids(acmeServer.page))
  assert.deepEqual(ids(betaServer.page).filter((id) => taken.has(id)), [])
})
