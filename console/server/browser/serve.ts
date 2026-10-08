import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname } from 'node:path'
import type { Bus } from '../events.ts'
import type { Source } from '../workspace.ts'
import type { ActReq, ActRes, ConceptReply } from '../bridge/wire.ts'

/* Any Source served as a bridge gateway on the loopback: /mcp with the read tools LLM runs use (either token),
   and, when a console token is given, the gateway wire the console's BridgeClient speaks (that token only). */

export type Served = { url: string; close(): Promise<void> }

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
const MAX_BODY = 1 << 20
const TOOLS = [
  {
    name: 'bridge_snapshot',
    description: 'Live workplace data straight from the source tools. concepts: comma-separated names (state: jobs, runs, playbooks, marks); '
      + 'empty for all. Each concept carries its own status; anything but ok means unavailable, never empty.',
    inputSchema: { type: 'object', properties: { concepts: { type: 'string' } } },
  },
  {
    name: 'bridge_get',
    description: "Detail of one item: a chat thread's messages, a mail body, a work item's description and comments. cursor pages back through earlier chat messages.",
    inputSchema: { type: 'object', properties: { concept: { type: 'string' }, id: { type: 'string' }, cursor: { type: 'string' } }, required: ['concept', 'id'] },
  },
  { name: 'bridge_status', description: "Whether the bridge is up, and each concept's state.", inputSchema: { type: 'object', properties: {} } },
]

/** writes a fresh token file when there is none; the token is read from it on every request */
export function ensureToken(path: string): string {
  mkdirSync(dirname(path), { recursive: true })
  try { writeFileSync(path, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' }) } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  }
  return path
}

const same = (got: string, want: string) => {
  if (!want) return false
  const a = Buffer.from(got), b = Buffer.from(want)
  return a.length === b.length && timingSafeEqual(a, b)
}
const bearer = (req: IncomingMessage) => /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? ''

/** an act's answer as the gateway sends it: ok carries the result in items, an error its code as the status */
export function wireAct(r: ActRes): ConceptReply {
  if (r.status === 'ok') return { status: 'ok', rev: 0, items: r.result ?? null }
  return { status: r.error?.code ?? r.status, message: r.error?.message ?? r.status }
}

export async function serveBridge(o: {
  source: Source; bus: Bus; host?: string; port: number; llmToken: () => string; consoleToken?: () => string; name?: string; statusMs?: number
}): Promise<Served> {
  const host = o.host ?? '127.0.0.1'
  if (!LOOPBACK.has(host)) throw new Error(`the bridge is served on the loopback only, not ${host}`)
  const src = o.source, streams = new Set<ServerResponse>()
  let last: { at: string; state: string; concepts: Record<string, string> } | null = null

  const out = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    if (res.headersSent) return
    res.writeHead(status, { 'cache-control': 'no-store', ...(body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }), ...headers })
    res.end(body === undefined ? undefined : JSON.stringify(body))
  }
  const readBody = (req: IncomingMessage) => new Promise<unknown>((ok, no) => {
    const parts: Buffer[] = []; let n = 0
    req.on('data', (c: Buffer) => { n += c.length; if (n > MAX_BODY) { no(new Error('too_large')); req.destroy() } else parts.push(c) })
    req.on('end', () => { try { const t = Buffer.concat(parts).toString('utf8'); ok(t ? JSON.parse(t) : {}) } catch (e) { no(e) } })
    req.on('error', no)
  })
  const names = (raw: unknown) => String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const snapshot = async (want: string[]) => ({
    bridge: { state: src.available() ? 'up' : 'down', at: last?.at ?? new Date().toISOString() },
    concepts: await src.read(want.length ? want : Object.keys(src.concepts())),
  })
  const status = () => ({ state: src.available() ? 'up' : 'down', machine: o.name ?? 'local', at: new Date().toISOString(), concepts: src.concepts() })

  const run = async (name: string, a: Record<string, unknown>): Promise<unknown> => {
    if (name === 'bridge_snapshot') return snapshot(names(a.concepts))
    if (name === 'bridge_get') return src.get(String(a.concept ?? ''), String(a.id ?? ''), typeof a.cursor === 'string' && a.cursor ? a.cursor : undefined)
    return { state: src.available() ? 'up' : 'down', last }
  }
  type Rpc = { id?: string | number | null; method?: unknown; params?: Record<string, unknown> }
  const one = async (m: Rpc, made: { sid?: string }) => {
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id: m.id ?? null, result })
    const error = (code: number, message: string) => ({ jsonrpc: '2.0', id: m?.id ?? null, error: { code, message } })
    if (!m || typeof m !== 'object' || typeof m.method !== 'string') return error(-32600, 'not a JSON-RPC request')
    if (m.id === undefined) return undefined
    switch (m.method) {
      case 'initialize': {
        const asked = String(m.params?.protocolVersion ?? '')
        made.sid = randomUUID()
        return reply({
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0], capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'bridge', version: '1.0.0' },
          instructions: 'Read-only workplace data. Each concept carries its own status; anything but ok means unavailable, never empty.',
        })
      }
      case 'ping': return reply({})
      case 'tools/list': return reply({ tools: TOOLS })
      case 'tools/call': {
        const name = String(m.params?.name)
        if (!TOOLS.some((t) => t.name === name)) return error(-32602, `no tool ${name}`)
        try {
          return reply({ content: [{ type: 'text', text: JSON.stringify(await run(name, (m.params?.arguments as Record<string, unknown>) ?? {})) }] })
        } catch (e) {
          return reply({ content: [{ type: 'text', text: String((e as Error)?.message ?? e) }], isError: true })
        }
      }
      default: return error(-32601, `no method ${m.method}`)
    }
  }
  const mcp = async (req: IncomingMessage, res: ServerResponse) => {
    const tok = bearer(req)
    if (!same(tok, o.llmToken()) && !(o.consoleToken && same(tok, o.consoleToken())))
      return out(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'missing or wrong bearer token' } })
    if (req.method === 'DELETE') return out(res, 200)
    if (req.method !== 'POST') return out(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'POST only; this server sends no event stream' } }, { allow: 'POST, DELETE' })
    let body: unknown
    try { body = await readBody(req) } catch { return out(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'the body is not JSON' } }) }
    const made: { sid?: string } = {}, batch = Array.isArray(body)
    const replies = (await Promise.all(((batch ? body : [body]) as Rpc[]).map((m) => one(m, made)))).filter((r) => r !== undefined)
    const headers: Record<string, string> = made.sid ? { 'mcp-session-id': made.sid } : {}
    if (!replies.length) return out(res, 202, undefined, headers)
    out(res, 200, batch ? replies : replies[0], headers)
  }

  const send = (res: ServerResponse, ev: string, data: unknown) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`)
  const broadcast = (ev: string, data: unknown) => { for (const s of streams) send(s, ev, data) }
  const api = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (!o.consoleToken) return out(res, 404, { error: 'not_found' })
    if (!same(bearer(req), o.consoleToken())) return out(res, 401, { error: 'unauthorized' })
    const p = url.pathname
    if (req.method === 'GET' && p === '/api/snapshot') return out(res, 200, await snapshot(names(url.searchParams.get('concepts'))))
    const item = /^\/api\/items\/([^/]+)\/([^/]+)$/.exec(p)
    if (req.method === 'GET' && item)
      return out(res, 200, await src.get(decodeURIComponent(item[1]), decodeURIComponent(item[2]), url.searchParams.get('cursor') || undefined))
    if (req.method === 'POST' && p === '/api/act') {
      const a = (await readBody(req)) as ActReq
      return out(res, 200, wireAct(await src.act({ action: String(a.action ?? ''), actionId: String(a.actionId ?? ''), args: a.args ?? {} })))
    }
    if (p.startsWith('/api/state/') && (req.method === 'GET' || req.method === 'POST'))
      return out(res, 200, await src.state(req.method, p, req.method === 'POST' ? await readBody(req) : undefined))
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      streams.add(res)
      req.on('close', () => streams.delete(res))
      return send(res, 'status', status())
    }
    out(res, 404, { error: 'not_found' })
  }

  // a change goes out as a delta at the concept's rev now; a client whose rev does not line up re-reads it
  const offBus = o.bus.on((e) => {
    if (e.kind === 'bridge') { last = { at: new Date().toISOString(), state: e.state, concepts: e.concepts }; if (streams.size) broadcast('status', status()); return }
    if (e.kind !== 'source' || !streams.size || !o.consoleToken) return
    void src.read([e.concept]).then((r) => {
      const toRev = r[e.concept]?.rev ?? 0
      broadcast('delta', e.reset
        ? { concept: e.concept, fromRev: toRev, toRev, upserts: [], removes: [], resync: true }
        : { concept: e.concept, fromRev: toRev - 1, toRev, upserts: e.upserts, removes: e.removes })
    }, () => {})
  })
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://bridge')
    const go = url.pathname === '/mcp' ? mcp(req, res) : url.pathname.startsWith('/api/') ? api(req, res, url) : Promise.resolve(out(res, 404, { error: 'not_found' }))
    go.catch((e: unknown) => {
      if ((e as Error)?.message === 'too_large') return out(res, 413, { error: 'too_large' })
      if (e instanceof SyntaxError) return out(res, 400, { error: 'bad_request' })
      console.error(`bridge: ${req.method} ${url.pathname} failed:`, (e as Error)?.message ?? e)
      if (res.headersSent) res.destroy(); else out(res, 500, { error: 'internal_error' })
    })
  })
  const tick = setInterval(() => broadcast('status', status()), o.statusMs ?? 10_000)
  tick.unref()
  try {
    await new Promise<void>((ok, no) => { server.once('error', no); server.listen(o.port, host, () => { server.off('error', no); ok() }) })
  } catch (e) { clearInterval(tick); offBus(); throw e }
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    async close() {
      clearInterval(tick); offBus()
      for (const s of streams) s.destroy()
      streams.clear()
      server.closeAllConnections()
      await new Promise<void>((ok) => server.close(() => ok()))
    },
  }
}
