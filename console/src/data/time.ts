/* Timesheet hours as the bridge's time concept serves it: one item per month, this one and the one
   before. The demo and the fake gateway build both months from a date and apply a fill in memory. */

export type TimeTop = { workItemId: number; workItemName: string; activityId: number; activityName: string; hours: number }
/** top = the work item + activity with the most hours in the month before this one; a fill reuses it */
export type TimeItem = {
  id: string; period: string; state: 'empty' | 'partial' | 'entered'; hours: number; workdays: number
  emptyDays: string[]; top: TimeTop | null; locked: boolean; link: string
}
export type FillArgs = { month: string; days: string[]; workItemId: number; activityId: number; hours: number }
export type FillResult = { month: string; filled: string[]; skipped: string[]; failed: { date: string; reason: string }[] }

const pad = (n: number) => String(n).padStart(2, '0')
const utc = (s: string) => new Date(s + 'T00:00:00Z')
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export const monthAdd = (m: string, k: number) => { const d = utc(m + '-01'); d.setUTCMonth(d.getUTCMonth() + k); return d.toISOString().slice(0, 7) }
export const periodOf = (m: string) => utc(m + '-01').toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
/** the browser's own date as YYYY-MM-DD */
export const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
/** "Mon 28" */
export const dayLabel = (s: string) => { const d = utc(s); return `${WD[d.getUTCDay()]} ${d.getUTCDate()}` }

/** Mon–Fri of a month up to `until`; there is no holiday list */
export function workdays(month: string, until = '9999-12-31'): string[] {
  const out: string[] = []
  for (const d = utc(month + '-01'); d.toISOString().slice(0, 7) === month; d.setUTCDate(d.getUTCDate() + 1)) {
    const s = d.toISOString().slice(0, 10)
    if (s > until) break
    if (d.getUTCDay() % 6 !== 0) out.push(s)
  }
  return out
}

export const stateOf = (hours: number, empty: string[]): TimeItem['state'] => (hours === 0 ? 'empty' : empty.length ? 'partial' : 'entered')

/** one month's dates as runs of days: "Aug 20–21, 24–28, 31" */
export function compactDays(days: string[]): string {
  const ds = [...days].sort(), runs: [number, number][] = []
  if (!ds.length) return ''
  for (const s of ds) { const n = +s.slice(8), r = runs[runs.length - 1]; if (r && n === r[1] + 1) r[1] = n; else runs.push([n, n]) }
  return utc(ds[0]).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }) + ' ' + runs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ')
}

const TOP = { workItemId: 4230, workItemName: 'Platform', activityId: 1343, activityName: 'Development' }

/** this month entered up to yesterday; the last one 8 h a day but for its last three working days */
export function demoTime(today: string, link = 'https://timesheet.example/'): TimeItem[] {
  const cur = today.slice(0, 7), prev = monthAdd(cur, -1)
  const item = (id: string, days: string[], empty: string[], topHours: number): TimeItem => {
    const hours = 8 * (days.length - empty.length)
    return { id, period: periodOf(id), state: stateOf(hours, empty), hours, workdays: days.length, emptyDays: empty, top: topHours ? { ...TOP, hours: topHours } : null, locked: false, link }
  }
  const pd = workdays(prev), cd = workdays(cur, today)
  return [item(cur, cd, cd.filter((d) => d === today), 8 * (pd.length - 3)), item(prev, pd, pd.slice(-3), 8 * workdays(monthAdd(cur, -2)).length)]
}

/** what a fill does to a month, as the pack does it: only empty days get hours, the rest come back skipped */
export function fillMonth(it: TimeItem, a: FillArgs): { item: TimeItem; result: FillResult } {
  const filled = a.days.filter((d) => it.emptyDays.includes(d)), skipped = a.days.filter((d) => !it.emptyDays.includes(d))
  const emptyDays = it.emptyDays.filter((d) => !filled.includes(d)), hours = it.hours + filled.length * a.hours
  return { item: { ...it, emptyDays, hours, state: stateOf(hours, emptyDays) }, result: { month: a.month, filled, skipped, failed: [] } }
}
