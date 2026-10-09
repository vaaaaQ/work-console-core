import * as React from 'react'
import { BK, MODES, NODE } from '../data/core.ts'
import { G } from '../data/ui.ts'
import { ago, artIc, dm, tfmt } from '../lib/util.ts'
import { openOf, holdsOf } from '../model/blockers.ts'
import type { Mark } from '../model/preview.ts'
import { JOBS, PB, S, byId, isClosed, isLive, jsteps, phState, phases, pview } from '../model/world.ts'
import type { Job, JournalEntry, NodeState, Phase, Step } from '../model/types.ts'
import { LIVE } from '../live/api.ts'
import { go } from '../actions/nav.tsx'
import { jobCloseAsk, jobReopen, jobStart, selBadge, selStep } from '../actions/flow.tsx'
import { Pill, useReplay } from '../ui/bits.tsx'
import { ArtName, dlHref } from '../ui/artifact.tsx'
import { Ic } from '../ui/Icon.tsx'
import { CtxPanel, DescPanel } from './Context.tsx'
import { ProposalCard } from './Proposal.tsx'
import { Rounds } from './Rounds.tsx'
import { TrackerPanels } from './Tracker.tsx'

const LEGEND: NodeState[] = ['done', 'cur', 'wait', 'bad', 'fut', 'tpl']

function JobActs({ j }: { j: Job }) {
  if (isClosed(j)) return <button className="btn" onClick={jobReopen}><Ic n="retry" sm />Reopen</button>
  return <>
    {j.st === 'draft' || j.st === 'ready' ? <button className="btn pri" onClick={jobStart}><Ic n="play" sm />Start</button> : null}
    <button className="btn ghost" onClick={jobCloseAsk}><Ic n="archive" sm />Close…</button>
  </>
}

const MARK: Record<Mark, string> = { add: 'proposed new step', del: 'proposed for removal', edit: 'proposed change', reopen: 'reopens' }

/** prior = a step before the current round's start: its state comes from an earlier round; mark = what the open proposal does to it */
function Node({ j, s, prior, mark }: { j: Job; s: Step; prior: boolean; mark?: Mark }) {
  const f = j.flow[s.id], st = f.s, g = st === 'cur' ? MODES[s.m].i : G[st]
  const ref = useReplay<HTMLDivElement>(f.nw)
  return (
    <div ref={ref} className={`node n-${st}${S.sel === s.id ? ' on' : ''}${f.nw ? ' new' : ''}${prior ? ' prior' : ''}${mark ? ' pv-' + mark : ''}`}>
      <button className="hit" id={'h-' + s.id} aria-label={`${s.t}: ${NODE[st][1]}${mark ? `, ${MARK[mark]}` : ''}`} disabled={mark === 'add'} onClick={() => selStep(s.id)} />
      <span className="g">{g ? <Ic n={g} /> : null}</span><span className="n-t">{mark === 'add' ? '+ ' : mark === 'edit' ? '~ ' : ''}{s.t}</span>
      <span className="n-m"><Ic n={MODES[s.m].i} sm />{isLive(f) && f.s !== 'bad' && openOf(f).length ? `⏳ ${openOf(f).map((l) => l.j).join(' ')}` : f.m || MODES[s.m].l}{s.msg ? <> <span className="msgs"><Ic n="message" sm />{s.msg}</span></> : null}
        {s.add && mark !== 'add' ? <> <span className="n-add" title={s.add.why}>+ {dm(s.add.at)}</span></> : null}</span>
      {mark === 'reopen' ? <span className="n-tag pv">reopens</span> : null}
      {f.run ? <span key="run" className="n-tag run"><span className="spin" />LLM working</span>
        : f.dr ? <span key="dr" className={'n-tag' + (f.dr.nw ? ' new' : '')}><Ic n="bot" sm />LLM draft to review</span> : null}
      {f.arts.length ? <div className="arts">{f.arts.map((a, i) => <span key={i} className={`art${a.ok ? '' : ' gh'}${a.nw ? ' new' : ''}`}><Ic n={artIc(a.n)} sm />{a.n}</span>)}</div> : null}
      {f.b.length ? <div className="bdgs">{f.b.map((b, i) => (
        <button key={i} className={`bdg ${b.o ? b.k : 'res'}${b.nw ? ' new' : ''}`} title={`${BK[b.k].l}: ${b.t}`} aria-label={`${BK[b.k].l}${b.o ? ' (open)' : ''}: ${b.t}`}
          onClick={() => selBadge(s.id, i)}><Ic n={BK[b.k].i} /></button>))}</div> : null}
    </div>
  )
}

/** ph and mk = the phases and marks of an open proposal's preview; j then carries the preview's flows */
function Board({ j, ph, mk = {} }: { j: Job; ph?: Phase[]; mk?: Record<string, Mark> }) {
  const all = jsteps(j), ri = j.rf ? all.findIndex((s) => s.id === j.rf) : 0
  const prior = new Set(all.slice(0, Math.max(ri, 0)).map((s) => s.id))
  return (
    <div className="board">{(ph ?? phases(j)).map((p, i) => {
      const d = p.s.filter((s) => j.flow[s.id].s === 'done').length
      return (
        <React.Fragment key={i}>
          {i ? <div className="link"><Ic n="chevron" /></div> : null}
          <div className="phase">
            <div className="ph-h"><span className={'chip s-' + phState(j, p)}>{p.c}</span><span className="nm">{p.n}</span><span className="pr">{d}/{p.s.length}</span></div>
            <div className="nodes">{p.s.map((s) => <Node key={s.id} j={j} s={s} prior={prior.has(s.id)} mark={mk[s.id]} />)}</div>
          </div>
        </React.Fragment>
      )
    })}</div>
  )
}

const Je = ({ e }: { e: JournalEntry }) => (
  <div className={'je' + (e.nw ? ' new' : '')}><h4>{tfmt(e.ts)} — {e.a}</h4><p><b>Observed</b> {e.o}</p><p><b>Changed</b> {e.c}</p><p><b>Next</b> {e.n}</p></div>
)

export function JobView() {
  const j = S.job ? byId(S.job) : undefined
  if (!j) return <div className="empty">Job not found. <button className="lnk" onClick={() => go('jobs')}>Back to jobs</button></div>
  const holds = holdsOf(JOBS, j.id)
  const pb = PB[j.pb], arts = jsteps(j).flatMap((s) => j.flow[s.id].arts.map((a) => ({ ...a, s })))
  // never stored: the board shows the proposal as it would land, derived on every render
  const pv = pview(j), bj = pv && !pv.err ? { ...j, flow: pv.flow } : j
  return <>
    <div className="jh"><button className="back" onClick={() => go('jobs')}><Ic n="arrow-left" sm />Jobs</button>
      <div className="jh-row"><span className="key">{j.key}</span><h1>{j.t}</h1><Pill st={j.st} /><span className="fsp" /><JobActs j={j} /></div>
      <div className="meta"><span>Playbook <b>{pb.n}</b>{pb.ws ? '' : ' · core'}</span><span>Project <b>{j.prj}</b></span><span>Updated <b>{ago(j.ts)}</b></span>{holds.length ? <span>Holds {holds.filter((h, i) => holds.findIndex((x) => x.job.id === h.job.id) === i).map((h, i) => <React.Fragment key={h.job.id + h.step}>{i ? ', ' : ''}<a href={`#${h.job.id}`} onClick={(e) => { e.preventDefault(); go('job', h.job.id) }}><b>{h.job.id}</b> · {h.job.t}</a></React.Fragment>)}</span> : null}<span className="mono">{j.id} · {j.slug}</span></div></div>
    <TrackerPanels j={j} />
    <div className="toolbar"><div className="legend">{LEGEND.map((k) => <span key={k}><i className={'chip s-' + k} />{NODE[k][1]}</span>)}</div><span className="fsp" />
      {pv?.banner ? <span className="rd-cur pv">{pv.banner}</span> : null}
      {j.rounds?.length ? <span className="rd-cur">Round {j.rounds.length + 1}</span> : null}<span className="hint">Click a step to work on it</span></div>
    {j.pp ? <ProposalCard j={j} where="board" /> : null}
    <div className="bw" id="bw"><Board j={bj} ph={pv?.ph} mk={pv?.mk} /><Rounds j={j} /></div>
    <div className="below">
      <section className="panel"><header><Ic n="list" /><h3>Journal</h3><span className="src">journal.md</span></header>
        <div className="pb jr">{j.jr.map((e, i) => <Je key={j.jr.length - i} e={e} />)}</div></section>
      <div className="side"><DescPanel j={j} /><CtxPanel j={j} />
      <section className="panel"><header><Ic n="file" /><h3>Artifacts</h3><span className="src">{arts.filter((a) => a.ok).length}/{arts.length} ready</span></header>
        <div className="pb">{arts.length ? <ul className="al">{arts.map((a, i) => (
          <li key={i} className={a.ok ? undefined : 'gh'}><Ic n={artIc(a.n)} sm /><span className="mono">{LIVE.on && a.link ? <ArtName n={a.n} link={a.link} /> : a.n}</span><span className="why">{a.s.t}</span>
            <span className="st"><span className={'lamp ' + (a.ok ? 'ok' : 'hol')} />{a.ok ? 'ready' : 'planned'}</span>
            {LIVE.on && a.link ? <a className="iconbtn adl" href={dlHref(a.link)} download={a.n} aria-label={`Download ${a.n}`} title="Download"><Ic n="download" sm /></a> : <span />}</li>))}</ul>
          : <p className="why" style={{ margin: 0 }}>This playbook produces no files.</p>}</div></section></div>
    </div>
  </>
}
