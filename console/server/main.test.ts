import { acme, acmeServer } from './testkit.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import type { Job } from '../src/model/types.ts'
import { startFakeGateway } from './bridge/fake.ts'
import { loadConfig, wsConfig } from './config.ts'
import { Bus } from './events.ts'
import { jobByText, main } from './main.ts'
import { onBridgeBack } from './spaces.ts'
import type { Sdk } from './llm/sdk.ts'
import type { WorkspaceServer } from './workspace.ts'
import { tempDir } from './testdirs.ts'

async function until(f: () => boolean | Promise<boolean>, ms = 2000) {
  const t0 = Date.now()
  while (!(await f())) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 2)) }
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
  const home = tempDir('main')
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
  const home = tempDir('main')
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
  const home = tempDir('main')
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
  const cfg = { ...loadConfig({ WORK_CONSOLE_HOME: tempDir('cfg') }), workspaces: { acme: { maxSessions: 5 } } }
  const quiet = () => undefined
  const core = wsConfig({ ...cfg, workspaces: {} }, acmeServer, {}, quiet)
  assert.deepEqual([core.runTools, core.teamTz, core.maxSessions], [['Read', 'Glob', 'Grep'], null, 3])
  assert.deepEqual(wsConfig(cfg, { ...acmeServer, llm: { runTools: ['Read'] } }, {}, quiet).runTools, ['Read'])
  const w = { ...acmeServer, llm: { runTools: ['Read'] }, defaults: { runTools: ['Grep'], teamTz: 'Europe/Berlin', maxSessions: 2, billingRepo: 'x' } }
  const c = wsConfig(cfg, w, { teamTz: 'Asia/Tokyo', maxSessions: 4 }, quiet)
  assert.deepEqual([c.runTools, c.teamTz, c.maxSessions, c.billingRepo], [['Grep'], 'Asia/Tokyo', 5, 'x'], 'the section beats a legacy key')
})

test('autoAsk is off unless a workspace turns it on; its config section turns it off again', () => {
  const cfg = { ...loadConfig({ WORK_CONSOLE_HOME: tempDir('cfg') }), workspaces: {} }
  const quiet = () => undefined, on = { ...acmeServer, defaults: { autoAsk: true } }
  assert.equal(wsConfig(cfg, acmeServer, {}, quiet).autoAsk, false)
  assert.equal(wsConfig(cfg, on, {}, quiet).autoAsk, true)
  assert.equal(wsConfig({ ...cfg, workspaces: { acme: { autoAsk: false } } }, on, {}, quiet).autoAsk, false)
})

test("the env given to loadConfig sets every workspace's gateway and work dir", () => {
  const cfg = loadConfig({ WORK_CONSOLE_HOME: tempDir('cfg'), GATEWAY_URL: 'http://127.0.0.1:47999', WORK_CONSOLE_CWD: 'C:/work' })
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
    const home = tempDir('main')
    const cfg = { ...loadConfig({ WORK_CONSOLE_HOME: home, WORK_CONSOLE_FAKE_GATEWAY: '1' }), loopbackPort: (taken.address() as { port: number }).port }
    await assert.rejects(main({ cfg, sdk: unused, workspaces: [acmeServer, beta2] }), /EADDRINUSE/)
    // only the server holding the port is left
    await until(() => servers() === 1)
  } finally { await new Promise((r) => taken.close(r)) }
})

test('a workspace key at the top of config.json goes to the one workspace with a line saying where; with two, startup refuses', async (t) => {
  const lines: string[] = []
  t.mock.method(console, 'log', (...a: unknown[]) => { lines.push(a.join(' ')) })
  const home = tempDir('main')
  writeFileSync(join(home, 'config.json'), JSON.stringify({ runTools: ['Bash'] }))
  const cfg = { ...loadConfig({ WORK_CONSOLE_HOME: home, WORK_CONSOLE_FAKE_GATEWAY: '1' }), loopbackPort: 0 }
  const m = await main({ cfg, sdk: unused, workspaces: [acmeServer] })
  try {
    assert.deepEqual(m.spaces.get('acme').cfg.runTools, ['Bash'])
    assert.ok(lines.some((l) => l.includes('move runTools to workspaces.acme.runTools')), lines.join(' | '))
  } finally { await m.close() }
  await assert.rejects(main({ cfg, sdk: unused, workspaces: [acmeServer, beta2] }), /runTools.*workspaces\.<id>/)
})

test("a managed workspace has an agent behind /api/ws/<id>/agent and in /api/state", async () => {
  const home = tempDir('main'), root = tempDir('root')
  mkdirSync(join(root, 'workspaces', 'beta2'), { recursive: true })
  writeFileSync(join(root, 'workspaces', 'beta2', 'grants.json'), JSON.stringify({ packs: ['p'] }))
  const cfg = { ...loadConfig({ WORK_CONSOLE_HOME: home, WORK_CONSOLE_FAKE_GATEWAY: '1' }), loopbackPort: 0 }
  const prompts: string[] = []
  const sdk: Sdk = {
    ...unused,
    async *agent(o) { prompts.push(o.prompt); yield { k: 'session', id: 's1' }; yield { k: 'text', t: 'Hello.' }; yield { k: 'result', ok: true } },
  }
  let restarts = 0
  const m = await main({ cfg, sdk, workspaces: [acmeServer, beta2], root, restart: () => { restarts++ } })
  try {
    const base = `http://127.0.0.1:${m.loopbackPort}`
    const call = async (path: string, body?: unknown) => {
      const r = await fetch(`${base}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: r.status, json: (await r.json()) as Record<string, any> }
    }
    const st = (await call('/api/state')).json.ws
    assert.deepEqual([st.acme.managed, st.acme.agent, st.beta2.managed, st.beta2.agent], [false, null, true, null])
    const sent = await call('/api/ws/beta2/agent', { text: 'hi' })
    assert.equal(sent.status, 200)
    assert.equal(sent.json.agent.interview, undefined, 'its grants are not empty: no interview')
    const t0 = Date.now()
    let rec = (await call('/api/ws/beta2/agent')).json.agent
    while (rec.status === 'running') { if (Date.now() - t0 > 5000) throw new Error('the turn never ended'); await new Promise((r) => setTimeout(r, 20)); rec = (await call('/api/ws/beta2/agent')).json.agent }
    assert.deepEqual(rec.turns.map((t: { who: string; t: string }) => [t.who, t.t]), [['you', 'hi'], ['agent', 'Hello.']])
    assert.deepEqual(prompts.map((p) => p.split('\n').at(-1)), ['hi'], 'the words come last, after the context')
    assert.equal((await call('/api/ws/beta2/agent/grants', { accept: true })).json.error.code, 'no_pending')
    assert.equal((await call('/api/ws/beta2/agent/stop', {})).json.error.code, 'idle')
    assert.equal(restarts, 0)
    assert.equal((await call('/api/state')).json.ws.beta2.agent.id, rec.id)
  } finally { await m.close() }
})

test('the agent routes take job and conv; grants and undo are not_managed in an unmanaged workspace', async () => {
  const home = tempDir('main'), root = tempDir('root')
  const cfg = { ...loadConfig({ WORK_CONSOLE_HOME: home, WORK_CONSOLE_FAKE_GATEWAY: '1' }), loopbackPort: 0 }
  const prompts: string[] = []
  const sdk: Sdk = { ...unused, async *agent(o) { prompts.push(o.prompt); yield { k: 'session', id: 's1' }; yield { k: 'text', t: 'Seen.' }; yield { k: 'result', ok: true } } }
  const m = await main({ cfg, sdk, workspaces: [acmeServer], root, restart: () => {} })
  try {
    const base = `http://127.0.0.1:${m.loopbackPort}`
    const call = async (path: string, body?: unknown) => {
      const r = await fetch(`${base}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: r.status, json: (await r.json()) as Record<string, any> }
    }
    await until(() => m.spaces.get('acme').source.available(), 5000)
    const j = await m.spaces.get('acme').jobs.create({ t: 'Look', key: 'K-1', pb: 'action', prj: 'p', ws: 'acme' })
    assert.equal((await call(`/api/ws/acme/agent?job=${j.id}`)).json.agent, null)
    assert.equal((await call('/api/ws/acme/agent', { text: 'hi', job: 'A-999' })).json.error.code, 'not_found')
    const sent = await call('/api/ws/acme/agent', { text: 'what is left?', job: j.id })
    assert.equal(sent.status, 200, JSON.stringify(sent.json))
    assert.equal(sent.json.agent.job, j.id)
    const id = sent.json.agent.id
    await until(async () => (await call(`/api/ws/acme/agent?conv=${id}`)).json.agent.status !== 'running')
    assert.equal((await call(`/api/ws/acme/agent?job=${j.id}`)).json.agent.turns.at(-1).t, 'Seen.')
    assert.deepEqual((await call('/api/ws/acme/agent/convs')).json.convs.map((c: Record<string, string>) => [c.id, c.job, c.title]), [[id, j.id, 'what is left?']])
    assert.equal((await call('/api/ws/acme/agent')).json.agent, null, 'no general conversation yet')
    assert.equal((await call('/api/state')).json.ws.acme.agent, null)
    assert.equal((await call('/api/ws/acme/agent/stop', { conv: id })).json.error.code, 'idle')
    assert.equal((await call('/api/ws/acme/agent/retry', { conv: id })).json.error.code, 'not_failed')
    assert.equal((await call('/api/ws/acme/agent', { text: 'x', conv: 'nope' })).json.error.code, 'not_found')
    for (const p of ['grants', 'undo', 'reintegrate']) assert.equal((await call(`/api/ws/acme/agent/${p}`, {})).json.error.code, 'not_managed', p)
    const general = await call('/api/ws/acme/agent', { text: 'and in general?' })
    assert.equal(general.json.agent.job, undefined)
    assert.deepEqual(prompts.map((p) => p.split('\n').at(-1)), ['what is left?', 'and in general?'])
    assert.match(prompts[0], /^# The job now: A-\d+ “Look”/)
    assert.doesNotMatch(prompts[1], /# The job now/)
  } finally { await m.close() }
})

test('a failed core update shows in /api/state; a managed workspace reintegrates it, and Give up runs update.mjs and closes the conversation', async () => {
  const home = tempDir('main'), root = tempDir('root'), wt = tempDir('wt')
  mkdirSync(join(root, 'workspaces', 'beta2'), { recursive: true })
  writeFileSync(join(root, 'workspaces', 'beta2', 'grants.json'), JSON.stringify({ packs: ['p'] }))
  // a stand-in update.mjs: it drops the record when given up, as the real one does
  mkdirSync(join(root, 'scripts'))
  writeFileSync(join(root, 'scripts', 'update.mjs'), [
    "import { rmSync } from 'node:fs'",
    "if (process.argv.includes('--give-up') && process.argv.includes('--no-restart')) rmSync(process.env.WORK_CONSOLE_HOME + '/update-failed.json')",
    "console.log('ran ' + process.argv.slice(2).join(' '))",
  ].join('\n'))
  const git = (...a: string[]) => execFileSync('git', ['-C', wt, ...a], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
  mkdirSync(join(wt, 'server')); writeFileSync(join(wt, 'server', 'local.ts'), 'export const needDb = 1\n')
  git('add', '-A'); git('commit', '-q', '-m', 'folder')
  const pre = git('rev-parse', 'HEAD')
  writeFileSync(join(wt, 'server', 'local.ts'), 'export const db = 1\n')
  git('add', '-A'); git('commit', '-q', '-m', 'core eeeeeee')
  const f = { core: 'e'.repeat(40), from: 'f'.repeat(40), repo: wt, branch: 'update/eeeeeee', worktree: wt, dir: wt, pre, head: pre, step: 'tests', output: 'not ok 1 - beta2 reads its db', at: '2026-10-08T12:00:00.000Z' }
  writeFileSync(join(home, 'update-failed.json'), JSON.stringify(f))
  const cfg = { ...loadConfig({ WORK_CONSOLE_HOME: home, WORK_CONSOLE_FAKE_GATEWAY: '1' }), loopbackPort: 0 }
  const prompts: string[] = []
  const sdk: Sdk = { ...unused, async *agent(o) { prompts.push(o.prompt); yield { k: 'session', id: 's1' }; yield { k: 'text', t: 'Looking.' }; yield { k: 'result', ok: true } } }
  let restarts = 0
  const m = await main({ cfg, sdk, workspaces: [acmeServer, beta2], root, restart: () => { restarts++ } })
  try {
    const base = `http://127.0.0.1:${m.loopbackPort}`
    const call = async (path: string, body?: unknown) => {
      const r = await fetch(`${base}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: r.status, json: (await r.json()) as Record<string, any> }
    }
    const up = (await call('/api/state')).json.update
    assert.deepEqual([up.core, up.step, up.reintegrable, up.running], [f.core, 'tests', true, null])
    assert.equal((await call('/api/ws/acme/agent/reintegrate', {})).json.error.code, 'not_managed')
    const r = await call('/api/ws/beta2/agent/reintegrate', {})
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.deepEqual(r.json.agent.reintegrate, { core: f.core, from: f.from, branch: f.branch, step: 'tests' })
    await until(() => prompts.length === 1)
    assert.match(prompts[0], /not ok 1 - beta2 reads its db/)
    assert.match(prompts[0], /-export const needDb = 1/)
    let st = (await call('/api/state')).json
    for (const t0 = Date.now(); st.ws.beta2.agent.status === 'running'; st = (await call('/api/state')).json) {
      if (Date.now() - t0 > 5000) throw new Error('the turn never ended')
      await new Promise((ok) => setTimeout(ok, 20))
    }
    const g = await call('/api/update/give-up', {})
    assert.equal(g.json.update?.running, 'give-up', JSON.stringify(g.json))
    for (const t0 = Date.now(); (st = (await call('/api/state')).json).update; ) {
      if (Date.now() - t0 > 10000) throw new Error('give up never ended')
      await new Promise((ok) => setTimeout(ok, 50))
    }
    assert.equal((await call('/api/update/apply', {})).json.error.code, 'no_update')
    assert.equal((await call('/api/ws/beta2/agent', { text: 'and now?' })).json.error.code, 'update_closed')
    assert.equal(restarts, 0)
  } finally { await m.close() }
})
