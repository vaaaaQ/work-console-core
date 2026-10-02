import { CAL } from '../data/demo.ts'
import { PACKS } from '../data/packs.ts'
import { REG } from '../data/registry.ts'
import { L, srcState } from '../live/boot.ts'
import { todayOnly } from './cal.ts'
import { JOBS, LOG, needsYou } from './world.ts'
import type { CalEvent, Job, LogEntry, View, Ws } from './types.ts'

/* Home: Today across every registered workspace. Each row carries its workspace and a label, the pack's
   name; with one workspace the label is null, so a single-workspace install shows what it always did. */

const ids = (): Ws[] => REG.map((r) => r.page.id)
export const homeLabel = (ws: Ws): string | null => (REG.length > 1 ? PACKS[ws].n : null)

/** a workspace's calendar on every day: the demo's, or the live one once loaded; undefined without a source or while not loaded */
export function calOf(ws: Ws): CalEvent[] | undefined {
  if (!PACKS[ws]?.src.cal) return undefined
  const st = srcState('cal', ws)
  return st == null ? CAL[ws] : st === 'ok' ? L(ws).cal : undefined
}

/** today's meetings of every workspace that has a calendar, by start; tzl is the team zone's label of the row's pack */
export function homeCal(): { ws: Ws; label: string | null; e: CalEvent & { tzl: string } }[] {
  return ids().flatMap((ws) => {
    const evs = calOf(ws), label = homeLabel(ws), tzl = PACKS[ws].tzl
    return evs ? todayOnly(evs).map((e) => ({ ws, label, e: { ...e, tzl } })) : []
  }).sort((a, b) => (a.e.start || '').localeCompare(b.e.start || ''))
}

/** the jobs that need you in every workspace, the latest first */
export const homeNeeds = (): { ws: Ws; label: string | null; j: Job }[] =>
  JOBS.filter(needsYou).sort((a, b) => b.ts - a.ts).map((j) => ({ ws: j.ws, label: homeLabel(j.ws), j }))

/** a is newer than b: by the journal time when both have one (a live log spans days), else by the time of day */
const newer = (a: LogEntry, b: LogEntry) => (a.ts && b.ts ? Date.parse(a.ts) > Date.parse(b.ts) : a.at > b.at)
/** every workspace's activity, newest first; each workspace's own order is kept */
export function homeLog(): { ws: Ws; label: string | null; e: LogEntry }[] {
  const lists = ids().map((ws) => ({ ws, label: homeLabel(ws), l: LOG[ws] || [], i: 0 }))
  const out: { ws: Ws; label: string | null; e: LogEntry }[] = []
  for (;;) {
    let best: (typeof lists)[number] | undefined
    for (const x of lists) if (x.i < x.l.length && (!best || newer(x.l[x.i], best.l[best.i]))) best = x
    if (!best) return out
    out.push({ ws: best.ws, label: best.label, e: best.l[best.i++] })
  }
}

/* ===== step acts: the console button a step offers ===== */
export interface Act {
  icon: string; label: string; run(j: Job): void | Promise<void>
  busy?(j: Job): boolean; blocked?(j: Job): string | null; eyebrow?(j: Job): string
}
/** opens a view: nav.tsx puts its go here as it loads, since this module stays importable by Node, which cannot load JSX */
export const opener: { go(v: View): void } = { go: () => {} }
/** the core's own acts */
const CORE_ACTS: Record<string, Act> = { time: { icon: 'hourglass', label: 'Open Time', run: () => opener.go('time') } }
/** a core act, or the first workspace's whose page names it (icon, label) and whose ui handles it; null shows no button */
export function actOf(name: string): Act | null {
  if (Object.hasOwn(CORE_ACTS, name)) return CORE_ACTS[name]
  for (const { page, ui } of REG) {
    const p = page.acts && Object.hasOwn(page.acts, name) ? page.acts[name] : undefined
    const u = ui?.acts && Object.hasOwn(ui.acts, name) ? ui.acts[name] : undefined
    if (p && u) return { ...u, icon: p.icon, label: p.label }
  }
  return null
}
