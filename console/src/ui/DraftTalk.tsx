import * as React from 'react'
import { failText } from '../actions/flow.tsx'
import { newBlocker } from '../actions/newjob.tsx'
import * as api from '../live/api.ts'
import { LIVE } from '../live/api.ts'
import { thread } from '../model/thread.ts'
import type { Job, RunIntent, RunRec } from '../model/types.ts'
import { commit } from '../store.ts'
import { Ic } from './Icon.tsx'
import { OutText } from './outText.ts'
import { RunFeed } from './RunFeed.tsx'
import { toast } from './toasts.tsx'
import { VoiceField } from './VoiceField.tsx'

/* A draft's conversation: the replies after its first ask, each with what came of it, then the box that
   sends the next one. A reply runs in the draft's own session; live only. */

const SEND_L: Record<RunIntent, string> = { revise: 'Send', accept: 'Send and accept', ask: 'Ask' }

/** last = how many replies to show before "N more" */
export function DraftTalk({ job, step, last }: { job: Job; step: string; last?: number }) {
  const [more, setMore] = React.useState(false), [t, setT] = React.useState(''), [intent, setIntent] = React.useState<RunIntent>('revise')
  const [sending, setSending] = React.useState(false)
  const f = job.flow[step]
  if (!LIVE.on || !f?.dr) return null
  const all = thread(Object.values(LIVE.runs), job.id, step), turns = all.filter((r) => r.parent), head = all.at(-1)
  const shown = last && !more ? turns.slice(-last) : turns
  const send = async () => {
    if (!head) return
    setSending(true)
    try {
      const { run } = await api.reply(head.id, t.trim(), intent)
      commit(() => { LIVE.runs[run.id] = run })
      setT(''); setIntent('revise')
    } catch (e) { toast(failText(e)) } finally { setSending(false) }
  }
  return (
    <div className="talk">
      {shown.length < turns.length && <button type="button" className="lnk talk-more" onClick={() => setMore(true)}>{turns.length - shown.length} more</button>}
      {shown.map((r) => <Turn key={r.id} r={r} />)}
      {all.some((r) => r.session)
        ? !f.run && <div className="talk-box">
            <VoiceField value={t} onChange={setT} target="llm" ctx={f.dr.t} intent={intent} onIntent={setIntent} rows={3} placeholder="Reply to the draft: what to change, or a question" />
            <div className="row"><button type="button" className="btn sm pri" disabled={!t.trim() || sending} onClick={() => void send()}><Ic n="send" sm />{SEND_L[intent]}</button>
              <button type="button" className="btn sm" disabled={sending} title="Make or link a job this step waits for"
                onClick={() => { const say = t.trim(); newBlocker({ job: job.id, step, ...(say ? { say } : {}) }) }}><Ic n="hourglass" sm />Blocker</button></div>
          </div>
        : <div className="hint">This draft has no LLM session to continue; Reject with a reason starts a new one.</div>}
    </div>
  )
}

function Turn({ r }: { r: RunRec }) {
  // a run still going, or stopped short, shows as the inspector shows a run: its feed, Cancel or Resume
  if (r.state === 'queued' || r.state === 'running' || r.state === 'interrupted' || r.state === 'failed') return <RunFeed run={r} />
  const who = r.via === 'session' ? 'Claude Code' : r.via === 'console' ? 'Console' : 'You'
  return (
    <div className="turn">
      <div className="turn-q"><b>{who} · {r.intent}</b> {r.q}</div>
      {r.state === 'answered' ? <OutText t={r.a || ''} />
        : r.state === 'draft' ? <div className="hint">{r.intent === 'accept' ? 'The draft was revised but not accepted; accept it above.' : 'The draft was revised.'}</div>
        : <div className="hint">{r.state}{r.reason ? `: ${r.reason}` : ''}</div>}
    </div>
  )
}
