import { dayOf } from '../lib/zone.ts'
import type { CalEvent, Job, NjDraft } from './types.ts'

/* The calendar week in home-zone days, Monday first. */

const DAY = 86400e3
export { dayOf }

/** the seven dates of this week (wk 0) or the next (wk 1) */
export function weekDays(wk: number, now: number | Date = Date.now()): string[] {
  const t = Date.parse(dayOf(now)), wd = (new Date(t).getUTCDay() + 6) % 7
  return Array.from({ length: 7 }, (_, i) => new Date(t + (i - wd + 7 * wk) * DAY).toISOString().slice(0, 10))
}

/** Monday to Friday always; Saturday and Sunday only when they hold an event */
export const shownDays = (days: string[], evs: CalEvent[]) => days.filter((d, i) => i < 5 || evs.some((e) => e.day === d))

export const onDay = (evs: CalEvent[], day: string) =>
  evs.filter((e) => e.day === day).sort((a, b) => (a.start || '').localeCompare(b.start || ''))

/** today's rows; an event without a date (an older gateway) still shows */
export const todayOnly = (evs: CalEvent[], now: number | Date = Date.now()) => { const d = dayOf(now); return evs.filter((e) => !e.day || e.day === d) }

export const evJobs = (e: CalEvent, jobs: Job[]) => (e.id ? jobs.filter((j) => j.ev === e.id) : [])

/** New job from a meeting: titled after it, linked to it, due when it starts */
export const evDraft = (e: CalEvent, src: string): NjDraft => ({ t: e.t, ev: e.id, due: e.start, src: `${src} · ${e.t}` })
