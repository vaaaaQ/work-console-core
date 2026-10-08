import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CarrierError, cdpCarrier } from '../browser/cdp.ts'
import { edgeBrowser, sharedBrowser } from '../browser/launcher.ts'
import type { Browser, BrowserStatus } from '../browser/launcher.ts'
import { configGrants, grantedPacks, PACKS_DIR } from '../browser/packs.ts'
import type { GrantsFn, LoadedPack } from '../browser/packs.ts'
import { pgDocs } from '../browser/pgdocs.ts'
import { checkItems, Projection } from '../browser/projection.ts'
import type { Change } from '../browser/projection.ts'
import { PackRuntime, SourceFail, Unknown, Watched } from '../browser/runtime.ts'
import { SCHEMAS_DIR, validator } from '../browser/schema.ts'
import { fileDocs, STATE, StateB } from '../browser/state.ts'
import type { StateDocs } from '../browser/state.ts'
import { TabPool } from '../browser/tabs.ts'
import { readToken } from '../config.ts'
import { HttpError } from '../events.ts'
import type { Bus } from '../events.ts'
import type { Source, WsConfig } from '../workspace.ts'
import type { ActReq, ActRes, ConceptReply } from './wire.ts'

/* The Bridge served from the console itself: A from the workspace's packs running in tabs of the console's own Edge,
   B kept here. A workspace opts in by returning localSource(cfg, o) from its source(); tokens never leave the tabs. */

export type LocalStatus = { browser: BrowserStatus; packs: Record<string, string>; tabs: { key: string; host: string; signin: boolean }[]; mcp: string | null }
export type LocalSource = Source & { status(): LocalStatus; front(host: string): Promise<void>; local: true }
export type LocalOptions = {
  bus: Bus; ws: string
  /** default: configGrants, the workspace config's packs, hosts, packConfig and acts */
  grants?: GrantsFn
  /** default: Postgres rows when cfg.pgUrl is set, else <home>/state/<ws>.json */
  docs?: StateDocs
  /** default: the console's own Edge on <home>/browser, shared by every workspace of this process */
  browser?: Browser
  packsDir?: string; schemasDir?: string; home?: string
  /** a pack's interval is in ticks; 1000 = seconds */
  tickMs?: number
  /** how long a read waits for a concept's first poll */
  firstReadMs?: number
  runtime?: { evalMs?: number; actMs?: number; settleMs?: number }
  log?: (line: string) => void
}

type Concept = {
  name: string; pack: LoadedPack; rt: PackRuntime; tab: string; everyMs: number; cap: number; proj: Projection
  nextAt: number; busy: Promise<void> | null; again: boolean; first: Promise<void>; settle: () => void
}

const WS = /^[a-z][a-z0-9-]{0,31}$/, PACK = /^[a-z][a-z0-9-]{0,40}$/
const BACKOFF = [1000, 2000, 5000, 10_000, 30_000], DEDUPE_MS = 10 * 60_000
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms))
const within = (p: Promise<void>, ms: number) => new Promise<void>((ok) => {
  const t = setTimeout(ok, ms)
  void p.then(() => { clearTimeout(t); ok() })
})
const err = (code: string, message: string): ActRes => ({ status: 'error', error: { code, message } })
const why = (s: BrowserStatus) => (s.state === 'unavailable' ? `the browser is unavailable: ${s.reason ?? 'no reason given'}` : `the browser is ${s.state}`)

function defaultDocs(cfg: WsConfig, home: string, ws: string): StateDocs {
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  const url = str(cfg.pgUrl), pw = str(cfg.pgPasswordPath)
  if (url) return pgDocs({ url, password: pw ? () => readToken(pw) : undefined, schema: str(cfg.pgSchema), ws })
  return fileDocs(join(home, 'state', `${ws}.json`))
}

/** the concept names a pack that did not load would have served, read from its pack.json when it can be */
function declared(dir: string, name: string): string[] {
  if (!PACK.test(name)) return []
  try { return Object.keys(JSON.parse(readFileSync(join(dir, name, 'pack.json'), 'utf8')).concepts ?? {}) } catch { return [] }
}

export function isLocal(s: Source): s is LocalSource { return (s as { local?: unknown }).local === true }

export function localSource(cfg: WsConfig, o: LocalOptions): LocalSource {
  if (!WS.test(o.ws)) throw new Error(`workspace id ${o.ws} must match ${WS}`)
  const bus = o.bus, log = o.log ?? ((l: string) => console.error(l))
  const home = o.home ?? (process.env.WORK_CONSOLE_HOME || join(homedir(), '.work-console'))
  const tickMs = o.tickMs ?? 1000, firstReadMs = o.firstReadMs ?? 5000
  const g = (o.grants ?? configGrants)(cfg), packsDir = o.packsDir ?? PACKS_DIR, schemasDir = o.schemasDir ?? SCHEMAS_DIR
  const { packs, problems } = grantedPacks(g, packsDir, schemasDir)
  const val = validator(schemasDir), watched = new Watched()
  const profile = join(home, 'browser')
  const browser: Browser | null = !packs.length ? null : o.browser
    ?? sharedBrowser(profile, () => edgeBrowser({ dir: profile, exe: typeof cfg.edgePath === 'string' && cfg.edgePath ? cfg.edgePath : undefined }))
  const carrier = cdpCarrier(() => browser?.endpoint() ?? null)
  const pool = new TabPool(carrier, (h) => g.hosts.includes(h))

  const cs = new Map<string, Concept>(), rts = new Map<string, PackRuntime>(), down = new Map<string, string>()
  for (const p of packs) {
    const rt = new PackRuntime(p, pool, carrier, { ...o.runtime, log })
    rts.set(p.name, rt)
    for (const [name, spec] of Object.entries(p.concepts)) {
      let settle = () => {}
      const first = new Promise<void>((ok) => { settle = ok })
      cs.set(name, { name, pack: p, rt, tab: spec.tab, everyMs: spec.interval * tickMs, cap: spec.cap, proj: new Projection(), nextAt: 0, busy: null, again: false, first, settle })
    }
  }
  for (const [name, problem] of Object.entries(problems))
    for (const c of declared(packsDir, name)) if (!cs.has(c) && !STATE.includes(c)) down.set(c, `pack ${name} did not load: ${problem}`)

  const reset = (c: string) => { if (cs.has(c)) bus.emit({ kind: 'source', concept: c, upserts: [], removes: [], reset: true }) }
  const docs = o.docs ?? defaultDocs(cfg, home, o.ws)
  const b = new StateB({
    docs,
    onChange: (c, upserts, removes) => {
      bus.emit({ kind: 'source', concept: c, upserts, removes })
      // B joins into A: a mark into mail and chat, a job into chat
      if (c === 'marks') { reset('mail'); reset('chat') }
      if (c === 'jobs') reset('chat')
    },
  })

  let running = false, timer: ReturnType<typeof setInterval> | undefined, unsub: (() => void) | null = null, lastSent = ''
  const done = new Map<string, { at: number; res: Promise<ActRes> }>()

  const concepts = (): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const [n, c] of cs) out[n] = c.proj.state === 'ready' ? 'ready' : c.proj.state
    for (const n of down.keys()) out[n] = 'source_error'
    for (const n of STATE) out[n] = b.ready ? 'ready' : 'warming_up'
    return out
  }
  const emitBridge = (state: 'ok' | 'unavailable' = b.ready ? 'ok' : 'unavailable') => {
    const cur = concepts(), key = JSON.stringify([state, cur])
    if (key === lastSent) return
    lastSent = key
    bus.emit({ kind: 'bridge', state, concepts: cur })
  }
  // chat's join sorts and caps the threads, so a chat change is re-read whole
  const emitSource = (name: string, ch: Change) => {
    if (name === 'chat') return reset('chat')
    bus.emit({ kind: 'source', concept: name, upserts: name === 'mail' ? b.join('mail', ch.upserts) : ch.upserts, removes: ch.removes })
  }

  const poll = (c: Concept): Promise<void> => {
    if (c.busy) { c.again = true; return c.busy }
    c.busy = (async () => {
      try {
        const raw = await c.rt.read(c.tab, { verb: 'read', concept: c.name, watch: watched.snapshot() })
        const items = checkItems(raw, c.cap, (it) => val.item(c.name, it))
        const was = c.proj.state, ch = c.proj.apply(items)
        if (ch) emitSource(c.name, ch)
        if (was !== c.proj.state) emitBridge()
      } catch (e) {
        let f = e instanceof SourceFail ? e : new SourceFail('source_error', (e as Error).message)
        const s = browser?.status()
        if (s && s.state !== 'up') f = new SourceFail('source_unavailable', why(s))
        if (c.proj.fail(f.code, f.message, f.host)) emitBridge()
        if (f.code === 'rate_limited') c.nextAt = Date.now() + (f.retryAfter ?? 60) * 1000
      } finally {
        c.nextAt = Math.max(c.nextAt, Date.now() + c.everyMs)
        c.busy = null
        c.settle()
        if (c.again && running) { c.again = false; void poll(c) }
      }
    })()
    return c.busy
  }
  const tick = () => {
    if (!running || browser?.status().state !== 'up') return
    const t = Date.now()
    for (const c of cs.values()) if (!c.busy && t >= c.nextAt) void poll(c)
  }
  const onBrowser = (s: BrowserStatus) => {
    if (!running) return
    if (s.state === 'up') return tick()
    if (s.state !== 'unavailable') return
    let changed = false
    for (const c of cs.values()) { changed = c.proj.fail('source_unavailable', why(s)) || changed; c.settle() }
    if (changed) emitBridge()
  }
  const loadB = async () => {
    for (let i = 0; running; i++) {
      try { await b.load(); emitBridge(); return } catch (e) {
        log(`local source ${o.ws}: loading its state failed: ${(e as Error).message}`)
        await sleep(BACKOFF[Math.min(i, BACKOFF.length - 1)])
      }
    }
  }

  const runAct = async (a: ActReq): Promise<ActRes> => {
    const p = packs.find((x) => Object.hasOwn(x.actions, a.action))
    if (!p || (g.acts && !g.acts.includes(a.action))) return err('unknown_action', `no granted pack runs ${a.action}`)
    const s = browser!.status()
    if (s.state !== 'up') return err('source_unavailable', why(s))
    const spec = p.actions[a.action]
    try {
      const data = await rts.get(p.name)!.act(spec.tab, { verb: 'act', action: a.action, actionId: a.actionId, args: a.args ?? {} })
      const c = cs.get(spec.concept)
      if (c) void poll(c)
      return data != null ? { status: 'ok', result: data } : { status: 'ok' }
    } catch (e) {
      if (e instanceof SourceFail) return err(e.code, e.message)
      const message = e instanceof Unknown ? e.message : `${a.action}: ${(e as Error).message}; it may or may not have run`
      return { status: 'outcome_unknown', error: { code: 'outcome_unknown', message } }
    }
  }

  return {
    local: true,
    available: () => b.ready,
    concepts,
    async read(names) {
      const out: Record<string, ConceptReply> = {}
      await Promise.all(names.map(async (n) => {
        if (STATE.includes(n)) { out[n] = b.reply(n); return }
        const c = cs.get(n)
        if (!c) { out[n] = { status: 'source_error', message: down.get(n) ?? `no granted pack serves ${n}` }; return }
        const s = browser!.status().state
        if (c.proj.state === 'warming_up' && running && (s === 'up' || s === 'starting')) await within(c.first, firstReadMs)
        const r = c.proj.reply()
        out[n] = r.status === 'ok' ? { status: 'ok', rev: r.rev, items: b.join(n, c.proj.items) } : r
      }))
      return out
    },
    async get(concept, id, cursor) {
      if (STATE.includes(concept)) return b.get(concept, id)
      const c = cs.get(concept)
      if (!c) return { status: 'source_error', message: down.get(concept) ?? `no granted pack serves ${concept}` }
      const s = browser!.status()
      if (s.state !== 'up') return { status: 'source_unavailable', message: why(s) }
      try {
        const v = await c.rt.read(c.tab, { verb: 'get', concept, id, ...(cursor ? { cursor } : {}) })
        const errors = val.get(concept, v)
        if (errors.length) return { status: 'source_error', message: `${concept} ${id}: ${errors.slice(0, 3).join('; ')}` }
        watched.add(concept, id)
        return { status: 'ok', rev: c.proj.rev, items: v }
      } catch (e) {
        if (!(e instanceof SourceFail)) throw e
        return { status: e.code, message: e.message, ...(e.host ? { host: e.host } : {}) } as ConceptReply
      }
    },
    act(a) {
      const t = Date.now()
      for (const [k, v] of done) if (t - v.at > DEDUPE_MS) done.delete(k)
      const had = a.actionId ? done.get(a.actionId) : undefined
      if (had) return had.res
      const res = runAct(a)
      if (!a.actionId) return res
      const id = a.actionId
      done.set(id, { at: t, res })
      // an error means it never ran, so a retry under the same id may run it
      void res.then((r) => { if (r.status === 'error' && done.get(id)?.res === res) done.delete(id) })
      return res
    },
    async state(method, path, body) {
      if (method === 'POST' && path === '/api/state/put') return b.put(body)
      if (method === 'POST' && path === '/api/state/new-job-id') return b.newJobId()
      return { status: 'bad_request', message: `no state op ${method} ${path}` }
    },
    async front(host) {
      const key = pool.keys().find((k) => pool.host(k) === host)
      if (!key) throw new HttpError(404, 'not_found', `no tab for ${host}`)
      const s = browser!.status()
      if (s.state !== 'up') throw new HttpError(503, 'source_unavailable', why(s))
      try { await pool.front(key) } catch (e) {
        if (e instanceof CarrierError) throw new HttpError(503, 'source_unavailable', e.message)
        throw e
      }
    },
    status: () => ({
      browser: browser?.status() ?? { state: 'off' },
      packs: { ...Object.fromEntries(packs.map((p) => [p.name, 'loaded'])), ...problems },
      tabs: pool.keys().map((key) => ({
        key, host: pool.host(key),
        signin: [...cs.values()].some((c) => `${c.pack.name}/${c.tab}` === key && c.proj.state === 'signin_required'),
      })),
      mcp: null,
    }),
    start() {
      if (running) return
      running = true
      void loadB()
      if (!browser) return
      unsub = browser.onChange(onBrowser)
      timer = setInterval(tick, tickMs)
      void browser.start().then(() => onBrowser(browser.status()), (e) => log(`local source ${o.ws}: the browser did not start: ${(e as Error).message}`))
    },
    stop() {
      if (!running) return
      running = false
      clearInterval(timer)
      unsub?.(); unsub = null
      if (browser) void browser.stop()
      if (!o.docs) void (docs as { close?: () => Promise<void> }).close?.()
      emitBridge('unavailable')
    },
  }
}
