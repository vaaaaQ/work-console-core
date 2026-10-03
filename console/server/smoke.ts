import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.ts'
import type { Sdk } from './llm/sdk.ts'
import { main } from './main.ts'
import { ensureCerts } from './tls/mkcert.ts'
import * as T from '../src/model/transitions.ts'
import acmeServer from '../workspaces/acme/server.ts'

/* A running backend end to end, with the fake gateway and a scripted SDK on free ports:
   loopback serves the page, a phone pairs over TLS, SSE delivers a job event, and an ask goes
   queued → running → draft. `npm run build` first: the page is served from dist/. */

const PKG = fileURLToPath(new URL('../', import.meta.url))
if (!existsSync(join(PKG, 'dist', 'index.html'))) { console.error('smoke: run `npm run build` first'); process.exit(1) }

let release = () => {}
const gate = new Promise<void>((r) => { release = r })
const sdk: Sdk = { async *start({ tools }) { yield { k: 'session', id: 'smoke-1' }; await gate; await tools.submitDraft('smoke draft'); yield { k: 'result', ok: true } } }

type Res = { status: number; headers: IncomingMessage['headers']; text: string }
const read = (res: IncomingMessage) => new Promise<Res>((ok) => { let t = ''; res.setEncoding('utf8'); res.on('data', (c) => { t += c }); res.on('end', () => ok({ status: res.statusCode!, headers: res.headers, text: t })) })

const step = (name: string) => console.log(`  ok  ${name}`)

async function run() {
  const home = mkdtempSync(join(tmpdir(), 'wc-smoke-'))
  ensureCerts(join(home, 'tls'), { host: 'localhost', ips: [] })
  const ca = readFileSync(join(home, 'tls', 'ca.crt'))
  const cfg = { ...loadConfig({ WORK_CONSOLE_HOME: home, WORK_CONSOLE_FAKE_GATEWAY: '1' }), loopbackPort: 0, lanPort: 0, pcName: 'localhost' }
  const m = await main({ cfg, sdk, workspaces: [acmeServer] })
  const loop = (method: string, path: string, body?: unknown) => new Promise<Res>((ok, no) => {
    const q = httpRequest({ host: '127.0.0.1', port: m.loopbackPort, method, path, headers: body === undefined ? {} : { 'content-type': 'application/json' } }, (r) => { void read(r).then(ok) })
    q.on('error', no); q.end(body === undefined ? undefined : JSON.stringify(body))
  })
  const json = async (method: string, path: string, body?: unknown) => {
    const r = await loop(method, path, body)
    assert.ok(r.status < 300, `${method} ${path} → ${r.status} ${r.text}`)
    return JSON.parse(r.text)
  }
  const lan = (path: string, cookie?: string) => new Promise<Res>((ok, no) => {
    const q = httpsRequest({ host: '127.0.0.1', servername: 'localhost', port: m.lanPort!, path, ca, headers: { host: `localhost:${m.lanPort}`, ...(cookie ? { cookie } : {}) } }, (r) => { void read(r).then(ok) })
    q.on('error', no); q.end()
  })

  try {
    const page = await loop('GET', '/')
    assert.equal(page.status, 200); assert.match(page.text, /<div id="root">/)
    step('loopback serves the page')

    assert.ok(m.lanPort, 'the LAN listener is up once a certificate exists')
    assert.equal((await lan('/api/state')).status, 401)
    const { url } = await json('POST', '/api/pair/new', {})
    const paired = await lan(new URL(url).pathname + new URL(url).search)
    const cookie = String(paired.headers['set-cookie']?.[0] || '').split(';')[0]
    assert.ok(cookie.includes('='), `pairing sets a device cookie (${paired.status})`)
    const st = await lan('/api/state', cookie)
    assert.equal(st.status, 200); assert.equal(JSON.parse(st.text).side, 'lan')
    assert.equal((await lan(new URL(url).pathname + new URL(url).search)).status, 403, 'a code works once')
    step('pairing issues a device token that opens the API over TLS')

    const events: { kind: string; [k: string]: unknown }[] = []
    const sse = await new Promise<IncomingMessage>((ok, no) => { const q = httpRequest({ host: '127.0.0.1', port: m.loopbackPort, path: '/api/events' }, ok); q.on('error', no); q.end() })
    let buf = ''
    sse.setEncoding('utf8')
    sse.on('data', (c: string) => {
      buf += c
      for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) {
        const d = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '))
        if (d) events.push(JSON.parse(d.slice(6)))
      }
    })
    const until = async (f: () => boolean, what: string) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > 5000) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 20)) } }

    const { job } = await json('POST', '/api/jobs', { t: 'Smoke', key: 'ACME-9001', pb: 'action', prj: 'platform', ws: 'acme' })
    assert.match(job.id, /^A-\d{4}$/, "the fake gateway's J-NNNN comes back under Acme's prefix")
    await until(() => events.some((e) => e.kind === 'job' && (e.job as { id: string }).id === job.id), 'a job event')
    step('SSE delivers a job event')

    const started = (await json('POST', `/api/jobs/${job.id}/cmd`, { cmd: { op: 'start' }, v: job.v })).job
    const live = Object.keys(started.flow).find((k) => T.isLive(started.flow[k]))!
    const { run } = await json('POST', '/api/runs', { job: job.id, step: live, instruction: 'smoke' })
    const states = () => events.filter((e) => e.kind === 'run' && (e.run as { id: string }).id === run.id).map((e) => (e.run as { state: string }).state)
    await until(() => states().includes('running'), 'the run starts')
    release()
    await until(() => states().includes('draft'), 'the draft')
    const seen = [run.state, ...states()].filter((s, i, a) => s !== a[i - 1])
    assert.deepEqual(seen, ['queued', 'running', 'draft'])
    assert.equal((await json('GET', `/api/jobs/${job.id}`)).job.flow[live].dr?.t, 'smoke draft')
    step('an ask goes queued → running → draft')

    const mcp = (token: string) => new Promise<Res>((ok, no) => {
      const q = httpRequest({ host: '127.0.0.1', port: m.loopbackPort, method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } }, (r) => { void read(r).then(ok) })
      q.on('error', no); q.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }))
    })
    assert.equal((await mcp('wrong')).status, 401)
    const init = await mcp(readFileSync(m.mcpToken, 'utf8').trim())
    assert.equal(init.status, 200); assert.ok(init.headers['mcp-session-id'])
    assert.equal((await lan('/mcp', cookie)).status, 404)
    step('the job MCP answers on loopback with its token, and not on the LAN')
    sse.destroy()
  } finally { await m.close() }
}

run().then(() => { console.log('smoke passed'); process.exit(0) }, (e) => { console.error('smoke failed:', e); process.exit(1) })
