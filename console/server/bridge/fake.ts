import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BOARD0, ME, started } from '../../src/data/board.ts'
import type { BoardItem } from '../../src/data/board.ts'
import { CAL_ITEMS, CHATS0, JOBS0, MAIL0, PRI, WORK0 } from '../../src/data/demo.ts'
import { demoTime, fillMonth } from '../../src/data/time.ts'
import type { FillArgs, TimeItem } from '../../src/data/time.ts'
import { dayOf, fromWall } from '../../src/lib/zone.ts'
import type { ActReq, Delta } from './wire.ts'

/* A stand-in for the bridge gateway, speaking its wire: bearer per caller class, concept replies,
   SSE status/delta frames. A's concepts are seeded from the demo data; B's start empty and keep B's
   rules in memory: compare-and-set, caller rights, the mail and chat joins, knowledge proposals.
   Used by tests, the smoke run and `npm start` without a real bridge. */

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
/** B's concepts; notes are served as an index, a note's text by get */
const STATE = ['jobs', 'runs', 'playbooks', 'marks', 'notes', 'proposals']
const CONSOLE_ONLY = new Set(['/api/act', '/api/state/put', '/api/state/new-job-id', '/api/knowledge/decide'])
const MAX_DOC = 256 * 1024, MAX_NOTE_TEXT = 64 * 1024

/** a home-zone wall time today (or 'yesterday') as ISO UTC */
function iso(hm: string, day = 0) {
  if (!/^\d\d:\d\d$/.test(hm)) { day = -1; hm = '12:00' }
  const ymd = dayOf(Date.now() + day * 86400e3)
  return new Date(fromWall(Date.parse(`${ymd}T${hm}:00Z`))).toISOString()
}

function seed() {
  const chats = CHATS0.acme, threads: Record<string, Item[]> = {}
  for (const c of chats) threads[c.id] = c.msgs.map((m, i) => ({
    id: `${c.id}-${i}`, author: m.me ? ME : m.who, authorKind: m.me ? 'me' : m.bot ? 'bot' : 'person', at: iso(m.at), text: m.t,
  }))
  const cs: Record<string, Concept> = {
    chat: { rev: 1, items: chats.map((c) => {
      const last = c.msgs[c.msgs.length - 1]
      return { id: c.id, name: c.name, kind: c.kind, unread: c.unread, lastAt: iso(last.at), lastFrom: last.me ? ME : last.who, lastPreview: last.t, link: `https://slack.example/archives/${c.id}`, mentioned: false }
    }) },
    mail: { rev: 1, items: (MAIL0.acme || []).map((m) => ({
      id: m.id, folder: m.cat === 'wait' ? 'Sent' : 'Inbox', from: m.from.replace(/^You → .*/, ME), to: m.cat === 'wait' ? [m.from.replace(/^You → /, '')] : [ME], cc: [],
      subject: m.subj, at: iso(m.at), unread: m.cat === 'reply', preview: m.sum, category: m.cat, myReply: false, conversationId: `conv-${m.id}`, link: `https://mail.example/${m.id}`,
    })) },
    cal: { rev: 1, items: (CAL_ITEMS.acme || []).map((e) => ({ ...e })) },
    work: { rev: 1, items: JOBS0.filter((j) => j.ws === 'acme' && /^ACME-\d/.test(j.key)).map((j) => ({
      id: j.key, type: 'Story', title: j.t, state: 'In Progress', assignedTo: ME, changedAt: iso('09:00'), link: `https://jira.example/browse/${j.key}`,
    })) },
    review: { rev: 1, items: Object.values(PRI).filter((p) => p.id.startsWith('#')).map((p) => ({
      id: p.id.slice(1), repo: 'acme/platform', title: p.br, author: ME, myVote: 0, votes: [{ reviewer: 'Priya Shah', vote: 1 }], activeThreads: 1, createdAt: iso('09:12'), link: `https://github.example/acme/platform/pull/${p.id.slice(1)}`,
    })) },
    board: { rev: 1, items: BOARD0().map((b): Item => ({ ...b })) },
    time: { rev: 1, items: demoTime(iso('12:00').slice(0, 10)) },
    ci: { rev: 1, items: [{ id: 'main#1288', pipeline: 'main', status: 'completed', result: 'succeeded', branch: 'main', startedAt: iso('07:01'), finishedAt: iso('07:15'), link: 'https://jenkins.example/job/main/1288/' }] },
  }
  for (const k of STATE) cs[k] = { rev: 1, items: [] }
  return { cs, threads }
}

export async function startFakeGateway(o: { port?: number; token?: string; llmToken?: string; statusMs?: number } = {}): Promise<FakeGateway> {
  const token = o.token ?? 'fake-console-token', llmToken = o.llmToken ?? 'fake-llm-token'
  const { cs, threads } = seed()
  const notes = new Map<string, Item>()
  const acts: ActReq[] = [], streams = new Set<ServerResponse>()
  let down = false, seq = 0, pseq = 0
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
  const index = (n: Item): Item => ({ id: n.id, v: n.v, title: n.title, tags: n.tags ?? [], updated: n.updated, size: String(n.text ?? '').length })

  function put(concept: string, id: string, doc: Record<string, unknown> | null, expectV: number | null): Reply {
    if (!STATE.includes(concept) || !id) return { status: 'bad_request', message: 'put needs a state concept and an id' }
    const cur = concept === 'notes' ? notes.get(id) : find(concept, id)
    if ((cur?.v ?? null) !== expectV)
      return { status: 'conflict', message: `${concept} '${id}' is at v${cur?.v ?? '-'}, not v${expectV ?? '-'}`, items: cur ? { current: cur } : null }
    if (doc === null) {
      if (cur) { if (concept === 'notes') notes.delete(id); change({ concept, removes: [id] }); rejoin(concept) }
      return { status: 'ok', rev: cs[concept].rev, items: { doc: null, replaced: cur ?? null } }
    }
    if (concept === 'notes' && String(doc.text ?? '').length > MAX_NOTE_TEXT) return { status: 'too_large', message: 'a note text is capped at 64 KB' }
    const saved: Item = { ...doc, id, v: (expectV ?? 0) + 1, updated: now() }
    if (JSON.stringify(saved).length > MAX_DOC) return { status: 'too_large', message: 'a document is capped at 256 KB' }
    if (concept === 'notes') { notes.set(id, saved); change({ concept, upserts: [index(saved)] }) } else change({ concept, upserts: [saved] })
    rejoin(concept)
    return { status: 'ok', rev: cs[concept].rev, items: { doc: saved, replaced: cur ?? null } }
  }

  // as the pack: a free item or one already on you; a Ready one moves to Dev
  function start(id: string): Reply {
    const it = find('board', id)
    if (!it) return { status: 'source_error', message: `tracker: not_found: no item ${id}` }
    if (it.lane !== 'free' && it.lane !== 'mine') return { status: 'source_error', message: `tracker: bad_args: ${id} is assigned to ${it.assignedTo}` }
    const up = started(it as unknown as BoardItem, ME, now()) as unknown as Item
    change({ concept: 'board', upserts: [up] })
    return { status: 'ok', rev: cs.board.rev, items: { id, type: it.type, title: it.title, state: up.state } }
  }

  const slug = (title: string) => {
    const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'note'
    let s = base
    for (let n = 2; notes.has(s); n++) s = `${base}-${n}`
    return s
  }

  function propose(b: Record<string, unknown>, caller: string): Reply {
    const title = String(b.title ?? '').trim(), text = String(b.text ?? '')
    if (!title || !text.trim()) return { status: 'bad_request', message: 'a proposal needs a title and a text' }
    const note = typeof b.note === 'string' && b.note ? b.note : undefined
    if (note && !notes.has(note)) return { status: 'not_found', message: `notes '${note}' does not exist` }
    // the llm token cannot name its author; the console's may
    const by = caller === 'llm' ? 'llm' : typeof b.by === 'string' && b.by ? b.by : caller
    const doc: Item = {
      id: `P-${String(++pseq).padStart(4, '0')}`, v: 1, updated: now(), ...(note ? { note, baseV: notes.get(note)!.v } : {}),
      title, tags: Array.isArray(b.tags) ? b.tags : [], text, reason: String(b.reason ?? ''), by, at: now(),
    }
    change({ concept: 'proposals', upserts: [doc] })
    return { status: 'ok', rev: cs.proposals.rev, items: { doc } }
  }

  function decide(b: Record<string, unknown>): Reply {
    const p = find('proposals', String(b.proposal ?? ''))
    if (!p) return { status: 'not_found', message: `proposals '${String(b.proposal ?? '')}' does not exist` }
    if (b.accept !== true) { change({ concept: 'proposals', removes: [p.id] }); return { status: 'ok', rev: cs.proposals.rev, items: { doc: null, replaced: null } } }
    const id = typeof p.note === 'string' ? p.note : slug(String(p.title))
    const cur = notes.get(id)
    if (typeof p.note === 'string' && (cur?.v ?? null) !== (p.baseV ?? null))
      return { status: 'conflict', message: `notes '${id}' changed since the proposal`, items: cur ? { current: cur } : null }
    const r = put('notes', id, { title: p.title, tags: p.tags, text: typeof b.text === 'string' ? b.text : p.text }, (cur?.v as number | undefined) ?? null)
    if (r.status === 'ok') change({ concept: 'proposals', removes: [p.id] })
    return r
  }

  function search(q: string, tags: string[]): Reply {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    const hits = [...notes.values()]
      .filter((n) => tags.every((t) => ((n.tags as string[]) ?? []).some((x) => x.toLowerCase() === t.toLowerCase())))
      .map((n) => {
        const title = String(n.title).toLowerCase(), raw = String(n.text ?? ''), text = raw.toLowerCase(), ts = ((n.tags as string[]) ?? []).map((t) => t.toLowerCase())
        const score = terms.reduce((s, t) => s + (title.includes(t) ? 3 : 0) + (ts.some((x) => x.includes(t)) ? 2 : 0) + (text.includes(t) ? 1 : 0), 0)
        const first = terms.find((t) => text.includes(t)), at = Math.max(0, (first ? text.indexOf(first) : 0) - 60)
        return { ...index(n), score, snippet: raw.slice(at, at + 160) }
      })
      .filter((h) => !terms.length || h.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, 20)
    return { status: 'ok', rev: cs.notes.rev, items: hits }
  }

  const body = (req: IncomingMessage) => new Promise<string>((ok) => { let s = ''; req.on('data', (d) => (s += d)); req.on('end', () => ok(s)) })
  const parse = async (req: IncomingMessage) => { try { return JSON.parse((await body(req)) || '{}') as Record<string, unknown> } catch { return {} } }

  const server = createServer(async (req, res) => {
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
      if (!c) return json(200, { status: 'source_error', message: `unknown concept ${concept}` })
      if (c.down) return json(200, { status: c.down, message: `${concept} is ${c.down}` })
      if (STATE.includes(concept)) {
        const it = concept === 'notes' ? notes.get(id) : find(concept, id)
        return json(200, it ? { status: 'ok', rev: c.rev, items: it } : { status: 'not_found', message: `${concept} '${id}' does not exist` })
      }
      const it = c.items.find((i) => i.id === id)
      if (!it) return json(200, { status: 'source_error', message: `no ${concept} ${id}` })
      if (concept === 'chat') return json(200, { status: 'ok', rev: c.rev, items: { messages: threads[id] || [] } })
      if (concept === 'work') return json(200, { status: 'ok', rev: c.rev, items: WORK0[id] ?? {
        type: it.type, title: it.title, state: it.state, assignedTo: it.assignedTo ?? null, description: '', reproSteps: '', acceptanceCriteria: '', comments: [],
      } })
      if (concept === 'mail') {
        const src = (MAIL0.acme || []).find((x) => x.id === id)
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
      seq = Math.max(seq, ...cs.jobs.items.map((j) => +j.id.replace(/\D/g, '') || 0)) + 1
      return json(200, { status: 'ok', rev: cs.jobs.rev, items: { id: 'J-' + String(seq).padStart(4, '0') } })
    }
    if (req.method === 'POST' && url.pathname === '/api/knowledge/propose') return json(200, propose(await parse(req), caller))
    if (req.method === 'POST' && url.pathname === '/api/knowledge/decide') return json(200, decide(await parse(req)))
    if (req.method === 'GET' && url.pathname === '/api/knowledge/search')
      return json(200, search(url.searchParams.get('q') || '', (url.searchParams.get('tags') || '').split(',').map((s) => s.trim()).filter(Boolean)))
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      streams.add(res)
      req.on('close', () => streams.delete(res))
      send(res, 'status', statusFrame())
      return
    }
    json(404, { error: 'not_found' })
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
