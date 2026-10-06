import { createReadStream, existsSync, statSync } from 'node:fs'
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { adapt } from '../../src/live/adapt.ts'
import { ctxOf } from '../../src/model/context.ts'
import type * as T from '../../src/model/transitions.ts'
import type { Cmd, Job, Playbook, RunIntent, RunRec, Tpl } from '../../src/model/types.ts'
import { resolveAct } from '../bridge/actions.ts'
import { GatewayError, READY } from '../bridge/wire.ts'
import type { ActRes, ConceptReply } from '../bridge/wire.ts'
import { HttpError } from '../events.ts'
import type { Bus, Ev } from '../events.ts'
import { noteIn } from '../knowledge/notes.ts'
import { buildIn } from '../llm/builder.ts'
import { resolveItem } from '../llm/context.ts'
import { safeName } from '../llm/runner.ts'
import { TrackerCache } from '../tracker.ts'
import type { Notify } from '../notify/notify.ts'
import { qrSvg } from '../pairing/pairing.ts'
import type { Pairing } from '../pairing/pairing.ts'
import type { Space, Spaces } from '../spaces.ts'
import type { Format } from '../voice/format.ts'
import type { Voice } from '../voice/whisper.ts'
import type { PluginReq } from '../workspace.ts'

/* Two listeners over one router. Loopback trusts the PC but checks Host and Origin, so a web page
   the browser happens to have open cannot drive it (DNS rebinding, cross-site POST). LAN serves the
   page to anyone and the API only to a paired device cookie; pairing and devices stay PC-only.
   Job and run routes are shared and find their workspace by the job id's prefix or by asking each
   runner; the workspace-bound ones live under /api/ws/<id>/, then that workspace's plugin routes. */

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
  /** every space's events on one bus, each tagged with its workspace id */
  hub: Bus
  spaces: Spaces
  pairing: Pairing; notify?: Notify
  staticDirs: string[]; artifactsDir: string
  /** the PC's zone, for /api/state's home */
  tz: string
  /** the job tools for Claude Code sessions, served on loopback only */
  mcp?: RequestListener
  /** the mic's speech to text; none = no voice */
  voice?: Voice
  /** dictated text made clean for a field; none = no Tidy up */
  format?: Format
}

type Side = 'loopback' | 'lan'
/** body(limit) = the JSON body, refused past limit bytes (default 2 MB) */
type Req = { side: Side; m: string; path: string; q: URLSearchParams; p: string[]; body: (limit?: number) => Promise<Record<string, unknown>>; device: string | null; req: IncomingMessage; res: ServerResponse }
type Route<A extends unknown[] = []> = readonly [method: string, path: RegExp, run: (r: Req, ...a: A) => Promise<unknown> | unknown]
type Part = 'ok' | 'unavailable'

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
/** artifact types the page shows as they are; never svg or html, which could run script */
const ART_IMAGES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const PC_ONLY = /^\/api\/(pair|devices)(\/|$)/
/** a workspace-bound route: the workspace id, then the path the per-space table and plugins match */
const IN_WS = /^\/api\/ws\/([^/]+)(\/.*)$/

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
const BAD_PATH = () => new HttpError(400, 'bad_path', 'bad path')
/** aborted when the page drops the request before it is answered */
function dropped(r: Req) {
  const ac = new AbortController()
  r.res.on('close', () => { if (!r.res.writableEnded) ac.abort() })
  return ac.signal
}
/** a saved playbook as a body names it: a name, and phases whose steps have ids */
function pbOf(v: unknown): Playbook | null {
  if (v == null) return null
  const p = v as Playbook
  if (typeof v !== 'object' || typeof p.n !== 'string' || !Array.isArray(p.ph) || !p.ph.every((h) => h && Array.isArray(h.s) && h.s.every((s) => s && typeof s.id === 'string')))
    throw new HttpError(400, 'bad_args', 'pb must be a playbook: a name n and phases ph, each with steps s that have an id')
  return p
}
/** a saved playbook's planned messages: [via, to, text] lists, each under one of its own steps */
function tplOf(pb: Playbook, v: unknown): Record<string, Tpl[]> | undefined {
  if (v == null) return undefined
  if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'bad_args', 'tpl must map step ids to messages')
  const ids = new Set(pb.ph.flatMap((h) => h.s.map((s) => s.id)))
  for (const [sid, list] of Object.entries(v)) {
    if (!ids.has(sid)) throw new HttpError(400, 'bad_args', `tpl names step ${sid}, which the playbook does not have`)
    if (!Array.isArray(list) || !list.every((m) => Array.isArray(m) && m.length === 3 && m.every((x) => typeof x === 'string')))
      throw new HttpError(400, 'bad_args', `tpl ${sid} must be a list of [via, to, text]`)
  }
  return v as Record<string, Tpl[]>
}

/** the first route of the method whose path matches, its params decoded; 'method' when only another method's does */
function find<R extends readonly [string, RegExp, unknown]>(table: readonly R[], m: string, path: string): { run: R[2]; p: string[] } | 'method' | null {
  let other = false
  for (const [rm, re, run] of table) {
    const hit = path.match(re)
    if (!hit) continue
    if (rm !== m) { other = true; continue }
    try { return { run, p: hit.slice(1).map(decodeURIComponent) } } catch { throw BAD_PATH() }
  }
  return other ? 'method' : null
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
  const part = async <T>(p: Promise<T>, empty: T): Promise<[T, Part]> => {
    try { return [await p, 'ok'] } catch (e) { if (e instanceof GatewayError) return [empty, 'unavailable']; throw e }
  }
  const bridgeOf = (s: Space) => ({ state: (s.source.available() ? 'ok' : 'unavailable') as Part, concepts: s.source.concepts() })

  /** one workspace's block in /api/state */
  async function block(s: Space) {
    const [[jobs, js], [runs, rs], [marks, ms]] = await Promise.all([part(s.jobs.all(), []), part(s.runner.all(), []), part(s.store.marks(), {})])
    const plugins: Record<string, unknown> = {}
    for (const p of s.plugins) if (p.state) {
      // one broken plugin must not take the whole page down: its block carries the error instead
      try { plugins[p.name] = await p.state() } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        console.error(`workspace ${s.id}: plugin ${p.name} state failed:`, message)
        plugins[p.name] = { error: message }
      }
    }
    return { jobs, runs, marks, parts: { jobs: js, runs: rs, marks: ms }, playbooks: s.ctx().PB, templates: s.ctx().TPL, bridge: bridgeOf(s), plugins }
  }
  async function state(r: Req) {
    const list = d.spaces.list, blocks = await Promise.all(list.map(block))
    return {
      home: { tz: d.tz, pc: d.pcName },
      side: r.side, device: r.device, push: d.notify ? { key: d.notify.publicKey() } : null,
      voice: d.voice?.ready() ?? false,
      ws: Object.fromEntries(list.map((s, i) => [s.id, blocks[i]])),
    }
  }

  /** every space's list in one; a space B cannot answer for is left out and named in parts, never a 503 for all */
  async function merged<T>(f: (s: Space) => Promise<T[]>) {
    const got = await Promise.all(d.spaces.list.map((s) => part(f(s), [] as T[])))
    return { items: got.flatMap(([x]) => x), parts: Object.fromEntries(d.spaces.list.map((s, i) => [s.id, got[i][1]])) }
  }

  /** the run and the space whose runner knows it; a space that cannot answer is skipped, and when no other
      knows the run its failure is the answer, since the run may be there */
  async function runOf(id: string): Promise<[Space, RunRec]> {
    let failed: unknown
    for (const s of d.spaces.list) {
      try {
        const run = await s.runner.get(id)
        if (run) return [s, run]
      } catch (e) { if (!(e instanceof GatewayError)) throw e; failed ??= e }
    }
    if (failed) throw failed
    throw new HttpError(404, 'not_found', `no run ${id}`)
  }

  async function sources(s: Space, concepts: string[]) {
    let raw: Record<string, ConceptReply>
    try { raw = await s.source.read(concepts) } catch (e) {
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
            : c === 'cal' ? items.map((i) => ({ id: i.id, ...adapt.cal(i, s.cfg.teamTz ?? null) }))
              : items,
      }
    }
    return { concepts: out }
  }

  async function item(s: Space, concept: string, id: string, cursor?: string) {
    const r = await s.source.get(concept, id, cursor)
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
      const x = e.kind === 'source' ? { kind: e.kind, concept: e.concept, upserts: [], removes: [], ws: e.ws } : e
      r.res.write(`event: ${e.kind}\ndata: ${JSON.stringify(x)}\n\n`)
    }
    for (const s of d.spaces.list) out({ kind: 'bridge', ...bridgeOf(s), ws: s.id })
    const off = d.hub.on(out), ping = setInterval(() => r.res.write(': ping\n\n'), 25000)
    streams.set(r.res, r.device)
    r.res.on('close', () => { off(); clearInterval(ping); streams.delete(r.res) })
  }

  async function act(s: Space, b: Record<string, unknown>) {
    if (!s.source.available()) throw new HttpError(503, 'bridge_unavailable', 'the bridge is unavailable; nothing was sent')
    const chats = async () => {
      const c = (await s.source.read(['chat'])).chat
      return READY.has(c?.status) && Array.isArray(c.items) ? (c.items as { id: string; name: string }[]) : []
    }
    const a = await resolveAct(b as { action: string; actionId?: string; args?: Record<string, unknown> }, chats)
    return { actionId: a.actionId, ...(await s.source.act(a)) }
  }

  /** plain text for the page's viewer, an image as itself; ?dl=1 = a download under the file's own name and type */
  function artifact(r: Req, job: string, name: string) {
    const n = safeName(name), f = join(d.artifactsDir, safeName(job), n)
    if (!existsSync(f)) throw new HttpError(404, 'not_found', 'no such artifact')
    const dl = r.q.get('dl') === '1', ext = extname(n).toLowerCase()
    r.res.writeHead(200, {
      'content-type': ART_IMAGES[ext] || (dl && ART_TYPES[ext]) || 'text/plain; charset=utf-8', 'cache-control': 'no-store',
      'content-disposition': dl ? `attachment; filename="${n.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(n)}` : 'inline',
    })
    createReadStream(f).pipe(r.res)
  }

  /** a reject with a reason answers the redo run too, or why none started */
  async function cmd(id: string, b: Record<string, unknown>) {
    const s = d.spaces.byJob(id)
    let res: Awaited<ReturnType<Space['jobs']['cmd']>>
    try { res = await s.jobs.cmd(id, b.cmd as Cmd, typeof b.v === 'number' ? b.v : undefined) } catch (e) {
      if (e instanceof HttpError && e.status === 409) throw Object.assign(e, { job: await s.jobs.get(id) })
      throw e
    }
    return { ...res, ...(await s.runner.redoRejected(res.prev, b.cmd as Cmd)) }
  }
  async function jobOf(id: string) {
    const s = d.spaces.byJob(id), job = await s.jobs.get(id)
    if (!job) throw new HttpError(404, 'not_found', `no job ${id}`)
    return { s, job }
  }

  const tracker = new TrackerCache()

  /** shared: matched against the whole path */
  const routes: Route[] = [
    ['GET', /^\/api\/state$/, state],
    ['GET', /^\/api\/jobs$/, async () => { const m = await merged((s) => s.jobs.all()); return { jobs: m.items, parts: m.parts } }],
    ['POST', /^\/api\/jobs$/, async (r) => {
      const b = await r.body()
      // Date.parse would read a number as a year
      for (const k of ['ev', 'due', 'd']) if (b[k] != null && typeof b[k] !== 'string') throw new HttpError(400, 'bad_args', `${k} is not a string`)
      const s = d.spaces.pick(b.ws)
      return { job: await s.jobs.create({ ...b, ws: s.id } as unknown as T.NewJob) }
    }],
    ['GET', /^\/api\/jobs\/([^/]+)$/, async (r) => ({ job: (await jobOf(r.p[0])).job })],
    ['POST', /^\/api\/jobs\/([^/]+)\/cmd$/, async (r) => cmd(r.p[0], await r.body())],
    // the text a run would get for one of the job's context items, from the run's own renderer
    ['GET', /^\/api\/jobs\/([^/]+)\/context\/([^/]+)\/([^/]+)$/, async (r) => {
      const { s, job } = await jobOf(r.p[0])
      const it = ctxOf(job).find((c) => c.k === r.p[1] && c.id === r.p[2])
      if (!it) throw new HttpError(404, 'not_found', `${r.p[1]} ${r.p[2]} is not in ${job.id}'s context`)
      return { item: await resolveItem(s.source, it, s.page.me, s.notes) }
    }],
    // the job's work items and the PRs linked to them, for the page's two panels; fresh=1 skips the 5-minute cache
    ['GET', /^\/api\/jobs\/([^/]+)\/tracker$/, async (r) => {
      const { s, job } = await jobOf(r.p[0])
      const ids = ctxOf(job).filter((c) => c.k === 'work').map((c) => c.id)
      return { tracker: await tracker.read(job.id, ids, (c, id) => s.source.get(c, id), r.q.get('fresh') === '1') }
    }],
    ['POST', /^\/api\/undo$/, async (r) => {
      const b = await r.body(), id = str(b.job, 'job')
      return { job: await d.spaces.byJob(id).jobs.undo(id, Number(b.v), b.prev as Job) }
    }],
    ['GET', /^\/api\/runs$/, async () => { const m = await merged((s) => s.runner.all()); return { runs: m.items, parts: m.parts } }],
    ['POST', /^\/api\/runs$/, async (r) => {
      const b = await r.body(), job = str(b.job, 'job')
      return { run: await d.spaces.byJob(job).runner.ask(job, str(b.step, 'step'), String(b.instruction ?? '')) }
    }],
    ['GET', /^\/api\/runs\/([^/]+)$/, async (r) => {
      const [s, run] = await runOf(r.p[0])
      return { run, feed: s.runner.feed(run.id) }
    }],
    ['POST', /^\/api\/runs\/([^/]+)\/cancel$/, async (r) => ({ run: await (await runOf(r.p[0]))[0].runner.cancel(r.p[0]) })],
    ['POST', /^\/api\/runs\/([^/]+)\/resume$/, async (r) => ({ run: await (await runOf(r.p[0]))[0].runner.resume(r.p[0]) })],
    // a reply to the draft of the run's step, in the step's newest session
    ['POST', /^\/api\/runs\/([^/]+)\/reply$/, async (r) => {
      const [s, run] = await runOf(r.p[0]), b = await r.body()
      return { run: await s.runner.reply(run.job, run.step, String(b.t ?? ''), b.intent as RunIntent) }
    }],
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

  /** one workspace's: matched against the path after /api/ws/<id> */
  const wsRoutes: Route<[Space]>[] = [
    ['POST', /^\/act$/, async (r, s) => act(s, await r.body())],
    // the audio comes base64 in JSON: up to 30 MB, so whisper's 25 MB file limit is the one that bites
    ['POST', /^\/transcribe$/, async (r) => {
      const b = await r.body(30 << 20)
      if (!d.voice) throw new HttpError(503, 'no_key', 'voice is off on this console')
      return { text: await d.voice.transcribe(str(b.audio, 'audio'), str(b.mime, 'mime'), dropped(r)) }
    }],
    ['POST', /^\/format$/, async (r) => {
      const b = await r.body()
      if (!d.format) throw new HttpError(503, 'no_key', 'voice is off on this console')
      if (b.target !== 'llm' && b.target !== 'people') throw new HttpError(400, 'bad_args', 'target is llm or people')
      const opt = (v: unknown) => (typeof v === 'string' ? v : undefined)
      return await d.format.format({ text: str(b.text, 'text'), ctx: opt(b.ctx), field: opt(b.field), target: b.target, intents: b.intents === true }, dropped(r))
    }],
    // a build reads for up to 120 s; a page that goes away stops it. A key another workspace holds is not offered
    ['POST', /^\/build$/, async (r, s) => {
      const b = buildIn(await r.body())
      return { form: await s.build(b, { tz: d.tz, signal: dropped(r), taken: (k) => d.spaces.list.some((o) => o !== s && Object.hasOwn(o.ctx().PB, k)) }) }
    }],
    ['POST', /^\/board\/([^/]+)\/start$/, async (r, s) => {
      const b = await r.body()
      return s.start(r.p[0], typeof b.pb === 'string' && b.pb ? b.pb : undefined, 'page')
    }],
    ['GET', /^\/sources$/, (r, s) => sources(s, (r.q.get('concepts') || 'chat,mail,cal').split(',').map((x) => x.trim()).filter(Boolean))],
    ['GET', /^\/sources\/([^/]+)\/([^/]+)$/, async (r, s) => ({ item: await item(s, r.p[0], r.p[1], r.q.get('cursor') || undefined) })],
    ['POST', /^\/mail\/([^/]+)\/mark$/, async (r, s) => {
      const b = await r.body()
      await s.store.putMark(r.p[0], { done: b.done === true || undefined, job: typeof b.job === 'string' ? b.job : undefined })
      return { ok: true }
    }],
    // hiding is the console's own mark in B, never the chat tool's; unhiding deletes the mark
    ['POST', /^\/chats\/([^/]+)\/hide$/, async (r, s) => {
      const b = await r.body()
      await s.store.putMark(`chat:${r.p[0]}`, b.hidden === true ? { hidden: true, name: typeof b.name === 'string' ? b.name : r.p[0] } : null)
      return { ok: true }
    }],
    ['GET', /^\/chats\/hidden$/, async (_r, s) => ({
      hidden: Object.entries(await s.store.marks()).filter(([id, m]) => id.startsWith('chat:') && m.hidden).map(([id, m]) => ({ id: id.slice(5), name: m.name ?? id.slice(5) })),
    })],
    ['PUT', /^\/playbooks\/([^/]+)$/, async (r, s) => {
      const b = await r.body(), id = r.p[0], pb = pbOf(b.pb), tpl = pb ? tplOf(pb, b.tpl) : undefined
      if (pb && pb.ws != null && pb.ws !== s.id) throw new HttpError(400, 'bad_args', `the playbook names workspace ${pb.ws}, not ${s.id}`)
      // a built-in playbook belongs to the workspace that brings it; another one saving it would shadow it there
      const owner = d.spaces.list.find((o) => o !== s && o.ctx().PB[id]?.ws === o.id)
      if (owner) throw new HttpError(409, 'playbook_taken', `${id} belongs to workspace ${owner.id}`)
      await s.putPlaybook(id, pb, tpl)
      return { playbooks: s.ctx().PB, templates: s.ctx().TPL }
    }],
    ['DELETE', /^\/playbooks\/([^/]+)$/, async (r, s) => {
      await s.putPlaybook(r.p[0], null)
      return { playbooks: s.ctx().PB, templates: s.ctx().TPL }
    }],
    ['GET', /^\/knowledge$/, async (_r, s) => ({ notes: await s.notes.list() })],
    ['GET', /^\/knowledge\/search$/, async (r, s) => ({ hits: await s.notes.search(r.q.get('q') || '', (r.q.get('tags') || '').split(',').map((x) => x.trim()).filter(Boolean)) })],
    ['GET', /^\/knowledge\/notes\/([^/]+)$/, async (r, s) => ({ note: await s.notes.read(r.p[0]) })],
    ['POST', /^\/knowledge\/notes$/, async (r, s) => ({ note: await s.notes.save(null, noteIn(await r.body()), null) })],
    ['PUT', /^\/knowledge\/notes\/([^/]+)$/, async (r, s) => {
      const b = await r.body()
      if (typeof b.v !== 'number') throw new HttpError(400, 'bad_args', 'an edit names the v it replaces')
      return { note: await s.notes.save(r.p[0], noteIn(b), b.v) }
    }],
    ['DELETE', /^\/knowledge\/notes\/([^/]+)$/, async (r, s) => {
      const v = Number(r.q.get('v'))
      if (!Number.isInteger(v) || v < 1) throw new HttpError(400, 'bad_args', 'a delete names the v it removes')
      await s.notes.remove(r.p[0], v)
      return { ok: true }
    }],
    ['GET', /^\/knowledge\/proposals$/, async (_r, s) => ({ proposals: await s.notes.proposals() })],
    ['POST', /^\/knowledge\/proposals\/([^/]+)\/decide$/, async (r, s) => {
      const b = await r.body()
      return { note: await s.notes.decide(r.p[0], b.accept === true, typeof b.text === 'string' ? b.text : undefined) }
    }],
  ]

  /** what answers a request, or the 400/404/405 that says why nothing does */
  function route(r: Omit<Req, 'p'>): unknown {
    const req = (p: string[]): Req => ({ ...r, p })
    const none = (...found: unknown[]) => found.includes('method')
      ? new HttpError(405, 'method', `${r.m} is not allowed on ${r.path}`) : new HttpError(404, 'not_found', `no route ${r.m} ${r.path}`)
    const ws = r.path.match(IN_WS)
    if (ws) {
      let id: string
      try { id = decodeURIComponent(ws[1]) } catch { throw BAD_PATH() }
      const s = d.spaces.get(id), own = find(wsRoutes, r.m, ws[2])
      if (own && own !== 'method') return own.run(req(own.p), s)
      const plug = find(s.plugins.flatMap((p) => p.routes), r.m, ws[2])
      if (plug && plug !== 'method') return plug.run({ q: r.q, p: plug.p, body: r.body } satisfies PluginReq)
      throw none(own, plug)
    }
    const shared = find(routes, r.m, r.path)
    if (shared && shared !== 'method') return shared.run(req(shared.p))
    throw none(shared)
  }

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
      const r = { side, m, path, q: u.searchParams, body: (limit?: number) => readBody(req, limit), device: g.device, req, res }
      Promise.resolve().then(() => route(r)).then((out) => { if (out !== undefined) send(res, 200, out) }, (e) => {
        if (e instanceof HttpError || e instanceof GatewayError) {
          const extra = (e as { job?: Job }).job
          return send(res, e.status, { error: { code: e.code, message: e.message }, ...(extra ? { job: extra } : {}) })
        }
        console.error('request failed', m, path, e)
        fail(res, 500, 'internal', 'the console hit an error; see its log')
      })
    }
  }

  return {
    loopback: listener('loopback'), lan: listener('lan'),
    /** ends the open SSE streams so a server can close */
    close() { for (const s of streams.keys()) s.end(); streams.clear() },
  }
}
