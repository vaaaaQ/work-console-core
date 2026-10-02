import * as React from 'react'
import { BK, EXEC, MODES } from '../data/core.ts'
import { PRI } from '../data/demo.ts'
import { PACKS } from '../data/packs.ts'
import { hm, initials, tfmt } from '../lib/util.ts'
import { S, TPL, byId, chName, isClosed, isLive, phaseOf, rvState, stepOf } from '../model/world.ts'
import { actOf } from '../model/home.ts'
import type { Flow, Job, Step } from '../model/types.ts'
import { closeDrawer } from '../actions/nav.tsx'
import {
  acceptDraft, askLlm, bAdd, bAnswer, bReopen, editDraft, llmCancel, nudge, rejectDraft, rvOpen, rvVote, stepDoneHere, stepReopen,
  stepResume, stepSkip, stepWait, tplSend,
} from '../actions/flow.tsx'
import { LIVE } from '../live/api.ts'
import { FillT, NodePill } from '../ui/bits.tsx'
import { RunFeed, lastRun } from '../ui/RunFeed.tsx'
import { Ic } from '../ui/Icon.tsx'

type P = { j: Job; s: Step; f: Flow }

function LlmSec({ j, s, f }: P) {
  const run = LIVE.on ? lastRun(j.id, s.id) : undefined
  // live: the run record, not the job, knows whether it is queued, working, stopped or can resume
  if (run && (f.run || ((run.state === 'interrupted' || run.state === 'failed') && !f.dr)))
    return <section className="sec"><div className="eyebrow">LLM</div><RunFeed run={run} /></section>
  if (f.run) return (
    <section className="sec"><div className="eyebrow">LLM</div><div className="llmr run">
      <div className="hd"><span className="spin" /><b>Working on it…</b><span>asked {hm(new Date(f.run.at))}</span></div>
      <div className="why" style={{ whiteSpace: 'pre-wrap' }}>{f.run.q}</div></div></section>
  )
  if (f.dr) return (
    <section className="sec"><div className="eyebrow">LLM draft</div><div className="llmr pending">
      <div className="hd"><Ic n="bot" sm /><b>Waiting for your review</b><span>· {tfmt(f.dr.at)}</span></div><pre className="out">{f.dr.t}</pre>
      <div className="row"><button className="btn sm pri" onClick={() => acceptDraft(j.id, s.id)}><Ic n="check" sm />Accept</button>
        <button className="btn sm" onClick={() => editDraft(j.id, s.id)}><Ic n="pen" sm />Edit…</button>
        <button className="btn sm" onClick={() => rejectDraft(j.id, s.id)}><Ic n="x" sm />Reject</button></div></div></section>
  )
  if (f.out) return <section className="sec"><div className="eyebrow">Accepted output</div><pre className="out">{f.out}</pre></section>
  return null
}

const vcls = (j: Job, v: number) => v > 0 ? 'vp' : v === 0 ? 'v0' : v <= PACKS[j.ws].veto ? 'vx' : 'vn'

function ReviewSec({ j, f }: P) {
  const w = PACKS[j.ws], { r, ok, veto } = rvState(j, f), pr = PRI[j.id], tool = w.src.review?.n
  return (
    <section className="sec"><div className="eyebrow">Review{tool ? ' · ' + tool : ''}{pr ? ' · ' + pr.id : ''}</div><div className="card">
      {r.v.length ? r.v.map((x, i) => (
        <div key={i} className="rv"><span className="av">{initials(x.n)}</span><span>{x.n}</span><span className={'vote ' + vcls(j, x.v)}>{x.v > 0 ? '+' : ''}{x.v} · {w.votes[String(x.v)] || ''}</span></div>))
        : <p className="why" style={{ margin: 0 }}>No votes yet.</p>}
      <div><div className="row"><span>Approvals <b className="num">{ok}/{r.need}</b></span>
        {veto ? <span className="st"><span className="lamp bad" />blocked</span> : ok >= r.need ? <span className="st"><span className="lamp ok" />rule met</span> : null}</div>
        <div className="appr">{Array.from({ length: r.need }, (_, i) => <i key={i} className={i < ok ? 'on' : undefined} />)}</div></div>
      <div className="why">{w.rule}</div>
      {isClosed(j) ? null : <div className="row"><button className="btn sm" onClick={rvVote}><Ic n="check" sm />Record a vote…</button>
        {pr ? <button className="btn sm" onClick={nudge}><Ic n="send" sm />Nudge reviewers…</button> : null}
        {tool ? <button className="btn sm ghost" onClick={rvOpen}><Ic n="external" sm />Open in {tool}</button> : <span className="hint">No code review tool set for this workspace yet</span>}</div>}
    </div></section>
  )
}

function TplSec({ j, s, f }: P) {
  const T = TPL[s.id]
  if (!T) return null
  const live = !isClosed(j) && isLive(f)
  return (
    <section className="sec"><div className="eyebrow">Messages</div>{T.map(([k, lbl, t], i) => {
      const sent = f.sent[i]
      return (
        <div key={i} className={'tplm' + (sent ? ' sent' : '')}>
          <div className="ch"><Ic n={k === 'work' ? 'file' : 'message'} sm />{chName(j, k, lbl)}{sent ? ` · sent ${/T/.test(sent.at) ? hm(new Date(sent.at)) : sent.at}` : ''}</div>
          <div className="body">{sent ? sent.t : <FillT j={j} t={t} />}</div>
          {!sent && live ? <div className="row"><button className="btn sm pri" onClick={() => tplSend(j.id, s.id, i)}><Ic n="send" sm />Review and send…</button></div> : null}
        </div>
      )
    })}</section>
  )
}

function BadgeSec({ j, f }: P) {
  const live = !isClosed(j)
  return (
    <section className="sec"><div className="row"><div className="eyebrow">Questions and notes</div><span className="fsp" />
      {live ? <button className="btn sm ghost" onClick={bAdd}><Ic n="plus" sm />Add…</button> : null}</div>
      {f.b.length ? <div className="bl">{f.b.map((b, i) => (
        <div key={i} className={'bi' + (S.focusB === i ? ' focus' : '')}><span className={'bdg ' + (b.o ? b.k : 'res')}><Ic n={BK[b.k].i} /></span>
          <div><div className="why">{BK[b.k].l} · {b.o ? 'open' : 'resolved'}</div><p>{b.t}</p>{b.r ? <p className="res-t"><Ic n="check" sm /> {b.r}</p> : null}</div>
          {live ? <div className="acts">{b.o ? <button className="btn sm" onClick={() => bAnswer(i)}>{b.k === 'p' ? 'Resolve…' : 'Answer…'}</button>
            : <button className="btn sm ghost" onClick={() => bReopen(i)}>Reopen</button>}</div> : null}
        </div>))}</div>
        : <p className="hint" style={{ margin: 0 }}>None on this step.</p>}
    </section>
  )
}

/** a step the console does itself: its button, and why it cannot yet. actOf knows the core's acts and the workspaces';
    an act nobody knows shows no button */
function ConsoleSec({ j, s, f }: P) {
  const a = s.act ? actOf(s.act) : null
  if (!a || isClosed(j) || !isLive(f)) return null
  const wait = a.busy?.(j) ?? false, why = a.blocked?.(j) ?? null, eb = a.eyebrow?.(j)
  return (
    <section className="sec"><div className="eyebrow">Console{eb ? ' · ' + eb : ''}</div>
      <div className="row"><button className="btn sm pri" disabled={wait} onClick={() => void a.run(j)}><Ic n={a.icon} sm />{wait ? 'Working…' : a.label}</button></div>
      {why ? <p className="hint" style={{ margin: '8px 0 0' }}>{why}</p> : null}</section>
  )
}

/** the step's buttons: what the step is waiting for goes first */
function StepActs({ j, s, f }: P) {
  if (isClosed(j)) return <span className="why">The job is closed. Reopen it to change steps.</span>
  if (f.run) return <button className="btn" onClick={llmCancel}><Ic n="x" sm />Cancel the LLM run</button>
  if (!isLive(f)) return <button className="btn" onClick={stepReopen}><Ic n="retry" sm />Reopen step</button>
  const llmFirst = s.m === 'llm' && !f.dr
  const done = <button key="done" className={'btn' + (llmFirst || f.dr ? '' : ' pri')} onClick={stepDoneHere}><Ic n="check" sm />Mark done</button>
  const ask = <button key="ask" className={'btn' + (llmFirst ? ' pri' : '')} onClick={() => askLlm(j, s.id)}><Ic n="bot" sm />{f.dr ? 'Ask again…' : 'Ask LLM…'}</button>
  return <>
    {llmFirst ? [ask, done] : [done, ask]}
    {f.s === 'wait' ? <button className="btn ghost" onClick={stepResume}><Ic n="play" sm />Resume</button>
      : <button className="btn ghost" onClick={stepWait}><Ic n="hourglass" sm />Waiting…</button>}
    <button className="btn ghost" onClick={stepSkip}><Ic n="skip" sm />Skip</button>
  </>
}

function DrawerBody({ j, sid }: { j: Job; sid: string }) {
  const s = stepOf(j, sid)!, f = j.flow[sid], ph = phaseOf(j, sid)!, p = { j, s, f }
  return <>
    <div className="dr-h"><div style={{ minWidth: 0 }}><div className="eyebrow">{ph.c} · {ph.n} · {j.key}</div><h2>{s.t}</h2><div className="row" style={{ marginTop: 6 }}><NodePill s={f.s} /></div></div>
      <button className="iconbtn" aria-label="Close inspector" style={{ marginLeft: 'auto' }} onClick={closeDrawer}><Ic n="x" /></button></div>
    <div className="dr-b">
      <dl className="kv"><dt>Who does it</dt><dd><Ic n={MODES[s.m].i} sm /> {MODES[s.m].l}<div className="why">{EXEC[s.m]}</div></dd>
        <dt>Done when</dt><dd>{s.x}</dd>{s.a ? <><dt>Produces</dt><dd>{s.a.join(', ')}</dd></> : null}{f.m ? <><dt>Note</dt><dd>{f.m}</dd></> : null}</dl>
      <ConsoleSec {...p} /><LlmSec {...p} />{s.rv ? <ReviewSec {...p} /> : null}<TplSec {...p} /><BadgeSec {...p} />
    </div>
    <div className="dr-f"><StepActs {...p} /></div>
  </>
}

/** the step inspector: open while a step of the shown job is selected */
export function Drawer() {
  const j = S.view === 'job' && S.job ? byId(S.job) : undefined
  const sid = j && S.sel && j.flow[S.sel] ? S.sel : null
  return <aside className="drawer" id="drawer" hidden={!sid} aria-label="Step inspector">{j && sid ? <DrawerBody j={j} sid={sid} /> : null}</aside>
}
