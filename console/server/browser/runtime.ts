import { CarrierError } from './cdp.ts'
import type { TabCarrier } from './cdp.ts'
import type { LoadedPack } from './packs.ts'
import type { TabPool } from './tabs.ts'

/* Runs a pack's function in its tab and turns the envelope into data or a wire error. A read recovers
   once (reload, retry); an act never retries, because a second run could act twice. */

export type Call = Record<string, unknown>
type Envelope = { ok: boolean; data?: unknown; code?: unknown; message?: unknown; retryAfter?: unknown; tokenExpiresAt?: unknown }

/** a wire error code: signin_required (with the tab's host), rate_limited, source_error, source_unavailable, bad_args, not_found */
export class SourceFail extends Error {
  code: string; retryAfter?: number; host?: string
  constructor(code: string, message: string, o: { retryAfter?: number; host?: string } = {}) { super(message); this.code = code; this.retryAfter = o.retryAfter; this.host = o.host }
}
/** the act may or may not have run */
export class Unknown extends Error {}

const PASS = new Set(['bad_args', 'not_found'])
const TOKEN_MARGIN = 5 * 60_000, REFRESH_GAP = 5 * 60_000, RECENT_RELOAD = 15_000, SIGNIN_QUIET = 10 * 60_000
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms))
const msg = (e: Envelope | null) => (e && typeof e.message === 'string' ? e.message : 'no message')

export class PackRuntime {
  private pack: LoadedPack; private pool: TabPool; private carrier: TabCarrier
  private evalMs: number; private actMs: number; private settleMs: number; private now: () => number; private log: (l: string) => void
  private reloadedAt = new Map<string, number>(); private signedOutAt = new Map<string, number>()
  private acting = new Map<string, number>(); private reloading = new Map<string, Promise<void>>()

  constructor(pack: LoadedPack, pool: TabPool, carrier: TabCarrier, o: { evalMs?: number; actMs?: number; settleMs?: number; now?: () => number; log?: (l: string) => void } = {}) {
    this.pack = pack; this.pool = pool; this.carrier = carrier
    this.evalMs = o.evalMs ?? 5000; this.actMs = o.actMs ?? 20000; this.settleMs = o.settleMs ?? 3000
    this.now = o.now ?? Date.now; this.log = o.log ?? (() => {})
    for (const [t, s] of Object.entries(pack.tabs)) pool.add(this.key(t), s)
  }

  key(tab: string): string { return `${this.pack.name}/${tab}` }

  private expression(call: Call): string {
    const full = { ...call, zone: this.pack.zone, now: new Date(this.now()).toISOString(), config: this.pack.config }
    return `(${this.pack.script})(${JSON.stringify(full)})`
  }

  async read(tab: string, call: Call): Promise<unknown> {
    const key = this.key(tab), expr = this.expression(call)
    let recovered = false
    for (;;) {
      const [env, failure] = await this.evaluate(key, expr, this.evalMs, true)
      const code = failure ?? this.code(env)
      if (code === null) {
        this.signedOutAt.delete(key)
        await this.refreshIfExpiring(key, env)
        return env!.data
      }
      if ((code === 'blank' || code === 'timeout' || code === 'unauthorized') && !recovered && !(code === 'unauthorized' && this.signedOutRecently(key))) {
        recovered = true
        await this.recover(key, code)
        continue
      }
      if (code === 'unauthorized' && recovered) this.signedOutAt.set(key, this.now())
      throw this.readFail(tab, key, code, env)
    }
  }

  private readFail(tab: string, key: string, code: string, env: Envelope | null): SourceFail {
    if (code === 'unauthorized') return new SourceFail('signin_required', `${tab}: sign-in required at ${this.pool.host(key)} (${msg(env)})`, { host: this.pool.host(key) })
    if (code === 'rate_limited') {
      const r = Number(env?.retryAfter)
      return new SourceFail('rate_limited', `${tab}: rate limited`, { retryAfter: Number.isFinite(r) && r > 0 ? Math.min(Math.max(r, 1), 3600) : 60 })
    }
    if (code === 'blank') return new SourceFail('source_error', `${tab}: the tab stays blank after a reload`)
    if (code === 'timeout') return new SourceFail('source_error', `${tab}: no answer within ${this.evalMs} ms after a reload`)
    if (code === 'unreachable') return new SourceFail('source_unavailable', `${tab}: ${msg(env)}`)
    if (PASS.has(code)) return new SourceFail(code, `${tab}: ${msg(env)}`)
    return new SourceFail('source_error', `${tab}: ${code}: ${msg(env)}`)
  }

  /** one run, no reload, no retry; it waits out a reload that has just started, and holds reloads off while it runs */
  async act(tab: string, call: Call): Promise<unknown> {
    const key = this.key(tab)
    this.acting.set(key, (this.acting.get(key) ?? 0) + 1)
    try {
      const reload = this.reloading.get(key)
      if (reload) await reload
      const at = this.reloadedAt.get(key), settle = at === undefined ? 0 : at + this.settleMs - this.now()
      if (settle > 0) await sleep(settle)
      const [env, failure] = await this.evaluate(key, this.expression(call), this.actMs, false)
      if (failure === 'unreachable') throw new SourceFail('source_unavailable', `${tab}: ${msg(env)}`)
      if (failure) throw new Unknown(`${tab}: the action's call failed (${failure}); it may or may not have run`)
      const code = this.code(env)
      if (code === null) return env!.data
      if (code === 'unauthorized') throw new SourceFail('signin_required', `${tab}: sign-in required at ${this.pool.host(key)} (${msg(env)})`, { host: this.pool.host(key) })
      if (code === 'rate_limited') throw new SourceFail('source_unavailable', `${tab}: rate limited; nothing was sent`)
      if (code === 'unknown') throw new Unknown(`${tab}: ${msg(env)}; the write may or may not have landed`)
      if (PASS.has(code)) throw new SourceFail(code, `${tab}: ${msg(env)}`)
      throw new SourceFail('source_error', `${tab}: ${code}: ${msg(env)}`)
    } finally {
      const n = (this.acting.get(key) ?? 1) - 1
      if (n) this.acting.set(key, n); else this.acting.delete(key)
    }
  }

  private code(env: Envelope | null): string | null {
    if (env?.ok === true) return null
    return typeof env?.code === 'string' ? env.code : 'source_error'
  }

  /** the envelope, or a carrier failure: timeout, unreachable (no tab or no CDP: nothing ran), lost (it broke mid-call) */
  private async evaluate(key: string, expr: string, ms: number, read: boolean): Promise<[Envelope | null, string | null]> {
    const note = (m: string): Envelope => ({ ok: false, message: m })
    for (let attempt = 0; ; attempt++) {
      let id: string
      try { id = await this.pool.resolve(key) } catch (e) {
        if (e instanceof CarrierError) return [note(e.message), 'unreachable']
        throw e
      }
      try {
        const v = await this.carrier.evaluate(id, expr, ms)
        if (!v || typeof v !== 'object' || !('ok' in v)) return [note('the pack returned no envelope'), 'source_error']
        return [v as Envelope, null]
      } catch (e) {
        if (!(e instanceof CarrierError)) throw e
        if (e.kind === 'gone') {
          this.pool.forget(key)
          if (read && attempt === 0) continue
          return [note(e.message), read || !e.sent ? 'unreachable' : 'lost']
        }
        if (e.kind === 'timeout') return [note(e.message), read || e.sent ? 'timeout' : 'unreachable']
        if (e.kind === 'script') return [note(e.message), 'source_error']
        return [note(e.message), read || !e.sent ? 'unreachable' : 'lost']
      }
    }
  }

  private async recover(key: string, why: string) {
    const at = this.reloadedAt.get(key), recent = at !== undefined && this.now() - at < RECENT_RELOAD
    // another concept on the tab just reloaded it; a tab on a sign-in page is the person's to finish
    if (!recent && (why !== 'unauthorized' || await this.pool.onApp(key))) await this.reload(key, why)
    await sleep(this.settleMs)
  }

  private signedOutRecently(key: string) {
    const at = this.signedOutAt.get(key)
    return at !== undefined && this.now() - at < SIGNIN_QUIET
  }

  private async refreshIfExpiring(key: string, env: Envelope | null) {
    const exp = typeof env?.tokenExpiresAt === 'string' ? Date.parse(env.tokenExpiresAt) : NaN
    if (!Number.isFinite(exp) || exp - this.now() >= TOKEN_MARGIN) return
    const at = this.reloadedAt.get(key)
    if (at !== undefined && this.now() - at < REFRESH_GAP) return
    await this.reload(key, 'token expiring')
  }

  private async reload(key: string, why: string) {
    if (this.acting.has(key)) { this.log(`browser: not reloading ${key} (${why}): an action is running in it`); return }
    let done = () => {}
    const p = new Promise<void>((ok) => { done = ok })
    this.reloadedAt.set(key, this.now()); this.reloading.set(key, p)
    try {
      this.log(`browser: reloading ${key} (${why})`)
      await this.carrier.reload(await this.pool.resolve(key))
    } catch (e) {
      if (!(e instanceof CarrierError)) throw e
      this.pool.forget(key)
      this.log(`browser: reloading ${key} failed: ${e.message}`)
    } finally {
      this.reloadedAt.set(key, this.now())
      if (this.reloading.get(key) === p) this.reloading.delete(key)
      done()
    }
  }
}

/** ids a get opened in the last 24 h, per concept: the pack reads them alongside the person's own */
export class Watched {
  private seen = new Map<string, Map<string, number>>()
  private now: () => number; private ttl: number; private cap: number
  constructor(now: () => number = Date.now, ttl = 24 * 3600_000, cap = 50) { this.now = now; this.ttl = ttl; this.cap = cap }

  add(concept: string, id: string): void {
    const m = this.seen.get(concept) ?? new Map<string, number>()
    m.delete(id); m.set(id, this.now()); this.seen.set(concept, m)
    while (m.size > this.cap) m.delete(m.keys().next().value as string)
  }

  snapshot(): Record<string, string[]> {
    const out: Record<string, string[]> = {}, now = this.now()
    for (const [c, m] of this.seen) {
      for (const [id, at] of m) if (now - at > this.ttl) m.delete(id)
      if (m.size) out[c] = [...m.keys()].sort()
    }
    return out
  }
}
