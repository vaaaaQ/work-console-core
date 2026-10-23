import * as React from 'react'
import { BK, NODE } from '../data/core.ts'
import { artIc, tfmt } from '../lib/util.ts'
import { CTX } from '../model/world.ts'
import { roundPhases, stepOf } from '../model/transitions.ts'
import { failedChecks, isNone } from '../model/facts.ts'
import type { Fact, RoundFact } from '../model/facts.ts'
import type { Job, Round } from '../model/types.ts'
import { FactList } from '../ui/Facts.tsx'
import { LIVE } from '../live/api.ts'
import { ArtName } from '../ui/artifact.tsx'
import { Ic } from '../ui/Icon.tsx'
import { OutText } from '../ui/outText.ts'

/* Past rounds of a job: one compact row each under the phase columns, newest first. A row expands into
   what that pass left behind, read-only. Columns line up with the board because both use the fixed
   phase and link widths. */

function RoundDetail({ j, r }: { j: Job; r: Round }) {
  return (
    <div className="rd-d">{roundPhases(CTX, j, r).flatMap((p) => p.s).filter((s) => r.flow[s.id]).map((s) => {
      const f = r.flow[s.id], sent = Object.values(f.sent)
      return (
        <section key={s.id} className="rd-step">
          <h4><i className={'chip s-' + f.s} />{s.t}<span className="why"> · {NODE[f.s][1]}{f.m ? ` · ${f.m}` : ''}</span></h4>
          {f.arts.length ? <div className="arts">{f.arts.map((a, i) => (
            <span key={i} className={'art' + (a.ok ? '' : ' gh')}><Ic n={artIc(a.n)} sm />{LIVE.on && a.link ? <ArtName n={a.n} link={a.link} /> : a.n}</span>))}</div> : null}
          {f.b.map((b, i) => <p key={i} className="why"><Ic n={BK[b.k].i} sm /> {b.t}{b.r ? ` — ${b.r}` : b.o ? ' (open)' : ''}</p>)}
          <FactList j={j} fx={f.fx} />
          {f.out ? <OutText t={f.out} /> : f.dr ? <><div className="why">LLM draft, not accepted</div><OutText t={f.dr.t} /></> : null}
          {sent.map((m, i) => <p key={'m' + i} className="why"><Ic n="send" sm /> sent {tfmt(m.at)}: {m.t}</p>)}
        </section>
      )
    })}</div>
  )
}

/** the round fact the console wrote when round n went back: on the next pass's step it went back to */
function roundFact(j: Job, n: number): (Fact & RoundFact) | undefined {
  const later = [...(j.rounds ?? []).filter((r) => r.n > n).map((r) => r.flow), j.flow]
  return later.flatMap((fl) => Object.values(fl).flatMap((f) => f.fx ?? []))
    .find((f): f is Fact & RoundFact => f.kind === 'round' && !isNone(f) && (f as RoundFact).n === n)
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
          <span className="why">ended {tfmt(r.at)} · {r.fx
            ? <>fix round {r.fx.n} of {r.fx.max}: “{roundPhases(CTX, j, r).flatMap((p) => p.s).find((s) => s.id === r.fx!.step)?.t ?? r.fx.step}” failed, the console sent it back: {r.why}</>
            : <>{r.by} returned it: {r.why}</>}</span>
          {(() => {
            const rf = roundFact(j, r.n), failed = rf?.failed.length ? rf.failed : failedChecks(Object.values(r.flow).flatMap((f) => f.fx ?? []))
            return rf || failed.length ? <span className="fx-rd"><span className="lamp cur" />{rf ? `back to “${stepOf(CTX, j, rf.back_to)?.t ?? rf.back_to}”` : ''}
              {failed.length ? <>{rf ? ' · ' : ''}<span className="lamp bad" />failed: {failed.join(', ')}</> : null}</span> : null
          })()}
        </div>
        <div className="rd-row">{roundPhases(CTX, j, r).map((p, i) => (
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
