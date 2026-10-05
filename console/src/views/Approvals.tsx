import * as React from 'react'
import { tfmt } from '../lib/util.ts'
import { S, TPL, W, approvals, chName } from '../model/world.ts'
import type { Approval } from '../model/world.ts'
import { go } from '../actions/nav.tsx'
import { acceptDraft, editDraft, rejectDraft, tplSend } from '../actions/flow.tsx'
import { lineDiff } from '../lib/diff.ts'
import * as api from '../live/api.ts'
import { LIVE } from '../live/api.ts'
import type { Proposal } from '../live/api.ts'
import { L } from '../live/boot.ts'
import { decide, editProposal } from '../actions/knowledge.tsx'
import { FillT } from '../ui/bits.tsx'
import { DraftTalk } from '../ui/DraftTalk.tsx'
import { Ic } from '../ui/Icon.tsx'
import { OutSeg, OutText } from '../ui/outText.ts'

function ApCard({ x }: { x: Approval }) {
  const { j, s, f } = x
  const lnk = <button className="lnk mono" onClick={() => go('job', j.id)}>{j.id} · {j.key}</button>
  const open = <button className="btn sm ghost" onClick={() => go('job', j.id, s.id)}>Open the step</button>
  if (x.k === 'draft') {
    const dr = f.dr!
    return (
      <article className={'dc' + (dr.nw ? ' new' : '')}>
        <div className="dc-h"><span className="st"><Ic n="bot" sm /><b>LLM draft · {s.t}</b></span>{lnk}<span className="src">{tfmt(dr.at)}</span><OutSeg /></div>
        <div className="why">{j.t} · done when: {s.x}</div><OutText t={dr.t} />
        <div className="row"><button className="btn sm pri" disabled={!!f.run} onClick={() => acceptDraft(j.id, s.id)}><Ic n="check" sm />Accept</button>
          <button className="btn sm" disabled={!!f.run} onClick={() => editDraft(j.id, s.id)}><Ic n="pen" sm />Edit…</button>
          <button className="btn sm" disabled={!!f.run} onClick={() => rejectDraft(j.id, s.id)}><Ic n="x" sm />Reject…</button>{open}</div>
        <DraftTalk job={j} step={s.id} last={2} />
      </article>
    )
  }
  const [k, lbl, t] = TPL[s.id][x.i], ic = k === 'work' ? 'file' : 'message'
  return (
    <article className="dc">
      <div className="dc-h"><span className="st"><Ic n={ic} sm /><b>Message · {s.t}</b></span>{lnk}</div>
      <div className="why">{j.t}</div>
      <div className="tplm"><div className="ch"><Ic n={ic} sm />{chName(j, k, lbl)}</div><div className="body"><FillT j={j} t={t} /></div></div>
      <div className="row"><button className="btn sm pri" onClick={() => tplSend(j.id, s.id, x.i)}><Ic n="send" sm />Review and send…</button>{open}</div>
    </article>
  )
}

function KnCard({ p }: { p: Proposal }) {
  // undefined while the note's current text loads; a new note is compared with nothing
  const [old, setOld] = React.useState<string | undefined>(p.note ? undefined : '')
  React.useEffect(() => { if (p.note) api.note(S.ws, p.note).then((n) => setOld(n.text), () => setOld('')) }, [p.note])
  const d = old === undefined ? null : lineDiff(old, p.text)
  return (
    <article className="dc">
      <div className="dc-h"><span className="st"><Ic n="file" sm /><b>Knowledge · {p.note ? 'change' : 'new note'}</b></span><span className="mono">{p.title}</span><span className="src">{p.by} · {tfmt(p.at)}</span></div>
      <div className="why">{p.reason || 'no reason given'}{p.tags.length ? ` · ${p.tags.join(', ')}` : ''}{p.playbooks.length ? ` · playbooks ${p.playbooks.join(', ')}` : ''}</div>
      {d ? <pre className="out diff">{d.map((l, i) => <span key={i} className={l.k === '+' ? 'add' : l.k === '-' ? 'del' : undefined}>{l.k === '=' ? '  ' : l.k + ' '}{l.t}{'\n'}</span>)}</pre>
        : <div className="why">Loading the note…</div>}
      <div className="row"><button className="btn sm pri" onClick={() => void decide(p, true)}><Ic n="check" sm />Accept</button>
        <button className="btn sm" onClick={() => editProposal(p)}><Ic n="pen" sm />Edit…</button>
        <button className="btn sm" onClick={() => void decide(p, false)}><Ic n="x" sm />Reject</button></div>
    </article>
  )
}

export function Approvals() {
  const w = W(), A = approvals(), K = LIVE.on ? L().proposals : []
  return <>
    <div className="vh"><div><div className="eyebrow">{w.n} · work</div><h1>Approvals</h1>
      <p>LLM drafts, planned messages and knowledge proposals that wait for you. Nothing is kept or sent until you press a button, here or on the step.</p></div></div>
    <div className="dl">{K.map((p) => <KnCard key={p.id} p={p} />)}
      {A.map((x) => <ApCard key={`${x.j.id}/${x.s.id}${x.k === 'msg' ? '/' + x.i : ''}`} x={x} />)}
      {!K.length && !A.length ? <div className="dc empty">Nothing waits for you. A draft lands here after you ask the LLM on a step; a knowledge proposal after an LLM suggests a note.</div> : null}</div>
  </>
}
