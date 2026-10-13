import * as React from 'react'
import { failText } from '../actions/flow.tsx'
import * as api from '../live/api.ts'
import { LIVE } from '../live/api.ts'
import { cmdsN } from '../model/transitions.ts'
import { thread } from '../model/thread.ts'
import type { Job } from '../model/types.ts'
import { commit } from '../store.ts'
import { Ic } from './Icon.tsx'
import { toast } from './toasts.tsx'

/* A draft that waits for commands: the list, and one Approve that runs exactly those in the draft's session.
   The backend takes the commands from the stored draft, never from the page; the page names the draft by its time. */

/** the commands the step's draft waits to have approved, numbered; nothing when it waits for none */
export function CmdList({ job, step }: { job: Job; step: string }) {
  const cm = job.flow[step]?.dr?.cm
  if (!cm?.length) return null
  return (
    <div className="cmds">
      <div className="eyebrow">Waits for approval of {cmdsN(cm.length)}</div>
      <ol className="mono">{cm.map((c, i) => <li key={i} style={{ whiteSpace: 'pre-wrap' }}>{c}</li>)}</ol>
    </div>
  )
}

/** the run a step's Approve goes to: its newest, when the thread has a session to continue; live only */
export function approveHead(job: Job, step: string) {
  const f = job.flow[step]
  if (!LIVE.on || !f?.dr?.cm?.length) return null
  const all = thread(Object.values(LIVE.runs), job.id, step)
  return all.some((r) => r.session) ? all.at(-1) ?? null : null
}

/** Approve: one click, no dialog; hidden without a session to continue, disabled while a run is on the step */
export function ApproveBtn({ job, step }: { job: Job; step: string }) {
  const [busy, setBusy] = React.useState(false)
  const f = job.flow[step], head = approveHead(job, step)
  if (!head || !f?.dr) return null
  const at = f.dr.at
  const go = async () => {
    setBusy(true)
    try {
      const { run } = await api.approve(head.id, at)
      commit(() => { LIVE.runs[run.id] = run })
    } catch (e) { toast(failText(e)) } finally { setBusy(false) }
  }
  return <button type="button" className="btn sm pri" disabled={!!f.run || busy} title="Run exactly these commands, in this order, in the draft's session"
    onClick={() => void go()}><Ic n="check" sm />Approve</button>
}
