import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { started } from '../../src/data/board.ts'
import type { BoardItem } from '../../src/data/board.ts'
import type { Board } from '../../src/workspace.ts'
import { MAIL0, WORK0 } from '../../src/data/demo.ts'
import { fillMonth } from '../../src/data/time.ts'
import type { FillArgs, TimeItem } from '../../src/data/time.ts'
import type { FakeSeed } from '../workspace.ts'
import type { ActReq, Delta } from './wire.ts'

/* A stand-in for the bridge gateway, speaking its wire: bearer per caller class, concept replies,
   SSE status/delta frames. A's concepts are seeded from the workspace's FakeSeed (none without one); B's start
   empty and keep B's rules in memory: compare-and-set, caller rights, the mail and chat joins. Used by tests,
   the smoke run and `npm start` without a real bridge. */

type Item = { id: string; [k: string]: unknown }
type Concept = { rev: number; items: Item[]; down?: string }
type Reply = { status: string; rev?: number; items?: unknown; message?: string }
export interface FakeGateway {
  url: string; token: string; llmToken: string; acts: ActReq[]
  close(): Promise<void>
  /** fromRev defaults to the current rev; pass another to simulate a gap */
  emitDelta(d: { concept: string; upserts?: Item[]; removes?: string[]; fromRev?: number; resync?: boolean }): Delta
  /** down = the gateway stops answering and drops every stream */
  setDown(down: boolean): void
  /** a concept that answers an error code instead of items; null restores it */
  setSource(concept: string, code: string | null): void
  /** a status frame now, instead of waiting for the next tick */
  pushStatus(): void
}

const ACTIONS = new Set(['chat.post', 'mail.send', 'review.vote', 'review.comment', 'work.setState', 'work.comment', 'work.start', 'time.fill'])
/** B's concepts */
const STATE = ['jobs', 'runs', 'playbooks', 'marks']
const CONSOLE_ONLY = new Set(['/api/act', '/api/state/put', '/api/state/new-job-id'])
const MAX_DOC = 256 * 1024

/** the demo's one picture, a 32x20 png, for every image a demo work item lists */
const PIC = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAUCAIAAABj86gYAAAAKElEQVR42mP4SmPAMGoBSRbcsTGiChq1YNSCUQtGLaDEgtHiekAsAAD8b2YsPCRrAwAAAABJRU5ErkJggg=='

/** A's concepts; an empty one still answers, a seed may add more */
const BASE = ['chat', 'mail', 'cal', 'work', 'review', 'board', 'time', 'ci']

/** seed = what A starts with; me = who Start puts an item on; board = the workspace's board, whose columns Start
    moves an item between; log = where a request that threw is written */
export async function startFakeGateway(o: {
  port?: number; token?: string; llmToken?: string; statusMs?: number; seed?: FakeSeed; me?: string; board?: Pick<Board, 'ready' | 'dev'>
  log?: (line: string) => void
} = {}): Promise<FakeGateway> {
  const token = o.token ?? 'fake-console-token', llmToken = o.llmToken ?? 'fake-llm-token', me = o.me ?? 'You'
  const log = o.log ?? console.error
  // the get handlers are functions, so only the items are copied
  const seed = structuredClone({ concepts: o.seed?.concepts ?? {}, threads: o.seed?.threads ?? {} }), threads = seed.threads, gets = o.seed?.get ?? {}
  const cs: Record<string, Concept> = {}
  for (const k of [...BASE, ...Object.keys(seed.concepts)]) cs[k] ??= { rev: 1, items: seed.concepts[k] ?? [] }
  for (const k of STATE) cs[k] = { rev: 1, items: [] }
  const acts: ActReq[] = [], streams = new Set<ServerResponse>()
  let down = false, seq = 0
  const now = () => new Date().toISOString()
  const find = (concept: string, id: string) => cs[concept].items.find((i) => i.id === id)

  const statusFrame = () => ({
    state: 'up', machine: 'fake', browser: 'ok', at: now(),
    concepts: Object.fromEntries(Object.entries(cs).map(([k, c]) => [k, c.down ?? 'ready'])),
  })
  const send = (res: ServerResponse, ev: string, data: unknown) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`)
  const broadcast = (ev: string, data: unknown) => { for (const s of streams) send(s, ev, data) }

  /** the one place items change: applies a delta and broadcasts it */
  function change(d: { concept: string; upserts?: Item[]; removes?: string[]; fromRev?: number; resync?: boolean }): Delta {
    const c = cs[d.concept]
    const fromRev = d.fromRev ?? c.rev, toRev = Math.max(fromRev, c.rev) + 1
    const ups = d.upserts || [], rms = d.removes || []
    c.items = c.items.filter((i) => !rms.includes(i.id) && !ups.some((u) => u.id === i.id)).concat(ups)
    c.rev = toRev
    // resync: the change did not fit a message, so the frame carries none of it
    const delta: Delta = d.resync
      ? { concept: d.concept, fromRev, toRev, upserts: [], removes: [], resync: true }
      : { concept: d.concept, fromRev, toRev, upserts: ups, removes: rms }
    broadcast('delta', delta)
    return delta
  }
  // as on the workplace, a mark re-joins mail and chat and a job re-joins chat; the fake re-sends them whole
  const rejoin = (concept: string) => {
    if (concept === 'marks') change({ concept: 'mail', resync: true })
    if (concept === 'jobs' || concept === 'marks') change({ concept: 'chat', resync: true })
  }
  const joined = (name: string, items: Item[]) => {
    if (name === 'mail') return items.map((m) => {
      const k = find('marks', m.id)
      return k ? { ...m, ...(k.done != null ? { done: k.done } : {}), ...(k.job != null ? { job: k.job } : {}) } : m
    })
    // a hidden thread is dropped unless an unread message mentions me
    if (name === 'chat') return items.flatMap((t): Item[] => {
      const js = cs.jobs.items.filter((j) => j.chat === t.id).map((j) => j.id).sort(), hidden = find('marks', `chat:${t.id}`)?.hidden === true
      if (hidden && !(t.mentioned === true && Number(t.unread) > 0)) return []
      return [{ ...t, ...(js.length ? { jobs: js } : {}), ...(hidden ? { hidden: true } : {}) }]
    })
    return items
  }
  const reply = (name: string): Reply => {
    const c = cs[name]
    if (!c) return { status: 'source_error', message: `unknown concept ${name}` }
    if (c.down) return { status: c.down, message: `${name} is ${c.down}` }
    return { status: 'ok', rev: c.rev, items: joined(name, c.items) }
  }

  function put(concept: string, id: string, doc: Record<string, unknown> | null, expectV: number | null): Reply {
    if (!STATE.includes(concept) || !id) return { status: 'bad_request', message: 'put needs a state concept and an id' }
    const cur = find(concept, id)
    if ((cur?.v ?? null) !== expectV)
      return { status: 'conflict', message: `${concept} '${id}' is at v${cur?.v ?? '-'}, not v${expectV ?? '-'}`, items: cur ? { current: cur } : null }
    if (doc === null) {
      if (cur) { change({ concept, removes: [id] }); rejoin(concept) }
      return { status: 'ok', rev: cs[concept].rev, items: { doc: null, replaced: cur ?? null } }
    }
    const saved: Item = { ...doc, id, v: (expectV ?? 0) + 1, updated: now() }
    if (JSON.stringify(saved).length > MAX_DOC) return { status: 'too_large', message: 'a document is capped at 256 KB' }
    change({ concept, upserts: [saved] })
    rejoin(concept)
    return { status: 'ok', rev: cs[concept].rev, items: { doc: saved, replaced: cur ?? null } }
  }

  // as the pack: a free item or one already on you; one in the board's ready column moves to its dev column
  function start(id: string): Reply {
    const it = find('board', id)
    if (!it) return { status: 'source_error', message: `tracker: not_found: no item ${id}` }
    if (it.lane !== 'free' && it.lane !== 'mine') return { status: 'source_error', message: `tracker: bad_args: ${id} is assigned to ${it.assignedTo}` }
    const up = started(it as unknown as BoardItem, me, o.board, now()) as unknown as Item
    change({ concept: 'board', upserts: [up] })
    return { status: 'ok', rev: cs.board.rev, items: { id, type: it.type, title: it.title, state: up.state } }
  }

  const body = (req: IncomingMessage) => new Promise<string>((ok) => { let s = ''; req.on('data', (d) => (s += d)); req.on('end', () => ok(s)) })
  const parse = async (req: IncomingMessage) => { try { return JSON.parse((await body(req)) || '{}') as Record<string, unknown> } catch { return {} } }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (down) { req.socket.destroy(); return }
    const json = (st: number, b: unknown) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)) }
    const auth = req.headers.authorization
    const caller = auth === `Bearer ${token}` ? 'console' : auth === `Bearer ${llmToken}` ? 'llm' : null
    const url = new URL(req.url || '/', 'http://fake')
    if (!caller) return json(401, { error: 'unauthorized' })
    if (CONSOLE_ONLY.has(url.pathname) && caller !== 'console') return json(403, { error: 'forbidden_for_caller' })

    if (req.method === 'GET' && url.pathname === '/api/snapshot') {
      const want = (url.searchParams.get('concepts') || '').split(',').map((s) => s.trim()).filter(Boolean)
      const names = want.length ? want : Object.keys(cs)
      const unread = joined('chat', cs.chat.items).reduce((n, c) => n + (Number(c.unread) || 0), 0)
      const toReply = joined('mail', cs.mail.items).filter((m) => m.category === 'reply' && !m.myReply && m.done !== true).length
      return json(200, { bridge: { state: 'up', at: now() }, counts: { chatUnread: unread, mailToReply: toReply }, concepts: Object.fromEntries(names.map((n) => [n, reply(n)])) })
    }
    const m = /^\/api\/items\/([^/]+)\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'GET' && m) {
      const [concept, id] = [decodeURIComponent(m[1]), decodeURIComponent(m[2])], c = cs[concept]
      // get-only: a picture a work item lists
      if (concept === 'image') {
        const im = Object.values(WORK0).flatMap((d) => d.images ?? []).find((i) => i.ref === id)
        return json(200, im ? { status: 'ok', rev: 1, items: { name: im.name, mime: 'image/png', data: PIC, width: 32, height: 20 } } : { status: 'not_found', message: `no image ${id}` })
      }
      if (!c) return json(200, { status: 'source_error', message: `unknown concept ${concept}` })
      if (c.down) return json(200, { status: c.down, message: `${concept} is ${c.down}` })
      if (STATE.includes(concept)) {
        const it = find(concept, id)
        return json(200, it ? { status: 'ok', rev: c.rev, items: it } : { status: 'not_found', message: `${concept} '${id}' does not exist` })
      }
      const it = c.items.find((i) => i.id === id)
      if (!it) return json(200, { status: 'source_error', message: `no ${concept} ${id}` })
      if (Object.hasOwn(gets, concept)) return json(200, { status: 'ok', rev: c.rev, items: gets[concept](id, it) })
      if (concept === 'chat') return json(200, { status: 'ok', rev: c.rev, items: { messages: threads[id] || [] } })
      if (concept === 'work') return json(200, { status: 'ok', rev: c.rev, items: WORK0[id] ?? {
        type: it.type, title: it.title, state: it.state, assignedTo: it.assignedTo ?? null, description: '', reproSteps: '', acceptanceCriteria: '', comments: [],
      } })
      if (concept === 'mail') {
        const src = Object.values(MAIL0).flatMap((l) => l ?? []).find((x) => x.id === id)
        return json(200, { status: 'ok', rev: c.rev, items: { body: src?.body ?? String(it.preview ?? ''), attachments: [] } })
      }
      return json(200, { status: 'ok', rev: c.rev, items: it })
    }
    if (req.method === 'POST' && url.pathname === '/api/act') {
      const a = (await parse(req)) as unknown as ActReq
      acts.push(a)
      if (!ACTIONS.has(a.action)) return json(200, { status: 'unknown_action', message: `unknown action ${a.action}` })
      if (a.action === 'work.start') return json(200, start(String(a.args?.id ?? '')))
      if (a.action === 'time.fill') {
        // as the pack: the month's empty days get hours, the others come back skipped, and the concept changes
        const f = a.args as unknown as FillArgs, it = find('time', String(f.month))
        if (!it || !Array.isArray(f.days)) return json(200, { status: 'bad_args', message: `no month ${String(f.month)} to fill` })
        const { item, result } = fillMonth(it as unknown as TimeItem, f)
        change({ concept: 'time', upserts: [item] })
        return json(200, { status: 'ok', rev: cs.time.rev, items: result })
      }
      return json(200, { status: 'ok', rev: 0, items: null })
    }
    if (req.method === 'POST' && url.pathname === '/api/state/put') {
      const b = await parse(req)
      return json(200, put(String(b.concept ?? ''), String(b.id ?? ''), (b.doc as Record<string, unknown> | null) ?? null, (b.expectV as number | null) ?? null))
    }
    if (req.method === 'POST' && url.pathname === '/api/state/new-job-id') {
      // J-NNNN only, as the gateway; a console stores the job under its own prefix, so every held id counts,
      // by the number after its first dash, standing in for the seq the gateway persists
      seq = Math.max(seq, ...cs.jobs.items.map((j) => { const i = j.id.indexOf('-'); return i > 0 ? +j.id.slice(i + 1) || 0 : 0 })) + 1
      return json(200, { status: 'ok', rev: cs.jobs.rev, items: { id: `J-${String(seq).padStart(4, '0')}` } })
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      streams.add(res)
      req.on('close', () => streams.delete(res))
      send(res, 'status', statusFrame())
      return
    }
    json(404, { error: 'not_found' })
  }
  // a handler that throws (a seed's get, say) answers 500 naming the error instead of leaving the request hanging
  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e)
      log(`fake gateway: ${req.method} ${req.url} failed: ${message}`)
      if (res.headersSent) { res.destroy(); return }
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'internal_error', message }))
    })
  })
  const tick = setInterval(() => broadcast('status', statusFrame()), o.statusMs ?? 10000)
  await new Promise<void>((ok) => server.listen(o.port ?? 0, '127.0.0.1', ok))
  const port = (server.address() as AddressInfo).port

  return {
    url: `http://127.0.0.1:${port}`, token, llmToken, acts,
    emitDelta: change,
    setDown(v) {
      down = v
      if (v) { for (const s of streams) s.destroy(); streams.clear(); server.closeAllConnections() }
    },
    setSource(concept, code) { if (cs[concept]) cs[concept].down = code ?? undefined },
    pushStatus() { broadcast('status', statusFrame()) },
    async close() {
      clearInterval(tick)
      for (const s of streams) s.destroy()
      server.closeAllConnections()
      await new Promise<void>((ok) => server.close(() => ok()))
    },
  }
}
