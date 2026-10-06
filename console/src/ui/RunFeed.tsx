import * as React from 'react'
import { hm } from '../lib/util.ts'
import * as api from '../live/api.ts'
import { LIVE } from '../live/api.ts'
import type { RunRec, RunState } from '../model/types.ts'
import { repaint } from '../store.ts'
import { llmResume, runCancel } from '../actions/flow.tsx'
import { Ic } from './Icon.tsx'

/* A live run in the step inspector: its state, what the session is doing, Cancel or Resume. The
   session is taken up by hand with the step's Open button. */

const ST: Record<RunState, [string, string]> = {
  queued: ['wait', 'Queued'], running: ['cur pulse', 'Working on it…'], draft: ['ok', 'Draft ready'], answered: ['ok', 'Answered'],
  failed: ['bad', 'Failed'], cancelled: ['', 'Cancelled'], interrupted: ['wait', 'Interrupted'],
}

/** the newest run of a step, if the backend has one */
export function lastRun(job: string, step: string): RunRec | undefined {
  return Object.values(LIVE.runs).filter((r) => r.job === job && r.step === step).sort((a, b) => b.at.localeCompare(a.at))[0]
}

export function RunFeed({ run }: { run: RunRec }) {
  const box = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (LIVE.feed[run.id]) return
    api.runInfo(run.id).then((r) => { LIVE.feed[run.id] ||= r.feed; LIVE.runs[run.id] = r.run; repaint() }).catch(() => undefined)
  }, [run.id])
  const feed = LIVE.feed[run.id] || []
  React.useEffect(() => { const b = box.current; if (b) b.scrollTop = b.scrollHeight }, [feed.length])
  const [lamp, label] = ST[run.state], live = run.state === 'queued' || run.state === 'running'
  const again = (run.state === 'interrupted' || run.state === 'failed') && run.session
  return (
    <div className={'llmr' + (live ? ' run' : '')}>
      <div className="hd">{live ? <span className="spin" /> : <span className={'lamp ' + lamp} />}<b>{label}</b><span>asked {hm(new Date(run.at))}</span></div>
      {run.reason ? <div className="why">{run.reason}</div> : null}
      <div className="why" style={{ whiteSpace: 'pre-wrap' }}>{run.q}</div>
      {feed.length ? <div ref={box} className="feed" aria-live="polite">{feed.map((l, i) => <div key={i} className={l.startsWith('→') ? 'tool' : undefined}>{l}</div>)}</div>
        : live ? <div className="hint">The session's steps show here as it works.</div> : null}
      <div className="row">
        {live ? <button className="btn sm" onClick={() => void runCancel(run.id)}><Ic n="x" sm />Cancel</button> : null}
        {again ? <button className="btn sm pri" onClick={() => void llmResume(run.id)}><Ic n="retry" sm />Resume</button> : null}
      </div>
    </div>
  )
}
