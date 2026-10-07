import * as React from 'react'
import { GROUPS } from '../data/ui.ts'
import { ago } from '../lib/util.ts'
import { holdsOf, openOf } from '../model/blockers.ts'
import { JOBS, PB, S, W, isClosed, isLive, needsYou, wsJobs } from '../model/world.ts'
import type { Job } from '../model/types.ts'
import { commit } from '../store.ts'
import { LIVE, missingParts } from '../live/api.ts'
import { go } from '../actions/nav.tsx'
import { newJob } from '../actions/newjob.tsx'
import { Chips, NextCell, Pill } from '../ui/bits.tsx'
import { Ic } from '../ui/Icon.tsx'

function inGroup(j: Job, g: string) {
  if (g === 'all') return true
  if (g === 'closed') return isClosed(j)
  if (isClosed(j)) return false
  const n = needsYou(j)
  return g === 'needs' ? !!n : g === 'waiting' ? (j.st === 'waiting-external' || j.st === 'review') && !n : g === 'progress' ? j.st === 'active' && !n
    : g === 'drafts' ? j.st === 'draft' : g === 'recurring' ? j.st === 'recurring' : g === 'blockers' ? holdsOf(JOBS, j.id).length > 0 : false
}
/** what needs you first, closed jobs last, newest first within each */
const rank = (j: Job) => isClosed(j) ? 3 : needsYou(j) ? 0 : j.st === 'draft' ? 2 : 1

function Row({ j }: { j: Job }) {
  const cls = (isClosed(j) ? 'closed' : '') + (S.flash === j.id ? ' flash' : '')
  return (
    <tr className={cls || undefined} onClick={() => go('job', j.id)}>
      <td><button className="lnk key">{j.key}</button></td>
      <td><div className="topic"><span className="t">{j.t}</span><span className="sub"><span className="tag">{j.prj}</span>{PB[j.pb].n} · {j.id}{(() => {
          const h = holdsOf(JOBS, j.id).length, w = [...new Set(Object.values(j.flow).filter(isLive).flatMap((f) => openOf(f).map((l) => l.j)))]
          return h ? ` · holds ${h}` : w.length && !isClosed(j) ? ` · waits for ${w.join(', ')}` : null
        })()}</span></div></td>
      <td><Pill st={j.st} /></td><td><Chips j={j} /></td><td><NextCell j={j} /></td><td className="why num">{ago(j.ts)}</td>
    </tr>
  )
}

export function Jobs() {
  const w = W(), all = wsJobs(), q = S.q.trim().toLowerCase()
  const base = all.filter((j) => (S.prj === 'all' || j.prj === S.prj) && (!q || (j.key + ' ' + j.t + ' ' + j.id).toLowerCase().includes(q)))
  const list = base.filter((j) => inGroup(j, S.f)).sort((a, b) => rank(a) - rank(b) || b.ts - a.ts)
  const clear = () => commit(() => { S.f = 'all'; S.prj = 'all'; S.q = '' })
  return <>
    <div className="vh"><div><div className="eyebrow">{w.n} · {w.d}</div><h1>Jobs</h1>
      <p>Each job follows a playbook. You move every step yourself, or ask the LLM for a draft; nothing runs on its own.</p></div>
      <div className="acts"><button className="btn pri" onClick={() => newJob()}><Ic n="plus" sm />New job</button></div></div>
    <div className="fbar">
      {GROUPS.map(([g, l]) => <button key={g} className="fb" aria-pressed={S.f === g} onClick={() => commit(() => { S.f = g })}>{l}<span className="n">{base.filter((j) => inGroup(j, g)).length}</span></button>)}
      <span className="fsp" />
      <select className="sel" id="prj" aria-label="Project" value={S.prj} onChange={(e) => { const v = e.target.value; commit(() => { S.prj = v }) }}>
        <option value="all">All projects</option>{w.prj.map((p) => <option key={p} value={p}>{p}</option>)}</select>
      <label className="search"><Ic n="search" sm /><input id="q" type="search" placeholder="Search  /" aria-label="Search jobs" value={S.q}
        onChange={(e) => { const v = e.target.value; commit(() => { S.q = v }) }} /></label>
    </div>
    <div className="tw"><table className="tbl"><thead><tr><th>Key</th><th>Topic</th><th>Status</th><th>Flow</th><th>Next</th><th>Updated</th></tr></thead>
      <tbody>{list.length ? list.map((j) => <Row key={j.id} j={j} />)
        : <tr><td colSpan={6} className="empty">{LIVE.on && missingParts().includes('jobs') ? 'Jobs unavailable: the state store did not answer.'
          : <>No jobs here. <button className="lnk" onClick={clear}>Show all</button></>}</td></tr>}</tbody></table>
      <div className="tfoot"><span>{list.length} of {all.length} jobs in {w.n}</span><span className="src">{LIVE.on ? 'workplace state store' : 'demo data'}</span></div></div>
  </>
}
