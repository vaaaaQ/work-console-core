import * as React from 'react'
import { MODES } from '../data/core.ts'
import { tfmt } from '../lib/util.ts'
import { ppLine } from '../model/preview.ts'
import { jctx, pview } from '../model/world.ts'
import type { Job, Start } from '../model/types.ts'
import { go } from '../actions/nav.tsx'
import { ppAccept, ppEdit, ppReject } from '../actions/proposal.tsx'
import { discuss } from '../actions/agent.tsx'
import { LIVE } from '../live/api.ts'
import { Ic } from '../ui/Icon.tsx'

const STARTS: Start[] = ['hand', 'self', 'auto']

/** the agent's open proposal on a job: what it says, one line per change, and the answer; on the board, in the panel and in Approvals */
export function ProposalCard({ j, where }: { j: Job; where: 'board' | 'panel' | 'approvals' }) {
  const p = j.pp
  if (!p) return null
  const x = jctx(), err = p.err || pview(j)?.err
  return (
    <article className={'dc pp-card'} aria-label={`Proposal for ${j.id}`}>
      <div className="dc-h"><span className="st"><Ic n="bot" sm /><b>Proposal · {tfmt(p.at)} · agent</b></span>
        {where === 'approvals' ? <button className="lnk mono" onClick={() => go('job', j.id)}>{j.id} · {j.t}</button> : null}</div>
      <div className="pp-say">{p.say}</div>
      <ul className="pp-l">{p.cmds.map((c, i) => {
        const l = ppLine(x, j, c)
        return (
          <li key={i}><span className="sg" aria-hidden="true">{l.sign}</span><span className="pp-t">{l.t}</span>
            {l.mode ? <span className="src"><Ic n={MODES[l.mode].i} sm />{l.mode === 'llm' ? 'LLM' : 'you'}</span> : null}
            {l.mode === 'llm' ? <span className="seg" role="group" aria-label="Starts">{STARTS.map((s) => (
              <button key={s} type="button" aria-pressed={l.start === s} onClick={() => void ppEdit(j.id, i, s)}>{s}</button>))}</span> : null}</li>
        )
      })}</ul>
      {err ? <div className="errs">It no longer applies: {err}</div> : null}
      <div className="row"><button className="btn sm pri" onClick={() => void ppAccept(j.id)}><Ic n="check" sm />Accept</button>
        <button className="btn sm" onClick={() => ppReject(j.id)}><Ic n="x" sm />Reject…</button>
        {where !== 'panel' && LIVE.on ? <button className="btn sm ghost" onClick={() => discuss(j)}><Ic n="bot" sm />Discuss</button> : null}</div>
    </article>
  )
}
