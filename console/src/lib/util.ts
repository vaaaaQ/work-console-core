import { zone } from './zone.ts'

export const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o))
/** replaces an object's contents in place, so modules holding it see the new ones */
export function refill<T extends object>(o: T, from: T) {
  for (const k of Object.keys(o)) delete (o as Record<string, unknown>)[k]
  return Object.assign(o, from)
}

/** per-browser conveniences only: storage can be blocked or empty, and then the default applies */
export const store = {
  get<T>(k: string, d: T): T {
    try { const v = localStorage.getItem('wc.' + k); return v == null ? d : JSON.parse(v) } catch { return d }
  },
  set(k: string, v: unknown) {
    try { localStorage.setItem('wc.' + k, JSON.stringify(v)) } catch { /* blocked: the page works without it */ }
  },
}

export const hm = (d = new Date(), tz = zone()) => d.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' })
export const tfmt = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { timeZone: zone(), day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
/** dd.mm */
export const dm = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { timeZone: zone(), day: '2-digit', month: '2-digit' }).replace('/', '.')
export function ago(ts: number) {
  const m = Math.round((Date.now() - ts) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return m + ' min ago'
  const h = Math.round(m / 60)
  if (h < 24) return h + ' h ago'
  const d = Math.round(h / 24)
  return d === 1 ? 'yesterday' : d + ' days ago'
}
/** minutes since midnight of "HH:MM" */
export const toMin = (s: string) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0) }

/** a dialog closes only once its save went through; a failed save leaves it open with what was typed */
export async function saveThenClose<T>(save: () => Promise<T>, close: () => void): Promise<T> {
  const r = await save()
  close()
  return r
}

export const slugify = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
export const initials = (n: string) => String(n).split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()
export const first = (n: string) => String(n).split(/\s+/)[0]
export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
export const snip = (t: string, n: number) => { t = String(t).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }
/** channel names compare without case, spaces or punctuation */
export const norm = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9#]+/g, '')

/** icon for an artifact name */
export function artIc(n: string) {
  n = String(n).toLowerCase()
  return /^pr\b|review|merge/.test(n) ? 'pr' : /branch|^feature\//.test(n) ? 'layers' : /log|build|^run/.test(n) ? 'terminal'
    : /^tests?\b/.test(n) ? 'check' : /^diff/.test(n) ? 'pen' : 'file'
}
