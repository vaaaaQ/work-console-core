import * as React from 'react'
import { MODES } from '../data/core.ts'
import { PACKS } from '../data/packs.ts'
import { artIc } from '../lib/util.ts'
import { PB, S, TPL, W, isClosed, pbs, steps, wsJobs } from '../model/world.ts'
import type { Mode, SrcKey } from '../model/types.ts'
import { commit } from '../store.ts'
import { onPbStep, pbAdd, pbRemove } from '../actions/playbooks.tsx'
import { ExportBtn, FlowLegend, FlowMap } from '../ui/bits.tsx'
import { Ic } from '../ui/Icon.tsx'

const WHO = Object.keys(MODES) as Mode[]

export function Playbooks() {
  const w = W(), list = pbs(), k = S.pbv && list.includes(S.pbv) ? S.pbv : list.find((x) => PB[x].ws) || list[0], p = PB[k], st = steps(k)
  const used = wsJobs().filter((j) => j.pb === k && !isClosed(j)).length
  return <>
    <div className="vh"><div><div className="eyebrow">{w.n} · setup</div><h1>Playbooks</h1>
      <p>A playbook is the flow a job follows: phases, steps, who does each step, and when it counts as done. Core playbooks work in every workspace; a pack’s playbooks use that workspace’s tools.</p></div>
      <div className="acts"><button className="btn" onClick={() => pbAdd()}><Ic n="upload" sm />Add playbook…</button></div></div>
    <div className="fbar">
      <select className="sel" id="pbv" aria-label="Playbook" value={k} onChange={(e) => { const v = e.target.value; commit(() => { S.pbv = v }) }}>
        {list.map((x) => <option key={x} value={x}>{`${PB[x].n}${PB[x].ws ? '' : ' · core'}${PB[x].custom ? ' · added' : ''}`}</option>)}</select>
      <span className="tag">{p.ws ? PACKS[p.ws].n + ' pack' : 'core'}</span>{p.custom ? <span className="tag">added</span> : null}
      <span className="why">{p.d} · {st.length} steps · {used} open job{used === 1 ? '' : 's'}</span>
      <span className="fsp" /><ExportBtn k={k} />
      {p.custom ? <button className="btn sm ghost" onClick={() => pbRemove(k)}><Ic n="x" sm />Remove</button> : null}
    </div>
    <div className="prev" style={{ marginBottom: 14 }}><FlowMap p={p} /><FlowLegend /></div>
    <div className="tw"><table className="mt" style={{ minWidth: 820 }}>
      <thead><tr><th>Phase</th><th>Step</th><th>Who does it</th><th>Done when</th><th>Produces</th><th>Messages</th></tr></thead>
      <tbody>{p.ph.map((ph) => ph.s.map((s, i) => (
        <tr key={s.id}>
          {i ? null : <td rowSpan={ph.s.length}><span className="chip s-fut">{ph.c}</span> {ph.n}</td>}
          <td className="cn">{s.t}{s.rv ? <small>review with votes</small> : null}{s.out ? <small>fills {'{' + s.out + '}'}</small> : null}</td>
          <td><select className="sel" data-pbstep={k + '|' + s.id} aria-label={'Who does ' + s.t} value={s.m} onChange={(e) => onPbStep(k, s.id, e.target.value as Mode)}>
            {WHO.map((m) => <option key={m} value={m}>{MODES[m].l}</option>)}</select></td>
          <td>{s.x}</td>
          <td>{s.a ? <div className="ctx">{s.a.map((a, n) => <span key={n} className="art gh"><Ic n={artIc(a)} sm />{a}</span>)}</div> : <span className="na">—</span>}</td>
          <td>{TPL[s.id] ? TPL[s.id].map(([src, lbl], n) => (
            <div key={n} className="why"><Ic n={src === 'work' ? 'file' : 'message'} sm /> {w.src[src as SrcKey]?.n || src} · {lbl}</div>)) : <span className="na">—</span>}</td>
        </tr>)))}</tbody>
    </table></div>
    <p className="hint">Changing who does a step applies to open jobs at once and is remembered in this browser.</p>
  </>
}
