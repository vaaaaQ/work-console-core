import * as React from 'react'
import { PACKS } from '../data/packs.ts'
import { REG } from '../data/registry.ts'
import { hm, toMin } from '../lib/util.ts'
import { srcState } from '../live/boot.ts'
import { calOf, homeCal, homeLabel, homeLog, homeNeeds } from '../model/home.ts'
import { W } from '../model/world.ts'
import { go } from '../actions/nav.tsx'
import { NextCell } from '../ui/bits.tsx'
import { Ic } from '../ui/Icon.tsx'

const box = (t: string, k?: React.Key) => <div key={k} className="pb"><p className="why" style={{ margin: 0 }}>{t}</p></div>
/** a row's workspace, shown only when several are registered */
const tag = (label: string | null) => (label ? <span className="tag">{label}</span> : null)
const uniq = (l: string[]) => [...new Set(l)]

/* Today is Home: meetings, the jobs that need you and the activity of every workspace. With one workspace
   it reads as that workspace's page, as it always did. */
export function Today() {
  const w = W(), now = toMin(hm()), home = REG.length > 1
  const wss = REG.map((r) => r.page.id), withSrc = wss.filter((ws) => PACKS[ws].src.cal), shown = withSrc.filter((ws) => calOf(ws))
  // a calendar that has a source but no events yet says why: loading, or unavailable
  const why = withSrc.filter((ws) => !calOf(ws) && srcState('cal', ws)).map((ws) => {
    const st = srcState('cal', ws), l = homeLabel(ws)
    return (l ? l + ': ' : '') + (st === 'loading' ? 'Loading the calendar…' : `Calendar unavailable: ${st}.`)
  })
  const cal = homeCal(), need = homeNeeds(), log = homeLog()
  const tzs = uniq(shown.filter((ws) => PACKS[ws].tz).map((ws) => PACKS[ws].tzl))
  let nx = false
  const ev = cal.map(({ e, label }, i) => {
    const a = toMin(e.b), end = a + (parseInt(e.d, 10) || 1), past = end <= now
    const cls = past ? ' past' : nx ? '' : (nx = true, ' next')
    const meta = [e.d && e.d !== '—' ? e.d : '', e.n, a <= now && !past ? 'now' : ''].filter(Boolean).join(' · ')
    return <div key={i} className={'ev' + cls}><div className="tm">{e.b}<small>{e.v} {e.tzl}</small></div><div>{tag(label)}<b>{e.t}</b>{meta ? <div className="why">{meta}</div> : null}</div></div>
  })
  return <>
    <div className="vh"><div><div className="eyebrow">{home ? 'Home' : `${w.n} · work`}</div><h1>Today</h1>
      <p>{shown.length ? `Meetings in your local time${tzs.length ? ` with ${tzs.join(' and ')} alongside` : ''}, the` : 'The'} jobs that need you, and what you and the LLM runs you asked for did today{home ? ', in every workspace' : ''}.</p></div></div>
    <div className="cols">
      <div style={{ display: 'grid', gap: 16, minWidth: 0 }}>
        <section className="panel"><header><Ic n="calendar" /><h3>Calendar</h3><span className="src">{shown.length ? uniq(shown.map((ws) => PACKS[ws].src.cal!.n)).join(' · ') : 'not set'}</span></header>
          {shown.length ? <>{cal.length ? <div>{ev}</div> : box('No meetings today.')}{why.map((t) => box(t, t))}</>
            : why.length ? <>{why.map((t) => box(t, t))}</>
              : box(home ? 'No workspace has a calendar source yet. A pack adds one by mapping a tool onto the core Calendar concept.'
                : `${w.n} has no calendar source yet. A pack adds one by mapping a tool onto the core Calendar concept.`)}</section>
        <section className="panel"><header><Ic n="user" /><h3>Needs you</h3><span className="src">{need.length}</span></header>
          {need.length ? <div style={{ overflowX: 'auto' }}><table className="mt"><thead><tr><th>Key</th><th>Job</th><th>Next</th></tr></thead><tbody>
            {need.map(({ j, label }) => <tr key={j.id}><td><button className="lnk key" onClick={() => go('job', j.id)}>{j.key}</button></td><td>{tag(label)}{j.t}</td><td><NextCell j={j} /></td></tr>)}
          </tbody></table></div> : box('Nothing needs you right now.')}</section>
      </div>
      <section className="panel"><header><Ic n="activity" /><h3>Activity</h3><span className="src">{log.length} today</span></header>
        {log.length ? log.map(({ e, label }, i) => (
          <div key={log.length - i} className="fe"><span className="tm">{e.at}</span><span className="st"><span className={'lamp ' + e.l} />{e.a}</span>
            <div>{tag(label)}{e.t}{e.job ? <> · <button className="lnk mono" onClick={() => go('job', e.job)}>{e.job}</button></> : null}</div></div>))
          : box('Nothing yet today.')}</section>
    </div>
  </>
}
