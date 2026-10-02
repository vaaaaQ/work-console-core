import { createReadStream, existsSync, statSync } from 'node:fs'
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { adapt } from '../../src/live/adapt.ts'
import type * as T from '../../src/model/transitions.ts'
import type { Cmd, Job, Playbook } from '../../src/model/types.ts'
import { startItem } from '../board/start.ts'
import { resolveAct } from '../bridge/actions.ts'
import { GatewayError, READY } from '../bridge/wire.ts'
import type { ActRes, ConceptReply } from '../bridge/wire.ts'
import { HttpError } from '../events.ts'
import type { Bus, Ev } from '../events.ts'
import type { Jobs } from '../jobs/jobs.ts'
import { knowledge, noteIn } from '../knowledge/knowledge.ts'
import { safeName } from '../llm/runner.ts'
import type { Runner } from '../llm/runner.ts'
import type { Notify } from '../notify/notify.ts'
import { qrSvg } from '../pairing/pairing.ts'
import type { Pairing } from '../pairing/pairing.ts'
import type { Store } from '../store/port.ts'

/* Two listeners over one router. Loopback trusts the PC but checks Host and Origin, so a web page
   the browser happens to have open cannot drive it (DNS rebinding, cross-site POST). LAN serves the
   page to anyone and the API only to a paired device cookie; pairing and devices stay PC-only. */

export interface Bridge {
  available(): boolean
  concepts(): Record<string, string>
  read(concepts: string[]): Promise<Record<string, ConceptReply>>
  get(concept: string, id: string, cursor?: string): Promise<ConceptReply>
  act(a: { action: string; actionId: string; args: Record<string, unknown> }): Promise<ActRes>
  state(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ConceptReply>
}
export interface Deps {
  loopbackPort: number; lanPort: number; pcName: string
  bus: Bus; store: Store; jobs: Jobs; runner: Runner; bridge: Bridge; pairing: Pairing; notify?: Notify
  ctx: () => T.Ctx
  /** stores a playbook (null deletes it) and refreshes what ctx() returns */
  putPlaybook(id: string, pb: Playbook | null): Promise<void>
  staticDirs: string[]; artifactsDir: string
  /** the pack's team zone for calendar times; null when it has none */
  tz?: string | null
  /** the job tools for Claude Code sessions, served on loopback only */
  mcp?: RequestListener
}

type Side = 'loopback' | 'lan'
type Req = { side: Side; m: string; path: string; q: URLSearchParams; p: string[]; body: () => Promise<Record<string, unknown>>; device: string | null; req: IncomingMessage; res: ServerResponse }

const COOKIE = 'wc_dev'
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
}
/** a downloaded artifact's type; every other one, html included, goes as plain text */
const ART_TYPES: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.json': 'application/json; charset=utf-8', '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}
const PC_ONLY = /^\/api\/(pair|devices)(\/|$)/

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent) return
  const txt = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(txt)
}
const fail = (res: ServerResponse, status: number, code: string, message: string) => send(res, status, { error: { code, message } })

function readBody(req: IncomingMessage, limit = 2 << 20): Promise<Record<string, unknown>> {
  return new Promise((ok, no) => {
    const parts: Buffer[] = []; let n = 0
    req.on('data', (c: Buffer) => {
      n += c.length
      if (n > limit) { no(new HttpError(413, 'too_large', 'the request body is too large')); req.destroy() } else parts.push(c)
    })
    req.on('end', () => {
      const t = Buffer.concat(parts).toString('utf8')
      if (!t) return ok({})
      try {
        const v = JSON.parse(t)
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object')
        ok(v)
      } catch { no(new HttpError(400, 'bad_json', 'the body is not a JSON object')) }
    })
    req.on('error', no)
  })
}

const cookieOf = (req: IncomingMessage, name: string) => {
  for (const kv of (req.headers.cookie || '').split(';')) {
    const i = kv.indexOf('=')
    if (i > 0 && kv.slice(0, i).trim() === name) { try { return decodeURIComponent(kv.slice(i + 1).trim()) } catch { return undefined } }
  }
  return undefined
}
const deviceName = (ua = '') => (/iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : 'device')
const str = (v: unknown, what: string) => {
  if (typeof v !== 'string' || !v) throw new HttpError(400, 'bad_args', `${what} is missing`)
  return v
}

export function createApp(d: Deps) {
  /** open event streams and the paired device each belongs to (null = the PC) */
  const streams = new Map<ServerResponse, string | null>()
  const loopHosts = new Set([`localhost:${d.loopbackPort}`, `127.0.0.1:${d.loopbackPort}`])

  /** null when the request may go on; otherwise it has been answered */
  function guard(side: Side, req: IncomingMessage, res: ServerResponse, path: string): { device: string | null } | null {
    const host = (req.headers.host || '').toLowerCase(), origin = req.headers.origin
    if (side === 'loopback') {
      if (!loopHosts.has(host)) { fail(res, 403, 'bad_host', 'this address is served on localhost only'); return null }
      if (origin && !loopHosts.has(origin.toLowerCase().replace(/^http:\/\//, ''))) { fail(res, 403, 'bad_origin', 'cross-site request'); return null }
      return { device: null }
    }
    if (origin && origin.toLowerCase() !== `https://${host}`) { fail(res, 403, 'bad_origin', 'cross-site request'); return null }
    if (!path.startsWith('/api/')) return { device: null }
    if (PC_ONLY.test(path)) { fail(res, 403, 'pc_only', 'pairing and devices are managed on the PC'); return null }
    const dev = d.pairing.check(cookieOf(req, COOKIE))
    if (!dev) { fail(res, 401, 'not_paired', 'this device is not paired; scan the pairing code on the PC'); return null }
    return { device: dev.id }
  }

  /** a part B cannot give is empty and marked unavailable, so the page never reads it as "no jobs" */
  const part = async <T>(p: Promise<T>, empty: T): Promise<[T, 'ok' | 'unavailable']> => {
    try { return [await p, 'ok'] } catch (e) { if (e instanceof GatewayError) return [empty, 'unavailable']; throw e }
  }
  async function state(r: Req) {
    const [[jobs, js], [runs, rs], [marks, ms]] = await Promise.all([part(d.jobs.all(), []), part(d.runner.all(), []), part(d.store.marks(), {})])
    return {
      jobs, runs, marks, parts: { jobs: js, runs: rs, marks: ms }, playbooks: d.ctx().PB,
      bridge: { state: d.bridge.available() ? 'ok' : 'unavailable', concepts: d.bridge.concepts() },
      side: r.side, device: r.device, push: d.notify ? { key: d.notify.publicKey() } : null,
    }
  }

  async function sources(concepts: string[]) {
    let raw: Record<string, ConceptReply>
    try { raw = await d.bridge.read(concepts) } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      raw = Object.fromEntries(concepts.map((c) => [c, { status: 'unavailable', message }]))
    }
    const out: Record<string, ConceptReply> = {}
    for (const c of concepts) {
      const r = raw[c] || { status: 'unavailable', message: 'the bridge did not answer for this concept' }
      if (!READY.has(r.status) || !Array.isArray(r.items)) { out[c] = { status: r.status === 'ok' ? 'unavailable' : r.status, message: r.message }; continue }
      const items = r.items as Record<string, unknown>[]
      out[c] = {
        status: 'ok', rev: r.rev,
        items: c === 'chat' ? items.map((i) => adapt.chat(i))
          : c === 'mail' ? items.map((i) => adapt.mail(i, { done: i.done === true || undefined, job: typeof i.job === 'string' ? i.job : undefined }))
            : c === 'cal' ? items.map((i) => ({ id: i.id, ...adapt.cal(i, d.tz ?? null) }))
              : items,
      }
    }
    return { concepts: out }
  }

  async function item(concept: string, id: string, cursor?: string) {
    const r = await d.bridge.get(concept, id, cursor)
    if (!READY.has(r.status)) throw new HttpError(503, r.status, r.message || `${concept} is unavailable`)
    const it = (r.items || {}) as Record<string, unknown>
    if (concept === 'chat' && Array.isArray(it.messages)) return { ...it, messages: (it.messages as Record<string, unknown>[]).map((m) => adapt.msg(m)) }
    return it
  }

  function events(r: Req) {
    r.res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    r.res.write('retry: 3000\n\n')
    // a source event only tells the page what to re-read; B's deltas can carry whole jobs
    const out = (e: Ev) => {
      if (r.res.writableEnded) return
      const x = e.kind === 'source' ? { kind: e.kind, concept: e.concept, upserts: [], removes: [] } : e
      r.res.write(`event: ${e.kind}\ndata: ${JSON.stringify(x)}\n\n`)
    }
    out({ kind: 'bridge', state: d.bridge.available() ? 'ok' : 'unavailable', concepts: d.bridge.concepts() })
    const off = d.bus.on(out), ping = setInterval(() => r.res.write(': ping\n\n'), 25000)
    streams.set(r.res, r.device)
    r.res.on('close', () => { off(); clearInterval(ping); streams.delete(r.res) })
  }

  async function act(b: Record<string, unknown>) {
    if (!d.bridge.available()) throw new HttpError(503, 'bridge_unavailable', 'the bridge is unavailable; nothing was sent')
    const chats = async () => {
      const c = (await d.bridge.read(['chat'])).chat
      return READY.has(c?.status) && Array.isArray(c.items) ? (c.items as { id: string; name: string }[]) : []
    }
    const a = await resolveAct(b as { action: string; actionId?: string; args?: Record<string, unknown> }, chats)
    return { actionId: a.actionId, ...(await d.bridge.act(a)) }
  }

  /** plain text for the page's viewer; ?dl=1 = a download under the file's own name and type */
  function artifact(r: Req, job: string, name: string) {
    const n = safeName(name), f = join(d.artifactsDir, safeName(job), n)
    if (!existsSync(f)) throw new HttpError(404, 'not_found', 'no such artifact')
    const dl = r.q.get('dl') === '1'
    r.res.writeHead(200, {
      'content-type': (dl && ART_TYPES[extname(n).toLowerCase()]) || 'text/plain; charset=utf-8', 'cache-control': 'no-store',
      'content-disposition': dl ? `attachment; filename="${n.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(n)}` : 'inline',
    })
    createReadStream(f).pipe(r.res)
  }

  async function cmd(id: string, b: Record<string, unknown>) {
    try { return await d.jobs.cmd(id, b.cmd as Cmd, typeof b.v === 'number' ? b.v : undefined) } catch (e) {
      if (e instanceof HttpError && e.status === 409) throw Object.assign(e, { job: await d.jobs.get(id) })
      throw e
    }
  }

  const kn = knowledge(d.bridge)
  const start = startItem({ jobs: d.jobs, ctx: d.ctx, bridge: d.bridge })

  const routes: [string, RegExp, (r: Req) => Promise<unknown> | unknown][] = [
    ['GET', /^\/api\/state$/, state],
    ['GET', /^\/api\/jobs$/, async () => ({ jobs: await d.jobs.all() })],
    ['POST', /^\/api\/jobs$/, async (r) => {
      const b = await r.body()
      // Date.parse would read a number as a year
      for (const k of ['ev', 'due']) if (b[k] != null && typeof b[k] !== 'string') throw new HttpError(400, 'bad_args', `${k} is not a string`)
      return { job: await d.jobs.create(b as unknown as T.NewJob) }
    }],
    ['GET', /^\/api\/jobs\/([^/]+)$/, async (r) => {
      const job = await d.jobs.get(r.p[0])
      if (!job) throw new HttpError(404, 'not_found', `no job ${r.p[0]}`)
      return { job }
    }],
    ['POST', /^\/api\/jobs\/([^/]+)\/cmd$/, async (r) => cmd(r.p[0], await r.body())],
    ['POST', /^\/api\/undo$/, async (r) => {
      const b = await r.body()
      return { job: await d.jobs.undo(str(b.job, 'job'), Number(b.v), b.prev as Job) }
    }],
    ['POST', /^\/api\/act$/, async (r) => act(await r.body())],
    ['POST', /^\/api\/board\/([^/]+)\/start$/, async (r) => {
      const b = await r.body()
      return start(r.p[0], typeof b.pb === 'string' && b.pb ? b.pb : undefined, 'page')
    }],
    ['GET', /^\/api\/sources$/, (r) => sources((r.q.get('concepts') || 'chat,mail,cal').split(',').map((s) => s.trim()).filter(Boolean))],
    ['GET', /^\/api\/sources\/([^/]+)\/([^/]+)$/, async (r) => ({ item: await item(r.p[0], r.p[1], r.q.get('cursor') || undefined) })],
    ['POST', /^\/api\/mail\/([^/]+)\/mark$/, async (r) => {
      const b = await r.body()
      await d.store.putMark(r.p[0], { done: b.done === true || undefined, job: typeof b.job === 'string' ? b.job : undefined })
      return { ok: true }
    }],
    // hiding is the console's own mark in B, never the chat tool's; unhiding deletes the mark
    ['POST', /^\/api\/chats\/([^/]+)\/hide$/, async (r) => {
      const b = await r.body()
      await d.store.putMark(`chat:${r.p[0]}`, b.hidden === true ? { hidden: true, name: typeof b.name === 'string' ? b.name : r.p[0] } : null)
      return { ok: true }
    }],
    ['GET', /^\/api\/chats\/hidden$/, async () => ({
      hidden: Object.entries(await d.store.marks()).filter(([id, m]) => id.startsWith('chat:') && m.hidden).map(([id, m]) => ({ id: id.slice(5), name: m.name ?? id.slice(5) })),
    })],
    ['PUT', /^\/api\/playbooks\/([^/]+)$/, async (r) => {
      const b = await r.body()
      await d.putPlaybook(r.p[0], (b.pb as Playbook) ?? null)
      return { playbooks: d.ctx().PB }
    }],
    ['DELETE', /^\/api\/playbooks\/([^/]+)$/, async (r) => {
      await d.putPlaybook(r.p[0], null)
      return { playbooks: d.ctx().PB }
    }],
    ['GET', /^\/api\/knowledge$/, async () => ({ notes: await kn.list() })],
    ['GET', /^\/api\/knowledge\/search$/, async (r) => ({ hits: await kn.search(r.q.get('q') || '', (r.q.get('tags') || '').split(',').map((s) => s.trim()).filter(Boolean)) })],
    ['GET', /^\/api\/knowledge\/notes\/([^/]+)$/, async (r) => ({ note: await kn.read(r.p[0]) })],
    ['POST', /^\/api\/knowledge\/notes$/, async (r) => ({ note: await kn.save(null, noteIn(await r.body()), null) })],
    ['PUT', /^\/api\/knowledge\/notes\/([^/]+)$/, async (r) => {
      const b = await r.body()
      if (typeof b.v !== 'number') throw new HttpError(400, 'bad_args', 'an edit names the v it replaces')
      return { note: await kn.save(r.p[0], noteIn(b), b.v) }
    }],
    ['GET', /^\/api\/knowledge\/proposals$/, async () => ({ proposals: await kn.proposals() })],
    ['POST', /^\/api\/knowledge\/proposals\/([^/]+)\/decide$/, async (r) => {
      const b = await r.body()
      return { note: await kn.decide(r.p[0], b.accept === true, typeof b.text === 'string' ? b.text : undefined) }
    }],
    ['GET', /^\/api\/runs$/, async () => ({ runs: await d.runner.all() })],
    ['POST', /^\/api\/runs$/, async (r) => {
      const b = await r.body()
      return { run: await d.runner.ask(str(b.job, 'job'), str(b.step, 'step'), String(b.instruction ?? '')) }
    }],
    ['GET', /^\/api\/runs\/([^/]+)$/, async (r) => {
      const run = await d.runner.get(r.p[0])
      if (!run) throw new HttpError(404, 'not_found', `no run ${r.p[0]}`)
      return { run, feed: d.runner.feed(run.id) }
    }],
    ['POST', /^\/api\/runs\/([^/]+)\/cancel$/, async (r) => ({ run: await d.runner.cancel(r.p[0]) })],
    ['POST', /^\/api\/runs\/([^/]+)\/resume$/, async (r) => ({ run: await d.runner.resume(r.p[0]) })],
    ['GET', /^\/api\/artifacts\/([^/]+)\/([^/]+)$/, (r) => artifact(r, r.p[0], r.p[1])],
    ['POST', /^\/api\/push\/subscribe$/, async (r) => {
      if (!d.notify) throw new HttpError(404, 'not_found', 'push is off')
      try { d.notify.subscribe((await r.body()).sub as never) } catch (e) {
        if (e instanceof HttpError) throw e
        throw new HttpError(400, 'bad_args', (e as Error).message)
      }
      return { ok: true }
    }],
    ['POST', /^\/api\/pair\/new$/, async () => {
      const { code, expires } = d.pairing.newCode()
      const url = `https://${d.pcName}:${d.lanPort}/pair?code=${code}`
      return { url, expires: new Date(expires).toISOString(), qr: await qrSvg(url) }
    }],
    ['GET', /^\/api\/devices$/, () => ({ devices: d.pairing.devices() })],
    ['DELETE', /^\/api\/devices\/([^/]+)$/, (r) => {
      if (!d.pairing.revoke(r.p[0])) throw new HttpError(404, 'not_found', 'no such device')
      // a revoked phone stops hearing events now, not at its next reconnect
      for (const [s, dev] of streams) if (dev === r.p[0]) { s.end(); streams.delete(s) }
      return { ok: true }
    }],
    ['GET', /^\/api\/events$/, events],
  ]

  function pair(side: Side, req: IncomingMessage, res: ServerResponse, q: URLSearchParams) {
    if (side !== 'lan') return fail(res, 404, 'not_found', 'pairing links open on the phone')
    const got = d.pairing.redeem(q.get('code') || '', deviceName(req.headers['user-agent']))
    if (!got) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      return res.end('This pairing code is used or expired. Show a new one on the PC.')
    }
    res.writeHead(302, {
      location: '/', 'cache-control': 'no-store',
      'set-cookie': `${COOKIE}=${got.token}; Path=/; Max-Age=${10 * 365 * 86400}; HttpOnly; Secure; SameSite=Strict`,
    })
    res.end()
  }

  function file(res: ServerResponse, path: string) {
    let rel: string
    try { rel = decodeURIComponent(path) } catch { return fail(res, 400, 'bad_path', 'bad path') }
    for (const dir of d.staticDirs) {
      const root = resolve(dir)
      for (const cand of rel === '/' ? ['/index.html'] : [rel]) {
        const f = resolve(join(root, cand))
        if (f !== root && !f.startsWith(root + sep)) continue
        if (existsSync(f) && statSync(f).isFile()) {
          res.writeHead(200, {
            'content-type': MIME[extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache',
            ...(f.endsWith('sw.js') ? { 'service-worker-allowed': '/' } : {}),
          })
          return void createReadStream(f).pipe(res)
        }
      }
    }
    if (!extname(rel) && rel !== '/') return file(res, '/')
    fail(res, 404, 'not_found', 'no such file')
  }

  function listener(side: Side): RequestListener {
    return (req, res) => {
      const u = new URL(req.url || '/', 'http://x'), path = u.pathname, m = req.method || 'GET'
      res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('x-frame-options', 'DENY')
      const g = guard(side, req, res, path)
      if (!g) return
      if (path === '/mcp') return side === 'loopback' && d.mcp ? d.mcp(req, res) : fail(res, 404, 'not_found', 'no route /mcp')
      if (path === '/pair') return pair(side, req, res, u.searchParams)
      if (!path.startsWith('/api/')) return m === 'GET' || m === 'HEAD' ? file(res, path) : fail(res, 405, 'method', 'method not allowed')
      if (m !== 'GET' && m !== 'DELETE' && !/^application\/json\b/i.test(req.headers['content-type'] || ''))
        return fail(res, 415, 'json_only', 'send application/json')
      for (const [rm, re, h] of routes) {
        const hit = path.match(re)
        if (!hit || rm !== m) continue
        let p: string[]
        try { p = hit.slice(1).map(decodeURIComponent) } catch { return fail(res, 400, 'bad_path', 'bad path') }
        const r: Req = { side, m, path, q: u.searchParams, p, body: () => readBody(req), device: g.device, req, res }
        Promise.resolve().then(() => h(r)).then((out) => { if (out !== undefined) send(res, 200, out) }, (e) => {
          if (e instanceof HttpError || e instanceof GatewayError) {
            const extra = (e as { job?: Job }).job
            return send(res, e.status, { error: { code: e.code, message: e.message }, ...(extra ? { job: extra } : {}) })
          }
          console.error('request failed', m, path, e)
          fail(res, 500, 'internal', 'the console hit an error; see its log')
        })
        return
      }
      if (routes.some(([, re]) => re.test(path))) return fail(res, 405, 'method', `${m} is not allowed on ${path}`)
      fail(res, 404, 'not_found', `no route ${m} ${path}`)
    }
  }

  return {
    loopback: listener('loopback'), lan: listener('lan'),
    /** ends the open SSE streams so a server can close */
    close() { for (const s of streams.keys()) s.end(); streams.clear() },
  }
}
