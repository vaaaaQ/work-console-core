import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bus } from '../events.ts'
import type { Source, WsConfig } from '../workspace.ts'
import type { ActReq } from '../bridge/wire.ts'
import { localSource } from '../bridge/local.ts'
import type { StateDocs } from './state.ts'
import { serveBridge } from './serve.ts'
import { browserPlugin } from './plugin.ts'

const root = mkdtempSync(join(tmpdir(), 'wc-serve-'))
const closing: (() => Promise<void> | void)[] = []
after(async () => { for (const c of closing.reverse()) await c(); rmSync(root, { recursive: true, force: true }) })

/** a Source that answers the same things every time */
function stubSource() {
  const acts: ActReq[] = []
  const src: Source = {
    available: () => true,
    concepts: () => ({ work: 'ready', jobs: 'ready' }),
    read: async (cs) => Object.fromEntries(cs.map((c) => [c, c === 'work' ? { status: 'ok', rev: 3, items: [{ id: 'W-1' }] } : { status: 'source_error', message: `no ${c}` }])),
    get: async (_c, id) => ({ status: 'ok', rev: 3, items: { id, description: 'd' } }),
    act: async (a) => {
      acts.push(a)
      return a.action === 'work.comment' ? { status: 'ok', result: { done: 1 } } : { status: 'error', error: { code: 'unknown_action', message: `no ${a.action}` } }
    },
    state: async (method, path, body) => ({ status: 'ok', items: { method, path, body } }),
    start() {}, stop() {},
  }
  return { src, acts }
}

async function serve(o: { console?: boolean } = {}) {
  const bus = new Bus(), { src, acts } = stubSource()
  const s = await serveBridge({ source: src, bus, port: 0, llmToken: () => 'llm-t', ...(o.console ? { consoleToken: () => 'con-t' } : {}) })
  closing.push(() => s.close())
  return { s, bus, acts }
}
const rpc = async (url: string, body: unknown, tok: string | null = 'llm-t') => {
  const r = await fetch(url + '/mcp', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
  })
  return { status: r.status, sid: r.headers.get('mcp-session-id'), body: r.status === 202 ? null : await r.json() as any }
}
const tool = async (url: string, name: string, args: Record<string, unknown> = {}) =>
  JSON.parse((await rpc(url, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } })).body.result.content[0].text)
const wire = async (url: string, path: string, o: { tok?: string | null; body?: unknown } = {}) => {
  const tok = o.tok === undefined ? 'con-t' : o.tok
  const r = await fetch(url + path, {
    method: o.body === undefined ? 'GET' : 'POST', ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
  })
  return { status: r.status, body: await r.json() as any }
}
/** reads an event stream until want matches what came, or ms pass */
async function stream(url: string, want: RegExp, then: () => void = () => {}, ms = 3000) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms)
  let buf = ''
  try {
    const r = await fetch(url + '/api/events', { signal: ac.signal, headers: { authorization: 'Bearer con-t' } })
    assert.equal(r.status, 200)
    let fired = false
    for await (const ch of r.body as unknown as AsyncIterable<Uint8Array>) {
      buf += Buffer.from(ch).toString('utf8')
      if (!fired && /event: status\n/.test(buf)) { fired = true; then() }
      if (want.test(buf)) break
    }
  } catch { /* aborted at the deadline */ } finally { clearTimeout(t); ac.abort() }
  return buf
}

test('the MCP refuses a missing or wrong bearer with 401', async () => {
  const { s } = await serve()
  assert.equal((await rpc(s.url, { jsonrpc: '2.0', id: 1, method: 'ping' }, null)).status, 401)
  assert.equal((await rpc(s.url, { jsonrpc: '2.0', id: 1, method: 'ping' }, 'nope')).status, 401)
})

test('an empty token authorizes nobody', async () => {
  const s = await serveBridge({ source: stubSource().src, bus: new Bus(), port: 0, llmToken: () => '' })
  closing.push(() => s.close())
  const r = await fetch(s.url + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ', 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' })
  assert.equal(r.status, 401)
})

test('initialize gives a session, and tools/list gives the three read tools', async () => {
  const { s } = await serve()
  const init = await rpc(s.url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
  assert.equal(init.status, 200)
  assert.equal(init.body.result.protocolVersion, '2025-06-18')
  assert.ok(init.body.result.capabilities.tools)
  assert.ok(init.sid)
  assert.equal((await rpc(s.url, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202)
  const list = await rpc(s.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
  assert.deepEqual(list.body.result.tools.map((t: { name: string }) => t.name).sort(), ['bridge_get', 'bridge_snapshot', 'bridge_status'])
  assert.equal((await rpc(s.url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bridge_act', arguments: {} } })).body.error.code, -32602)
})

test("bridge_snapshot answers the source's concepts; bridge_get its get; bridge_status says up", async () => {
  const { s, bus } = await serve()
  const snap = await tool(s.url, 'bridge_snapshot', { concepts: 'work, mail' })
  assert.equal(snap.bridge.state, 'up')
  assert.deepEqual(snap.concepts.work, { status: 'ok', rev: 3, items: [{ id: 'W-1' }] })
  assert.equal(snap.concepts.mail.status, 'source_error')
  assert.deepEqual(Object.keys((await tool(s.url, 'bridge_snapshot')).concepts).sort(), ['jobs', 'work'], 'no concepts = all of them')
  assert.deepEqual(await tool(s.url, 'bridge_get', { concept: 'work', id: 'W-9' }), { status: 'ok', rev: 3, items: { id: 'W-9', description: 'd' } })
  bus.emit({ kind: 'bridge', state: 'ok', concepts: { work: 'signin_required' } })
  const st = await tool(s.url, 'bridge_status')
  assert.equal(st.state, 'up')
  assert.equal(st.last.concepts.work, 'signin_required')
})

test('the wire is not served without a console token', async () => {
  const { s } = await serve()
  assert.equal((await wire(s.url, '/api/snapshot', { tok: 'llm-t' })).status, 404)
})

test('the wire needs the console token; the llm token cannot act', async () => {
  const { s, acts } = await serve({ console: true })
  assert.equal((await wire(s.url, '/api/snapshot', { tok: null })).status, 401)
  assert.equal((await wire(s.url, '/api/act', { tok: 'llm-t', body: { action: 'work.comment', actionId: 'a', args: {} } })).status, 401)
  assert.equal(acts.length, 0)
  const snap = await wire(s.url, '/api/snapshot?concepts=work')
  assert.deepEqual([snap.status, snap.body.bridge.state, snap.body.concepts.work.rev], [200, 'up', 3])
  assert.deepEqual((await wire(s.url, '/api/items/work/W%2F1?cursor=c')).body.items, { id: 'W/1', description: 'd' })
})

test('an act answers in the wire shape: ok with its result in items, an error by its code', async () => {
  const { s, acts } = await serve({ console: true })
  assert.deepEqual((await wire(s.url, '/api/act', { body: { action: 'work.comment', actionId: 'a1', args: { id: 'W-1' } } })).body, { status: 'ok', rev: 0, items: { done: 1 } })
  const bad = await wire(s.url, '/api/act', { body: { action: 'console.contract.noop', actionId: 'a2', args: {} } })
  assert.equal(bad.body.status, 'unknown_action')
  assert.deepEqual(acts.map((a) => a.actionId), ['a1', 'a2'])
  assert.deepEqual((await wire(s.url, '/api/state/put', { body: { concept: 'jobs' } })).body.items, { method: 'POST', path: '/api/state/put', body: { concept: 'jobs' } })
})

test('the event stream sends status at once, then a delta per source change', async () => {
  const { s, bus } = await serve({ console: true })
  const buf = await stream(s.url, /resync/, () => {
    bus.emit({ kind: 'source', concept: 'work', upserts: [{ id: 'W-2' }], removes: [] })
    setTimeout(() => bus.emit({ kind: 'source', concept: 'work', upserts: [], removes: [], reset: true }), 50)
  })
  assert.match(buf, /^event: status\ndata: \{/)
  const status = JSON.parse(/event: status\ndata: (.*)\n/.exec(buf)![1])
  assert.deepEqual([status.state, status.concepts], ['up', { work: 'ready', jobs: 'ready' }])
  const deltas = [...buf.matchAll(/event: delta\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]))
  assert.deepEqual(deltas, [
    { concept: 'work', fromRev: 2, toRev: 3, upserts: [{ id: 'W-2' }], removes: [] },
    { concept: 'work', fromRev: 3, toRev: 3, upserts: [], removes: [], resync: true },
  ])
})

test('a non-loopback host is refused', async () => {
  await assert.rejects(serveBridge({ source: stubSource().src, bus: new Bus(), host: '0.0.0.0', port: 0, llmToken: () => 'x' }), /loopback/)
})

const memDocs = (): StateDocs => ({ load: async () => ({ docs: {}, seq: 0 }), put: async () => {}, seq: async () => {} })
const freePort = () => new Promise<number>((ok) => { const v = createServer().listen(0, '127.0.0.1', () => { const p = (v.address() as { port: number }).port; v.close(() => ok(p)) }) })

test('browserPlugin is nothing for a gateway source; for a local one it serves status and front', async () => {
  assert.deepEqual(browserPlugin(stubSource().src), [])
  const cfg = { gatewayUrl: 'http://127.0.0.1:1', consoleTokenPath: '', llmTokenPath: '', workDir: '', runTools: [], teamTz: null, maxSessions: 1 } as WsConfig
  const src = localSource(cfg, { bus: new Bus(), ws: 'w', grants: () => ({ packs: [], hosts: [], config: {} }), docs: memDocs(), home: root })
  closing.push(() => src.stop())
  const [p] = browserPlugin(src)
  assert.equal(p.name, 'browser')
  const route = (m: string, path: string) => p.routes.find(([rm, re]) => rm === m && re.test(path))![2]
  const req = (body: Record<string, unknown> = {}) => ({ q: new URLSearchParams(), p: [], body: async () => body })
  assert.deepEqual(await route('GET', '/browser/status')(req()), { browser: { state: 'off' }, packs: {}, tabs: [], mcp: null })
  await assert.rejects(route('POST', '/browser/front')(req({ host: 'board.example' })), /no tab/)
  await assert.rejects(route('POST', '/browser/front')(req({})), /host/)
  assert.deepEqual(p.state!(), src.status())
})

test('localSource with mcp serves the read tools at the gateway url, on a token it creates', async () => {
  const port = await freePort(), tokenPath = join(root, 'bridge', 'llm.token')
  const cfg = { gatewayUrl: `http://127.0.0.1:${port}`, consoleTokenPath: '', llmTokenPath: tokenPath, workDir: '', runTools: [], teamTz: null, maxSessions: 1 } as WsConfig
  const src = localSource(cfg, { bus: new Bus(), ws: 'w', grants: () => ({ packs: [], hosts: [], config: {} }), docs: memDocs(), home: root, mcp: true })
  closing.push(() => src.stop())
  src.start()
  const end = Date.now() + 5000
  while (!src.status().mcp && Date.now() < end) await new Promise((ok) => setTimeout(ok, 20))
  assert.equal(src.status().mcp, `http://127.0.0.1:${port}/mcp`)
  assert.ok(existsSync(tokenPath))
  const tok = readFileSync(tokenPath, 'utf8').trim()
  assert.match(tok, /^[0-9a-f]{64}$/)
  const r = await rpc(cfg.gatewayUrl, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bridge_snapshot', arguments: { concepts: 'jobs' } } }, tok)
  assert.equal(JSON.parse(r.body.result.content[0].text).concepts.jobs.status, 'ok')
  src.stop()
  const gone = async () => { try { await fetch(cfg.gatewayUrl + '/mcp', { method: 'POST' }); return false } catch { return true } }
  const stopBy = Date.now() + 3000
  while (!(await gone()) && Date.now() < stopBy) await new Promise((ok) => setTimeout(ok, 20))
  assert.ok(await gone(), 'stop closes the MCP listener')
})
