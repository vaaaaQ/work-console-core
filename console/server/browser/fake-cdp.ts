import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import vm from 'node:vm'

/* A stand-in for a Chromium debugging port, for tests: /json/list, /json/new, /json/activate and /json/version,
   and a page websocket answering Page.* and Runtime.evaluate, evaluated in a vm context per tab. */

export type FakeTab = { id: string; url: string; type: string; ctx: vm.Context; reloads: number }
export interface FakeCdp {
  url: string; tabs: FakeTab[]; log: string[]; activated: string[]
  addTab(url: string, globals?: Record<string, unknown>, type?: string): FakeTab
  closeTab(id: string): void
  /** a tab moving to another url, as a sign-in redirect does */
  navigate(id: string, url: string): void
  /** replaces evaluation: return a value, throw for a script error, never settle for a timeout */
  onEval: ((tab: FakeTab, expression: string) => unknown) | null
  /** the globals a tab opened through /json/new gets */
  globalsFor: (url: string) => Record<string, unknown>
  close(): Promise<void>
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const loc = (u: string) => { const x = new URL(u); return { href: x.href, host: x.host, hostname: x.hostname, origin: x.origin, pathname: x.pathname, protocol: x.protocol } }

function frame(text: string): Buffer {
  const p = Buffer.from(text, 'utf8'), n = p.length
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b })()])
  return Buffer.concat([head, p])
}

/** client frames are masked; returns [opcode, payload] per complete frame and keeps the rest */
function frames(buf: Buffer): { out: [number, Buffer][]; rest: Buffer } {
  const out: [number, Buffer][] = []
  let i = 0
  while (buf.length - i >= 2) {
    const op = buf[i] & 15, masked = (buf[i + 1] & 128) !== 0
    let len = buf[i + 1] & 127, at = i + 2
    if (len === 126) { if (buf.length < at + 2) break; len = buf.readUInt16BE(at); at += 2 }
    else if (len === 127) { if (buf.length < at + 8) break; len = Number(buf.readBigUInt64BE(at)); at += 8 }
    const mask = masked ? buf.subarray(at, at + 4) : null
    if (masked) at += 4
    if (buf.length < at + len) break
    const p = Buffer.from(buf.subarray(at, at + len))
    if (mask) for (let k = 0; k < p.length; k++) p[k] ^= mask[k & 3]
    out.push([op, p]); i = at + len
  }
  return { out, rest: buf.subarray(i) }
}

export async function startFakeCdp(o: { globalsFor?: (url: string) => Record<string, unknown> } = {}): Promise<FakeCdp> {
  const tabs: FakeTab[] = [], log: string[] = [], activated: string[] = []
  const sockets = new Map<string, Set<Socket>>()
  let n = 0
  const me = {} as FakeCdp

  const addTab = (url: string, globals: Record<string, unknown> = {}, type = 'page'): FakeTab => {
    const ctx = vm.createContext({ ...globals, location: loc(url) })
    vm.runInContext('globalThis.window = globalThis', ctx)
    const t: FakeTab = { id: `T${++n}`, url, type, ctx, reloads: 0 }
    tabs.push(t)
    return t
  }
  const find = (id: string) => tabs.find((t) => t.id === id)

  async function evaluate(t: FakeTab, expression: string): Promise<Record<string, unknown>> {
    try {
      const v = await (me.onEval ? me.onEval(t, expression) : vm.runInContext(expression, t.ctx))
      return v === undefined ? { result: { type: 'undefined' } } : { result: { type: typeof v, value: JSON.parse(JSON.stringify(v)) } }
    } catch (e) {
      return { result: { type: 'object' }, exceptionDetails: { text: 'Uncaught', exception: { description: String((e as Error)?.stack ?? e) } } }
    }
  }

  async function onMessage(t: FakeTab, s: Socket, raw: string) {
    let m: { id: number; method: string; params?: Record<string, unknown> }
    try { m = JSON.parse(raw) } catch { return }
    log.push(m.method)
    const reply = (r: unknown) => { if (!s.destroyed) s.write(frame(JSON.stringify({ id: m.id, ...r as object }))) }
    if (m.method === 'Runtime.evaluate') return reply({ result: await evaluate(t, String(m.params?.expression)) })
    if (m.method === 'Page.reload') { t.reloads++; return reply({ result: {} }) }
    if (m.method.startsWith('Page.')) return reply({ result: {} })
    reply({ error: { code: -32601, message: `'${m.method}' wasn't found` } })
  }

  const server = createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x'), json = (st: number, b: unknown) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)) }
    const ws = (t: FakeTab) => `${me.url.replace('http', 'ws')}/devtools/page/${t.id}`
    if (u.pathname === '/json/version') return json(200, { Browser: 'Fake/1.0', webSocketDebuggerUrl: `${me.url.replace('http', 'ws')}/devtools/browser/x` })
    if (u.pathname === '/json/list' || u.pathname === '/json') return json(200, tabs.map((t) => ({ id: t.id, type: t.type, url: t.url, title: '', webSocketDebuggerUrl: ws(t) })))
    if (u.pathname === '/json/new') {
      if (req.method !== 'PUT') return json(405, { error: 'use PUT' })
      const url = decodeURIComponent((req.url || '').split('?').slice(1).join('?')) || 'about:blank'
      const t = addTab(url, me.globalsFor(url))
      return json(200, { id: t.id, type: t.type, url: t.url, webSocketDebuggerUrl: ws(t) })
    }
    const act = /^\/json\/activate\/(.+)$/.exec(u.pathname)
    if (act) { const t = find(decodeURIComponent(act[1])); if (!t) { res.writeHead(404); return res.end('No such target id') } activated.push(t.id); res.writeHead(200); return res.end('Target activated') }
    res.writeHead(404); res.end()
  })
  server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
    const m = /^\/devtools\/page\/(.+)$/.exec(new URL(req.url || '/', 'http://x').pathname), t = m && find(decodeURIComponent(m[1]))
    if (!t) { socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n', () => socket.destroy()); return }
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + GUID).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const set = sockets.get(t.id) ?? new Set(); set.add(socket); sockets.set(t.id, set)
    let buf: Buffer = Buffer.alloc(0)
    socket.on('data', (d: Buffer) => {
      const r = frames(Buffer.concat([buf, d])); buf = r.rest
      for (const [op, p] of r.out) {
        if (op === 1) void onMessage(t, socket, p.toString('utf8'))
        else if (op === 8) socket.end(Buffer.from([0x88, 0]))
        else if (op === 9) socket.write(Buffer.concat([Buffer.from([0x8a, p.length]), p]))
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => set.delete(socket))
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))

  Object.assign(me, {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, tabs, log, activated, addTab, onEval: null,
    globalsFor: o.globalsFor ?? (() => ({})),
    closeTab(id: string) {
      const i = tabs.findIndex((t) => t.id === id)
      if (i >= 0) tabs.splice(i, 1)
      for (const s of sockets.get(id) ?? []) s.destroy()
    },
    navigate(id: string, url: string) { const t = find(id); if (t) { t.url = url; t.ctx.location = loc(url) } },
    async close() {
      for (const set of sockets.values()) for (const s of set) s.destroy()
      server.closeAllConnections()
      await new Promise<void>((ok) => server.close(() => ok()))
    },
  })
  return me
}
