import * as React from 'react'
import { BK, NODE } from '../data/core.ts'
import { artIc, tfmt } from '../lib/util.ts'
import { PB, steps } from '../model/world.ts'
import type { Job, Round } from '../model/types.ts'
import { LIVE } from '../live/api.ts'
import { Ic } from '../ui/Icon.tsx'

/* Past rounds of a job: one compact row each under the phase columns, newest first. A row expands into
   what that pass left behind, read-only. Columns line up with the board because both use the fixed
   phase and link widths. */

function RoundDetail({ j, r }: { j: Job; r: Round }) {
  return (
    <div className="rd-d">{steps(j.pb).filter((s) => r.flow[s.id]).map((s) => {
      const f = r.flow[s.id], sent = Object.values(f.sent)
      return (
        <section key={s.id} className="rd-step">
          <h4><i className={'chip s-' + f.s} />{s.t}<span className="why"> · {NODE[f.s][1]}{f.m ? ` · ${f.m}` : ''}</span></h4>
          {f.arts.length ? <div className="arts">{f.arts.map((a, i) => (
            <span key={i} className={'art' + (a.ok ? '' : ' gh')}><Ic n={artIc(a.n)} sm />{LIVE.on && a.link ? <a href={a.link} target="_blank" rel="noopener">{a.n}</a> : a.n}</span>))}</div> : null}
          {f.b.map((b, i) => <p key={i} className="why"><Ic n={BK[b.k].i} sm /> {b.t}{b.r ? ` — ${b.r}` : b.o ? ' (open)' : ''}</p>)}
          {f.out ? <pre className="out">{f.out}</pre> : f.dr ? <><div className="why">LLM draft, not accepted</div><pre className="out">{f.dr.t}</pre></> : null}
          {sent.map((m, i) => <p key={'m' + i} className="why"><Ic n="send" sm /> sent {tfmt(m.at)}: {m.t}</p>)}
        </section>
      )
    })}</div>
  )
}

export function Rounds({ j }: { j: Job }) {
  const [open, setOpen] = React.useState<number | null>(null)
  if (!j.rounds?.length) return null
  return (
    <div className="rounds" aria-label="Past rounds">{[...j.rounds].reverse().map((r) => (
      <div key={r.n} className="rd">
        <div className="rd-h">
          <button className="lnk" aria-expanded={open === r.n} onClick={() => setOpen(open === r.n ? null : r.n)}>
            <Ic n="chevron" sm />Round {r.n}</button>
          <span className="why">ended {tfmt(r.at)} · {r.by} returned it: {r.why}</span>
        </div>
        <div className="rd-row">{PB[j.pb].ph.map((p, i) => (
          <React.Fragment key={i}>
            {i ? <div className="link" /> : null}
            <div className="rd-ph">{p.s.filter((s) => r.flow[s.id]).map((s) => (
              <span key={s.id} className="rd-s" title={`${s.t}: ${NODE[r.flow[s.id].s][1]}`}><i className={'chip s-' + r.flow[s.id].s} />{s.t}</span>))}</div>
          </React.Fragment>))}</div>
        {open === r.n ? <RoundDetail j={j} r={r} /> : null}
      </div>))}
    </div>
  )
}
