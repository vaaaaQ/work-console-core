import * as React from 'react'
import { CAL } from '../data/demo.ts'
import { hm, toMin } from '../lib/util.ts'
import { LIVE } from '../live/api.ts'
import { srcState } from '../live/boot.ts'
import { todayOnly } from '../model/cal.ts'
import { LOG, S, W, needsYou, wsJobs } from '../model/world.ts'
import { go } from '../actions/nav.tsx'
import { NextCell } from '../ui/bits.tsx'
import { Ic } from '../ui/Icon.tsx'

const box = (t: string) => <div className="pb"><p className="why" style={{ margin: 0 }}>{t}</p></div>

export function Today() {
  const w = W(), cst = srcState('cal'), now = toMin(hm()), log = LOG[S.ws] || []
  const all = !w.src.cal ? undefined : cst == null ? CAL[S.ws] : cst === 'ok' ? LIVE.cal : undefined, cal = all && todayOnly(all)
  const need = wsJobs().filter(needsYou).sort((a, b) => b.ts - a.ts)
  let nx = false
  const ev = cal ? cal.map((e, i) => {
    const a = toMin(e.b), end = a + (parseInt(e.d, 10) || 1), past = end <= now
    const cls = past ? ' past' : nx ? '' : (nx = true, ' next')
    const meta = [e.d && e.d !== '—' ? e.d : '', e.n, a <= now && !past ? 'now' : ''].filter(Boolean).join(' · ')
    return <div key={i} className={'ev' + cls}><div className="tm">{e.b}<small>{e.v} {w.tzl}</small></div><div><b>{e.t}</b>{meta ? <div className="why">{meta}</div> : null}</div></div>
  }) : null
  return <>
    <div className="vh"><div><div className="eyebrow">{w.n} · work</div><h1>Today</h1>
      <p>{cal ? `Meetings in your local time${w.tz ? ` with ${w.tzl} alongside` : ''}, the` : 'The'} jobs that need you, and what you and the LLM runs you asked for did today.</p></div></div>
    <div className="cols">
      <div style={{ display: 'grid', gap: 16, minWidth: 0 }}>
        <section className="panel"><header><Ic n="calendar" /><h3>Calendar</h3><span className="src">{cal ? w.src.cal!.n : 'not set'}</span></header>
          {cal ? cal.length ? <div>{ev}</div> : box('No meetings today.')
            : w.src.cal && cst ? box(cst === 'loading' ? 'Loading the calendar…' : `Calendar unavailable: ${cst}.`)
              : box(`${w.n} has no calendar source yet. A pack adds one by mapping a tool onto the core Calendar concept.`)}</section>
        <section className="panel"><header><Ic n="user" /><h3>Needs you</h3><span className="src">{need.length}</span></header>
          {need.length ? <div style={{ overflowX: 'auto' }}><table className="mt"><thead><tr><th>Key</th><th>Job</th><th>Next</th></tr></thead><tbody>
            {need.map((j) => <tr key={j.id}><td><button className="lnk key" onClick={() => go('job', j.id)}>{j.key}</button></td><td>{j.t}</td><td><NextCell j={j} /></td></tr>)}
          </tbody></table></div> : box('Nothing needs you right now.')}</section>
      </div>
      <section className="panel"><header><Ic n="activity" /><h3>Activity</h3><span className="src">{log.length} today</span></header>
        {log.length ? log.map((e, i) => (
          <div key={log.length - i} className="fe"><span className="tm">{e.at}</span><span className="st"><span className={'lamp ' + e.l} />{e.a}</span>
            <div>{e.t}{e.job ? <> · <button className="lnk mono" onClick={() => go('job', e.job)}>{e.job}</button></> : null}</div></div>))
          : box('Nothing yet today.')}</section>
    </div>
  </>
}
