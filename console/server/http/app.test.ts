import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as T from '../../src/model/transitions.ts'
import { PB0 } from '../../src/data/playbooks.ts'
import type { Job } from '../../src/model/types.ts'
import { BridgeClient } from '../bridge/client.ts'
import { startFakeGateway } from '../bridge/fake.ts'
import { Bus } from '../events.ts'
import { Jobs } from '../jobs/jobs.ts'
import { Runner } from '../llm/runner.ts'
import type { Sdk } from '../llm/sdk.ts'
import { Notify } from '../notify/notify.ts'
import { Pairing } from '../pairing/pairing.ts'
import { bridgeStore } from '../store/bridge.ts'
import { fileStore } from '../store/file.ts'
import { demoCtx, demoSeed } from '../testkit.ts'
import { createApp } from './app.ts'

/* The whole backend over real sockets: fake gateway, file store, a scripted SDK that drafts at once. */

const sdk: Sdk = { async *start({ tools }) { yield { k: 'session', id: 'sess-1' }; await tools.submitDraft('a draft'); yield { k: 'result', ok: true } } }

async function listen(s: Server) { await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); return (s.address() as AddressInfo).port }

async function setup(o: { page?: boolean; store?: 'file' | 'bridge' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wc-http-')), web = join(dir, 'web')
  mkdirSync(web)
  if (o.page !== false) { writeFileSync(join(web, 'index.html'), '<!doctype html><title>Work Console</title>'); writeFileSync(join(web, 'sw.js'), '// sw') }
  const fake = await startFakeGateway({ statusMs: 50 })
  const bus = new Bus()
  const bridge = new BridgeClient({ url: fake.url, token: () => fake.token, bus, backoff: [30, 60] })
  // marks join into mail on the bridge side, so a test of them needs the store that lives there
  const store = o.store === 'bridge' ? bridgeStore({ bridge, bus, playbooks: PB0 }) : fileStore(join(dir, 's.json'), demoSeed)
  const gate = () => bridge.available(), ctx = demoCtx
  const jobs = new Jobs({ store, bus, ctx, gate })
  const runner = new Runner({ store, jobs, bus, sdk, cwd: dir, gate, artifactsDir: join(dir, 'arts'), ctx })
  const pairing = new Pairing(join(dir, 'home'))
  const notify = new Notify({ dir: join(dir, 'home'), bus, ctx, jobFor: () => undefined, sender: { send: async () => ({ status: 201 }) } })
  let h: ReturnType<typeof createApp> | null = null
  const loop = createServer((q, s) => h!.loopback(q, s)), lanS = createServer((q, s) => h!.lan(q, s))
  const lp = await listen(loop), np = await listen(lanS)
  h = createApp({
    loopbackPort: lp, lanPort: 7411, pcName: 'pc', bus, store, jobs, runner, bridge, pairing, notify, ctx,
    putPlaybook: (id, pb) => store.putPlaybook(id, pb), staticDirs: [web], artifactsDir: join(dir, 'arts'), tz: 'Europe/Berlin',
  })
  bridge.start()
  await until(() => bridge.available())
  const stop = async () => {
    h!.close(); bridge.stop(); await fake.close()
    await Promise.all([loop, lanS].map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r) })))
  }
  return { fake, jobs, runner, pairing, store, lp, np, stop, dir }
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
/** an open step without a run on a job that is not closed */
async function openStep(jobs: Jobs) {
  const x = demoCtx()
  for (const j of await jobs.all()) {
    if (T.isClosed(j) || j.st === 'recurring') continue
    for (const s of T.steps(x, j.pb)) if (j.flow[s.id] && T.isLive(j.flow[s.id]) && !j.flow[s.id].run) return { job: j, step: s.id }
  }
  throw new Error('no open step in the demo')
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
  } finally { await stop() }
})

test('LAN: the page is public, the API needs a paired cookie, pairing and devices are PC-only', async () => {
  const { np, lp, pairing, stop } = await setup()
  const host = 'pc:7411'
  try {
    assert.equal((await call(np, 'GET', '/', { host })).status, 200)
    assert.equal((await call(np, 'GET', '/api/state', { host })).status, 401)
    assert.equal((await call(np, 'POST', '/api/pair/new', { host, body: {} })).status, 403)
    assert.equal((await call(np, 'GET', '/api/devices', { host })).status, 403)

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

test('state, a command round trip, a stale version is 409 with the current job, undo', async () => {
  const { lp, jobs, stop } = await setup()
  try {
    const st = await call(lp, 'GET', '/api/state')
    assert.ok(st.json.jobs.length > 0); assert.ok(st.json.playbooks); assert.deepEqual(st.json.runs, [])
    assert.equal(st.json.bridge.state, 'ok'); assert.ok(st.json.push.key)

    const { job, step } = await openStep(jobs)
    const r = await call(lp, 'POST', `/api/jobs/${job.id}/cmd`, { body: { cmd: { op: 'noteAdd', step, k: 'q', t: 'why?' }, v: job.v } })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.job.v, job.v! + 1); assert.equal(r.json.prev.v, job.v)

    const stale = await call(lp, 'POST', `/api/jobs/${job.id}/cmd`, { body: { cmd: { op: 'noteAdd', step, k: 'q', t: 'again' }, v: job.v } })
    assert.equal(stale.status, 409); assert.equal(stale.json.error.code, 'conflict'); assert.equal(stale.json.job.v, job.v! + 1)

    const bad = await call(lp, 'POST', `/api/jobs/${job.id}/cmd`, { body: { cmd: { op: 'runDraft', step, t: 'x' } } })
    assert.equal(bad.status, 400, 'the page cannot send runner ops')

    const u = await call(lp, 'POST', '/api/undo', { body: { job: job.id, v: r.json.job.v, prev: r.json.prev } })
    assert.equal(u.status, 200, u.text)
    assert.equal(u.json.job.flow[step].b.length, job.flow[step].b.length); assert.equal(r.json.job.flow[step].b.length, job.flow[step].b.length + 1)
    assert.equal((await call(lp, 'POST', '/api/undo', { body: { job: job.id, v: r.json.job.v, prev: r.json.prev } })).status, 409)
    assert.equal((await call(lp, 'GET', '/api/jobs/NOPE')).status, 404)
  } finally { await stop() }
})

test('with the bridge down a command, an act and an ask are 503; sources say unavailable', async () => {
  const { lp, jobs, fake, stop } = await setup()
  try {
    const { job, step } = await openStep(jobs)
    fake.setDown(true)
    await until(async () => (await call(lp, 'GET', '/api/state')).json.bridge.state === 'unavailable')
    assert.equal((await call(lp, 'POST', `/api/jobs/${job.id}/cmd`, { body: { cmd: { op: 'noteAdd', step, k: 'q', t: 'x' } } })).status, 503)
    assert.equal((await call(lp, 'POST', '/api/act', { body: { action: 'work.comment', args: { id: 'x', text: 'hi' } } })).status, 503)
    assert.equal((await call(lp, 'POST', '/api/runs', { body: { job: job.id, step, instruction: 'go' } })).status, 503)
    const src = await call(lp, 'GET', '/api/sources?concepts=chat,mail')
    assert.equal(src.status, 200)
    assert.notEqual(src.json.concepts.chat.status, 'ok'); assert.notEqual(src.json.concepts.mail.status, 'ok')
  } finally { await stop() }
})

test('a state store that cannot be read shows as unavailable, not as no jobs', async () => {
  const { lp, fake, stop } = await setup({ store: 'bridge' })
  try {
    fake.setSource('runs', 'source_unavailable')
    const st = await call(lp, 'GET', '/api/state')
    assert.equal(st.status, 200); assert.equal(st.json.bridge.state, 'ok')
    assert.deepEqual(st.json.parts, { jobs: 'unavailable', runs: 'unavailable', marks: 'unavailable' })
    fake.setSource('runs', null)
    assert.deepEqual((await call(lp, 'GET', '/api/state')).json.parts, { jobs: 'ok', runs: 'ok', marks: 'ok' })
  } finally { await stop() }
})

test('SSE delivers the bridge state and then a job event after a command', async () => {
  const { lp, jobs, stop } = await setup()
  try {
    const { job, step } = await openStep(jobs)
    const got: string[] = []
    const sse = request({ host: '127.0.0.1', port: lp, path: '/api/events', headers: { host: `127.0.0.1:${lp}` } }, (res) => {
      assert.match(String(res.headers['content-type']), /text\/event-stream/)
      res.setEncoding('utf8'); res.on('data', (c: string) => { got.push(c) })
    })
    sse.end()
    await until(() => got.join('').includes('event: bridge'))
    await call(lp, 'POST', `/api/jobs/${job.id}/cmd`, { body: { cmd: { op: 'noteAdd', step, k: 'q', t: 'sse' }, v: job.v } })
    await until(() => got.join('').includes('event: job'))
    const data = got.join('').split('event: job\ndata: ')[1].split('\n')[0]
    assert.equal((JSON.parse(data) as { job: Job }).job.id, job.id)
    sse.destroy()
  } finally { await stop() }
})

test('sources come in page shapes; an act resolves the chat name and returns the gateway answer', async () => {
  const { lp, fake, store, stop } = await setup({ store: 'bridge' })
  try {
    const src = await call(lp, 'GET', '/api/sources?concepts=chat,mail,cal,work')
    assert.equal(src.json.concepts.chat.status, 'ok')
    const chat = src.json.concepts.chat.items[0]
    assert.ok(chat.name && Array.isArray(chat.msgs))
    const mail = src.json.concepts.mail.items[0]
    assert.ok(['reply', 'wait', 'fyi', 'auto'].includes(mail.cat))
    assert.ok(src.json.concepts.cal.items.every((e: { b: string }) => /^\d\d:\d\d$/.test(e.b)))

    await call(lp, 'POST', `/api/mail/${encodeURIComponent(mail.id)}/mark`, { body: { done: true } })
    await until(async () => (await call(lp, 'GET', '/api/sources?concepts=mail')).json.concepts.mail.items.find((m: { id: string }) => m.id === mail.id).done === true)
    assert.equal((await store.marks())[mail.id].done, true)

    const one = await call(lp, 'GET', `/api/sources/chat/${encodeURIComponent(chat.id)}`)
    assert.equal(one.status, 200, one.text)
    assert.ok(Array.isArray(one.json.item.messages))

    const a = await call(lp, 'POST', '/api/act', { body: { action: 'chat.post', actionId: 'act-1', args: { chatName: chat.name.toUpperCase(), text: 'hello' } } })
    assert.equal(a.status, 200, a.text); assert.equal(a.json.status, 'ok'); assert.equal(a.json.actionId, 'act-1')
    assert.deepEqual(fake.acts.at(-1), { action: 'chat.post', actionId: 'act-1', args: { chat: chat.id, text: 'hello' } })
    assert.equal((await call(lp, 'POST', '/api/act', { body: { action: 'chat.post', args: { chatName: 'no such chat', text: 'x' } } })).json.error.code, 'unknown_chat')
    assert.equal((await call(lp, 'POST', '/api/act', { body: { action: 'rm -rf', args: {} } })).status, 400)
  } finally { await stop() }
})

test('a job made from a meeting carries the event and is due when it starts', async () => {
  const { lp, stop } = await setup()
  try {
    const items = (await call(lp, 'GET', '/api/sources?concepts=cal')).json.concepts.cal.items
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

test('board Start: A moves a free item to Dev on the user and its job starts; a taken item is refused', async () => {
  const { lp, fake, jobs, stop } = await setup()
  try {
    const r = await call(lp, 'POST', '/api/board/ACME-603/start', { body: {} })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.created, true); assert.equal(r.json.job.key, 'ACME-603'); assert.equal(r.json.job.st, 'active')
    assert.equal(r.json.job.t, 'Projects grid: export ignores the filter')
    assert.equal((await jobs.get(r.json.job.id))!.pb, 'dev-item')
    assert.deepEqual(fake.acts.map((a) => [a.action, a.args]), [['work.start', { id: 'ACME-603' }]])
    const item = (await call(lp, 'GET', '/api/sources?concepts=board')).json.concepts.board.items.find((i: { id: string }) => i.id === 'ACME-603')
    assert.deepEqual([item.lane, item.column, item.assignedTo], ['mine', 'Dev', 'You'])
    const no = await call(lp, 'POST', '/api/board/ACME-530/start', { body: {} })
    assert.equal(no.status, 400); assert.equal(no.json.error.code, 'refused'); assert.equal(no.json.error.message, 'ACME-530 is assigned to Sam Rivera')
  } finally { await stop() }
})

test('chats: a thread is hidden in B from the PC and unhidden from a paired device', async () => {
  const { lp, np, store, stop } = await setup({ store: 'bridge' })
  const host = 'pc:7411'
  const ids = async (port = lp, headers: Record<string, string> = {}) =>
    ((await call(port, 'GET', '/api/sources?concepts=chat', { host: port === np ? host : undefined, headers })).json.concepts.chat.items as { id: string }[]).map((c) => c.id)
  try {
    assert.ok((await ids()).includes('c1'))
    const hid = await call(lp, 'POST', '/api/chats/c1/hide', { body: { hidden: true, name: 'Team Dev' } })
    assert.equal(hid.status, 200, hid.text)
    await until(async () => !(await ids()).includes('c1'))
    assert.deepEqual((await store.marks())['chat:c1'], { hidden: true, name: 'Team Dev' })
    assert.deepEqual((await call(lp, 'GET', '/api/chats/hidden')).json, { hidden: [{ id: 'c1', name: 'Team Dev' }] })

    const code = new URL((await call(lp, 'POST', '/api/pair/new', { body: {} })).json.url).searchParams.get('code')!
    const cookie = String((await call(np, 'GET', `/pair?code=${code}`, { host })).headers['set-cookie']).split(';')[0]
    assert.deepEqual((await call(np, 'GET', '/api/chats/hidden', { host, headers: { cookie } })).json.hidden.map((h: { id: string }) => h.id), ['c1'])
    const un = await call(np, 'POST', '/api/chats/c1/hide', { host, headers: { cookie }, body: { hidden: false } })
    assert.equal(un.status, 200, un.text)
    await until(async () => (await ids(np, { cookie })).includes('c1'))
    assert.equal((await store.marks())['chat:c1'], undefined)
    assert.deepEqual((await call(lp, 'GET', '/api/chats/hidden')).json, { hidden: [] })
    assert.equal((await call(np, 'GET', '/api/chats/hidden', { host })).status, 401)
  } finally { await stop() }
})

test('time months pass through as the bridge gives them; a fill hands its result to the page', async () => {
  const { lp, stop } = await setup({ store: 'bridge' })
  try {
    const [cur, prev] = (await call(lp, 'GET', '/api/sources?concepts=time')).json.concepts.time.items
    assert.ok(cur.id > prev.id && prev.emptyDays.length > 0 && prev.top, JSON.stringify(prev))
    const args = { month: prev.id, days: prev.emptyDays, workItemId: prev.top.workItemId, activityId: prev.top.activityId, hours: 8 }
    const a = await call(lp, 'POST', '/api/act', { body: { action: 'time.fill', actionId: 'fill-1', args } })
    assert.equal(a.json.status, 'ok', a.text)
    assert.deepEqual(a.json.result, { month: prev.id, filled: prev.emptyDays, skipped: [], failed: [] })
  } finally { await stop() }
})

test('an ask runs to a draft; its artifact is served as text; path tricks stay inside', async () => {
  const { lp, jobs, dir, stop } = await setup()
  try {
    const { job, step } = await openStep(jobs)
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
    assert.equal((await call(lp, 'GET', `/api/artifacts/${job.id}/..%2F..%2Fs.json`)).status, 404)
    const up = await call(lp, 'GET', '/..%2F..%2Fs.json')
    assert.equal(up.status, 404); assert.ok(!up.text.includes('"jobs"'), 'nothing outside the web root')
    assert.match((await call(lp, 'GET', '/jobs/J-1')).text, /Work Console/, 'a page route falls back to the page')
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

test('knowledge: an LLM proposes, the user accepts in Approvals, then edits the note by hand', async () => {
  const { lp, fake, stop } = await setup()
  try {
    const r = await fetch(`${fake.url}/api/knowledge/propose`, { method: 'POST', headers: { authorization: `Bearer ${fake.llmToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Test note', tags: ['smoke'], text: 'one', reason: 'a test' }) })
    const p = ((await r.json()) as { items: { doc: { id: string } } }).items.doc
    await until(async () => (await call(lp, 'GET', '/api/knowledge/proposals')).json.proposals.length === 1)
    const d = await call(lp, 'POST', `/api/knowledge/proposals/${p.id}/decide`, { body: { accept: true, text: 'one, edited' } })
    assert.equal(d.status, 200, d.text); assert.equal(d.json.note.text, 'one, edited')
    await until(async () => (await call(lp, 'GET', '/api/knowledge')).json.notes.length === 1)
    const id = d.json.note.id as string
    assert.equal((await call(lp, 'GET', `/api/knowledge/notes/${id}`)).json.note.v, 1)
    const e = await call(lp, 'PUT', `/api/knowledge/notes/${id}`, { body: { title: 'Test note', tags: ['smoke'], text: 'two', v: 1 } })
    assert.equal(e.json.note.v, 2)
    assert.equal((await call(lp, 'PUT', `/api/knowledge/notes/${id}`, { body: { title: 'Test note', tags: [], text: 'x', v: 1 } })).status, 409)
    assert.equal((await call(lp, 'POST', '/api/knowledge/notes', { body: { title: '', text: 'x' } })).status, 400)
    assert.deepEqual((await call(lp, 'GET', '/api/knowledge/search?q=two')).json.hits.map((h: { id: string }) => h.id), [id])
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
