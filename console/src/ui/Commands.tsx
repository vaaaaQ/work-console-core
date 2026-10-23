import * as React from 'react'
import { acceptDraft, acceptRan, failText } from '../actions/flow.tsx'
import * as api from '../live/api.ts'
import { LIVE } from '../live/api.ts'
import { acceptWay, cmdsN, okPreview } from '../model/transitions.ts'
import { approveTo, thread } from '../model/thread.ts'
import type { Job } from '../model/types.ts'
import { CTX } from '../model/world.ts'
import { commit } from '../store.ts'
import { Ic } from './Icon.tsx'
import { toast } from './toasts.tsx'

/* A draft that waits for commands: the list, and one Approve that runs exactly those in the draft's session, or I ran them
   for commands the person ran outside the console. The backend takes the commands from the stored draft, never from the
   page; the page names the draft by its time. A draft of the step that grants the job's one-time approval lists what
   accepting it approves. */

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

/** on the draft of the step whose Accept grants the job's one-time approval: the commands it approves, or why none */
export function OkList({ job, step }: { job: Job; step: string }) {
  const p = job.flow[step]?.dr ? okPreview(CTX, job, step) : null
  if (!p) return null
  if ('why' in p) return <div className="cmds"><div className="eyebrow">Accepting approves no commands for this job</div><p className="why" style={{ margin: 0 }}>{p.why}.</p></div>
  return (
    <div className="cmds">
      <div className="eyebrow">Accepting also approves these {cmdsN(p.cmds.length)} for this job</div>
      <ol className="mono">{p.cmds.map((c, i) => <li key={i} style={{ whiteSpace: 'pre-wrap' }}>{c}</li>)}</ol>
      <p className="why" style={{ margin: 0 }}>A later draft that asks for exactly these runs them without asking you. Withdraw it in Approvals.</p>
    </div>
  )
}

/** Accept; on a draft that waits for commands it is I ran them, since an Accept alone would close a step whose commands never
    ran. A draft that reports an outcome asks how first, commands or not (acceptWay) */
export function AcceptBtn({ job, step }: { job: Job; step: string }) {
  const f = job.flow[step]
  if (!f?.dr) return null
  if (acceptWay(f.dr) === 'ran') return <button type="button" className={'btn sm' + (approveHead(job, step) ? '' : ' pri')} disabled={!!f.run}
    title="You ran these commands yourself, outside the console: accept the draft as done" onClick={() => acceptRan(job.id, step)}><Ic n="check" sm />I ran them</button>
  return <button type="button" className={'btn sm' + (approveHead(job, step) ? '' : ' pri')} disabled={!!f.run} onClick={() => acceptDraft(job.id, step)}><Ic n="check" sm />Accept</button>
}

/** the run a step's Approve goes to (approveTo); live only */
export function approveHead(job: Job, step: string) {
  const f = job.flow[step]
  if (!LIVE.on || !f?.dr) return null
  return approveTo(f.dr, thread(Object.values(LIVE.runs), job.id, step))
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
