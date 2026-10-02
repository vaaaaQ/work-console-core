import * as React from 'react'
import { compactDays, dayLabel, demoTime, fillMonth, localDay } from '../data/time.ts'
import type { FillArgs, FillResult, TimeItem } from '../data/time.ts'
import { failText } from '../actions/flow.tsx'
import { go } from '../actions/nav.tsx'
import * as api from '../live/api.ts'
import { LIVE } from '../live/api.ts'
import { srcState } from '../live/boot.ts'
import { W, jobAtAct, wsJobs } from '../model/world.ts'
import { commit } from '../store.ts'
import { Ic } from '../ui/Icon.tsx'
import { CancelBtn } from '../ui/bits.tsx'
import { closeModal, modal } from '../ui/modal.tsx'
import { toast } from '../ui/toasts.tsx'
import { Unavailable } from './Chats.tsx'

/* Time: this month and the last one from the timesheet tool. Only the month that just ended is
   filled, 8 h on each empty working day, after a confirmation; bridge A writes it as one action. */

const HOURS = 8
const STATE: Record<TimeItem['state'], [string, string]> = { empty: ['No hours yet', ''], partial: ['Partly entered', 'wait'], entered: ['Entered', 'ok'] }
/** the demo's months live in memory for the page's lifetime */
let demo: TimeItem[] | null = null
/** the month a fill is out for: its button waits until the answer */
let filling: string | null = null

const srcName = () => W().src.time?.n || 'Timesheet'
const fmtH = (h: number) => `${Math.round(h * 100) / 100} h`
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
/** newest first: this month, then the one that just ended */
const months = () => [...(LIVE.on ? LIVE.time : (demo ||= demoTime(localDay())))].sort((a, b) => b.id.localeCompare(a.id)).slice(0, 2)
/** the job whose current step opens this view: the monthly fill starts there; else a recurring timesheet job */
const timesheetJob = () => jobAtAct('time') || wsJobs().find((j) => j.st === 'recurring' && /timesheet/i.test(`${j.t} ${j.key}`))

function put(id: string, f: (it: TimeItem) => TimeItem) {
  if (LIVE.on) LIVE.time = LIVE.time.map((x) => (x.id === id ? f(x) : x))
  else demo = (demo || []).map((x) => (x.id === id ? f(x) : x))
}

function fillText(it: TimeItem, r: FillResult | undefined) {
  if (!r || !Array.isArray(r.filled)) return `Filled ${it.period}`
  const out = [`Filled ${plural(r.filled.length, 'day')} of ${it.period}`]
  if (r.skipped?.length) out.push(`${r.skipped.length} already had hours`)
  if (r.failed?.length) out.push(`not filled: ${r.failed.map((f) => `${dayLabel(f.date)} (${f.reason})`).join('; ')}`)
  return out.join(' · ')
}

async function fill(it: TimeItem, args: FillArgs) {
  if (!LIVE.on) {
    commit(() => put(it.id, (x) => fillMonth(x, args).item))
    toast(`Filled ${plural(args.days.length, 'day')} of ${it.period} · demo, nothing left this page`)
    return
  }
  commit(() => { filling = it.id })
  try {
    const r = await api.act('time.fill', args)
    if (r.status === 'ok') {
      const res = r.result as FillResult | undefined
      // A re-reads the month after the act; until it lands the card shows the days A reported filled
      if (res && Array.isArray(res.filled)) commit(() => put(it.id, (x) => fillMonth(x, { ...args, days: res.filled }).item))
      toast(fillText(it, res), undefined, undefined, res?.failed?.length ? 12000 : undefined)
    } else if (r.status === 'outcome_unknown') {
      toast(`Not sure the fill went through — check ${srcName()} first. Filling again skips the days that already have hours.`, undefined, undefined, 12000)
    } else toast(`Not filled: ${r.error?.message || r.error?.code}.`, undefined, undefined, 12000)
  } catch (e) { toast(`Not filled: ${failText(e)}`) }
  finally { commit(() => { filling = null }) }
}

function fillAsk(it: TimeItem) {
  const top = it.top, days = [...it.emptyDays].sort(), n = days.length
  if (!top || !n || filling) return
  const args: FillArgs = { month: it.id, days, workItemId: top.workItemId, activityId: top.activityId, hours: HOURS }
  modal({
    title: `Fill ${it.period}`, form: 'tfill',
    body: <>
      <div className="src"><Ic n="hourglass" sm /> {srcName()} · {it.period}</div>
      <dl className="kv">
        <dt>Work item</dt><dd>{top.workItemName} <span className="src">#{top.workItemId}</span></dd>
        <dt>Activity</dt><dd>{top.activityName}</dd>
        <dt>Per day</dt><dd>{HOURS} h</dd>
        <dt>{plural(n, 'day')}</dt><dd>{days.map(dayLabel).join(', ')} {it.period}</dd>
        <dt>Total</dt><dd><b>{fmtH(HOURS * n)}</b></dd>
      </dl>
      <p className="hint" style={{ margin: 0 }}>The work item and activity had the most hours the month before.{' '}
        {LIVE.on ? `Written to ${srcName()} through the bridge; a day that has hours by then is left as it is.` : 'Demo: filling only records it here.'}</p>
    </>,
    foot: <><CancelBtn /><button className="btn pri" type="submit" data-autofocus><Ic n="check" sm />Fill {plural(n, 'day')}</button></>,
    onSubmit: () => { closeModal(); void fill(it, args) },
  })
}

function MonthCard({ it, last }: { it: TimeItem; last: boolean }) {
  const [label, lamp] = STATE[it.state] || [it.state, ''], n = it.emptyDays.length
  const can = last && n > 0 && !it.locked && !!it.top
  const why = !last || !n ? null : it.locked ? `${srcName()} no longer takes entries for some of this month's days.`
    : !it.top ? 'No hours the month before, so there is no work item to fill with.' : null
  return (
    <section className="panel"><header><Ic n="hourglass" /><h3>{it.period}</h3><span className="src">{last ? 'last month' : 'this month'}</span></header>
      <div className="pb">
        <dl className="kv">
          <dt>Hours</dt><dd><b>{fmtH(it.hours)}</b> over {plural(it.workdays, 'working day')}{last ? '' : ' so far'}</dd>
          <dt>State</dt><dd><span className={'lamp ' + lamp} /> {label}{it.locked ? ' · locked' : ''}</dd>
          <dt>Empty days</dt><dd>{n ? `${n} · ${compactDays(it.emptyDays)}` : 'none'}</dd>
          {it.top ? <><dt>Month before</dt><dd>most on {it.top.workItemName} · {it.top.activityName}, {fmtH(it.top.hours)}</dd></> : null}
        </dl>
        <div className="row" style={{ marginTop: 12 }}>
          {can ? <button className="btn sm pri" disabled={filling === it.id} onClick={() => fillAsk(it)}><Ic n="pen" sm />{filling === it.id ? 'Filling…' : `Fill ${HOURS} h`}</button> : null}
          {LIVE.on ? <a className="btn sm ghost" style={{ textDecoration: 'none' }} href={it.link} target="_blank" rel="noopener"><Ic n="external" sm />Open {srcName()}</a> : null}
        </div>
        {why ? <p className="hint" style={{ margin: '8px 0 0' }}>{why}</p> : null}
      </div>
    </section>
  )
}

export function TimeView() {
  const w = W(), st = srcState('time')
  if (!w.src.time) return <div className="empty">No timesheet source in {w.n}.</div>
  if (st && st !== 'ok') return <Unavailable what="Time" st={st} />
  const ms = months(), job = timesheetJob()
  return <>
    <div className="vh"><div><div className="eyebrow">{w.n} · sources</div><h1>Time</h1>
      <p>{srcName()} hours for this month and the last one, Mon–Fri. The month that just ended can be filled with {HOURS} h on each empty working day; you see the days first.</p></div></div>
    {ms.length ? <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', alignItems: 'start' }}>
      {ms.map((it, i) => <MonthCard key={it.id} it={it} last={i === 1} />)}</div> : <div className="empty">No months from {srcName()} yet.</div>}
    {job ? <p className="hint" style={{ marginTop: 16 }}>{job.st === 'recurring' ? 'Recurring job' : 'Job'}: <button className="lnk mono" onClick={() => go('job', job.id)}>{job.id}</button> · {job.t}</p> : null}
  </>
}
