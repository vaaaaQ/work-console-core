import * as React from 'react'
import { MODES, NODE, STATUS } from '../data/core.ts'
import { artIc } from '../lib/util.ts'
import { pbToFile } from '../model/playbookFile.ts'
import { TPL, atOf, isClosed, jsteps, openBadges, phState, phases, stepOf, tvars } from '../model/world.ts'
import type { Job, JobStatus, NodeState, Playbook, Tpl } from '../model/types.ts'
import { changeNo, useWorld } from '../store.ts'
import { dismiss } from '../actions/nav.tsx'
import { canSave, saveFile } from '../actions/playbooks.tsx'
import { Ic } from './Icon.tsx'
import { toast } from './toasts.tsx'

/** t to the clipboard; el = what to select for Ctrl+C when the clipboard is refused; done = the toast */
export function copy(t: string, el?: HTMLElement | null, done: React.ReactNode = 'Copied') {
  const pick = () => { if (!el) return; const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s?.removeAllRanges(); s?.addRange(r) }
  try { navigator.clipboard.writeText(t).then(() => toast(done), () => { pick(); toast(el ? 'Selected — press Ctrl+C' : 'The clipboard was refused') }) } catch { pick(); toast(el ? 'Selected — press Ctrl+C' : 'The clipboard was refused') }
}

export function Pill({ st }: { st: JobStatus }) {
  const x: { l: string; c: string; h?: 1; p?: 1 } = STATUS[st] || { l: st, c: 'off' }
  return <span className="st"><span className={`lamp ${x.c}${x.h ? ' hol' : ''}${x.p ? ' pulse' : ''}`} />{x.l}</span>
}

export function NodePill({ s }: { s: NodeState }) {
  const [c, l] = NODE[s] || NODE.fut
  return <span className="st"><span className={'lamp ' + c} />{l}</span>
}

/** phase chips of a job, then its open questions and problems */
export function Chips({ j }: { j: Job }) {
  const q = openBadges(j), p = openBadges(j, 'p')
  return (
    <div className="chips">
      {phases(j).map((ph, i) => { const st = phState(j, ph); return <span key={i} className={'chip s-' + st} title={`${ph.n}: ${NODE[st][1]}`}>{ph.c}</span> })}
      {q ? <span className="flag q" title="Open questions"><Ic n="help" sm />{q}</span> : null}
      {p ? <span className="flag p" title="Open problems"><Ic n="alert" sm />{p}</span> : null}
    </div>
  )
}

/** a message template with its {fields} filled from the job, or marked when not known yet */
export function FillT({ j, t }: { j: Job; t: string }) {
  const v = tvars(j)
  return <>{t.split(/(\{\w+\})/).map((p, i) => {
    const k = /^\{(\w+)\}$/.exec(p)?.[1]
    if (!k) return p
    return v[k] ? <var key={i}>{v[k]}</var> : <var key={i} className="unk" title="not known yet">{k}</var>
  })}</>
}

/** Download where the page may save files, Copy JSON where it may not */
export function ExportBtn({ k }: { k: string }) {
  useWorld()
  return (
    <button type="button" className="btn sm ghost" title={k + '.json'} onClick={() => { void saveFile(k + '.json', JSON.stringify(pbToFile(k), null, 2) + '\n') }}>
      {canSave() ? <><Ic n="download" sm />Download</> : <><Ic n="copy" sm />Copy JSON</>}
    </button>
  )
}

/** a playbook drawn as phases of steps, with what each step produces, sends and reviews */
export function FlowMap({ p, T = TPL }: { p: Playbook; T?: Record<string, Tpl[]> }) {
  return (
    <div className="fl">
      {p.ph.map((ph, i) => (
        <React.Fragment key={i}>
          {i ? <div className="fl-ln"><Ic n="chevron" sm /></div> : null}
          <div className="fl-ph">
            <h4><span className="chip s-fut">{ph.c}</span>{ph.n}</h4>
            {ph.s.map((s) => {
              const x = [
                ...(s.a || []).map((a, n) => <span key={'a' + n} className="art gh"><Ic n={artIc(a)} sm />{a}</span>),
                ...(T[s.id] || []).map(([k, lbl], n) => <span key={'m' + n} className="msgs"><Ic n={k === 'work' ? 'file' : 'message'} sm />{lbl}</span>),
                ...(s.rv ? [<span key="rv" className="msgs rvm"><Ic n="pr" sm />review</span>] : []),
              ]
              return (
                <div key={s.id} className="fl-st" title={MODES[s.m].l}>
                  <Ic n={MODES[s.m].i} sm /><span>{s.t}</span><small>{s.x}</small>{x.length ? <div className="x">{x}</div> : null}
                </div>
              )
            })}
          </div>
        </React.Fragment>
      ))}
    </div>
  )
}

export const FlowLegend = () => (
  <div className="legend">
    <span><Ic n="user" sm />you do it</span><span><Ic n="bot" sm />ask the LLM</span>
    <span className="msgs"><Ic n="message" sm />message to send</span><span className="msgs rvm"><Ic n="pr" sm />review</span>
    <span><span className="art gh">file</span>produces</span>
  </div>
)

export const CancelBtn = () => <button type="button" className="btn ghost" onClick={dismiss}>Cancel</button>

/** what the job needs next, in one line */
export function NextCell({ j }: { j: Job }) {
  if (isClosed(j)) return <span className="why">—</span>
  const all = jsteps(j)
  const run = all.find((s) => j.flow[s.id].run)
  if (run) return <span className="nx run"><span className="spin" />LLM on “{run.t}”</span>
  const dr = all.find((s) => j.flow[s.id].dr)
  if (dr) return <span className="nx dr"><Ic n="bot" sm />Review draft: {dr.t}</span>
  if (j.st === 'draft') return <span className="nx"><Ic n="pen" sm />Start when ready</span>
  const id = atOf(j)
  if (!id) return <span className="why">all steps done</span>
  const s = stepOf(j, id)!, f = j.flow[id]
  return <span className="nx"><Ic n={f.s === 'wait' ? 'hourglass' : f.s === 'bad' ? 'alert' : MODES[s.m].i} sm />{j.st === 'ready' ? 'Start: ' : ''}{s.t}</span>
}

/** an element that stays in place keeps its running animation; replay it when a new change marks it new again */
export function useReplay<T extends HTMLElement>(on: unknown) {
  const ref = React.useRef<T | null>(null), n = changeNo()
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!on || !el) return
    el.classList.remove('new')
    void el.offsetWidth
    el.classList.add('new')
  }, [on ? n : -1])
  return ref
}
