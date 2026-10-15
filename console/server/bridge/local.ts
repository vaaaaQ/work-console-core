import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CarrierError, cdpCarrier } from '../browser/cdp.ts'
import { edgeBrowser, sharedBrowser } from '../browser/launcher.ts'
import { edgeProfile } from '../../scripts/edge.mjs'
import type { Browser, BrowserStatus } from '../browser/launcher.ts'
import { configGrants, grantedPacks, PACKS_DIR } from '../browser/packs.ts'
import type { GrantsFn, LoadedPack } from '../browser/packs.ts'
import { pgDocs } from '../browser/pgdocs.ts'
import { checkItems, Projection } from '../browser/projection.ts'
import type { Change, Item } from '../browser/projection.ts'
import { PackRuntime, SourceFail, Unknown, Watched } from '../browser/runtime.ts'
import { SCHEMAS_DIR, validator } from '../browser/schema.ts'
import { fileDocs, STATE, StateB } from '../browser/state.ts'
import type { StateDocs } from '../browser/state.ts'
import { TabPool } from '../browser/tabs.ts'
import { ensureToken, serveBridge } from '../browser/serve.ts'
import type { Served } from '../browser/serve.ts'
import { readToken } from '../config.ts'
import { HttpError } from '../events.ts'
import { actionsOf } from './actions.ts'
import type { Bus } from '../events.ts'
import type { Source, WsConfig } from '../workspace.ts'
import type { ActReq, ActRes, ConceptReply, PackReply } from './wire.ts'

/* The Bridge served from the console itself: A from the workspace's packs running in tabs of the console's own Edge,
   B kept here. A workspace opts in by returning localSource(cfg, o) from its source(); tokens never leave the tabs. */

/** mcp = where the run MCP is served, null when it is not; mcpError = why it could not be */
export type LocalStatus = {
  browser: BrowserStatus; packs: Record<string, string>; tabs: { key: string; host: string; signin: boolean }[]; mcp: string | null; mcpError?: string
}
/** concepts: this pack's state per concept it serves; names: id to name from its chat items, to show scopes by name */
export type PackState = { concepts: Record<string, PackReply>; names: Record<string, string> }
/** actions: what the loaded packs declare, less what the grants leave out; mcp = it serves the run MCP once started */
export type LocalSource = Source & { status(): LocalStatus; front(host: string): Promise<void>; actions(): ReadonlySet<string>; packStates(): Record<string, PackState>; actionPack(action: string): string | undefined; local: true; mcp: boolean }
export type LocalOptions = {
  bus: Bus; ws: string
  /** default: configGrants, the workspace config's packs, hosts, packConfig and acts */
  grants?: GrantsFn
  /** default: Postgres rows when cfg.pgUrl is set, else <home>/state/<ws>.json */
  docs?: StateDocs
  /** B lives only in Postgres: without cfg.pgUrl and cfg.pgPasswordPath it stays down, saying this */
  needDb?: string
  /** default: the console's own Edge on <home>/browser, shared by every workspace of this process */
  browser?: Browser
  packsDir?: string | readonly string[]; schemasDir?: string; home?: string
  /** a pack's interval is in ticks; 1000 = seconds */
  tickMs?: number
  /** how long a read waits for a concept's first poll */
  firstReadMs?: number
  runtime?: { evalMs?: number; actMs?: number; settleMs?: number }
  /** serve the run MCP's read tools at cfg.gatewayUrl (loopback only, never the gateway's 47821; port 0 = a free one) on the token in cfg.llmTokenPath, made when missing */
  mcp?: boolean
  log?: (line: string) => void
  /** the waits between tries to load B; tests shorten them */
  backoffMs?: number[]
}

/** one pack's read of one concept */
type Feed = {
  concept: string; pack: LoadedPack; rt: PackRuntime; tab: string; everyMs: number; cap: number; proj: Projection
  nextAt: number; busy: Promise<void> | null; again: boolean; first: Promise<void>; settle: () => void
}

const WS = /^[a-z][a-z0-9-]{0,31}$/, PACK = /^[a-z][a-z0-9-]{0,40}$/
const BACKOFF = [1000, 2000, 5000, 10_000, 30_000], DEDUPE_MS = 10 * 60_000, GATEWAY_PORT = 47821
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms))
const within = (p: Promise<void>, ms: number) => new Promise<void>((ok) => {
  const t = setTimeout(ok, ms)
  void p.then(() => { clearTimeout(t); ok() })
})
const inScope = (ids: ReadonlySet<string>, v: unknown) => typeof v === 'string' && ids.has(v)
const err = (code: string, message: string): ActRes => ({ status: 'error', error: { code, message } })
const why = (s: BrowserStatus) => (s.state === 'unavailable' ? `the browser is unavailable: ${s.reason ?? 'no reason given'}` : `the browser is ${s.state}`)

function defaultDocs(cfg: WsConfig, home: string, ws: string, needDb?: string): StateDocs {
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  const url = str(cfg.pgUrl), pw = str(cfg.pgPasswordPath)
  if (needDb && !(url && pw)) {
    const no = async (): Promise<never> => { throw new Error(needDb) }
    return { load: no, put: no, seq: no }
  }
  if (url) return pgDocs({ url, password: pw ? () => readToken(pw) : undefined, schema: str(cfg.pgSchema), ws })
  return fileDocs(join(home, 'state', `${ws}.json`))
}

/** the concept names a pack that did not load would have served, from the first dir whose pack.json says */
function declared(dirs: string | readonly string[], name: string): string[] {
  if (!PACK.test(name)) return []
  for (const dir of typeof dirs === 'string' ? [dirs] : dirs) {
    try { return Object.keys(JSON.parse(readFileSync(join(dir, name, 'pack.json'), 'utf8')).concepts ?? {}) } catch { /* next dir */ }
  }
  return []
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
  const profile = edgeProfile(home)
  const browser: Browser | null = !packs.length ? null : o.browser
    ?? sharedBrowser(profile, () => edgeBrowser({ dir: profile, exe: typeof cfg.edgePath === 'string' && cfg.edgePath ? cfg.edgePath : undefined, headless: cfg.edgeHeadless === true }))
  const carrier = cdpCarrier(() => browser?.endpoint() ?? null)
  // a core pack's own hosts come with it; grants.hosts covers the rest, a workspace pack's included
  const allowed = new Set([...g.hosts, ...packs.filter((p) => p.core).flatMap((p) => [...Object.values(p.tabs).map((t) => t.host), ...p.hosts])])
  const pool = new TabPool(carrier, (h) => allowed.has(h))

  const cs = new Map<string, Feed[]>(), rts = new Map<string, PackRuntime>(), down = new Map<string, string>()
  for (const p of packs) {
    const rt = new PackRuntime(p, pool, carrier, { ...o.runtime, log })
    rts.set(p.name, rt)
    for (const [concept, spec] of Object.entries(p.concepts)) {
      let settle = () => {}
      const first = new Promise<void>((ok) => { settle = ok })
      cs.set(concept, [...(cs.get(concept) ?? []), { concept, pack: p, rt, tab: spec.tab, everyMs: spec.interval * tickMs, cap: spec.cap, proj: new Projection(), nextAt: 0, busy: null, again: false, first, settle }])
    }
  }
  const feeds = () => [...cs.values()].flat()
  const tagged = (f: Feed, items: readonly Item[]): Item[] => items.map((i) => ({ ...i, pack: f.pack.name }))
  const packReply = (f: Feed): PackReply => {
    const r = f.proj.reply()
    return r.status === 'ok' ? { status: 'ok' } : { status: r.status, message: r.message, ...(r.host ? { host: r.host } : {}) }
  }
  for (const [name, problem] of Object.entries(problems))
    for (const c of declared(packsDir, name)) if (!cs.has(c) && !STATE.includes(c)) down.set(c, `pack ${name} did not load: ${problem}`)

  /** the ids a scoped pack serves; a pack the scopes leave out serves none */
  const scopeOf = (p: LoadedPack): ReadonlySet<string> => new Set(g.scopes?.[p.name] ?? [])
  const conceptScope = (f: Feed) => {
    const field = f.pack.concepts[f.concept].scope
    return field ? { field, ids: scopeOf(f.pack) } : null
  }

  const reset = (c: string) => { if (cs.has(c)) bus.emit({ kind: 'source', concept: c, upserts: [], removes: [], reset: true }) }
  const docs = o.docs ?? defaultDocs(cfg, home, o.ws, o.needDb)
  const b = new StateB({
    docs,
    onChange: (c, upserts, removes) => {
      bus.emit({ kind: 'source', concept: c, upserts, removes })
      // B joins into A: a mark into mail and chat, a job into chat
      if (c === 'marks') { reset('mail'); reset('chat') }
      if (c === 'jobs') reset('chat')
    },
  })

  let running = false, timer: ReturnType<typeof setInterval> | undefined, unsub: (() => void) | null = null, lastSent = '', bWhy = ''
  const done = new Map<string, { at: number; res: Promise<ActRes> }>()

  const concepts = (): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const [n, fs] of cs) out[n] = fs.some((f) => f.proj.state === 'ready') ? 'ready' : fs[0].proj.state
    for (const n of down.keys()) out[n] = 'source_error'
    for (const n of STATE) out[n] = b.ready ? 'ready' : 'warming_up'
    return out
  }
  const emitBridge = (state: 'ok' | 'unavailable' = b.ready ? 'ok' : 'unavailable') => {
    const cur = concepts(), key = JSON.stringify([state, cur])
    if (key === lastSent) return
    lastSent = key
    bus.emit({ kind: 'bridge', state, concepts: cur, via: 'store', ...(state === 'ok' ? {} : { why: bWhy }) })
  }
  // chat's join sorts and caps the threads, so a chat change is re-read whole
  const emitSource = (f: Feed, ch: Change) => {
    if (f.concept === 'chat') return reset('chat')
    const up = tagged(f, ch.upserts)
    bus.emit({ kind: 'source', concept: f.concept, upserts: f.concept === 'mail' ? b.join('mail', up) : up, removes: ch.removes })
  }

  // a concept several packs serve: which of them are ready decides what a read lists
  const readyKey = (concept: string) => (cs.get(concept) ?? []).filter((x) => x.proj.state === 'ready').map((x) => x.pack.name).join()

  const poll = (f: Feed): Promise<void> => {
    if (f.busy) { f.again = true; return f.busy }
    f.busy = (async () => {
      const before = readyKey(f.concept)
      try {
        const sc = conceptScope(f), call = { verb: 'read', concept: f.concept, watch: watched.snapshot() }
        let raw = await f.rt.read(f.tab, sc ? { ...call, scope: [...sc.ids] } : call)
        // the console's own filter: a pack that reads past its scope still serves nothing outside it
        if (sc && Array.isArray(raw)) raw = raw.filter((it) => inScope(sc.ids, (it as Record<string, unknown> | null)?.[sc.field]))
        const items = checkItems(raw, f.cap, (it) => val.item(f.concept, it))
        const was = f.proj.state, ch = f.proj.apply(items)
        if (ch) emitSource(f, ch)
        if (was !== f.proj.state) emitBridge()
      } catch (e) {
        let x = e instanceof SourceFail ? e : new SourceFail('source_error', (e as Error).message)
        const s = browser?.status()
        if (s && s.state !== 'up') x = new SourceFail('source_unavailable', why(s))
        if (f.proj.fail(x.code, x.message, x.host)) emitBridge()
        if (x.code === 'rate_limited') f.nextAt = Date.now() + (x.retryAfter ?? 60) * 1000
      } finally {
        // one pack of a shared concept going or coming back changes the merged list without a delta: listeners re-read
        if ((cs.get(f.concept)?.length ?? 0) > 1 && readyKey(f.concept) !== before) reset(f.concept)
        f.nextAt = Math.max(f.nextAt, Date.now() + f.everyMs)
        f.busy = null
        f.settle()
        if (f.again && running) { f.again = false; void poll(f) }
      }
    })()
    return f.busy
  }
  const tick = () => {
    if (!running || browser?.status().state !== 'up') return
    const t = Date.now()
    for (const f of feeds()) if (!f.busy && t >= f.nextAt) void poll(f)
  }
  const onBrowser = (s: BrowserStatus) => {
    if (!running) return
    if (s.state === 'up') return tick()
    if (s.state !== 'unavailable') return
    let changed = false
    for (const f of feeds()) { changed = f.proj.fail('source_unavailable', why(s)) || changed; f.settle() }
    if (changed) emitBridge()
  }
  const backoff = o.backoffMs ?? BACKOFF
  const loadB = async () => {
    for (let i = 0; running; i++) {
      try { await b.load(); bWhy = ''; emitBridge(); return } catch (e) {
        const m = (e as Error).message
        if (m !== bWhy) { bWhy = m; log(`local source ${o.ws}: loading its state failed: ${m}`); lastSent = ''; emitBridge() }
        await sleep(backoff[Math.min(i, backoff.length - 1)])
      }
    }
  }

  const runAct = async (a: ActReq): Promise<ActRes> => {
    const p = packs.find((x) => Object.hasOwn(x.actions, a.action))
    if (!p || (g.acts && !g.acts.includes(a.action))) return err('unknown_action', `no granted pack runs ${a.action}`)
    const spec = p.actions[a.action], args = a.args ?? {}
    const ids = spec.scope ? scopeOf(p) : null
    if (ids && !inScope(ids, args[spec.scope!])) return err('out_of_scope', `${a.action}: ${spec.scope} ${JSON.stringify(args[spec.scope!] ?? null)} is not in this workspace's scope for ${p.name}; nothing was sent`)
    const s = browser!.status()
    if (s.state !== 'up') return err('source_unavailable', why(s))
    try {
      const data = await rts.get(p.name)!.act(spec.tab, { verb: 'act', action: a.action, actionId: a.actionId, args, ...(ids ? { scope: [...ids] } : {}) })
      const f = cs.get(spec.concept)?.find((x) => x.pack === p)
      if (f) void poll(f)
      return data != null ? { status: 'ok', result: data } : { status: 'ok' }
    } catch (e) {
      if (e instanceof SourceFail) return err(e.code, e.message)
      const message = e instanceof Unknown ? e.message : `${a.action}: ${(e as Error).message}; it may or may not have run`
      return { status: 'outcome_unknown', error: { code: 'outcome_unknown', message } }
    }
  }

  let served: Served | null = null, mcpError: string | undefined
  const serveMcp = async () => {
    try {
      const u = new URL(cfg.gatewayUrl)
      const host = u.hostname.replace(/^\[|\]$/g, ''), port = u.port === '' ? 80 : Number(u.port)
      if (port === GATEWAY_PORT) throw new Error(`${GATEWAY_PORT} is the gateway's port; give this workspace's gatewayUrl another`)
      ensureToken(cfg.llmTokenPath)
      const s = await serveBridge({ source: self, bus, host, port, llmToken: () => readToken(cfg.llmTokenPath), name: o.ws })
      if (running) served = s; else await s.close()
    } catch (e) {
      mcpError = `the run MCP is not served at ${cfg.gatewayUrl}: ${(e as Error).message}`
      log(`local source ${o.ws}: ${mcpError}`)
    }
  }

  const self: LocalSource = {
    local: true,
    mcp: o.mcp === true,
    via: 'store',
    available: () => b.ready,
    why: () => (b.ready ? '' : bWhy),
    actions: () => actionsOf(packs, g.acts),
    concepts,
    packStates() {
      const out: Record<string, PackState> = {}
      for (const f of feeds()) {
        const st = (out[f.pack.name] ??= { concepts: {}, names: {} })
        st.concepts[f.concept] = packReply(f)
        if (f.concept === 'chat') for (const i of f.proj.items) if (typeof i.name === 'string') st.names[i.id] = i.name
      }
      return out
    },
    async read(names) {
      const out: Record<string, ConceptReply> = {}
      await Promise.all(names.map(async (n) => {
        if (STATE.includes(n)) { out[n] = b.reply(n); return }
        const fs = cs.get(n)
        if (!fs) { out[n] = { status: 'source_error', message: down.get(n) ?? `no granted pack serves ${n}` }; return }
        const s = browser!.status().state
        if (running && (s === 'up' || s === 'starting')) await Promise.all(fs.filter((f) => f.proj.state === 'warming_up').map((f) => within(f.first, firstReadMs)))
        const per = Object.fromEntries(fs.map((f) => [f.pack.name, packReply(f)]))
        const ok = fs.filter((f) => f.proj.state === 'ready')
        // rev sums every feed's, so it only grows while any one of them moves
        const rev = fs.reduce((sum, f) => sum + f.proj.rev, 0)
        out[n] = ok.length
          ? { status: 'ok', rev, items: b.join(n, ok.flatMap((f) => tagged(f, f.proj.items))), packs: per }
          : { ...(fs.find((f) => f.proj.state !== 'warming_up') ?? fs[0]).proj.reply(), rev, packs: per }
      }))
      return out
    },
    async get(concept, id, cursor, pack) {
      if (STATE.includes(concept)) return b.get(concept, id)
      const fs = cs.get(concept)
      if (!fs) return { status: 'source_error', message: down.get(concept) ?? `no granted pack serves ${concept}` }
      // without a pack, the one feed that lists the id answers: ids kept in jobs carry no pack
      const owners = pack || fs.length === 1 ? [] : fs.filter((x) => x.proj.items.some((i) => (i as { id?: unknown }).id === id))
      const f = pack ? fs.find((x) => x.pack.name === pack) : fs.length === 1 ? fs[0] : owners.length === 1 ? owners[0] : undefined
      if (pack && !f) return { status: 'not_found', message: `no pack ${pack} serves ${concept}` }
      if (!f) return { status: 'ambiguous', message: `ambiguous: ${concept} served by ${fs.map((x) => x.pack.name).join(', ')}; give pack` }
      const sc = conceptScope(f)
      // an id field is checked as given; any other field through the item the scoped read kept
      if (sc && !(sc.field === 'id' ? inScope(sc.ids, id) : f.proj.items.some((x) => (x as { id?: unknown }).id === id)))
        return { status: 'out_of_scope', message: `${concept} ${id} is not in this workspace's scope for ${f.pack.name}` }
      const s = browser!.status()
      if (s.state !== 'up') return { status: 'source_unavailable', message: why(s) }
      try {
        const v = await f.rt.read(f.tab, { verb: 'get', concept, id, ...(cursor ? { cursor } : {}), ...(sc ? { scope: [...sc.ids] } : {}) })
        const errors = val.get(concept, v)
        if (errors.length) return { status: 'source_error', message: `${concept} ${id}: ${errors.slice(0, 3).join('; ')}` }
        watched.add(concept, id)
        return { status: 'ok', rev: f.proj.rev, items: v }
      } catch (e) {
        if (!(e instanceof SourceFail)) throw e
        return { status: e.code, message: e.message, ...(e.host ? { host: e.host } : {}) } as ConceptReply
      }
    },
    actionPack: (a) => packs.find((p) => Object.hasOwn(p.actions, a))?.name,
    act(a) {
      const t = Date.now()
      for (const [k, v] of done) if (t - v.at > DEDUPE_MS) done.delete(k)
      const had = a.actionId ? done.get(a.actionId) : undefined
      if (had) return had.res
      const res = runAct(a)
      if (!a.actionId) return res
      // a refusal is kept too: one Send is never sent twice, and a new Send comes with a new id
      done.set(a.actionId, { at: t, res })
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
        signin: feeds().some((f) => `${f.pack.name}/${f.tab}` === key && f.proj.state === 'signin_required'),
      })),
      mcp: served ? `${served.url}/mcp` : null,
      ...(mcpError ? { mcpError } : {}),
    }),
    start() {
      if (running) return
      running = true
      void loadB()
      if (o.mcp) void serveMcp()
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
      void served?.close(); served = null
      emitBridge('unavailable')
    },
  }
  return self
}
