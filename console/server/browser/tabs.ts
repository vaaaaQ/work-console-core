import { CarrierError } from './cdp.ts'
import type { TabCarrier } from './cdp.ts'

/* Maps a pack's tab key (<pack>/<tab>) to a browser tab: reuses the first matching tab on a granted host,
   opens the pack's url only when none matches, never navigates. Resolution is serialized per key. */

export type TabSpec = { match: RegExp; open: string }
const hostOf = (u: string) => { try { return new URL(u).hostname } catch { return '' } }

export class TabPool {
  private specs = new Map<string, TabSpec>()
  private ids = new Map<string, string>()
  private chains = new Map<string, Promise<unknown>>()
  private carrier: TabCarrier
  private allowed: (host: string) => boolean
  constructor(carrier: TabCarrier, allowed: (host: string) => boolean) { this.carrier = carrier; this.allowed = allowed }

  add(key: string, spec: TabSpec): void { this.specs.set(key, spec) }
  keys(): string[] { return [...this.specs.keys()] }
  host(key: string): string { return hostOf(this.spec(key).open) }
  forget(key: string): void { this.ids.delete(key) }

  private spec(key: string): TabSpec {
    const s = this.specs.get(key)
    if (!s) throw new Error(`no tab ${key}`)
    return s
  }
  private fits(s: TabSpec, url: string) { return s.match.test(url) && this.allowed(hostOf(url)) }

  async resolve(key: string): Promise<string> {
    const s = this.spec(key), cached = this.ids.get(key)
    if (cached) return cached
    const run = (this.chains.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const again = this.ids.get(key)
      if (again) return again
      const found = (await this.carrier.list()).find((t) => this.fits(s, t.url))
      let id = found?.id
      if (!id) {
        const h = hostOf(s.open)
        if (!this.allowed(h)) throw new CarrierError('cdp', `${h} is not granted`, false)
        id = (await this.carrier.open(s.open)).id
      }
      this.ids.set(key, id)
      return id
    })
    this.chains.set(key, run)
    return run
  }

  /** whether the tab still shows its app: a gone tab counts as on it (the reload finds out), CDP down as not */
  async onApp(key: string): Promise<boolean> {
    const s = this.spec(key)
    try {
      const id = await this.resolve(key), tab = (await this.carrier.list()).find((t) => t.id === id)
      return !tab || this.fits(s, tab.url)
    } catch (e) {
      if (e instanceof CarrierError) return false
      throw e
    }
  }

  async front(key: string): Promise<void> {
    try { await this.carrier.activate(await this.resolve(key)) }
    catch (e) {
      if (!(e instanceof CarrierError) || e.kind !== 'gone') throw e
      this.forget(key)
      await this.carrier.activate(await this.resolve(key))
    }
  }
}
