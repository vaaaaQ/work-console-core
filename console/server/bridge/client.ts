import type { Bus } from '../events.ts'
import { actResult, GatewayError, READY } from './wire.ts'
import type { ActReq, ActRes, ConceptReply, Delta, Gateway, Snapshot, Status } from './wire.ts'

/* The console's one channel to bridge A: request/reply over HTTP plus the SSE stream. It keeps the
   last reply of every concept it has read, applies deltas by rev, and re-reads a concept when a rev
   does not line up or the stream was lost. Nothing is buffered while A is away. */

type Cached = { rev: number; items: { id: string }[] }

export class BridgeClient implements Gateway {
  private url: string; private token: () => string; private bus: Bus; private backoff: number[]; private staleMs: number; private stateMs: number
  private up = false; private states: Record<string, string> = {}
  private cache = new Map<string, Cached>()
  private ac: AbortController | null = null; private timer: ReturnType<typeof setTimeout> | null = null
  private watchdog: ReturnType<typeof setTimeout> | null = null
  private tries = 0; private running = false; private lastSent = ''

  constructor(o: { url: string; token: () => string; bus: Bus; backoff?: number[]; staleMs?: number; stateMs?: number }) {
    this.url = o.url.replace(/\/$/, ''); this.token = o.token; this.bus = o.bus
    this.backoff = o.backoff ?? [1000, 2000, 5000, 10000, 30000]; this.staleMs = o.staleMs ?? 35000; this.stateMs = o.stateMs ?? 20000
  }

  /** A is reachable and at least one of its sources can answer */
  available() { return this.up && (Object.keys(this.states).length === 0 || Object.values(this.states).some((s) => READY.has(s))) }
  concepts() { return { ...this.states } }

  private async call(method: string, path: string, body?: unknown, timeout = 15000): Promise<unknown> {
    let tok: string
    try { tok = this.token() } catch { throw new GatewayError(503, 'bridge_unavailable', 'the bridge token file cannot be read') }
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeout)
    let r: Response
    try {
      r = await fetch(this.url + path, {
        method, signal: ac.signal,
        headers: { authorization: `Bearer ${tok}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (e) {
      clearTimeout(t)
      if (ac.signal.aborted) throw new GatewayError(504, 'timeout', 'the bridge did not answer in time')
      throw new GatewayError(503, 'bridge_unavailable', `the bridge is not reachable: ${(e as Error).message}`)
    }
    try {
      const txt = await r.text()
      const data = txt ? JSON.parse(txt) : {}
      if (!r.ok) {
        const code = typeof data?.error === 'string' ? data.error : data?.error?.code || String(r.status)
        throw new GatewayError(r.status === 401 || r.status === 403 ? 502 : 503, code, `the bridge refused the request (${r.status} ${code})`)
      }
      return data
    } catch (e) {
      if (e instanceof GatewayError) throw e
      if (ac.signal.aborted) throw new GatewayError(504, 'timeout', 'the bridge did not answer in time')
      throw new GatewayError(502, 'bad_reply', `the bridge sent an unreadable reply: ${(e as Error).message}`)
    } finally { clearTimeout(t) }
  }

  async snapshot(concepts: string[]): Promise<Snapshot> {
    const s = (await this.call('GET', `/api/snapshot?concepts=${encodeURIComponent(concepts.join(','))}`)) as Snapshot
    for (const [k, c] of Object.entries(s.concepts || {})) {
      if (c.status === 'ok' && Array.isArray(c.items)) this.cache.set(k, { rev: c.rev ?? 0, items: c.items as Cached['items'] })
      else this.cache.delete(k)
    }
    return s
  }

  /** concepts from the cache where it holds them, the rest from one snapshot */
  async read(concepts: string[]): Promise<Record<string, ConceptReply>> {
    const out: Record<string, ConceptReply> = {}, miss: string[] = []
    for (const k of concepts) {
      const c = this.cache.get(k)
      if (c && this.available() && READY.has(this.states[k] ?? 'ok')) out[k] = { status: 'ok', rev: c.rev, items: c.items }
      else miss.push(k)
    }
    if (miss.length) Object.assign(out, (await this.snapshot(miss)).concepts)
    return out
  }

  async get(concept: string, id: string, cursor?: string): Promise<ConceptReply> {
    const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
    return (await this.call('GET', `/api/items/${encodeURIComponent(concept)}/${encodeURIComponent(id)}${q}`)) as ConceptReply
  }

  /** a timeout after the request left is outcome_unknown, never a retry: A dedupes by actionId only for 10 min */
  async act(a: ActReq): Promise<ActRes> {
    try { return actResult((await this.call('POST', '/api/act', a, 60000)) as ConceptReply) } catch (e) {
      if (e instanceof GatewayError && (e.code === 'timeout' || e.code === 'bad_reply'))
        return { status: 'outcome_unknown', error: { code: 'outcome_unknown', message: 'the bridge did not confirm the action; check the source before retrying' } }
      throw e
    }
  }

  /** a B op. The gateway waits 10 s for the workplace; a POST it does not confirm may still have
      been applied, so it is outcome_unknown and the caller re-reads before trying again */
  async state(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ConceptReply> {
    try { return (await this.call(method, path, method === 'POST' ? body ?? {} : undefined, this.stateMs)) as ConceptReply } catch (e) {
      if (method === 'POST' && e instanceof GatewayError && (e.code === 'timeout' || e.code === 'bad_reply'))
        throw new GatewayError(503, 'outcome_unknown', 'the bridge did not confirm the write; it may or may not have been applied')
      throw e
    }
  }

  start() { if (this.running) return; this.running = true; void this.connect() }
  stop() {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    if (this.watchdog) clearTimeout(this.watchdog)
    this.ac?.abort()
    this.setState(false, this.states)
  }

  private setState(up: boolean, states: Record<string, string>) {
    this.up = up; this.states = states
    const state = this.available() ? 'ok' as const : 'unavailable' as const
    const key = JSON.stringify([state, states])
    if (key === this.lastSent) return
    this.lastSent = key
    this.bus.emit({ kind: 'bridge', state, concepts: { ...states } })
  }

  private arm() {
    if (this.watchdog) clearTimeout(this.watchdog)
    this.watchdog = setTimeout(() => this.ac?.abort(), this.staleMs)
  }

  private async connect() {
    if (!this.running) return
    const ac = new AbortController(); this.ac = ac
    let resync = false
    try {
      const r = await fetch(this.url + '/api/events', { signal: ac.signal, headers: { authorization: `Bearer ${this.token()}`, accept: 'text/event-stream' } })
      if (!r.ok || !r.body) throw new Error(`events answered ${r.status}`)
      this.arm()
      const dec = new TextDecoder()
      let buf = ''
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
        let i: number
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2)
          let ev = 'message'; const data: string[] = []
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) ev = line.slice(6).trim()
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
          }
          if (!data.length) continue
          let body: unknown
          try { body = JSON.parse(data.join('\n')) } catch { continue }
          if (ev === 'status') {
            this.arm()
            const s = body as Status
            const wasUp = this.available()
            this.setState(s.state === 'up', s.state === 'up' ? { ...(s.concepts || {}) } : {})
            if (this.available()) this.tries = 0
            // the stream (re)opened or A came back: anything cached may have missed deltas
            if (this.available() && (!wasUp || !resync)) { resync = true; void this.resync() }
          } else if (ev === 'delta') void this.onDelta(body as Delta)
        }
      }
      throw new Error('the event stream ended')
    } catch {
      if (this.watchdog) clearTimeout(this.watchdog)
      if (!this.running) return
      this.setState(false, {})
      const wait = this.backoff[Math.min(this.tries++, this.backoff.length - 1)]
      this.timer = setTimeout(() => void this.connect(), wait)
    }
  }

  private async resync() {
    const names = [...this.cache.keys()]
    if (!names.length) return
    try {
      await this.snapshot(names)
      for (const k of names) this.bus.emit({ kind: 'source', concept: k, upserts: [], removes: [], reset: true })
    } catch { /* the stream decides availability; a failed re-read waits for the next reconnect */ }
  }

  private async onDelta(d: Delta) {
    const c = this.cache.get(d.concept)
    if (c && (d.resync || c.rev !== d.fromRev)) {
      this.cache.delete(d.concept)
      try { await this.snapshot([d.concept]) } catch { /* next read fetches it */ }
      this.bus.emit({ kind: 'source', concept: d.concept, upserts: [], removes: [], reset: true })
      return
    }
    if (c) {
      const gone = new Set([...(d.removes || []), ...(d.upserts || []).map((u) => u.id)])
      c.items = c.items.filter((i) => !gone.has(i.id)).concat(d.upserts || [])
      c.rev = d.toRev
    }
    this.bus.emit({ kind: 'source', concept: d.concept, upserts: d.upserts || [], removes: d.removes || [] })
  }
}
