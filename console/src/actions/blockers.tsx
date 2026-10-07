import * as React from 'react'
import { openOf, reaches, waitsM } from '../model/blockers.ts'
import type { Job } from '../model/types.ts'
import { JOBS, byId, isClosed, stepOf } from '../model/world.ts'
import { Ic } from '../ui/Icon.tsx'
import { closeModal, modal } from '../ui/modal.tsx'
import { doCmd } from './flow.tsx'
import { newBlocker } from './newjob.tsx'

/* Waits for…: an open job of this workspace the step waits for, or a new blocker through the builder. */

/** the jobs a step may wait for: open and not recurring, this workspace's, not this job, and not waiting for it already */
export const candidates = (j: Job) => JOBS.filter((b) => b.ws === j.ws && b.id !== j.id && !isClosed(b) && b.st !== 'recurring' && !reaches(byId, b.id, j.id))

function Pick({ j, step }: { j: Job; step: string }) {
  const [q, setQ] = React.useState(''), [plan, setPlan] = React.useState('')
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const list = candidates(j).filter((b) => !openOf(j.flow[step]).some((l) => l.j === b.id))
    .filter((b) => words.every((w) => `${b.id} ${b.t}`.toLowerCase().includes(w))).sort((a, b) => b.ts - a.ts).slice(0, 30)
  const link = async (id: string) => {
    const p = plan.trim()
    if (await doCmd(j.id, { op: 'waitAdd', step, j: id, ...(p ? { plan: p } : {}) }, `Waits for ${id}`)) closeModal()
  }
  return <>
    <input className="inp" autoFocus placeholder="Search open jobs" value={q} onChange={(e) => setQ(e.target.value)} />
    <textarea className="inp" rows={2} placeholder="Plan: what the step does with the outcome (optional)" value={plan} onChange={(e) => setPlan(e.target.value)} />
    <div className="wf-list">{list.length ? list.map((b) => <button key={b.id} type="button" className="wf-row" onClick={() => void link(b.id)}>
      <span className="mono">{b.id}</span> {b.t}</button>) : <p className="hint">No open job matches.</p>}</div>
  </>
}

export function waitsFor(j: Job, step: string) {
  modal({
    title: `“${stepOf(j, step)?.t ?? step}” waits for…`, cls: 'wf', body: <Pick j={j} step={step} />,
    foot: <><button type="button" className="btn" onClick={closeModal}>Cancel</button>
      <button type="button" className="btn pri" onClick={() => { closeModal(); newBlocker({ job: j.id, step }) }}><Ic n="plus" sm />New blocker</button></>,
  })
}

/** done although blockers are open: asks first, then go() sends it with force */
export function confirmForce(j: Job, sid: string, go: () => void) {
  const f = j.flow[sid]
  modal({
    title: 'Blockers still open',
    body: <p>“{stepOf(j, sid)?.t}” {waitsM(f)}. Go on anyway? The open blockers are removed from the step.</p>,
    foot: <><button type="button" className="btn" onClick={closeModal}>Cancel</button>
      <button type="button" className="btn pri" onClick={() => { closeModal(); go() }}>Go on anyway</button></>,
  })
}
