import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as T from '../../src/model/transitions.ts'
import type { Job } from '../../src/model/types.ts'
import { install } from '../../src/workspace.ts'
import type { FakeGateway } from '../bridge/fake.ts'
import { Bus } from '../events.ts'
import type { Sdk } from '../llm/sdk.ts'
import { Notify } from '../notify/notify.ts'
import { Pairing } from '../pairing/pairing.ts'
import { hub, makeSpace, Spaces } from '../spaces.ts'
import type { Space } from '../spaces.ts'
import { acme, acmeServer } from '../testkit.ts'
import type { Format } from '../voice/format.ts'
import type { Voice } from '../voice/whisper.ts'
import { Settings } from '../settings.ts'
import type { Plugin, WorkspaceServer, WsConfig } from '../workspace.ts'
import { bridgeOf, createApp } from './app.ts'
import type { Bridge } from './app.ts'

/* The whole backend over real sockets: two workspaces, each on its own fake gateway with its store in B,
   and a scripted SDK that drafts at once and builds a form from the first say. acme mints A-NNNN and mounts a test plugin; beta is Acme under
   another id, prefix B, no playbooks of its own and no team zone. */

const STEPS = { once: false, key: 'weekly-report', name: 'Weekly report', description: '', phases: [{ code: 'W', name: 'Write', steps: [{ id: 'w1', title: 'Write it', who: 'llm', doneWhen: 'written' }] }] }
/** every run's prompt, in the order the runs started */
const prompts: string[] = []
const sdk: Sdk = {
  async *start({ tools, prompt }) { prompts.push(prompt); yield { k: 'session', id: 'sess-1' }; await tools.submitDraft('a draft'); yield { k: 'result', ok: true } },
  // a say that starts with "steps:" gets new steps
  async *ask({ prompt }) {
    const say = /^1\. (.*)$/m.exec(prompt)?.[1] ?? ''
    yield { k: 'tool', name: 'knowledge_search', input: { q: 'rate limiting' } }
    yield {
      k: 'result', ok: true, out: say.startsWith('steps:')
        ? { title: 'Weekly report', key: 'weekly-report', project: 'ops', playbook: '', newPlaybook: STEPS, description: say, context: [], due: '', problems: [] }
        : { title: 'Reply to Sam', key: 'ACME-512', project: 'platform', playbook: 'action', description: say, context: [{ k: 'chat', id: 'c4', name: 'Sam Rivera' }], due: '', problems: [] },
    }
  },
}

const echo: Plugin = {
  name: 'echo',
  routes: [
    ['GET', /^\/echo$/, async (r) => ({ x: r.q.get('x') })],
    ['POST', /^\/echo\/([^/]+)$/, async (r) => ({ id: r.p[0], body: await r.body() })],
  ],
  state: () => ({ on: true }),
}
const acmeW: WorkspaceServer = { ...acmeServer, plugins: () => [echo] }
const betaW: WorkspaceServer = { ...acmeServer, page: { ...acme, id: 'beta', playbooks: {} }, jobPrefix: 'B' }
const wsCfg = (dir: string, teamTz: string | null): WsConfig => ({ gatewayUrl: 'http://127.0.0.1:9', consoleTokenPath: join(dir, 'none'), llmTokenPath: join(dir, 'none'), workDir: dir, runTools: [], teamTz, maxSessions: 3 })

async function listen(s: Server) { await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); return (s.address() as AddressInfo).port }

/** swallows only the console.error lines a test expects; anything else still prints */
function expectErrors(t: TestContext, ...pats: RegExp[]) {
  const print = console.error
  t.mock.method(console, 'error', (...a: unknown[]) => { if (!pats.some((p) => p.test(a.map(String).join(' ')))) print(...a) })
}

type Fakes = Record<string, FakeGateway>
/** acme and beta (or acme alone), each on its own fake gateway; `before` runs before the sources start.
    A setup that fails partway closes what it opened, so a red run fails instead of hanging. */
async function setup(o: { page?: boolean; one?: boolean; betaPlugins?: Plugin[]; before?: (f: Fakes) => void; voice?: Voice; format?: Format; root?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wc-http-')), web = join(dir, 'web')
  const list: Space[] = [], servers: Server[] = []
  let h: ReturnType<typeof createApp> | null = null, unhub = () => {}
  const stop = async () => {
    h?.close(); unhub()
    await Promise.allSettled(list.map((s) => s.close()))
    await Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r) })))
  }
  try {
    mkdirSync(web)
    if (o.page !== false) { writeFileSync(join(web, 'index.html'), '<!doctype html><title>Work Console</title>'); writeFileSync(join(web, 'sw.js'), '// sw') }
    const beta = o.betaPlugins ? { ...betaW, plugins: () => o.betaPlugins! } : betaW
    const ws: [WorkspaceServer, string | null][] = o.one ? [[acmeW, 'Europe/Berlin']] : [[acmeW, 'Europe/Berlin'], [beta, null]]
    install(ws.map(([w]) => ({ page: w.page })))
    for (const [w, tz] of ws) list.push(await makeSpace(w, { cfg: wsCfg(dir, tz), home: dir, artifactsDir: join(dir, 'arts'), sdk, fake: true, push: async () => {}, root: o.root }))
    const spaces = new Spaces(list), bus = new Bus()
    unhub = hub(list, bus)
    const fakes: Fakes = Object.fromEntries(list.map((s) => [s.id, s.fake!]))
    const pairing = new Pairing(join(dir, 'home'))
    const notify = new Notify({ dir: join(dir, 'home'), bus, ctx: () => spaces.ctx(), jobFor: () => undefined, sender: { send: async () => ({ status: 201 }) } })
    const loop = createServer((q, s) => h!.loopback(q, s)), lanS = createServer((q, s) => h!.lan(q, s))
    servers.push(loop, lanS)
    const lp = await listen(loop), np = await listen(lanS)
    h = createApp({ loopbackPort: lp, lanPort: 7411, pcName: 'pc', hub: bus, spaces, pairing, notify, staticDirs: [web], artifactsDir: join(dir, 'arts'), tz: 'Asia/Tokyo', settings: new Settings(dir), voice: o.voice, format: o.format })
    o.before?.(fakes)
    for (const s of list) s.source.start()
    await until(() => list.every((s) => s.source.available()))
    return { fakes, spaces, pairing, lp, np, stop, dir }
  } catch (e) {
    await stop().catch(() => {})
    throw e
  }
}
async function until(f: () => boolean | Promise<boolean>, ms = 3000) {
  const t0 = Date.now()
  while (!(await f())) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 10)) }
}

type Out = { status: number; headers: Record<string, string | string[] | undefined>; text: string; json: any }
function call(port: number, method: string, path: string, o: { host?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Out> {
  return new Promise((ok, no) => {
    const body = o.body === undefined ? undefined : JSON.stringify(o.body)
    const q = request({
      host: '127.0.0.1', port, method, path,
      headers: { host: o.host ?? `127.0.0.1:${port}`, ...(body ? { 'content-type': 'application/json' } : {}), ...o.headers },
    }, (res) => {
      let t = ''
      res.setEncoding('utf8'); res.on('data', (c) => { t += c })
      res.on('end', () => { let j: unknown; try { j = JSON.parse(t) } catch { j = undefined } ok({ status: res.statusCode!, headers: res.headers, text: t, json: j }) })
    })
    q.on('error', no)
    q.end(body)
  })
}
/** a started job in the workspace, made over HTTP, and its open step */
async function openStep(lp: number, ws = 'acme', t = 'An open step') {
  const made = await call(lp, 'POST', '/api/jobs', { body: { t, key: 'NEW', pb: 'action', prj: 'platform', ws } })
  assert.equal(made.status, 200, made.text)
  const r = await call(lp, 'POST', `/api/jobs/${made.json.job.id}/cmd`, { body: { cmd: { op: 'start' }, v: made.json.job.v } })
  assert.equal(r.status, 200, r.text)
  const job = r.json.job as Job
  return { job, step: Object.keys(job.flow).find((k) => T.isLive(job.flow[k]))! }
}

test('loopback refuses a foreign Host (DNS rebinding) and a cross-site Origin, allows its own', async () => {
  const { lp, stop } = await setup()
  try {
    assert.equal((await call(lp, 'GET', '/api/state', { host: `evil.example:${lp}` })).status, 403)
    assert.equal((await call(lp, 'GET', '/', { host: `evil.example:${lp}` })).status, 403)
    assert.equal((await call(lp, 'GET', '/api/state', { headers: { origin: 'https://evil.example' } })).status, 403)
    assert.equal((await call(lp, 'GET', '/api/state', { headers: { origin: `http://localhost:${lp}` } })).status, 200)
    assert.equal((await call(lp, 'GET', '/api/state', { host: `localhost:${lp}` })).status, 200)
    const form = await call(lp, 'POST', '/api/undo', { headers: { 'content-type': 'text/plain' } })
    assert.equal(form.status, 415, 'a form post cannot reach the API')
    assert.equal((await call(lp, 'POST', '/api/ws/acme/act', { headers: { 'content-type': 'text/plain' } })).status, 415)
  } finally { await stop() }
})

test('LAN: the page is public, the API needs a paired cookie, pairing and devices are PC-only', async () => {
  const { np, lp, pairing, stop } = await setup()
  const host = 'pc:7411'
  try {
    assert.equal((await call(np, 'GET', '/', { host })).status, 200)
    assert.equal((await call(np, 'GET', '/api/state', { host })).status, 401)
    assert.equal((await call(np, 'GET', '/api/ws/acme/sources', { host })).status, 401)
    assert.equal((await call(np, 'POST', '/api/pair/new', { host, body: {} })).status, 403)
    assert.equal((await call(np, 'GET', '/api/devices', { host })).status, 403)
    assert.equal((await call(np, 'GET', '/api/settings', { host })).status, 403)
    assert.equal((await call(np, 'GET', '/api/jobs/A-0001/steps/s1/open', { host })).status, 403)

    const made = await call(lp, 'POST', '/api/pair/new', { body: {} })
    assert.equal(made.status, 200)
    assert.match(made.json.qr, /^<svg/)
    const code = new URL(made.json.url).searchParams.get('code')!
    assert.equal(new URL(made.json.url).host, 'pc:7411')

    const p = await call(np, 'GET', `/pair?code=${code}`, { host, headers: { 'user-agent': 'Mozilla (iPhone)' } })
    assert.equal(p.status, 302); assert.equal(p.headers.location, '/')
    const ck = String(p.headers['set-cookie'])
    for (const a of ['HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(ck.includes(a), a)
    const cookie = ck.split(';')[0]
    assert.equal((await call(np, 'GET', `/pair?code=${code}`, { host })).status, 403, 'a code works once')

    const st = await call(np, 'GET', '/api/state', { host, headers: { cookie } })
    assert.equal(st.status, 200); assert.equal(st.json.side, 'lan'); assert.ok(st.json.device)
    assert.equal((await call(np, 'GET', '/api/state', { host, headers: { cookie, origin: 'https://evil.example' } })).status, 403)

    const devs = await call(lp, 'GET', '/api/devices')
    assert.equal(devs.json.devices[0].name, 'iPhone')
    assert.equal((await call(lp, 'DELETE', `/api/devices/${devs.json.devices[0].id}`)).status, 200)
    assert.equal((await call(np, 'GET', '/api/state', { host, headers: { cookie } })).status, 401, 'revoked')
    assert.equal(pairing.devices().length, 0)
  } finally { await stop() }
})

test('state: the PC zone in home, one block per workspace with its jobs, playbooks, bridge and plugins', async () => {
  const { lp, stop } = await setup()
  try {
    await openStep(lp, 'acme')
    const st = await call(lp, 'GET', '/api/state')
    assert.equal(st.status, 200, st.text)
    assert.deepEqual(st.json.home, { tz: 'Asia/Tokyo', pc: 'pc' })
    assert.ok(st.json.push.key); assert.equal(st.json.side, 'loopback')
    assert.equal(st.json.update, null, 'no updater: no failed update')
    assert.equal((await call(lp, 'POST', '/api/update/apply', { body: {} })).json.error.code, 'no_updates')
    assert.deepEqual(Object.keys(st.json.ws), ['acme', 'beta'])
    const { acme: a, beta: b } = st.json.ws
    for (const w of [a, b]) {
      for (const k of ['jobs', 'runs', 'marks', 'parts', 'playbooks', 'templates', 'bridge', 'plugins']) assert.ok(k in w, k)
      assert.deepEqual(w.parts, { jobs: 'ok', runs: 'ok', marks: 'ok' }); assert.equal(w.bridge.state, 'ok')
      assert.equal(w.bridge.via, 'gateway'); assert.equal(w.bridge.why, '')
      assert.ok(Object.keys(w.bridge.concepts).length > 0)
    }
    assert.deepEqual(a.jobs.map((j: Job) => j.id), ['A-0001']); assert.deepEqual(b.jobs, [])
    assert.ok(a.playbooks['dev-item']); assert.equal(b.playbooks['dev-item'], undefined, "beta brings none of acme's playbooks")
    assert.ok(a.playbooks.action && b.playbooks.action, 'the core playbooks are in both')
    assert.deepEqual(a.plugins, { echo: { on: true } }); assert.deepEqual(b.plugins, {})
  } finally { await stop() }
})

test("a plugin whose state() throws keeps /api/state up: its block carries the error, the others are intact", async (t) => {
  expectErrors(t, /workspace beta: plugin boom state failed/)
  const boom: Plugin = { name: 'boom', routes: [], state: () => { throw new Error('no billing repo') } }
  const { lp, stop } = await setup({ betaPlugins: [boom] })
  try {
    const st = await call(lp, 'GET', '/api/state')
    assert.equal(st.status, 200, st.text)
    assert.deepEqual(st.json.ws.beta.plugins, { boom: { error: 'no billing repo' } })
    assert.deepEqual(st.json.ws.acme.plugins, { echo: { on: true } })
    assert.deepEqual(st.json.ws.acme.parts, { jobs: 'ok', runs: 'ok', marks: 'ok' }); assert.equal(st.json.ws.acme.bridge.state, 'ok')
    assert.deepEqual(st.json.ws.beta.parts, { jobs: 'ok', runs: 'ok', marks: 'ok' })
  } finally { await stop() }
})

test('a job id finds its workspace by prefix; an id no workspace owns is 404, never a 500', async () => {
  const { lp, spaces, stop } = await setup()
  try {
    const a = await call(lp, 'POST', '/api/jobs', { body: { t: 'in acme', key: 'NEW', pb: 'action', prj: 'platform', ws: 'acme' } })
    const b = await call(lp, 'POST', '/api/jobs', { body: { t: 'in beta', key: 'NEW', pb: 'action', prj: 'platform', ws: 'beta' } })
    assert.equal(a.json.job.id, 'A-0001'); assert.equal(b.json.job.id, 'B-0001')
    assert.equal(a.json.job.ws, 'acme'); assert.equal(b.json.job.ws, 'beta')

    const ga = await call(lp, 'GET', '/api/jobs/A-0001')
    assert.equal(ga.status, 200, ga.text); assert.equal(ga.json.job.t, 'in acme')
    assert.equal((await call(lp, 'GET', '/api/jobs/B-0001')).json.job.t, 'in beta')
    // acme's store holds A-0001 and beta's does not
    assert.ok(await spaces.get('acme').jobs.get('A-0001')); assert.equal(await spaces.get('beta').jobs.get('A-0001'), undefined)

    const x = await call(lp, 'GET', '/api/jobs/X-0001')
    assert.equal(x.status, 404); assert.deepEqual(x.json.error, { code: 'not_found', message: 'no job X-0001' })
    assert.equal((await call(lp, 'GET', '/api/jobs/A-0099')).status, 404)
    assert.equal((await call(lp, 'GET', '/api/jobs/nodash')).status, 404)
    assert.equal((await call(lp, 'POST', '/api/jobs/X-0001/cmd', { body: { cmd: { op: 'start' }, v: 1 } })).status, 404)
    assert.equal((await call(lp, 'POST', '/api/undo', { body: { job: 'X-0001', v: 2, prev: {} } })).status, 404)

    const all = await call(lp, 'GET', '/api/jobs')
    assert.deepEqual(all.json.jobs.map((j: Job) => j.id).sort(), ['A-0001', 'B-0001'])
    assert.deepEqual(all.json.parts, { acme: 'ok', beta: 'ok' })

    const none = await call(lp, 'POST', '/api/jobs', { body: { t: 'where?', key: 'NEW', pb: 'action', prj: 'platform' } })
    assert.equal(none.status, 400); assert.equal(none.json.error.message, 'say which workspace: acme, beta')
    assert.equal((await call(lp, 'POST', '/api/jobs', { body: { t: 'where?', key: 'NEW', pb: 'action', prj: 'platform', ws: 'zzz' } })).json.error.code, 'no_workspace')

    // an A- id sitting in beta's store is still not found: routing goes by prefix, never falls through to another workspace
    await spaces.get('beta').store.putJob({ ...structuredClone(b.json.job as Job), id: 'A-0005', t: 'stray' }, null)
    assert.equal((await spaces.get('beta').jobs.get('A-0005'))?.t, 'stray')
    const stray = await call(lp, 'GET', '/api/jobs/A-0005')
    assert.equal(stray.status, 404, stray.text); assert.deepEqual(stray.json.error, { code: 'not_found', message: 'no job A-0005' })
  } finally { await stop() }
})

test('a command round trip, a stale version is 409 with the current job, undo', async () => {
  const { lp, stop } = await setup()
  try {
    const { job, step } = await openStep(lp)
    const r = await call(lp, 'POST', `/api/jobs/${job.id}/cmd`, { body: { cmd: { op: 'noteAdd', step, k: 'q', t: 'why?' }, v: job.v } })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.job.v, job.v! + 1); assert.equal(r.json.prev.v, job.v)

    const stale = await call(lp, 'POST', `/api/jobs/${job.id}/cmd`, { body: { cmd: { op: 'noteAdd', step, k: 'q', t: 'again' }, v: job.v } })
    assert.equal(stale.status, 409); assert.equal(stale.json.error.code, 'conflict'); assert.equal(stale.json.job.v, job.v! + 1)

    const bad = await call(lp, 'POST', `/api/jobs/${job.id}/cmd`, { body: { cmd: { op: 'runDraft', step, t: 'x' } } })
    assert.equal(bad.status, 400, 'the page cannot send runner ops')

    // a prev that names another workspace cannot move the job there
    const u = await call(lp, 'POST', '/api/undo', { body: { job: job.id, v: r.json.job.v, prev: { ...r.json.prev, ws: 'beta' } } })
    assert.equal(u.status, 200, u.text); assert.equal(u.json.job.ws, 'acme')
    assert.equal((await call(lp, 'GET', `/api/jobs/${job.id}`)).json.job.ws, 'acme')
    assert.equal(u.json.job.flow[step].b.length, job.flow[step].b.length); assert.equal(r.json.job.flow[step].b.length, job.flow[step].b.length + 1)
    assert.equal((await call(lp, 'POST', '/api/undo', { body: { job: job.id, v: r.json.job.v, prev: r.json.prev } })).status, 409)
  } finally { await stop() }
})

test("runs: found in whichever workspace's runner knows them; an unknown run is 404", async () => {
  const { lp, fakes, stop } = await setup()
  try {
    assert.equal((await call(lp, 'GET', '/api/runs/nope')).status, 404)
    assert.deepEqual((await call(lp, 'GET', '/api/runs/nope')).json.error, { code: 'not_found', message: 'no run nope' })
    assert.equal((await call(lp, 'POST', '/api/runs/nope/cancel', { body: {} })).status, 404)
    assert.equal((await call(lp, 'POST', '/api/runs', { body: { job: 'X-0001', step: 's', instruction: 'go' } })).status, 404)

    const { job, step } = await openStep(lp, 'beta')
    const a = await call(lp, 'POST', '/api/runs', { body: { job: job.id, step, instruction: 'draft it' } })
    assert.equal(a.status, 200, a.text)
    const id = a.json.run.id as string
    await until(async () => (await call(lp, 'GET', `/api/runs/${id}`)).json.run?.state === 'draft')
    const all = await call(lp, 'GET', '/api/runs')
    assert.deepEqual(all.json.runs.map((r: { id: string }) => r.id), [id]); assert.deepEqual(all.json.parts, { acme: 'ok', beta: 'ok' })
    assert.equal((await call(lp, 'POST', `/api/runs/${id}/cancel`, { body: {} })).status, 409, 'cancel reaches the owning runner')

    // acme going away does not hide beta's run; a run nobody can vouch for is not "no run"
    fakes.acme.setDown(true)
    await until(async () => (await call(lp, 'GET', '/api/state')).json.ws.acme.bridge.state === 'unavailable')
    assert.equal((await call(lp, 'GET', `/api/runs/${id}`)).status, 200)
    assert.equal((await call(lp, 'GET', '/api/runs/nope')).status, 503)
    const some = await call(lp, 'GET', '/api/runs')
    assert.equal(some.status, 200); assert.deepEqual(some.json.parts, { acme: 'unavailable', beta: 'ok' })
  } finally { await stop() }
})

test('with one bridge down its command, act and ask are 503 and its block says unavailable; the other carries on', async () => {
  const { lp, fakes, stop } = await setup()
  try {
    const { job, step } = await openStep(lp, 'acme')
    await openStep(lp, 'beta')
    fakes.acme.setDown(true)
    await until(async () => (await call(lp, 'GET', '/api/state')).json.ws.acme.bridge.state === 'unavailable')
    assert.equal((await call(lp, 'POST', `/api/jobs/${job.id}/cmd`, { body: { cmd: { op: 'noteAdd', step, k: 'q', t: 'x' } } })).status, 503)
    assert.equal((await call(lp, 'POST', '/api/ws/acme/act', { body: { action: 'work.comment', args: { id: 'x', text: 'hi' } } })).status, 503)
    assert.equal((await call(lp, 'POST', '/api/runs', { body: { job: job.id, step, instruction: 'go' } })).status, 503)
    const src = await call(lp, 'GET', '/api/ws/acme/sources?concepts=chat,mail')
    assert.equal(src.status, 200)
    assert.notEqual(src.json.concepts.chat.status, 'ok'); assert.notEqual(src.json.concepts.mail.status, 'ok')
    assert.equal((await call(lp, 'GET', '/api/ws/beta/sources?concepts=chat')).json.concepts.chat.status, 'ok')

    const st = (await call(lp, 'GET', '/api/state')).json
    assert.deepEqual(st.ws.acme.parts, { jobs: 'unavailable', runs: 'unavailable', marks: 'unavailable' })
    assert.equal(st.ws.beta.bridge.state, 'ok'); assert.deepEqual(st.ws.beta.parts, { jobs: 'ok', runs: 'ok', marks: 'ok' })
    assert.deepEqual(st.ws.beta.jobs.map((j: Job) => j.id), ['B-0001'])
    const jobs = await call(lp, 'GET', '/api/jobs')
    assert.equal(jobs.status, 200); assert.deepEqual(jobs.json.jobs.map((j: Job) => j.id), ['B-0001'])
    assert.deepEqual(jobs.json.parts, { acme: 'unavailable', beta: 'ok' })
  } finally { await stop() }
})

test('a state store that cannot be read shows as unavailable, not as no jobs', async (t) => {
  expectErrors(t, /loading the state from the bridge failed/)
  const { lp, fakes, stop } = await setup({ before: (f) => f.acme.setSource('runs', 'source_unavailable') })
  try {
    const st = await call(lp, 'GET', '/api/state')
    assert.equal(st.status, 200); assert.equal(st.json.ws.acme.bridge.state, 'ok')
    assert.deepEqual(st.json.ws.acme.parts, { jobs: 'unavailable', runs: 'unavailable', marks: 'unavailable' })
    assert.deepEqual(st.json.ws.beta.parts, { jobs: 'ok', runs: 'ok', marks: 'ok' })
    fakes.acme.setSource('runs', null)
    assert.deepEqual((await call(lp, 'GET', '/api/state')).json.ws.acme.parts, { jobs: 'ok', runs: 'ok', marks: 'ok' })
  } finally { await stop() }
})

test('a bridge block says what is down and why: a store source names itself, a gateway is the default', () => {
  const src = (up: boolean, more: object = {}) => ({ source: { available: () => up, concepts: () => ({}), ...more } as unknown as Bridge })
  assert.deepEqual(bridgeOf(src(false, { via: 'store', why: () => 'Postgres not running' })), { state: 'unavailable', concepts: {}, via: 'store', why: 'Postgres not running' })
  assert.deepEqual(bridgeOf(src(true, { via: 'store', why: () => 'stale' })), { state: 'ok', concepts: {}, via: 'store', why: '' })
  assert.deepEqual(bridgeOf(src(false)), { state: 'unavailable', concepts: {}, via: 'gateway', why: '' })
})

test('SSE opens with one bridge frame per workspace; a job event carries its workspace', async () => {
  const { lp, fakes, stop } = await setup()
  try {
    const { job, step } = await openStep(lp, 'beta')
    const got: string[] = []
    const sse = request({ host: '127.0.0.1', port: lp, path: '/api/events', headers: { host: `127.0.0.1:${lp}` } }, (res) => {
      assert.match(String(res.headers['content-type']), /text\/event-stream/)
      res.setEncoding('utf8'); res.on('data', (c: string) => { got.push(c) })
    })
    sse.end()
    const frames = () => got.join('').split('\n\n').filter((f) => f.startsWith('event: ')).map((f) => {
      const [ev, data] = f.split('\n')
      return { kind: ev.slice(7), data: JSON.parse(data.slice(6)) }
    })
    await until(() => frames().filter((f) => f.kind === 'bridge').length === 2)
    assert.deepEqual(frames().slice(0, 2).map((f) => [f.kind, f.data.ws, f.data.state]), [['bridge', 'acme', 'ok'], ['bridge', 'beta', 'ok']])
    await call(lp, 'POST', `/api/jobs/${job.id}/cmd`, { body: { cmd: { op: 'noteAdd', step, k: 'q', t: 'sse' }, v: job.v } })
    await until(() => frames().some((f) => f.kind === 'job'))
    const e = frames().find((f) => f.kind === 'job')!.data
    assert.equal(e.job.id, job.id); assert.equal(e.ws, 'beta')
    // the write's own delta comes back as a source frame; a later delta on the same stream is the barrier behind it
    fakes.beta.emitDelta({ concept: 'chat', upserts: [] })
    await until(() => frames().some((f) => f.kind === 'source' && f.data.concept === 'chat'))
    const src = frames().filter((f) => f.kind === 'source')
    assert.deepEqual(src.map((f) => [f.data.concept, f.data.ws]), [['jobs', 'beta'], ['chat', 'beta']])
    assert.deepEqual(src[0].data.upserts, [], 'a source frame tells the page what to re-read, never the documents')
    assert.equal(frames().filter((f) => f.kind === 'job').length, 1, 'one change, one job frame')
    sse.destroy()
  } finally { await stop() }
})

test('sources come in page shapes; an act resolves the chat name and reaches only its own gateway', async () => {
  const { lp, fakes, spaces, stop } = await setup()
  try {
    const src = await call(lp, 'GET', '/api/ws/acme/sources?concepts=chat,mail,cal,work')
    assert.equal(src.json.concepts.chat.status, 'ok')
    const chat = src.json.concepts.chat.items[0]
    assert.ok(chat.name && Array.isArray(chat.msgs))
    const mail = src.json.concepts.mail.items[0]
    assert.ok(['reply', 'wait', 'fyi', 'auto'].includes(mail.cat))
    assert.ok(src.json.concepts.cal.items.every((e: { b: string }) => /^\d\d:\d\d$/.test(e.b)))

    await call(lp, 'POST', `/api/ws/acme/mail/${encodeURIComponent(mail.id)}/mark`, { body: { done: true } })
    await until(async () => (await call(lp, 'GET', '/api/ws/acme/sources?concepts=mail')).json.concepts.mail.items.find((m: { id: string }) => m.id === mail.id).done === true)
    assert.equal((await spaces.get('acme').store.marks())[mail.id].done, true)
    assert.equal((await spaces.get('beta').store.marks())[mail.id], undefined, "a mark lands in its own workspace's store")

    const one = await call(lp, 'GET', `/api/ws/acme/sources/chat/${encodeURIComponent(chat.id)}`)
    assert.equal(one.status, 200, one.text)
    assert.ok(Array.isArray(one.json.item.messages))

    const a = await call(lp, 'POST', '/api/ws/acme/act', { body: { action: 'chat.post', actionId: 'act-1', args: { chatName: chat.name.toUpperCase(), text: 'hello' } } })
    assert.equal(a.status, 200, a.text); assert.equal(a.json.status, 'ok'); assert.equal(a.json.actionId, 'act-1')
    assert.deepEqual(fakes.acme.acts.at(-1), { action: 'chat.post', actionId: 'act-1', args: { chat: chat.id, text: 'hello' } })
    assert.deepEqual(fakes.beta.acts, [], "an act in acme never reaches beta's gateway")
    assert.equal((await call(lp, 'POST', '/api/ws/acme/act', { body: { action: 'chat.post', args: { chatName: 'no such chat', text: 'x' } } })).json.error.code, 'unknown_chat')
    assert.equal((await call(lp, 'POST', '/api/ws/acme/act', { body: { action: 'rm -rf', args: {} } })).status, 400)
    assert.equal((await call(lp, 'DELETE', '/api/ws/acme/sources')).status, 405)
  } finally { await stop() }
})

test("a managed workspace acts only through what its granted packs declare and its grants name", async () => {
  const root = mkdtempSync(join(tmpdir(), 'wc-root-'))
  mkdirSync(join(root, 'workspaces', 'acme'), { recursive: true })
  writeFileSync(join(root, 'workspaces', 'acme', 'grants.json'), JSON.stringify({
    packs: ['m365-teams', 'm365-mail'], hosts: ['teams.microsoft.com', 'outlook.office.com', 'graph.microsoft.com'], acts: ['chat.post'],
  }))
  const { lp, fakes, stop } = await setup({ one: true, root })
  try {
    for (const [action, args] of [['work.comment', { id: 'x', text: 'hi' }], ['mail.send', { to: ['a@b.example'], subject: 's', body: 'b' }]] as const) {
      const no = await call(lp, 'POST', '/api/ws/acme/act', { body: { action, args } })
      assert.equal(no.json.error?.code, 'unknown_action', `${action}: ${no.text}`)
    }
    const chat = (await call(lp, 'GET', '/api/ws/acme/sources?concepts=chat')).json.concepts.chat.items[0]
    const a = await call(lp, 'POST', '/api/ws/acme/act', { body: { action: 'chat.post', args: { chatName: chat.name, text: 'hello' } } })
    assert.equal(a.status, 200, a.text)
    assert.deepEqual(fakes.acme.acts.map((x) => x.action), ['chat.post'])
  } finally { await stop() }
})

test("calendar times read in the workspace's team zone; a workspace without one gets none", async () => {
  const { lp, stop } = await setup()
  try {
    const a = (await call(lp, 'GET', '/api/ws/acme/sources?concepts=cal')).json.concepts.cal.items as { v: string }[]
    const b = (await call(lp, 'GET', '/api/ws/beta/sources?concepts=cal')).json.concepts.cal.items as { v: string }[]
    assert.ok(a.length > 0 && a.every((e) => /^\d\d:\d\d$/.test(e.v)), JSON.stringify(a))
    assert.ok(b.length > 0 && b.every((e) => e.v === ''), JSON.stringify(b))
  } finally { await stop() }
})

test('an unknown workspace is 404 no_workspace; a malformed one is 400', async () => {
  const { lp, stop } = await setup()
  try {
    const z = await call(lp, 'GET', '/api/ws/zzz/sources')
    assert.equal(z.status, 404); assert.deepEqual(z.json.error, { code: 'no_workspace', message: 'no workspace zzz' })
    assert.equal((await call(lp, 'POST', '/api/ws/zzz/act', { body: {} })).json.error.code, 'no_workspace')
    assert.equal((await call(lp, 'GET', '/api/ws/%ZZ/sources')).status, 400)
    assert.equal((await call(lp, 'GET', '/api/ws/acme/nothing-here')).status, 404)
  } finally { await stop() }
})

test("a plugin's routes answer under its own workspace only, and its state() is that workspace's block", async () => {
  const { lp, stop } = await setup()
  try {
    const g = await call(lp, 'GET', '/api/ws/acme/echo?x=hi')
    assert.equal(g.status, 200, g.text); assert.deepEqual(g.json, { x: 'hi' })
    const p = await call(lp, 'POST', `/api/ws/acme/echo/${encodeURIComponent('a b')}`, { body: { k: 1 } })
    assert.deepEqual(p.json, { id: 'a b', body: { k: 1 } })
    assert.equal((await call(lp, 'DELETE', '/api/ws/acme/echo')).status, 405)
    const b = await call(lp, 'GET', '/api/ws/beta/echo')
    assert.equal(b.status, 404); assert.equal(b.json.error.code, 'not_found')
  } finally { await stop() }
})

test('playbooks: saved in their own workspace; an id another workspace owns is 409 playbook_taken', async () => {
  const { lp, stop } = await setup()
  try {
    const dev = structuredClone(acme.playbooks['dev-item'])
    const taken = await call(lp, 'PUT', '/api/ws/beta/playbooks/dev-item', { body: { pb: { ...dev, ws: 'beta', custom: 1 } } })
    assert.equal(taken.status, 409, taken.text)
    assert.deepEqual(taken.json.error, { code: 'playbook_taken', message: 'dev-item belongs to workspace acme' })

    const own = await call(lp, 'PUT', '/api/ws/acme/playbooks/dev-item', { body: { pb: { ...dev, n: 'Dev item, edited' } } })
    assert.equal(own.status, 200, own.text); assert.equal(own.json.playbooks['dev-item'].n, 'Dev item, edited')

    const mine = await call(lp, 'PUT', '/api/ws/beta/playbooks/mine', { body: { pb: { ...dev, ws: 'beta', n: 'Mine', custom: 1 } } })
    assert.equal(mine.status, 200, mine.text); assert.ok(mine.json.playbooks.mine)
    // a body that names another workspace is refused, and nothing is saved in either
    const other = await call(lp, 'PUT', '/api/ws/beta/playbooks/mine2', { body: { pb: { ...dev, ws: 'acme', n: 'Mine 2', custom: 1 } } })
    assert.equal(other.status, 400, other.text); assert.equal(other.json.error.code, 'bad_args')
    const st = (await call(lp, 'GET', '/api/state')).json
    assert.ok(st.ws.beta.playbooks.mine); assert.equal(st.ws.acme.playbooks.mine, undefined)
    assert.equal(st.ws.beta.playbooks.mine2, undefined); assert.equal(st.ws.acme.playbooks.mine2, undefined)
    const del = await call(lp, 'DELETE', '/api/ws/beta/playbooks/mine')
    assert.equal(del.status, 200, del.text); assert.equal(del.json.playbooks.mine, undefined)
  } finally { await stop() }
})

test('playbooks: a saved one keeps its planned messages, which may name only its own steps', async () => {
  const { lp, stop } = await setup()
  try {
    const pb = { n: 'Tell', custom: 1, ph: [{ c: 'TL', n: 'Tell', s: [{ id: 'tell/post', fid: 'post', t: 'Post it', m: 'you', x: 'Posted', msg: 1 }] }] }
    const msg = [['chat', 'team chat', 'hi all, {key} is done.']]
    const ok = await call(lp, 'PUT', '/api/ws/acme/playbooks/tell', { body: { pb, tpl: { 'tell/post': msg } } })
    assert.equal(ok.status, 200, ok.text); assert.deepEqual(ok.json.templates['tell/post'], msg)
    const builtin = Object.keys(acme.templates!)[0]
    assert.ok(ok.json.templates[builtin], 'the built-in ones stay')
    const st = (await call(lp, 'GET', '/api/state')).json
    assert.deepEqual(st.ws.acme.templates['tell/post'], msg); assert.equal(st.ws.beta.templates['tell/post'], undefined)

    const foreign = await call(lp, 'PUT', '/api/ws/acme/playbooks/tell', { body: { pb, tpl: { [builtin]: msg } } })
    assert.equal(foreign.status, 400, foreign.text)
    assert.equal(foreign.json.error.message, `tpl names step ${builtin}, which the playbook does not have`)
    const bad = await call(lp, 'PUT', '/api/ws/acme/playbooks/tell', { body: { pb, tpl: { 'tell/post': [['chat', 'only two']] } } })
    assert.equal(bad.status, 400, bad.text); assert.equal(bad.json.error.message, "tpl tell/post must be a list of [via, to, text], a mail's with {cc, subject}")
    const mail = [['mail', 'a@x.example', 'hi', { cc: 'b@x.example', subject: 'Done' }]]
    const withHead = await call(lp, 'PUT', '/api/ws/acme/playbooks/tell', { body: { pb, tpl: { 'tell/post': mail } } })
    assert.equal(withHead.status, 200, withHead.text); assert.deepEqual(withHead.json.templates['tell/post'], mail)
    const chatHead = await call(lp, 'PUT', '/api/ws/acme/playbooks/tell', { body: { pb, tpl: { 'tell/post': [['chat', 'team', 'hi', { subject: 'x' }]] } } })
    assert.equal(chatHead.status, 400, chatHead.text)
    assert.equal((await call(lp, 'PUT', '/api/ws/acme/playbooks/tell', { body: { pb, tpl: { 'tell/post': msg } } })).status, 200)
    const shapeless = await call(lp, 'PUT', '/api/ws/acme/playbooks/tell', { body: { pb: { n: 'No phases' } } })
    assert.equal(shapeless.status, 400, shapeless.text); assert.equal(shapeless.json.error.code, 'bad_args')
    assert.deepEqual((await call(lp, 'GET', '/api/state')).json.ws.acme.templates['tell/post'], msg, 'a refused save changes nothing')

    const del = await call(lp, 'DELETE', '/api/ws/acme/playbooks/tell')
    assert.equal(del.status, 200, del.text); assert.equal(del.json.templates['tell/post'], undefined); assert.ok(del.json.templates[builtin])
  } finally { await stop() }
})

test('a job made from a meeting carries the event and is due when it starts', async () => {
  const { lp, stop } = await setup()
  try {
    const items = (await call(lp, 'GET', '/api/ws/acme/sources?concepts=cal')).json.concepts.cal.items
    const e = items.find((x: { start?: string }) => Date.parse(x.start!) > Date.now()) ?? items[0]
    assert.ok(e.id && e.day && e.start && e.end && e.org, JSON.stringify(e))
    const base = { t: e.t, key: 'NEW', pb: 'action', prj: 'platform', ws: 'acme' }
    const r = await call(lp, 'POST', '/api/jobs', { body: { ...base, src: `Zoom · ${e.t}`, ev: e.id, due: e.start } })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.job.ev, e.id); assert.equal(r.json.job.due, e.start)
    assert.ok((await call(lp, 'GET', '/api/jobs')).json.jobs.some((j: Job) => j.id === r.json.job.id && j.ev === e.id))
    assert.equal((await call(lp, 'POST', '/api/jobs', { body: { ...base, due: 2026 } })).status, 400)
    assert.equal((await call(lp, 'POST', '/api/jobs', { body: { ...base, ev: { id: 1 } } })).status, 400)
    assert.equal((await call(lp, 'POST', '/api/jobs', { body: { ...base, due: 'soon' } })).json.error.code, 'bad_args')
  } finally { await stop() }
})

test('a new job takes a description and its context as given; a bad one is refused', async () => {
  const { lp, stop } = await setup()
  try {
    const base = { t: 'Described', key: 'NEW', pb: 'action', prj: 'platform', ws: 'acme' }
    const r = await call(lp, 'POST', '/api/jobs', { body: { ...base, d: 'Why it **matters**.', ctx: [{ k: 'chat', id: 'c4', n: 5 }] } })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.job.d, 'Why it **matters**.'); assert.deepEqual(r.json.job.ctx, [{ k: 'chat', id: 'c4', n: 5 }])
    assert.equal((await call(lp, 'POST', '/api/jobs', { body: { ...base, d: 5 } })).status, 400)
    assert.equal((await call(lp, 'POST', '/api/jobs', { body: { ...base, ctx: 'c4' } })).json.error.code, 'bad_args')
    assert.equal((await call(lp, 'POST', '/api/jobs', { body: { ...base, ctx: [{ k: 'chat', id: 'c4', n: 99 }] } })).status, 400)
  } finally { await stop() }
})

test("board Start: the workspace's own Start moves a free item on its own gateway; a taken item is refused", async () => {
  const { lp, fakes, spaces, stop } = await setup()
  try {
    const r = await call(lp, 'POST', '/api/ws/acme/board/ACME-603/start', { body: {} })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.created, true); assert.equal(r.json.job.key, 'ACME-603'); assert.equal(r.json.job.st, 'active')
    assert.equal(r.json.job.t, 'Projects grid: export ignores the filter'); assert.equal(r.json.job.id, 'A-0001')
    assert.equal((await spaces.get('acme').jobs.get(r.json.job.id))!.pb, 'dev-item')
    assert.deepEqual(fakes.acme.acts.map((a) => [a.action, a.args]), [['work.start', { id: 'ACME-603' }]])
    const item = (await call(lp, 'GET', '/api/ws/acme/sources?concepts=board')).json.concepts.board.items.find((i: { id: string }) => i.id === 'ACME-603')
    assert.deepEqual([item.lane, item.column, item.assignedTo], ['mine', 'Dev', 'You'])
    const no = await call(lp, 'POST', '/api/ws/acme/board/ACME-530/start', { body: {} })
    assert.equal(no.status, 400); assert.equal(no.json.error.code, 'refused'); assert.equal(no.json.error.message, 'ACME-530 is assigned to Sam Rivera')

    // beta has no dev-item of its own; with a playbook named, its Start mints B and acts on beta's gateway only
    const acmeActs = fakes.acme.acts.length
    const nb = await call(lp, 'POST', '/api/ws/beta/board/ACME-603/start', { body: {} })
    assert.equal(nb.status, 400); assert.equal(nb.json.error.message, 'no playbook dev-item')
    const b = await call(lp, 'POST', '/api/ws/beta/board/ACME-603/start', { body: { pb: 'action' } })
    assert.equal(b.status, 200, b.text); assert.equal(b.json.job.id, 'B-0001'); assert.equal(b.json.job.ws, 'beta')
    assert.deepEqual(fakes.beta.acts.map((a) => [a.action, a.args]), [['work.start', { id: 'ACME-603' }]])
    assert.equal(fakes.acme.acts.length, acmeActs)
  } finally { await stop() }
})

test('chats: a thread is hidden in B from the PC and unhidden from a paired device', async () => {
  const { lp, np, spaces, stop } = await setup()
  const host = 'pc:7411', store = spaces.get('acme').store
  const ids = async (port = lp, headers: Record<string, string> = {}) =>
    ((await call(port, 'GET', '/api/ws/acme/sources?concepts=chat', { host: port === np ? host : undefined, headers })).json.concepts.chat.items as { id: string }[]).map((c) => c.id)
  try {
    assert.ok((await ids()).includes('c1'))
    const hid = await call(lp, 'POST', '/api/ws/acme/chats/c1/hide', { body: { hidden: true, name: 'Team Dev' } })
    assert.equal(hid.status, 200, hid.text)
    await until(async () => !(await ids()).includes('c1'))
    assert.deepEqual((await store.marks())['chat:c1'], { hidden: true, name: 'Team Dev' })
    assert.deepEqual((await call(lp, 'GET', '/api/ws/acme/chats/hidden')).json, { hidden: [{ id: 'c1', name: 'Team Dev' }] })
    assert.deepEqual((await call(lp, 'GET', '/api/ws/beta/chats/hidden')).json, { hidden: [] })

    const code = new URL((await call(lp, 'POST', '/api/pair/new', { body: {} })).json.url).searchParams.get('code')!
    const cookie = String((await call(np, 'GET', `/pair?code=${code}`, { host })).headers['set-cookie']).split(';')[0]
    assert.deepEqual((await call(np, 'GET', '/api/ws/acme/chats/hidden', { host, headers: { cookie } })).json.hidden.map((h: { id: string }) => h.id), ['c1'])
    const un = await call(np, 'POST', '/api/ws/acme/chats/c1/hide', { host, headers: { cookie }, body: { hidden: false } })
    assert.equal(un.status, 200, un.text)
    await until(async () => (await ids(np, { cookie })).includes('c1'))
    assert.equal((await store.marks())['chat:c1'], undefined)
    assert.deepEqual((await call(lp, 'GET', '/api/ws/acme/chats/hidden')).json, { hidden: [] })
    assert.equal((await call(np, 'GET', '/api/ws/acme/chats/hidden', { host })).status, 401)
  } finally { await stop() }
})

test('time months pass through as the bridge gives them; a fill hands its result to the page', async () => {
  const { lp, stop } = await setup()
  try {
    const [cur, prev] = (await call(lp, 'GET', '/api/ws/acme/sources?concepts=time')).json.concepts.time.items
    assert.ok(cur.id > prev.id && prev.emptyDays.length > 0 && prev.top, JSON.stringify(prev))
    const args = { month: prev.id, days: prev.emptyDays, workItemId: prev.top.workItemId, activityId: prev.top.activityId, hours: 8 }
    const a = await call(lp, 'POST', '/api/ws/acme/act', { body: { action: 'time.fill', actionId: 'fill-1', args } })
    assert.equal(a.json.status, 'ok', a.text)
    assert.deepEqual(a.json.result, { month: prev.id, filled: prev.emptyDays, skipped: [], failed: [] })
  } finally { await stop() }
})

test('an ask runs to a draft; its artifact is served as text; path tricks stay inside', async () => {
  const { lp, dir, stop } = await setup()
  try {
    const { job, step } = await openStep(lp)
    const a = await call(lp, 'POST', '/api/runs', { body: { job: job.id, step, instruction: 'draft it' } })
    assert.equal(a.status, 200, a.text)
    await until(async () => (await call(lp, 'GET', `/api/runs/${a.json.run.id}`)).json.run.state === 'draft')
    assert.equal((await call(lp, 'GET', `/api/jobs/${job.id}`)).json.job.flow[step].dr.t, 'a draft')
    assert.equal((await call(lp, 'POST', `/api/runs/${a.json.run.id}/cancel`, { body: {} })).status, 409)

    mkdirSync(join(dir, 'arts', job.id), { recursive: true }); writeFileSync(join(dir, 'arts', job.id, 'a.md'), '<script>x</script>')
    const f = await call(lp, 'GET', `/api/artifacts/${job.id}/a.md`)
    assert.equal(f.status, 200); assert.match(String(f.headers['content-type']), /^text\/plain/)
    assert.equal(f.headers['content-disposition'], 'inline')
    const dl = await call(lp, 'GET', `/api/artifacts/${job.id}/a.md?dl=1`)
    assert.equal(dl.text, '<script>x</script>'); assert.match(String(dl.headers['content-type']), /^text\/markdown/)
    assert.equal(dl.headers['content-disposition'], `attachment; filename="a.md"; filename*=UTF-8''a.md`)
    writeFileSync(join(dir, 'arts', job.id, 'отчёт 1.csv'), 'a,b\n')
    const ru = await call(lp, 'GET', `/api/artifacts/${job.id}/${encodeURIComponent('отчёт 1.csv')}?dl=1`)
    assert.match(String(ru.headers['content-type']), /^text\/csv/)
    assert.equal(ru.headers['content-disposition'], `attachment; filename="_____ 1.csv"; filename*=UTF-8''${encodeURIComponent('отчёт 1.csv')}`)
    writeFileSync(join(dir, 'arts', job.id, 'invoice.pdf'), '%PDF-1.7')
    const pdf = await call(lp, 'GET', `/api/artifacts/${job.id}/invoice.pdf?dl=1`)
    assert.equal(pdf.headers['content-type'], 'application/pdf', 'a binary file carries no charset')
    writeFileSync(join(dir, 'arts', job.id, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const img = await call(lp, 'GET', `/api/artifacts/${job.id}/shot.png`)
    assert.equal(img.headers['content-type'], 'image/png', 'an image shows as itself on the page')
    assert.equal(img.headers['content-disposition'], 'inline')
    writeFileSync(join(dir, 'arts', job.id, 'page.html'), '<script>x</script>')
    assert.match(String((await call(lp, 'GET', `/api/artifacts/${job.id}/page.html`)).headers['content-type']), /^text\/plain/)
    assert.match(String((await call(lp, 'GET', `/api/artifacts/${job.id}/page.html?dl=1`)).headers['content-type']), /^text\/plain/, 'html never goes as html')
    assert.equal((await call(lp, 'GET', `/api/artifacts/${job.id}/..%2F..%2Fs.json`)).status, 404)
    const up = await call(lp, 'GET', '/..%2F..%2Fs.json')
    assert.equal(up.status, 404); assert.ok(!up.text.includes('"jobs"'), 'nothing outside the web root')
    assert.match((await call(lp, 'GET', '/jobs/A-1')).text, /Work Console/, 'a page route falls back to the page')
    assert.equal((await call(lp, 'GET', '/sw.js')).headers['service-worker-allowed'], '/')
  } finally { await stop() }
})

/** an open event stream; `ended` settles when the server closes it */
function stream(port: number, headers: Record<string, string>) {
  return new Promise<{ status: number; ended: Promise<void>; close: () => void }>((ok, no) => {
    const q = request({ host: '127.0.0.1', port, method: 'GET', path: '/api/events', headers }, (res) => {
      res.resume()
      ok({ status: res.statusCode!, ended: new Promise((r) => { res.on('end', r); res.on('close', r) }), close: () => q.destroy() })
    })
    q.on('error', no)
    q.end()
  })
}

test('a malformed cookie is 401 and a malformed path is 400; the process keeps serving', async () => {
  const { np, lp, stop } = await setup()
  try {
    assert.equal((await call(np, 'GET', '/api/state', { host: 'pc:7411', headers: { cookie: 'wc_dev=%E0%A4%A' } })).status, 401)
    assert.equal((await call(lp, 'POST', '/api/jobs/%ZZ/cmd', { body: { cmd: { op: 'start' }, v: 1 } })).status, 400)
    assert.equal((await call(lp, 'GET', '/api/ws/acme/sources/chat/%ZZ')).status, 400)
    assert.equal((await call(lp, 'GET', '/api/state')).status, 200)
  } finally { await stop() }
})

test('revoking a device closes its open event stream', async () => {
  const { np, lp, stop } = await setup()
  const host = 'pc:7411'
  try {
    const code = new URL((await call(lp, 'POST', '/api/pair/new', { body: {} })).json.url).searchParams.get('code')!
    const cookie = String((await call(np, 'GET', `/pair?code=${code}`, { host })).headers['set-cookie']).split(';')[0]
    const s = await stream(np, { host, cookie })
    assert.equal(s.status, 200)
    const pc = await stream(lp, { host: `127.0.0.1:${lp}` })
    const id = (await call(lp, 'GET', '/api/devices')).json.devices[0].id
    assert.equal((await call(lp, 'DELETE', `/api/devices/${id}`)).status, 200)
    await Promise.race([s.ended, new Promise((_, no) => setTimeout(() => no(new Error('the stream stayed open')), 2000))])
    let pcEnded = false
    void pc.ended.then(() => { pcEnded = true })
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(pcEnded, false, "the PC's own stream is untouched")
    pc.close()
  } finally { await stop() }
})

test('without a built page a route is 404, not a crash', async () => {
  const { lp, stop } = await setup({ page: false })
  try {
    assert.equal((await call(lp, 'GET', '/')).status, 404)
    assert.equal((await call(lp, 'GET', '/jobs')).status, 404)
    assert.equal((await call(lp, 'GET', '/api/state')).status, 200)
  } finally { await stop() }
})

test('knowledge: an LLM proposes, the user accepts in Approvals, edits the note by hand, then deletes it', async () => {
  const { lp, fakes, spaces, dir, stop } = await setup()
  try {
    const p = await spaces.get('acme').notes.propose({ title: 'Test note', tags: ['smoke'], text: 'one', reason: 'a test', by: 'run A-0001/s1' })
    assert.deepEqual((await call(lp, 'GET', '/api/ws/acme/knowledge/proposals')).json.proposals.map((x: { id: string }) => x.id), [p.id])
    assert.deepEqual((await call(lp, 'GET', '/api/ws/beta/knowledge/proposals')).json.proposals, [])
    // a workspace's notes are its own folder, and need no bridge
    fakes.acme.setDown(true)
    await until(() => !spaces.get('acme').source.available())
    const d = await call(lp, 'POST', `/api/ws/acme/knowledge/proposals/${p.id}/decide`, { body: { accept: true, text: 'one, edited' } })
    assert.equal(d.status, 200, d.text); assert.equal(d.json.note.text, 'one, edited')
    const id = d.json.note.id as string
    assert.match(readFileSync(join(dir, 'knowledge', 'acme', `${id}.md`), 'utf8'), /^---\ntitle: "Test note"\n[\s\S]*\n---\none, edited$/)
    assert.deepEqual((await call(lp, 'GET', '/api/ws/acme/knowledge')).json.notes.map((n: { id: string; v: number }) => [n.id, n.v]), [[id, 1]])
    assert.deepEqual((await call(lp, 'GET', '/api/ws/beta/knowledge')).json.notes, [])
    const e = await call(lp, 'PUT', `/api/ws/acme/knowledge/notes/${id}`, { body: { title: 'Test note', tags: ['smoke'], playbooks: ['action'], text: 'two', v: 1 } })
    assert.equal(e.json.note.v, 2); assert.deepEqual(e.json.note.playbooks, ['action'])
    assert.equal((await call(lp, 'PUT', `/api/ws/acme/knowledge/notes/${id}`, { body: { title: 'Test note', tags: [], text: 'x', v: 1 } })).json.error.code, 'conflict')
    assert.equal((await call(lp, 'PUT', `/api/ws/acme/knowledge/notes/${id}`, { body: { title: 'Test note', text: 'x' } })).status, 400)
    assert.equal((await call(lp, 'POST', '/api/ws/acme/knowledge/notes', { body: { title: '', text: 'x' } })).status, 400)
    assert.equal((await call(lp, 'GET', '/api/ws/acme/knowledge/notes/..%5Cx')).status, 400)
    assert.deepEqual((await call(lp, 'GET', '/api/ws/acme/knowledge/search?q=two')).json.hits.map((h: { id: string }) => h.id), [id])
    assert.equal((await call(lp, 'DELETE', `/api/ws/acme/knowledge/notes/${id}?v=1`)).status, 409)
    assert.equal((await call(lp, 'DELETE', `/api/ws/acme/knowledge/notes/${id}`)).status, 400)
    assert.equal((await call(lp, 'DELETE', `/api/ws/acme/knowledge/notes/${id}?v=2`)).status, 200)
    assert.equal((await call(lp, 'GET', `/api/ws/acme/knowledge/notes/${id}`)).status, 404)
  } finally { await stop() }
})

test('a knowledge change reaches the page as a source event of its workspace', async () => {
  const { lp, spaces, stop } = await setup()
  try {
    const got: string[] = []
    const q = request({ host: '127.0.0.1', port: lp, path: '/api/events', headers: { host: `127.0.0.1:${lp}` } }, (res) => {
      res.setEncoding('utf8'); res.on('data', (c: string) => { for (const m of c.matchAll(/event: source\ndata: (.*)\n/g)) got.push(m[1]) })
    })
    q.end()
    await new Promise((r) => setTimeout(r, 50))
    await spaces.get('beta').notes.save(null, { title: 'Seen', tags: [], playbooks: [], text: 'x' }, null)
    await until(() => got.length > 0)
    assert.deepEqual(JSON.parse(got[0]), { kind: 'source', concept: 'notes', upserts: [], removes: [], ws: 'beta' })
    q.destroy()
  } finally { await stop() }
})

test("context preview: a job's item reads as the run would get it; an item not on the job is 404", async () => {
  const { lp, stop } = await setup()
  try {
    const r = await call(lp, 'POST', '/api/jobs', { body: { t: 'Reply to Sam', key: 'ACME-512', pb: 'action', prj: 'platform', ws: 'acme', chat: 'c4', chatName: 'Sam Rivera' } })
    assert.equal(r.status, 200, r.text)
    const id = r.json.job.id
    assert.deepEqual(r.json.job.ctx.map((c: { k: string; id: string; name: string }) => `${c.k}/${c.id}/${c.name}`), ['work/ACME-512/ACME-512', 'chat/c4/Sam Rivera'])
    const w = await call(lp, 'GET', `/api/jobs/${id}/context/work/ACME-512`)
    assert.equal(w.status, 200, w.text)
    assert.equal(w.json.item.status, 'ok')
    assert.match(w.json.item.text, /^Story ACME-512: Public API: rate limiting per token\nState In Progress · assigned to You\n[\s\S]*Acceptance criteria:\n- A token over its limit gets 429[\s\S]*Comments, oldest first:\n- 2026-09-24 12:10Z Dana:/)
    const c = await call(lp, 'GET', `/api/jobs/${id}/context/chat/c4`)
    assert.match(c.json.item.text, /Sam Rivera: Hi, is the rate limiting live yet\?/)
    assert.equal((await call(lp, 'GET', `/api/jobs/${id}/context/chat/c1`)).status, 404)
    assert.equal((await call(lp, 'GET', '/api/jobs/J-NOPE/context/chat/c4')).status, 404)
  } finally { await stop() }
})

test("tracker: a job's work items and their PRs, active first; cached, fresh on ask, a snapshot while the bridge is down", async () => {
  const { lp, fakes, stop } = await setup()
  try {
    const r = await call(lp, 'POST', '/api/jobs', { body: { t: 'Rate limits', key: 'ACME-512', pb: 'action', prj: 'platform', ws: 'acme' } })
    assert.equal(r.status, 200, r.text)
    const id = r.json.job.id
    const t = await call(lp, 'GET', `/api/jobs/${id}/tracker`)
    assert.equal(t.status, 200, t.text)
    const tr = t.json.tracker
    assert.equal(tr.supported, true)
    assert.deepEqual(tr.items.map((c: { id: string; title: string; area: string; prs: string[] }) => [c.id, c.title, c.area, c.prs]),
      [['ACME-512', 'Public API: rate limiting per token', 'Platform/API', ['482', '470']]])
    assert.deepEqual(tr.prs.map((p: { id: string; status: string; items: string[] }) => [p.id, p.status, p.items]), [['482', 'active', ['ACME-512']], ['470', 'abandoned', ['ACME-512']]])
    assert.equal(tr.prs[0].policies[0].name, 'Minimum number of reviewers')
    fakes.acme.setSource('work', 'unavailable')
    assert.equal((await call(lp, 'GET', `/api/jobs/${id}/tracker`)).json.tracker.at, tr.at, 'within five minutes: the cached read')
    const down = (await call(lp, 'GET', `/api/jobs/${id}/tracker?fresh=1`)).json.tracker
    assert.equal(down.at, tr.at)
    assert.equal(down.items[0].title, 'Public API: rate limiting per token')
    assert.match(down.offline, /work is unavailable/)
    fakes.acme.setSource('work', null)
    const none = await call(lp, 'POST', '/api/jobs', { body: { t: 'No item', key: 'ops', pb: 'action', prj: 'platform', ws: 'acme' } })
    assert.equal((await call(lp, 'GET', `/api/jobs/${none.json.job.id}/tracker`)).json.tracker.supported, false)
    assert.equal((await call(lp, 'GET', '/api/jobs/J-NOPE/tracker')).status, 404)
  } finally { await stop() }
})

test('a workspace route answers only under /api/ws/<id>, and the state has no merged top level', async () => {
  for (const o of [{}, { one: true }]) {
    const { lp, stop } = await setup(o)
    try {
      await openStep(lp)
      const a = await call(lp, 'POST', '/api/act', { body: { action: 'chat.post', args: { chatName: 'x', text: 'x' } } })
      assert.equal(a.status, 404)
      assert.equal((await call(lp, 'GET', '/api/sources?concepts=chat')).status, 404)
      assert.equal((await call(lp, 'GET', '/api/chats/hidden')).status, 404)
      assert.equal((await call(lp, 'GET', '/api/knowledge')).status, 404)
      assert.equal((await call(lp, 'GET', '/api/ws/acme/sources?concepts=chat')).json.concepts.chat.status, 'ok')
      const st = (await call(lp, 'GET', '/api/state')).json
      for (const k of ['jobs', 'runs', 'marks', 'parts', 'playbooks', 'bridge']) assert.equal(k in st, false, `no top-level ${k}`)
      assert.ok(st.home); assert.deepEqual(st.ws.acme.jobs.map((j: Job) => j.id), ['A-0001'])
    } finally { await stop() }
  }
})

test('build: one session fills the form from the says, its reading on the event stream; a key another workspace holds is not offered', async () => {
  const { lp, stop } = await setup()
  try {
    const got: string[] = []
    const q = request({ host: '127.0.0.1', port: lp, path: '/api/events', headers: { host: `127.0.0.1:${lp}` } }, (res) => {
      res.setEncoding('utf8'); res.on('data', (c: string) => { for (const m of c.matchAll(/event: build\ndata: (.*)\n/g)) got.push(m[1]) })
    })
    q.end()
    await new Promise((r) => setTimeout(r, 50))
    const r = await call(lp, 'POST', '/api/ws/acme/build', { body: { id: 'b1', say: ['reply to Sam about rate limiting'], form: {} } })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.form, {
      t: 'Reply to Sam', key: 'ACME-512', prj: 'platform', pb: 'action', d: 'reply to Sam about rate limiting', ctx: [{ k: 'chat', id: 'c4', n: 10, name: 'Sam Rivera' }], due: '', npb: null, why: [],
    })
    await until(() => got.length >= 2)
    assert.deepEqual(got.map((x) => JSON.parse(x)), [
      { kind: 'build', id: 'b1', t: 'Started', ws: 'acme' },
      { kind: 'build', id: 'b1', t: 'Searching notes for “rate limiting”', tool: 'knowledge_search', ws: 'acme' },
    ])
    q.destroy()
    const dev = structuredClone(acme.playbooks['dev-item'])
    assert.equal((await call(lp, 'PUT', '/api/ws/beta/playbooks/weekly-report', { body: { pb: { ...dev, ws: 'beta', n: 'Weekly', custom: 1 } } })).status, 200)
    const n = await call(lp, 'POST', '/api/ws/acme/build', { body: { id: 'b2', say: ['steps: a weekly report'], form: {} } })
    assert.equal(n.status, 200, n.text)
    assert.equal(n.json.form.pb, 'weekly-report-2'); assert.equal(n.json.form.npb.file.workspace, 'acme')
    for (const body of [{ id: 'b3', say: [] }, { say: ['x'] }, { id: 'a b', say: ['x'] }])
      assert.equal((await call(lp, 'POST', '/api/ws/acme/build', { body })).status, 400, JSON.stringify(body))
    assert.equal((await call(lp, 'POST', '/api/ws/nope/build', { body: { id: 'b', say: ['x'] } })).status, 404)
  } finally { await stop() }
})

test('transcribe: the audio reaches the voice, past the usual 2 MB; state says whether there is a key; a dropped request aborts', async () => {
  const got: { audio: string; mime: string; signal?: AbortSignal }[] = []
  let ready = false
  const voice: Voice = { ready: () => ready, transcribe: async (audio, mime, signal) => { got.push({ audio, mime, signal }); return 'make a job' } }
  const { lp, stop } = await setup({ one: true, voice })
  try {
    assert.equal((await call(lp, 'GET', '/api/state')).json.voice, false, 'no key yet')
    ready = true
    assert.equal((await call(lp, 'GET', '/api/state')).json.voice, true, 'a key placed later shows the mic')
    const big = 'A'.repeat(3 << 20)
    const r = await call(lp, 'POST', '/api/ws/acme/transcribe', { body: { audio: big, mime: 'audio/webm' } })
    assert.equal(r.status, 200, r.text.slice(0, 200))
    assert.deepEqual(r.json, { text: 'make a job' })
    assert.equal(got[0].audio.length, big.length); assert.equal(got[0].mime, 'audio/webm')
    assert.equal((await call(lp, 'POST', '/api/ws/acme/transcribe', { body: { mime: 'audio/webm' } })).status, 400, 'no audio')
    assert.equal((await call(lp, 'POST', '/api/ws/nope/transcribe', { body: { audio: 'AA==', mime: 'audio/webm' } })).status, 404)
    // past its limit the request is cut off, so the client may see a reset rather than the 413
    const over = await call(lp, 'POST', '/api/ws/acme/act', { body: { pad: big } }).then((x) => x.status, (e: Error) => e.message)
    assert.ok(over === 413 || /ECONNRESET|EPIPE/.test(String(over)), `other routes keep 2 MB: ${over}`)
    // a page that gives up stops the call to OpenAI
    let aborted: Promise<void> | null = null
    voice.transcribe = (_a, _m, signal) => { aborted = new Promise((ok) => signal!.addEventListener('abort', () => ok())); return new Promise(() => {}) }
    const q = request({ host: '127.0.0.1', port: lp, method: 'POST', path: '/api/ws/acme/transcribe', headers: { host: `127.0.0.1:${lp}`, 'content-type': 'application/json' } })
    q.on('error', () => {})
    q.end(JSON.stringify({ audio: 'AA==', mime: 'audio/webm' }))
    await until(() => aborted !== null)
    q.destroy()
    await aborted
  } finally { await stop() }
  const none = await setup({ one: true })
  try {
    assert.equal((await call(none.lp, 'GET', '/api/state')).json.voice, false)
    const r = await call(none.lp, 'POST', '/api/ws/acme/transcribe', { body: { audio: 'AA==', mime: 'audio/webm' } })
    assert.equal(r.status, 503); assert.equal(r.json.error.code, 'no_key')
  } finally { await none.stop() }
})

test('format: the text, ctx and target reach the formatter; a bad target is 400; without one it is no_key', async () => {
  const got: unknown[] = []
  const format: Format = { format: async (o) => { got.push(o); return { text: o.text.toUpperCase(), ...(o.intents ? { intent: 'ask' as const } : {}) } } }
  const { lp, stop } = await setup({ one: true, format })
  try {
    const r = await call(lp, 'POST', '/api/ws/acme/format', { body: { text: 'hi', ctx: 'the draft', target: 'llm', intents: true } })
    assert.equal(r.status, 200); assert.deepEqual(r.json, { text: 'HI', intent: 'ask' })
    assert.deepEqual(got[0], { text: 'hi', ctx: 'the draft', field: undefined, target: 'llm', intents: true })
    const bad = await call(lp, 'POST', '/api/ws/acme/format', { body: { text: 'hi', target: 'robots' } })
    assert.equal(bad.status, 400); assert.equal(bad.json.error.code, 'bad_args')
    assert.equal((await call(lp, 'POST', '/api/ws/acme/format', { body: { target: 'llm' } })).status, 400, 'no text')
  } finally { await stop() }
  const none = await setup({ one: true })
  try {
    const r = await call(none.lp, 'POST', '/api/ws/acme/format', { body: { text: 'hi', target: 'llm' } })
    assert.equal(r.status, 503); assert.equal(r.json.error.code, 'no_key')
  } finally { await none.stop() }
})

test("a reply goes to the run's step in its session; reject with a reason answers the redo run", async () => {
  const { lp, stop } = await setup({ one: true })
  try {
    const { job, step } = await openStep(lp)
    const a = await call(lp, 'POST', '/api/runs', { body: { job: job.id, step, instruction: 'draft it' } })
    const id = a.json.run.id as string
    await until(async () => (await call(lp, 'GET', `/api/runs/${id}`)).json.run?.state === 'draft')
    const n = prompts.length
    const rep = await call(lp, 'POST', `/api/runs/${id}/reply`, { body: { t: 'shorter', intent: 'revise' } })
    assert.equal(rep.status, 200, rep.text); assert.equal(rep.json.run.parent, id); assert.equal(rep.json.run.intent, 'revise')
    await until(async () => (await call(lp, 'GET', `/api/runs/${rep.json.run.id}`)).json.run?.state === 'draft')
    assert.match(prompts[n], /replied to your draft:\n\nshorter/)
    const bad = await call(lp, 'POST', `/api/runs/${id}/reply`, { body: { t: 'x', intent: 'ship' } })
    assert.equal(bad.status, 400); assert.equal(bad.json.error.code, 'bad_args')
    assert.equal((await call(lp, 'POST', '/api/runs/nope/reply', { body: { t: 'x', intent: 'revise' } })).status, 404)
    const rj = await call(lp, 'POST', `/api/jobs/${job.id}/cmd`, { body: { cmd: { op: 'rejectDraft', step, why: 'wrong scope' } } })
    assert.equal(rj.status, 200, rj.text); assert.ok(rj.json.run?.id); assert.equal(rj.json.job.flow[step].dr, null)
    await until(() => prompts.length === n + 2)
    assert.match(prompts[n + 1], /## Why\nwrong scope/)
    const plain = await call(lp, 'POST', `/api/jobs/${job.id}/cmd`, { body: { cmd: { op: 'noteAdd', step, k: 'q', t: 'x' } } })
    assert.equal(plain.status, 200); assert.equal('run' in plain.json, false)
  } finally { await stop() }
})

test('settings: read with the providers, written key by key, refused whole; state names the manual provider', async () => {
  const { lp, stop } = await setup({ one: true })
  try {
    const g = await call(lp, 'GET', '/api/settings')
    assert.equal(g.status, 200, g.text)
    assert.deepEqual(g.json.settings, { auto: 'claude', manual: 'claude' })
    assert.deepEqual(g.json.providers.map((p: { id: string; auto: boolean }) => [p.id, p.auto]), [['claude', true], ['cursor', false]])
    const bad = await call(lp, 'PUT', '/api/settings', { body: { manual: 'cursor', auto: 'cursor' } })
    assert.equal(bad.status, 400); assert.equal(bad.json.error.code, 'bad_args')
    assert.equal((await call(lp, 'GET', '/api/settings')).json.settings.manual, 'claude', 'a refused write changes nothing')
    const ok = await call(lp, 'PUT', '/api/settings', { body: { manual: 'cursor' } })
    assert.equal(ok.status, 200, ok.text); assert.equal(ok.json.settings.manual, 'cursor')
    assert.deepEqual((await call(lp, 'GET', '/api/state')).json.providers, { auto: 'claude', manual: 'cursor', manualLabel: 'Cursor' })
  } finally { await stop() }
})

test('open: a step without a session opens in the manual provider with a short prompt; a link for Cursor', async () => {
  const { lp, stop } = await setup({ one: true })
  try {
    const { job, step } = await openStep(lp)
    const c = await call(lp, 'GET', `/api/jobs/${job.id}/steps/${step}/open`)
    assert.equal(c.status, 200, c.text)
    assert.equal(c.json.label, 'Claude Code'); assert.equal(c.json.open.kind, 'link')
    assert.match(c.json.open.value, /^claude-cli:\/\/open\?/)
    assert.ok(decodeURIComponent(c.json.open.value).includes(job.id))
    await call(lp, 'PUT', '/api/settings', { body: { manual: 'cursor' } })
    const u = await call(lp, 'GET', `/api/jobs/${job.id}/steps/${step}/open`)
    assert.equal(u.json.label, 'Cursor'); assert.match(u.json.open.value, /^cursor:\/\/anysphere\.cursor-deeplink\/prompt\?text=/)
    assert.equal((await call(lp, 'GET', `/api/jobs/${job.id}/steps/nope/open`)).status, 400)
  } finally { await stop() }
})
