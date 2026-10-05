import { acme, acmeServer } from './testkit.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Job } from '../src/model/types.ts'
import { startFakeGateway } from './bridge/fake.ts'
import { loadConfig, wsConfig } from './config.ts'
import { Bus } from './events.ts'
import { jobByText, main } from './main.ts'
import { onBridgeBack } from './spaces.ts'
import type { Sdk } from './llm/sdk.ts'
import type { WorkspaceServer } from './workspace.ts'

async function until(f: () => boolean, ms = 2000) {
  const t0 = Date.now()
  while (!f()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 2)) }
}

const job = (id: string, key: string, st = 'active') => ({ id, key, st }) as unknown as Job
const unused: Sdk = { async *start() { yield { k: 'result', ok: false, error: 'unused' } } }
/** Acme under another id and prefix, bringing no playbooks of its own */
const beta2: WorkspaceServer = { ...acmeServer, page: { ...acme, id: 'beta2', playbooks: {} }, jobPrefix: 'B' }

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

test('main starts on loopback with a fake gateway per workspace, recovers runs, and closes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wc-main-'))
  const cfg = { ...loadConfig({ WORK_CONSOLE_HOME: home, WORK_CONSOLE_FAKE_GATEWAY: '1' }), loopbackPort: 0 }
  const m = await main({ cfg, sdk: unused, workspaces: [acmeServer] })
  try {
    assert.equal(m.lanPort, null, 'no certificate, no LAN listener')
    assert.deepEqual(m.spaces.list.map((s) => s.id), ['acme']); assert.deepEqual(Object.keys(m.fakes), ['acme'])
    const state = async () => ((await (await fetch(`http://127.0.0.1:${m.loopbackPort}/api/state`)).json()) as { ws: { acme: { jobs: Job[]; playbooks: Record<string, unknown>; bridge: { state: string } } } }).ws.acme
    const st = await state()
    assert.deepEqual(st.jobs, []); assert.ok(Object.keys(st.playbooks).length > 0)
    const t0 = Date.now()
    while ((await state()).bridge.state !== 'ok') { if (Date.now() - t0 > 5000) throw new Error('the fake never came up'); await new Promise((r) => setTimeout(r, 20)) }
    const r = await fetch(`http://127.0.0.1:${m.loopbackPort}/api/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t: 'Prefix', key: 'ACME-1', pb: 'action', prj: 'platform', ws: 'acme' }) })
    assert.match(((await r.json()) as { job: Job }).job.id, /^A-\d{4}$/, "the fake's J-NNNN comes back under Acme's prefix")
  } finally { await m.close() }
})

test('the job MCP behind main serves every workspace: ws picks the space, none named is refused naming them', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wc-main-'))
  const cfg = { ...loadConfig({ WORK_CONSOLE_HOME: home, WORK_CONSOLE_FAKE_GATEWAY: '1' }), loopbackPort: 0 }
  const m = await main({ cfg, sdk: unused, workspaces: [acmeServer, beta2] })
  try {
    const base = `http://127.0.0.1:${m.loopbackPort}`
    const t0 = Date.now()
    while (!m.spaces.list.every((s) => s.source.available())) { if (Date.now() - t0 > 5000) throw new Error('the fakes never came up'); await new Promise((r) => setTimeout(r, 20)) }
    const rpc = async (body: unknown) => (await (await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${readFileSync(m.mcpToken, 'utf8').trim()}` }, body: JSON.stringify(body) })).json()) as { result: { content: { text: string }[]; isError?: boolean } }
    const call = async (name: string, args: Record<string, unknown>) => { const r = (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result; return { err: !!r.isError, text: r.content[0].text } }
    const none = await call('create_job', { title: 'Which?', playbook: 'action' })
    assert.deepEqual([none.err, none.text], [true, 'bad_args: say which workspace: acme, beta2'])
    const made = await call('create_job', { title: 'In beta', playbook: 'action', ws: 'beta2' })
    assert.equal(made.err, false, made.text)
    assert.match(made.text, /"id": "B-0001"/)
    assert.equal((await call('get_job', { id: 'B-0001' })).err, false)
    assert.equal((await call('get_job', { id: 'X-0001' })).text, 'not_found: no job X-0001')
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
  const cfg = { ...loadConfig({ WORK_CONSOLE_HOME: home }), loopbackPort: 0, workspaces: { acme: { gatewayUrl: `http://127.0.0.1:${port}`, consoleTokenPath: tok, llmTokenPath: tok } } }
  const m = await main({ cfg, sdk: unused, workspaces: [acmeServer] })
  const state = async () => ((await (await fetch(`http://127.0.0.1:${m.loopbackPort}/api/state`)).json()) as { ws: { acme: { jobs: Job[]; playbooks: Record<string, unknown>; bridge: { state: string } } } }).ws.acme
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

test('a workspace config: core defaults, then its llm runTools, its defaults, legacy keys, its config section', () => {
  const cfg = { ...loadConfig({ WORK_CONSOLE_HOME: mkdtempSync(join(tmpdir(), 'wc-cfg-')) }), workspaces: { acme: { maxSessions: 5 } } }
  const quiet = () => undefined
  const core = wsConfig({ ...cfg, workspaces: {} }, acmeServer, {}, quiet)
  assert.deepEqual([core.runTools, core.teamTz, core.maxSessions], [['Read', 'Glob', 'Grep'], null, 3])
  assert.deepEqual(wsConfig(cfg, { ...acmeServer, llm: { runTools: ['Read'] } }, {}, quiet).runTools, ['Read'])
  const w = { ...acmeServer, llm: { runTools: ['Read'] }, defaults: { runTools: ['Grep'], teamTz: 'Europe/Berlin', maxSessions: 2, billingRepo: 'x' } }
  const c = wsConfig(cfg, w, { teamTz: 'Asia/Tokyo', maxSessions: 4 }, quiet)
  assert.deepEqual([c.runTools, c.teamTz, c.maxSessions, c.billingRepo], [['Grep'], 'Asia/Tokyo', 5, 'x'], 'the section beats a legacy key')
})

test('autoAsk is off unless a workspace turns it on; its config section turns it off again', () => {
  const cfg = { ...loadConfig({ WORK_CONSOLE_HOME: mkdtempSync(join(tmpdir(), 'wc-cfg-')) }), workspaces: {} }
  const quiet = () => undefined, on = { ...acmeServer, defaults: { autoAsk: true } }
  assert.equal(wsConfig(cfg, acmeServer, {}, quiet).autoAsk, false)
  assert.equal(wsConfig(cfg, on, {}, quiet).autoAsk, true)
  assert.equal(wsConfig({ ...cfg, workspaces: { acme: { autoAsk: false } } }, on, {}, quiet).autoAsk, false)
})

test("the env given to loadConfig sets every workspace's gateway and work dir", () => {
  const cfg = loadConfig({ WORK_CONSOLE_HOME: mkdtempSync(join(tmpdir(), 'wc-cfg-')), GATEWAY_URL: 'http://127.0.0.1:47999', WORK_CONSOLE_CWD: 'C:/work' })
  const c = wsConfig(cfg, acmeServer, {}, () => undefined)
  assert.deepEqual([c.gatewayUrl, c.workDir], ['http://127.0.0.1:47999', 'C:/work'])
})

test('a taken port rejects main() and leaves nothing listening behind', async () => {
  const servers = () => process.getActiveResourcesInfo().filter((r) => r === 'TCPServerWrap').length
  // the servers earlier tests closed go a turn of the loop after their close callbacks
  await until(() => servers() === 0)
  const taken = createServer()
  await new Promise<void>((r) => taken.listen(0, '127.0.0.1', r))
  try {
    const home = mkdtempSync(join(tmpdir(), 'wc-main-'))
    const cfg = { ...loadConfig({ WORK_CONSOLE_HOME: home, WORK_CONSOLE_FAKE_GATEWAY: '1' }), loopbackPort: (taken.address() as { port: number }).port }
    await assert.rejects(main({ cfg, sdk: unused, workspaces: [acmeServer, beta2] }), /EADDRINUSE/)
    // only the server holding the port is left
    await until(() => servers() === 1)
  } finally { await new Promise((r) => taken.close(r)) }
})

test('a workspace key at the top of config.json goes to the one workspace with a line saying where; with two, startup refuses', async (t) => {
  const lines: string[] = []
  t.mock.method(console, 'log', (...a: unknown[]) => { lines.push(a.join(' ')) })
  const home = mkdtempSync(join(tmpdir(), 'wc-main-'))
  writeFileSync(join(home, 'config.json'), JSON.stringify({ runTools: ['Bash'] }))
  const cfg = { ...loadConfig({ WORK_CONSOLE_HOME: home, WORK_CONSOLE_FAKE_GATEWAY: '1' }), loopbackPort: 0 }
  const m = await main({ cfg, sdk: unused, workspaces: [acmeServer] })
  try {
    assert.deepEqual(m.spaces.get('acme').cfg.runTools, ['Bash'])
    assert.ok(lines.some((l) => l.includes('move runTools to workspaces.acme.runTools')), lines.join(' | '))
  } finally { await m.close() }
  await assert.rejects(main({ cfg, sdk: unused, workspaces: [acmeServer, beta2] }), /runTools.*workspaces\.<id>/)
})
