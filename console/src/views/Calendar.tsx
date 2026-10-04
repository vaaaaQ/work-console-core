import * as React from 'react'
import { STATUS } from '../data/core.ts'
import { CAL } from '../data/demo.ts'
import { L, srcState } from '../live/boot.ts'
import { dayOf, evDraft, evJobs, onDay, shownDays, weekDays } from '../model/cal.ts'
import type { CalEvent, Job } from '../model/types.ts'
import { S, W, wsJobs } from '../model/world.ts'
import { go } from '../actions/nav.tsx'
import { newJob } from '../actions/newjob.tsx'
import { Ic } from '../ui/Icon.tsx'
import { Unavailable } from './Chats.tsx'

const dayLabel = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })

function JobChip({ j }: { j: Job }) {
  const x = STATUS[j.st] || { l: j.st, c: 'off' }
  return <button className="cjob" title={`${j.t} · ${x.l}`} aria-label={`Open ${j.id}: ${j.t}`} onClick={() => go('job', j.id)}>
    <span className={`lamp ${x.c}${x.h ? ' hol' : ''}`} />{j.id}</button>
}

function Ev({ e, jobs, src, tzl }: { e: CalEvent; jobs: Job[]; src: string; tzl: string }) {
  const meta = [e.d !== '—' ? e.d : '', e.x ? 'cancelled' : e.org].filter(Boolean).join(' · ')
  return <div className={'ce' + (e.x ? ' x' : '')}>
    <div className="tm">{e.b}{e.v ? <small>{e.v} {tzl}</small> : null}</div>
    <b>{e.t}</b>
    {meta ? <div className="why">{meta}</div> : null}
    {jobs.length ? <div className="acts">{jobs.map((j) => <JobChip key={j.id} j={j} />)}</div> : null}
    <div className="acts">
      {e.join && !e.x ? <a className="btn sm ghost" href={e.join} target="_blank" rel="noopener noreferrer"><Ic n="external" sm />Join</a> : null}
      {e.id && e.start ? <button className="btn sm ghost" onClick={() => newJob(evDraft(e, src))}><Ic n="plus" sm />New job</button> : null}
    </div>
  </div>
}

/* This week and next in home-zone days; a meeting lists its jobs and makes new ones due when it starts. */
export function CalendarView() {
  const w = W(), cst = srcState('cal'), [wk, setWk] = React.useState(0)
  const cal = !w.src.cal ? undefined : cst == null ? CAL[S.ws] : cst === 'ok' ? L().cal : undefined
  const head = <div className="vh"><div><div className="eyebrow">{w.n} · work</div><h1>Calendar</h1>
    <p>Meetings in your local time{w.tz ? ` with ${w.tzl} alongside` : ''}. A job made from a meeting is due when it starts.</p></div>
    <div className="acts"><div className="seg" role="group" aria-label="Week">
      {['This week', 'Next week'].map((l, i) => <button key={l} aria-pressed={wk === i} onClick={() => setWk(i)}>{l}</button>)}</div></div></div>
  if (!w.src.cal) return <>{head}<div className="empty">{w.n} has no calendar source yet.</div></>
  if (!cal) return <>{head}<Unavailable what="Calendar" st={cst || 'loading'} /></>
  const today = dayOf(), days = shownDays(weekDays(wk), cal), jobs = wsJobs()
  return <>{head}
    <div className="wk" style={{ '--n': days.length } as React.CSSProperties}>
      {days.map((d) => {
        const evs = onDay(cal, d)
        return <section key={d} className={'panel wkd' + (d === today ? ' today' : d < today ? ' past' : '')} aria-label={dayLabel(d)}>
          <header><h3>{dayLabel(d)}</h3>{d === today ? <span className="src">today</span> : null}</header>
          {evs.length ? evs.map((e, i) => <Ev key={e.id || i} e={e} jobs={evJobs(e, jobs)} src={w.src.cal!.n} tzl={w.tzl} />)
            : <div className="empty">No meetings.</div>}
        </section>
      })}
    </div>
  </>
}
